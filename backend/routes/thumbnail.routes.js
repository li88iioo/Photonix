/**
 * 缩略图路由模块
 * 处理缩略图生成和获取相关的API请求
 */
const express = require('express');
const router = express.Router();
const thumbnailController = require('../controllers/thumbnail.controller');
const { validate, Joi, asyncHandler } = require('../middleware/validation');

// 缩略图获取路由
// 根据查询参数中的文件路径生成或获取对应的缩略图
const thumbQuerySchema = Joi.object({
  path: Joi.string()
    .min(1)
    .max(2048)
    .custom((value, helpers)=> value.includes('..') ? helpers.error('any.invalid') : value, 'path traversal guard')
    .required()
});

router.get('/', validate(thumbQuerySchema, 'query'), asyncHandler(thumbnailController.getThumbnail));

// 导出缩略图路由模块
module.exports = router;