const Joi = require('joi');
const { ValidationError } = require('../utils/errors');

/**
 * 字段与中文标签的映射，用于消息翻译
 */
const FIELD_LABEL_MAP = {
  adminSecret: '管理员密钥',
  newPassword: '新密码',
  enabled: '启用状态',
  schedule: '自动维护计划',
  AI_URL: 'AI 地址',
  AI_MODEL: 'AI 模型',
  AI_PROMPT: 'AI 提示词',
  AI_KEY: 'AI 密钥'
};

/**
 * 翻译 Joi 校验错误信息为用户友好的中文格式
 * @param {Object} detail Joi 的错误详情对象
 * @returns {string} 翻译后的错误信息
 */
function translateJoiMessage(detail) {
  if (!detail || typeof detail.message !== 'string') {
    return '参数校验失败';
  }

  let message = detail.message;

  // 替换字段名为中文标签
  Object.entries(FIELD_LABEL_MAP).forEach(([field, label]) => {
    const pattern = new RegExp(`"${field}"`, 'g');
    message = message.replace(pattern, label);
  });

  // 翻译常见的 Joi 校验提示语为中文
  message = message
    .replace(/length must be at least (\d+) characters long/g, '长度至少为 $1 个字符')
    .replace(/length must be less than or equal to (\d+) characters long/g, '长度最多为 $1 个字符')
    .replace(/is required/g, '为必填项')
    .replace(/must be a string/g, '必须为字符串')
    .replace(/must be a boolean/g, '必须为布尔值')
    .replace(/must be an? array/g, '必须为数组')
    .replace(/must be a number/g, '必须为数字');

  return message;
}

/**
 * 通用异步错误包装器，将异步异常交给全局错误处理中间件
 * @param {Function} fn 需要包装的异步处理函数
 * @returns {Function} 包装后的中间件函数
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 校验中间件工厂，生成校验中间件
 * @param {Joi.Schema} schema Joi 校验规则
 * @param {string} property 校验的请求数据属性（如 body, query, params）
 * @returns {Function} Express 中间件
 */
function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], { abortEarly: false, stripUnknown: true });
    if (error) {
      // 翻译和整理所有错误详情
      const translatedDetails = error.details.map((detail) => {
        const translatedMessage = translateJoiMessage(detail);
        return {
          path: detail.path,
          message: translatedMessage,
          originalMessage: detail.message
        };
      });
      // 汇总所有错误信息
      const combinedMessage = translatedDetails.length > 0
        ? translatedDetails.map(d => d.message).join('；')
        : '参数校验失败';
      return next(new ValidationError(combinedMessage, translatedDetails));
    }
    req[property] = value; // 使用 Joi 处理后的（过滤未知字段等）数据
    next();
  };
}

module.exports = {
    validate,
    Joi,
    asyncHandler
};
