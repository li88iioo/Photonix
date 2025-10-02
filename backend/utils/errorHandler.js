/**
 * 统一的错误处理工具
 * 提供标准化的错误处理和日志记录
 */

const logger = require('../config/logger');

/**
 * 静默处理错误 - 只记录警告日志
 * @param {Error} error - 错误对象
 * @param {string} context - 错误上下文描述
 * @param {string} level - 日志级别 (debug|info|warn|error)
 */
function silentErrorHandler(error, context = '', level = 'warn') {
    if (!error) return;

    const message = error.message || String(error);
    const logMessage = context ? `${context}: ${message}` : message;

    switch (level) {
        case 'debug':
            logger?.debug?.(logMessage);
            break;
        case 'info':
            logger?.info?.(logMessage);
            break;
        case 'error':
            logger?.error?.(logMessage);
            break;
        case 'warn':
        default:
            logger?.warn?.(logMessage);
            break;
    }
}

/**
 * 创建带日志的错误处理器
 * @param {string} context - 错误上下文描述
 * @param {string} level - 日志级别
 * @returns {Function} 错误处理函数
 */
function createErrorHandler(context, level = 'warn') {
    return (error) => silentErrorHandler(error, context, level);
}

/**
 * 安全执行异步函数，静默处理错误
 * @param {Function} fn - 要执行的异步函数
 * @param {string} context - 错误上下文描述
 * @param {string} level - 日志级别
 * @returns {Promise} 执行结果，如果出错返回undefined
 */
async function safeExecute(fn, context = '', level = 'warn') {
    try {
        return await fn();
    } catch (error) {
        silentErrorHandler(error, context, level);
        return undefined;
    }
}

/**
 * 安全执行同步函数，静默处理错误
 * @param {Function} fn - 要执行的同步函数
 * @param {string} context - 错误上下文描述
 * @param {string} level - 日志级别
 * @returns {*} 执行结果，如果出错返回undefined
 */
function safeExecuteSync(fn, context = '', level = 'warn') {
    try {
        return fn();
    } catch (error) {
        silentErrorHandler(error, context, level);
        return undefined;
    }
}

/**
 * 服务错误边界 - 包装服务函数，提供错误处理和日志记录
 * @param {Function} fn - 要包装的异步函数
 * @param {Object} options - 配置选项
 * @param {string} options.context - 错误上下文描述
 * @param {*} options.fallbackResult - 出错时的默认返回值
 * @param {boolean} options.logError - 是否记录错误日志
 * @returns {Function} 包装后的函数
 */
function withServiceErrorBoundary(fn, options = {}) {
    const { context = 'Service', fallbackResult = null, logError = true } = options;

    return async (...args) => {
        try {
            return await fn(...args);
        } catch (error) {
            if (logError) {
                silentErrorHandler(error, `${context} error`, 'warn');
            }
            return fallbackResult;
        }
    };
}

/**
 * 数据库错误边界 - 包装数据库操作，提供错误处理和日志记录
 * @param {Function} fn - 要包装的异步函数
 * @param {Object} options - 配置选项
 * @param {string} options.context - 错误上下文描述
 * @param {*} options.fallbackResult - 出错时的默认返回值
 * @param {boolean} options.logError - 是否记录错误日志
 * @returns {Function} 包装后的函数
 */
function withDatabaseErrorBoundary(fn, options = {}) {
    const { context = 'Database', fallbackResult = null, logError = true } = options;

    return async (...args) => {
        try {
            return await fn(...args);
        } catch (error) {
            if (logError) {
                silentErrorHandler(error, `${context} error`, 'error');
            }
            return fallbackResult;
        }
    };
}

module.exports = {
    silentErrorHandler,
    createErrorHandler,
    safeExecute,
    safeExecuteSync,
    withServiceErrorBoundary,
    withDatabaseErrorBoundary
};