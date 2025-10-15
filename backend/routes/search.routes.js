/**
 * 搜索路由模块
 * 处理文件搜索相关的API请求，支持全文搜索和结果缓存
 */
const express = require('express');
const router = express.Router();
const searchController = require('../controllers/search.controller');
const { cache } = require('../middleware/cache');
const { validate, Joi, asyncHandler } = require('../middleware/validation');
const { requirePermission, PERMISSIONS } = require('../middleware/permissions');
const { validateInput, VALIDATION_RULES } = require('../middleware/inputValidation');

// 搜索参数校验
const searchSchema = Joi.object({
  q: Joi.string().trim().min(1).max(100).required(),
  page: Joi.number().integer().min(1).max(1000).optional(),
  limit: Joi.number().integer().min(1).max(200).optional()
});

// 搜索功能路由（缓存缩短至 180 秒，与前端 SW TTL 对齐）
// 可通过 SEARCH_CACHE_TTL 环境变量覆盖默认缓存时长
const SEARCH_CACHE_TTL = Number(process.env.SEARCH_CACHE_TTL || 180);

router.get('/',
    validateInput(VALIDATION_RULES.searchQuery),
    requirePermission(PERMISSIONS.SEARCH_FILES),
    validate(searchSchema, 'query'),
    cache(SEARCH_CACHE_TTL),
    asyncHandler(searchController.searchItems)
);

// 导出搜索路由模块
module.exports = router;