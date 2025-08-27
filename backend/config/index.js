const path = require('path');

/**
 * 后端全局配置模块
 * 统一管理端口、目录、数据库、缓存、AI服务等所有后端配置项
 */

// --- 应用配置 ---
const PORT = process.env.PORT || 13001;                // 服务端口
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';      // 日志级别

// --- 目录配置 ---
// 目录默认值：若未通过 .env 指定，则使用容器内 /app/photos 与 /app/data
const PHOTOS_DIR = process.env.PHOTOS_DIR || '/app/photos'; // 图片/视频主目录（容器挂载点）
const DATA_DIR = process.env.DATA_DIR || '/app/data';       // 数据存储目录（容器挂载点）

// --- 多数据库配置 ---
const DB_FILE = path.resolve(DATA_DIR, 'gallery.db');         // 主数据库（图片/视频索引）
const SETTINGS_DB_FILE = path.resolve(DATA_DIR, 'settings.db'); // 设置数据库
const HISTORY_DB_FILE = path.resolve(DATA_DIR, 'history.db');   // 历史记录数据库
const INDEX_DB_FILE = path.resolve(DATA_DIR, 'index.db');       // 索引数据库

const THUMBS_DIR = path.resolve(DATA_DIR, 'thumbnails');        // 缩略图存储目录




// --- Redis & BullMQ ---
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'; // Redis连接地址
const AI_CAPTION_QUEUE_NAME = 'ai-caption-queue';                    // AI字幕任务队列名
const SETTINGS_QUEUE_NAME = 'settings-update-queue';                 // 设置更新任务队列名
const THUMBNAIL_QUEUE_NAME = process.env.THUMBNAIL_QUEUE_NAME || 'thumb-job-queue';
const VIDEO_QUEUE_NAME = process.env.VIDEO_QUEUE_NAME || 'video-job-queue';

// --- API & 性能 ---
const API_BASE = '';                                              // API基础路径（预留）
const NUM_WORKERS = Math.max(1, Math.floor(require('os').cpus().length / 2)); // 工作进程数
const MAX_THUMBNAIL_RETRIES = 5;                                  // 缩略图最大重试次数
const INITIAL_RETRY_DELAY = 2000;                                 // 缩略图初始重试延迟（毫秒）

// --- 自适应/可配置参数（大规模与冷启动优化） ---
const INDEX_STABILIZE_DELAY_MS = Number(process.env.INDEX_STABILIZE_DELAY_MS || 5000); // 变更聚合延迟
const TAG_INVALIDATION_MAX_TAGS = Number(process.env.TAG_INVALIDATION_MAX_TAGS || 2000); // 标签失效上限，超出则降级为粗清理
const THUMB_CHECK_BATCH_SIZE = Number(process.env.THUMB_CHECK_BATCH_SIZE || 200); // 缩略图检查批量
const THUMB_CHECK_BATCH_DELAY_MS = Number(process.env.THUMB_CHECK_BATCH_DELAY_MS || 100); // 批次间延迟
const COVER_INFO_LRU_SIZE = Number(process.env.COVER_INFO_LRU_SIZE || 4000); // 进程内封面 LRU 大小
const ROUTE_CACHE_BROWSE_PATTERN = 'route_cache:*:/api/browse*'; // 路由缓存清理匹配模式（降级用）

// --- 视频HLS处理优化配置 ---
const VIDEO_BATCH_SIZE = Number(process.env.VIDEO_BATCH_SIZE || 2); // 视频批次大小（降低并发）
const VIDEO_BATCH_DELAY_MS = Number(process.env.VIDEO_BATCH_DELAY_MS || 10000); // 视频批次间延迟
const VIDEO_TASK_DELAY_MS = Number(process.env.VIDEO_TASK_DELAY_MS || 3000); // 单个视频任务间延迟
const SYSTEM_LOAD_THRESHOLD = Number(process.env.SYSTEM_LOAD_THRESHOLD || 1.0); // 系统负载阈值

// --- HLS状态检查配置 ---
const USE_FILE_SYSTEM_HLS_CHECK = process.env.USE_FILE_SYSTEM_HLS_CHECK !== 'false'; // 默认使用文件系统检查
const HLS_CACHE_TTL_MS = Number(process.env.HLS_CACHE_TTL_MS || 300000); // HLS缓存TTL（5分钟）
const HLS_CHECK_BATCH_SIZE = Number(process.env.HLS_CHECK_BATCH_SIZE || 10); // HLS检查批次大小

// --- 硬盘保护配置 ---
const HLS_MIN_CHECK_INTERVAL_MS = Number(process.env.HLS_MIN_CHECK_INTERVAL_MS || 5000); // 最小检查间隔（5秒）
const HLS_BATCH_DELAY_MS = Number(process.env.HLS_BATCH_DELAY_MS || 200); // 批次间延迟（200ms）

// --- 超大图库优化/开关 ---
const DISABLE_WATCH = (process.env.DISABLE_WATCH || 'false').toLowerCase() === 'true'; // 关闭实时文件监听，改靠维护任务
const QUEUE_MODE = (process.env.QUEUE_MODE || 'false').toLowerCase() === 'true'; // 使用 Redis 队列驱动的异步处理

module.exports = {
    PORT,                    // 服务端口
    LOG_LEVEL,               // 日志级别
    PHOTOS_DIR,              // 图片/视频主目录
    DATA_DIR,                // 数据存储目录
    DB_FILE,                 // 主数据库
    SETTINGS_DB_FILE,        // 设置数据库
    HISTORY_DB_FILE,         // 历史记录数据库
    INDEX_DB_FILE,           // 索引数据库
    THUMBS_DIR,              // 缩略图目录
    
    
    REDIS_URL,               // Redis连接地址
    AI_CAPTION_QUEUE_NAME,   // AI字幕队列名
    SETTINGS_QUEUE_NAME,     // 设置更新队列名
    THUMBNAIL_QUEUE_NAME,    // 缩略图处理队列名
    VIDEO_QUEUE_NAME,        // 视频处理队列名
    API_BASE,                // API基础路径
    NUM_WORKERS,             // 工作进程数
    MAX_THUMBNAIL_RETRIES,   // 缩略图最大重试次数
    INITIAL_RETRY_DELAY,     // 缩略图初始重试延迟
    INDEX_STABILIZE_DELAY_MS, // 索引事件聚合延迟
    TAG_INVALIDATION_MAX_TAGS, // 标签失效上限
    THUMB_CHECK_BATCH_SIZE,  // 缩略图检查批量
    THUMB_CHECK_BATCH_DELAY_MS, // 批次间延迟
    COVER_INFO_LRU_SIZE,     // 封面 LRU 大小
    ROUTE_CACHE_BROWSE_PATTERN, // 路由缓存降级模式
    
    // 视频HLS处理配置
    VIDEO_BATCH_SIZE,        // 视频批次大小
    VIDEO_BATCH_DELAY_MS,    // 视频批次间延迟
    VIDEO_TASK_DELAY_MS,     // 单个视频任务间延迟
    SYSTEM_LOAD_THRESHOLD,   // 系统负载阈值
    
    // HLS状态检查配置
    USE_FILE_SYSTEM_HLS_CHECK, // 是否使用文件系统检查
    HLS_CACHE_TTL_MS,        // HLS缓存TTL
    HLS_CHECK_BATCH_SIZE,    // HLS检查批次大小
    
    // 硬盘保护配置
    HLS_MIN_CHECK_INTERVAL_MS, // 最小检查间隔
    HLS_BATCH_DELAY_MS,      // 批次间延迟
    DISABLE_WATCH,           // 是否关闭 chokidar 实时监听
    QUEUE_MODE,              // 是否启用队列模式
};