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
   * NUM_WORKERS 智能计算逻辑（考虑 I/O 密集型任务特性）
   *
   * 策略：
   * - 缩略图生成是 I/O 密集型任务（读取图片、写入缩略图）
   * - CPU 在等待 I/O 时空闲，可以超配 worker 数量
   * - 超配系数：1.5-2.0（根据硬件规格调整）
   *
   * 计算公式：
   * - 基础值 = cpuCount * ioMultiplier
   * - 内存约束 = (totalMemoryGB - systemReserve) / workerMemoryGB
   * - 最终值 = min(基础值, 内存约束, 硬件上限)
   */
  let suggested;
  const totalMemoryMB = totalMemoryGB * 1024;

  // 系统预留（10%）+ Node.js 主进程（300MB）+ 其他服务（200MB）
  const systemReserveMB = Math.max(500, totalMemoryMB * 0.1 + 300 + 200);
  const availableMemoryMB = totalMemoryMB - systemReserveMB;

  // I/O 密集型超配系数
  let ioMultiplier;
  let workerMemoryMB;

  if (cpuCount <= 2 && totalMemoryGB <= 4) {
    // 低配：2核4GB，适度超配
    ioMultiplier = 1.5;  // 2核 → 3个worker
    workerMemoryMB = 256;  // 保守内存限制
  } else if (cpuCount <= 4 && totalMemoryGB <= 8) {
    // 中配：4核8GB，充分利用
    ioMultiplier = 1.5;  // 4核 → 6个worker
    workerMemoryMB = 384;
  } else if (cpuCount <= 8 && totalMemoryGB <= 16) {
    // 高配：8核16GB，激进超配
    ioMultiplier = 1.75;  // 8核 → 14个worker
    workerMemoryMB = 512;
  } else {
    // 超高配：16核+，最大化利用
    ioMultiplier = 2.0;
    workerMemoryMB = 768;
  }

  // 基于 CPU 的建议值（考虑 I/O 超配）
  const cpuBasedWorkers = Math.floor(cpuCount * ioMultiplier);

  // 基于内存的约束（确保每个 worker 有足够内存）
  const memoryBasedWorkers = Math.floor(availableMemoryMB / workerMemoryMB);

  // 取两者较小值，并限制在合理范围
  suggested = Math.max(2, Math.min(cpuBasedWorkers, memoryBasedWorkers, 16));

  const NUM_WORKERS = Math.max(
    1,
    parseInt(process.env.NUM_WORKERS || String(suggested), 10)
  );

  // 动态计算 WORKER_MEMORY_MB（如果用户未指定）
  const WORKER_MEMORY_MB = parseInt(
    process.env.WORKER_MEMORY_MB || String(Math.floor(availableMemoryMB / NUM_WORKERS)),
    10
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
    WORKER_MEMORY_MB,
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