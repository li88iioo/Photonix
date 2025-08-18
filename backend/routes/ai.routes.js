/**
 * AI功能路由模块
 * 处理AI相关的API请求，包括图片标题生成和任务状态查询
 */
const express = require('express');
const router = express.Router();
const aiController = require('../controllers/ai.controller');
const apiLimiter = require('../middleware/rateLimiter');
const { validate, Joi, asyncHandler } = require('../middleware/validation');
const aiRateGuard = require('../middleware/ai-rate-guard');

// AI标题生成路由
// 接收图片路径和AI配置，创建异步任务生成图片描述
// 生成接口参数校验
const generateSchema = Joi.object({
  image_path: Joi.string().min(1).max(2048).custom((value, helpers) => {
    if (value.includes('..')) return helpers.error('any.invalid');
    return value;
  }, 'path traversal guard').required(),
  aiConfig: Joi.object({
    url: Joi.string().uri({ allowRelative: false }).max(2048).required(),
    key: Joi.string().min(1).max(4096).required(),
    model: Joi.string().min(1).max(256).required(),
    prompt: Joi.string().min(1).max(4000).required()
  }).required()
});

// 为生成接口增加更严格的速率限制（在全局限速之外叠加，防止滥用）
router.post('/generate', apiLimiter, aiRateGuard, validate(generateSchema), asyncHandler(aiController.generateCaption));

// AI任务状态查询路由
// 根据任务ID查询AI处理任务的状态和结果
router.get('/job/:jobId', asyncHandler(aiController.getJobStatus));

// 导出AI路由模块
module.exports = router;