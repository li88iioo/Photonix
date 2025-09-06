const path = require('path');

/**
 * 后端全局配置模块 - 简化版
 * 统一管理核心配置项，移除复杂的队列和性能调优参数
 */

// --- 应用配置 ---
const PORT = process.env.PORT || 13001;                // 服务端口
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';      // 日志级别
const API_BASE = process.env.API_BASE || '';            // API基础URL（为空时使用相对路径）

// --- 目录配置 ---
const PHOTOS_DIR = process.env.PHOTOS_DIR || '/app/photos'; // 图片/视频主目录
const DATA_DIR = process.env.DATA_DIR || '/app/data';       // 数据存储目录

// --- 数据库配置 ---
const DB_FILE = path.resolve(DATA_DIR, 'gallery.db');         // 主数据库
const SETTINGS_DB_FILE = path.resolve(DATA_DIR, 'settings.db'); // 设置数据库
const HISTORY_DB_FILE = path.resolve(DATA_DIR, 'history.db');   // 历史记录数据库
const INDEX_DB_FILE = path.resolve(DATA_DIR, 'index.db');       // 索引数据库
const THUMBS_DIR = path.resolve(DATA_DIR, 'thumbnails');        // 缩略图存储目录

// --- Redis配置 ---
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'; // Redis连接地址
const AI_CAPTION_QUEUE_NAME = 'ai-caption-queue';                    // AI字幕任务队列名
const SETTINGS_QUEUE_NAME = 'settings-update-queue';                 // 设置更新任务队列名

// --- 性能配置 ---
// 智能硬件检测：支持环境变量自定义和容器环境检测
function detectHardwareConfig() {
    // 优先使用环境变量指定的硬件信息（适用于Docker/LXC等容器环境）
    let cpuCount = parseInt(process.env.DETECTED_CPU_COUNT);
    let totalMemoryGB = parseInt(process.env.DETECTED_MEMORY_GB);

    // 如果环境变量未设置，尝试检测实际可用资源
    if (!cpuCount || isNaN(cpuCount)) {
        cpuCount = require('os').cpus().length;
        console.log(`[CONFIG] 使用系统检测CPU数量: ${cpuCount}`);
    } else {
        console.log(`[CONFIG] 使用环境变量指定CPU数量: ${cpuCount}`);
    }

    if (!totalMemoryGB || isNaN(totalMemoryGB)) {
        totalMemoryGB = Math.floor(require('os').totalmem() / (1024 * 1024 * 1024));
        console.log(`[CONFIG] 使用系统检测内存大小: ${totalMemoryGB}GB`);
    } else {
        console.log(`[CONFIG] 使用环境变量指定内存大小: ${totalMemoryGB}GB`);
    }

    // Docker环境检测和资源限制读取（静默模式）
    const isDocker = require('fs').existsSync('/.dockerenv');
    if (isDocker) {
        // 静默尝试读取Docker容器资源限制，不输出检测日志
        try {
            // 尝试读取Docker容器CPU限制
            const cpuCfsQuota = require('fs').readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim();
            const cpuCfsPeriod = require('fs').readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim();

            if (cpuCfsQuota !== '-1' && cpuCfsQuota !== '0') {
                const detectedCpuLimit = Math.ceil(parseInt(cpuCfsQuota) / parseInt(cpuCfsPeriod));
                if (detectedCpuLimit > 0 && detectedCpuLimit < cpuCount) {
                    cpuCount = detectedCpuLimit;
                }
            }

            // 尝试读取Docker容器内存限制
            const memLimit = require('fs').readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
            const memLimitGB = Math.floor(parseInt(memLimit) / (1024 * 1024 * 1024));
            if (memLimitGB > 0 && memLimitGB < totalMemoryGB) {
                totalMemoryGB = memLimitGB;
            }
        } catch (error) {
            // Docker资源检测失败时静默跳过，不输出错误日志
        }
    }

    // 检查是否在LXC容器中
    const isLXC = require('fs').existsSync('/proc/1/environ') &&
                  require('fs').readFileSync('/proc/1/environ', 'utf8').includes('lxc');

    if (isLXC) {
        console.log(`[CONFIG] 检测到LXC容器环境`);
        // LXC环境下可能需要更保守的配置
    }

    return { cpuCount, totalMemoryGB, isDocker, isLXC };
}

const { cpuCount, totalMemoryGB, isDocker, isLXC } = detectHardwareConfig();

let NUM_WORKERS;
// 低端配置（≤4核）：保守策略
if (cpuCount <= 4 || totalMemoryGB <= 4) {
    NUM_WORKERS = Math.max(2, Math.min(4, Math.floor(cpuCount * 0.5)));
}
// 中端配置（5-8核）：平衡策略
else if (cpuCount <= 8 || totalMemoryGB <= 8) {
    NUM_WORKERS = Math.max(3, Math.min(6, Math.floor(cpuCount * 0.6)));
}
// 高端配置（>8核）：高效策略
else {
    NUM_WORKERS = Math.max(4, Math.min(12, Math.floor(cpuCount * 0.75)));
}

console.log(`[CONFIG] 最终硬件配置: CPU=${cpuCount}核, 内存=${totalMemoryGB}GB, 工作线程=${NUM_WORKERS}`);
const MAX_THUMBNAIL_RETRIES = 3;                                  // 缩略图最大重试次数
const INITIAL_RETRY_DELAY = 1000;                                 // 缩略图初始重试延迟（毫秒）

// --- 视频处理配置 ---
const VIDEO_TASK_DELAY_MS = parseInt(process.env.VIDEO_TASK_DELAY_MS) || 1000; // 视频任务间延迟
const INDEX_STABILIZE_DELAY_MS = parseInt(process.env.INDEX_STABILIZE_DELAY_MS) || 2000; // 索引稳定化延迟
const FFMPEG_THREADS = parseInt(process.env.FFMPEG_THREADS) || 2; // FFmpeg线程数
const SHARP_CONCURRENCY = parseInt(process.env.SHARP_CONCURRENCY) || 2; // Sharp并发数

// --- HLS视频配置 ---
const USE_FILE_SYSTEM_HLS_CHECK = (process.env.USE_FILE_SYSTEM_HLS_CHECK || 'true').toLowerCase() === 'true'; // 使用文件系统检查HLS
const HLS_CACHE_TTL_MS = parseInt(process.env.HLS_CACHE_TTL_MS) || 300000; // HLS缓存TTL（5分钟）
const HLS_CHECK_BATCH_SIZE = parseInt(process.env.HLS_CHECK_BATCH_SIZE) || 10; // HLS检查批次大小
const HLS_MIN_CHECK_INTERVAL_MS = parseInt(process.env.HLS_MIN_CHECK_INTERVAL_MS) || 1000; // HLS最小检查间隔
const HLS_BATCH_DELAY_MS = parseInt(process.env.HLS_BATCH_DELAY_MS) || 100; // HLS批次间延迟

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
    AI_CAPTION_QUEUE_NAME,
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
};