/**
 * 索引服务模块
 * 管理文件系统监控、索引重建、增量更新和缩略图生成协调
 */
const chokidar = require('chokidar');
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { invalidateTags } = require('./cache.service');
const { PHOTOS_DIR, THUMBS_DIR, INDEX_STABILIZE_DELAY_MS, TAG_INVALIDATION_MAX_TAGS, ROUTE_CACHE_BROWSE_PATTERN, THUMB_CHECK_BATCH_SIZE, THUMB_CHECK_BATCH_DELAY_MS } = require('../config');
const { dbRun, runPreparedBatch, dbAll } = require('../db/multi-db');
const { getIndexingWorker, getVideoWorker, ensureCoreWorkers } = require('./worker.manager');
const { shouldDisableHlsBackfill } = require('./adaptive.service');
const { startIdleThumbnailGeneration, lowPriorityThumbnailQueue, dispatchThumbnailTask, isTaskQueuedOrActive } = require('./thumbnail.service');
const settingsService = require('./settings.service');
const { invalidateCoverCache } = require('./file.service');
const crypto = require('crypto');

// 依赖文件服务的封面批处理能力
const { findCoverPhotosBatchDb } = require('./file.service');

// 索引服务状态管理
let rebuildTimeout;           // 重建超时定时器
let isIndexing = false;       // 索引进行中标志
let pendingIndexChanges = []; // 待处理的索引变更队列
// 背景缩略图补齐循环运行标记，避免重复并行循环占用资源
let thumbBgLoopActive = false;

/**
 * 设置工作线程监听器
 * 为索引工作线程、设置工作线程和视频工作线程添加消息处理
 */
function setupWorkerListeners() {
    // 确保核心 worker 已创建
    const indexingWorker = getIndexingWorker();
    const videoWorker = getVideoWorker();

    // 索引工作线程消息处理
    indexingWorker.on('message', async (msg) => {
        logger.debug(`收到来自 Indexing Worker 的消息: ${msg.type}`);
        switch (msg.type) {
            case 'rebuild_complete':
                logger.info(`[Main-Thread] Indexing Worker 完成索引重建，共处理 ${msg.count} 个条目。`);
                isIndexing = false;
                logger.info('[Main-Thread] 准备启动智能缩略图后台生成任务...');
                startIdleThumbnailGeneration();

                // 索引完成后，触发一次性的HLS视频流回填任务
                try {
                    if (shouldDisableHlsBackfill()) {
                        logger.warn('[Main-Thread] 自适应模式：当前禁用 HLS 回填，跳过触发。');
                    } else {
                        logger.info('[Main-Thread] 触发 HLS 回填任务，为所有已存在视频生成码率流...');
                        const videoWorker = getVideoWorker();
                        videoWorker.postMessage({ type: 'backfill' });
                    }
                } catch (e) {
                    logger.warn('[Main-Thread] 触发 HLS 回填任务失败（忽略）:', e && e.message);
                }

                // 全量重建完成后，触发一次视频 faststart 扫描（仅对未优化的视频排队）
                try {
                    const rows = await dbAll('main', `SELECT path FROM items WHERE type='video'`);
                    if (rows && rows.length) {
                        const vw = getVideoWorker();
                        for (const r of rows) {
                            try { 
                                // 统一消息格式：为旧的 faststart 任务也补全新逻辑需要的字段
                                vw.postMessage({ 
                                    filePath: path.join(PHOTOS_DIR, r.path),
                                    relativePath: r.path,
                                    thumbsDir: THUMBS_DIR
                                }); 
                            } catch {}
                        }
                        logger.info(`[Main-Thread] 已为 ${rows.length} 个视频触发一次 faststart 检查/优化。`);
                    }
                } catch (e) {
                    logger.warn('[Main-Thread] 触发视频 faststart 扫描失败（忽略）:', e && e.message);
                }
                break;

            case 'all_media_items_result':
                // 收到所有媒体项目，开始批量检查缩略图
                if (thumbBgLoopActive) {
                    logger.debug('[Main-Thread] 背景缩略图循环已在运行，忽略重复触发。');
                    break;
                }
                thumbBgLoopActive = true;
                let items = msg.payload || [];

                // 额外防御：过滤掉非媒体扩展的历史脏数据、临时文件和临时目录，并尝试清理数据库索引中的无效条目
                const isMediaPath = (p) => /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(p || '');
                const isNotTempFile = (p) => !p.includes('/.tmp/') && !p.includes('\\.tmp\\') && !p.startsWith('temp_opt_') && !p.endsWith('.tmp');
                const validItems = items.filter(it => isMediaPath(it.path) && isNotTempFile(it.path));
                const invalidItems = items.filter(it => !isMediaPath(it.path) || !isNotTempFile(it.path));
                if (invalidItems.length > 0) {
                    try {
                        const badPaths = invalidItems.map(it => it.path);
                        const placeholders = badPaths.map(() => '?').join(',');
                        await dbRun('main', `DELETE FROM items WHERE path IN (${placeholders})`, badPaths);
                        // 清理孤立的 FTS 记录
                        await dbRun('main', `DELETE FROM items_fts WHERE rowid NOT IN (SELECT rowid FROM items)`);
                        logger.info(`[Main-Thread] 清理无效媒体索引和临时文件 ${invalidItems.length} 条。`);
                    } catch (e) {
                        logger.warn(`[Main-Thread] 清理无效媒体索引失败: ${e.message}`);
                    }
                    items = validItems;
                }
                logger.info(`[Main-Thread] 收到 ${items.length} 个媒体项目，开始按数据库“缺失集合”入队后台缩略图任务...`);
                // 自适应调度参数（不依赖 .env，自动调节）
                const MIN_PAGE_SIZE = 100;
                const MAX_PAGE_SIZE = 800;
                let pageSize = 200;

                const MIN_DELAY = 80;
                const MAX_DELAY = 500;
                let dynamicBatchDelay = 200;

                let lastTuneLogTs = 0;

                const processLoop = async () => {
                    try {
                        // 低档位（auto 切到 low）暂缓后台扫描，减少与前端/回填的 DB/I/O 争用
                        try {
                            const { getCurrentMode } = require('./adaptive.service');
                            if (getCurrentMode && getCurrentMode() === 'low') {
                                logger.debug('[Main-Thread] 自适应 low 档：暂停一轮缩略图缺失扫描');
                                setTimeout(processLoop, 1000);
                                return;
                            }
                        } catch {}
                        const t0 = Date.now();
                        const rows = await require('../db/multi-db').dbAll('main',
                            `SELECT i.path, i.type, i.mtime
                             FROM items i
                             LEFT JOIN thumb_status t ON t.path = i.path
                             WHERE i.type IN ('photo','video')
                               AND (
                                   t.mtime IS NULL              -- 从未生成
                                   OR t.mtime < i.mtime         -- 源文件已更新
                                   OR t.status IN ('pending','failed') -- 待处理/失败均需要生成
                               )
                             ORDER BY i.mtime DESC
                             LIMIT ?`, [pageSize]
                        );
                        const durationMs = Date.now() - t0;
                        const batch = rows || [];
                        if (batch.length === 0) {
                            // 降低噪声：改为 debug，避免频繁刷屏
                            logger.debug('[Main-Thread] 数据库未发现需要生成的缩略图，后台任务结束。');
                            thumbBgLoopActive = false;
                            return;
                        }
                        for (const item of batch) {
                            const sourceAbsPath = path.join(PHOTOS_DIR, item.path);

                            // 跳过已被标记为永久失败的缩略图（根据 Redis 标记）
                            try {
                                const failureKey = `thumb_failed_permanently:${item.path}`;
                                const permanentlyFailed = await redis.get(failureKey);
                                if (permanentlyFailed) {
                                    // 可选：更新一次检查时间，避免长时间卡在“失败待处理”视觉状态
                                    try {
                                        await dbRun('main', `INSERT INTO thumb_status(path, mtime, status, last_checked)
                                                              VALUES(?, ?, 'failed', strftime('%s','now')*1000)
                                                              ON CONFLICT(path) DO UPDATE SET last_checked=excluded.last_checked`,
                                            [item.path, item.mtime || Date.now()]);
                                    } catch {}
                                    continue;
                                }
                            } catch {}

                            if (!isTaskQueuedOrActive(item.path)) {
                                lowPriorityThumbnailQueue.push({
                                    filePath: sourceAbsPath,
                                    relativePath: item.path,
                                    type: item.type
                                });
                            }
                        }
                        dispatchThumbnailTask();

                        // 自适应调参：快则加大批量/缩短间隔，慢则降低批量/拉长间隔
                        const prevPage = pageSize;
                        const prevDelay = dynamicBatchDelay;
                        if (durationMs < 150 && batch.length >= Math.max(20, Math.floor(pageSize * 0.8))) {
                            // DB 很空闲且批次几乎打满，提速
                            pageSize = Math.min(MAX_PAGE_SIZE, pageSize + Math.ceil(pageSize * 0.25));
                            dynamicBatchDelay = Math.max(MIN_DELAY, dynamicBatchDelay - 10);
                        } else if (durationMs > 1200) {
                            // DB 繁忙，降速
                            pageSize = Math.max(MIN_PAGE_SIZE, Math.floor(pageSize * 0.7));
                            dynamicBatchDelay = Math.min(MAX_DELAY, dynamicBatchDelay + 40);
                        }
                        if ((pageSize !== prevPage || dynamicBatchDelay !== prevDelay) && Date.now() - lastTuneLogTs > 30000) {
                            lastTuneLogTs = Date.now();
                            logger.info(`[Main-Thread] 缩略图后台扫描自适应调度: pageSize=${pageSize}, delay=${dynamicBatchDelay}ms (duration=${durationMs}ms, batch=${batch.length})`);
                        }
                    } catch (e) {
                        // 降噪：只在间隔性打印一次 warn，其余打印为 debug，同时降速
                        const msg = e && e.message ? e.message : String(e);
                        if (!global.__thumbMissingWarnTs || Date.now() - global.__thumbMissingWarnTs > 30000) {
                            global.__thumbMissingWarnTs = Date.now();
                            logger.warn('[Main-Thread] 获取缩略图缺失集合失败（重试中）:', msg);
                        } else {
                            logger.debug('[Main-Thread] 获取缩略图缺失集合失败（重试中，已降噪）:', msg);
                        }
                        // 遇到错误则退避，并反馈给 DB 自适应：适度拉长查询超时/忙等待
                        pageSize = Math.max(MIN_PAGE_SIZE, Math.floor(pageSize * 0.6));
                        dynamicBatchDelay = Math.min(MAX_DELAY, dynamicBatchDelay + 80);
                        try {
                            const { adaptDbTimeouts } = require('../db/multi-db');
                            adaptDbTimeouts({
                                busyTimeoutDeltaMs: +2000,   // +2s 上限 60s
                                queryTimeoutDeltaMs: +2000,  // +2s 上限 60s
                            });
                        } catch {}
                    }
                    setTimeout(processLoop, dynamicBatchDelay);
                };
                processLoop();
                break;

            case 'process_changes_complete':
                // 增量更新完成
                logger.info('[Main-Thread] Indexing Worker 完成索引增量更新。');
                isIndexing = false;
                // 增量完成后，提示并启动一次后台缩略图检查（更直观的进度日志）
                try {
                    logger.info('[Main-Thread] 增量完成，启动后台缩略图检查任务...');
                    startIdleThumbnailGeneration();
                } catch (e) {
                    logger.warn('触发后台缩略图检查失败:', e && e.message);
                }

                // 对本批次变更中的视频，触发一次 faststart 检查/优化
                try {
                    const changes = Array.isArray(pendingIndexChanges) ? [...pendingIndexChanges] : [];
                    const vw = getVideoWorker();
                    for (const ch of changes) {
                        if (ch && ch.filePath && /\.(mp4|webm|mov)$/i.test(ch.filePath)) {
                            try { 
                                // 统一消息格式：为增量 faststart 任务也补全新逻辑需要的字段
                                const relativePath = path.relative(PHOTOS_DIR, ch.filePath);
                                vw.postMessage({ 
                                    filePath: ch.filePath,
                                    relativePath: relativePath,
                                    thumbsDir: THUMBS_DIR
                                }); 
                            } catch {}
                        }
                    }
                } catch (e) {
                    logger.debug('增量 faststart 触发失败（忽略）：', e && e.message);
                }

                // 新增：主动重算受影响相册的封面，写入 album_covers 表
                try {
                    await recomputeAndPersistAlbumCovers();
                } catch (e) {
                    logger.warn('主动重算相册封面失败（忽略）:', e && e.message);
                }

                // 新增：后台回填缺失的媒体尺寸，减少运行时探测
                try {
                    logger.info('[Main-Thread] 触发一次媒体尺寸回填后台任务...');
                    const worker = getIndexingWorker();
                    worker.postMessage({ type: 'backfill_missing_dimensions', payload: { photosDir: PHOTOS_DIR } });
                } catch (e) {
                    logger.warn('触发媒体尺寸回填失败（忽略）:', e && e.message);
                }

                // 新增：后台回填缺失的 mtime，避免运行时频繁 fs.stat
                try {
                    logger.info('[Main-Thread] 触发一次 mtime 回填后台任务...');
                    const worker = getIndexingWorker();
                    worker.postMessage({ type: 'backfill_missing_mtime', payload: { photosDir: PHOTOS_DIR } });
                } catch (e) {
                    logger.warn('触发 mtime 回填失败（忽略）:', e && e.message);
                }
                break;
                
            case 'backfill_dimensions_complete':
                // 尺寸回填完成事件：记录更新条数
                try {
                    const updated = typeof msg.updated === 'number' ? msg.updated : 0;
                    logger.info(`[Main-Thread] 媒体尺寸回填完成，更新 ${updated} 条记录。`);
                } catch (e) {
                    logger.debug('[Main-Thread] 记录尺寸回填结果失败（忽略）');
                }
                break;

            case 'error':
                // 索引工作线程报告错误
                logger.error(`[Main-Thread] Indexing Worker 报告一个错误: ${msg.error}`);
                isIndexing = false;
                break;
            default:
                logger.warn(`[Main-Thread] 收到来自Indexing Worker的未知消息类型: ${msg.type}`);
        }
    });

    // 设置工作线程消息处理
    const { getSettingsWorker } = require('./worker.manager');
    const settingsWorker = getSettingsWorker();
    settingsWorker.on('message', (msg) => {
        logger.debug(`收到来自 Settings Worker 的消息: ${msg.type}`);
        switch (msg.type) {
            case 'settings_update_complete':
                // 设置更新成功
                logger.info(`[Main-Thread] 设置更新成功: ${msg.updatedKeys.join(', ')}`);
                settingsService.clearCache();
                // 更新设置状态（如果控制器可用）
                try {
                    const { updateSettingsStatus } = require('../controllers/settings.controller');
                    updateSettingsStatus('success', '设置更新成功');
                } catch (e) {
                    logger.debug('无法更新设置状态（控制器可能未加载）');
                }
                break;
                
            case 'settings_update_failed':
                // 设置更新失败
                logger.error(`[Main-Thread] 设置更新失败: ${msg.error}, 涉及设置: ${msg.updatedKeys.join(', ')}`);
                // 更新设置状态（如果控制器可用）
                try {
                    const { updateSettingsStatus } = require('../controllers/settings.controller');
                    updateSettingsStatus('failed', msg.error);
                } catch (e) {
                    logger.debug('无法更新设置状态（控制器可能未加载）');
                }
                break;
                
            default:
                logger.warn(`[Main-Thread] 收到来自Settings Worker的未知消息类型: ${msg.type}`);
        }
    });

    // 索引工作线程错误和退出处理
    indexingWorker.on('error', (err) => {
        logger.error(`[Main-Thread] Indexing Worker 遇到致命错误，索引功能可能中断: ${err.message}`, err);
        isIndexing = false;
    });

    indexingWorker.on('exit', (code) => {
        if (code !== 0) {
            logger.warn(`[Main-Thread] Indexing Worker 意外退出，退出码: ${code}。索引功能将停止。`);
        }
        isIndexing = false;
    });

    // 视频工作线程消息处理
    videoWorker.on('message', (result) => {
        if (result.success) {
            logger.info(`视频处理完成或跳过: ${result.path}`);
            // 将处理完成的视频添加到待索引队列
            if (!pendingIndexChanges.some(c => c.filePath === result.path)) {
                pendingIndexChanges.push({ type: 'add', filePath: result.path });
            }
            triggerDelayedIndexProcessing();
        } else {
            logger.error(`视频处理失败: ${result.path}, 原因: ${result.error}`);
        }
    });

    videoWorker.on('error', (err) => logger.error(`视频处理器Worker遇到错误: ${err.message}`));
}

/**
 * 计算文件内容哈希值（SHA256）
 * 用于检测文件是否真正发生变化
 * @param {string} filePath - 文件路径
 * @returns {Promise<string|null>} 文件哈希值或null
 */
async function computeFileHash(filePath) {
    // 使用流式处理避免大文件导致内存溢出
    const fs = require('fs'); // 需要引入核心fs模块以使用createReadStream
    return new Promise((resolve) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => {
            hash.update(data);
        });
        stream.on('end', () => {
            resolve(hash.digest('hex'));
        });
        stream.on('error', (err) => {
            logger.warn(`流式计算文件 hash 失败: ${filePath}`, err);
            resolve(null); // 发生错误时返回 null，保持原有行为
        });
    });
}

/**
 * 合并索引变更事件
 * 将连续的变更事件合并，避免重复处理
 * @param {Array} changes - 原始变更事件数组
 * @returns {Array} 合并后的变更事件数组
 */
    function consolidateIndexChanges(changes) {
    logger.info(`开始合并 ${changes.length} 个原始变更事件...`);
    const changeMap = new Map();
    
    for (const change of changes) {
        const { type, filePath, hash } = change;
        const existingChange = changeMap.get(filePath);
        
        if (existingChange) {
            // --- 合并规则 ---
            // 1) add -> unlink（抖动）：直接抵消（无变化）。不依赖 hash。
            if ((existingChange.type === 'add' && type === 'unlink') || (existingChange.type === 'addDir' && type === 'unlinkDir')) {
                changeMap.delete(filePath);
                continue;
            }

            // 2) unlink 之后出现 add：视为真正的更新（文件被替换/重建）。
            if ((existingChange.type === 'unlink' && type === 'add') || (existingChange.type === 'unlinkDir' && type === 'addDir')) {
                changeMap.set(filePath, { ...change, type: 'update' });
                continue;
            }

            // 3) 连续 add 且 hash 相同：保留一次
            if (existingChange.type === 'add' && type === 'add' && existingChange.hash && existingChange.hash === hash) {
                changeMap.set(filePath, change);
                continue;
            }

            // 4) 其它同路径变化：统一视为 update（例如 add -> add(hash 变) / update -> unlink 之外情况）
            changeMap.set(filePath, { ...change, type: 'update' });
        } else {
            changeMap.set(filePath, change);
        }
    }
    
    const consolidated = Array.from(changeMap.values());
    logger.info(`合并后剩余 ${consolidated.length} 个有效变更事件。`);
    return consolidated;
}

/**
 * 构建搜索索引
 * 执行全量索引重建
 */
async function buildSearchIndex() {
    if (isIndexing) {
        logger.warn('索引任务已在进行中，本次全量重建请求被跳过。');
        return;
    }
    isIndexing = true;
    logger.info('向 Indexing Worker 发送索引重建任务...');
    const worker = getIndexingWorker();
    worker.postMessage({ type: 'rebuild_index', payload: { photosDir: PHOTOS_DIR } });
}

/**
 * 处理待处理的索引变更
 * 执行增量索引更新
 */
async function processPendingIndexChanges() {
    if (isIndexing) {
        logger.warn('索引任务已在进行中，本次增量更新请求被跳过。');
        return;
    }
    if (pendingIndexChanges.length === 0) return;

    const changesToProcess = consolidateIndexChanges(pendingIndexChanges);
    pendingIndexChanges = [];

    if (changesToProcess.length === 0) {
        logger.info('所有文件变更相互抵消，无需更新索引。');
        return;
    }

    if (changesToProcess.length > 5000) {
        logger.warn(`检测到超过 5000 个文件变更，将执行全量索引重建以保证数据一致性。`);
        await buildSearchIndex();
        return;
    }

    // 执行增量索引更新
    isIndexing = true;
    logger.info(`向 Indexing Worker 发送 ${changesToProcess.length} 个索引变更以进行处理...`);
    const worker = getIndexingWorker();
    worker.postMessage({ type: 'process_changes', payload: { changes: changesToProcess, photosDir: PHOTOS_DIR } });
}

/**
 * 触发延迟索引处理
 * 在文件系统稳定后清理相关缓存并处理索引变更
 * 使用5秒延迟确保文件系统操作完成
 */
function triggerDelayedIndexProcessing() {
    clearTimeout(rebuildTimeout);
    // 自适应聚合延迟：根据近期变更密度放大延迟，降低抖动
    const dynamicDelay = (() => {
        const changes = pendingIndexChanges.length;
        if (changes > 10000) return Math.max(INDEX_STABILIZE_DELAY_MS, 30000);
        if (changes > 5000) return Math.max(INDEX_STABILIZE_DELAY_MS, 20000);
        if (changes > 1000) return Math.max(INDEX_STABILIZE_DELAY_MS, 10000);
        return INDEX_STABILIZE_DELAY_MS;
    })();

    rebuildTimeout = setTimeout(async () => {
        logger.info('文件系统稳定，开始按标签精细化失效缓存并处理索引变更...');
        try {
            // 基于当前待处理的变更，推导受影响的相册层级标签
            const pendingSnapshot = Array.isArray(pendingIndexChanges) ? [...pendingIndexChanges] : [];
            const albumTags = new Set();
            for (const change of pendingSnapshot) {
                const rawPath = change && change.filePath ? String(change.filePath) : '';
                if (!rawPath) continue;
                // 仅处理位于 PHOTOS_DIR 下的路径
                if (!rawPath.startsWith(PHOTOS_DIR)) continue;
                const rel = rawPath.substring(PHOTOS_DIR.length).replace(/\\/g, '/').replace(/^\/+/, '');
                if (!rel) {
                    albumTags.add('album:/');
                    continue;
                }
                // 目录标签链：album:/、album:/A、album:/A/B ...
                const isDirEvent = change.type === 'addDir' || change.type === 'unlinkDir';
                const relDir = isDirEvent ? rel : rel.split('/').slice(0, -1).join('/');
                const segments = relDir.split('/').filter(Boolean);
                let current = '';
                albumTags.add('album:/');
                for (const seg of segments) {
                    current = `${current}/${seg}`;
                    albumTags.add(`album:${current}`);
                }
            }

            if (albumTags.size > 0) {
                const tagsArr = Array.from(albumTags);
                const dynamicTagLimit = (() => {
                    const changes = pendingIndexChanges.length;
                    if (changes > 10000) return Math.max(TAG_INVALIDATION_MAX_TAGS || 2000, 6000);
                    if (changes > 5000) return Math.max(TAG_INVALIDATION_MAX_TAGS || 2000, 4000);
                    if (changes > 1000) return Math.max(TAG_INVALIDATION_MAX_TAGS || 2000, 3000);
                    return TAG_INVALIDATION_MAX_TAGS || 2000;
                })();

                if (tagsArr.length > dynamicTagLimit) {
                    // 标签数过大，自动降级：粗粒度清理 browse 路由缓存
                    try {
                        let cursor = '0';
                        let cleared = 0;
                        do {
                            const res = await redis.scan(cursor, 'MATCH', ROUTE_CACHE_BROWSE_PATTERN, 'COUNT', 1000);
                            cursor = res[0];
                            const keys = res[1] || [];
                            if (keys.length > 0) {
                                if (typeof redis.unlink === 'function') await redis.unlink(...keys); else await redis.del(...keys);
                                cleared += keys.length;
                            }
                        } while (cursor !== '0');
                        logger.info(`[Index] 标签数量 ${tagsArr.length} 超过上限 ${dynamicTagLimit}，已降级清理 browse 路由缓存，共 ${cleared} 个键。`);
                    } catch (e) {
                        logger.warn(`[Index] 降级清理 browse 路由缓存失败: ${e && e.message}`);
                    }
                } else {
                    await invalidateTags(tagsArr);
                    logger.info(`[Index] 已按标签失效路由缓存：${tagsArr.length} 个相册层级标签。`);
                }
            }
        } catch (err) {
            logger.warn('按标签精细化失效缓存时出错（将继续处理索引变更）:', err && err.message ? err.message : err);
        }

        try {
            await processPendingIndexChanges();
        } catch (err) {
            logger.error('处理索引变更失败:', err);
        }
    }, dynamicDelay); // 自适应延迟，等待文件系统稳定
}


/**
 * 监控照片目录
 * 使用chokidar库监控文件系统变化，处理文件添加、删除、目录创建等事件
 */
function watchPhotosDir() {
    // 配置chokidar文件监控器
    const watcher = chokidar.watch(PHOTOS_DIR, {
        ignoreInitial: true,    // 忽略初始扫描
        persistent: true,       // 持续监控
        depth: 99,              // 监控深度99层
        ignored: [
            /(^|[\/\\])\..|@eaDir/,  // 忽略隐藏文件和Synology系统目录
            /(^|[\/\\])\.tmp/,        // 忽略临时目录
            /temp_opt_.*/,            // 忽略临时文件
            /.*\.tmp$/                // 忽略.tmp后缀文件
        ],
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }, // 等待文件写入完成
        // 在 SMB/NFS/网络挂载/某些 Windows 环境下，FS 事件可能丢失；允许通过环境变量切换为轮询模式
        usePolling: (process.env.WATCH_USE_POLLING || 'false').toLowerCase() === 'true',
        interval: Number(process.env.WATCH_POLL_INTERVAL || 1000),
        binaryInterval: Number(process.env.WATCH_POLL_BINARY_INTERVAL || 1500),
    });

    if ((process.env.WATCH_USE_POLLING || 'false').toLowerCase() === 'true') {
        logger.warn('[Watcher] 已启用轮询模式(usePolling)。interval=%dms binaryInterval=%dms',
            Number(process.env.WATCH_POLL_INTERVAL || 1000),
            Number(process.env.WATCH_POLL_BINARY_INTERVAL || 1500));
    }

    /**
     * 文件变更事件处理函数
     * 处理文件添加、删除、目录创建等事件
     * @param {string} type - 事件类型（add, unlink, addDir, unlinkDir）
     * @param {string} filePath - 文件路径
     */
    const onFileChange = async (type, filePath) => {
        logger.debug(`检测到文件变动: ${filePath} (${type})。等待文件系统稳定...`);

        // 智能失效封面缓存
        try {
            await invalidateCoverCache(filePath);
        } catch (error) {
            logger.warn(`智能失效封面缓存失败: ${filePath}`, error);
        }

        // 处理新视频文件，发送到视频处理器进行优化（先检查永久失败标记）
        if (type === 'add' && /\.(mp4|webm|mov)$/i.test(filePath)) {
            try {
                const failureKey = `video_failed_permanently:${filePath}`;
                const failed = await redis.get(failureKey);
                if (failed) {
                    logger.debug(`检测到永久失败标记，跳过视频处理: ${filePath}`);
                } else {
                    logger.info(`检测到新视频文件，发送到处理器进行优化: ${filePath}`);
                    // 统一消息格式：为新视频文件处理也补全新逻辑需要的字段
                    const relativePath = path.relative(PHOTOS_DIR, filePath);
                    const vw = getVideoWorker();
                    vw.postMessage({ 
                        filePath,
                        relativePath: relativePath,
                        thumbsDir: THUMBS_DIR
                    });
                }
            } catch (e) {
                logger.warn(`检查视频永久失败标记出错，仍尝试处理: ${filePath} - ${e && e.message}`);
                // 统一消息格式：为错误处理分支也补全新逻辑需要的字段
                const relativePath = path.relative(PHOTOS_DIR, filePath);
                const vw = getVideoWorker();
                vw.postMessage({ 
                    filePath,
                    relativePath: relativePath,
                    thumbsDir: THUMBS_DIR
                });
            }
            return;
        }

        // 处理文件删除事件，清理对应的缩略图
        if (type === 'unlink') {
            const relativePath = path.relative(PHOTOS_DIR, filePath);
            const isVideo = /\.(mp4|webm|mov)$/i.test(relativePath);
            const extension = isVideo ? '.jpg' : '.webp';
            const thumbRelPath = relativePath.replace(/\.[^.]+$/, extension);
            const thumbPath = path.join(THUMBS_DIR, thumbRelPath);

            // 删除孤立的缩略图文件（降噪：仅 debug 级别记录）
            try {
                await fs.unlink(thumbPath);
                logger.debug(`成功删除孤立的缩略图: ${thumbPath}`);
            } catch (err) {
                if (err.code !== 'ENOENT') { // 忽略“文件不存在”的错误
                    logger.error(`删除缩略图失败: ${thumbPath}`, err);
                }
            }
        }

        // 处理目录删除事件（或重命名导致的旧目录消失）：递归清理对应缩略图子树
        if (type === 'unlinkDir') {
            try {
                const relDir = path.relative(PHOTOS_DIR, filePath).replace(/\\/g, '/');
                if (relDir && !relDir.startsWith('..')) {
                    const thumbsSubtree = path.join(THUMBS_DIR, relDir);
                    await fs.rm(thumbsSubtree, { recursive: true, force: true }).catch(() => {});
                    logger.debug(`[Watcher] 目录移除，已递归清理缩略图子树: ${thumbsSubtree}`);
                    // 数据库同步清理该子树的 thumb_status 记录（失败忽略）
                    try { await dbRun('main', `DELETE FROM thumb_status WHERE path LIKE ? || '/%'`, [relDir]); } catch {}
                }
            } catch (e) {
                logger.warn('[Watcher] 清理目录缩略图子树失败（忽略）：', e && e.message);
            }
        }
        
        // 只对添加事件计算文件哈希值，用于检测重复事件
        let hash = undefined;
        if (type === 'add') {
            hash = await computeFileHash(filePath);
        }
        
        // 仅跟踪媒体文件或目录；非媒体文件（含 .db/.wal/.shm）直接忽略
        if (type === 'add') {
            const isMedia = /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(filePath);
            const isDbLike = /\.(db|db3|sqlite|sqlite3|wal|shm)$/i.test(filePath) || /history\.db(-wal|-shm)?$/i.test(filePath);
            if (!isMedia || isDbLike) {
                return;
            }
        }

        // 避免重复添加相同的变更事件
        if (!pendingIndexChanges.some(c => c.type === type && c.filePath === filePath && (type !== 'add' || c.hash === hash))) {
            pendingIndexChanges.push({ type, filePath, ...(type === 'add' && hash ? { hash } : {}) });
        }
        
        // 触发延迟索引处理
        triggerDelayedIndexProcessing();
    };

    logger.info(`开始监控照片目录: ${PHOTOS_DIR}`);
    
    // 绑定文件系统事件监听器
    watcher
        .on('add', path => onFileChange('add', path))           // 文件添加事件
        .on('unlink', path => onFileChange('unlink', path))     // 文件删除事件
        .on('addDir', path => onFileChange('addDir', path))     // 目录添加事件
        .on('unlinkDir', path => onFileChange('unlinkDir', path)) // 目录删除事件
        .on('error', error => logger.error('目录监控出错:', error)); // 错误处理
}


// 导出索引服务函数
module.exports = {
    setupWorkerListeners,    // 设置工作线程监听器
    buildSearchIndex,        // 构建搜索索引
    watchPhotosDir,          // 监控照片目录
};

// 心跳扫描已移除：由 scripts/maintenance.js 的 reconcileDirectories 低频任务替代

/**
 * 主动重算受影响相册的封面并持久化到 album_covers
 * 逻辑：根据最近的 pendingIndexChanges 推导相册路径集合，批量查封面后 UPSERT 到表
 */
async function recomputeAndPersistAlbumCovers() {
    try {
        const snapshot = Array.isArray(pendingIndexChanges) ? [...pendingIndexChanges] : [];
        if (snapshot.length === 0) return;

        const albumRelSet = new Set();
        for (const change of snapshot) {
            const rawPath = change && change.filePath ? String(change.filePath) : '';
            if (!rawPath || !rawPath.startsWith(PHOTOS_DIR)) continue;
            const rel = rawPath.substring(PHOTOS_DIR.length).replace(/\\/g, '/').replace(/^\/+/, '');
            if (!rel) { albumRelSet.add(''); continue; }
            const isDirEvent = change.type === 'addDir' || change.type === 'unlinkDir';
            const relDir = isDirEvent ? rel : rel.split('/').slice(0, -1).join('/');
            const segments = relDir.split('/').filter(Boolean);
            let cur = '';
            albumRelSet.add('');
            for (const seg of segments) {
                cur = cur ? `${cur}/${seg}` : seg;
                albumRelSet.add(cur);
            }
        }

        if (albumRelSet.size === 0) return;
        const rels = Array.from(albumRelSet);
        const coversMap = await findCoverPhotosBatchDb(rels);

        // 构造 UPSERT
        const upserts = [];
        for (const rel of rels) {
            const absAlbum = require('path').join(PHOTOS_DIR, rel);
            const info = coversMap.get(absAlbum);
            if (!info || !info.path) continue;
            const coverRel = require('path').relative(PHOTOS_DIR, info.path).replace(/\\/g, '/');
            const mtime = info.mtime || Date.now();
            const width = info.width || 1;
            const height = info.height || 1;
            upserts.push({ albumPath: rel, coverPath: coverRel, mtime, width, height });
        }

        if (upserts.length === 0) return;

        // 统一使用通用批处理助手执行 UPSERT
        const upsertSql = `INSERT INTO album_covers (album_path, cover_path, width, height, mtime)
                           VALUES (?, ?, ?, ?, ?)
                           ON CONFLICT(album_path) DO UPDATE SET
                               cover_path=excluded.cover_path,
                               width=excluded.width,
                               height=excluded.height,
                               mtime=excluded.mtime`;
        const rows = upserts.map(r => [r.albumPath, r.coverPath, r.width, r.height, r.mtime]);
        await runPreparedBatch('main', upsertSql, rows, { chunkSize: 800 });
        // 完成后无需立即清Redis，这在触发路径已有 invalidateCoverCache；这里仅保障表数据新鲜
    } catch (e) {
        logger.debug('recomputeAndPersistAlbumCovers 出错（忽略）:', e && e.message);
    }
}