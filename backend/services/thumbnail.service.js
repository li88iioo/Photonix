/**
 * 缩略图服务模块 - 简化版
 * 纯按需生成缩略图，移除复杂的队列调度机制
 */
const crypto = require('crypto');
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { THUMBS_DIR, MAX_THUMBNAIL_RETRIES, INITIAL_RETRY_DELAY, NUM_WORKERS } = require('../config');
const { idleThumbnailWorkers } = require('./worker.manager');
const { writeThumbStatusWithRetry: writeThumbStatusWithRetryNew, runPreparedBatchWithRetry } = require('../db/sqlite-retry');
const { dbRun } = require('../db/multi-db');
const eventBus = require('./event.service');

// 环境检测：开发环境显示详细日志
const isDevelopment = process.env.NODE_ENV !== 'production';

// 简化的任务管理
const activeTasks = new Set();          // 正在处理的任务集合
const failureCounts = new Map();        // 任务失败次数统计
const failureTimestamps = new Map();    // 失败记录的时间戳

// 内存清理配置
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30分钟清理一次
const FAILURE_ENTRY_TTL_MS = 24 * 60 * 60 * 1000; // 失败记录保留24小时
const ACTIVE_TASK_TTL_MS = 60 * 60 * 1000; // 活动任务记录保留1小时

// 任务记录的时间戳追踪
const taskTimestamps = new Map();

// 定期清理过期记录
setInterval(() => {
    const now = Date.now();
    let cleanedFailures = 0;
    let cleanedTasks = 0;

    // 清理失败计数记录
    for (const [path, timestamp] of failureTimestamps.entries()) {
        if ((now - timestamp) > FAILURE_ENTRY_TTL_MS) {
            failureCounts.delete(path);
            failureTimestamps.delete(path);
            cleanedFailures++;
        }
    }

    // 清理活动任务记录（防止任务卡住）
    for (const path of activeTasks) {
        const timestamp = taskTimestamps.get(path);
        if (timestamp && (now - timestamp) > ACTIVE_TASK_TTL_MS) {
            activeTasks.delete(path);
            taskTimestamps.delete(path);
            cleanedTasks++;
        }
    }

    // 清理时间戳记录
    for (const [path, timestamp] of taskTimestamps.entries()) {
        if ((now - timestamp) > Math.max(FAILURE_ENTRY_TTL_MS, ACTIVE_TASK_TTL_MS)) {
            taskTimestamps.delete(path);
        }
    }

    if (cleanedFailures > 0 || cleanedTasks > 0) {
        logger.debug(`[THUMBNAIL CLEANUP] 清理了 ${cleanedFailures} 个失败记录和 ${cleanedTasks} 个过期任务`);
    }
}, CLEANUP_INTERVAL_MS);

// 更新任务时间戳的辅助函数
function updateTaskTimestamp(path) {
    taskTimestamps.set(path, Date.now());
}

// 缩略图状态批处理相关变量
const thumbStatusPending = new Map();
let thumbStatusFlushScheduled = false;

// 添加锁机制防止竞态条件
const thumbStatusLock = {
    isLocked: false,
    queue: [],
    async acquire() {
        if (this.isLocked) {
            return new Promise(resolve => {
                this.queue.push(resolve);
            });
        }
        this.isLocked = true;
        return Promise.resolve();
    },
    release() {
        this.isLocked = false;
        const next = this.queue.shift();
        if (next) {
            this.isLocked = true;
            next();
        }
    }
};

function queueThumbStatusUpdate(relPath, mtime, status) {
    try {
        const prev = thumbStatusPending.get(relPath);
        if (!prev || (mtime || 0) >= (prev.mtime || 0)) {
            thumbStatusPending.set(relPath, { mtime: mtime || Date.now(), status });
        }
        if (!thumbStatusFlushScheduled) {
            thumbStatusFlushScheduled = true;
            setTimeout(flushThumbStatusBatch, 300);
        }
    } catch {}
}

async function flushThumbStatusBatch() {
    // 使用锁机制防止竞态条件
    await thumbStatusLock.acquire();
    
    try {
        if (thumbStatusPending.size === 0) return;
        
        const snapshot = Array.from(thumbStatusPending.entries());
        thumbStatusPending.clear();
        const rows = snapshot.map(([relPath, v]) => [relPath, v.mtime || Date.now(), v.status || 'pending']);
        
        if (rows.length === 0) return;
        
        try {
            const { runPreparedBatch } = require('../db/multi-db');
            const upsertSql = `INSERT INTO thumb_status(path, mtime, status, last_checked)
                               VALUES(?, ?, ?, strftime('%s','now')*1000)
                               ON CONFLICT(path) DO UPDATE SET
                                   mtime=excluded.mtime,
                                   status=excluded.status,
                                   last_checked=excluded.last_checked`;
            await runPreparedBatchWithRetry(runPreparedBatch, 'main', upsertSql, rows, { chunkSize: 200 }, redis);
            logger.debug(`[THUMB] 批量写入缩略图状态成功: ${rows.length} 条记录`);
        } catch (e) {
            logger.warn(`批量写入缩略图状态失败，回退为逐条重试: ${e.message}`);
            
            // 失败时回退为逐条重试（避免数据丢失）
            let successCount = 0;
            let failureCount = 0;
            
            for (const [pathRel, mtime, status] of rows) {
                try { 
                    // 清理路径并验证参数
                    const cleanPath = String(pathRel || '').replace(/\\/g, '/').trim();
                    if (!cleanPath) {
                        logger.warn(`跳过空路径的缩略图状态更新`);
                        failureCount++;
                        continue;
                    }
                    
                    await writeThumbStatusWithRetryNew(dbRun, { 
                        path: cleanPath, 
                        mtime: Number(mtime) || Date.now(), 
                        status: String(status || 'pending') 
                    }, redis);
                    successCount++;
                } catch (retryError) {
                    failureCount++;
                    const displayPath = String(pathRel || '').length > 50 ? 
                        String(pathRel).substring(0, 50) + '...' : pathRel;
                    logger.error(`缩略图状态写入失败: ${displayPath}`, {
                        error: retryError.message,
                        code: retryError.code,
                        path: pathRel,
                        mtime,
                        status
                    });
                }
            }
            
            if (successCount > 0 || failureCount > 0) {
                logger.debug(`[THUMB] 逐条重试完成: 成功 ${successCount}, 失败 ${failureCount}`);
            }
        }
    } finally {
        thumbStatusFlushScheduled = false;
        thumbStatusLock.release();
        
        // 如果还有待处理的数据，继续处理
        if (thumbStatusPending.size > 0 && !thumbStatusFlushScheduled) {
            thumbStatusFlushScheduled = true;
            setTimeout(flushThumbStatusBatch, 300);
        }
    }
}

/**
 * 设置缩略图工作线程监听器
 * 为每个空闲工作线程添加消息处理和错误监听
 */
function setupThumbnailWorkerListeners() {
    // 确保工作线程池已创建
    const { thumbnailWorkers } = require('./worker.manager');
    
    if (!thumbnailWorkers || thumbnailWorkers.length === 0) {
        logger.warn('缩略图工作线程池未初始化，跳过监听器设置');
        return;
    }

    // 使用所有工作线程而不是只使用空闲的
    thumbnailWorkers.forEach((worker, index) => {
        // 避免重复绑定监听器
        if (worker.__thumbnailListenersAttached) {
            return;
        }
        worker.__thumbnailListenersAttached = true;
        // 监听工作线程完成消息
        worker.on('message', async (result) => {
            const { success, error, task, workerId, skipped, message } = result;
            const relativePath = task.relativePath;
            const workerLogId = `[THUMBNAIL-WORKER-${workerId || '?'}]`;
            const failureKey = `thumb_failed_permanently:${relativePath}`;

            if (success) {
                // 任务成功，从 activeTasks 中移除
                activeTasks.delete(relativePath);
                failureCounts.delete(relativePath);

                if (skipped) {
                    // 跳过时不发布事件，不失效缓存，仅清理失败标记和更新指标
                    await redis.del(failureKey).catch(err => logger.warn(`清理Redis永久失败标记时出错: ${err.message}`));
                    try { await redis.incr('metrics:thumb:skip'); } catch {}
                } else {
                    logger.debug(`${workerLogId} 生成完成: ${relativePath}`);
                    
                    // 通过Redis发布订阅发送SSE事件通知前端（支持跨进程通信）
                    await redis.publish('thumbnail-generated', JSON.stringify({ path: relativePath }));
                    if (isDevelopment) {
                        logger.debug(`[THUMB] 已发布缩略图生成事件: ${relativePath}`);
                    }

                    // 同时在本进程内也触发事件，以防有其他监听器
                    eventBus.emit('thumbnail-generated', { path: relativePath });
                    await redis.del(failureKey).catch(err => logger.warn(`清理Redis永久失败标记时出错: ${err.message}`));
                    try { await redis.incr('metrics:thumb:success'); } catch {}

                    // 缩略图生成完成后，失效相关页面的缓存
                    try {
                        const { invalidateTags } = require('./cache.service');
                        const dirname = path.dirname(relativePath);
                        const tags = [
                            `thumbnail:${relativePath}`,  // 缩略图自身缓存
                            `album:${dirname}`,           // 所属相册缓存
                            `album:/`                     // 根相册缓存
                        ];

                        await invalidateTags(tags);
                        if (isDevelopment) {
                            logger.debug(`[THUMB] 缓存失效完成，标签: ${tags.join(', ')}`);
                        }
                    } catch (cacheError) {
                        logger.warn(`[CACHE] 失效缩略图缓存失败（已忽略）: ${cacheError.message}`);
                    }
                }

                try {
                    // 使用缩略图文件的mtime作为版本参数，而不是源文件的mtime
                    const isVideo = task.type === 'video';
                    const extension = isVideo ? '.jpg' : '.webp';
                    const thumbRelPath = task.relativePath.replace(/\.[^.]+$/, extension);
                    const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);
                    const thumbMtime = await fs.stat(thumbAbsPath).then(s => s.mtimeMs).catch(() => Date.now());
                    queueThumbStatusUpdate(task.relativePath, thumbMtime, 'exists');
                    if (!skipped) {
                        logger.debug(`[THUMB] 更新缩略图状态: ${task.relativePath}, mtime: ${thumbMtime}`);
                    }
                } catch (dbErr) {
                    logger.warn(`写入 thumb_status 入队失败（成功分支，已忽略）：${dbErr && dbErr.message}`);
                }
            } else {
                // 针对"文件损坏/格式异常无法解析"的失败，进行专门的计数与阈值删除
                let deletedByCorruptionRule = false;
                try {
                    const CORRUPT_PARSE_SNIPPET = '损坏或格式异常，无法解析';
                    if (typeof message === 'string' && message.includes(CORRUPT_PARSE_SNIPPET)) {
                        const corruptionKey = `thumb_corrupt_parse_count:${relativePath}`;
                        const corruptCount = await redis.incr(corruptionKey).catch(() => 0);
                        // 设置一个较长的过期时间，便于跨进程/重启累计
                        if (corruptCount === 1) {
                            try { await redis.expire(corruptionKey, 3600 * 24 * 30); } catch {}
                        }
                        // 可观测性：输出一次计数日志，便于在容器日志中追踪累计情况
                        try {
                            logger.warn(`${workerLogId} [CORRUPT_PARSE_COUNT] 发现文件损坏: ${relativePath} | count=${corruptCount}/10 | reason=${message}`);
                        } catch {}
                        if (corruptCount >= 10) {
                            try {
                                // 达到阈值：直接删除原始文件，避免反复重试
                                await fs.unlink(task.filePath).catch(() => {});
                                logger.error(`${workerLogId} [CORRUPTED_IMAGE_DELETED] 已因出现 ${corruptCount} 次"${CORRUPT_PARSE_SNIPPET}"而删除源文件: ${task.filePath} (relative=${relativePath})`);
                                // 清理状态与计数，避免后续重复处理
                                activeTasks.delete(relativePath);
                                failureCounts.delete(relativePath);
                                try { await redis.set(failureKey, '1', 'EX', 3600 * 24 * 7); } catch {}
                                try { await redis.del(corruptionKey); } catch {}
                                deletedByCorruptionRule = true;
                            } catch (delErr) {
                                logger.warn(`${workerLogId} 触发阈值删除失败（已忽略重试逻辑）：${delErr && delErr.message}`);
                                deletedByCorruptionRule = true; // 即便删除失败，也不再重试本次任务
                            }
                        }
                    }
                } catch {}

                const currentFailures = (failureCounts.get(relativePath) || 0) + 1;
                failureCounts.set(relativePath, currentFailures);
                failureTimestamps.set(relativePath, Date.now()); // 记录时间戳用于清理
                updateTaskTimestamp(relativePath);
                logger.error(`${workerLogId} 处理任务失败: ${relativePath} (第 ${currentFailures} 次)。错误: ${error}`);
                try { await redis.incr('metrics:thumb:fail'); } catch {}

                if (deletedByCorruptionRule) {
                    // 已按"损坏阈值"策略处理（删除/跳过），不再入队重试
                } else if (currentFailures < MAX_THUMBNAIL_RETRIES) {
                    // 任务失败但可重试，暂时不从 activeTasks 移除，避免竞态条件
                    const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, currentFailures - 1);
                    logger.warn(`任务 ${relativePath} 将在 ${retryDelay / 1000}秒 后重试...`);
                    setTimeout(() => {
                        // 在真正重新入队前再从 activeTasks 移除，避免竞态且不阻塞重试派发
                        activeTasks.delete(relativePath);
                        dispatchThumbnailTask({
                            filePath: task.filePath,
                            relativePath: task.relativePath,
                            type: task.type
                        });
                    }, retryDelay);
                } else {
                    // 达到最大重试次数，标记为永久失败，并从 activeTasks 移除
                    activeTasks.delete(relativePath);
                    logger.error(`任务 ${relativePath} 已达到最大重试次数 (${MAX_THUMBNAIL_RETRIES}次)，标记为永久失败。`);
                    await redis.set(failureKey, '1', 'EX', 3600 * 24 * 7); // 缓存7天
                    try { await redis.incr('metrics:thumb:permanent_fail'); } catch {}
                }

                try {
                    const srcMtime = await fs.stat(task.filePath).then(s => s.mtimeMs).catch(() => Date.now());
                    queueThumbStatusUpdate(relativePath, srcMtime, 'failed');
                } catch (dbErr) {
                    logger.warn(`写入 thumb_status 入队失败（失败分支，已忽略）：${dbErr && dbErr.message}`);
                }
            }

            // 将工作线程放回空闲队列，继续处理下一个任务
            idleThumbnailWorkers.push(worker);
            // 通知有工人变为空闲，便于批量派发继续推进
            try { eventBus.emit('thumb-worker-idle'); } catch {}
            // 维护活动计数
            global.__thumbActiveCount = Math.max(0, (global.__thumbActiveCount || 0) - 1);
        });

        // 监听工作线程错误和退出事件
        worker.on('error', (err) => logger.error(`缩略图工人 ${index + 1} 遇到错误:`, err));
        worker.on('exit', (code) => {
            if (code !== 0) logger.warn(`缩略图工人 ${index + 1} 退出，代码: ${code}`);
        });
    });
    
    logger.debug(`缩略图工作线程监听器已设置完成，共 ${thumbnailWorkers.length} 个工作线程`);
    logger.debug(`当前空闲工作线程数量: ${idleThumbnailWorkers.length}`);
}

/**
 * 调度缩略图任务
 * 直接分配给空闲的工作线程处理
 */
function dispatchThumbnailTask(task, context = 'ondemand') {
    if (!task || !idleThumbnailWorkers.length) {
        return false;
    }

    // 额外防御：若拿到非媒体任务，直接丢弃
    if (!/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(task.filePath || task.relativePath || '')) {
        return false;
    }

    // 检查任务是否已在处理中，避免重复处理
    if (activeTasks.has(task.relativePath)) {
        return false;
    }

    const worker = idleThumbnailWorkers.shift();
    if (!worker) {
        return false;
    }

    // 标记任务为活动状态，发送给工作线程处理
    activeTasks.add(task.relativePath);
    updateTaskTimestamp(task.relativePath);
    global.__thumbActiveCount = (global.__thumbActiveCount || 0) + 1;
    worker.postMessage({ ...task, thumbsDir: THUMBS_DIR });
    
    // 根据调用上下文显示不同的日志
    const logPrefix = context === 'batch' ? '[批量补全]' : '[按需生成]';
    logger.debug(`${logPrefix} 缩略图任务已派发: ${task.relativePath}`);
    return true;
}

/**
 * 确保缩略图存在 - 按需生成版本
 * 检查缩略图是否存在，不存在则立即创建生成任务
 * @param {string} sourceAbsPath - 源文件绝对路径
 * @param {string} sourceRelPath - 源文件相对路径
 * @returns {Promise<Object>} 缩略图状态信息
 */
async function ensureThumbnailExists(sourceAbsPath, sourceRelPath) {
    // 检查是否包含 @eaDir，如果是则直接返回失败状态
    if (sourceRelPath.includes('@eaDir')) {
        logger.debug(`跳过 @eaDir 文件的缩略图生成: ${sourceRelPath}`);
        return { status: 'failed' };
    }

    // 根据文件类型确定缩略图格式
    const isVideo = /\.(mp4|webm|mov)$/i.test(sourceAbsPath);
    const extension = isVideo ? '.jpg' : '.webp';
    const thumbRelPath = sourceRelPath.replace(/\.[^.]+$/, extension);
    const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);
    // 修复：使用API调用方式生成缩略图URL，与文件服务保持一致
    const thumbUrl = `/api/thumbnail?path=${encodeURIComponent(sourceRelPath)}`;

    try {
        // 检查缩略图文件是否存在
        await fs.access(thumbAbsPath);
        return { status: 'exists', path: thumbUrl };
    } catch (e) {
        // 检查是否已标记为永久失败
        const isPermanentlyFailed = await redis.get(`thumb_failed_permanently:${sourceRelPath}`);
        if (isPermanentlyFailed) {
            return { status: 'failed' };
        }

        // 按需生成：立即派发任务
        const task = {
            filePath: sourceAbsPath,
            relativePath: sourceRelPath,
            type: isVideo ? 'video' : 'photo'
        };

        const dispatched = dispatchThumbnailTask(task);
        if (!dispatched) {
            logger.warn(`[按需生成] 任务派发失败: ${sourceRelPath} (工作线程繁忙或重复任务)`);
        }

        return { status: 'processing' };
    }
}

/**
 * 批量补全缺失的缩略图
 * 扫描数据库中状态为 missing 或 failed 的文件，批量生成缩略图
 * @param {number} limit - 批量处理的数量限制，默认1000
 * @returns {Promise<Object>} 补全结果统计
 */
async function batchGenerateMissingThumbnails(limit = 1000) {
    try {
        const { dbAll } = require('../db/multi-db');
        
        // 查询需要补全的缩略图
        // 注意：不排除'processing'状态，因为可能有任务处理失败后需要重新处理
        const missingThumbs = await dbAll('main', `
            SELECT path FROM thumb_status 
            WHERE status IN ('missing', 'failed', 'pending') 
            ORDER BY last_checked ASC 
            LIMIT ?
        `, [limit]);

        logger.debug(`[批量补全] 数据库查询结果: 找到 ${missingThumbs?.length || 0} 个需要补全的缩略图`);
        
        // 添加更详细的调试信息
        if (missingThumbs && missingThumbs.length > 0) {
            // 查询各状态的总数，用于调试
            const statusCounts = await dbAll('main', `
                SELECT status, COUNT(*) as count 
                FROM thumb_status 
                WHERE status IN ('missing', 'failed', 'pending', 'processing') 
                GROUP BY status
            `);
            logger.debug(`[批量补全] 当前状态统计: ${statusCounts.map(s => `${s.status}:${s.count}`).join(', ')}`);
        }
        
        // 调试：显示前5个需要补全的文件
        if (missingThumbs && missingThumbs.length > 0) {
            const samplePaths = missingThumbs.slice(0, 5).map(row => row.path);
            logger.debug(`[批量补全] 示例文件: ${samplePaths.join(', ')}`);
        }

        if (!missingThumbs || missingThumbs.length === 0) {
            return { 
                success: true, 
                message: '没有发现需要补全的缩略图',
                processed: 0,
                queued: 0,
                skipped: 0,
                foundMissing: 0  // 关键：没有找到缺失的缩略图
            };
        }

        let queued = 0;
        let skipped = 0;

        // 辅助：等待任意工人空闲（最多10秒防止卡死）
        function waitForIdle(timeoutMs = 10000) {
            return new Promise((resolve) => {
                let done = false;
                const handler = () => { if (!done) { done = true; eventBus.off('thumb-worker-idle', handler); resolve(); } };
                eventBus.once('thumb-worker-idle', handler);
                setTimeout(() => { if (!done) { done = true; eventBus.off('thumb-worker-idle', handler); resolve(); } }, timeoutMs);
            });
        }

        // 按可用工人持续派发，直到本批全部入队
        const { idleThumbnailWorkers } = require('./worker.manager');
        const { NUM_WORKERS } = require('../config');
        // 优化：批量补全时减少预留按需工人数量（默认为0，最大并发）
        let RESERVED_ONDEMAND = Math.max(0, Math.floor(Number(process.env.THUMB_ONDEMAND_RESERVE || 0)));
        RESERVED_ONDEMAND = Math.max(0, Math.min(RESERVED_ONDEMAND, Math.max(0, NUM_WORKERS - 2))); // 确保至少留2个工人用于批量补全
        logger.debug(`[批量补全] 预留按需工人数: ${RESERVED_ONDEMAND}/${NUM_WORKERS} (可用工人: ${idleThumbnailWorkers.length})`);

        // 智能负载控制：确保不影响按需生成和系统运行
        const cpuCount = require('os').cpus().length;
        const totalMemoryGB = Math.floor(require('os').totalmem() / (1024 * 1024 * 1024));
        const currentLoad = require('os').loadavg()[0]; // 1分钟平均负载
        const isHighLoad = currentLoad > cpuCount * 0.8; // 负载超过80%认为高负载

        // 动态调整预留策略，确保按需生成不受影响
        if (isHighLoad) {
            RESERVED_ONDEMAND = Math.max(2, Math.floor(NUM_WORKERS * 0.4)); // 高负载时预留更多工人
            logger.warn(`[批量补全] 检测到高负载状态 (${currentLoad.toFixed(1)}/${cpuCount})，增加预留工人到${RESERVED_ONDEMAND}`);
        }

        // 并发控制：根据系统负载动态调整
        let MAX_CONCURRENT_WAITS;
        if (isHighLoad) {
            MAX_CONCURRENT_WAITS = Math.min(3, NUM_WORKERS); // 高负载时降低并发
        } else {
            MAX_CONCURRENT_WAITS = Math.min(8, NUM_WORKERS);
        }

        logger.debug(`[批量补全] 负载控制: CPU负载${currentLoad.toFixed(1)}/${cpuCount}, 预留${RESERVED_ONDEMAND}/${NUM_WORKERS}, 并发上限${MAX_CONCURRENT_WAITS}`);

        let currentWaits = 0;
        let i = 0;
        while (i < missingThumbs.length) {
            const available = idleThumbnailWorkers.length - RESERVED_ONDEMAND;
            if (available <= 0) {
                // 无可用工人（考虑预留），等待一个工人释放
                if (currentWaits >= MAX_CONCURRENT_WAITS) {
                    // 避免过多并发等待，短暂延迟后重试
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
                currentWaits++;
                await waitForIdle(10000);
                currentWaits--;
                continue;
            }

            const relativePath = missingThumbs[i].path;
            const sourceAbsPath = path.join(require('../config').PHOTOS_DIR, relativePath);

            // 源文件检查
            try {
                await fs.access(sourceAbsPath);
            } catch {
                skipped++;
                i++;
                continue;
            }

            // 去重：已在处理则跳过
            if (activeTasks.has(relativePath)) {
                skipped++;
                i++;
                continue;
            }

            const isVideo = /\.(mp4|webm|mov)$/i.test(relativePath);
            const task = { filePath: sourceAbsPath, relativePath, type: isVideo ? 'video' : 'photo' };

            const dispatched = dispatchThumbnailTask(task, 'batch');
            if (dispatched) {
                queued++;
                
                // 立即更新数据库状态为processing，避免下一轮重复查询
                // 注意：不更新last_checked，保持原有的排序逻辑
                try {
                    const { runAsync } = require('../db/multi-db');
                    await runAsync('main', 
                        'UPDATE thumb_status SET status = ? WHERE path = ?',
                        ['processing', relativePath]
                    );
                } catch (e) {
                    logger.warn(`[批量补全] 更新任务状态失败: ${relativePath}, ${e.message}`);
                }
                
                i++;

                // 智能延迟控制：根据负载状态添加延迟，避免系统过载
                const shouldAddDelay = i > 0 && (
                    // 高负载时每处理几个任务就延迟
                    (isHighLoad && i % Math.floor(available * 1) === 0) ||
                    // 低端配置时每处理几个任务就延迟
                    ((cpuCount <= 4 || totalMemoryGB <= 4) && i % Math.floor(available * 2) === 0)
                );

                if (shouldAddDelay) {
                    const delayMs = isHighLoad ? 500 : 100; // 高负载时延迟更长
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            } else {
                // 理论上此时应仅发生于瞬时并发，等待下一次空闲
                await waitForIdle(5000);
            }
        }

        logger.debug(`[手动补全] 缩略图批量补全完成: 已排队 ${queued} 个任务，跳过 ${skipped} 个文件`);
        
        return {
            success: true,
            message: `批量补全任务已启动`,
            processed: missingThumbs.length,  // 返回本批次处理的总数量
            queued: queued,                   // 返回实际排队的任务数量
            skipped: skipped,
            foundMissing: missingThumbs.length  // 新增：本批次找到的缺失数量
        };
    } catch (error) {
        logger.error('批量补全缩略图失败:', error);
        throw error;
    }
}

// 导出缩略图服务函数
module.exports = {
    setupThumbnailWorkerListeners,    // 设置工作线程监听器
    ensureThumbnailExists,            // 确保缩略图存在（按需生成）
    batchGenerateMissingThumbnails,   // 批量补全缺失的缩略图
    queueThumbStatusUpdate,           // 队列缩略图状态更新
};