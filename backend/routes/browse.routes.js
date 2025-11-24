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
// 文件浏览路由（缓存缩短至 180 秒，强化与前端 TTL 的一致性）
// 使用通配符 `*` 捕获所有路径，支持任意深度的目录浏览
// 缓存时间可通过环境变量 BROWSE_CACHE_TTL 覆盖，默认 180 秒
const browseQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(200).optional(),
  page: Joi.number().integer().min(1).max(100000).optional(),
  sort: Joi.string().valid('smart','name_asc','name_desc','mtime_asc','mtime_desc').optional()
});

const BROWSE_CACHE_TTL = Number(process.env.BROWSE_CACHE_TTL || 180);

// 使用 validatePath 中间件处理来自 req.params 的路径
router.get(
  '/*',
  validate(browseQuerySchema, 'query'),
  validatePath('param'),
  cache(BROWSE_CACHE_TTL),
  asyncHandler(browseController.browseDirectory)
);

// 导出浏览路由模块
module.exports = router;