/**
 * @file download.routes.js
 * @description 图片下载服务相关API路由定义
 */

const express = require('express');
const router = express.Router();

const downloadController = require('../controllers/download.controller');
const { validate, Joi, asyncHandler } = require('../middleware/validation');
const optionalAuth = require('../middleware/optional-auth'); // 可选JWT认证中间件

// 管理员身份查询参数校验
const adminQuerySchema = Joi.object({
  adminSecret: Joi.string().min(1).max(4096).optional()
}).unknown(true);

const previewQuerySchema = adminQuerySchema.keys({
  limit: Joi.number().integer().min(1).max(50).optional()
});

const paginatedQuerySchema = adminQuerySchema.keys({
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).max(500).optional()
});

// 任务列表查询参数校验
const taskListQuerySchema = Joi.object({
  adminSecret: Joi.string().min(1).max(4096).optional(),
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).max(500).optional(),
  status: Joi.string().max(64).optional(),
  search: Joi.string().max(256).optional(),
  feed: Joi.string().max(256).optional()
}).unknown(true);

// 任务创建/更新通用参数校验
const taskMutationSchema = Joi.object({
  adminSecret: Joi.string().min(1).max(4096).optional(),
  cookie: Joi.string().max(4096).allow('').optional(),
  cookieDomain: Joi.string().max(256).allow('').optional()
}).unknown(true);

const selectionMutationSchema = Joi.object({
  adminSecret: Joi.string().min(1).max(4096).optional(),
  entries: Joi.array().items(Joi.string().min(1).max(2048)).min(1).optional(),
  links: Joi.array().items(Joi.string().min(1).max(2048)).min(1).optional(),
  force: Joi.boolean().optional()
}).or('entries', 'links').unknown(false);

// 配置更新参数校验
const configMutationSchema = Joi.object({
  adminSecret: Joi.string().min(1).max(4096).optional(),
  baseFolder: Joi.string().max(1024).optional(),
  dbFile: Joi.string().max(1024).optional(),
  opmlFile: Joi.string().max(1024).optional(),
  errorLogFile: Joi.string().max(1024).optional(),
  skipFeeds: Joi.alternatives(
    Joi.array().items(Joi.string().max(256)),
    Joi.string().allow('')
  ).optional(),
  allowFallbackToSourceSite: Joi.boolean().optional(),
  imageValidation: Joi.object({
    enabled: Joi.boolean().optional(),
    strictMode: Joi.boolean().optional()
  }).optional(),
  maxConcurrentFeeds: Joi.number().integer().min(1).max(20).optional(),
  maxConcurrentDownloads: Joi.number().integer().min(1).max(50).optional(),
  requestTimeout: Joi.number().min(5).max(600).optional(),
  connectTimeout: Joi.number().min(1).max(120).optional(),
  readTimeout: Joi.number().min(1).max(600).optional(),
  minImageBytes: Joi.number().integer().min(0).optional(),
  minImageWidth: Joi.number().integer().min(0).optional(),
  minImageHeight: Joi.number().integer().min(0).optional(),
  retryDelay: Joi.number().min(1).max(600).optional(),
  maxRetries: Joi.number().integer().min(1).max(20).optional(),
  paginationDelay: Joi.array().items(Joi.number().min(0)).length(2).optional(),
  dedupScope: Joi.string().valid('global', 'per_feed', 'by_link').optional(),
  security: Joi.object({
    requestInterval: Joi.array().items(Joi.number().min(0)).length(2).optional()
  }).optional(),
  throttler: Joi.object({
    baseLimit: Joi.number().integer().min(1).optional(),
    minLimit: Joi.number().integer().min(1).optional(),
    maxLimit: Joi.number().integer().min(1).optional(),
    baseDelay: Joi.number().min(0).optional(),
    maxDelay: Joi.number().min(0).optional(),
    decay: Joi.number().min(0).max(1).optional()
  }).optional(),
  proxies: Joi.array().items(Joi.string().max(512)).optional(),
  domainProxies: Joi.object().pattern(/.*/, Joi.alternatives(Joi.string(), Joi.array().items(Joi.string()))).optional(),
  requestHeaders: Joi.object().pattern(/.*/, Joi.string().max(512)).optional(),
  imageHeaders: Joi.object().pattern(/.*/, Joi.string().max(512)).optional()
}).unknown(true);

// 任务操作：路径参数校验
const taskActionParamsSchema = Joi.object({
  taskId: Joi.string().min(1).max(256).required(),
  action: Joi.string().min(1).max(64).required()
});

// 任务ID路径参数校验
const taskIdParamsSchema = Joi.object({
  taskId: Joi.string().min(1).max(256).required()
});

const opmlImportSchema = Joi.object({
  adminSecret: Joi.string().min(1).max(4096).optional(),
  content: Joi.string().min(10).required(),
  mode: Joi.string().valid('merge', 'replace').optional()
}).unknown(false);

/**
 * @route GET /download/status
 * @desc 获取下载服务运行状态
 */
router.get('/status', optionalAuth, validate(adminQuerySchema, 'query'), asyncHandler(downloadController.getServiceStatus));

/**
 * @route GET /download/history
 * @desc 分页获取下载历史
 */
router.get('/history', optionalAuth, validate(paginatedQuerySchema, 'query'), asyncHandler(downloadController.getHistory));

/**
 * @route GET /download/tasks
 * @desc 获取图片下载任务列表
 */
router.get('/tasks', optionalAuth, validate(taskListQuerySchema, 'query'), asyncHandler(downloadController.listTasks));

/**
 * @route POST /download/tasks
 * @desc 创建新的下载任务
 */
router.post('/tasks', optionalAuth, validate(taskMutationSchema), asyncHandler(downloadController.createTask));

/**
 * @route PATCH /download/tasks/:taskId
 * @desc 更新指定下载任务
 */
router.patch(
  '/tasks/:taskId',
  optionalAuth,
  validate(taskIdParamsSchema, 'params'),
  validate(taskMutationSchema),
  asyncHandler(downloadController.updateTask)
);

router.get(
  '/tasks/:taskId/preview',
  optionalAuth,
  validate(taskIdParamsSchema, 'params'),
  validate(previewQuerySchema, 'query'),
  asyncHandler(downloadController.previewFeed)
);

router.post(
  '/tasks/:taskId/download',
  optionalAuth,
  validate(taskIdParamsSchema, 'params'),
  validate(selectionMutationSchema),
  asyncHandler(downloadController.downloadSelectedEntries)
);

/**
 * @route POST /download/tasks/:taskId/:action
 * @desc 对单个任务执行指定动作（如重试、暂停等）
 */
router.post(
  '/tasks/:taskId/:action',
  optionalAuth,
  validate(taskActionParamsSchema, 'params'),
  validate(taskMutationSchema),
  asyncHandler(downloadController.triggerTaskAction)
);

/**
 * @route DELETE /download/tasks/:taskId
 * @desc 删除指定下载任务
 */
router.delete(
  '/tasks/:taskId',
  optionalAuth,
  validate(taskIdParamsSchema, 'params'),
  asyncHandler(downloadController.deleteTask)
);

/**
 * @route GET /download/tasks/:taskId/logs
 * @desc 获取某任务的日志
 */
router.get(
  '/tasks/:taskId/logs',
  optionalAuth,
  validate(taskIdParamsSchema, 'params'),
  validate(taskListQuerySchema, 'query'),
  asyncHandler(downloadController.getTaskLogs)
);

/**
 * @route GET /download/logs
 * @desc 查询全局下载服务日志
 */
router.get('/logs', optionalAuth, validate(taskListQuerySchema, 'query'), asyncHandler(downloadController.getGlobalLogs));

/**
 * @route DELETE /download/logs
 * @desc 清空全局下载服务日志
 */
router.delete('/logs', optionalAuth, validate(taskMutationSchema), asyncHandler(downloadController.clearGlobalLogs));

/**
 * @route GET /download/config
 * @desc 获取下载服务配置
 */
router.get('/config', optionalAuth, validate(adminQuerySchema, 'query'), asyncHandler(downloadController.getConfig));

/**
 * @route PUT /download/config
 * @desc 更新下载服务配置
 */
router.put('/config', optionalAuth, validate(configMutationSchema), asyncHandler(downloadController.updateConfig));

/**
 * @route GET /download/opml
 * @desc 导出订阅 OPML 文件
 */
router.get('/opml', optionalAuth, validate(adminQuerySchema, 'query'), asyncHandler(downloadController.exportOpml));

/**
 * @route POST /download/opml
 * @desc 导入订阅 OPML 文件
 */
router.post('/opml', optionalAuth, validate(opmlImportSchema), asyncHandler(downloadController.importOpml));

module.exports = router;
