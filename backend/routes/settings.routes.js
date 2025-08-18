/**
 * 设置管理路由模块
 * 处理系统设置相关的API请求，包括获取、更新和状态查询
 */
const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settings.controller');
const { validate, Joi, asyncHandler } = require('../middleware/validation');

// 定义获取和更新设置的路由端点
router.get('/', asyncHandler(settingsController.getSettingsForClient));     // 获取客户端设置

// 更新系统设置（禁止持久化 AI_KEY/OPENAI_API_KEY，控制器内已过滤）
const updateSettingsSchema = Joi.object({
  // 布尔字符串开关
  AI_ENABLED: Joi.string().valid('true','false').optional(),
  PASSWORD_ENABLED: Joi.string().valid('true','false').optional(),
  ALLOW_PUBLIC_ACCESS: Joi.string().valid('true','false').optional(),

  // 文本配置
  AI_URL: Joi.string().uri({ allowRelative: false }).max(2048).optional(),
  AI_MODEL: Joi.string().max(256).optional(),
  AI_PROMPT: Joi.string().max(4000).optional(),

  // 敏感字段（控制器过滤，不入库），这里允许透传给业务层使用
  AI_KEY: Joi.string().max(4096).optional(),
  OPENAI_API_KEY: Joi.string().max(4096).optional(),

  // 密码相关
  newPassword: Joi.string().min(4).max(256).optional(),
  adminSecret: Joi.string().min(4).max(256).allow('').optional()
}).unknown(false);

router.post('/', validate(updateSettingsSchema), asyncHandler(settingsController.updateSettings));          // 更新系统设置
router.get('/status', asyncHandler(settingsController.getSettingsUpdateStatus)); // 获取设置更新状态

// 导出设置路由模块
module.exports = router;