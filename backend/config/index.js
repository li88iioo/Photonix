const path = require('path');
const baseLogger = require('./logger');
const { LOG_PREFIXES, formatLog } = baseLogger;
const logger = baseLogger;
const { detectHardwareConfig } = require('./hardware');

/**
 * @file index.js
 * @description
 *  后端全局配置模块（简化版）
 *  - 集中管理核心配置项
 *  - 移除复杂队列与高级性能调优参数
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
    try { if (require('fs').existsSync(dockerDefault)) return dockerDefault; }
    catch (error) {
        logger.silly(formatLog(LOG_PREFIXES.CONFIG, `检测默认目录失败，使用项目内路径: ${error && error.message}`));
    }
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

// --- 日志开关配置 ---
const ENABLE_AUTH_DEBUG_LOGS = (process.env.AUTH_DEBUG_LOGS || '').toLowerCase() === 'true';

// 只在主线程输出配置日志，避免Worker线程重复输出
const { isMainThread } = require('worker_threads');
if (isMainThread) {
    logger.debug(formatLog(LOG_PREFIXES.CONFIG, `最终硬件配置: CPU=${cpuCount}核, 内存=${totalMemoryGB}GB, 工作线程=${NUM_WORKERS}`));
}

// --- 缩略图配置 ---
const MAX_THUMBNAIL_RETRIES = 3;                                  // 缩略图最大重试次数
const INITIAL_RETRY_DELAY = 1000;                                 // 缩略图初始重试延迟（毫秒）
const THUMB_ONDEMAND_QUEUE_MAX = Number(process.env.THUMB_ONDEMAND_QUEUE_MAX || 2000); // 按需队列最大长度
const THUMB_BATCH_COOLDOWN_MS = Math.max(0, Number(process.env.THUMB_BATCH_COOLDOWN_MS || 0)); // 批处理冷却时间
const THUMB_TELEMETRY_LOG_INTERVAL_MS = Math.max(5000, Number(process.env.THUMB_TELEMETRY_LOG_INTERVAL_MS || 15000)); // 遥测日志间隔
const THUMB_OVERFLOW_RETRY_MS = Number(process.env.THUMB_OVERFLOW_RETRY_MS || 5000); // 队列溢出重试间隔
const THUMB_ONDEMAND_IDLE_DESTROY_MS = Number(process.env.THUMB_ONDEMAND_IDLE_DESTROY_MS || 30000); // 空闲销毁时间
const THUMB_ONDEMAND_RESERVE = Math.max(0, Math.floor(Number(process.env.THUMB_ONDEMAND_RESERVE || 0))); // 预留worker数量

// --- Sharp配置 ---
const SHARP_CACHE_MEMORY_MB = Number(process.env.SHARP_CACHE_MEMORY_MB || 16); // Sharp缓存内存
const SHARP_CACHE_ITEMS = Number(process.env.SHARP_CACHE_ITEMS || 50); // Sharp缓存项数
const SHARP_CACHE_FILES = Number(process.env.SHARP_CACHE_FILES || 0); // Sharp缓存文件数
const SHARP_CONCURRENCY = __rt.SHARP_CONCURRENCY; // Sharp并发数
const SHARP_MAX_PIXELS = Number(process.env.SHARP_MAX_PIXELS || (24000 * 24000)); // Sharp最大像素数

// --- 视频处理配置 ---
const VIDEO_TASK_DELAY_MS = __rt.VIDEO_TASK_DELAY_MS; // 视频任务间延迟
const VIDEO_MAX_CONCURRENCY = __rt.VIDEO_MAX_CONCURRENCY; // 视频任务最大并发
const HLS_BATCH_TIMEOUT_MS = Number(process.env.HLS_BATCH_TIMEOUT_MS || 600000); // HLS批处理超时
const FFMPEG_THREADS = parseInt(process.env.FFMPEG_THREADS) || 2; // FFmpeg线程数

// --- 索引配置 ---
const INDEX_STABILIZE_DELAY_MS = parseInt(process.env.INDEX_STABILIZE_DELAY_MS) || 2000; // 索引稳定化延迟
const INDEX_BATCH_SIZE = __rt.INDEX_BATCH_SIZE; // 索引批量大小
const INDEX_CONCURRENCY = __rt.INDEX_CONCURRENCY; // 索引并发数

// --- 文件服务配置 ---
const FILE_BATCH_SIZE = Number(process.env.FILE_BATCH_SIZE || 200); // 文件批处理大小
const FILE_CACHE_DURATION = Number(process.env.FILE_CACHE_DURATION || 604800); // 文件缓存时长（秒）
const DIMENSION_CACHE_TTL = Number(process.env.DIMENSION_CACHE_TTL || 60 * 60 * 24 * 30); // 尺寸缓存TTL（秒）
const DIMENSION_PROBE_CONCURRENCY = Number(process.env.DIMENSION_PROBE_CONCURRENCY || 4); // 尺寸探测并发数
const BATCH_LOG_FLUSH_INTERVAL = Number(process.env.BATCH_LOG_FLUSH_INTERVAL || 5000); // 批量日志刷新间隔
const CACHE_CLEANUP_DAYS = Number(process.env.CACHE_CLEANUP_DAYS || 1); // 缓存清理天数

// --- AI配置 ---
const AI_QUEUE_MAX = Number(process.env.AI_QUEUE_MAX || 50); // AI队列最大长度
const AI_QUEUE_TIMEOUT_MS = Number(process.env.AI_QUEUE_TIMEOUT_MS || 60000); // AI队列超时
const AI_TASK_TIMEOUT_MS = Number(process.env.AI_TASK_TIMEOUT_MS || 120000); // AI任务超时
const AI_MAX_CONCURRENT = Number(process.env.AI_MAX_CONCURRENT || process.env.AI_CONCURRENCY || 2); // AI最大并发数

// --- Worker配置 ---
const WORKER_MEMORY_MB = Number(process.env.WORKER_MEMORY_MB || 256); // Worker内存限制
const THUMB_INITIAL_WORKERS = Number(process.env.THUMB_INITIAL_WORKERS || 0); // 初始缩略图worker数量
const TASK_SCHEDULER_CONCURRENCY = Math.max(1, Number(process.env.TASK_SCHEDULER_CONCURRENCY || 2)); // 任务调度器并发数

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
  } catch (error) {
    logger.silly(formatLog(LOG_PREFIXES.CONFIG, `获取系统负载失败，采用默认配置: ${error && error.message}`));
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
const DISABLE_WATCH = (process.env.DISABLE_WATCH || 'true').toLowerCase() === 'true'; // 关闭实时文件监听

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

    // 缩略图配置
    THUMB_ONDEMAND_QUEUE_MAX,
    THUMB_BATCH_COOLDOWN_MS,
    THUMB_TELEMETRY_LOG_INTERVAL_MS,
    THUMB_OVERFLOW_RETRY_MS,
    THUMB_ONDEMAND_IDLE_DESTROY_MS,
    THUMB_ONDEMAND_RESERVE,

    // Sharp配置
    SHARP_CACHE_MEMORY_MB,
    SHARP_CACHE_ITEMS,
    SHARP_CACHE_FILES,
    SHARP_CONCURRENCY,
    SHARP_MAX_PIXELS,

    // 视频处理配置
    VIDEO_TASK_DELAY_MS,
    VIDEO_MAX_CONCURRENCY,
    HLS_BATCH_TIMEOUT_MS,
    FFMPEG_THREADS,

    // 索引配置
    INDEX_STABILIZE_DELAY_MS,
    INDEX_BATCH_SIZE,
    INDEX_CONCURRENCY,

    // 文件服务配置
    FILE_BATCH_SIZE,
    FILE_CACHE_DURATION,
    DIMENSION_CACHE_TTL,
    DIMENSION_PROBE_CONCURRENCY,
    BATCH_LOG_FLUSH_INTERVAL,
    CACHE_CLEANUP_DAYS,

    // AI配置
    AI_QUEUE_MAX,
    AI_QUEUE_TIMEOUT_MS,
    AI_TASK_TIMEOUT_MS,
    AI_MAX_CONCURRENT,

    // Worker配置
    WORKER_MEMORY_MB,
    THUMB_INITIAL_WORKERS,
    TASK_SCHEDULER_CONCURRENCY,

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

    // 日志开关
    ENABLE_AUTH_DEBUG_LOGS,
};