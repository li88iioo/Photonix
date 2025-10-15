/**
 * @file runtime.js
 * @description
 * 统一计算运行期参数（如并发数/批量大小/延迟等），支持环境变量覆盖。
 * 保持与 index.js 现有默认算法一致，无行为变更。
 */

const { detectHardwareConfig } = require('./hardware');

/**
 * 缓存运行时配置，避免重复计算
 * @type {object|null}
 */
let cachedRuntime = null;

/**
 * 推导并返回运行期配置参数
 * - 计算 NUM_WORKERS, SHARP_CONCURRENCY, 索引批量/延迟等核心并发参数
 * - 允许通过环境变量覆盖默认推荐值
 * @returns {{
 *   NUM_WORKERS: number,
 *   SHARP_CONCURRENCY: number,
 *   INDEX_CONCURRENCY: number,
 *   INDEX_BATCH_SIZE: number,
 *   VIDEO_TASK_DELAY_MS: number,
 *   VIDEO_MAX_CONCURRENCY: number,
 * }}
 */
function deriveRuntime() {
  // 已有缓存直接返回，避免重复运算
  if (cachedRuntime) {
    return cachedRuntime;
  }

  const { cpuCount, totalMemoryGB } = detectHardwareConfig();

  /**
   * NUM_WORKERS 计算逻辑（保持 index.js 算法一致，允许环境变量覆盖）
   * - 低配 (≤4核/4GB)：2~4 worker，比例0.5
   * - 中配 (≤8核/8GB)：3~6 worker，比例0.6
   * - 高配：4~12 worker，比例0.75
   */
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

  /**
   * SHARP_CONCURRENCY: Sharp 并发数
   * - 默认2，可用 SHARP_CONCURRENCY 环境变量调整
   */
  const SHARP_CONCURRENCY = Math.max(
    1,
    parseInt(process.env.SHARP_CONCURRENCY || '2', 10)
  );

  /**
   * INDEX_CONCURRENCY: 索引并发数（预留）
   * - 默认8，可通过环境变量INDEX_CONCURRENCY调整
   */
  const INDEX_CONCURRENCY = Math.max(
    1,
    parseInt(process.env.INDEX_CONCURRENCY || '8', 10)
  );

  /**
   * INDEX_BATCH_SIZE: 索引批处理单次任务量（预留）
   * - 默认1000条，可通过环境变量INDEX_BATCH_SIZE调整
   */
  const INDEX_BATCH_SIZE = Math.max(
    100,
    parseInt(process.env.INDEX_BATCH_SIZE || '1000', 10)
  );

  /**
   * VIDEO_TASK_DELAY_MS: 视频处理任务节流间隔（毫秒）
   * - 默认1000ms，可通过 VIDEO_TASK_DELAY_MS 覆盖
   */
  const VIDEO_TASK_DELAY_MS = Math.max(
    0,
    parseInt(process.env.VIDEO_TASK_DELAY_MS || '1000', 10)
  );

  /**
   * VIDEO_MAX_CONCURRENCY: 视频同时处理并发数
   * - 根据 CPU 核心数动态选择，支持环境变量覆盖
   *   ≤2核: 1, ≤4核: 2, 其他: 3，且不超过可用CPU
   */
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

  // 打包结果，写入缓存后返回
  const result = {
    NUM_WORKERS,
    SHARP_CONCURRENCY,
    INDEX_CONCURRENCY,
    INDEX_BATCH_SIZE,
    VIDEO_TASK_DELAY_MS,
    VIDEO_MAX_CONCURRENCY,
  };

  cachedRuntime = result;
  return result;
}

module.exports = { deriveRuntime };