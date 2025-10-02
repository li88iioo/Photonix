/**
 * runtime.js
 * 统一计算运行期参数（并发/批量/延迟等），支持环境变量覆盖。
 * 与现有 index.js 的默认计算保持一致（零行为变更）。
 */
const { detectHardwareConfig } = require('./hardware');

function deriveRuntime() {
  const { cpuCount, totalMemoryGB } = detectHardwareConfig();

  // 按现有 index.js 的算法计算 NUM_WORKERS（零行为变更）
  let suggested;
  if (cpuCount <= 4 || totalMemoryGB <= 4) {
    suggested = Math.max(2, Math.min(4, Math.floor(cpuCount * 0.5)));
  } else if (cpuCount <= 8 || totalMemoryGB <= 8) {
    suggested = Math.max(3, Math.min(6, Math.floor(cpuCount * 0.6)));
  } else {
    suggested = Math.max(4, Math.min(12, Math.floor(cpuCount * 0.75)));
  }
  const NUM_WORKERS = Math.max(
    1,
    parseInt(process.env.NUM_WORKERS || String(suggested), 10)
  );

  // Sharp 并发：保持与 index.js 默认一致（默认2），支持 env 覆盖
  const SHARP_CONCURRENCY = Math.max(
    1,
    parseInt(process.env.SHARP_CONCURRENCY || '2', 10)
  );

  // 索引并发/批量（预留，当前未在 index.js 使用）
  const INDEX_CONCURRENCY = Math.max(
    1,
    parseInt(process.env.INDEX_CONCURRENCY || '8', 10)
  );

  const INDEX_BATCH_SIZE = Math.max(
    100,
    parseInt(process.env.INDEX_BATCH_SIZE || '1000', 10)
  );

  // 视频任务间隔：保持与 index.js 默认一致（默认1000ms）
  const VIDEO_TASK_DELAY_MS = Math.max(
    0,
    parseInt(process.env.VIDEO_TASK_DELAY_MS || '1000', 10)
  );

  const defaultVideoConcurrency = (() => {
    if (cpuCount <= 2) return 1;
    if (cpuCount <= 4) return 2;
    return 3;
  })();
  const requestedVideoConcurrency = parseInt(
    process.env.VIDEO_MAX_CONCURRENCY || String(defaultVideoConcurrency),
    10
  );
  const VIDEO_MAX_CONCURRENCY = Math.max(
    1,
    Math.min(requestedVideoConcurrency || defaultVideoConcurrency, cpuCount)
  );

  return {
    NUM_WORKERS,
    SHARP_CONCURRENCY,
    INDEX_CONCURRENCY,
    INDEX_BATCH_SIZE,
    VIDEO_TASK_DELAY_MS,
    VIDEO_MAX_CONCURRENCY,
  };
}

module.exports = { deriveRuntime };