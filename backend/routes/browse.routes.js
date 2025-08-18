/**
 * 文件浏览路由模块
 * 处理文件目录浏览相关的API请求，支持缓存和访问时间记录
 */
const express = require('express');
const router = express.Router();
const browseController = require('../controllers/browse.controller');
const { cache } = require('../middleware/cache');
const { validate, Joi, asyncHandler } = require('../middleware/validation');

const validatePath = require('../middleware/pathValidator');

// 更新文件访问时间的专用路由（不缓存）
// 用于记录用户查看特定文件或目录的时间
const viewedSchema = Joi.object({
  path: Joi.string()
    .min(1)
    .max(2048)
    // 这里的 custom 校验与 pathValidator 重复，但作为 Joi 层的第一道防线保留是好的实践
    .custom((v,h)=> v.includes('..') ? h.error('any.invalid') : v, 'path traversal guard')
    .required()
});

// 使用 validatePath 中间件处理来自 req.body 的路径
router.post('/viewed', validate(viewedSchema), validatePath('body'), asyncHandler(browseController.updateViewTime));

// 文件浏览路由（缓存10分钟）
// 使用通配符 `*` 捕获所有路径，支持任意深度的目录浏览
// 缓存时间设置为600秒（10分钟），提高响应速度
const browseQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(200).optional(),
  page: Joi.number().integer().min(1).max(100000).optional(),
  sort: Joi.string().valid('smart','name_asc','name_desc','mtime_asc','mtime_desc','viewed_desc').optional()
});

// 使用 validatePath 中间件处理来自 req.params 的路径
router.get('/*', validate(browseQuerySchema, 'query'), validatePath('param'), cache(600), asyncHandler(browseController.browseDirectory));

// 导出浏览路由模块
module.exports = router;