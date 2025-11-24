/**
 * 全局工作负载编排器（轻量版，零配置）
 *
 * 主要功能：
 * 1. 统一重负载判断（isHeavy）：
 *    - 检查数据库索引状态
 *    - 检查 Redis 旗标
 *    - 检查资源预算（CPU、内存等）
 *    - 检查事件环延迟
 * 2. 空闲窗口执行一次性任务（runWhenIdle）：
 *    - 支持分布式锁
 *    - 支持超时守护
 * 3. 周期性采样、任务调度入口（start）
 * 4. 提供带闸门的函数封装（withAdmission）
 *
 * 里程碑：
 * - M1：仅提供 isHeavy 与 runWhenIdle，并整合分布式锁和负载判定，服务 adaptive/service 等调用方，去除重复判断逻辑。
 * - 后续：扩展 withAdmission()，支持缩略图/索引/HLS 的并发与速率限控等上层场景。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const { redis, isRedisAvailable } = require('../config/redis');
const { safeRedisIncr } = require('../utils/helpers');
const { DATA_DIR } = require('../config');
const fsp = fs.promises;
let loopTimer = null;
let lastLagMs = 0;

const localLocks = new Map();
const fileLocks = new Map();
let lockDirReady = false;
let lockDirPath = null;

// 软缓存 isHeavy 结果，降低观测负载
let __heavyCache = { at: 0, val: false };

const LOCK_STARTUP_MODE = (process.env.LOCK_FALLBACK_STRATEGY || 'warn').toLowerCase();
const INSTANCE_TOKEN = process.env.INSTANCE_TOKEN || process.env.HOSTNAME || process.pid.toString();
const MULTI_INSTANCE_ABORT = (process.env.LOCK_ABORT_ON_MULTI_INSTANCE || 'false').toLowerCase() === 'true';
const MULTI_INSTANCE_HINT = process.env.EXPECTED_INSTANCE_COUNT;
let __lockStartupWarned = false;

/**
 * 忽略非关键异常并记录底细（silently log soft errors）
 * @param {string} scope - 异常发生模块说明
 * @param {Error} error - 捕获到的异常对象
 */
function logSoftIgnore(scope, error) {
  if (!error) return;
  logger.silly(`[Orchestrator] ${scope} 忽略异常: ${error.message}`);
}

/**
 * 清理本地过期锁（localLocks）
 */
function cleanupLocalLocks() {
  const now = Date.now();
  for (const [key, expiresAt] of localLocks.entries()) {
    if (!expiresAt || expiresAt <= now) {
      localLocks.delete(key);
    }
  }
}

/**
 * 获取本地进程级锁
 * @param {string} key 锁名
 * @param {number} ttlMs 有效期（毫秒）
 * @returns {boolean} 是否获取成功
 */
function acquireLocalLock(key, ttlMs) {
  cleanupLocalLocks();
  const expiresAt = localLocks.get(key);
  if (expiresAt && expiresAt > Date.now()) {
    return false;
  }
  localLocks.set(key, Date.now() + ttlMs);
  return true;
}

/**
 * 释放本地锁
 * @param {string} key 
 */
function releaseLocalLock(key) {
  localLocks.delete(key);
}

/**
 * 锁标识标准化（只允许安全字符, 避免文件系统问题）
 * @param {string} key 
 * @returns {string}
 */
function normalizeLockKey(key) {
  return String(key || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 128) || 'lock';
}

/**
 * 确保锁目录存在，创建测试文件验证读写权限
 * @returns {Promise<string>} 锁目录绝对路径
 */
async function ensureLockDir() {
  if (lockDirReady && lockDirPath) return lockDirPath;
  try {
    lockDirPath = path.join(DATA_DIR, '.locks');
    await fsp.mkdir(lockDirPath, { recursive: true });
    const testFile = path.join(lockDirPath, `.rw-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.writeFile(testFile, INSTANCE_TOKEN, 'utf8');
    await fsp.unlink(testFile);
    lockDirReady = true;
    return lockDirPath;
  } catch (error) {
    const message = `[Orchestrator] 锁目录不可用，已退化为进程内锁: ${error && error.message}`;
    if (!__lockStartupWarned) {
      if (LOCK_STARTUP_MODE === 'error') {
        logger.error(message);
        throw error;
      }
      logger.warn(message);
      __lockStartupWarned = true;
    }
    lockDirReady = false;
    lockDirPath = null;
    throw error;
  }
}

/**
 * 文件级锁实现（多进程/容器本地互斥）
 * 优先 Redis 锁，Redis 不可用时采用
 * @param {string} key 锁名
 * @param {number} ttlMs 有效期（毫秒）
 * @returns {Promise<{ok: boolean, reason?: string, error?: Error}>}
 */
async function acquireFileLock(key, ttlMs) {
  try {
    const dir = await ensureLockDir();
    const safeKey = normalizeLockKey(key);
    const filePath = path.join(dir, `${safeKey}.lock`);

    // 写入锁信息（包含PID和时间戳）
    const lockInfo = JSON.stringify({
      pid: process.pid,
      timestamp: Date.now(),
      instance: INSTANCE_TOKEN,
      key: key
    });

    const handle = await fsp.open(filePath, 'wx');
    await handle.writeFile(lockInfo, 'utf8');

    const timer = setTimeout(() => {
      releaseFileLock(key).catch((err) => {
        if (err) {
          logger.debug(`[Orchestrator] 自动释放文件锁失败: ${err.message}`);
        }
      });
    }, ttlMs);
    if (typeof timer.unref === 'function') timer.unref();

    fileLocks.set(key, { filePath, handle, timer });
    return { ok: true };
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      // 锁文件已存在，检查是否为死锁
      const dir = lockDirPath;
      const safeKey = normalizeLockKey(key);
      const filePath = path.join(dir, `${safeKey}.lock`);

      try {
        const content = await fsp.readFile(filePath, 'utf8');
        const lockInfo = JSON.parse(content);
        const lockTs = Number(lockInfo.timestamp) || 0;
        const lockAge = Date.now() - lockTs;

        // 检查锁是否过期（超过TTL的2倍认为过期）
        if (lockAge > ttlMs * 2) {
          logger.warn(`[Orchestrator] 检测到过期锁文件: ${key}, age=${Math.round(lockAge / 1000)}s, 尝试清理`);

          // 检查进程是否还活着
          let processAlive = false;
          try {
            process.kill(lockInfo.pid, 0); // 0信号只检测进程是否存在
            processAlive = true;
          } catch (e) {
            // ESRCH: 进程不存在
            processAlive = false;
          }

          if (!processAlive) {
            logger.warn(`[Orchestrator] 锁对应的进程(PID=${lockInfo.pid})已不存在，清理死锁`);
            await fsp.unlink(filePath);
            // 递归重试获取锁
            return await acquireFileLock(key, ttlMs);
          } else {
            logger.warn(`[Orchestrator] 锁对应的进程(PID=${lockInfo.pid})仍在运行，但锁已过期，强制清理`);
            await fsp.unlink(filePath);
            return await acquireFileLock(key, ttlMs);
          }
        }
      } catch (parseError) {
        // 无法解析锁文件，可能是旧格式或损坏
        try {
          const stat = await fsp.stat(filePath);
          const age = Date.now() - stat.mtimeMs;
          if (age > ttlMs * 2) {
            logger.warn(`[Orchestrator] 锁文件损坏且过期 (${key}), age=${Math.round(age / 1000)}s，执行清理`);
            await fsp.unlink(filePath);
            return await acquireFileLock(key, ttlMs);
          }
        } catch (statErr) {
          logSoftIgnore('检测损坏锁文件年龄', statErr);
        }
        logger.debug(`[Orchestrator] 无法解析锁文件，保持锁存在状态: ${parseError.message}`);
      }

      return { ok: false, reason: 'exists' };
    }
    return { ok: false, reason: 'error', error };
  }
}

/**
 * 释放文件锁（带清理定时器及句柄）
 * @param {string} key
 */
async function releaseFileLock(key) {
  const entry = fileLocks.get(key);
  if (!entry) {
    const dir = lockDirPath;
    if (!dir) return;
    const fallbackPath = path.join(dir, `${normalizeLockKey(key)}.lock`);
    try {
      await fsp.unlink(fallbackPath);
    } catch (error) {
      logSoftIgnore('清理备用锁文件', error);
    }
    return;
  }

  fileLocks.delete(key);
  if (entry.timer) clearTimeout(entry.timer);
  try {
    await entry.handle.close();
  } catch (error) {
    logSoftIgnore('关闭锁文件句柄', error);
  }
  try {
    await fsp.unlink(entry.filePath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      logger.debug(`[Orchestrator] 删除锁文件失败: ${error.message}`);
    } else {
      logSoftIgnore('删除锁文件时文件缺失', error);
    }
  }
}
let __emptyBootstrap = null;
const HEAVY_CACHE_TTL_MS = Number(process.env.HEAVY_CACHE_TTL_MS || 3000);

/**
 * 事件环延迟采样（基于定时器周期性采集）
 * @param {number} intervalMs 采样周期(ms)
 */
function startEventLoopLagSampler(intervalMs = Number(process.env.EVENT_LOOP_SAMPLE_INTERVAL || 1000)) {
  if (loopTimer) return;
  let last = process.hrtime.bigint();
  loopTimer = setInterval(() => {
    const now = process.hrtime.bigint();
    const diffMs = Number(now - last) / 1e6; // 应接近 intervalMs
    lastLagMs = Math.max(0, diffMs - intervalMs);
    last = now;
  }, intervalMs);
}

/**
 * 统一重负载判断（可被缓存，含冷启动判定、索引相关等信息）
 * @returns {Promise<boolean>} 是否为“重负载”状态
 */
async function isHeavy() {
  const now = Date.now();
  if (now - __heavyCache.at <= HEAVY_CACHE_TTL_MS) return __heavyCache.val;

  // 0) 冷启动：首次无业务数据启动时自动视为不重负载
  try {
    if (__emptyBootstrap == null) {
      const ItemsRepository = require('../repositories/items.repo');
      const itemsRepo = new ItemsRepository();
      const count = await itemsRepo.count();
      __emptyBootstrap = count === 0;
    }
    if (__emptyBootstrap) {
      __heavyCache = { at: now, val: false };
      return false;
    }
  } catch (error) {
    logSoftIgnore('检测首启引导状态', error);
  }

  // 1) 索引流程状态检测（数据库+Redis双重）
  try {
    const idxRepo = require('../repositories/indexStatus.repo');
    const st = await idxRepo.getIndexStatus();
    if (st === 'building') return true;
    const resumeVal = await idxRepo.getResumeValue('last_processed_path');
    if (resumeVal) return true;
  } catch (error) {
    logSoftIgnore('读取索引状态', error);
  }
  try {
    const { redis } = require('../config/redis');
    const { safeRedisGet } = require('../utils/helpers');
    // Redis 旗标判断
    if (await safeRedisGet(redis, 'indexing_in_progress', '检查索引进行中') === '1') return true;
  } catch (error) {
    logSoftIgnore('查询Redis索引旗标', error);
  }

  // 2) 资源预算&事件环延迟阈值
  const { hasResourceBudget } = require('./adaptive.service');
  const { loadOk, memOk } = hasResourceBudget();
  if (!loadOk || !memOk) { __heavyCache = { at: now, val: true }; return true; }
  if (lastLagMs > 150) { __heavyCache = { at: now, val: true }; return true; } // 事件环延迟过高

  __heavyCache = { at: now, val: false };
  return false;
}

/**
 * 获取分布式锁，自动降级为文件锁/进程锁
 * @param {string} key 
 * @param {number} ttlSec 
 * @returns {Promise<boolean>}
 */
async function acquireLock(key, ttlSec) {
  const ttlMs = Math.max(1000, Number(ttlSec || 0) * 1000);
  try {
    if (isRedisAvailable()) {
      const { safeRedisSet } = require('../utils/helpers');
      const res = await safeRedisSet(redis, key, '1', 'EX', ttlSec, '编排器锁获取', 'NX');
      if (res) {
        logger.silly(`[Orchestrator] Redis锁获取成功: ${key}`);
        return true;
      }
      return false;
    }
  } catch (err) {
    logger.debug(`[Orchestrator] acquireLock fallback for ${key}: ${err && err.message}`);
  }

  const fileLock = await acquireFileLock(key, ttlMs);
  if (fileLock.ok) {
    acquireLocalLock(key, ttlMs);
    logger.debug(`[Orchestrator] 使用文件锁获取成功: ${key}`);
    return true;
  }

  if (fileLock.reason === 'error') {
    if (fileLock.error) {
      logger.debug(`[Orchestrator] 文件锁退化为进程内锁: ${fileLock.error.message}`);
    }
    return acquireLocalLock(key, ttlMs);
  }

  logger.silly(`[Orchestrator] 文件锁存在，获取失败: ${key}`);
  return false;
}

/**
 * 释放分布式锁（Redis、文件锁、进程锁皆尝试）
 * @param {string} key 
 */
async function releaseLock(key) {
  try {
    if (isRedisAvailable()) {
      const { safeRedisDel } = require('../utils/helpers');
      await safeRedisDel(redis, key, '编排器锁释放');
      logger.silly(`[Orchestrator] Redis锁释放成功: ${key}`);
    }
  } catch (err) {
    logger.debug(`[Orchestrator] releaseLock fallback for ${key}: ${err && err.message}`);
  } finally {
    await releaseFileLock(key);
    releaseLocalLock(key);
  }
}

/**
 * 批量释放分布式锁
 * @param {string[]} keys 
 */
async function releaseLocks(keys) {
  for (const key of keys || []) {
    if (key) {
      await releaseLock(key);
    }
  }
}

/**
 * 设置任务超时保护（定时自动释放锁，避免挂死）
 * @param {string} jobName 
 * @param {string[]} lockKeys 
 * @param {number} timeoutMs 
 * @returns {{finalize:function():Promise<void>}}
 */
function setupTaskTimeout(jobName, lockKeys, timeoutMs) {
  const keys = Array.isArray(lockKeys) ? lockKeys.filter(Boolean) : [];
  let finished = false;

  const timer = setTimeout(async () => {
    if (!finished) {
      finished = true;
      logger.warn(`[Orchestrator] Job "${jobName}" timeout, cancelling`);
      await releaseLocks(keys);
    }
  }, timeoutMs);

  return {
    async finalize() {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        await releaseLocks(keys);
      }
    }
  };
}

/**
 * 实际调度逻辑（尝试获取锁、判断重负载、包裹超时回收）
 * @private
 */
async function tryAcquireAndExecute(jobName, fn, lockKey, lockTtlSec, timeoutMs, retryIntervalMs, schedule, categoryKey) {
  const activeLocks = [];
  try {
    if (await isHeavy()) {
      return schedule(retryIntervalMs);
    }

    if (categoryKey) {
      const categoryOk = await acquireLock(categoryKey, lockTtlSec);
      if (!categoryOk) {
        return schedule(retryIntervalMs);
      }
      activeLocks.push(categoryKey);
    }

    const jobOk = await acquireLock(lockKey, lockTtlSec);
    if (!jobOk) {
      await releaseLocks(activeLocks);
      return schedule(retryIntervalMs);
    }
    activeLocks.push(lockKey);

    const timeoutHandler = setupTaskTimeout(jobName, activeLocks, timeoutMs);

    try {
      await fn();
    } catch (e) {
      logger.debug(`[Orchestrator] Job "${jobName}" failed (ignored): ${e && e.message}`);
    } finally {
      await timeoutHandler.finalize();
    }
  } catch (e) {
    logger.debug(`[Orchestrator] runWhenIdle("${jobName}") error (ignored): ${e && e.message}`);
    await releaseLocks(activeLocks);
    schedule(retryIntervalMs);
  }
}

/**
 * 创建单次任务/调度器，支持分布式锁与延迟重试
 */
function createScheduler(jobName, fn, retryIntervalMs, opts = {}) {
  const schedule = (ms) => setTimeout(tick, ms);
  const categoryKey = opts.category ? `orchestrator:category:${opts.category}:lock` : null;

  const tick = () => tryAcquireAndExecute(
    jobName,
    fn,
    `orchestrator:job:${jobName}:lock`,
    Number(opts.lockTtlSec || (2 * 60 * 60)),
    Number(opts.timeoutMs || (20 * 60 * 1000)),
    retryIntervalMs,
    schedule,
    categoryKey
  );

  return { schedule, tick };
}

/**
 * 空闲窗口执行一次性任务（分布式锁，重负载避让，失败自动重试）
 * @param {string} jobName 任务名称
 * @param {function():Promise<any>} fn 任务主体
 * @param {object} opts 调度选项
 */
async function runWhenIdle(jobName, fn, opts = {}) {
  const startDelayMs = Number(opts.startDelayMs || 8000);
  const retryIntervalMs = Number(opts.retryIntervalMs || 30000);

  const { schedule, tick } = createScheduler(jobName, fn, retryIntervalMs, opts);

  // 启动调度入口（延迟启动）
  schedule(startDelayMs);
}

/**
 * 轻量级 Sleep
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 闸门函数：重负载时等待，恢复后放行（带最长等待防饿死）
 * @param {string} kind - 任务类型说明
 * @param {object} opts - 选项
 * @returns {Promise<void>}
 */
async function gate(kind, opts = {}) {
  const checkIntervalMs = Number(opts.checkIntervalMs || 1500);
  const maxWaitMs = Number(opts.maxWaitMs || (5 * 60 * 1000)); // 最长等待5分钟，防止饿死
  let waited = 0;
  while (await isHeavy()) {
    await sleep(checkIntervalMs);
    waited += checkIntervalMs;
    if (waited >= maxWaitMs) break;
  }
}

/**
 * 包装函数：重负载时自动让路（带闸门机制）
 * @param {string} kind 
 * @param {function():Promise<any>} fn 
 * @param {object} opts 
 * @returns {Promise<any>}
 */
async function withAdmission(kind, fn, opts = {}) {
  await gate(kind, opts);
  return fn();
}

/**
 * 启动编排器（初始化事件环采样，预注册数据库维护任务等）
 * start 只需调用一次
 */
function start() {
  startEventLoopLagSampler();
  try { scheduleDbMaintenance(); }
  catch (error) {
    logSoftIgnore('启动数据库维护调度', error);
  }
  if (!isRedisAvailable()) {
    try {
      ensureLockDir().catch((error) => logSoftIgnore('预创建锁目录', error));
      if (MULTI_INSTANCE_ABORT && MULTI_INSTANCE_HINT && Number(MULTI_INSTANCE_HINT) > 1) {
        logger.error('[Orchestrator] 当前未启用 Redis，且检测到 EXPECTED_INSTANCE_COUNT>1，已根据配置拒绝启动。');
        const { ConfigurationError } = require('../utils/errors');
        throw new ConfigurationError('多实例模式需要Redis支持', {
          errorCode: 'MULTI_INSTANCE_WITHOUT_REDIS',
          instanceCount: Number(MULTI_INSTANCE_HINT),
          redisEnabled: false
        });
      }
      if (MULTI_INSTANCE_HINT && Number(MULTI_INSTANCE_HINT) > 1) {
        logger.warn('[Orchestrator] Redis 未启用，但 EXPECTED_INSTANCE_COUNT>1，锁将退化为文件/进程级，可能导致重复执行。建议启用 Redis 或设置 LOCK_ABORT_ON_MULTI_INSTANCE=true');
      }
    } catch (lockError) {
      if (LOCK_STARTUP_MODE === 'error') {
        throw lockError;
      }
    }
  }
  logger.silly('[Orchestrator] started (lightweight mode)');
}

/**
 * 数据库维护任务（循环执行主要库的检查点及分析）
 */
async function performDbMaintenance() {
  const { dbRun } = require('../db/multi-db');
  const startAll = Date.now();
  const dbs = ['main', 'index', 'settings'];

  for (let i = 0; i < dbs.length; i++) {
    const db = dbs[i];
    const start = Date.now();
    try {
      // 错峰执行，避免同时触发 I/O 峰值
      if (i > 0) await new Promise(r => setTimeout(r, 500 * i));
      try { await dbRun(db, "PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) { logger.debug(`操作失败: ${e.message}`); }
      try { await dbRun(db, "ANALYZE"); } catch (e) { logger.debug(`操作失败: ${e.message}`); }
      const elapsed = Date.now() - start;
      logger.debug(`[调度器] 数据库维护 ${db} 完成，耗时 ${elapsed}ms`);
      await safeRedisIncr(redis, `metrics:db_maint:success:${db}`, '数据库维护成功指标');
    } catch (e) {
      logger.debug(`[调度器] 数据库维护 ${db} 失败: ${e && e.message}`);
      await safeRedisIncr(redis, `metrics:db_maint:fail:${db}`, '数据库维护失败指标');
    }
  }
  logger.debug(`[调度器] 数据库维护总耗时 ${Date.now() - startAll}ms`);
}

/**
 * 定时注册数据库维护任务（runWhenIdle形式，带重试、周期性触发等参数）
 */
function scheduleDbMaintenance() {
  try {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const intervalMs = Number(process.env.DB_MAINT_INTERVAL_MS || DAY_MS);
    const retryMs = Number(process.env.DB_MAINT_RETRY_MS || (6 * 60 * 60 * 1000));
    const timeoutMs = Number(process.env.DB_MAINT_TIMEOUT_MS || (10 * 60 * 1000));

    setTimeout(() => {
      runWhenIdle('db-maintenance', performDbMaintenance, { startDelayMs: 0, retryIntervalMs: retryMs, timeoutMs, lockTtlSec: Math.ceil(timeoutMs / 1000), category: 'index-maintenance' });
    }, 30000);

    setInterval(() => {
      runWhenIdle('db-maintenance', performDbMaintenance, { startDelayMs: 0, retryIntervalMs: retryMs, timeoutMs, lockTtlSec: Math.ceil(timeoutMs / 1000), category: 'index-maintenance' });
    }, intervalMs);
  } catch (error) {
    logSoftIgnore('注册数据库维护定时器', error);
  }
}

module.exports = {
  start,
  isHeavy,
  runWhenIdle,
  gate,
  withAdmission,
};