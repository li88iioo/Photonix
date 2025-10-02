const path = require('path');
const logger = require('./logger');
const { detectHardwareConfig } = require('./hardware');

/**
 * 后端全局配置模块 - 简化版
 * 统一管理核心配置项，移除复杂的队列和性能调优参数
 */

// --- 应用配置 ---
const PORT = process.env.PORT || 13001;                // 服务端口
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';      // 日志级别
const API_BASE = process.env.API_BASE || '';            // API基础URL（为空时使用相对路径）

// --- 目录配置 ---
 // 目录解析：优先 env；否则若容器默认目录存在则用之；否则回退到项目内目录
function resolveDir(envKey, dockerDefault, projectFallback) {
    const envVal = process.env[envKey];
    if (envVal && envVal.trim() !== '') return envVal;
    try { if (require('fs').existsSync(dockerDefault)) return dockerDefault; } catch {}
    return path.resolve(__dirname, '..', projectFallback);
}
const PHOTOS_DIR = resolveDir('PHOTOS_DIR', '/app/photos', 'photos'); // 图片/视频主目录
const DATA_DIR = resolveDir('DATA_DIR', '/app/data', 'data');       // 数据存储目录

// --- 数据库配置 ---
const DB_FILE = path.resolve(DATA_DIR, 'gallery.db');         // 主数据库
const SETTINGS_DB_FILE = path.resolve(DATA_DIR, 'settings.db'); // 设置数据库
const HISTORY_DB_FILE = path.resolve(DATA_DIR, 'history.db');   // 历史记录数据库
const INDEX_DB_FILE = path.resolve(DATA_DIR, 'index.db');       // 索引数据库
const THUMBS_DIR = path.resolve(DATA_DIR, 'thumbnails');        // 缩略图存储目录

// --- Redis配置 ---
// 注意：AI功能已重构为微服务架构，不再需要AI队列
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'; // Redis连接地址
const SETTINGS_QUEUE_NAME = 'settings-update-queue';                 // 设置更新任务队列名（仍在使用）

// --- 性能配置 ---
const { cpuCount, totalMemoryGB, isDocker, isLXC } = detectHardwareConfig();

const { deriveRuntime } = require('./runtime');
const __rt = deriveRuntime();
const NUM_WORKERS = __rt.NUM_WORKERS;

logger.debug(`[CONFIG] 最终硬件配置: CPU=${cpuCount}核, 内存=${totalMemoryGB}GB, 工作线程=${NUM_WORKERS}`);
const MAX_THUMBNAIL_RETRIES = 3;                                  // 缩略图最大重试次数
const INITIAL_RETRY_DELAY = 1000;                                 // 缩略图初始重试延迟（毫秒）
// --- 视频处理配置 ---
const VIDEO_TASK_DELAY_MS = __rt.VIDEO_TASK_DELAY_MS; // 视频任务间延迟
const VIDEO_MAX_CONCURRENCY = __rt.VIDEO_MAX_CONCURRENCY; // 视频任务最大并发
const INDEX_STABILIZE_DELAY_MS = parseInt(process.env.INDEX_STABILIZE_DELAY_MS) || 2000; // 索引稳定化延迟
const FFMPEG_THREADS = parseInt(process.env.FFMPEG_THREADS) || 2; // FFmpeg线程数
const SHARP_CONCURRENCY = __rt.SHARP_CONCURRENCY; // Sharp并发数
const INDEX_BATCH_SIZE = __rt.INDEX_BATCH_SIZE; // 索引批量大小

const INDEX_CONCURRENCY = __rt.INDEX_CONCURRENCY; // 索引并发数

// --- HLS视频配置 ---
const USE_FILE_SYSTEM_HLS_CHECK = (process.env.USE_FILE_SYSTEM_HLS_CHECK || 'true').toLowerCase() === 'true'; // 使用文件系统检查HLS

/**
 * 动态调整HLS性能参数，根据系统负载优化配置
 */
function getAdaptiveHlsConfig() {
  const { cpuCount, totalMemoryGB } = detectHardwareConfig();

  // 获取系统负载指标
  let systemLoad = 0;
  try {
    const loadAvg = require('os').loadavg && require('os').loadavg();
    systemLoad = loadAvg ? loadAvg[0] : 0;
  } catch {
    // 忽略负载获取错误
  }

  // 计算负载因子 (0-1之间)
  const loadFactor = Math.min(1, Math.max(0, systemLoad / (cpuCount * 1.5)));

  // 基础配置值
  const baseCacheTtl = parseInt(process.env.HLS_CACHE_TTL_MS) || 300000; // 5分钟
  const baseCheckInterval = parseInt(process.env.HLS_MIN_CHECK_INTERVAL_MS) || 1000; // 1秒
  const baseBatchDelay = parseInt(process.env.HLS_BATCH_DELAY_MS) || 100; // 100ms

  // 根据负载动态调整
  let cacheTtlMs, minCheckIntervalMs, batchDelayMs;

  if (loadFactor > 0.8) {
    // 高负载：减少检查频率，增加缓存时间，减少批处理频率
    cacheTtlMs = Math.max(baseCacheTtl * 2, 600000); // 最少10分钟
    minCheckIntervalMs = Math.max(baseCheckInterval * 5, 5000); // 最少5秒
    batchDelayMs = Math.max(baseBatchDelay * 10, 2000); // 最少2秒
  } else if (loadFactor > 0.5) {
    // 中等负载：适度调整
    cacheTtlMs = Math.max(baseCacheTtl * 1.5, 450000); // 最少7.5分钟
    minCheckIntervalMs = Math.max(baseCheckInterval * 2, 2000); // 最少2秒
    batchDelayMs = Math.max(baseBatchDelay * 3, 500); // 最少500ms
  } else {
    // 低负载：保持基础配置或稍微优化
    cacheTtlMs = baseCacheTtl;
    minCheckIntervalMs = Math.max(baseCheckInterval, 500); // 最少500ms
    batchDelayMs = baseBatchDelay;
  }

  // 确保配置值合理
  const HLS_CACHE_TTL_MS = Math.max(60000, cacheTtlMs); // 最少1分钟
  const HLS_MIN_CHECK_INTERVAL_MS = Math.max(100, minCheckIntervalMs); // 最少100ms
  const HLS_BATCH_DELAY_MS = Math.max(10, batchDelayMs); // 最少10ms

  return {
    HLS_CACHE_TTL_MS,
    HLS_MIN_CHECK_INTERVAL_MS,
    HLS_BATCH_DELAY_MS,
    loadFactor,
    adaptive: true
  };
}

const { HLS_CACHE_TTL_MS, HLS_MIN_CHECK_INTERVAL_MS, HLS_BATCH_DELAY_MS } = getAdaptiveHlsConfig();

// HLS批次大小配置（相对固定，不需要动态调整）
const HLS_CHECK_BATCH_SIZE = parseInt(process.env.HLS_CHECK_BATCH_SIZE) || 10; // HLS检查批次大小

// --- 文件监听配置 ---
const DISABLE_WATCH = (process.env.DISABLE_WATCH || 'false').toLowerCase() === 'true'; // 关闭实时文件监听

module.exports = {
    // 基础配置
    PORT,
    LOG_LEVEL,
    API_BASE,

    // 目录配置
    PHOTOS_DIR,
    DATA_DIR,
    THUMBS_DIR,

    // 数据库配置
    DB_FILE,
    SETTINGS_DB_FILE,
    HISTORY_DB_FILE,
    INDEX_DB_FILE,

    // Redis配置
    REDIS_URL,
    SETTINGS_QUEUE_NAME,

    // 性能配置
    NUM_WORKERS,
    MAX_THUMBNAIL_RETRIES,
    INITIAL_RETRY_DELAY,

    // 视频处理配置
    VIDEO_TASK_DELAY_MS,
    INDEX_STABILIZE_DELAY_MS,
    FFMPEG_THREADS,
    SHARP_CONCURRENCY,
    INDEX_BATCH_SIZE,
    INDEX_CONCURRENCY,

    VIDEO_MAX_CONCURRENCY,
    // HLS配置
    USE_FILE_SYSTEM_HLS_CHECK,
    HLS_CACHE_TTL_MS,
    HLS_CHECK_BATCH_SIZE,
    HLS_MIN_CHECK_INTERVAL_MS,
    HLS_BATCH_DELAY_MS,

    // 文件监听配置
    DISABLE_WATCH,

    // 硬件检测函数
    detectHardwareConfig,

    // HLS自适应配置
    getAdaptiveHlsConfig,
};