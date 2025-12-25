/**
 * 视频处理服务 - 手动补全 HLS（共享 Worker 按需唤醒）
 * 负责将批处理任务派发给按需启动的 video worker，并在任务完成后返回统计。
 */
const path = require('path');
const logger = require('../config/logger');
const { TraceManager } = require('../utils/trace');
const { normalizeWorkerMessage } = require('../utils/workerMessage');
const { PHOTOS_DIR, THUMBS_DIR, HLS_BATCH_TIMEOUT_MS } = require('../config');
const { startVideoWorker } = require('./worker.manager');
const state = require('./state.manager');
const HLS_INFLIGHT_TTL_MS = Math.max(60000, Number(process.env.HLS_INFLIGHT_TTL_MS || 30 * 60 * 1000));

// 防止重复排队的 HLS 任务（relative path -> timestamp）
const inFlightHls = new Map();

function pruneInFlight(now = Date.now()) {
  for (const [rel, ts] of inFlightHls.entries()) {
    if ((now - ts) > HLS_INFLIGHT_TTL_MS) {
      inFlightHls.delete(rel);
    }
  }
}

/**
 * 规范化输入路径为 { abs, rel }
 */
function normalizePaths(inputPaths) {
  const res = [];
  for (const p of inputPaths || []) {
    if (!p) continue;
    const abs = path.isAbsolute(p) ? p : path.join(PHOTOS_DIR, p);
    const rel = path.relative(PHOTOS_DIR, abs).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) continue;
    res.push({ abs, rel });
  }
  return res;
}

/**
 * 运行一次手动 HLS 批处理
 * @param {string[]} paths - 绝对或相对 PHOTOS_DIR 的视频路径数组（mp4/webm/mov）
 * @param {object} [opts] - 选项，如 { timeoutMs: 600000 }
 * @returns {Promise<{total:number, success:number, failed:number, skipped:number}>}
 */
async function runHlsBatch(paths, opts = {}) {
  const normalized = normalizePaths(paths).filter(p => /\.(mp4|webm|mov)$/i.test(p.abs));
  const uniqueTasks = [];
  const dedupe = new Set();
  for (const task of normalized) {
    if (!dedupe.has(task.rel)) {
      dedupe.add(task.rel);
      uniqueTasks.push(task);
    }
  }

  const now = Date.now();
  pruneInFlight(now);

  const scheduledTasks = [];
  let skippedInflight = 0;
  for (const task of uniqueTasks) {
    if (inFlightHls.has(task.rel)) {
      skippedInflight += 1;
      continue;
    }
    inFlightHls.set(task.rel, now);
    scheduledTasks.push(task);
  }

  const total = uniqueTasks.length;
  if (total === 0) {
    return { total: 0, success: 0, failed: 0, skipped: 0 };
  }

  if (scheduledTasks.length === 0) {
    return { total, success: 0, failed: 0, skipped: skippedInflight };
  }

  const releaseScheduled = () => {
    for (const task of scheduledTasks) {
      inFlightHls.delete(task.rel);
    }
  };

  let worker;
  try {
    worker = startVideoWorker();
  } catch (err) {
    releaseScheduled();
    throw err;
  }
  if (!worker) {
    releaseScheduled();
    throw new Error('无法启动视频处理线程');
  }

  const timeoutMs = Math.max(10000, Number(opts.timeoutMs || HLS_BATCH_TIMEOUT_MS));
  const pending = new Set(scheduledTasks.map(task => task.rel));
  let success = 0;
  let failed = 0;
  let skipped = skippedInflight;
  let timer = null;

  return new Promise((resolve, reject) => {
    let settled = false;
    const removeListener = typeof worker.off === 'function' ? worker.off.bind(worker) : worker.removeListener.bind(worker);

    const releaseInFlight = () => {
      // scheduledTasks 涵盖了所有本次排队的任务，pending 是其子集，无需重复遍历
      for (const task of scheduledTasks) {
        inFlightHls.delete(task.rel);
      }
    };

    const cleanup = () => {
      if (cleanup.__done) return;
      cleanup.__done = true;
      clearTimeout(timer);
      removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
      // 清理视频处理状态计数（确保所有退出路径都能正确减少）
      state.video.decrementActiveCount();
      releaseInFlight();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ total, success, failed, skipped });
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          if (worker && typeof worker.terminate === 'function') {
            worker.__expectedTermination = true;
            worker.terminate().catch(() => { });
          }
        } catch (_) { /* 忽略终止异常 */ }
        fail(new Error(`HLS 批处理超时或无进度 (${timeoutMs}ms)`));
      }, timeoutMs);
    };

    const onMessage = (rawMessage) => {
      if (settled) return;
      try {
        const message = normalizeWorkerMessage(rawMessage);
        const payload = message.payload || {};
        const eventType = payload.type || rawMessage?.type || message.kind;

        if (eventType === 'WORKER_IDLE') {
          return;
        }

        if (message.kind === 'log') {
          const level = (payload.level || 'debug').toLowerCase();
          const text = payload.message || payload.text || '';
          const fn = typeof logger[level] === 'function' ? level : 'debug';
          logger[fn](`[VIDEO-SERVICE][worker-log] ${text}`);
          return;
        }

        const rel = payload.task && payload.task.relativePath
          ? payload.task.relativePath
          : (payload.path ? payload.path : null);

        if (!rel || !pending.has(rel)) {
          return;
        }

        pending.delete(rel);
        if (message.kind === 'error') {
          failed += 1;
        } else if (payload.status === 'skipped_hls_exists' || payload.status === 'skipped_permanent_failure') {
          skipped += 1;
        } else if (payload.success === true) {
          success += 1;
        } else {
          failed += 1;
        }

        if (pending.size === 0) {
          finish();
        }

        // 只要收到进度/结果就重置超时，避免长批次被整体超时打断
        armTimeout();
      } catch (err) {
        logger.warn('[VIDEO-SERVICE] 处理worker消息失败:', err && err.message ? err.message : err);
      }
    };

    const onError = (err) => fail(err);

    const onExit = (code) => {
      if (pending.size === 0) {
        return;
      }
      fail(new Error(`视频处理线程提前退出 (code ${code})，剩余 ${pending.size} 个任务未完成`));
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);

    // 标记视频处理任务开始（与 cleanup 中的 decrementActiveCount 配对）
    state.video.incrementActiveCount();
    armTimeout();

    try {
      for (const { abs, rel } of scheduledTasks) {
        const message = TraceManager.injectToWorkerMessage({
          filePath: abs,
          relativePath: rel,
          thumbsDir: THUMBS_DIR
        });
        worker.postMessage(message);
      }
    } catch (error) {
      fail(new Error(`任务派发失败: ${error.message}`));
    }
  });
}

module.exports = {
  runHlsBatch,
};
