const Joi = require('joi');

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
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: '参数校验失败', details });
    }
    req[property] = value;
    next();
  };
}

module.exports = { validate, Joi, asyncHandler };


