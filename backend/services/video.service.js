/**
 * 视频处理服务 - 手动补全 HLS（一次性会话）
 * 使用一次性 video worker：创建 -> 批量派发 -> 收敛完成 -> 终止
 */
const path = require('path');
const logger = require('../config/logger');
const { PHOTOS_DIR, THUMBS_DIR } = require('../config');
const { createDisposableWorker } = require('./worker.manager');

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
  const tasks = normalizePaths(paths).filter(p => /\.(mp4|webm|mov)$/i.test(p.abs));
  const total = tasks.length;
  if (total === 0) {
    return { total: 0, success: 0, failed: 0, skipped: 0 };
  }

  const timeoutMs = Math.max(10000, Number(opts.timeoutMs || process.env.HLS_BATCH_TIMEOUT_MS || 600000));
  return new Promise(async (resolve, reject) => {
    let settled = false;
    const worker = createDisposableWorker('video');
    const done = new Set();
    let success = 0, failed = 0, skipped = 0;
    let forceTerminated = false;

    const cleanup = async () => {
      try {
        // 先移除所有监听器，防止在终止过程中触发事件
        worker.removeAllListeners();

        // 优雅终止：给工作进程一些时间来自行清理
        if (!forceTerminated) {
          worker.terminate();
          // 等待最多2秒让进程优雅退出
          await new Promise(resolve => {
            const graceTimer = setTimeout(() => resolve(), 2000);
            worker.once('exit', () => {
              clearTimeout(graceTimer);
              resolve();
            });
          });
        }
      } catch (e) {
        // 忽略清理过程中的错误
      }
    };

    const tryFinish = () => {
      if (done.size >= total) {
        if (!settled) { settled = true; cleanup(); resolve({ total, success, failed, skipped }); }
      }
    };

    // 进程健康监控
    const healthCheckInterval = setInterval(() => {
      if (settled) {
        clearInterval(healthCheckInterval);
        return;
      }

      try {
        // 检查工作进程是否仍然活跃
        if (worker && typeof worker.kill === 'function') {
          // 发送心跳检查（可选，如果工作进程支持）
        }
      } catch (e) {
        // 忽略健康检查错误
      }
    }, 30000); // 每30秒检查一次

    // 收集结果
    worker.on('message', (result) => {
      try {
        if (!result || settled) return;

        // 处理worker关闭信号
        if (result.type === 'worker_shutdown') {
          console.log(`[VIDEO-SERVICE] Worker进程关闭信号: ${result.reason}`);
          if (!settled) {
            settled = true;
            cleanup().finally(() => {
              const remaining = total - done.size;
              resolve({ 
                total, 
                success, 
                failed: failed + remaining, 
                skipped, 
                workerShutdown: true,
                message: `Worker进程关闭 (${result.reason})，${remaining} 个任务被标记为失败` 
              });
            });
          }
          return;
        }

        const rel = result && result.task && result.task.relativePath
          ? result.task.relativePath
          : (result && result.path ? result.path : null);

        if (rel && !done.has(rel)) {
          done.add(rel);
          if (result.success === true) {
            success++;
          } else if (result.status === 'skipped_hls_exists' || result.status === 'skipped_permanent_failure') {
            skipped++;
          } else {
            failed++;
          }
        }
        tryFinish();
      } catch (e) {
        // 记录但不中断处理
        console.warn('[VIDEO-SERVICE] 结果解析失败:', e.message);
      }
    });

    worker.on('error', (err) => {
      console.error('[VIDEO-SERVICE] 工作进程错误:', err);
      if (!settled) {
        clearInterval(healthCheckInterval);
        settled = true;
        cleanup().finally(() => reject(err));
      }
    });

    worker.on('exit', (code) => {
      clearInterval(healthCheckInterval);

      if (settled) return;

      // 分析退出原因
      if (code === 0) {
        console.log('[VIDEO-SERVICE] 工作进程正常退出');
      } else {
        console.warn(`[VIDEO-SERVICE] 工作进程异常退出，代码: ${code}`);
      }

      // 如果任务未全部完成，按失败处理剩余任务
      if (done.size < total) {
        const remaining = total - done.size;
        failed += remaining;
        console.warn(`[VIDEO-SERVICE] ${remaining} 个任务因进程退出而失败`);
      }

      settled = true;
      resolve({ total, success, failed, skipped });
    });

    // 安全超时：防止意外卡住
    const timer = setTimeout(async () => {
      if (!settled) {
        console.warn(`[VIDEO-SERVICE] 批处理超时 (${timeoutMs}ms)，强制终止`);
        clearInterval(healthCheckInterval);
        forceTerminated = true; // 标记为强制终止

        settled = true;
        await cleanup();

        const remaining = total - done.size;
        resolve({
          total,
          success,
          failed: failed + remaining,
          skipped,
          timeout: true,
          message: `处理超时，${remaining} 个任务被标记为失败`
        });
      }
    }, timeoutMs);

    // 逐条派发任务
    try {
      for (const { abs, rel } of tasks) {
        worker.postMessage({
          filePath: abs,
          relativePath: rel,
          thumbsDir: THUMBS_DIR
        });
      }
    } catch (e) {
      console.error('[VIDEO-SERVICE] 任务派发失败:', e);
      clearTimeout(timer);
      clearInterval(healthCheckInterval);
      settled = true;
      await cleanup();
      reject(new Error(`任务派发失败: ${e.message}`));
      return;
    }
  });
}

module.exports = {
  runHlsBatch,
};