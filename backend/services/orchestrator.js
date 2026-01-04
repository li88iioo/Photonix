/**
 * 轻量级工作负载编排器（Orchestrator）。
 *
 * 目标说明：
 * - 所有重型后台任务均经由单一调度路径串行化。
 * - 优先使用 Redis 分布式锁；若不可用则降级为本地锁（单进程内）。
 * - gate/withAdmission 辅助函数复用统一的空闲检测逻辑 。
 */
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;

let redisClient = null;
try {
    ({ redis: redisClient } = require('../config/redis'));
} catch (error) {
    logger.debug(`${LOG_PREFIXES.ORCHESTRATOR} Redis模块在加载时不可用，仅使用本地锁`);
}
const { safeRedisSet, safeRedisDel } = require('../utils/helpers');
const { hasResourceBudget } = require('./adaptive.service');

let __heavyCache = { at: 0, val: false };
const HEAVY_CACHE_TTL_MS = Number(process.env.HEAVY_CACHE_TTL_MS || 3000);
const DEFAULT_RETRY_MS = Math.max(1000, Number(process.env.IDLE_JOB_RETRY_MS || 30000));
const DEFAULT_IDLE_WAIT_MS = Math.max(2000, Number(process.env.IDLE_JOB_MAX_WAIT_MS || (5 * 60 * 1000)));
const LOCAL_LOCK_CLEANUP_MS = Number(process.env.LOCAL_LOCK_CLEANUP_MS || 60000);
const DB_MAINT_DB_DELAY_STEP_MS = Number(process.env.DB_MAINT_DB_DELAY_STEP_MS || 500);
const DB_MAINT_INITIAL_DELAY_MS = Number(process.env.DB_MAINT_INITIAL_DELAY_MS || 30000);

// 数据库维护定时器引用（用于优雅关闭时清理）
let maintenanceTimers = { initial: null, interval: null };

/**
 * 本地锁管理器，实现进程内简易锁机制
 */
class LocalLockManager {
    constructor(cleanupIntervalMs = LOCAL_LOCK_CLEANUP_MS) {
        this.cleanupIntervalMs = cleanupIntervalMs;
        this.locks = new Map();
        this.lastCleanupAt = 0;
    }

    /**
     * 尝试获取指定 key 的本地锁
     * @param {string} key
     * @param {number} ttlMs
     * @returns {boolean} 是否成功获取锁
     */
    acquire(key, ttlMs) {
        const now = Date.now();
        this.cleanup(now);
        const expiresAt = this.locks.get(key);
        if (expiresAt && expiresAt > now) {
            return false;
        }
        this.locks.set(key, now + ttlMs);
        return true;
    }

    /**
     * 释放本地锁
     * @param {string} key
     */
    release(key) {
        this.locks.delete(key);
        this.cleanup();
    }

    /**
     * 清理过期锁
     * @param {number} [now]
     */
    cleanup(now = Date.now()) {
        if (now - this.lastCleanupAt < this.cleanupIntervalMs) {
            return;
        }
        for (const [lockKey, expiresAt] of this.locks.entries()) {
            if (expiresAt <= now) {
                this.locks.delete(lockKey);
            }
        }
        this.lastCleanupAt = now;
    }
}

const localLockManager = new LocalLockManager();
const jobStates = new Map(); // jobName -> { promise, createdAt, settled, warned, stale }
let serializedJobs = Promise.resolve();

// 定期清理超长时间未完成的 jobStates 条目（防止内存泄漏）
const JOB_STATE_MAX_AGE_MS = Number(process.env.JOB_STATE_MAX_AGE_MS || 2 * 60 * 60 * 1000); // 2小时
const jobStateCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [jobName, state] of jobStates.entries()) {
        if (!state || !state.promise) continue;
        const age = now - (state.createdAt || now);
        if (state.settled || state.stale) {
            jobStates.delete(jobName);
            logger.debug(`${LOG_PREFIXES.ORCHESTRATOR} 清理已完成/过期的任务状态: ${jobName}`);
            continue;
        }
        if (age > JOB_STATE_MAX_AGE_MS && !state.warned) {
            logger.warn(`${LOG_PREFIXES.ORCHESTRATOR} 任务状态运行超时，标记为 stale 以允许重排: ${jobName}（> ${Math.round(JOB_STATE_MAX_AGE_MS / 60000)} 分钟）`);
            state.warned = true;
            state.stale = true;
        }
    }
}, 10 * 60 * 1000); // 每10分钟检查一次
if (typeof jobStateCleanupTimer.unref === 'function') jobStateCleanupTimer.unref();


/**
 * 柔性日志忽略（用于抑制冗余日志）
 * @param {string} scope
 * @param {Error} error
 */
function logSoftIgnore(scope, error) {
    if (!error) return;
    logger.debug(`${LOG_PREFIXES.ORCHESTRATOR} ${scope} 忽略错误: ${error.message}`);
}

/**
 * 判断当前系统资源或索引进度是否为“繁忙”状态
 * @returns {Promise<boolean>}
 */
async function isHeavy() {
    const now = Date.now();
    if (now - __heavyCache.at <= HEAVY_CACHE_TTL_MS) {
        return __heavyCache.val;
    }
    try {
        const idxRepo = require('../repositories/indexStatus.repo');
        const status = await idxRepo.getIndexStatus();
        if (status === 'building') {
            __heavyCache = { at: now, val: true };
            return true;
        }
        const resumeVal = await idxRepo.getResumeValue('last_processed_path');
        if (resumeVal) {
            __heavyCache = { at: now, val: true };
            return true;
        }
    } catch (error) {
        logSoftIgnore('读取索引状态', error);
    }

    const { loadOk, memOk } = hasResourceBudget();
    if (!loadOk || !memOk) {
        __heavyCache = { at: now, val: true };
        return true;
    }

    // 检查按需缩略图任务（前台任务优先）
    try {
        const state = require('./state.manager');
        const thumbActive = state.thumbnail.getActiveCount() || 0;
        const thumbQueued = state.thumbnail.getQueueLen() || 0;
        const thumbPending = thumbActive + thumbQueued;

        // 如果按需任务超过阈值，认为系统繁忙（为前台让路）
        const THRESHOLD = Number(process.env.THUMB_ONDEMAND_BUSY_THRESHOLD || 5);
        if (thumbPending > THRESHOLD) {
            __heavyCache = { at: now, val: true };
            return true;
        }
    } catch (error) {
        logSoftIgnore('检测按需缩略图任务', error);
    }

    __heavyCache = { at: now, val: false };
    return false;
}

/**
 * 按照串行调度安排惰性任务
 * @param {string} jobName 
 * @param {Function} fn 
 * @param {object} opts 
 */
async function runWhenIdle(jobName, fn, opts = {}) {
    if (typeof fn !== 'function') {
        throw new Error(`runWhenIdle("${jobName}") 需要一个回调函数参数`);
    }

    const existing = jobStates.get(jobName);
    // 如果任务已存在且未完成/未过期，则跳过重复安排
    if (existing && !existing.settled && !existing.stale) {
        logger.debug(`${LOG_PREFIXES.ORCHESTRATOR} 任务 "${jobName}" 已在队列中或正在执行，跳过重复安排`);
        return existing.promise;
    }


    const jobOptions = {
        startDelayMs: Number(opts.startDelayMs || 8000),
        retryIntervalMs: Number(opts.retryIntervalMs || DEFAULT_RETRY_MS),
        idleCheckIntervalMs: Number(opts.idleCheckIntervalMs || 1500),
        maxIdleWaitMs: Number(opts.maxIdleWaitMs || DEFAULT_IDLE_WAIT_MS),
        lockTtlSec: Number(opts.lockTtlSec || 7200),
        lockKey: `lock:job:${jobName}`,
    };

    let trackedPromise;
    const scheduled = serializedJobs
        .catch(() => undefined)
        .then(() => executeIdleJob(jobName, fn, jobOptions));

    serializedJobs = scheduled.finally(() => undefined);

    trackedPromise = scheduled.finally(() => {
        const state = jobStates.get(jobName);
        if (state && state.promise === trackedPromise) {
            state.settled = true;
            jobStates.delete(jobName);
            logger.debug(`${LOG_PREFIXES.ORCHESTRATOR} 任务完成，已清理状态: ${jobName}`);
        }
    });

    jobStates.set(jobName, { promise: trackedPromise, createdAt: Date.now(), settled: false, warned: false, stale: false });
    return trackedPromise;
}

/**
 * 实际串行执行惰性任务（带重试、空闲窗口与锁控制）
 * @param {string} jobName 
 * @param {Function} fn 
 * @param {object} opts 
 */
async function executeIdleJob(jobName, fn, opts) {
    await sleep(Math.max(0, opts.startDelayMs));

    while (true) {
        const ready = await waitForIdleWindow({
            idleCheckIntervalMs: opts.idleCheckIntervalMs,
            maxIdleWaitMs: opts.maxIdleWaitMs,
        });
        if (!ready) {
            logger.debug(`${LOG_PREFIXES.ORCHESTRATOR} 任务 "${jobName}" 等待空闲超时，${opts.retryIntervalMs}ms后重试`);
            await sleep(opts.retryIntervalMs);
            continue;
        }

        const lockSource = await acquireJobLock(opts.lockKey, opts.lockTtlSec);
        if (!lockSource) {
            logger.debug(`${LOG_PREFIXES.ORCHESTRATOR} 任务 "${jobName}" 获取锁失败，${opts.retryIntervalMs}ms后重试`);
            await sleep(opts.retryIntervalMs);
            continue;
        }

        try {
            logger.info(`${LOG_PREFIXES.ORCHESTRATOR} 正在执行任务 "${jobName}"`);
            await fn();
            logger.info(`${LOG_PREFIXES.ORCHESTRATOR} 任务完成 "${jobName}"`);
            return;
        } catch (error) {
            logger.error(`${LOG_PREFIXES.ORCHESTRATOR} 任务执行失败`, {
                jobName,
                error: error?.message || String(error),
                stack: error?.stack,
                lockKey: opts.lockKey,
                retryIntervalMs: opts.retryIntervalMs
            });
        } finally {
            await releaseJobLock(opts.lockKey, lockSource);
        }

        await sleep(opts.retryIntervalMs);
    }
}

/**
 * 等待空闲窗口判断
 * @param {object} opts 
 * @returns {Promise<boolean>}
 */
async function waitForIdleWindow(opts = {}) {
    const checkIntervalMs = Math.max(250, Number(opts.idleCheckIntervalMs || 1500));
    const maxWaitMs = Math.max(checkIntervalMs, Number(opts.maxIdleWaitMs || DEFAULT_IDLE_WAIT_MS));
    const started = Date.now();

    while (await isHeavy()) {
        if (Date.now() - started >= maxWaitMs) {
            return false;
        }
        await sleep(checkIntervalMs);
    }
    return true;
}

/**
 * 获取全局分布式锁，优先 Redis，不可用时退回本地锁
 * @param {string} lockKey 
 * @param {number} ttlSec 
 * @returns {Promise<'redis'|'local'|null>}
 */
async function acquireJobLock(lockKey, ttlSec) {
    if (redisClient && redisClient.status === 'ready') {
        try {
            const ok = await safeRedisSet(
                redisClient,
                lockKey,
                'LOCKED',
                'EX',
                ttlSec,
                `acquire lock ${lockKey}`,
                'NX'
            );
            if (ok) {
                return 'redis';
            }
        } catch (error) {
            logger.warn(`${LOG_PREFIXES.ORCHESTRATOR} 获取Redis锁失败`, {
                lockKey,
                error: error?.message,
                ttlSec
            });
        }
    }

    const localOk = acquireLocalLock(lockKey, ttlSec * 1000);
    return localOk ? 'local' : null;
}

/**
 * 释放分布式锁
 * @param {string} lockKey 
 * @param {'redis'|'local'} source 
 */
async function releaseJobLock(lockKey, source) {
    if (source === 'redis' && redisClient && redisClient.status === 'ready') {
        try {
            await safeRedisDel(redisClient, lockKey, `release lock ${lockKey}`);
            return;
        } catch (error) {
            logger.warn(`${LOG_PREFIXES.ORCHESTRATOR} 释放Redis锁失败`, {
                lockKey,
                error: error?.message
            });
        }
    }
    if (source === 'local') {
        releaseLocalLock(lockKey);
    }
}

/**
 * 获取本地锁
 * @param {string} key 
 * @param {number} ttlMs 
 * @returns {boolean}
 */
function acquireLocalLock(key, ttlMs) {
    return localLockManager.acquire(key, ttlMs);
}

/**
 * 释放本地锁
 * @param {string} key 
 */
function releaseLocalLock(key) {
    localLockManager.release(key);
}

/**
 * 延迟辅助函数
 * @param {number} ms 
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 等待空闲资源的门控函数
 * @param {string} kind 
 * @param {object} opts 
 * @returns {Promise<void>}
 */
async function gate(kind, opts = {}) {
    const ready = await waitForIdleWindow({
        idleCheckIntervalMs: opts.checkIntervalMs,
        maxIdleWaitMs: opts.maxWaitMs,
    });
    if (!ready) {
        logger.debug(`${LOG_PREFIXES.ORCHESTRATOR} gate("${kind || 'unknown'}") 等待空闲过久，直接继续`);
    }
}

/**
 * 把耗时任务包裹成 admission 并等待空闲资源再运行
 * @param {string} kind 
 * @param {Function} fn 
 * @param {object} opts 
 * @returns {Promise}
 */
async function withAdmission(kind, fn, opts = {}) {
    await gate(kind, opts);
    return fn();
}

/**
 * 执行数据库维护操作（如 WAL 截断、ANALYZE 统计）
 */
async function performDbMaintenance() {
    const { dbRun } = require('../db/multi-db');
    const dbs = ['main', 'index', 'settings'];
    for (let i = 0; i < dbs.length; i += 1) {
        const db = dbs[i];
        try {
            if (i > 0) {
                await sleep(DB_MAINT_DB_DELAY_STEP_MS * i);
            }
            await dbRun(db, 'PRAGMA wal_checkpoint(TRUNCATE)').catch(err => logger.warn(`数据库 "${db}" checkpoint 失败: ${err.message}`));
            await dbRun(db, 'ANALYZE').catch(err => logger.warn(`数据库 "${db}" analyze 失败: ${err.message}`));
            logger.info(`${LOG_PREFIXES.ORCHESTRATOR} 数据库维护已完成：${db}`);
        } catch (error) {
            logger.debug(`${LOG_PREFIXES.ORCHESTRATOR} 数据库维护失败 ${db}: ${error && error.message}`);
        }
    }
}

/**
 * 定期安排数据库维护任务
 */
function scheduleDbMaintenance() {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const intervalMs = Number(process.env.DB_MAINT_INTERVAL_MS || DAY_MS);
    const retryMs = Number(process.env.DB_MAINT_RETRY_MS || (6 * 60 * 60 * 1000));

    const enqueueMaintenance = () => {
        runWhenIdle(LOG_PREFIXES.DB_MAINTENANCE, performDbMaintenance, { startDelayMs: 0, retryIntervalMs: retryMs });
    };

    maintenanceTimers.initial = setTimeout(enqueueMaintenance, DB_MAINT_INITIAL_DELAY_MS);
    maintenanceTimers.interval = setInterval(enqueueMaintenance, intervalMs);

    // 允许进程退出（定时器不阻止进程退出）
    if (typeof maintenanceTimers.initial.unref === 'function') maintenanceTimers.initial.unref();
    if (typeof maintenanceTimers.interval.unref === 'function') maintenanceTimers.interval.unref();
}

/**
 * 停止数据库维护调度（用于优雅关闭）
 */
function stopDbMaintenance() {
    if (maintenanceTimers.initial) {
        clearTimeout(maintenanceTimers.initial);
        maintenanceTimers.initial = null;
    }
    if (maintenanceTimers.interval) {
        clearInterval(maintenanceTimers.interval);
        maintenanceTimers.interval = null;
    }
}

/**
 * 启动 orchestrator 入口
 */
function start() {
    try {
        scheduleDbMaintenance();
    } catch (error) {
        logSoftIgnore('数据库维护定时安排', error);
    }

    // 定期触发垃圾回收（需要 --expose-gc）
    // 可通过环境变量 ENABLE_MANUAL_GC 控制
    const ENABLE_MANUAL_GC = (process.env.ENABLE_MANUAL_GC || 'true').toLowerCase() === 'true';

    if (typeof global.gc === 'function' && ENABLE_MANUAL_GC) {
        logger.debug(`${LOG_PREFIXES.ORCHESTRATOR} 已启用手动垃圾回收调度`);

        let gcLogCount = 0; // GC 日志计数器，用于采样

        const gcInterval = setInterval(async () => {
            try {
                // 只在空闲时触发 GC
                const heavy = await isHeavy();
                if (!heavy) {
                    gcLogCount++;
                    // 采样：首次必输出 + 每10次GC记录一次详细指标，减少 memoryUsage() 开销
                    const shouldLogDetails = (gcLogCount === 1 || gcLogCount % 10 === 0);

                    let memBefore, gcStartTime, gcDuration, heapReleased;
                    if (shouldLogDetails) {
                        memBefore = process.memoryUsage();
                        gcStartTime = Date.now();
                    }

                    global.gc();

                    if (shouldLogDetails) {
                        gcDuration = Date.now() - gcStartTime;
                        const memAfter = process.memoryUsage();
                        heapReleased = ((memBefore.heapUsed - memAfter.heapUsed) / 1024 / 1024).toFixed(2);
                        logger.debug(`${LOG_PREFIXES.ORCHESTRATOR} GC #${gcLogCount} | 耗时: ${gcDuration}ms | 释放堆内存: ${heapReleased}MB | 当前堆: ${(memAfter.heapUsed / 1024 / 1024).toFixed(2)}MB`);
                    }
                }
            } catch (e) {
                logger.debug(`${LOG_PREFIXES.ORCHESTRATOR} 内存回收失败（忽略）:`, e.message);
            }
        }, 120000); // 每2分钟检查一次

        if (typeof gcInterval.unref === 'function') gcInterval.unref();
    } else if (typeof global.gc !== 'function' && ENABLE_MANUAL_GC) {
        logger.warn(`${LOG_PREFIXES.ORCHESTRATOR} ENABLE_MANUAL_GC=true 但 global.gc 不可用，请使用 --expose-gc 启动`);
    }

    logger.debug(`${LOG_PREFIXES.ORCHESTRATOR} 启动完成`);
}

module.exports = {
    start,
    stopDbMaintenance,
    isHeavy,
    runWhenIdle,
    gate,
    withAdmission,
};
