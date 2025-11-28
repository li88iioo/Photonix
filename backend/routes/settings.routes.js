/**
 * 设置管理路由模块
 * 处理系统设置相关的API请求，包括获取、更新和状态查询
 */
const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settings.controller');
const { validate, Joi, asyncHandler } = require('../middleware/validation');
const { requirePermission, PERMISSIONS } = require('../middleware/permissions');

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
  AI_DAILY_LIMIT: Joi.alternatives().try(
    Joi.number().integer().min(1).max(10000),
    Joi.string().pattern(/^\d+$/)
  ).optional(),

  // 敏感字段（控制器过滤，不入库），这里允许透传给业务层使用
  AI_KEY: Joi.string().max(4096).optional(),
  OPENAI_API_KEY: Joi.string().max(4096).optional(),

  // 密码相关
  newPassword: Joi.string().min(4).max(256).optional(),
  adminSecret: Joi.string().min(4).max(256).allow('').optional()
}).unknown(false);

const manualSyncSchema = Joi.object({
  adminSecret: Joi.string().min(4).max(256).required()
}).unknown(false);

const toggleDeletionSchema = Joi.object({
  enabled: Joi.boolean().required(),
  adminSecret: Joi.string().min(4).max(256).required()
}).unknown(false);

const updateScheduleSchema = Joi.object({
  schedule: Joi.string().trim().min(1).max(120).required(),
  adminSecret: Joi.string().min(4).max(256).required()
}).unknown(false);

const verifySecretSchema = Joi.object({
  adminSecret: Joi.string().min(4).max(256).required()
}).unknown(false);

const resetPasswordSchema = Joi.object({
  adminSecret: Joi.string().min(4).max(256).required(),
  newPassword: Joi.string().min(4).max(256).required()
}).unknown(false);

router.post('/', validate(updateSettingsSchema), asyncHandler(settingsController.updateSettings));          // 更新系统设置
router.get('/status', asyncHandler(settingsController.getSettingsUpdateStatus)); // 获取设置更新状态
router.post('/reset-password', validate(resetPasswordSchema), asyncHandler(settingsController.resetPasswordViaAdminSecret));

// 状态表相关接口
router.get('/status-tables', asyncHandler(settingsController.getStatusTables));          // 获取状态表信息
router.post('/sync/:type', requirePermission(PERMISSIONS.GENERATE_THUMBNAILS), asyncHandler(settingsController.triggerSync));                // 触发补全操作
router.post('/cleanup/:type', requirePermission(PERMISSIONS.GENERATE_THUMBNAILS), asyncHandler(settingsController.triggerCleanup));           // 触发同步操作（删除冗余文件）
router.post('/resync/thumbnails', requirePermission(PERMISSIONS.GENERATE_THUMBNAILS), asyncHandler(settingsController.resyncThumbnails));    // 重新同步缩略图状态
router.post('/manage/manual-sync', requirePermission(PERMISSIONS.GENERATE_THUMBNAILS), validate(manualSyncSchema), asyncHandler(settingsController.manualAlbumSync));
router.post('/manage/delete-toggle', requirePermission(PERMISSIONS.GENERATE_THUMBNAILS), validate(toggleDeletionSchema), asyncHandler(settingsController.toggleAlbumDeletion));
router.post('/manage/update-schedule', requirePermission(PERMISSIONS.GENERATE_THUMBNAILS), validate(updateScheduleSchema), asyncHandler(settingsController.updateManualSyncSchedule));
router.post('/manage/verify-secret', requirePermission(PERMISSIONS.GENERATE_THUMBNAILS), validate(verifySecretSchema), asyncHandler(settingsController.verifyAdminSecretOnly));

// 导出设置路由模块
module.exports = router;
