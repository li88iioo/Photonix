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

let loopTimer = null;
let lastLagMs = 0;
let __heavyCache = { at: 0, val: false };
const localLocks = new Map();
const HEAVY_CACHE_TTL_MS = Number(process.env.HEAVY_CACHE_TTL_MS || 3000);

function logSoftIgnore(scope, error) {
    if (!error) return;
    logger.silly(`[Orchestrator] ${scope} 忽略异常: ${error.message}`);
}

function startEventLoopLagSampler(intervalMs = Number(process.env.EVENT_LOOP_SAMPLE_INTERVAL || 1000)) {
    if (loopTimer) return;
    let last = process.hrtime.bigint();
    loopTimer = setInterval(() => {
        const now = process.hrtime.bigint();
        const diffMs = Number(now - last) / 1e6;
        lastLagMs = Math.max(0, diffMs - intervalMs);
        last = now;
    }, intervalMs);
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
    if (!loadOk || !memOk || lastLagMs > 150) {
        __heavyCache = { at: now, val: true };
        return true;
    }

    __heavyCache = { at: now, val: false };
    return false;
}

async function runWhenIdle(jobName, fn, opts = {}) {
    const startDelayMs = Number(opts.startDelayMs || 8000);
    const retryIntervalMs = Number(opts.retryIntervalMs || 30000);
    const lockTtlSec = Number(opts.lockTtlSec || 7200); // 默认2小时锁
    const lockKey = `lock:job:${jobName}`;

    // 初始延迟
    await sleep(startDelayMs);

    const execute = async () => {
        // 1. 检查系统负载
        if (await isHeavy()) {
            logger.debug(`[Orchestrator] 系统负载高，推迟任务 "${jobName}"`);
            setTimeout(execute, retryIntervalMs);
            return;
        }

        // 2. 尝试获取锁（Redis 或 本地）
        let locked = false;
        try {
            if (redis && redis.status === 'ready') {
                // NX: 仅当键不存在时设置; EX: 过期时间
                locked = await safeRedisSet(
                    redis,
                    lockKey,
                    'LOCKED',
                    'EX',
                    lockTtlSec,
                    `获取任务锁 ${jobName}`,
                    'NX'
                );
            } else {
                // 降级：无Redis时的简单内存锁（仅限单实例）
                locked = acquireLocalLock(lockKey, lockTtlSec * 1000);
            }
        } catch (e) {
            logger.warn(`[Orchestrator] 获取锁失败 "${jobName}": ${e.message}`);
            // 锁获取出错时，安全起见推迟执行
            setTimeout(execute, retryIntervalMs);
            return;
        }

        if (!locked) {
            logger.debug(`[Orchestrator] 任务 "${jobName}" 已在运行中（未获取到锁），跳过本次执行`);
            setTimeout(execute, retryIntervalMs);
            return;
        }

        // 3. 执行任务
        try {
            logger.info(`[Orchestrator] 开始执行任务 "${jobName}"`);
            await fn();
        } catch (error) {
            logger.error(`[Orchestrator] Job "${jobName}" 执行失败: ${error && error.message}`);
            setTimeout(execute, retryIntervalMs);
        } finally {
            // 4. 释放锁
            try {
                if (redis && redis.status === 'ready') {
                    await safeRedisDel(redis, lockKey, `释放任务锁 ${jobName}`);
                } else {
                    releaseLocalLock(lockKey);
                }
            } catch (e) {
                logger.warn(`[Orchestrator] 释放锁失败 "${jobName}": ${e.message}`);
            }
        }
    };

    // 启动执行循环
    execute();
}

function acquireLocalLock(key, ttlMs) {
    const now = Date.now();
    const expiresAt = localLocks.get(key);
    if (expiresAt && expiresAt > now) {
        return false;
    }
    localLocks.set(key, now + ttlMs);
    return true;
}

function releaseLocalLock(key) {
    localLocks.delete(key);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function gate(kind, opts = {}) {
    const checkIntervalMs = Number(opts.checkIntervalMs || 1500);
    const maxWaitMs = Number(opts.maxWaitMs || (5 * 60 * 1000));
    let waited = 0;
    while (await isHeavy()) {
        await sleep(checkIntervalMs);
        waited += checkIntervalMs;
        if (waited >= maxWaitMs) break;
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
                await new Promise(r => setTimeout(r, 500 * i));
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

    setTimeout(enqueueMaintenance, 30000);
    setInterval(enqueueMaintenance, intervalMs);
}

function start() {
    startEventLoopLagSampler();
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
