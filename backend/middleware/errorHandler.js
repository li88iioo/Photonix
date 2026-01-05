/**
 * @file errorHandler.js
 * @module errorHandler
 * @description 全局统一错误处理中间件，捕获并格式化所有应用错误，支持异步和404处理，以及未捕获异常与Promise拒绝处理
 */

const logger = require('../config/logger');
const { AppError, isOperationalError, fromNativeError } = require('../utils/errors');

/**
 * 全局错误处理中间件
 * @function errorHandler
 * @param {Error} err - 捕获到的错误对象
 * @param {import('express').Request} req - Express 请求对象
 * @param {import('express').Response} res - Express 响应对象
 * @param {Function} next - 下一中间件回调
 * @returns {void}
 */
function errorHandler(err, req, res, next) {
    // 转换为 AppError 实例
    let error = err instanceof AppError ? err : fromNativeError(err);

    // 记录错误日志
    logError(error, req);

    // 检查是否为开发环境
    const isDevelopment = process.env.NODE_ENV !== 'production';

    /**
     * 构建基础响应体
     * @type {{success: boolean, error: {code: string, message: string, requestId: string, details?:any, stack?:string}}}
     */
    const response = {
        success: false,
        error: {
            code: error.errorCode || 'INTERNAL_ERROR',
            message: error.message,
            requestId: req.requestId
        }
    };

    // 开发环境下附加详细错误堆栈和details
    if (isDevelopment) {
        response.error.details = error.details;
        response.error.stack = error.stack;
    } else {
        // 生产环境下隐藏详细错误，非操作性错误统一消息
        if (!isOperationalError(error)) {
            response.error.message = '服务器内部错误，请稍后重试';
        }
    }

    // 针对特定错误码设置响应头，如限流
    if (error.statusCode === 429 && error.details?.retryAfter) {
        res.setHeader('Retry-After', error.details.retryAfter);
    }

    // 返回JSON错误响应
    res.status(error.statusCode || 500).json(response);
}

/**
 * 记录错误日志，根据错误级别选择记录级别
 * @function logError
 * @param {AppError} error - 错误对象
 * @param {import('express').Request} req - 请求对象
 * @returns {void}
 */
function logError(error, req) {
    if (shouldSkipAuditedAdminSecretError(error)) {
        return;
    }
    const logContext = {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        ip: req.ip,
        errorCode: error.errorCode,
        statusCode: error.statusCode
    };

    const { LOG_PREFIXES } = logger;

    if (error?.errorCode === 'EXTERNAL_SERVICE_ERROR') {
        logger.warn(LOG_PREFIXES.REQUEST_ERROR + ` ${error.message}`, {
            ...logContext,
            details: error.details
        });
    } else if (error.statusCode >= 500) {
        // 服务端错误 - 记录为 ERROR
        logger.error(LOG_PREFIXES.SYSTEM_ERROR + ` ${error.message}`, {
            ...logContext,
            stack: error.stack,
            details: error.details
        });
    } else if (error.statusCode >= 400) {
        // 客户端错误 - 记录为 WARN
        logger.warn(LOG_PREFIXES.REQUEST_ERROR + ` ${error.message}`, logContext);
    } else {
        // 其他 - INFO 级别
        logger.info(LOG_PREFIXES.REQUEST + ` ${error.message}`, logContext);
    }
}

function shouldSkipAuditedAdminSecretError(error) {
    return error?.errorCode === 'AUTHORIZATION_ERROR'
        && error?.details?.audited
        && error?.details?.auditReason === '管理员密钥错误';
}

/**
 * 处理未捕获的异常（process.on('uncaughtException')）
 * @function handleUncaughtException
 * @param {Error} error - 未捕获异常对象
 * @returns {void}
 */
function handleUncaughtException(error) {
    logger.error('未捕获的异常:', {
        error: error.message,
        stack: error.stack
    });

    // 确保日志输出，延迟后安全退出进程
    setTimeout(() => {
        process.exit(1);
    }, 1000);
}

/**
 * 处理未处理的Promise拒绝（process.on('unhandledRejection')）
 * @function handleUnhandledRejection
 * @param {*} reason - 拒绝原因
 * @param {Promise} promise - 被拒绝的Promise
 * @returns {void}
 */
function handleUnhandledRejection(reason, promise) {
    logger.error('未处理的Promise拒绝:', {
        reason: reason?.message || reason,
        stack: reason?.stack
    });
}

/**
 * 404路由未找到中间件
 * @function notFoundHandler
 * @param {import('express').Request} req - Express请求对象
 * @param {import('express').Response} res - Express响应对象
 * @param {Function} next - 下一中间件
 * @returns {void}
 */
function notFoundHandler(req, res, next) {
    const { NotFoundError } = require('../utils/errors');
    next(new NotFoundError(`路径 ${req.path}`));
}

/**
 * 异步中间件包装器，自动将异常交由统一错误处理中间件处理
 * @function asyncHandler
 * @param {Function} fn - 需要包装的异步函数
 * @returns {Function} Express兼容的中间件函数
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = {
    errorHandler,
    notFoundHandler,
    asyncHandler,
    handleUncaughtException,
    handleUnhandledRejection
};
