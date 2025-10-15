/**
 * 统一错误类体系
 * 提供结构化、可分类的错误处理
 * 
 * @module errors
 */

/**
 * 基础应用错误类
 */
class AppError extends Error {
    constructor(message, statusCode = 500, errorCode = 'INTERNAL_ERROR', details = null) {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.details = details;
        this.isOperational = true; // 标记为可预期的业务错误
        Error.captureStackTrace(this, this.constructor);
    }

    toJSON() {
        return {
            error: {
                code: this.errorCode,
                message: this.message,
                details: this.details,
                statusCode: this.statusCode
            }
        };
    }
}

/**
 * 验证错误 (400)
 */
class ValidationError extends AppError {
    constructor(message, details = null) {
        super(message, 400, 'VALIDATION_ERROR', details);
    }
}

/**
 * 认证错误 (401)
 */
class AuthenticationError extends AppError {
    constructor(message = '未授权访问', details = null) {
        super(message, 401, 'AUTHENTICATION_ERROR', details);
    }
}

/**
 * 权限错误 (403)
 */
class AuthorizationError extends AppError {
    constructor(message = '权限不足', details = null) {
        super(message, 403, 'AUTHORIZATION_ERROR', details);
    }
}

/**
 * 资源不存在 (404)
 */
class NotFoundError extends AppError {
    constructor(resource = '资源', details = null) {
        super(`${resource}不存在`, 404, 'NOT_FOUND', details);
    }
}

/**
 * 冲突错误 (409)
 */
class ConflictError extends AppError {
    constructor(message = '资源冲突', details = null) {
        super(message, 409, 'CONFLICT', details);
    }
}

/**
 * 业务逻辑错误 (422)
 */
class BusinessLogicError extends AppError {
    constructor(message, errorCode = 'BUSINESS_LOGIC_ERROR', details = null) {
        super(message, 422, errorCode, details);
    }
}

/**
 * 请求过多 (429)
 */
class TooManyRequestsError extends AppError {
    constructor(message = '请求过于频繁', retryAfter = null) {
        super(message, 429, 'TOO_MANY_REQUESTS', { retryAfter });
    }
}

/**
 * 服务不可用 (503)
 */
class ServiceUnavailableError extends AppError {
    constructor(service = '服务', details = null) {
        super(`${service}暂时不可用`, 503, 'SERVICE_UNAVAILABLE', details);
    }
}

/**
 * 外部服务错误 (502)
 */
class ExternalServiceError extends AppError {
    constructor(service = '外部服务', details = null) {
        super(`${service}错误`, 502, 'EXTERNAL_SERVICE_ERROR', details);
    }
}

/**
 * 数据库错误 (500)
 */
class DatabaseError extends AppError {
    constructor(message = '数据库操作失败', details = null) {
        super(message, 500, 'DATABASE_ERROR', details);
    }
}

/**
 * 文件系统错误 (500)
 */
class FileSystemError extends AppError {
    constructor(message = '文件操作失败', details = null) {
        super(message, 500, 'FILESYSTEM_ERROR', details);
    }
}

/**
 * 超时错误 (408/504)
 */
class TimeoutError extends AppError {
    constructor(operation = '操作', isGateway = false) {
        const statusCode = isGateway ? 504 : 408;
        const errorCode = isGateway ? 'GATEWAY_TIMEOUT' : 'REQUEST_TIMEOUT';
        super(`${operation}超时`, statusCode, errorCode);
    }
}

/**
 * 资源耗尽错误 (507)
 */
class ResourceExhaustedError extends AppError {
    constructor(resource = '资源', details = null) {
        super(`${resource}耗尽`, 507, 'RESOURCE_EXHAUSTED', details);
    }
}

/**
 * 配置错误 (500)
 */
class ConfigurationError extends AppError {
    constructor(message = '配置错误', details = null) {
        super(message, 500, 'CONFIGURATION_ERROR', details);
    }
}

/**
 * 判断是否为可操作错误（业务错误）
 */
function isOperationalError(error) {
    if (error instanceof AppError) {
        return error.isOperational;
    }
    return false;
}

/**
 * 从原生错误转换为AppError
 */
function fromNativeError(error, context = null) {
    // 已经是AppError，直接返回
    if (error instanceof AppError) {
        return error;
    }

    // SQLite错误
    if (error.code === 'SQLITE_BUSY' || error.message?.includes('database is locked')) {
        return new DatabaseError('数据库繁忙，请稍后重试', { 
            originalError: error.message,
            context 
        });
    }

    if (error.code?.startsWith('SQLITE_')) {
        return new DatabaseError('数据库操作失败', { 
            originalError: error.message,
            sqliteCode: error.code,
            context 
        });
    }

    // 文件系统错误
    if (error.code === 'ENOENT') {
        return new NotFoundError('文件或目录', { 
            path: error.path,
            context 
        });
    }

    if (error.code === 'EACCES' || error.code === 'EPERM') {
        return new FileSystemError('文件访问被拒绝', { 
            path: error.path,
            code: error.code,
            context 
        });
    }

    if (error.code === 'ENOSPC') {
        return new ResourceExhaustedError('磁盘空间', { 
            path: error.path,
            context 
        });
    }

    // 网络错误
    if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') {
        return new TimeoutError('网络请求');
    }

    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        return new ExternalServiceError('网络服务', { 
            originalError: error.message,
            code: error.code 
        });
    }

    // JWT错误
    if (error.name === 'JsonWebTokenError') {
        return new AuthenticationError('无效的认证令牌', { 
            originalError: error.message 
        });
    }

    if (error.name === 'TokenExpiredError') {
        return new AuthenticationError('认证令牌已过期', { 
            expiredAt: error.expiredAt 
        });
    }

    // 默认转换为通用AppError
    return new AppError(
        error.message || '未知错误',
        500,
        'INTERNAL_ERROR',
        { originalError: error.toString(), context }
    );
}

module.exports = {
    // 基础类
    AppError,
    
    // 客户端错误 (4xx)
    ValidationError,
    AuthenticationError,
    AuthorizationError,
    NotFoundError,
    ConflictError,
    BusinessLogicError,
    TooManyRequestsError,
    TimeoutError,
    
    // 服务端错误 (5xx)
    ServiceUnavailableError,
    ExternalServiceError,
    DatabaseError,
    FileSystemError,
    ResourceExhaustedError,
    ConfigurationError,
    
    // 工具函数
    isOperationalError,
    fromNativeError
};
