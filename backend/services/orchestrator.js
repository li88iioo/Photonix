/**
 * 轻量级工作负载编排器
 * - 提供统一的 isHeavy 判定
 * - 在空闲窗口执行任务（runWhenIdle）
 * - gate/withAdmission 供批量任务让路
 */
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const { redis } = require('../config/redis');
const { safeRedisSet, safeRedisDel } = require('../utils/helpers');
const { hasResourceBudget } = require('./adaptive.service');

let __heavyCache = { at: 0, val: false };
const HEAVY_CACHE_TTL_MS = Number(process.env.HEAVY_CACHE_TTL_MS || 3000);
const MAX_IDLE_JOB_CONCURRENCY = Math.max(1, Number(process.env.IDLE_JOB_MAX_CONCURRENCY || 1));
const DEFAULT_RETRY_MS = Number(process.env.IDLE_JOB_RETRY_MS || 30000);
const DEFAULT_IDLE_WAIT_MS = Number(process.env.IDLE_JOB_MAX_WAIT_MS || (5 * 60 * 1000));
const LOCAL_LOCK_CLEANUP_MS = Number(process.env.LOCAL_LOCK_CLEANUP_MS || 60000);
const DB_MAINT_DB_DELAY_STEP_MS = Number(process.env.DB_MAINT_DB_DELAY_STEP_MS || 500);
const DB_MAINT_INITIAL_DELAY_MS = Number(process.env.DB_MAINT_INITIAL_DELAY_MS || 30000);

class LocalLockManager {
    constructor(cleanupIntervalMs = LOCAL_LOCK_CLEANUP_MS) {
        this.cleanupIntervalMs = cleanupIntervalMs;
        this.locks = new Map();
        this.lastCleanupAt = 0;
    }

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

    release(key) {
        this.locks.delete(key);
        this.cleanup();
    }

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

const idleJobQueue = [];
const jobStates = new Map();
let activeIdleJobs = 0;

function logSoftIgnore(scope, error) {
    if (!error) return;
    logger.silly(`[Orchestrator] ${scope} 忽略异常: ${error.message}`);
}

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

    __heavyCache = { at: now, val: false };
    return false;
}

async function runWhenIdle(jobName, fn, opts = {}) {
    if (typeof fn !== 'function') {
        throw new Error(`runWhenIdle("${jobName}") requires a function`);
    }

    const existing = jobStates.get(jobName);
    if (existing) {
        logger.debug(`[Orchestrator] 任务 "${jobName}" 已在排队或执行中，跳过重复安排`);
        return;
    }

    const job = {
        name: jobName,
        fn,
        startDelayMs: Number(opts.startDelayMs || 8000),
        retryIntervalMs: Number(opts.retryIntervalMs || DEFAULT_RETRY_MS),
        lockTtlSec: Number(opts.lockTtlSec || 7200),
        idleCheckIntervalMs: Number(opts.idleCheckIntervalMs || 1500),
        maxIdleWaitMs: Number(opts.maxIdleWaitMs || DEFAULT_IDLE_WAIT_MS),
        lockKey: `lock:job:${jobName}`,
        timeout: null,
        inQueue: false,
    };
    jobStates.set(jobName, job);
    scheduleJob(job, job.startDelayMs);
}

function scheduleJob(job, delayMs) {
    if (job.timeout) {
        clearTimeout(job.timeout);
        job.timeout = null;
    }
    job.timeout = setTimeout(() => {
        job.timeout = null;
        enqueueIdleJob(job);
    }, Math.max(0, delayMs));
}

function enqueueIdleJob(job) {
    if (job.inQueue) return;
    job.inQueue = true;
    idleJobQueue.push(job);
    processIdleJobQueue();
}

function processIdleJobQueue() {
    while (activeIdleJobs < MAX_IDLE_JOB_CONCURRENCY && idleJobQueue.length > 0) {
        const job = idleJobQueue.shift();
        if (!job) continue;
        job.inQueue = false;
        activeIdleJobs += 1;
        runIdleJob(job).finally(() => {
            activeIdleJobs = Math.max(0, activeIdleJobs - 1);
            processIdleJobQueue();
        });
    }
}

async function runIdleJob(job) {
    const { name, fn, retryIntervalMs } = job;
    try {
        const ready = await waitForIdleWindow(job);
        if (!ready) {
            logger.debug(`[Orchestrator] 任务 "${name}" 等待空闲超时，${retryIntervalMs}ms 后重试`);
            scheduleJob(job, retryIntervalMs);
            return;
        }

        const lockSource = await acquireJobLock(job.lockKey, job.lockTtlSec);
        if (!lockSource) {
            logger.debug(`[Orchestrator] 任务 "${name}" 未获取到锁，${retryIntervalMs}ms 后再试`);
            scheduleJob(job, retryIntervalMs);
            return;
        }

        try {
            logger.info(`[Orchestrator] 开始执行任务 "${name}"`);
            await fn();
            cleanupJob(job);
        } catch (error) {
            logger.error(`[Orchestrator] Job "${name}" 执行失败: ${error && error.message}`);
            scheduleJob(job, retryIntervalMs);
        } finally {
            await releaseJobLock(job.lockKey, lockSource);
        }
    } catch (error) {
        logger.warn(`[Orchestrator] 任务 "${name}" 调度异常: ${error && error.message}`);
        scheduleJob(job, retryIntervalMs);
    }
}

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

async function acquireJobLock(lockKey, ttlSec) {
    // 优先使用 Redis 锁，降级到进程内锁
    if (redis && redis.status === 'ready') {
        try {
            const ok = await safeRedisSet(
                redis,
                lockKey,
                'LOCKED',
                'EX',
                ttlSec,
                `获取任务锁 ${lockKey}`,
                'NX'
            );
            if (ok) {
                return 'redis';
            }
        } catch (error) {
            logger.warn(`[Orchestrator] 获取 Redis 锁失败 "${lockKey}": ${error.message}`);
        }
    }

    const localOk = acquireLocalLock(lockKey, ttlSec * 1000);
    return localOk ? 'local' : null;
}

async function releaseJobLock(lockKey, source) {
    if (source === 'redis' && redis && redis.status === 'ready') {
        try {
            await safeRedisDel(redis, lockKey, `释放任务锁 ${lockKey}`);
            return;
        } catch (error) {
            logger.warn(`[Orchestrator] 释放 Redis 锁失败 "${lockKey}": ${error.message}`);
        }
    }
    if (source === 'local') {
        releaseLocalLock(lockKey);
    }
}

function cleanupJob(job) {
    if (!job) return;
    if (job.timeout) {
        clearTimeout(job.timeout);
        job.timeout = null;
    }
    job.inQueue = false;
    jobStates.delete(job.name);
}

function acquireLocalLock(key, ttlMs) {
    return localLockManager.acquire(key, ttlMs);
}

function releaseLocalLock(key) {
    localLockManager.release(key);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function gate(kind, opts = {}) {
    const ok = await waitForIdleWindow({
        idleCheckIntervalMs: opts.checkIntervalMs,
        maxIdleWaitMs: opts.maxWaitMs,
    });
    if (!ok) {
        logger.debug(`[Orchestrator] gate("${kind || 'unknown'}") 等待超时，继续执行`);
    }
}

async function withAdmission(kind, fn, opts = {}) {
    await gate(kind, opts);
    return fn();
}

async function performDbMaintenance() {
    const { dbRun } = require('../db/multi-db');
    const dbs = ['main', 'index', 'settings'];
    for (let i = 0; i < dbs.length; i += 1) {
        const db = dbs[i];
        try {
            if (i > 0) {
                await new Promise(r => setTimeout(r, DB_MAINT_DB_DELAY_STEP_MS * i));
            }
            await dbRun(db, 'PRAGMA wal_checkpoint(TRUNCATE)').catch(err => logger.debug(`操作失败: ${err.message}`));
            await dbRun(db, 'ANALYZE').catch(err => logger.debug(`操作失败: ${err.message}`));
            logger.debug(`[Orchestrator] 数据库维护 ${db} 完成`);
        } catch (error) {
            logger.debug(`[Orchestrator] 数据库维护 ${db} 失败: ${error && error.message}`);
        }
    }
}

function scheduleDbMaintenance() {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const intervalMs = Number(process.env.DB_MAINT_INTERVAL_MS || DAY_MS);
    const retryMs = Number(process.env.DB_MAINT_RETRY_MS || (6 * 60 * 60 * 1000));

    const enqueueMaintenance = () => {
        runWhenIdle(LOG_PREFIXES.DB_MAINTENANCE, performDbMaintenance, { startDelayMs: 0, retryIntervalMs: retryMs });
    };

    setTimeout(enqueueMaintenance, DB_MAINT_INITIAL_DELAY_MS);
    setInterval(enqueueMaintenance, intervalMs);
}

function start() {
    try {
        scheduleDbMaintenance();
    } catch (error) {
        logSoftIgnore('注册数据库维护定时器', error);
    }
    logger.silly('[Orchestrator] started');
}

module.exports = {
    start,
    isHeavy,
    runWhenIdle,
    gate,
    withAdmission,
};
