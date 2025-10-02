/**
 * 缩略图服务模块 - 简化版
 * 纯按需生成缩略图，移除复杂的队列调度机制
 */
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { THUMBS_DIR, PHOTOS_DIR, MAX_THUMBNAIL_RETRIES, INITIAL_RETRY_DELAY, NUM_WORKERS } = require('../config');
const workerManager = require('./worker.manager');
const { idleThumbnailWorkers, ensureThumbnailWorkerPool, noteThumbnailUse, scaleThumbnailWorkerPool } = workerManager;
const { getThumbMaxConcurrency } = require('./adaptive.service');
const { writeThumbStatusWithRetry: writeThumbStatusWithRetryNew, runPreparedBatchWithRetry } = require('../db/sqlite-retry');
const { dbRun } = require('../db/multi-db');
const eventBus = require('./event.service');
const { sanitizePath, isPathSafe } = require('../utils/path.utils');

const PHOTOS_DIR_SAFE_ROOT = path.resolve(PHOTOS_DIR);
const thumbMetrics = {
    generated: 0,
    skipped: 0,
    failures: 0,
    permanentFailures: 0,
    retries: 0,
    lastError: null,
    lastFailureAt: null,
    lastGeneratedAt: null,
    processing: 0,
    queued: 0,
    pending: 0,
    lastUpdatedAt: 0
};
try { global.__thumbTaskMetrics = thumbMetrics; } catch {}

// 环境检测：开发环境显示详细日志
const isDevelopment = process.env.NODE_ENV !== 'production';

// 监听器安装标志（避免在无池时安装；首派发时按需安装）
let __thumbListenersSetup = false;

// 简化的任务管理
const activeTasks = new Set();          // 正在处理的任务集合
const failureCounts = new Map();        // 任务失败次数统计
const failureTimestamps = new Map();    // 失败记录的时间戳

// 按需生成内存队列（轻量、去重、上限保护）
const ondemandQueue = [];
const queuedSet = new Set();
const MAX_ONDEMAND_QUEUE = Number(process.env.THUMB_ONDEMAND_QUEUE_MAX || 2000);
const BATCH_COOLDOWN_MS = Math.max(0, Number(process.env.THUMB_BATCH_COOLDOWN_MS || 0));
const TELEMETRY_LOG_INTERVAL_MS = Math.max(5000, Number(process.env.THUMB_TELEMETRY_LOG_INTERVAL_MS || 15000));
let __drainBound = false;

const OVERFLOW_RETRY_MS = Number(process.env.THUMB_OVERFLOW_RETRY_MS || 5000);
const overflowBuffer = new Map(); // relativePath -> task
let overflowTimer = null;

// 按需空闲销毁：当按需队列清空且无在途任务时，短延时销毁线程池（更符合“本目录生成完后退出”）
let __idleDestroyTimer = null;
const THUMB_ONDEMAND_IDLE_DESTROY_MS = Number(process.env.THUMB_ONDEMAND_IDLE_DESTROY_MS || 30000);
let __lastBatchTelemetryLog = 0;
// 需求信号指标：供自适应增压判断是否需要扩容
function refreshThumbMetrics() {
    const active = Number(global.__thumbActiveCount || 0);
    const queued = ondemandQueue.length;
    thumbMetrics.processing = active;
    thumbMetrics.queued = queued;
    thumbMetrics.pending = active + queued;
    thumbMetrics.lastUpdatedAt = Date.now();
    try { global.__thumbOndemandQueueLen = queued; } catch {}
}

function updateQueueMetric() {
    try { refreshThumbMetrics(); } catch {}
}

refreshThumbMetrics();

function resolveThumbConcurrencyLimit() {
    try {
        const limit = getThumbMaxConcurrency();
        if (Number.isFinite(limit) && limit > 0) {
            return Math.max(1, Math.floor(limit));
        }
    } catch {}
    return Math.max(1, Math.floor(Number(NUM_WORKERS) || 1));
}

function drainOndemand() {
    try {
        const maxConcurrency = resolveThumbConcurrencyLimit();
        while (idleThumbnailWorkers.length > 0 && ondemandQueue.length > 0) {
            const active = Number(global.__thumbActiveCount || 0);
            if (active >= maxConcurrency) {
                break;
            }
            const task = ondemandQueue.shift();
            updateQueueMetric();
            if (!task) break;
            if (activeTasks.has(task.relativePath)) { queuedSet.delete(task.relativePath); continue; }
            const worker = idleThumbnailWorkers.shift();
            if (!worker) { ondemandQueue.unshift(task); break; }
            queuedSet.delete(task.relativePath);
            activeTasks.add(task.relativePath);
            updateTaskTimestamp(task.relativePath);
            global.__thumbActiveCount = (global.__thumbActiveCount || 0) + 1;
            refreshThumbMetrics();
            worker.postMessage({ ...task, thumbsDir: THUMBS_DIR });
            try { noteThumbnailUse(); } catch {}
        }

        // 队列空且无在途任务：短延时主动销毁线程池（更快释放内存）
        const active = Number(global.__thumbActiveCount || 0);
        if (ondemandQueue.length === 0 && active === 0) {
            try {
                if (__idleDestroyTimer) clearTimeout(__idleDestroyTimer);
                __idleDestroyTimer = setTimeout(() => {
                    try {
                        const againActive = Number(global.__thumbActiveCount || 0);
                        if (ondemandQueue.length === 0 && againActive === 0) {
                            require('./worker.manager').destroyThumbnailWorkerPool();
                            // 监听器会在下次首派发时再按需安装
                            __thumbListenersSetup = false;
                        }
                    } catch {}
                }, THUMB_ONDEMAND_IDLE_DESTROY_MS);
            } catch {}
        }
    } catch (e) {
        logger.debug(`[按需队列] drain 异常：${e && e.message}`);
    }

    refreshThumbMetrics();

function scheduleOverflowReplay() {
    if (overflowTimer || overflowBuffer.size === 0) {
        return;
    }

    overflowTimer = setTimeout(() => {
        overflowTimer = null;
        if (overflowBuffer.size === 0) {
            return;
        }

        const replayTasks = Array.from(overflowBuffer.values());
        overflowBuffer.clear();

        for (const task of replayTasks) {
            const dispatched = dispatchThumbnailTask(task, 'overflow');
            if (!dispatched) {
                // 再次失败，放回缓冲区等待下一轮
                overflowBuffer.set(task.relativePath, task);
            }
        }

        if (overflowBuffer.size > 0) {
            scheduleOverflowReplay();
        }
    }, OVERFLOW_RETRY_MS);
}

function enqueueOverflowTask(task) {
    if (!task || !task.relativePath) {
        return;
    }
    overflowBuffer.set(task.relativePath, task);
    scheduleOverflowReplay();
}
}

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

/**
 * 缩略图状态管理器
 * 处理批量状态更新和错误恢复逻辑
 */
class ThumbStatusManager {
    constructor() {
        this.repo = require('../repositories/thumbStatus.repo');
        this.orchestrator = require('./orchestrator');
    }

    /**
     * 准备批量数据
     */
    prepareBatchData(snapshot) {
        return snapshot.map(([relPath, v]) => [
            relPath,
            v.mtime || Date.now(),
            v.status || 'pending'
        ]).filter(row => row[0]); // 过滤掉空路径
    }

    /**
     * 批量写入缩略图状态
     */
    async batchUpsert(rows, redis) {
        try {
            await this.orchestrator.withAdmission('thumb-status-upsert', async () => {
                await this.repo.upsertThumbStatusBatch(rows, { manageTransaction: true, chunkSize: 400 }, redis);
            });
            logger.debug(`[THUMB] 批量写入缩略图状态成功: ${rows.length} 条记录`);
            return { success: true, rowsAffected: rows.length };
        } catch (e) {
            // 兜底：即便闸门封装异常也直接写一次，确保最终可达
            await this.repo.upsertThumbStatusBatch(rows, { manageTransaction: true, chunkSize: 400 }, redis);
            logger.debug(`[THUMB] 兜底批量写入成功: ${rows.length} 条记录`);
            return { success: true, rowsAffected: rows.length };
        }
    }

    /**
     * 逐条重试失败的记录
     */
    async retryIndividual(rows, redis) {
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

                await this.repo.upsertThumbStatusSingle(cleanPath, Number(mtime) || Date.now(), String(status || 'pending'), redis);
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

        return { successCount, failureCount };
    }

    /**
     * 执行批量刷新
     */
    async executeBatchFlush(snapshot, redis) {
        const rows = this.prepareBatchData(snapshot);
        if (rows.length === 0) return { success: true, rowsAffected: 0 };

        try {
            return await this.batchUpsert(rows, redis);
        } catch (e) {
            logger.warn(`批量写入缩略图状态失败，回退为逐条重试: ${e.message}`);
            const retryResult = await this.retryIndividual(rows, redis);

            if (retryResult.successCount > 0 || retryResult.failureCount > 0) {
                logger.debug(`[THUMB] 逐条重试完成: 成功 ${retryResult.successCount}, 失败 ${retryResult.failureCount}`);
            }

            return {
                success: retryResult.successCount > 0,
                rowsAffected: retryResult.successCount,
                retryResult
            };
        }
    }
}

// 创建单例管理器
const thumbStatusManager = new ThumbStatusManager();

async function flushThumbStatusBatch() {
    // 使用锁机制防止竞态条件
    await thumbStatusLock.acquire();

    try {
        if (thumbStatusPending.size === 0) return;

        const snapshot = Array.from(thumbStatusPending.entries());
        thumbStatusPending.clear();

        const result = await thumbStatusManager.executeBatchFlush(snapshot, redis);

        // 如果还有待处理的数据，继续处理
        if (thumbStatusPending.size > 0 && !thumbStatusFlushScheduled) {
            thumbStatusFlushScheduled = true;
            setTimeout(flushThumbStatusBatch, 300);
        }

        return result;
    } finally {
        thumbStatusFlushScheduled = false;
        thumbStatusLock.release();
    }
}

/**
 * 设置缩略图工作线程监听器
 * 为每个空闲工作线程添加消息处理和错误监听
 */
function setupThumbnailWorkerListeners() {
    // 不在这里创建线程池；仅当已有线程池时安装监听器
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
                    thumbMetrics.skipped += 1;
                    try { await redis.incr('metrics:thumb:skip'); } catch {}
                } else {
                    logger.debug(`${workerLogId} 生成完成: ${relativePath}`);
                    thumbMetrics.generated += 1;
                    thumbMetrics.lastGeneratedAt = Date.now();

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

                thumbMetrics.failures += 1;
                thumbMetrics.lastError = error && error.message ? error.message : String(error);
                thumbMetrics.lastFailureAt = Date.now();

                if (deletedByCorruptionRule) {
                    // 已按"损坏阈值"策略处理（删除/跳过），不再入队重试
                    thumbMetrics.permanentFailures += 1;
                } else if (currentFailures < MAX_THUMBNAIL_RETRIES) {
                    // 任务失败但可重试，暂时不从 activeTasks 移除，避免竞态条件
                    const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, currentFailures - 1);
                    logger.warn(`任务 ${relativePath} 将在 ${retryDelay / 1000}秒 后重试...`);
                    thumbMetrics.retries += 1;
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
                    thumbMetrics.permanentFailures += 1;
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
            refreshThumbMetrics();
            try { noteThumbnailUse(); } catch {}
        });

        // 监听工作线程错误和退出事件
        worker.on('error', (err) => logger.error(`缩略图工人 ${index + 1} 遇到错误:`, err));
        worker.on('exit', (code) => {
            if (code !== 0) logger.warn(`缩略图工人 ${index + 1} 退出，代码: ${code}`);
        });
    });
    
    logger.debug(`缩略图工作线程监听器已设置完成，共 ${thumbnailWorkers.length} 个工作线程`);
    logger.debug(`当前空闲工作线程数量: ${idleThumbnailWorkers.length}`);
    // 绑定按需队列的空闲触发（幂等）
    if (!__drainBound) {
        try { eventBus.on('thumb-worker-idle', drainOndemand); __drainBound = true; } catch (e) {}
    }
    __thumbListenersSetup = true;
}

/**
 * 调度缩略图任务
 * 直接分配给空闲的工作线程处理
 */
function dispatchThumbnailTask(task, context = 'ondemand') {
    const safeTask = normalizeThumbnailTask(task);
    if (!safeTask) {
        return false;
    }

    try { ensureThumbnailWorkerPool(); } catch {}
    // 首次派发时若尚未安装监听器，则安装之（幂等）
    if (!__thumbListenersSetup) {
        try { setupThumbnailWorkerListeners(); } catch {}
    }

    // 去重：正在处理或已在按需队列中，视为已安排
    if (activeTasks.has(safeTask.relativePath) || queuedSet.has(safeTask.relativePath)) {
        return true;
    }

    const maxConcurrency = resolveThumbConcurrencyLimit();
    const currentActive = Number(global.__thumbActiveCount || 0);
    if (currentActive >= maxConcurrency) {
        if (queuedSet.has(safeTask.relativePath)) {
            return true;
        }
        if (ondemandQueue.length >= MAX_ONDEMAND_QUEUE) {
            logger.warn(`[按需队列] 已满(${MAX_ONDEMAND_QUEUE})，推迟重试: ${safeTask.relativePath}`);
            enqueueOverflowTask(safeTask);
            return false;
        }
        ondemandQueue.push(safeTask);
        queuedSet.add(safeTask.relativePath);
        updateQueueMetric();
        logger.debug(`[按需生成] 并发受限，任务入队: ${safeTask.relativePath} (队列=${ondemandQueue.length}, active=${currentActive}, limit=${maxConcurrency})`);
        return true;
    }

    let worker = idleThumbnailWorkers.shift();
    if (!worker) {
        const poolSize = workerManager.thumbnailWorkers.length;
        const desiredSize = Math.max(1, Math.min(maxConcurrency, NUM_WORKERS));
        if (poolSize < desiredSize) {
            try {
                scaleThumbnailWorkerPool(desiredSize);
                if (!__thumbListenersSetup) {
                    try { setupThumbnailWorkerListeners(); } catch {}
                }
                worker = idleThumbnailWorkers.shift();
            } catch (error) {
                logger.warn(`[按需生成] 扩容缩略图线程池失败（忽略）：${error && error.message}`);
            }
        }
    }

    if (!worker) {
        // 无空闲工人：入队等待空闲
        if (ondemandQueue.length >= MAX_ONDEMAND_QUEUE) {
            logger.warn(`[按需队列] 已满(${MAX_ONDEMAND_QUEUE})，推迟重试: ${safeTask.relativePath}`);
            enqueueOverflowTask(safeTask);
            return false;
        }
        ondemandQueue.push(safeTask);
        queuedSet.add(safeTask.relativePath);
        updateQueueMetric();
        try { setImmediate(() => { try { drainOndemand(); } catch (e) {} }); } catch (e) {}
        logger.debug(`[按需生成] 已入队等待空闲: ${safeTask.relativePath} (队列=${ondemandQueue.length})`);
        return true;
    }

    // 标记任务为活动状态，发送给工作线程处理
    queuedSet.delete(safeTask.relativePath);
    activeTasks.add(safeTask.relativePath);
    updateTaskTimestamp(safeTask.relativePath);
    global.__thumbActiveCount = (global.__thumbActiveCount || 0) + 1;
    refreshThumbMetrics();
    worker.postMessage({ ...safeTask, thumbsDir: THUMBS_DIR });
    try { noteThumbnailUse(); } catch {}

    // 根据调用上下文显示不同的日志
    const logPrefix = context === 'batch' ? '[批量补全]' : '[按需生成]';
    logger.debug(`${logPrefix} 缩略图任务已派发: ${safeTask.relativePath}`);
    return true;
}

function normalizeThumbnailTask(task) {
    if (!task || (typeof task !== 'object')) {
        return null;
    }

    const rawRelative = typeof task.relativePath === 'string' ? task.relativePath : '';
    const sanitizedRelative = sanitizePath(rawRelative);
    if (!sanitizedRelative) {
        logger.warn('[按需生成] 拒绝缺少相对路径的缩略图任务');
        return null;
    }

    if (!isPathSafe(sanitizedRelative)) {
        logger.warn(`[按需生成] 检测到不安全的缩略图路径: ${rawRelative}`);
        return null;
    }

    const resolvedAbsolute = path.resolve(PHOTOS_DIR_SAFE_ROOT, sanitizedRelative);
    if (!resolvedAbsolute.startsWith(PHOTOS_DIR_SAFE_ROOT)) {
        logger.warn(`[按需生成] 缩略图任务路径超出受信目录: ${resolvedAbsolute}`);
        return null;
    }

    const declaredAbsolute = typeof task.filePath === 'string' ? task.filePath : resolvedAbsolute;
    const normalizedAbsolute = declaredAbsolute.startsWith(PHOTOS_DIR_SAFE_ROOT)
        ? declaredAbsolute
        : resolvedAbsolute;

    const inferredType = task.type || (/\.(mp4|webm|mov)$/i.test(sanitizedRelative) ? 'video' : 'photo');

    if (!/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(normalizedAbsolute) && !/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(sanitizedRelative)) {
        logger.warn(`[按需生成] 拒绝不支持的媒体类型任务: ${sanitizedRelative}`);
        return null;
    }

    return {
        filePath: normalizedAbsolute,
        relativePath: sanitizedRelative,
        type: inferredType
    };
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

    const sanitizedRelPath = sanitizePath(sourceRelPath);
    if (!sanitizedRelPath || !isPathSafe(sanitizedRelPath)) {
        logger.warn(`[按需生成] 拒绝不安全的缩略图生成请求: ${sourceRelPath}`);
        return { status: 'failed' };
    }

    const resolvedSourceAbsPath = path.resolve(PHOTOS_DIR_SAFE_ROOT, sanitizedRelPath);

    // 根据文件类型确定缩略图格式
    const isVideo = /\.(mp4|webm|mov)$/i.test(sanitizedRelPath);
    const extension = isVideo ? '.jpg' : '.webp';
    const thumbRelPath = sanitizedRelPath.replace(/\.[^.]+$/, extension);
    const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);
    // 修复：使用API调用方式生成缩略图URL，与文件服务保持一致
    const thumbUrl = `/api/thumbnail?path=${encodeURIComponent(sanitizedRelPath)}`;

    try {
        // 检查缩略图文件是否存在
        await fs.access(thumbAbsPath);
        return { status: 'exists', path: thumbUrl };
    } catch (e) {
        // 检查是否已标记为永久失败
        const isPermanentlyFailed = await redis.get(`thumb_failed_permanently:${sanitizedRelPath}`);
        if (isPermanentlyFailed) {
            return { status: 'failed' };
        }

        // 按需生成：立即派发任务
        const task = {
            filePath: resolvedSourceAbsPath,
            relativePath: sanitizedRelPath,
            type: isVideo ? 'video' : 'photo'
        };

        const dispatched = dispatchThumbnailTask(task);
        if (!dispatched) {
            logger.warn(`[按需生成] 任务派发失败: ${sanitizedRelPath} (工作线程繁忙或重复任务)`);
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
    const batchStartTs = Date.now();
    try {
        try { global.__thumbBatchActive = true; } catch {}
        const { dbAll } = require('../db/multi-db');

        // 统一闸门：重负载时让路，空闲窗口再跑（零配置）
        try { const orchestrator = require('./orchestrator'); await orchestrator.gate('thumb-batch', { checkIntervalMs: 3000 }); } catch {}
        
        // 优先查询明确需要补全的状态
        let missingThumbs = await dbAll('main', `
            SELECT path FROM thumb_status
            WHERE status IN ('missing', 'failed', 'pending')
            ORDER BY last_checked ASC
            LIMIT ?
        `, [limit]);

        logger.debug(`[批量补全] 明确缺失状态查询结果: ${missingThumbs?.length || 0} 个`);

        // 如果明确缺失的不够limit，则检查'exists'状态的记录是否真的存在
        if (missingThumbs.length < limit) {
            const remainingLimit = limit - missingThumbs.length;
            logger.debug(`[批量补全] 需要额外检查 ${remainingLimit} 个'exists'状态记录`);

            // 查询最近检查的'exists'状态记录，优先检查可能过期的
            const existsCandidates = await dbAll('main', `
                SELECT path FROM thumb_status
                WHERE status = 'exists'
                ORDER BY last_checked ASC
                LIMIT ?
            `, [remainingLimit * 3]); // 多查询一些用于验证

            if (existsCandidates && existsCandidates.length > 0) {
                logger.debug(`[批量补全] 找到 ${existsCandidates.length} 个'exists'状态记录待验证`);

                // 限制并发文件检查数量，避免系统过载
                const MAX_CONCURRENT_CHECKS = Math.min(50, existsCandidates.length);

                // 并行验证文件存在性，避免同步I/O阻塞
                const validationPromises = existsCandidates.slice(0, MAX_CONCURRENT_CHECKS).map(async (row) => {
                    const relativePath = row.path;
                    const isVideo = /\.(mp4|webm|mov)$/i.test(relativePath);
                    const extension = isVideo ? '.jpg' : '.webp';
                    const thumbRelPath = relativePath.replace(/\.[^.]+$/, extension);
                    const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);

                    try {
                        await fs.access(thumbAbsPath);
                        return null; // 文件存在，不需要补全
                    } catch {
                        // 文件不存在，需要补全
                        return { path: relativePath };
                    }
                });

                // 等待所有验证完成
                const validationResults = await Promise.all(validationPromises);

                // 收集需要补全的文件
                const additionalMissing = validationResults.filter(result => result !== null);

                if (additionalMissing.length > 0) {
                    logger.debug(`[批量补全] 在'exists'状态记录中发现 ${additionalMissing.length} 个缺失缩略图`);
                    missingThumbs = missingThumbs.concat(additionalMissing);
                }
            }
        }

        logger.debug(`[批量补全] 验证后发现 ${missingThumbs.length} 个真正需要补全的缩略图`);

        // 添加更详细的调试信息（仅在有需要补全的文件时）
        if (missingThumbs && missingThumbs.length > 0) {
            // 查询各状态的总数，用于调试
            const statusCounts = await dbAll('main', `
                SELECT status, COUNT(*) as count
                FROM thumb_status
                WHERE status IN ('missing', 'failed', 'pending', 'processing', 'exists')
                GROUP BY status
            `);
            logger.debug(`[批量补全] 当前状态统计: ${statusCounts.map(s => `${s.status}:${s.count}`).join(', ')}`);
        }

        // 调试：显示前5个需要补全的文件
        if (missingThumbs && missingThumbs.length > 0) {
            const samplePaths = missingThumbs.slice(0, 5).map(row => row.path);
            logger.debug(`[批量补全] 示例文件: ${samplePaths.join(', ')}`);
        }

        if (missingThumbs.length === 0) {
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
        let cooldownEnforced = false;

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
        const { idleThumbnailWorkers, ensureThumbnailWorkerPool } = require('./worker.manager');
        const { NUM_WORKERS } = require('../config');
        // 批量入口：确保线程池已就绪，并安装监听器（懒加载场景否则 idle 恒为 0）
        try { ensureThumbnailWorkerPool(); } catch {}
        if (!__thumbListenersSetup) {
            try { setupThumbnailWorkerListeners(); } catch {}
        }
        // 优化：批量补全时减少预留按需工人数量（默认为0，最大并发）
        let RESERVED_ONDEMAND = Math.max(0, Math.floor(Number(process.env.THUMB_ONDEMAND_RESERVE || 0)));
        RESERVED_ONDEMAND = Math.max(0, Math.min(RESERVED_ONDEMAND, Math.max(0, NUM_WORKERS - 2))); // 确保至少留2个工人用于批量补全
        logger.debug(`[批量补全] 预留按需工人数: ${RESERVED_ONDEMAND}/${NUM_WORKERS} (可用工人: ${idleThumbnailWorkers.length})`);

        // 智能负载控制：确保不影响按需生成和系统运行（优先使用 DETECTED_*，避免容器误读宿主机）
        const resolvedCpu = Number(process.env.DETECTED_CPU_COUNT) || require('os').cpus().length;
        const resolvedMemGB = Number(process.env.DETECTED_MEMORY_GB) || Math.floor(require('os').totalmem() / (1024 * 1024 * 1024));
        const currentLoad = require('os').loadavg()[0]; // 1分钟平均负载
        const cpuCount = resolvedCpu;
        const totalMemoryGB = resolvedMemGB;
        const isHighLoad = currentLoad > cpuCount * 0.8; // 负载超过80%认为高负载

        // 动态调整预留策略，确保按需生成不受影响
        if (isHighLoad) {
            // 高负载时预留更多工人，但至少保留1个给批量派发
            RESERVED_ONDEMAND = Math.max(1, Math.floor(NUM_WORKERS * 0.4));
            logger.warn(`[批量补全] 检测到高负载状态 (${currentLoad.toFixed(1)}/${cpuCount})，调整预留工人到${RESERVED_ONDEMAND}`);
        }
        // 绝不把预留设到等于总工人数，避免批量完全饿死
        RESERVED_ONDEMAND = Math.min(RESERVED_ONDEMAND, Math.max(NUM_WORKERS - 1, 0));
        if (NUM_WORKERS <= 1) RESERVED_ONDEMAND = 0;

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
        // 统一闸门引用
        const orchestrator = require('./orchestrator');
        while (i < missingThumbs.length) {
            if (await orchestrator.isHeavy()) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
            let available = idleThumbnailWorkers.length - RESERVED_ONDEMAND;
            // 若确有空闲工人但被预留吃光，至少放行1个给批量派发
            if (available <= 0 && idleThumbnailWorkers.length > 0) { available = 1; }
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

            const rawRelativePath = missingThumbs[i].path;
            const sanitizedRelativePath = sanitizePath(rawRelativePath);
            if (!sanitizedRelativePath || !isPathSafe(sanitizedRelativePath)) {
                skipped++;
                i++;
                continue;
            }

            const sourceAbsPath = path.join(require('../config').PHOTOS_DIR, sanitizedRelativePath);

            // 源文件检查
            try {
                await fs.access(sourceAbsPath);
            } catch {
                skipped++;
                i++;
                continue;
            }

            // 去重：已在处理则跳过
            if (activeTasks.has(sanitizedRelativePath)) {
                skipped++;
                i++;
                continue;
            }

            const isVideo = /\.(mp4|webm|mov)$/i.test(sanitizedRelativePath);
            const task = { filePath: sourceAbsPath, relativePath: sanitizedRelativePath, type: isVideo ? 'video' : 'photo' };

            const dispatched = dispatchThumbnailTask(task, 'batch');
            if (dispatched) {
                queued++;
                
                // 立即更新数据库状态为processing，避免下一轮重复查询
                // 注意：不更新last_checked，保持原有的排序逻辑
                try {
                    const { runAsync } = require('../db/multi-db');
                    await runAsync('main', 
                        'UPDATE thumb_status SET status = ? WHERE path = ?',
                        ['processing', sanitizedRelativePath]
                    );
                } catch (e) {
                    logger.warn(`[批量补全] 更新任务状态失败: ${sanitizedRelativePath}, ${e.message}`);
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

                if (BATCH_COOLDOWN_MS > 0 && BATCH_COOLDOWN_MS <= 60000) {
                    cooldownEnforced = true;
                    await new Promise(resolve => setTimeout(resolve, BATCH_COOLDOWN_MS));
                }
            } else {
                // 理论上此时应仅发生于瞬时并发，等待下一次空闲
                await waitForIdle(5000);
            }
        }

        logger.debug(`[手动补全] 缩略图批量补全完成: 已排队 ${queued} 个任务，跳过 ${skipped} 个文件`);
        const batchDurationMs = Date.now() - batchStartTs;
        const now = Date.now();
        if (now - __lastBatchTelemetryLog >= TELEMETRY_LOG_INTERVAL_MS) {
            __lastBatchTelemetryLog = now;
            logger.info(`[ThumbMetrics] batch_dispatch`, {
                processed: missingThumbs.length,
                queued,
                skipped,
                durationMs: batchDurationMs,
                cooldownMs: cooldownEnforced ? BATCH_COOLDOWN_MS : 0,
                backlogPending: thumbMetrics.pending,
                queuedLength: ondemandQueue.length
            });
        }
        
        try { global.__thumbBatchActive = false; } catch {}
        //   在循环批量模式下，不要销毁worker池，避免下一轮无法启动
        try {
            const active = Number(global.__thumbActiveCount || 0);
            const qlen = Number(global.__thumbOndemandQueueLen || 0);
            // 只有在非循环批量模式且确实空闲时才销毁worker池
            if (active === 0 && qlen === 0 && !global.__thumbBatchLoopActive) {
                try { require('./worker.manager').destroyThumbnailWorkerPool(); } catch {}
            }
        } catch {}
        return {
            success: true,
            message: `批量补全任务已启动`,
            processed: missingThumbs.length,  // 返回本批次处理的总数量
            queued: queued,                   // 返回实际排队的任务数量
            skipped: skipped,
            foundMissing: missingThumbs.length,  // 新增：本批次找到的缺失数量
            cooldownApplied: cooldownEnforced,
            durationMs: batchDurationMs
        };
    } catch (error) {
        logger.error('批量补全缩略图失败:', error);
        try { global.__thumbBatchActive = false; } catch {}
        throw error;
    }
}

function getThumbnailTaskMetrics() {
    refreshThumbMetrics();
    return {
        generated: thumbMetrics.generated,
        skipped: thumbMetrics.skipped,
        failures: thumbMetrics.failures,
        permanentFailures: thumbMetrics.permanentFailures,
        retries: thumbMetrics.retries,
        lastError: thumbMetrics.lastError,
        lastFailureAt: thumbMetrics.lastFailureAt,
        lastGeneratedAt: thumbMetrics.lastGeneratedAt,
        queued: thumbMetrics.queued,
        processing: thumbMetrics.processing,
        pending: thumbMetrics.pending,
        lastUpdatedAt: thumbMetrics.lastUpdatedAt
    };
}

// 导出缩略图服务函数
module.exports = {
    setupThumbnailWorkerListeners,    // 设置工作线程监听器
    ensureThumbnailExists,            // 确保缩略图存在（按需生成）
    batchGenerateMissingThumbnails,   // 批量补全缺失的缩略图
    queueThumbStatusUpdate,           // 队列缩略图状态更新
    getThumbnailTaskMetrics,
};