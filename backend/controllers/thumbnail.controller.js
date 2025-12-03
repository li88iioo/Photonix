/**
 * 缩略图控制器
 * 负责处理缩略图的按需生成、批量补全等相关请求。
 */
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const { PHOTOS_DIR, THUMBS_DIR } = require('../config');
const { ensureThumbnailExists, batchGenerateMissingThumbnails } = require('../services/thumbnail.service');
const { getThumbStatusStats, getCount } = require('../repositories/stats.repo');
const state = require('../services/state.manager');
const { dbRun } = require('../db/multi-db');

/**
 * 内存监控，仅在开发环境启用（可通过环境变量覆盖）。
 * 默认按分钟采样，但仅每 5 分钟输出一次日志，防止刷屏。
 */
const memoryMonitorToggle = (process.env.MEMORY_MONITOR_ENABLED || '').trim().toLowerCase();
const enableMemoryMonitoring = memoryMonitorToggle
    ? memoryMonitorToggle === 'true'
    : process.env.NODE_ENV !== 'production';
const MEMORY_MONITOR_INTERVAL_MS = Math.max(60000, Number(process.env.MEMORY_MONITOR_INTERVAL_MS) || 60000);
const MEMORY_MONITOR_LOG_THROTTLE_MS = Math.max(
    MEMORY_MONITOR_INTERVAL_MS,
    Number(process.env.MEMORY_MONITOR_LOG_THROTTLE_MS) || 5 * 60 * 1000
);
const MEMORY_MONITOR_LOG_LEVEL = (process.env.MEMORY_MONITOR_LOG_LEVEL || 'debug').toLowerCase();
const logMemory = typeof logger[MEMORY_MONITOR_LOG_LEVEL] === 'function'
    ? message => logger[MEMORY_MONITOR_LOG_LEVEL](message)
    : message => logger.debug(message);

if (enableMemoryMonitoring) {
    let lastMemoryLogAt = 0;

    const emitMemoryUsage = () => {
        const memUsage = process.memoryUsage();
        const memUsageMB = {
            rss: Math.round(memUsage.rss / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024)
        };

        if (memUsageMB.heapUsed > 200) {
            logger.warn(`${LOG_PREFIXES.MEMORY_WARNING} 堆内存使用过高: ${memUsageMB.heapUsed}MB`);
        }

        if (Date.now() - lastMemoryLogAt < MEMORY_MONITOR_LOG_THROTTLE_MS) {
            return;
        }

        logMemory(
            `${LOG_PREFIXES.MEMORY_MONITOR} RSS: ${memUsageMB.rss}MB, 堆使用: ${memUsageMB.heapUsed}/${memUsageMB.heapTotal}MB, 外部: ${memUsageMB.external}MB`
        );
        lastMemoryLogAt = Date.now();
    };

    emitMemoryUsage();
    setInterval(emitMemoryUsage, MEMORY_MONITOR_INTERVAL_MS);
}

// ======== 请求频率控制参数区 ========
/** 批量补全频率限制Map */
const batchThrottleMap = new Map();

/**
 * 获取（按需生成）单个缩略图。
 * 增加频率限制，自动返回SVG占位/错误图。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getThumbnail(req, res) {
    try {
        const { path: relativePath } = req.query;

        // 节流打印缩略图日志
        if (state.logThrottle.shouldLogThumb(5000)) {
            logger.debug(`${LOG_PREFIXES.THUMB_REQUEST} 收到请求: ${relativePath}`);
        }

        if (!relativePath) {
            return res.status(400).json({ error: '缺少 path 参数' });
        }

        // 路径检查（防止路径遍历攻击）
        // 注意：必须检查路径段是否为".."，而不是简单的includes('..')
        // 因为文件名可能包含"..."（如"ご主人様...優しくしてください_"）
        const normalizedPath = path.normalize(relativePath).replace(/\\/g, '/');
        const pathSegments = normalizedPath.split('/').filter(Boolean);
        const hasPathTraversal = pathSegments.some(seg => seg === '..' || seg === '.');
        if (hasPathTraversal || normalizedPath.startsWith('/')) {
            return res.status(400).json({ error: '无效的文件路径' });
        }

        const sourceAbsPath = path.join(PHOTOS_DIR, normalizedPath);

        // 验证源文件是否存在
        try {
            await fs.access(sourceAbsPath);
        } catch (error) {
            logger.debug(`${LOG_PREFIXES.THUMB_REQUEST || '[缩略图请求]'} 源文件缺失: ${sourceAbsPath} -> ${error && error.message}`);
            await purgeOrphanMedia(normalizedPath);
            return res.status(404).json({ error: '源文件不存在' });
        }

        // 按需生成缩略图
        const result = await ensureThumbnailExists(sourceAbsPath, normalizedPath);

        // 根据文件类型确定缩略图路径
        const isVideo = /\.(mp4|webm|mov)$/i.test(normalizedPath);
        const extension = isVideo ? '.jpg' : '.webp';
        const thumbRelPath = normalizedPath.replace(/\.[^.]+$/, extension);
        const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);

        if (result.status === 'exists') {
            // 双重验证：确保文件真实存在（防止竞态条件）
            try {
                await fs.access(thumbAbsPath);
            } catch (accessError) {
                // 文件实际不存在，可能是刚生成但检查有延迟，再次检查一次
                logger.debug(`${LOG_PREFIXES.THUMB_REQUEST || '[缩略图请求]'} 缩略图文件不存在，重新验证: ${thumbAbsPath}`);
                // 短暂延迟后再次检查（给文件系统时间同步）
                await new Promise(resolve => setTimeout(resolve, 100));
                try {
                    await fs.access(thumbAbsPath);
                } catch (secondAccessError) {
                    // 仍然不存在，返回processing状态，让前端重试
                    logger.debug(`${LOG_PREFIXES.THUMB_REQUEST || '[缩略图请求]'} 缩略图文件仍不存在，返回processing状态`);
                    const loadingSvg = generateLoadingSvg();
                    res.set({
                        'Content-Type': 'image/svg+xml',
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'X-Thumbnail-Status': 'processing',
                        'X-Thumb-Status': 'processing'
                    });
                    return res.status(202).send(loadingSvg);
                }
            }

            // 文件确认存在，直接返回
            try {
                res.set({
                    'Cache-Control': 'public, max-age=2592000', // 30天
                    'Content-Type': isVideo ? 'image/jpeg' : 'image/webp'
                });
                return res.sendFile(thumbAbsPath);
            } catch (error) {
                logger.error(`发送缩略图文件失败: ${thumbAbsPath}`, error);
                return res.status(500).json({ error: '缩略图文件读取失败' });
            }
        } else if (result.status === 'processing') {
            // 正在生成，返回加载中SVG
            const loadingSvg = generateLoadingSvg();
            res.set({
                'Content-Type': 'image/svg+xml',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'X-Thumbnail-Status': 'processing',
                'X-Thumb-Status': 'processing'  // 兼容旧的响应头
            });
            return res.status(202).send(loadingSvg);
        } else {
            // 生成失败，返回错误SVG
            const errorSvg = generateErrorSvg();
            res.set({
                'Content-Type': 'image/svg+xml',
                'Cache-Control': 'public, max-age=300',
                'X-Thumbnail-Status': 'failed',
                'X-Thumb-Status': 'failed'  // 兼容旧的响应头
            });
            return res.status(404).send(errorSvg);
        }
    } catch (error) {
        logger.error('获取缩略图时发生错误:', error);
        const errorSvg = generateErrorSvg();
        res.set({
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'no-cache'
        });
        return res.status(500).send(errorSvg);
    }
}

/**
 * 批量补全缺失的缩略图（用于设置页发起补全）。
 * 支持自动循环补全（loop=true），频率限制防止滥用。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function batchGenerateThumbnails(req, res) {
    try {
        const { limit = 1000 } = req.body;

        // 限制批量补全调用频率（每用户30秒一次）
        const now = Date.now();
        const userKey = `batch_${req.user?.id || 'anonymous'}`;
        const lastBatchTime = batchThrottleMap.get(userKey) || 0;

        if (now - lastBatchTime < 30000) {
            const remaining = Math.ceil((30000 - (now - lastBatchTime)) / 1000);
            logger.warn(`${LOG_PREFIXES.BATCH_BACKFILL} 频率过高，用户 ${userKey} 需等待 ${remaining} 秒`);
            return res.status(429).json({
                code: 'RATE_LIMIT_EXCEEDED',
                message: `批量补全过于频繁，请等待 ${remaining} 秒后再试`,
                retryAfter: remaining
            });
        }

        // 更新限制时间
        batchThrottleMap.set(userKey, now);

        // 清理过多的记录，防止泄漏
        if (batchThrottleMap.size > 1000) {
            const cutoff = now - 60000;
            for (const [key, timestamp] of batchThrottleMap.entries()) {
                if (timestamp < cutoff) {
                    batchThrottleMap.delete(key);
                }
            }
        }

        // limit校验
        const processLimit = Math.min(Math.max(1, parseInt(limit) || 1000), 5000);

        // 日志调试信息
        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 收到请求参数: limit=${limit}, loop=${req.body?.loop}, mode=${req.body?.mode}`);
        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 请求体: ${JSON.stringify(req.body)}`);
        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 请求体类型: ${typeof req.body}, 键: ${Object.keys(req.body || {})}`);
        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} req.body.loop 类型: ${typeof req.body?.loop}, 值: ${req.body?.loop}`);

        /**
         * 检查是否需要循环补全
         * loop=true 或 mode=loop 进入自动循环模式
         */
        const loopFlag = (
            String(req.body?.loop ?? '').toLowerCase() === 'true' ||
            req.body?.loop === true ||
            String(req.body?.mode ?? '').toLowerCase() === 'loop'
        );

        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 循环标志判断结果: loopFlag=${loopFlag}`);

        if (loopFlag) {
            logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 自动循环模式启动：单批限制 ${processLimit}`);
            // 启动循环标记，防止任务池提前销毁
            state.thumbnail.setBatchLoopActive(true);
            setImmediate(async () => {
                try {
                    let rounds = 0;
                    let totalProcessed = 0, totalQueued = 0, totalSkipped = 0;
                    while (true) {
                        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 开始第${rounds + 1}轮处理`);
                        const r = await batchGenerateMissingThumbnails(processLimit);
                        rounds++;
                        totalProcessed += r?.processed || 0;
                        totalQueued += r?.queued || 0;
                        totalSkipped += r?.skipped || 0;
                        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 第${rounds}轮完成: processed=${r?.processed || 0}, queued=${r?.queued || 0}, skipped=${r?.skipped || 0}, foundMissing=${r?.foundMissing || 0}`);
                        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 累计统计: totalProcessed=${totalProcessed}, totalQueued=${totalQueued}, totalSkipped=${totalSkipped}`);
                        if (!r || (r.foundMissing || 0) === 0) {
                            logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 检测到无更多缺失任务，第${rounds}轮后退出循环`);
                            logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 退出时状态: r=${!!r}, foundMissing=${r?.foundMissing || 0}, queued=${r?.queued || 0}`);
                            break;
                        }
                        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 第${rounds}轮后继续下一轮处理，等待2秒...`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                    logger.info(`${LOG_PREFIXES.BATCH_BACKFILL} 自动循环完成：轮次=${rounds} processed=${totalProcessed} queued=${totalQueued} skipped=${totalSkipped}`);
                } catch (e) {
                    logger.error('自动循环批量补全失败:', e);
                } finally {
                    state.thumbnail.setBatchLoopActive(false);
                }
            });
            return res.json({
                success: true,
                message: '批量补全已启动（自动循环直到无缺失）',
                data: { mode: 'loop', limit: processLimit }
            });
        }

        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 开始批量生成缩略图，限制: ${processLimit}`);

        const result = await batchGenerateMissingThumbnails(processLimit);

        // 普通模式确保循环标志已清除
        state.thumbnail.setBatchLoopActive(false);

        res.json({
            success: true,
            message: result.message,
            data: {
                processed: result.processed,
                queued: result.queued,
                skipped: result.skipped,
                limit: processLimit
            }
        });
    } catch (error) {
        logger.error('批量生成缩略图失败:', error);
        res.status(500).json({
            success: false,
            error: '批量生成缩略图失败',
            message: error.message
        });
    }
}

/**
 * 获取缩略图生成状态统计。
 * 用于设置页展示缩略图任务状态及调试数据。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getThumbnailStats(req, res) {
    try {
        const { dbAll } = require('../db/multi-db');

        // 查询缩略图状态统计
        const statusStats = await getThumbStatusStats();
        const totalCount = await getCount('thumb_status');

        // 整理统计结果
        const existsResult = { count: statusStats.exists || 0 };
        const missingResult = { count: statusStats.missing || 0 };
        const failedResult = { count: statusStats.failed || 0 };
        const pendingResult = { count: statusStats.pending || 0 };
        const totalResult = { total: totalCount };

        // debug模式下返回部分缺失/失败样本
        if (req.query.debug === 'true') {
            const sampleMissing = await dbAll('main', 'SELECT path FROM thumb_status WHERE status = ? LIMIT 10', ['missing']);
            const sampleFailed = await dbAll('main', 'SELECT path FROM thumb_status WHERE status = ? LIMIT 5', ['failed']);
            const samplePending = await dbAll('main', 'SELECT path FROM thumb_status WHERE status = ? LIMIT 5', ['pending']);

            return res.json({
                success: true,
                data: {
                    exists: existsResult?.count || 0,
                    missing: missingResult?.count || 0,
                    failed: failedResult?.count || 0,
                    pending: pendingResult?.count || 0,
                    total: totalResult?.total || 0,
                    activeTasks: state.thumbnail.getActiveCount(),
                    debug: {
                        sampleMissing: sampleMissing?.map(row => row.path) || [],
                        sampleFailed: sampleFailed?.map(row => row.path) || [],
                        samplePending: samplePending?.map(row => row.path) || []
                    }
                }
            });
        }

        res.json({
            success: true,
            data: {
                exists: existsResult?.count || 0,
                missing: missingResult?.count || 0,
                failed: failedResult?.count || 0,
                pending: pendingResult?.count || 0,
                total: totalResult?.total || 0,
                activeTasks: state.thumbnail.getActiveCount()
            }
        });
    } catch (error) {
        logger.error('获取缩略图统计失败:', error);
        res.status(500).json({
            success: false,
            error: '获取缩略图统计失败',
            message: error.message
        });
    }
}

/**
 * 返回加载中SVG占位图（用于缩略图生成中）。
 * @returns {string} SVG字符串
 */
function generateLoadingSvg() {
    return `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect width="200" height="200" fill="#f0f0f0"/>
        <circle cx="100" cy="100" r="20" fill="none" stroke="#007bff" stroke-width="3">
            <animate attributeName="stroke-dasharray" values="0 126;63 63;0 126" dur="1.5s" repeatCount="indefinite"/>
            <animate attributeName="stroke-dashoffset" values="0;-63;-126" dur="1.5s" repeatCount="indefinite"/>
        </circle>
        <text x="100" y="140" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#666">
            生成中...
        </text>
    </svg>`;
}

/**
 * 返回缩略图生成失败时的SVG占位图。
 * @returns {string} SVG字符串
 */
function generateErrorSvg() {
    return `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect width="200" height="200" fill="#f8f9fa"/>
        <circle cx="100" cy="100" r="30" fill="none" stroke="#dc3545" stroke-width="2"/>
        <line x1="85" y1="85" x2="115" y2="115" stroke="#dc3545" stroke-width="2"/>
        <line x1="115" y1="85" x2="85" y2="115" stroke="#dc3545" stroke-width="2"/>
        <text x="100" y="140" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#666">
            无法生成
        </text>
    </svg>`;
}

module.exports = {
    getThumbnail,
    batchGenerateThumbnails,
    getThumbnailStats,
    generateErrorSvg
};
async function purgeOrphanMedia(pathValue) {
    const cleanPath = typeof pathValue === 'string' ? pathValue.trim() : '';
    if (!cleanPath) return;
    try {
        const deleteItems = await dbRun('main', 'DELETE FROM items WHERE path = ?', [cleanPath]);
        const deleteThumb = await dbRun('main', 'DELETE FROM thumb_status WHERE path = ?', [cleanPath]);
        const removed = (deleteItems?.changes || 0) + (deleteThumb?.changes || 0);
        if (removed > 0) {
            logger.info(`${LOG_PREFIXES.THUMB_REQUEST || '[缩略图请求]'} 检测到孤立缩略图记录，已自动清理: ${cleanPath}`);
        }
    } catch (purgeError) {
        logger.debug(`${LOG_PREFIXES.THUMB_REQUEST || '[缩略图请求]'} 自动清理孤立缩略图记录失败 (path=${cleanPath}): ${purgeError && purgeError.message}`);
    }
}
