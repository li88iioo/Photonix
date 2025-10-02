/**
 * hardware.js
 * 统一硬件探测：优先环境变量（DETECTED_*），再系统检测，最终钳制为 >=1
 * 返回与旧 detectHardwareConfig 兼容的结构：{ cpuCount, totalMemoryGB, isDocker, isLXC }
 */
const os = require('os');
const fs = require('fs');
const logger = require('./logger');

function normalizeInt(v, min = 1) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min ? n : undefined;
}

function readIntFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  } catch (error) {
    logger.debug(`[Hardware] 读取 ${filePath} 失败`, { error: error.message });
    return undefined;
  }
}

function applyCgroupLimits(cpuCount, totalMemoryGB) {
  let adjustedCpu = cpuCount;
  let adjustedMem = totalMemoryGB;

  const quota = readIntFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
  const period = readIntFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  if (quota !== undefined && period && quota > 0 && period > 0) {
    const limit = Math.ceil(quota / period);
    if (limit > 0 && limit < adjustedCpu) {
      logger.info(`[Hardware] 应用 cgroup CPU 限制: ${limit}`);
      adjustedCpu = limit;
    }
  }

  const memLimitBytes = readIntFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (memLimitBytes && memLimitBytes > 0) {
    const limitGb = Math.floor(memLimitBytes / (1024 * 1024 * 1024));
    if (limitGb > 0 && limitGb < adjustedMem) {
      logger.info(`[Hardware] 应用 cgroup 内存限制: ${limitGb}GB`);
      adjustedMem = limitGb;
    }
  }

  return { cpuCount: adjustedCpu, totalMemoryGB: adjustedMem };
}

function detectHardwareConfig() {
  // 1) 优先使用外部标定（容器/虚拟化推荐）
  let cpuFromEnv = normalizeInt(process.env.DETECTED_CPU_COUNT, 1);
  let memFromEnv = normalizeInt(process.env.DETECTED_MEMORY_GB, 1);

  // 2) 系统检测（作为次选）
  let cpuFromSys, memGbFromSys;
  try {
    cpuFromSys = normalizeInt((os.cpus && os.cpus().length) || 0, 1);
  } catch (error) {
    logger.warn('CPU检测失败', { error: error.message });
  }
  try {
    memGbFromSys = normalizeInt((os.totalmem && (os.totalmem() / (1024 * 1024 * 1024))) || 0, 1);
  } catch (error) {
    logger.warn('内存检测失败', { error: error.message });
  }

  // 3) 选择优先级：ENV -> SYS -> 最低1
  let cpuCount = cpuFromEnv || cpuFromSys || 1;
  let totalMemoryGB = memFromEnv || memGbFromSys || 1;

  // Docker/LXC 检测（保持与旧版返回结构兼容）
  const isDocker = (() => {
    try {
      return fs.existsSync('/.dockerenv');
    } catch (error) {
      logger.debug('Docker检测失败', { error: error.message });
      return false;
    }
  })();
  const isLXC = (() => {
    try {
      return fs.existsSync('/proc/1/environ') && fs.readFileSync('/proc/1/environ', 'utf8').includes('lxc');
    } catch (error) {
      logger.debug('LXC检测失败', { error: error.message });
      return false;
    }
  })();

  if ((isDocker || isLXC) && (!cpuFromEnv || !memFromEnv)) {
    const limited = applyCgroupLimits(cpuCount, totalMemoryGB);
    cpuCount = limited.cpuCount;
    totalMemoryGB = limited.totalMemoryGB;
  }

  cpuCount = Math.max(1, cpuCount);
  totalMemoryGB = Math.max(1, totalMemoryGB);

  logger.debug(`[Hardware] 最终检测结果: CPU=${cpuCount} 核, 内存=${totalMemoryGB}GB, Docker=${isDocker}, LXC=${isLXC}`);

  return { cpuCount, totalMemoryGB, isDocker, isLXC };
}

module.exports = { detectHardwareConfig };