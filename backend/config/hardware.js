/**
 * @file hardware.js
 * @description
 *  统一硬件探测工具：
 *   - 优先读取环境变量（DETECTED_CPU_COUNT, DETECTED_MEMORY_GB）
 *   - 其次尝试系统探测（os.cpus、os.totalmem）
 *   - 最终钳制（最小值为1）
 *   - 返回结构兼容 detectHardwareConfig 旧格式:
 *     { cpuCount, totalMemoryGB, isDocker, isLXC }
 */

const os = require('os');
const fs = require('fs');
const baseLogger = require('./logger');
const { LOG_PREFIXES, formatLog } = baseLogger;
const logger = baseLogger;

/**
 * 将输入规范化为大于等于 min 的整数，否则返回 undefined
 * @param {*} v - 要转化的值
 * @param {number} min - 最小值，默认为 1
 * @returns {number|undefined}
 */
function normalizeInt(v, min = 1) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min ? n : undefined;
}

/**
 * 读取指定路径文件的整型值
 * @param {string} filePath - 文件路径
 * @returns {number|undefined}
 */
function readIntFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  } catch (error) {
    logger.debug(
      formatLog(LOG_PREFIXES.HARDWARE, `读取 ${filePath} 失败`),
      { error: error.message }
    );
    return undefined;
  }
}

/**
 * 应用 cgroup 的 CPU/内存限制（仅容器环境）
 * @param {number} cpuCount
 * @param {number} totalMemoryGB
 * @returns {{cpuCount: number, totalMemoryGB: number}}
 */
function applyCgroupLimits(cpuCount, totalMemoryGB) {
  let adjustedCpu = cpuCount;
  let adjustedMem = totalMemoryGB;

  const quota = readIntFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
  const period = readIntFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  if (quota !== undefined && period && quota > 0 && period > 0) {
    const limit = Math.ceil(quota / period);
    if (limit > 0 && limit < adjustedCpu) {
      logger.info(
        formatLog(LOG_PREFIXES.HARDWARE, `应用 cgroup CPU 限制: ${limit}`)
      );
      adjustedCpu = limit;
    }
  }

  const memLimitBytes = readIntFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (memLimitBytes && memLimitBytes > 0) {
    const limitGb = Math.floor(memLimitBytes / (1024 * 1024 * 1024));
    if (limitGb > 0 && limitGb < adjustedMem) {
      logger.info(
        formatLog(LOG_PREFIXES.HARDWARE, `应用 cgroup 内存限制: ${limitGb}GB`)
      );
      adjustedMem = limitGb;
    }
  }

  return { cpuCount: adjustedCpu, totalMemoryGB: adjustedMem };
}

/**
 * 缓存硬件检测结果，避免每进程/线程重复检测
 * @type {{cpuCount: number, totalMemoryGB: number, isDocker: boolean, isLXC: boolean}|null}
 */
let cachedHardwareConfig = null;

/**
 * 自动检测并返回主要硬件参数
 * 检测优先级：
 *   1. 环境变量
 *   2. 系统探测
 *   3. cgroup 容器限制
 *   4. 钳制 >=1
 * @returns {{cpuCount: number, totalMemoryGB: number, isDocker: boolean, isLXC: boolean}}
 */
function detectHardwareConfig() {
  // 已缓存即直接返回，无需重复检测
  if (cachedHardwareConfig) {
    return cachedHardwareConfig;
  }

  // 1. 优先：外部环境变量标定（容器/虚拟化推荐）
  let cpuFromEnv = normalizeInt(process.env.DETECTED_CPU_COUNT, 1);
  let memFromEnv = normalizeInt(process.env.DETECTED_MEMORY_GB, 1);

  // 2. 其次：系统自动探测
  let cpuFromSys, memGbFromSys;
  try {
    cpuFromSys = normalizeInt(
      (os.cpus && os.cpus().length) || 0,
      1
    );
  } catch (error) {
    logger.warn(
      formatLog(LOG_PREFIXES.HARDWARE, 'CPU检测失败'),
      { error: error.message }
    );
  }
  try {
    memGbFromSys = normalizeInt(
      (os.totalmem && (os.totalmem() / (1024 * 1024 * 1024))) || 0,
      1
    );
  } catch (error) {
    logger.warn(
      formatLog(LOG_PREFIXES.HARDWARE, '内存检测失败'),
      { error: error.message }
    );
  }

  // 3. 选择优先级：环境 -> 系统 -> 默认值
  let cpuCount = cpuFromEnv || cpuFromSys || 1;
  let totalMemoryGB = memFromEnv || memGbFromSys || 1;

  /**
   * Docker/LXC 检测（保持与旧版返回结构兼容）
   * isDocker: 是否为 Docker 环境
   * isLXC:    是否为 LXC 容器环境
   */
  const isDocker = (() => {
    try {
      return fs.existsSync('/.dockerenv');
    } catch (error) {
      logger.debug(
        formatLog(LOG_PREFIXES.HARDWARE, 'Docker检测失败'),
        { error: error.message }
      );
      return false;
    }
  })();
  const isLXC = (() => {
    try {
      return (
        fs.existsSync('/proc/1/environ') &&
        fs.readFileSync('/proc/1/environ', 'utf8').includes('lxc')
      );
    } catch (error) {
      logger.debug(
        formatLog(LOG_PREFIXES.HARDWARE, 'LXC检测失败'),
        { error: error.message }
      );
      return false;
    }
  })();

  // 4. 如果处于容器环境且未用 ENV 提供参数，尝试应用 cgroup 限制
  if ((isDocker || isLXC) && (!cpuFromEnv || !memFromEnv)) {
    const limited = applyCgroupLimits(cpuCount, totalMemoryGB);
    cpuCount = limited.cpuCount;
    totalMemoryGB = limited.totalMemoryGB;
  }

  // 5. 保证取值钳制下限
  cpuCount = Math.max(1, cpuCount);
  totalMemoryGB = Math.max(1, totalMemoryGB);

  //（只在主线程输出硬件检测日志，避免 Worker 线程重复输出）
  const { isMainThread } = require('worker_threads');
  if (isMainThread) {
    logger.debug(
      formatLog(
        LOG_PREFIXES.HARDWARE,
        `最终检测结果: CPU=${cpuCount} 核, 内存=${totalMemoryGB}GB, Docker=${isDocker}, LXC=${isLXC}`
      )
    );
  }

  // 结果缓存
  const result = { cpuCount, totalMemoryGB, isDocker, isLXC };
  cachedHardwareConfig = result;

  return result;
}

module.exports = { detectHardwareConfig };