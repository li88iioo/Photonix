/**
 * 缩略图服务模块 - 简化版
 * 纯按需生成缩略图，移除复杂的队列调度机制
 */
const path = require('path');
const { promises: fs } = require('fs');
const PQueue = require('p-queue').default;
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const { TraceManager } = require('../utils/trace');
const { redis } = require('../config/redis');
const { safeRedisIncr, safeRedisSet, safeRedisDel, safeRedisExpire, safeRedisGet } = require('../utils/helpers');
const { RetryManager } = require('../utils/retry');
const { THUMBS_DIR, PHOTOS_DIR, MAX_THUMBNAIL_RETRIES, INITIAL_RETRY_DELAY, NUM_WORKERS, THUMB_ONDEMAND_RESERVE } = require('../config');
const workerManager = require('./worker.manager');
const {
    ensureThumbnailWorkerPool,
    noteThumbnailUse,
    scaleThumbnailWorkerPool,
    destroyThumbnailWorkerPool,
    runThumbnailTask,
} = workerManager;
const { dbRun } = require('../db/multi-db');
const eventBus = require('./event.service');
const { sanitizePath, isPathSafe } = require('../utils/path.utils');
const state = require('./state.manager');

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
// 使用状态管理器替代全局变量
state.thumbnail.setTaskMetrics(thumbMetrics);

// 环境检测：开发环境显示详细日志
const isDevelopment = process.env.NODE_ENV !== 'production';

function logThumbIgnore(scope, error) {
    if (!error) return;
    logger.silly(`[ThumbnailService] ${scope} 忽略异常: ${error.message}`);
}

// 简化的任务管理
const activeTasks = new Set();          // 正在处理的任务集合
const activeTaskContexts = new Map();   // relativePath -> context (ondemand/batch)
const activeCounts = { ondemand: 0, batch: 0 };  // 正在执行的任务数
// 注意：重试计数由 RetryManager 在 Redis 中持久化管理，此处仅保留时间戳用于指标
const failureTimestamps = new Map();    // 失败记录的时间戳

// 单一优先队列：0=ondemand, 1=batch
const MAX_ONDEMAND_QUEUE = Number(process.env.THUMB_ONDEMAND_QUEUE_MAX || 2000);
const MAX_BATCH_QUEUE = Number(process.env.THUMB_BATCH_QUEUE_MAX || 5000);
const BATCH_COOLDOWN_MS = Math.max(0, Number(process.env.THUMB_BATCH_COOLDOWN_MS || 0));
const TELEMETRY_LOG_INTERVAL_MS = Math.max(5000, Number(process.env.THUMB_TELEMETRY_LOG_INTERVAL_MS || 15000));
const QUEUE_FULL_WARN_INTERVAL_MS = Math.max(1000, Number(process.env.THUMB_QUEUE_WARN_INTERVAL_MS || 5000));
const QUEUE_FULL_DEBUG_INTERVAL_MS = Math.max(5000, Number(process.env.THUMB_QUEUE_DEBUG_INTERVAL_MS || 30000));

const pendingTasks = new Map(); // relativePath -> context
const pendingCounts = { ondemand: 0, batch: 0 };
const thumbQueue = new PQueue({ concurrency: resolveThumbConcurrencyLimit() });
thumbQueue.on('idle', () => scheduleIdlePoolDestroy());

// 按需空闲销毁：当按需队列清空且无在途任务时，短延时销毁线程池（更符合“本目录生成完后退出”）
let __idleDestroyTimer = null;
const THUMB_ONDEMAND_IDLE_DESTROY_MS = Number(process.env.THUMB_ONDEMAND_IDLE_DESTROY_MS || 30000);
let __lastBatchTelemetryLog = 0;
let lastQueueFullWarnAt = 0;
let lastQueueFullDebugAt = 0;

function scheduleIdlePoolDestroy() {
    try {
        if (__idleDestroyTimer) clearTimeout(__idleDestroyTimer);
        __idleDestroyTimer = setTimeout(() => {
            try {
                if ((pendingCounts.ondemand + pendingCounts.batch) === 0 && state.thumbnail.getActiveCount() === 0) {
                    destroyThumbnailWorkerPool();
                }
            } catch (error) {
                logThumbIgnore('缩回缩略图线程池', error);
            }
        }, THUMB_ONDEMAND_IDLE_DESTROY_MS);
    } catch (error) {
        logThumbIgnore('安排缩略图线程池缩容', error);
    }
}
// 需求信号指标：供自适应增压判断是否需要扩容
function refreshThumbMetrics() {
    const active = state.thumbnail.getActiveCount();
    const queued = pendingCounts.ondemand + pendingCounts.batch;
    thumbMetrics.processing = active;
    thumbMetrics.queued = queued;
    thumbMetrics.pending = active + queued;
    thumbMetrics.lastUpdatedAt = Date.now();
    // 关键：只记录按需队列长度，供批量补全让路判断使用
    state.thumbnail.setQueueLen(pendingCounts.ondemand);
}

refreshThumbMetrics();

function resolveThumbConcurrencyLimit() {
    // 直接使用 NUM_WORKERS（已在 runtime.js 中智能计算，考虑了 I/O 超配）
    return Math.max(1, Math.floor(Number(NUM_WORKERS) || 1));
}

function synchronizeQueueCapacity() {
    const maxConcurrency = resolveThumbConcurrencyLimit();
    ensureThumbnailPoolCapacity(maxConcurrency);
    if (thumbQueue.concurrency !== maxConcurrency) {
        thumbQueue.concurrency = maxConcurrency;
    }
}

function triggerIdleDestroyCheck() {
    if (
        pendingCounts.ondemand === 0 &&
        pendingCounts.batch === 0 &&
        state.thumbnail.getActiveCount() === 0 &&
        thumbQueue.size === 0 &&
        thumbQueue.pending === 0
    ) {
        scheduleIdlePoolDestroy();
    }
}

async function runQueuedTask(task, context, traceData) {
    if (pendingTasks.delete(task.relativePath)) {
        pendingCounts[context] = Math.max(0, pendingCounts[context] - 1);
        refreshThumbMetrics();
    }
    try {
        await startThumbnailTask(task, context, traceData);
    } finally {
        triggerIdleDestroyCheck();
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

    // 清理失败时间戳记录（重试计数由 RetryManager 通过 Redis TTL 自动清理）
    const expiredPaths = [];
    for (const [path, timestamp] of failureTimestamps.entries()) {
        if ((now - timestamp) > FAILURE_ENTRY_TTL_MS) {
            failureTimestamps.delete(path);
            expiredPaths.push(`thumb:${path}`); // 收集需要清理的 RetryManager 上下文
            cleanedFailures++;
        }
    }

    // 清理 RetryManager 的降级计数（仅在 Redis 不可用时才存在）
    if (expiredPaths.length > 0) {
        RetryManager.clearFallbackCounts(expiredPaths);
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
let thumbStatusFlushPromise = null;

async function queueThumbStatusUpdate(relPath, mtime, status) {
    try {
        const prev = thumbStatusPending.get(relPath);
        if (!prev || (mtime || 0) >= (prev.mtime || 0)) {
            thumbStatusPending.set(relPath, { mtime: mtime || Date.now(), status });
        }

        scheduleThumbStatusFlush();
    } catch (e) {
        logger.debug(`队列缩略图状态更新失败 [path=${relPath}]: ${e.message}`);
    }
}

/**
 * 缩略图状态管理器
 * 处理批量状态更新和错误恢复逻辑
 */
class ThumbStatusManager {
    constructor() {
        const ThumbStatusRepository = require('../repositories/thumbStatus.repo');
        this.repo = new ThumbStatusRepository();
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
                await this.repo.upsertBatch(rows, { manageTransaction: true, chunkSize: 400 }, redis);
            });
            logger.debug(`[THUMB] 批量写入缩略图状态成功: ${rows.length} 条记录`);
            return { success: true, rowsAffected: rows.length };
        } catch (e) {
            // 兜底：即便闸门封装异常也直接写一次，确保最终可达
            await this.repo.upsertBatch(rows, { manageTransaction: true, chunkSize: 400 }, redis);
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

                await this.repo.upsertSingle(cleanPath, Number(mtime) || Date.now(), String(status || 'pending'), redis);
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

function scheduleThumbStatusFlush() {
    if (thumbStatusFlushPromise) {
        return;
    }
    thumbStatusFlushPromise = (async () => {
        while (thumbStatusPending.size > 0) {
            const snapshot = Array.from(thumbStatusPending.entries());
            thumbStatusPending.clear();
            try {
                await thumbStatusManager.executeBatchFlush(snapshot, redis);
            } catch (error) {
                for (const [pathRel, payload] of snapshot) {
                    const current = thumbStatusPending.get(pathRel);
                    if (!current || (payload.mtime || 0) >= (current.mtime || 0)) {
                        thumbStatusPending.set(pathRel, payload);
                    }
                }
                logger.error(`[THUMB] 批量刷新缩略图状态失败: ${error.message}`);
                throw error;
            }
        }
    })().catch((error) => {
        logThumbIgnore('缩略图状态刷新任务', error);
    }).finally(() => {
        thumbStatusFlushPromise = null;
        if (thumbStatusPending.size > 0) {
            scheduleThumbStatusFlush();
        }
    });
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

    const label = context === 'batch' ? 'batch' : 'ondemand';
    const maxQueue = label === 'ondemand' ? MAX_ONDEMAND_QUEUE : MAX_BATCH_QUEUE;

    if (activeTasks.has(safeTask.relativePath) || pendingTasks.has(safeTask.relativePath)) {
        return true;
    }

    synchronizeQueueCapacity();

    const traceContext = TraceManager.getCurrentContext();
    const traceData = traceContext ? traceContext.toObject() : null;

    // 预留槽位检查：只在有按需任务时才限制批量（按需预留，而非永久预留）
    if (label === 'batch' && THUMB_ONDEMAND_RESERVE > 0) {
        // 关键：检查是否有按需任务在排队或执行
        const ondemandPending = activeCounts.ondemand + pendingCounts.ondemand;

        if (ondemandPending > 0) {
            // 有按需任务时，限制批量使用量
            const totalConcurrency = thumbQueue.concurrency;
            const availableForBatch = Math.max(1, totalConcurrency - THUMB_ONDEMAND_RESERVE);
            const currentBatchUsage = activeCounts.batch + pendingCounts.batch;

            if (currentBatchUsage >= availableForBatch) {
                // 批量任务已用满可用槽位，拒绝派发（为按需任务保留）
                const now = Date.now();
                if (now - lastQueueFullDebugAt >= QUEUE_FULL_DEBUG_INTERVAL_MS) {
                    logger.debug(`[批量生成] 检测到按需任务(${ondemandPending}个)，限制批量并发(${currentBatchUsage}/${availableForBatch})，预留${THUMB_ONDEMAND_RESERVE}个槽位`);
                    lastQueueFullDebugAt = now;
                }
                return false;
            }
        }
        // 没有按需任务时，批量可以使用所有worker（火力全开）
    }

    if (pendingCounts[label] >= maxQueue) {
        const now = Date.now();
        if (now - lastQueueFullWarnAt >= QUEUE_FULL_WARN_INTERVAL_MS) {
            logger.warn(`[${label === 'ondemand' ? '按需' : '批量'}队列] 已满(${maxQueue})，暂缓新任务`);
            lastQueueFullWarnAt = now;
        } else if (now - lastQueueFullDebugAt >= QUEUE_FULL_DEBUG_INTERVAL_MS) {
            logger.debug(`[${label === 'ondemand' ? '按需' : '批量'}队列] 已满(${maxQueue})，任务推迟（示例）: ${safeTask.relativePath}`);
            lastQueueFullDebugAt = now;
        }
        return false;
    }

    pendingTasks.set(safeTask.relativePath, label);
    pendingCounts[label] += 1;
    refreshThumbMetrics();
    if (pendingCounts[label] <= 3 || (pendingCounts[label] % 50 === 0)) {
        logger.debug(`[${label === 'ondemand' ? '按需' : '批量'}生成] 并发受限，任务入队: ${safeTask.relativePath} (队列=${pendingCounts[label]}, active=${state.thumbnail.getActiveCount()}, limit=${thumbQueue.concurrency})`);
    }
    const priority = label === 'ondemand' ? 1 : 2; // Lower number = higher priority in PQueue
    thumbQueue.add(() => runQueuedTask(safeTask, label, traceData), { priority }).catch((error) => {
        logThumbIgnore('缩略图任务队列执行', error);
    });
    return true;
}

async function startThumbnailTask(task, context, traceData) {
    const logPrefix = context === 'batch' ? LOG_PREFIXES.BATCH_BACKFILL : LOG_PREFIXES.ONDEMAND_GENERATE;
    const label = context === 'batch' ? 'batch' : 'ondemand';

    activeTasks.add(task.relativePath);
    activeTaskContexts.set(task.relativePath, label);
    activeCounts[label] += 1;
    updateTaskTimestamp(task.relativePath);
    state.thumbnail.incrementActiveCount();
    refreshThumbMetrics();
    const traceContext = traceData ? null : TraceManager.getCurrentContext();
    const payload = {
        task: { ...task, thumbsDir: THUMBS_DIR },
        trace: traceData || (traceContext ? traceContext.toObject() : null),
    };

    logger.debug(`${logPrefix} 缩略图任务已派发: ${task.relativePath}`);
    try {
        noteThumbnailUse();
    } catch (error) {
        logThumbIgnore('分派缩略图任务使用记录', error);
    }

    try {
        const result = await runThumbnailTask(payload);
        await handleWorkerResult(task, result);
    } catch (error) {
        logThumbIgnore('缩略图任务执行异常', error);
        await handleWorkerResult(task, {
            success: false,
            error: { message: error && error.message ? error.message : 'Thumbnail worker failure' }
        });
    }
}

async function handleWorkerResult(task, workerResult) {
    try {
        if (workerResult && workerResult.success) {
            await processWorkerSuccess(task, Boolean(workerResult.skipped));
        } else {
            const errorPayload = workerResult && workerResult.error ? workerResult.error : null;
            await processWorkerFailure(task, errorPayload);
        }
    } catch (error) {
        logThumbIgnore('处理缩略图任务结果', error);
    } finally {
        finalizeWorkerCycle(task.relativePath);
    }
}

async function processWorkerSuccess(task, skipped) {
    const relativePath = task.relativePath;
    const failureKey = `thumb_failed_permanently:${relativePath}`;

    // 清理重试计数（成功后重置）
    await RetryManager.resetRetryCount(`thumb:${relativePath}`);
    failureTimestamps.delete(relativePath);

    if (skipped) {
        await safeRedisDel(redis, failureKey, '清理永久失败标记');
        thumbMetrics.skipped += 1;
        await safeRedisIncr(redis, 'metrics:thumb:skip', '缩略图跳过指标');
    } else {
        logger.debug(`[THUMB] 生成完成: ${relativePath}`);
        thumbMetrics.generated += 1;
        thumbMetrics.lastGeneratedAt = Date.now();

        await redis.publish('thumbnail-generated', JSON.stringify({ path: relativePath }));
        if (isDevelopment) {
            logger.debug(`[THUMB] 已发布缩略图生成事件: ${relativePath}`);
        }

        eventBus.emit('thumbnail-generated', { path: relativePath });
        await safeRedisDel(redis, failureKey, '清理永久失败标记');
        await safeRedisIncr(redis, 'metrics:thumb:success', '缩略图成功指标');

        try {
            const { invalidateTags } = require('./cache.service');
            const dirname = path.dirname(relativePath);
            const tags = [
                `thumbnail:${relativePath}`,
                `album:${dirname}`,
                `album:/`
            ];

            await invalidateTags(tags);
            if (isDevelopment) {
                logger.debug(`[THUMB] 缓存失效完成，标签: ${tags.join(', ')}`);
            }
        } catch (cacheError) {
            logger.debug(`[CACHE] 失效缩略图缓存失败（已忽略）: ${cacheError.message}`);
        }
    }

    try {
        const isVideo = task.type === 'video';
        const extension = isVideo ? '.jpg' : '.webp';
        const thumbRelPath = task.relativePath.replace(/\.[^.]+$/, extension);
        const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);
        const thumbMtime = await fs.stat(thumbAbsPath).then((s) => s.mtimeMs).catch(() => Date.now());
        await queueThumbStatusUpdate(task.relativePath, thumbMtime, 'exists');
        // if (!skipped) { logger.debug(`[THUMB] 更新缩略图状态: ${task.relativePath}, mtime: ${thumbMtime}`); }
    } catch (dbErr) {
        logger.debug(`写入缩略图状态队列失败（成功分支，已忽略）：${dbErr && dbErr.message}`);
    }
}

async function processWorkerFailure(task, errorPayload) {
    const relativePath = task.relativePath;
    const failureKey = `thumb_failed_permanently:${relativePath}`;
    const message = errorPayload && errorPayload.message ? errorPayload.message : (typeof errorPayload === 'string' ? errorPayload : '未知错误');
    let deletedByCorruptionRule = false;

    try {
        const CORRUPT_PARSE_SNIPPET = '损坏或格式异常，无法解析';
        if (typeof message === 'string' && message.includes(CORRUPT_PARSE_SNIPPET)) {
            const corruptionKey = `thumb_corrupt_parse_count:${relativePath}`;
            const corruptCount = await safeRedisIncr(redis, corruptionKey, '缩略图损坏计数') || 0;
            if (corruptCount === 1) {
                await safeRedisExpire(redis, corruptionKey, 3600 * 24 * 30, '缩略图损坏标记');
            }
            logger.warn(`[THUMB] [CORRUPT_PARSE_COUNT] 发现文件损坏: ${relativePath} | count=${corruptCount}/10 | reason=${message}`);
            if (corruptCount >= 10) {
                try {
                    await fs.unlink(task.filePath).catch(() => { });
                    logger.error(`[THUMB] [CORRUPTED_IMAGE_DELETED] 已因出现 ${corruptCount} 次"${CORRUPT_PARSE_SNIPPET}"而删除源文件: ${task.filePath}`);
                    await RetryManager.resetRetryCount(`thumb:${relativePath}`);
                    failureTimestamps.delete(relativePath);
                    await safeRedisSet(redis, failureKey, '1', 'EX', 3600 * 24 * 7, '缩略图永久失败标记');
                    await safeRedisDel(redis, corruptionKey, '清理缩略图损坏标记');
                    deletedByCorruptionRule = true;
                } catch (delErr) {
                    logger.warn(`[THUMB] 触发损坏文件删除失败：${delErr && delErr.message}`);
                    deletedByCorruptionRule = true;
                }
            }
        }
    } catch (err) {
        logger.debug(`[THUMB] 损坏文件检测逻辑失败: ${err.message}`);
    }

    // 使用 RetryManager 管理重试计数（Redis 持久化 + 指数退避）
    const retryInfo = await RetryManager.incrementRetryCount(
        `thumb:${relativePath}`,
        MAX_THUMBNAIL_RETRIES,
        INITIAL_RETRY_DELAY,
        30000 // 最大延迟 30 秒
    );

    failureTimestamps.set(relativePath, Date.now());
    updateTaskTimestamp(relativePath);
    logger.error(`[THUMB] 处理任务失败: ${relativePath} (第 ${retryInfo.retryCount} 次)。错误: ${message}`);
    await safeRedisIncr(redis, 'metrics:thumb:fail', '缩略图失败指标');

    thumbMetrics.failures += 1;
    thumbMetrics.lastError = message;
    thumbMetrics.lastFailureAt = Date.now();

    let statusForDb = 'failed';
    if (deletedByCorruptionRule) {
        thumbMetrics.permanentFailures += 1;
        await RetryManager.resetRetryCount(`thumb:${relativePath}`);
        failureTimestamps.delete(relativePath);
        statusForDb = 'permanent_failed';
    } else if (retryInfo.shouldRetry) {
        logger.warn(`任务 ${relativePath} 将在 ${retryInfo.delay / 1000}秒 后重试 (第 ${retryInfo.retryCount}/${MAX_THUMBNAIL_RETRIES} 次)...`);
        thumbMetrics.retries += 1;
        setTimeout(() => {
            dispatchThumbnailTask({
                filePath: task.filePath,
                relativePath: task.relativePath,
                type: task.type,
            });
        }, retryInfo.delay);
    } else {
        logger.error(`任务 ${relativePath} 已达到最大重试次数 (${MAX_THUMBNAIL_RETRIES}次)，标记为永久失败。`);
        await safeRedisSet(redis, failureKey, '1', 'EX', 3600 * 24 * 7, '缩略图永久失败标记');
        await safeRedisIncr(redis, 'metrics:thumb:permanent_fail', '缩略图永久失败指标');
        thumbMetrics.permanentFailures += 1;
        failureTimestamps.delete(relativePath);
        statusForDb = 'permanent_failed';
    }

    try {
        const srcMtime = await fs.stat(task.filePath).then((s) => s.mtimeMs).catch(() => Date.now());
        await queueThumbStatusUpdate(relativePath, srcMtime, statusForDb);
    } catch (dbErr) {
        logger.debug(`写入缩略图状态队列失败（失败分支，已忽略）：${dbErr && dbErr.message}`);
    }
}

function finalizeWorkerCycle(relativePath) {
    // 减少活跃任务计数
    const taskContext = activeTaskContexts.get(relativePath);
    if (taskContext) {
        activeCounts[taskContext] = Math.max(0, activeCounts[taskContext] - 1);
        activeTaskContexts.delete(relativePath);
    }

    activeTasks.delete(relativePath);
    state.thumbnail.decrementActiveCount();
    refreshThumbMetrics();
    try {
        noteThumbnailUse();
    } catch (error) {
        logThumbIgnore('更新缩略图使用指标', error);
    }
    triggerIdleDestroyCheck();
}

function ensureThumbnailPoolCapacity(limit) {
    const desiredSize = Math.max(1, Math.min(Math.floor(limit), NUM_WORKERS || 1));
    try {
        scaleThumbnailWorkerPool(desiredSize);
    } catch (error) {
        logThumbIgnore('调整缩略图线程池大小', error);
    }
}

function normalizeThumbnailTask(task) {
    if (!task || (typeof task !== 'object')) {
        return null;
    }

    const rawRelative = typeof task.relativePath === 'string' ? task.relativePath : '';
    const sanitizedRelative = sanitizePath(rawRelative);
    if (!sanitizedRelative) {
        logger.warn(`${LOG_PREFIXES.ONDEMAND_GENERATE} 拒绝缺少相对路径的缩略图任务`);
        return null;
    }

    if (!isPathSafe(sanitizedRelative)) {
        logger.warn(`${LOG_PREFIXES.ONDEMAND_GENERATE} 检测到不安全的缩略图路径: ${rawRelative}`);
        return null;
    }

    const resolvedAbsolute = path.resolve(PHOTOS_DIR_SAFE_ROOT, sanitizedRelative);
    if (!resolvedAbsolute.startsWith(PHOTOS_DIR_SAFE_ROOT)) {
        logger.warn(`${LOG_PREFIXES.ONDEMAND_GENERATE} 缩略图任务路径超出受信目录: ${resolvedAbsolute}`);
        return null;
    }

    const declaredAbsolute = typeof task.filePath === 'string' ? task.filePath : resolvedAbsolute;
    const normalizedAbsolute = declaredAbsolute.startsWith(PHOTOS_DIR_SAFE_ROOT)
        ? declaredAbsolute
        : resolvedAbsolute;

    const inferredType = task.type || (/\.(mp4|webm|mov)$/i.test(sanitizedRelative) ? 'video' : 'photo');

    if (!/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(normalizedAbsolute) && !/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(sanitizedRelative)) {
        logger.warn(`${LOG_PREFIXES.ONDEMAND_GENERATE} 拒绝不支持的媒体类型任务: ${sanitizedRelative}`);
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
        logger.warn(`${LOG_PREFIXES.ONDEMAND_GENERATE} 拒绝不安全的缩略图生成请求: ${sourceRelPath}`);
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
        const isPermanentlyFailed = await safeRedisGet(redis, `thumb_failed_permanently:${sanitizedRelPath}`, '检查永久失败标记');
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
            logger.warn(`${LOG_PREFIXES.ONDEMAND_GENERATE} 任务派发失败: ${sanitizedRelPath} (工作线程繁忙或重复任务)`);
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
        try {
            state.thumbnail.setBatchActive(true);
        } catch (error) {
            logThumbIgnore('标记批量缩略图任务开始', error);
        }
        const { dbAll } = require('../db/multi-db');

        // 统一闸门：重负载时让路，空闲窗口再跑（零配置）
        try {
            const orchestrator = require('./orchestrator');
            await orchestrator.gate('thumb-batch', { checkIntervalMs: 3000 });
        } catch (error) {
            logThumbIgnore('批量缩略图任务等待空闲窗口', error);
        }

        // 使用Repository优先查询明确需要补全的状态
        const ThumbStatusRepository = require('../repositories/thumbStatus.repo');
        const thumbStatusRepo = new ThumbStatusRepository();

        let missingThumbs = await thumbStatusRepo.getByStatus(['missing', 'failed', 'pending'], limit);

        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 明确缺失状态查询结果: ${missingThumbs?.length || 0} 个`);

        // 如果明确缺失的不够limit，则检查'exists'状态的记录是否真的存在
        if (missingThumbs.length < limit) {
            const remainingLimit = limit - missingThumbs.length;
            logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 需要额外检查 ${remainingLimit} 个'exists'状态记录`);

            // 查询最近检查的'exists'状态记录，优先检查可能过期的
            const existsCandidates = await thumbStatusRepo.getByStatus('exists', remainingLimit * 3); // 多查询一些用于验证

            if (existsCandidates && existsCandidates.length > 0) {
                logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 找到 ${existsCandidates.length} 个'exists'状态记录待验证`);

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
                    } catch (error) {
                        if (error && error.code !== 'ENOENT') {
                            logThumbIgnore('验证缩略图文件存在性', error);
                        }
                        // 文件不存在，需要补全
                        return { path: relativePath };
                    }
                });

                // 等待所有验证完成
                const validationResults = await Promise.all(validationPromises);

                // 收集需要补全的文件
                const additionalMissing = validationResults.filter(result => result !== null);

                if (additionalMissing.length > 0) {
                    logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 在'exists'状态记录中发现 ${additionalMissing.length} 个缺失缩略图`);
                    missingThumbs = missingThumbs.concat(additionalMissing);
                }
            }
        }

        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 验证后发现 ${missingThumbs.length} 个真正需要补全的缩略图`);

        // 添加更详细的调试信息（仅在有需要补全的文件时）
        if (missingThumbs && missingThumbs.length > 0) {
            // 查询各状态的总数，用于调试（使用索引优化）
            const statusCounts = await dbAll('main', `
                SELECT status, COUNT(1) as count
                FROM thumb_status INDEXED BY idx_thumb_status_status
                WHERE status IN ('missing', 'failed', 'pending', 'processing', 'exists', 'permanent_failed')
                GROUP BY status
            `);
            logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 当前状态统计: ${statusCounts.map(s => `${s.status}:${s.count}`).join(', ')}`);
        }

        // 调试：显示前5个需要补全的文件
        if (missingThumbs && missingThumbs.length > 0) {
            const samplePaths = missingThumbs.slice(0, 5).map(row => row.path);
            logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 示例文件: ${samplePaths.join(', ')}`);
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
        let yieldCount = 0;
        const orchestrator = require('./orchestrator');

        for (let i = 0; i < missingThumbs.length; i += 1) {
            // 持续等待直到按需任务清空
            while (await orchestrator.isHeavy()) {
                yieldCount++;
                const ondemandPending = (state.thumbnail.getActiveCount() || 0) + (state.thumbnail.getQueueLen() || 0);
                if (yieldCount === 1) {
                    logger.info(`${LOG_PREFIXES.BATCH_BACKFILL} 检测到前台任务，批量补全完全暂停等待 (按需任务=${ondemandPending})`);
                } else if (yieldCount % 10 === 0) {
                    logger.info(`${LOG_PREFIXES.BATCH_BACKFILL} 继续等待前台任务完成 (按需任务=${ondemandPending}, 已等待${yieldCount}秒)`);
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            // 恢复日志
            if (yieldCount > 0) {
                logger.info(`${LOG_PREFIXES.BATCH_BACKFILL} 前台任务完成，批量补全恢复运行 (共等待${yieldCount}秒)`);
                yieldCount = 0;
            }

            const rawRelativePath = missingThumbs[i].path;
            const sanitizedRelativePath = sanitizePath(rawRelativePath);
            if (!sanitizedRelativePath || !isPathSafe(sanitizedRelativePath)) {
                skipped++;
                continue;
            }

            if (missingThumbs[i].status === 'permanent_failed') {
                skipped++;
                continue;
            }

            const sourceAbsPath = path.join(PHOTOS_DIR_SAFE_ROOT, sanitizedRelativePath);
            try {
                await fs.access(sourceAbsPath);
            } catch (error) {
                if (error && error.code !== 'ENOENT') {
                    logThumbIgnore('批量任务验证源文件', error);
                }
                skipped++;
                continue;
            }

            try {
                const permanentKey = await safeRedisGet(redis, `thumb_failed_permanently:${sanitizedRelativePath}`, '批量检查永久失败标记');
                if (permanentKey) {
                    await queueThumbStatusUpdate(sanitizedRelativePath, Date.now(), 'permanent_failed');
                    skipped++;
                    continue;
                }
            } catch (permErr) {
                logThumbIgnore('检查永久失败标记', permErr);
            }

            if (activeTasks.has(sanitizedRelativePath)) {
                skipped++;
                continue;
            }

            const isVideo = /(\.mp4|\.webm|\.mov)$/i.test(sanitizedRelativePath);
            const task = { filePath: sourceAbsPath, relativePath: sanitizedRelativePath, type: isVideo ? 'video' : 'photo' };
            const dispatched = dispatchThumbnailTask(task, 'batch');
            if (dispatched) {
                queued++;
                try {
                    const { runAsync } = require('../db/multi-db');
                    await runAsync('main', 'UPDATE thumb_status SET status = ? WHERE path = ?', ['processing', sanitizedRelativePath]);
                } catch (e) {
                    logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 更新任务状态失败: ${sanitizedRelativePath}, ${e.message}`);
                }
            } else {
                skipped++;
            }
        }

        logger.debug(`${LOG_PREFIXES.MANUAL_BACKFILL} 缩略图批量补全完成: 已排队 ${queued} 个任务，跳过 ${skipped} 个文件`);
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
                queuedLength: pendingCounts.ondemand
            });
        }

        try {
            state.thumbnail.setBatchActive(false);
        } catch (error) {
            logThumbIgnore('批量任务结束时更新状态', error);
        }
        //   在循环批量模式下，不要销毁worker池，避免下一轮无法启动
        try {
            const active = state.thumbnail.getActiveCount();
            const qlen = state.thumbnail.getQueueLen();
            // 只有在非循环批量模式且确实空闲时才销毁worker池
            if (active === 0 && qlen === 0 && !state.thumbnail.isBatchLoopActive()) {
                try {
                    require('./worker.manager').destroyThumbnailWorkerPool();
                } catch (error) {
                    logThumbIgnore('批量任务销毁缩略图线程池', error);
                }
            }
        } catch (error) {
            logThumbIgnore('批量任务清理线程池状态', error);
        }
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
        try {
            state.thumbnail.setBatchActive(false);
        } catch (resetError) {
            logThumbIgnore('批量任务错误时恢复状态', resetError);
        }
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
    ensureThumbnailExists,
    batchGenerateMissingThumbnails,
    queueThumbStatusUpdate,
    getThumbnailTaskMetrics,
};
