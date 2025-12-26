/**
 * @file logger.js
 * @description
 *  日志配置模块。
 *  - 统一应用日志输出格式，支持结构化(json)和美化输出
 *  - 提供日志前缀常量和日志消息规范化工具
 */

const winston = require('winston');
const util = require('util');

// 显式设置颜色映射，确保 INFO/DEBUG 在不同终端主题下也可区分
winston.addColors({
    error: 'red',
    warn: 'yellow',
    info: 'green',
    debug: 'cyan',
    silly: 'magenta'
});

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_JSON = (process.env.LOG_JSON || 'false').toLowerCase() === 'true';

/**
 * Winston 日志基础格式集合：
 * - 添加时间戳
 * - 支持错误堆栈打印
 */
const baseFormats = [
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
];

/**
 * 日志级别显示宽度对齐映射
 */
const LEVEL_DISPLAY = {
    error: 'ERROR',
    warn: 'WARN ',
    info: 'INFO ',
    debug: 'DEBUG',
    silly: 'SILLY'
};

/**
 * 美化日志行格式（文本模式）
 * 格式: [MM-DD HH:mm:ss] LEVEL [前缀] 消息 | key=value | trace=xxx
 * @param {object} info - 日志信息对象
 * @returns {string} 格式化日志字符串
 */
const prettyFormat = winston.format.printf((info) => {
    const date = new Date(info.timestamp);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const time = date.toTimeString().split(' ')[0];
    const dateTime = `${month}-${day} ${time}`;

    // 级别对齐显示（去除 colorize 添加的 ANSI 码后的原始级别）
    const rawLevel = typeof info.level === 'string'
        ? info.level.replace(/\x1b\[[0-9;]*m/g, '')
        : String(info.level || '');
    const levelDisplayRaw = LEVEL_DISPLAY[rawLevel] || rawLevel.toUpperCase().padEnd(5);
    const colorizer = winston.format.colorize();
    const levelDisplay = colorizer.colorize(rawLevel, levelDisplayRaw);

    const normalizedMessage = normalizeMessagePrefix(info.message || '');

    // 构建元数据字符串（key=value 格式）
    let metaParts = [];
    const formatMetaValue = (value) => {
        if (value === undefined || value === null) return '';
        if (value instanceof Error) return value.stack || value.message || 'Error';
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'object') {
            try {
                return JSON.stringify(value);
            } catch (e) {
                return util.inspect(value, { depth: 2, breakLength: Infinity });
            }
        }
        try {
            return String(value);
        } catch (e) {
            return '[Unstringifiable]';
        }
    };
    if (info.meta && Object.keys(info.meta).length) {
        for (const [key, value] of Object.entries(info.meta)) {
            if (value !== undefined && value !== null) {
                // 过滤冗余的请求ID（Pretty模式下已有 traceId 覆盖）
                if (key === 'requestId' || key === '请求ID') continue;
                metaParts.push(`${key}=${formatMetaValue(value)}`);
            }
        }
    }

    // TraceId 放在末尾
    if (info.traceId) {
        metaParts.push(`trace=${info.traceId.slice(0, 8)}`);
    }

    const metaStr = metaParts.length > 0 ? ` | ${metaParts.join(' | ')}` : '';
    const stackStr = info.stack ? `\n${info.stack}` : '';

    return `[${dateTime}] ${levelDisplay} ${normalizedMessage}${metaStr}${stackStr}`;
});

/**
 * 结构化 JSON 日志行格式
 * @param {object} info - 日志信息对象
 * @returns {string} JSON 字符串
 */
const jsonFormat = winston.format.printf((info) => {
    const payload = {
        timestamp: info.timestamp,
        level: info.level,
        message: info.message,
        pid: process.pid,
    };
    if (info.traceId) payload.traceId = info.traceId;
    if (info.spanId) payload.spanId = info.spanId;
    if (info.meta && Object.keys(info.meta).length) payload.meta = info.meta;
    if (info.stack) payload.stack = info.stack;
    return JSON.stringify(payload);
});

/**
 * 主 Winston 日志记录器配置
 */
const logger = winston.createLogger({
    level: LOG_LEVEL,
    format: LOG_JSON
        ? winston.format.combine(...baseFormats, jsonFormat)
        : winston.format.combine(winston.format.colorize(), ...baseFormats, prettyFormat),
    transports: [new winston.transports.Console()],
});

/**
 * 追踪日志增强：支持 TraceID 链路追踪的日志接口
 */
const { createTracedLogger } = require('../utils/trace');
const tracedLogger = createTracedLogger(logger);

/**
 * 导出：默认追踪增强的 logger 对象
 */
module.exports = tracedLogger;

/**
 * 日志前缀常量（统一关键模块日志标签）
 */
const LOG_PREFIXES = {
    INDEXING_WORKER: '[索引线程]',
    THUMB_POOL: '[缩略线程池]',
    CONFIG: '[配置]',
    SERVER: '[服务器]',
    MAIN_THREAD: '[主线程]',
    SSE: '[SSE事件]',
    CACHE: '[缓存]',
    ADAPTIVE: '[自适应]',
    WORKER_HEALTH: '[线程健康]',
    TASK_SCHEDULER: '[任务调度器]',
    THUMBNAIL_CLEANUP: '[缩略图清理]',
    THUMB: '[缩略图]',
    MEMORY_MONITOR: '[内存监控]',
    FREQUENCY_CONTROL: '[频率控制]',
    THUMB_REQUEST: '[缩略图请求]',
    BATCH_BACKFILL: '[批量补全]',
    MANUAL_BACKFILL: '[手动补全]',
    ONDEMAND_QUEUE: '[按需队列]',
    ONDEMAND_GENERATE: '[按需生成]',
    RATE_CONTROL: '[频率控制]',
    SETTINGS_WORKER: '[设置线程]',
    VIDEO_WORKER: '[视频线程]',
    TEMP_FILE_MANAGER: '[临时文件管理]',
    DB_TIMEOUT_MANAGER: '[数据库超时]',
    ORCHESTRATOR: '[调度器]',
    HARDWARE: '[硬件]',
    PATH_VALIDATION: '[路径验证]',
    CONFIG_VALIDATION: '[配置校验]',
    SEARCH: '[搜索]',
    THUMB_BACKFILL_DISPATCH: '[缩略图补全派发]',
    SLOW_QUERY: '[慢查询]',
    MEMORY_WARNING: '[内存警告]',
    DOWNLOADER: '[下载器]',
    AUTO_SYNC: '[自动同步]',
    THUMBNAIL_SYNC: '[缩略图同步]',
    THUMB_STATUS_REPO: '[缩略图状态仓库]',
    ALBUM_COVERS_REPO: '[相册封面]',
    STARTUP_BACKFILL: '启动回填',
    DB_MAINTENANCE: '数据库维护',
    SYSTEM_MAINTENANCE: '[系统维护]',
    HLS_CLEANUP: '[HLS清理]',
    SETTINGS_UPDATE: '[设置更新]',
    WORKER_MANAGER: '[工作线程管理]',
    SQLITE: '[SQLite]',
    REDIS: '[Redis]',
    AUTH: '[认证]',
    RETRY_MANAGER: '[重试管理]',
    METRICS: '[指标]',
    RATE_LIMITER: '[限流器]',
    AI_SERVICE: '[AI服务]',
    AI_RATE_GUARD: '[AI限流]',
    ITEMS_REPO: '[媒体仓库]',
    INDEX_STATUS_REPO: '[索引状态]',
    FILE_SERVICE: '[文件服务]',
    INDEXER_SERVICE: '[索引服务]',
    VIDEO_QUEUE: '[视频队列]',
    MANUAL_INDEX: '[手动索引]',
    THUMB_METRICS: '[缩略图指标]',
    SLOW_REQUEST: '[慢请求]',
    INDEX_CONCURRENCY: '[索引并发]',
    BATCH_GENERATE: '[批量生成]',
    THUMBNAIL_WORKER: '[缩略图线程]',
    VIDEO_PROCESSOR: '[视频处理]',
    SYSTEM_ERROR: '[系统错误]',
    REQUEST_ERROR: '[请求异常]',
    REQUEST: '[请求]',
    ALBUM: '[相册]',
    ALBUM_MGMT: '[相册管理]',
    LOGIN_BG: '[登录背景]',
    TX_MANAGER: '[事务]',
    MIGRATION: '[数据库迁移]',
    STARTUP: '[启动]',
    WATCHER: '[监听器]',
    INDEX: '[索引]',
    WORKER: '[线程]',
    PERMISSIONS: '[权限]',
    PATH_VALIDATOR: '[路径校验]',
    BROWSE: '[浏览]',
    HLS: '[HLS]',
    VIDEO_SERVICE: '[视频服务]',
};

/**
 * 日志中用到的表名/资源名标签
 */
const LOG_TABLE_LABELS = {
    THUMB_STATUS: '缩略图状态表',
};

/**
 * 日志消息前缀和原始消息合成函数
 * @param {string} prefix - 日志前缀
 * @param {string} message - 日志主体内容
 * @returns {string} 规范化合成日志字符串
 */
function formatLog(prefix, message) {
    return `${prefix} ${message}`;
}

/**
 * 创建一个带默认前缀的 logger（常用于 worker 线程）。
 * - 若 message 已以 `[` 开头（已包含前缀），则不重复添加
 * - 复用当前进程 logger 的统一格式与结构化 meta 支持
 * @param {string} prefix
 * @returns {{error:Function,warn:Function,info:Function,debug:Function,silly:Function,log:Function}}
 */
function createPrefixedLogger(prefix) {
    const safePrefix = String(prefix || '').trim();

    const withPrefix = (message) => {
        if (!safePrefix) return message;
        if (typeof message !== 'string') return message;
        const trimmed = message.trimStart();
        if (trimmed.startsWith('[')) return message;
        return `${safePrefix} ${message}`;
    };

    const wrap = (level) => (message, ...args) => tracedLogger[level](withPrefix(message), ...args);

    return {
        error: wrap('error'),
        warn: wrap('warn'),
        info: wrap('info'),
        debug: wrap('debug'),
        silly: wrap('silly'),
        log(levelOrEntry, ...args) {
            if (typeof levelOrEntry === 'string') {
                const [message, ...rest] = args;
                return tracedLogger.log(levelOrEntry, withPrefix(message), ...rest);
            }
            return tracedLogger.log(levelOrEntry, ...args);
        }
    };
}

/**
 * 兼容历史日志前缀映射表
 * （老前缀 => 新LOG_PREFIXES或规范化标签）
 */
const LEGACY_PREFIX_MAP = {
    '[CONFIG]': LOG_PREFIXES.CONFIG,
    '[Hardware]': LOG_PREFIXES.HARDWARE,
    '[Adaptive]': LOG_PREFIXES.ADAPTIVE,
    '[TaskScheduler]': LOG_PREFIXES.TASK_SCHEDULER,
    '[WorkerHealth]': LOG_PREFIXES.WORKER_HEALTH,
    '[ThumbPool]': LOG_PREFIXES.THUMB_POOL,
    '[THUMBNAIL CLEANUP]': LOG_PREFIXES.THUMBNAIL_CLEANUP,
    '[CACHE]': LOG_PREFIXES.CACHE,
    '[Cache]': LOG_PREFIXES.CACHE,
    '[Main-Thread]': LOG_PREFIXES.MAIN_THREAD,
    '[IndexScheduler]': '[索引调度]',
    '[THUMB]': LOG_PREFIXES.THUMB,
    '[SSE]': LOG_PREFIXES.SSE,
    '[SERVER]': LOG_PREFIXES.SERVER,
    '[Orchestrator]': LOG_PREFIXES.ORCHESTRATOR,
    '[MIGRATIONS]': LOG_PREFIXES.MIGRATION,
    '[TempFileManager]': LOG_PREFIXES.TEMP_FILE_MANAGER,
    '[DbTimeoutManager]': LOG_PREFIXES.DB_TIMEOUT_MANAGER,
    '[RateLimiter]': LOG_PREFIXES.RATE_LIMITER,
    '[Startup]': LOG_PREFIXES.STARTUP,
    '[Startup-Index]': '[启动索引]',
    '[Watcher]': LOG_PREFIXES.WATCHER,
    '[Auth]': LOG_PREFIXES.AUTH,
    '[Index]': LOG_PREFIXES.INDEX,
    '[MAIN MIGRATION]': '[主库迁移]',
    '[SETTINGS MIGRATION]': '[设置库迁移]',
    '[HISTORY MIGRATION]': '[历史库迁移]',
    '[INDEX MIGRATION]': '[索引库迁移]',
    '[AI]': LOG_PREFIXES.AI_SERVICE,
    '[WORKER]': LOG_PREFIXES.WORKER,
    '[FileService]': LOG_PREFIXES.FILE_SERVICE,
    '[IndexerService]': LOG_PREFIXES.INDEXER_SERVICE,
    '[VideoQueue]': LOG_PREFIXES.VIDEO_QUEUE,
    '[ManualIndex]': LOG_PREFIXES.MANUAL_INDEX,
    '[ThumbMetrics]': LOG_PREFIXES.THUMB_METRICS,
    '[OptionalAuth]': LOG_PREFIXES.AUTH,
    '[AlbumCoversRepo]': LOG_PREFIXES.ALBUM_COVERS_REPO,
    '[Album]': LOG_PREFIXES.ALBUM,
    '[AlbumMgmt]': LOG_PREFIXES.ALBUM_MGMT,
    '[LoginBG]': LOG_PREFIXES.LOGIN_BG,
    '[LogManager]': LOG_PREFIXES.DOWNLOADER,
    '[SettingsStatus]': '[设置状态]',
    '[TxManager]': LOG_PREFIXES.TX_MANAGER,
    '[HLS_CACHE_CLEANUP]': LOG_PREFIXES.HLS_CLEANUP,
    '[慢请求]': LOG_PREFIXES.SLOW_REQUEST,
    '[索引并发]': LOG_PREFIXES.INDEX_CONCURRENCY,
    '[批量生成]': LOG_PREFIXES.BATCH_GENERATE,
    '[VIDEO-SERVICE]': LOG_PREFIXES.VIDEO_SERVICE,
    '[HLS]': LOG_PREFIXES.HLS,
};

/**
 * 需直接剔除的历史日志前缀
 */
const LEGACY_PREFIX_REMOVE = [
    '[INDEXING-WORKER]',
    '[SETTINGS-WORKER]',
    '[HISTORY-WORKER]',
    '[VIDEO-PROCESSOR]',
    '[VIDEO-SERVICE]',
    '[THUMBNAIL-WORKER]',
    '[THUMBNAIL-WORKER-1]',
    '[THUMBNAIL-WORKER-2]'
];

/**
 * 转义字符串用于正则表达式（避免特殊符号影响替换）
 * @param {string} str
 * @returns {string}
 */
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 历史日志前缀归一化，规范化输出为新前缀风格
 * @param {string} message - 原始日志消息
 * @returns {string} 替换前缀的规范化日志消息
 */
function normalizeMessagePrefix(message) {
    if (typeof message !== 'string') return message;
    let normalized = message;
    for (const [legacy, replacement] of Object.entries(LEGACY_PREFIX_MAP)) {
        if (!replacement) continue;
        normalized = normalized.replace(new RegExp(escapeRegExp(legacy), 'gi'), replacement);
    }
    for (const legacy of LEGACY_PREFIX_REMOVE) {
        normalized = normalized.replace(new RegExp(escapeRegExp(legacy), 'gi'), '');
    }
    normalized = normalized.replace(/\[THUMBNAIL-WORKER-\d+\]/g, LOG_PREFIXES.THUMB || '[缩略图]');
    return normalized.replace(/\s{2,}/g, ' ').trimStart();
}

/**
 * 节流日志状态存储
 * key -> { lastTime: number, count: number }
 */
const throttleState = new Map();
const THROTTLE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5分钟清理一次
const THROTTLE_ENTRY_TTL_MS = 10 * 60 * 1000; // 条目10分钟过期

/**
 * 节流日志输出
 * 在指定时间间隔内，相同 key 的日志只输出一次，并统计被抑制的次数
 * @param {string} level - 日志级别 (info/warn/error/debug)
 * @param {string} key - 节流键（相同 key 的日志会被合并）
 * @param {string} message - 日志消息
 * @param {object} [meta] - 元数据对象
 * @param {number} [intervalMs=5000] - 节流间隔（毫秒）
 * @returns {boolean} 是否实际输出了日志
 */
function throttledLog(level, key, message, meta = {}, intervalMs = 5000) {
    const now = Date.now();
    const state = throttleState.get(key);

    if (state && (now - state.lastTime) < intervalMs) {
        // 在节流期内，只计数不输出
        state.count += 1;
        return false;
    }

    // 超过节流期或首次调用，输出日志
    const suppressedCount = state ? state.count : 0;
    const enrichedMeta = { ...meta };

    // 如果有被抑制的日志，添加计数信息
    if (suppressedCount > 0) {
        enrichedMeta.suppressed = suppressedCount;
    }

    throttleState.set(key, { lastTime: now, count: 0 });

    // 调用实际的日志方法
    if (typeof tracedLogger[level] === 'function') {
        tracedLogger[level](message, Object.keys(enrichedMeta).length > 0 ? enrichedMeta : undefined);
    }

    return true;
}

/**
 * 定期清理过期的节流状态条目
 */
const throttleCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, state] of throttleState.entries()) {
        if ((now - state.lastTime) > THROTTLE_ENTRY_TTL_MS) {
            throttleState.delete(key);
        }
    }
}, THROTTLE_CLEANUP_INTERVAL_MS);
// 允许进程退出
if (typeof throttleCleanupTimer.unref === 'function') throttleCleanupTimer.unref();

/**
 * 导出日志前缀、格式化、归一化工具
 */
module.exports.LOG_PREFIXES = LOG_PREFIXES;
module.exports.formatLog = formatLog;
module.exports.normalizeMessagePrefix = normalizeMessagePrefix;
module.exports.LOG_TABLE_LABELS = LOG_TABLE_LABELS;
module.exports.throttledLog = throttledLog;
module.exports.createPrefixedLogger = createPrefixedLogger;
