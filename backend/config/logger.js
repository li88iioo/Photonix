/**
 * 日志配置模块
 * 使用winston库配置应用程序的日志记录功能
 */
const winston = require('winston');
const { LOG_LEVEL } = require('./index');

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
        // 自定义日志输出格式：[时间戳] 级别: 消息内容
        winston.format.printf(info => `[${info.timestamp}] ${info.level}: ${info.message}`)
    ),
    // 配置日志传输器，将日志输出到控制台
    transports: [new winston.transports.Console()],
});

// 导出日志记录器实例供其他模块使用
module.exports = logger;