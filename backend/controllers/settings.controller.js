const bcrypt = require('bcryptjs');
const logger = require('../config/logger');
const settingsService = require('../services/settings.service');
const { settingsWorker } = require('../services/worker.manager'); // 兼容保留
const { settingsUpdateQueue } = require('../config/redis');
const { dbAll, dbGet } = require('../db/multi-db');
const { promises: fs } = require('fs');
const path = require('path');
const { THUMBS_DIR, PHOTOS_DIR } = require('../config');

// 存储最近的设置更新状态（向后兼容，同时引入基于ID的 Map 存储）
let lastSettingsUpdateStatus = null;
const updateStatusMap = new Map(); // key: updateId, value: { status, message, updatedKeys, timestamp }

// 获取设置的逻辑不变
exports.getSettingsForClient = async (req, res) => {
    const allSettings = await settingsService.getAllSettings();
    const clientSettings = {
        // 仅公开非敏感字段；AI_URL/AI_MODEL/AI_PROMPT 不对外返回
        AI_ENABLED: allSettings.AI_ENABLED,
        PASSWORD_ENABLED: allSettings.PASSWORD_ENABLED,
        hasPassword: !!(allSettings.PASSWORD_HASH && allSettings.PASSWORD_HASH !== ''),
        isAdminSecretConfigured: !!(process.env.ADMIN_SECRET && process.env.ADMIN_SECRET.trim() !== '')
    };
    res.json(clientSettings);
};

// 通用旧密码或管理员密钥校验函数
async function verifyAdminSecret(adminSecret) {
    // 首先检查服务器是否配置了ADMIN_SECRET
    if (!process.env.ADMIN_SECRET || process.env.ADMIN_SECRET.trim() === '') {
        logger.warn('安全操作失败：管理员密钥未在.env文件中配置。');
        return { ok: false, code: 500, msg: '管理员密钥未在服务器端配置，无法执行此操作' };
    }

    // 然后检查用户是否提供了密钥
    if (!adminSecret || adminSecret.trim() === '') {
        return { ok: false, code: 400, msg: '必须提供管理员密钥' };
    }

    // 最后验证密钥是否正确
    if (adminSecret !== process.env.ADMIN_SECRET) {
        return { ok: false, code: 401, msg: '管理员密钥错误' };
    }

    logger.info('管理员密钥验证成功');
    return { ok: true };
}

// 更新设置的逻辑改变
exports.updateSettings = async (req, res) => {
        const { newPassword, adminSecret, ...rawSettings } = req.body;

        // 明确禁止持久化 AI 密钥相关字段
        const forbiddenKeys = ['AI_KEY', 'AI_API_KEY', 'OPENAI_API_KEY'];
        const settingsToUpdate = Object.fromEntries(
            Object.entries(rawSettings).filter(([k]) => !forbiddenKeys.includes(k))
        );

        const allSettings = await settingsService.getAllSettings();
        const passwordIsCurrentlySet = !!(allSettings.PASSWORD_HASH && allSettings.PASSWORD_HASH !== '');

        const isTryingToSetOrChangePassword = newPassword && newPassword.trim() !== '';
        const isTryingToDisablePassword = Object.prototype.hasOwnProperty.call(settingsToUpdate, 'PASSWORD_ENABLED') && settingsToUpdate.PASSWORD_ENABLED === 'false';

        // 敏感操作指的是修改或禁用一个已经存在的密码
        const isSensitiveOperation = (isTryingToSetOrChangePassword || isTryingToDisablePassword) && passwordIsCurrentlySet;

        // --- 审计辅助：构建安全的审计上下文（不写入敏感值） ---
        function buildAuditContext(extra) {
            const headerUserId = req.headers['x-user-id'] || req.headers['x-userid'] || req.headers['x-user'];
            const userId = (req.user && req.user.id) ? String(req.user.id) : (headerUserId ? String(headerUserId) : 'anonymous');
            return {
                requestId: req.requestId || '-',
                ip: req.ip,
                userId,
                ...extra
            };
        }

        if (isSensitiveOperation) {
            const verifyResult = await verifyAdminSecret(adminSecret);
            if (!verifyResult.ok) {
                // 审计：敏感操作校验失败
                logger.warn(JSON.stringify(buildAuditContext({
                    action: 'update_settings',
                    sensitive: true,
                    status: 'denied',
                    reason: verifyResult.msg
                })));
                return res.status(verifyResult.code).json({ error: verifyResult.msg });
            }
        }

        // 根据操作类型，更新密码哈希
        if (isTryingToSetOrChangePassword) {
            logger.info('正在为新密码生成哈希值...');
            const salt = await bcrypt.genSalt(10);
            settingsToUpdate.PASSWORD_HASH = await bcrypt.hash(newPassword, salt);
        } else if (isTryingToDisablePassword && passwordIsCurrentlySet) {
            settingsToUpdate.PASSWORD_HASH = '';
        }
        
        // 开启密码访问时，若数据库无密码，必须强制要求设置新密码
        if (
            Object.prototype.hasOwnProperty.call(settingsToUpdate, 'PASSWORD_ENABLED') &&
            settingsToUpdate.PASSWORD_ENABLED === 'true' &&
            !passwordIsCurrentlySet && !isTryingToSetOrChangePassword
        ) {
            return res.status(400).json({ error: '请设置新密码以启用密码访问' });
        }

        // 检查是否包含认证相关设置（密码或AI配置）
        const authRelatedKeys = ['PASSWORD_ENABLED', 'PASSWORD_HASH', 'AI_ENABLED', 'AI_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_PROMPT'];
        const hasAuthChanges = Object.keys(settingsToUpdate).some(key => authRelatedKeys.includes(key));

        // 使用时间戳+随机串作为唯一ID，降低并发碰撞概率
        const updateId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // 设置初始状态
        const initialStatus = {
            timestamp: updateId,
            status: 'pending',
            updatedKeys: Object.keys(settingsToUpdate)
        };
        lastSettingsUpdateStatus = initialStatus; // 兼容旧查询
        updateStatusMap.set(updateId, initialStatus);
        
        // 首选：投递到 BullMQ 队列（持久化、可重试）
        try {
            await settingsUpdateQueue.add('update_settings', { settingsToUpdate, updateId });
            logger.info('设置更新任务已投递到队列');
        } catch (e) {
            logger.warn('投递到设置队列失败，降级使用线程消息：', e && e.message);
            try { settingsWorker.postMessage({ type: 'update_settings', payload: { settingsToUpdate, updateId } }); } catch {}
        }

        if (hasAuthChanges) {
            // 对于认证相关设置，异步处理，立即返回202 Accepted
            logger.info('检测到认证相关设置变更，任务已提交到后台处理...');

            // 审计：敏感相关变更已提交
            logger.info(JSON.stringify(buildAuditContext({
                action: 'update_settings',
                sensitive: true,
                status: 'submitted',
                updatedKeys: Object.keys(settingsToUpdate)
            })));

            // 立即返回202，告知客户端任务已接受，并提供查询ID
            return res.status(202).json({ 
                success: true, 
                message: '设置更新任务已接受，正在后台处理',
                status: 'pending',
                updateId
            });
        } else {
            // 对于非认证相关设置，立即返回成功
            logger.info('非认证相关设置变更，立即返回成功');

            // 审计：非敏感设置已提交
            logger.info(JSON.stringify(buildAuditContext({
                action: 'update_settings',
                sensitive: false,
                status: 'submitted',
                updatedKeys: Object.keys(settingsToUpdate)
            })));

            res.json({ 
                success: true, 
                message: '配置更新任务已提交',
                status: 'submitted',
                updateId
            });
        }
};

// 新增：获取设置更新状态
exports.getSettingsUpdateStatus = async (req, res) => {
    const id = req.query?.id || req.body?.id;
    if (id && updateStatusMap.has(id)) {
        const st = updateStatusMap.get(id);
        if (st.status === 'pending' && Date.now() - (Number(st.timestamp.split('-')[0]) || Date.now()) > 30000) {
            st.status = 'timeout';
        }
        // 优先读取 worker 写入的 Redis 状态以获得最终态
        try {
            const { redis } = require('../config/redis');
            const raw = await redis.get(`settings_update_status:${id}`);
            if (raw) {
                const parsed = JSON.parse(raw);
                return res.json({ status: parsed.status, timestamp: st.timestamp, updatedKeys: parsed.updatedKeys || st.updatedKeys, message: parsed.message || null });
            }
        } catch {}
        return res.json({ status: st.status, timestamp: st.timestamp, updatedKeys: st.updatedKeys, message: st.message || null });
    }
    if (lastSettingsUpdateStatus) {
        const st = lastSettingsUpdateStatus;
        if (st.status === 'pending' && Date.now() - (Number(String(st.timestamp).split('-')[0]) || Date.now()) > 30000) {
            st.status = 'timeout';
        }
        return res.json({ status: st.status, timestamp: st.timestamp, updatedKeys: st.updatedKeys, message: st.message || null });
    }
    return res.status(404).json({ error: '没有找到最近的设置更新记录' });
};

// 导出函数供 indexer.service.js 调用
exports.updateSettingsStatus = (status, message = null, updateId = null) => {
    if (updateId && updateStatusMap.has(updateId)) {
        const st = updateStatusMap.get(updateId);
        st.status = status;
        st.message = message;
        lastSettingsUpdateStatus = st; // 顺带刷新最后一次
    } else if (lastSettingsUpdateStatus) {
        lastSettingsUpdateStatus.status = status;
        lastSettingsUpdateStatus.message = message;
    }
};

/**
 * 获取状态表信息
 */
exports.getStatusTables = async (req, res) => {
    try {
        const statusTables = {
            index: await getIndexStatus(),
            thumbnail: await getThumbnailStatus(),
            hls: await getHlsStatus()
        };

        res.json({
            success: true,
            data: statusTables,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('获取状态表信息失败:', error);
        res.status(500).json({
            success: false,
            error: '获取状态表信息失败',
            message: error.message
        });
    }
};

/**
 * 触发补全操作
 * 查找并补全缺失的缩略图、索引或HLS文件
 */
exports.triggerSync = async (req, res) => {
    try {
        const { type } = req.params;
        const validTypes = ['index', 'thumbnail', 'hls', 'all'];

        if (!validTypes.includes(type)) {
            return res.status(400).json({
                success: false,
                error: '无效的补全类型',
                validTypes
            });
        }

        // 启动补全任务
        const syncResult = await triggerSyncOperation(type);

        res.json({
            success: true,
            message: `已启动${getTypeDisplayName(type)}补全任务`,
            data: syncResult,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error(`触发${req.params.type}补全失败:`, error);
        res.status(500).json({
            success: false,
            error: '补全操作失败',
            message: error.message
        });
    }
};

/**
 * 获取索引状态
 */
async function getIndexStatus() {
    try {
        // 获取索引状态
        const statusRow = await dbGet('index', "SELECT status, processed_files, total_files, last_updated FROM index_status WHERE id = 1");

        // 获取items表统计信息
        const itemsStats = await dbAll('main', "SELECT type, COUNT(*) as count FROM items GROUP BY type");

        // 获取FTS表统计信息
        const ftsStats = await dbAll('main', "SELECT COUNT(*) as count FROM items_fts");

        return {
            status: statusRow?.status || 'unknown',
            processedFiles: statusRow?.processed_files || 0,
            totalFiles: statusRow?.total_files || 0,
            lastUpdated: statusRow?.last_updated || null,
            itemsStats: itemsStats || [],
            ftsCount: ftsStats?.[0]?.count || 0
        };
    } catch (error) {
        logger.warn('获取索引状态失败:', error);
        return {
            status: 'error',
            error: error.message,
            processedFiles: 0,
            totalFiles: 0,
            itemsStats: [],
            ftsCount: 0
        };
    }
}

/**
 * 重新同步缩略图状态
 * 简化版：直接使用数据库中的文件记录来同步状态
 */
async function resyncThumbnailStatus() {
    try {
        const { promises: fs } = require('fs');
        const { THUMBS_DIR } = require('../config');
        const path = require('path');
        const { dbRun, dbAll } = require('../db/multi-db');

        logger.debug('开始重新同步缩略图状态...');

        // 获取所有媒体文件（从items表，这个表已经被索引服务维护）
        const mediaFiles = await dbAll('main', `
            SELECT path, type FROM items 
            WHERE type IN ('photo', 'video')
        `);

        if (!mediaFiles || mediaFiles.length === 0) {
            logger.info('没有找到媒体文件，跳过同步');
            return 0;
        }

        // 清空并重建thumb_status表
        await dbRun('main', 'DELETE FROM thumb_status');
        
        let syncedCount = 0;
        let existsCount = 0;
        let missingCount = 0;

        // 批量处理文件
        for (const file of mediaFiles) {
            try {
                // 确定缩略图路径
                const thumbExt = file.type === 'video' ? '.jpg' : '.webp';
                const thumbPath = file.path.replace(/\.[^.]+$/, thumbExt);
                const thumbFullPath = path.join(THUMBS_DIR, thumbPath);
                
                // 检查缩略图是否存在
                let status = 'missing';
                try {
                    await fs.access(thumbFullPath);
                    status = 'exists';
                    existsCount++;
                } catch {
                    missingCount++;
                }

                // 插入到数据库
                await dbRun('main', `
                    INSERT INTO thumb_status (path, mtime, status, last_checked)
                    VALUES (?, 0, ?, strftime('%s','now')*1000)
                `, [file.path, status]);

                syncedCount++;
            } catch (error) {
                logger.debug(`处理文件失败 ${file.path}: ${error.message}`);
            }
        }

        logger.debug(`缩略图状态重同步完成: 总计=${syncedCount}, 存在=${existsCount}, 缺失=${missingCount}`);
        
        // 清理相关缓存，确保状态更新立即生效
        try {
            const { redis } = require('../config/redis');
            if (redis) {
                await redis.del('thumb_stats_cache');
                logger.debug('已清理缩略图状态缓存');
            }
        } catch (cacheError) {
            logger.debug('清理缓存失败（非关键错误）:', cacheError.message);
        }
        
        return syncedCount;
    } catch (error) {
        logger.error('缩略图状态重同步失败:', error);
        throw error;
    }
}

/**
 * 获取缩略图状态
 * 简化版：直接从数据库获取状态，不进行复杂的文件系统检查
 */
async function getThumbnailStatus() {
    try {
        // 获取源媒体文件总数
        const sourceTotal = await dbAll('main', "SELECT COUNT(*) as count FROM items WHERE type IN ('photo', 'video')");
        const sourceCount = sourceTotal?.[0]?.count || 0;

        // 获取缩略图状态统计
        const stats = await dbAll('main', `
            SELECT status, COUNT(*) as count 
            FROM thumb_status 
            GROUP BY status
        `);

        // 获取缩略图表总计数
        const total = await dbAll('main', "SELECT COUNT(*) as count FROM thumb_status");
        const thumbStatusCount = total?.[0]?.count || 0;

        // 如果数据库为空，建议用户手动重同步
        if (thumbStatusCount === 0 && sourceCount > 0) {
            return {
                total: 0,
                sourceTotal: sourceCount,
                stats: [{ status: 'unknown', count: sourceCount }],
                needsResync: true,
                lastSync: null
            };
        }

        return {
            total: thumbStatusCount,
            sourceTotal: sourceCount,
            stats: stats || [],
            lastSync: new Date().toISOString()
        };
    } catch (error) {
        logger.error('获取缩略图状态失败:', error);
        return {
            total: 0,
            sourceTotal: 0,
            stats: [],
            error: error.message,
            lastSync: new Date().toISOString()
        };
    }
}

/**
 * 获取HLS状态
 */
async function getHlsStatus() {
    try {
        // 获取HLS文件统计
        const hlsStats = await getHlsFileStats();

        // 获取视频文件统计
        const videoStats = await dbAll('main', "SELECT COUNT(*) as count FROM items WHERE type='video'");

        // 计算HLS处理状态
        const totalVideos = videoStats?.[0]?.count || 0;
        const processedVideos = hlsStats.processed || 0;
        let status = 'unknown';

        if (totalVideos === 0) {
            status = 'no-videos'; // 没有视频文件
        } else if (processedVideos === 0) {
            status = 'pending'; // 有视频但未处理
        } else if (processedVideos < totalVideos) {
            status = 'processing'; // 处理中
        } else if (processedVideos === totalVideos) {
            status = 'complete'; // 已完成
        }

        return {
            status: status,
            totalVideos: totalVideos,
            hlsFiles: hlsStats.total,
            processedVideos: processedVideos,
            lastSync: new Date().toISOString()
        };
    } catch (error) {
        logger.warn('获取HLS状态失败:', error);
        return {
            status: 'error',
            totalVideos: 0,
            hlsFiles: 0,
            processedVideos: 0,
            error: error.message
        };
    }
}

/**
 * 获取HLS文件统计
 */
async function getHlsFileStats() {
    try {
        const hlsDir = path.join(THUMBS_DIR, 'hls');
        let total = 0;
        let processed = 0;

        async function scanDir(dir) {
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await scanDir(fullPath);
                    } else if (entry.name === 'master.m3u8') {
                        total++;
                        processed++;
                    }
                }
            } catch (error) {
                // 忽略错误，继续扫描
            }
        }

        await scanDir(hlsDir);
        return { total, processed };
    } catch (error) {
        return { total: 0, processed: 0 };
    }
}

/**
 * 触发补全操作
 * 根据类型补全缺失的内容
 */
async function triggerSyncOperation(type) {
    const { getIndexingWorker } = require('../services/worker.manager');

    switch (type) {
        case 'index':
            // 补全搜索索引（重建缺失的索引）
            const worker = getIndexingWorker();
            worker.postMessage({ type: 'rebuild_index', payload: { photosDir: PHOTOS_DIR } });
            return { message: '已启动索引补全任务' };

        case 'thumbnail':
            // 补全缺失的缩略图
            await performThumbnailReconcile();
            return { message: '已启动缩略图补全任务' };

        case 'hls':
            // 补全缺失的HLS文件
            await performHlsReconcile();
            return { message: '已启动HLS补全任务' };

        case 'all':
            // 执行所有补全操作
            const indexingWorker = getIndexingWorker();
            indexingWorker.postMessage({ type: 'rebuild_index', payload: { photosDir: PHOTOS_DIR } });
            await performThumbnailReconcile();
            await performHlsReconcile();
            return { message: '已启动全量补全任务' };

        default:
            throw new Error('未知的补全类型');
    }
}

/**
 * 执行缩略图补全检查
 * 将状态为 missing 的文件标记为 pending，准备生成缩略图
 */
async function performThumbnailReconcile() {
    try {
        const { dbAll, runAsync } = require('../db/multi-db');
        const { PHOTOS_DIR } = require('../config');
        const { promises: fsp } = require('fs');
        const path = require('path');

        // 查询状态为 missing 的文件
        const missingFiles = await dbAll('main', `
            SELECT path FROM thumb_status 
            WHERE status = 'missing' 
            LIMIT 1000
        `);

        if (!missingFiles || missingFiles.length === 0) {
            logger.debug('缩略图补全检查完成：没有发现需要补全的缩略图');
            return;
        }

        let changed = 0;
        let skipped = 0;

        for (const row of missingFiles) {
            try {
                // 检查源文件是否存在
                const sourceAbsPath = path.join(PHOTOS_DIR, row.path);
                await fsp.access(sourceAbsPath);
                
                // 源文件存在，将状态更新为 pending
                await runAsync('main', `
                    UPDATE thumb_status 
                    SET status = 'pending', last_checked = strftime('%s','now')*1000 
                    WHERE path = ?
                `, [row.path]);
                
                changed++;
            } catch {
                // 源文件不存在，跳过
                skipped++;
            }
        }

        logger.debug(`缩略图补全检查完成：发现 ${changed} 个文件需要补全缩略图，跳过 ${skipped} 个源文件不存在的记录`);

        // 追加：立即启动批量补全派发，让生成立刻开始
        try {
            const { batchGenerateMissingThumbnails } = require('../services/thumbnail.service');
            const result = await batchGenerateMissingThumbnails(1000);
            logger.debug(`[缩略图补全派发] 已启动: queued=${result.queued}, skipped=${result.skipped}, processed=${result.processed}`);
        } catch (dispatchErr) {
            logger.warn(`[缩略图补全派发] 启动失败（不影响状态更新）：${dispatchErr && dispatchErr.message}`);
        }
    } catch (error) {
        logger.error('缩略图补全检查失败:', error);
        throw error;
    }
}

/**
 * 执行HLS补全检查
 * 检查哪些视频缺少HLS文件，并直接发送到视频工作线程处理
 */
async function performHlsReconcile() {
    try {
        const { dbAll } = require('../db/multi-db');
        const { getVideoWorker } = require('../services/worker.manager');
        const { promises: fs } = require('fs');
        const path = require('path');
        
        const videos = await dbAll('main', `SELECT path FROM items WHERE type='video' LIMIT 1000`);

        if (!videos || videos.length === 0) {
            logger.debug('HLS补全检查：没有发现需要处理的视频文件');
            return;
        }

        const videoWorker = getVideoWorker();
        let queued = 0;
        let skip = 0;

        for (const v of videos) {
            try {
                const master = path.join(THUMBS_DIR, 'hls', v.path, 'master.m3u8');
                try {
                    await fs.access(master);
                    skip++; // 已存在，跳过
                    continue;
                } catch {
                    // 文件不存在，需要补全HLS
                    const sourceAbsPath = path.join(PHOTOS_DIR, v.path);
                    
                    // 检查源文件是否存在
                    try {
                        await fs.access(sourceAbsPath);
                        
                        // 发送HLS处理任务到视频工作线程
                        videoWorker.postMessage({
                            filePath: sourceAbsPath,
                            relativePath: v.path,
                            thumbsDir: THUMBS_DIR
                        });
                        
                        queued++;
                        
                        // 避免一次性派发过多任务
                        if (queued % 5 === 0) {
                            await new Promise(resolve => setTimeout(resolve, 200));
                        }
                    } catch {
                        // 源文件不存在，跳过
                        continue;
                    }
                }
            } catch (e) {
                // 静默失败，继续处理其他视频
                logger.debug(`HLS补全检查视频失败: ${v.path}, ${e.message}`);
            }
        }

        logger.debug(`HLS补全检查完成：已排队 ${queued} 个视频，跳过 ${skip} 个已存在`);
    } catch (error) {
        logger.error('HLS补全检查失败:', error);
        throw error;
    }
}

/**
 * 重新同步缩略图状态
 * 手动触发缩略图状态重新同步
 */
exports.resyncThumbnails = async (req, res) => {
    try {
        console.log('Manual thumbnail resync requested');

        const syncedCount = await resyncThumbnailStatus();

        res.json({
            success: true,
            message: `缩略图状态重同步完成，共同步 ${syncedCount} 个文件`,
            data: { syncedCount },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Manual thumbnail resync failed:', error);
        res.status(500).json({
            success: false,
            error: '缩略图状态重同步失败',
            message: error.message
        });
    }
};

/**
 * 触发同步操作（删除冗余文件）
 * 删除那些源文件不存在但缩略图/HLS文件还存在的冗余文件
 */
exports.triggerCleanup = async (req, res) => {
    try {
        const { type } = req.params;
        const validTypes = ['thumbnail', 'hls', 'all'];

        if (!validTypes.includes(type)) {
            return res.status(400).json({
                success: false,
                error: '无效的同步类型',
                validTypes
            });
        }

        // 启动同步任务
        const cleanupResult = await triggerCleanupOperation(type);

        res.json({
            success: true,
            message: `已启动${getTypeDisplayName(type)}同步任务`,
            data: cleanupResult,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error(`触发${req.params.type}同步失败:`, error);
        res.status(500).json({
            success: false,
            error: '同步操作失败',
            message: error.message
        });
    }
};

/**
 * 执行缩略图同步操作
 * 删除那些源文件不存在但缩略图还存在的冗余缩略图文件
 */
async function performThumbnailCleanup() {
    try {
        const { dbAll, runAsync } = require('../db/multi-db');
        const { THUMBS_DIR, PHOTOS_DIR } = require('../config');
        const { promises: fsp } = require('fs');
        const path = require('path');

        // 获取数据库中记录的所有缩略图状态
        const allThumbs = await dbAll('main', "SELECT path, status FROM thumb_status");
        let deletedCount = 0;
        let errorCount = 0;

        for (const thumb of allThumbs) {
            try {
                // 检查源文件是否存在
                const sourcePath = path.join(PHOTOS_DIR, thumb.path);
                const sourceExists = await fsp.access(sourcePath).then(() => true).catch(() => false);

                if (!sourceExists) {
                    // 源文件不存在，删除对应的缩略图文件
                    const isVideo = /\.(mp4|webm|mov)$/i.test(thumb.path);
                    const ext = isVideo ? '.jpg' : '.webp';
                    const thumbRelPath = thumb.path.replace(/\.[^.]+$/, ext);
                    const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);

                    try {
                        await fsp.unlink(thumbAbsPath);
                        // 从数据库中删除记录
                        await runAsync('main', "DELETE FROM thumb_status WHERE path=?", [thumb.path]);
                        deletedCount++;
                        logger.info(`删除冗余缩略图文件: ${thumbAbsPath}`);
                    } catch (fileError) {
                        // 缩略图文件可能不存在，这是正常的
                        if (fileError.code !== 'ENOENT') {
                            logger.warn(`删除缩略图文件失败: ${thumbAbsPath}`, fileError);
                        }
                        // 即使文件不存在，也要删除数据库记录
                        await runAsync('main', "DELETE FROM thumb_status WHERE path=?", [thumb.path]);
                        deletedCount++;
                    }
                }
            } catch (error) {
                logger.warn(`处理缩略图同步时出错: ${thumb.path}`, error);
                errorCount++;
            }
        }

        logger.info(`缩略图同步完成：删除 ${deletedCount} 个冗余缩略图文件，${errorCount} 个处理出错`);
        return { deleted: deletedCount, errors: errorCount };
    } catch (error) {
        logger.error('缩略图同步失败:', error);
        throw error;
    }
}

/**
 * 执行HLS清理操作  
 * 删除那些源视频不存在但HLS文件还存在的冗余HLS文件
 */
async function performHlsCleanup() {
    try {
        const { dbAll } = require('../db/multi-db');
        const { THUMBS_DIR, PHOTOS_DIR } = require('../config');
        const { promises: fsp } = require('fs');
        const path = require('path');

        // 获取数据库中记录的所有视频文件
        const allVideos = await dbAll('main', "SELECT path FROM items WHERE type='video'");
        const sourceVideoPaths = new Set(allVideos.map(v => v.path));

        const hlsDir = path.join(THUMBS_DIR, 'hls');
        let deletedCount = 0;
        let errorCount = 0;

        // 递归扫描HLS目录，检查对应的源视频文件是否存在
        async function scanAndDelete(dir, relativePath = '') {
            try {
                const entries = await fsp.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    const currentRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;

                    if (entry.isDirectory()) {
                        // 递归扫描子目录
                        await scanAndDelete(fullPath, currentRelativePath);
                        
                        // 检查目录是否为空，如果为空则删除
                        try {
                            const remainingEntries = await fsp.readdir(fullPath);
                            if (remainingEntries.length === 0) {
                                await fsp.rmdir(fullPath);
                                logger.info(`删除空的HLS目录: ${fullPath}`);
                            }
                        } catch (error) {
                            // 忽略删除空目录的错误
                        }
                    } else if (entry.name === 'master.m3u8') {
                        // 找到HLS主文件，检查对应的源视频是否存在
                        // HLS文件结构：/hls/complete/video/file/path.mp4/master.m3u8
                        // 对应的源视频：/complete/video/file/path.mp4
                        
                        // relativePath 就是完整的视频文件路径（包含扩展名）
                        // 直接检查这个路径是否在数据库中存在
                        const sourceVideoExists = sourceVideoPaths.has(relativePath);
                        
                        if (!sourceVideoExists) {
                            // 源视频不存在，删除整个HLS目录
                            const dirToDelete = path.dirname(fullPath);
                            logger.warn(`准备删除HLS目录，因为找不到对应的源视频。HLS路径: ${relativePath}, 源视频路径: ${relativePath}`);
                            
                            try {
                                await fsp.rm(dirToDelete, { recursive: true, force: true });
                                deletedCount++;
                                logger.info(`删除冗余HLS目录: ${dirToDelete}`);
                            } catch (deleteError) {
                                logger.warn(`删除HLS目录失败: ${dirToDelete}`, deleteError);
                                errorCount++;
                            }
                        } else {
                            logger.debug(`保留HLS目录，因为找到对应的源视频: ${relativePath}`);
                        }
                    }
                }
            } catch (error) {
                logger.warn(`扫描HLS目录失败: ${dir}`, error);
                errorCount++;
            }
        }

        // 检查HLS目录是否存在
        try {
            await fsp.access(hlsDir);
            await scanAndDelete(hlsDir);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.warn('访问HLS目录失败:', error);
            }
        }

        logger.info(`HLS清理完成：删除 ${deletedCount} 个冗余HLS目录，${errorCount} 个处理出错`);
        return { deleted: deletedCount, errors: errorCount };
    } catch (error) {
        logger.error('HLS清理失败:', error);
        throw error;
    }
}

/**
 * 检查是否需要同步
 * 检查缩略图/HLS是否与源文件同步
 */
async function checkSyncStatus(type) {
    try {
        const { dbAll } = require('../db/multi-db');
        const { THUMBS_DIR, PHOTOS_DIR } = require('../config');
        const { promises: fsp } = require('fs');
        const path = require('path');

        if (type === 'thumbnail') {
            // 检查缩略图同步状态
            const allThumbs = await dbAll('main', "SELECT path FROM thumb_status");
            let redundantCount = 0;

            for (const thumb of allThumbs) {
                const sourcePath = path.join(PHOTOS_DIR, thumb.path);
                const sourceExists = await fsp.access(sourcePath).then(() => true).catch(() => false);
                if (!sourceExists) {
                    redundantCount++;
                }
            }

            const total = allThumbs.length;
            const synced = total - redundantCount;
            return { total, synced, redundant: redundantCount, isSynced: redundantCount === 0 };

        } else if (type === 'hls') {
            // 检查HLS同步状态
            const allVideos = await dbAll('main', "SELECT path FROM items WHERE type='video'");
            const sourceVideoPaths = new Set(allVideos.map(v => v.path));

            const hlsDir = path.join(THUMBS_DIR, 'hls');
            let totalHlsDirs = 0;
            let redundantHlsDirs = 0;

            async function scanHlsDirs(dir, relativePath = '') {
                try {
                    const entries = await fsp.readdir(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        const currentRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;

                        if (entry.isDirectory()) {
                            totalHlsDirs++;
                            const videoExists = sourceVideoPaths.has(currentRelativePath);
                            if (!videoExists) {
                                redundantHlsDirs++;
                            } else {
                                await scanHlsDirs(fullPath, currentRelativePath);
                            }
                        }
                    }
                } catch (error) {
                    // 忽略错误
                }
            }

            await scanHlsDirs(hlsDir);
            const synced = totalHlsDirs - redundantHlsDirs;
            return { total: totalHlsDirs, synced, redundant: redundantHlsDirs, isSynced: redundantHlsDirs === 0 };
        }

        return { total: 0, synced: 0, redundant: 0, isSynced: true };
    } catch (error) {
        logger.warn(`检查${type}同步状态失败:`, error);
        return { total: 0, synced: 0, redundant: 0, isSynced: false, error: error.message };
    }
}

/**
 * 触发同步操作
 * 根据类型执行相应的同步操作
 */
async function triggerCleanupOperation(type) {
    // 先检查同步状态
    const syncStatus = await checkSyncStatus(type);

    if (syncStatus.isSynced) {
        return {
            message: `${getTypeDisplayName(type)}已经处于同步状态，无需清理`,
            status: syncStatus,
            skipped: true
        };
    }

    switch (type) {
        case 'thumbnail':
            // 执行缩略图同步
            const thumbResult = await performThumbnailCleanup();
            return {
                message: `缩略图同步完成：删除 ${thumbResult.deleted} 个冗余文件`,
                status: syncStatus,
                result: thumbResult
            };

        case 'hls':
            // 执行HLS同步
            const hlsResult = await performHlsCleanup();
            return {
                message: `HLS同步完成：删除 ${hlsResult.deleted} 个冗余目录`,
                status: syncStatus,
                result: hlsResult
            };

        case 'all':
            // 执行所有同步操作
            const thumbResultAll = await performThumbnailCleanup();
            const hlsResultAll = await performHlsCleanup();
            return {
                message: `全量同步完成：缩略图删除 ${thumbResultAll.deleted} 个，HLS删除 ${hlsResultAll.deleted} 个`,
                status: {
                    thumbnail: await checkSyncStatus('thumbnail'),
                    hls: await checkSyncStatus('hls')
                },
                result: { thumbnail: thumbResultAll, hls: hlsResultAll }
            };

        default:
            throw new Error('未知的同步类型');
    }
}

/**
 * 获取类型显示名称
 */
function getTypeDisplayName(type) {
    const names = {
        'index': '索引',
        'thumbnail': '缩略图',
        'hls': 'HLS',
        'all': '全部'
    };
    return names[type] || type;
}





