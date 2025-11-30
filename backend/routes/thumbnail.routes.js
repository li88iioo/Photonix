/**
 * 缩略图路由模块
 * 处理缩略图生成和获取相关的API请求
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const thumbnailController = require('../controllers/thumbnail.controller');
const { generateErrorSvg } = thumbnailController;
const { validate, Joi, asyncHandler } = require('../middleware/validation');
const { cache } = require('../middleware/cache');
const { requirePermission, PERMISSIONS } = require('../middleware/permissions');

// 注意：thumbnailController 内部会从 req.query.path 读取路径，需要特殊处理
// 创建一个适配器中间件将 query.path 复制到 req.body.path，以便 validatePath('body') 可以验证
const adaptQueryPathToBody = (req, res, next) => {
    if (req.query && req.query.path) {
        req.body = req.body || {};
        req.body.path = req.query.path;
    }
    next();
};

const validatePath = require('../middleware/pathValidator');

const thumbnailRateLimiter = rateLimit({
    windowMs: Math.max(500, Number(process.env.THUMBNAIL_RATE_WINDOW_MS || 1000)),
    max: Math.max(30, Number(process.env.THUMBNAIL_RATE_MAX_REQUESTS || 120)),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.user && req.user.id) {
            return `user:${req.user.id}`;
        }
        return req.ip || req.headers['x-forwarded-for'] || 'anonymous';
    },
    handler: (_req, res) => {
        const errorSvg = generateErrorSvg();
        res.set({
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'no-cache',
            'X-Rate-Limit': 'exceeded'
        });
        res.status(429).send(errorSvg);
    }
});

// 缩略图获取路由
// 根据查询参数中的文件路径生成或获取对应的缩略图
const thumbQuerySchema = Joi.object({
  path: Joi.string()
    .min(1)
    .max(2048)  // 与 pathValidator 的 MAX_PATH_LENGTH 保持一致，支持超长中文路径
    .custom((value, helpers) => {
      // 检查路径段是否为".."，而不是简单的includes('..')
      // 避免误判包含"..."的合法文件名（如"内容..._"）
      const segments = value.split(/[/\\]/).filter(Boolean);
      const hasTraversal = segments.some(seg => seg === '..' || seg === '.');
      return hasTraversal ? helpers.error('any.invalid') : value;
    }, 'path traversal guard')
    .required()
});

// 缩略图获取路由 - 需要查看权限
// 验证流程：Joi schema → adaptQueryPathToBody → validatePath → cache → controller
router.get('/',
    thumbnailRateLimiter,
    validate(thumbQuerySchema, 'query'),
    adaptQueryPathToBody,
    validatePath('body'),
    requirePermission(PERMISSIONS.VIEW_THUMBNAILS),
    cache(300),
    asyncHandler(thumbnailController.getThumbnail)
);

// 批量补全缩略图路由 - 需要生成权限
const batchSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(5000).optional(),
  loop: Joi.boolean().optional(),
  mode: Joi.string().valid('loop').optional(),
  silent: Joi.boolean().optional()
});

// 恢复正常权限检查 - 现在有调试日志可以追踪问题
router.post('/batch',
    requirePermission(PERMISSIONS.GENERATE_THUMBNAILS),
    validate(batchSchema, 'body'),
    asyncHandler(thumbnailController.batchGenerateThumbnails)
);

// 缩略图统计路由 - 需要查看权限
router.get('/stats',
    requirePermission(PERMISSIONS.VIEW_THUMBNAILS),
    asyncHandler(thumbnailController.getThumbnailStats)
);

// 导出缩略图路由模块
module.exports = router;
