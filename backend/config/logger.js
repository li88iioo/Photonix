/**
 * @file logger.js
 * @description
 *  日志配置模块。
 *  - 统一应用日志输出格式，支持结构化(json)和美化输出
 *  - 提供日志前缀常量和日志消息规范化工具
 */

const winston = require('winston');

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
 * 美化日志行格式（文本模式）
 * @param {object} info - 日志信息对象
 * @returns {string} 格式化日志字符串
 */
const prettyFormat = winston.format.printf((info) => {
    const date = new Date(info.timestamp);
    const time = date.toTimeString().split(' ')[0];
    const traceSegment = info.traceId ? `[Trace:${info.traceId.slice(0, 8)}] ` : '';
    const normalizedMessage = normalizeMessagePrefix(info.message || '');
    const metaStr = info.meta && Object.keys(info.meta).length ? ` ${JSON.stringify(info.meta)}` : '';
    const stackStr = info.stack ? `\n${info.stack}` : '';
    return `[${time}] ${info.level}: ${traceSegment}${normalizedMessage}${metaStr}${stackStr}`;
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
    缩略图请求: '[缩略图请求]',
    批量补全: '[批量补全]',
    手动补全: '[手动补全]',
    按需队列: '[按需队列]',
    按需生成: '[按需生成]',
    频率控制: '[频率控制]',
    HISTORY_WORKER: '[历史线程]',
    SETTINGS_WORKER: '[设置线程]',
    VIDEO_WORKER: '[视频线程]',
    TEMP_FILE_MANAGER: '[临时文件管理]',
    DB_TIMEOUT_MANAGER: '[数据库超时]',
    ORCHESTRATOR: '[调度器]',
    HARDWARE: '[硬件]',
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
    '[MIGRATIONS]': '[数据库迁移]',
    '[TempFileManager]': LOG_PREFIXES.TEMP_FILE_MANAGER,
    '[DbTimeoutManager]': LOG_PREFIXES.DB_TIMEOUT_MANAGER,
    '[RateLimiter]': '[限流器]',
    '[Startup]': '[启动]',
    '[Startup-Index]': '[启动索引]',
    '[Watcher]': '[监听器]',
    '[Auth]': '[认证]',
    '[ThumbMetrics]': '[缩略图指标]',
    '[Index]': '[索引]',
    '[MAIN MIGRATION]': '[主库迁移]',
    '[SETTINGS MIGRATION]': '[设置库迁移]',
    '[HISTORY MIGRATION]': '[历史库迁移]',
    '[INDEX MIGRATION]': '[索引库迁移]',
    '[AI]': '[AI服务]',
    '[WORKER]': '[线程]'
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
 * 导出日志前缀、格式化、归一化工具
 */
module.exports.LOG_PREFIXES = LOG_PREFIXES;
module.exports.formatLog = formatLog;
module.exports.normalizeMessagePrefix = normalizeMessagePrefix;