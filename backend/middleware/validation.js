const Joi = require('joi');

// 自定义错误类
class AppError extends Error {
    constructor(code, message, statusCode = 500, isOperational = true) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
        this.isOperational = isOperational; // 是否为可预期的操作错误

        Error.captureStackTrace(this, this.constructor);
    }
}

// 数据库错误类
class DatabaseError extends AppError {
    constructor(message, originalError = null) {
        super('DATABASE_ERROR', message, 500);
        this.originalError = originalError;
    }
}

// 验证错误类
class ValidationError extends AppError {
    constructor(message, details = null) {
        super('VALIDATION_ERROR', message, 400);
        this.details = details;
    }
}

// 权限错误类
class AuthorizationError extends AppError {
    constructor(message = '未授权访问') {
        super('UNAUTHORIZED', message, 401);
    }
}

// 文件系统错误类
class FileSystemError extends AppError {
    constructor(message, path = null) {
        super('FILESYSTEM_ERROR', message, 500);
        this.path = path;
    }
}

// 通用异步错误包装器，统一交给全局错误处理中间件
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], { abortEarly: false, stripUnknown: true });
    if (error) {
      const details = error.details.map(d => ({ message: d.message, path: d.path }));
      const validationError = new ValidationError('参数校验失败', details);
      return next(validationError);
    }
    req[property] = value;
    next();
  };
}

module.exports = {
    validate,
    Joi,
    asyncHandler,
    AppError,
    DatabaseError,
    ValidationError,
    AuthorizationError,
    FileSystemError
};


