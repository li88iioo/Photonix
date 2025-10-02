/**
 * 日志配置模块
 * 使用winston库配置应用程序的日志记录功能
 */
const winston = require('winston');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

/**
 * 创建winston日志记录器实例
 * 配置日志级别、格式和输出方式
 */
const logger = winston.createLogger({
    // 设置日志级别，从配置文件中读取
    level: LOG_LEVEL,
    // 配置日志格式，包含颜色、时间戳和自定义输出格式
    format: winston.format.combine(
        // 为不同级别的日志添加颜色标识
        winston.format.colorize(),
        // 添加时间戳到每条日志记录
        winston.format.timestamp(),
        // 自定义日志输出格式：HH:MM:SS 级别: 消息内容
        winston.format.printf(info => {
            const date = new Date(info.timestamp);
            const time = date.toTimeString().split(' ')[0];
            return `[${time}] ${info.level}: ${info.message}`;
        })
    ),
    // 配置日志传输器，将日志输出到控制台
    transports: [new winston.transports.Console()],
});

// 导出日志记录器实例供其他模块使用
module.exports = logger;

// 统一的日志前缀常量
const LOG_PREFIXES = {
    INDEXING_WORKER: '[INDEXING-WORKER]',
    THUMB_POOL: '[ThumbPool]',
    CONFIG: '[CONFIG]',
    SERVER: '[SERVER]',
    MAIN_THREAD: '[Main-Thread]',
    SSE: '[SSE]',
    CACHE: '[Cache]',
    ADAPTIVE: '[Adaptive]',
    WORKER_HEALTH: '[WorkerHealth]',
    TASK_SCHEDULER: '[TaskScheduler]',
    THUMBNAIL_CLEANUP: '[THUMBNAIL CLEANUP]',
    THUMB: '[THUMB]',
    MEMORY_MONITOR: '[内存监控]',
    FREQUENCY_CONTROL: '[频率控制]',
    缩略图请求: '[缩略图请求]',
    批量补全: '[批量补全]',
    手动补全: '[手动补全]',
    按需队列: '[按需队列]',
    按需生成: '[按需生成]',
    批量补全: '[批量补全]',
    频率控制: '[频率控制]',
    TEMP_FILE_MANAGER: '[TempFileManager]',
    DB_TIMEOUT_MANAGER: '[DbTimeoutManager]',
    ORCHESTRATOR: '[Orchestrator]'
};

// 统一的日志格式化函数
function formatLog(prefix, message) {
    return `${prefix} ${message}`;
}

// 导出日志格式化工具
module.exports.LOG_PREFIXES = LOG_PREFIXES;
module.exports.formatLog = formatLog;