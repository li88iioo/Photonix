/**
 * 全局工作负载编排器（轻量版，零配置）
 * - 统一重负载判断：DB 索引状态 + Redis 旗标 + 资源预算 + 事件环延迟
 * - 提供 start() 周期采样、isHeavy() 即时查询
 * - 提供 runWhenIdle(jobName, fn, opts)：空闲窗口执行一次性任务（分布式锁，超时守护）
 *
 * 里程碑1：仅提供 isHeavy 与 runWhenIdle，先让 adaptive/service 等处复用，去掉重复判断
 * 后续里程碑：withAdmission() 封装缩略图/索引/HLS 的并发与速率控制
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const { redis, isRedisAvailable } = require('../config/redis');
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

function cleanupLocalLocks() {
  const now = Date.now();
  for (const [key, expiresAt] of localLocks.entries()) {
    if (!expiresAt || expiresAt <= now) {
      localLocks.delete(key);
    }
  }
}

function acquireLocalLock(key, ttlMs) {
  cleanupLocalLocks();
  const expiresAt = localLocks.get(key);
  if (expiresAt && expiresAt > Date.now()) {
    return false;
  }
  localLocks.set(key, Date.now() + ttlMs);
  return true;
}

function releaseLocalLock(key) {
  localLocks.delete(key);
}

function normalizeLockKey(key) {
  return String(key || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 128) || 'lock';
}

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

async function acquireFileLock(key, ttlMs) {
  try {
    const dir = await ensureLockDir();
    const safeKey = normalizeLockKey(key);
    const filePath = path.join(dir, `${safeKey}.lock`);
    const handle = await fsp.open(filePath, 'wx');
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
      return { ok: false, reason: 'exists' };
    }
    return { ok: false, reason: 'error', error };
  }
}

async function releaseFileLock(key) {
  const entry = fileLocks.get(key);
  if (!entry) {
    const dir = lockDirPath;
    if (!dir) return;
    const fallbackPath = path.join(dir, `${normalizeLockKey(key)}.lock`);
    try {
      await fsp.unlink(fallbackPath);
    } catch {}
    return;
  }

  fileLocks.delete(key);
  if (entry.timer) clearTimeout(entry.timer);
  try {
    await entry.handle.close();
  } catch {}
  try {
    await fsp.unlink(entry.filePath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      logger.debug(`[Orchestrator] 删除锁文件失败: ${error.message}`);
    }
  }
}
let __emptyBootstrap = null;
const HEAVY_CACHE_TTL_MS = Number(process.env.HEAVY_CACHE_TTL_MS || 3000);

// 事件环延迟（粗略）采样
function startEventLoopLagSampler(intervalMs = Number(process.env.EVENT_LOOP_SAMPLE_INTERVAL || 1000)) {
  if (loopTimer) return;
  let last = process.hrtime.bigint();
  loopTimer = setInterval(() => {
    const now = process.hrtime.bigint();
    const diffMs = Number(now - last) / 1e6; // 理论应≈intervalMs
    lastLagMs = Math.max(0, diffMs - intervalMs);
    last = now;
  }, intervalMs);
}

// 使用自适应服务的资源预算函数，避免重复代码

// 统一重负载判断
async function isHeavy() {
  const now = Date.now();
  if (now - __heavyCache.at <= HEAVY_CACHE_TTL_MS) return __heavyCache.val;

  // 0) 冷启动快速通道：首次评估后缓存结果，避免重复扫描
  try {
    if (__emptyBootstrap == null) {
      const { dbAll } = require('../db/multi-db');
      const rows = await dbAll('main', "SELECT COUNT(*) AS c FROM items");
      __emptyBootstrap = rows && rows[0] ? Number(rows[0].c) === 0 : false;
    }
    if (__emptyBootstrap) {
      __heavyCache = { at: now, val: false };
      return false;
    }
  } catch {}

  // 1) 索引状态（DB + Redis 旗标）
  try {
    const idxRepo = require('../repositories/indexStatus.repo');
    const st = await idxRepo.getIndexStatus();
    if (st === 'building') return true;
    const resumeVal = await idxRepo.getResumeValue('last_processed_path');
    if (resumeVal) return true;
  } catch {}
  try {
    const { redis } = require('../config/redis');
    if (await redis.get('indexing_in_progress') === '1') return true;
  } catch {}

  // 2) 资源与事件环延迟阈值
  const { hasResourceBudget } = require('./adaptive.service');
  const { loadOk, memOk } = hasResourceBudget();
  if (!loadOk || !memOk) { __heavyCache = { at: now, val: true }; return true; }
  if (lastLagMs > 150) { __heavyCache = { at: now, val: true }; return true; } // 事件环延迟过高

  __heavyCache = { at: now, val: false };
  return false;
}

async function acquireLock(key, ttlSec) {
  const ttlMs = Math.max(1000, Number(ttlSec || 0) * 1000);
  try {
    if (isRedisAvailable()) {
      const res = await redis.set(key, '1', 'EX', ttlSec, 'NX');
      if (res === 'OK') {
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

async function releaseLock(key) {
  try {
    if (isRedisAvailable()) {
      await redis.del(key);
      logger.silly(`[Orchestrator] Redis锁释放成功: ${key}`);
    }
  } catch (err) {
    logger.debug(`[Orchestrator] releaseLock fallback for ${key}: ${err && err.message}`);
  } finally {
  await releaseFileLock(key);
    releaseLocalLock(key);
  }
}

async function releaseLocks(keys) {
  for (const key of keys || []) {
    if (key) {
      await releaseLock(key);
    }
  }
}

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
      logger.warn(`[Orchestrator] Job "${jobName}" failed (ignored): ${e && e.message}`);
    } finally {
      await timeoutHandler.finalize();
    }
  } catch (e) {
    logger.debug(`[Orchestrator] runWhenIdle("${jobName}") error (ignored): ${e && e.message}`);
    await releaseLocks(activeLocks);
    schedule(retryIntervalMs);
  }
}

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

// 空闲窗口执行一次性任务
async function runWhenIdle(jobName, fn, opts = {}) {
  const startDelayMs = Number(opts.startDelayMs || 8000);
  const retryIntervalMs = Number(opts.retryIntervalMs || 30000);

  const { schedule, tick } = createScheduler(jobName, fn, retryIntervalMs, opts);

  // 启动调度
  schedule(startDelayMs);
}

 // 轻量睡眠
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 闸门：重负载时让路，直到恢复或达到最大等待
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

// 封装：带闸门执行
async function withAdmission(kind, fn, opts = {}) {
  await gate(kind, opts);
  return fn();
}

// 启动编排器（目前只启动事件环采样，可逐步扩展）
function start() {
  startEventLoopLagSampler();
  try { scheduleDbMaintenance(); } catch {}
  if (!isRedisAvailable()) {
    try {
      ensureLockDir().catch(() => {});
      if (MULTI_INSTANCE_ABORT && MULTI_INSTANCE_HINT && Number(MULTI_INSTANCE_HINT) > 1) {
        logger.error('[Orchestrator] 当前未启用 Redis，且检测到 EXPECTED_INSTANCE_COUNT>1，已根据配置拒绝启动。');
        throw new Error('MULTI_INSTANCE_WITHOUT_REDIS');
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

async function performDbMaintenance() {
  const { dbRun } = require('../db/multi-db');
  const startAll = Date.now();
  const dbs = ['main', 'index', 'settings', 'history'];

  for (let i = 0; i < dbs.length; i++) {
    const db = dbs[i];
    const start = Date.now();
    try {
      // 错峰执行，避免同时触发 I/O 峰值
      if (i > 0) await new Promise(r => setTimeout(r, 500 * i));
      try { await dbRun(db, "PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
      try { await dbRun(db, "ANALYZE"); } catch {}
      const elapsed = Date.now() - start;
      logger.debug(`[Orchestrator] DB maintenance ${db} done in ${elapsed}ms`);
      try { const { redis } = require('../config/redis'); await redis.incr(`metrics:db_maint:success:${db}`).catch(()=>{}); } catch {}
    } catch (e) {
      logger.warn(`[Orchestrator] DB maintenance ${db} failed: ${e && e.message}`);
      try { const { redis } = require('../config/redis'); await redis.incr(`metrics:db_maint:fail:${db}`).catch(()=>{}); } catch {}
    }
  }
  logger.debug(`[Orchestrator] DB maintenance total ${Date.now() - startAll}ms`);
}

function scheduleDbMaintenance() {
  try {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const intervalMs = Number(process.env.DB_MAINT_INTERVAL_MS || DAY_MS);
    const retryMs = Number(process.env.DB_MAINT_RETRY_MS || (6 * 60 * 60 * 1000));
    const timeoutMs = Number(process.env.DB_MAINT_TIMEOUT_MS || (10 * 60 * 1000));

    setTimeout(() => {
      runWhenIdle('db-maintenance', performDbMaintenance, { startDelayMs: 0, retryIntervalMs: retryMs, timeoutMs, lockTtlSec: Math.ceil(timeoutMs/1000), category: 'index-maintenance' });
    }, 30000);

    setInterval(() => {
      runWhenIdle('db-maintenance', performDbMaintenance, { startDelayMs: 0, retryIntervalMs: retryMs, timeoutMs, lockTtlSec: Math.ceil(timeoutMs/1000), category: 'index-maintenance' });
    }, intervalMs);
  } catch {}
}

module.exports = {
  start,
  isHeavy,
  runWhenIdle,
  gate,
  withAdmission,
};