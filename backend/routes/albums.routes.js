/**
 * 相册路由模块
 */
const express = require('express');
const router = express.Router();
const albumsController = require('../controllers/albums.controller');
const { requirePermission, PERMISSIONS } = require('../middleware/permissions');
const validatePath = require('../middleware/pathValidator');
const { asyncHandler } = require('../middleware/validation');

/**
 * 删除相册
 * 需要 GENERATE_THUMBNAILS 权限
 * 路径参数需通过 validatePath 校验
 */
router.delete(
  '/*', 
  requirePermission(PERMISSIONS.GENERATE_THUMBNAILS), 
  validatePath('param'), 
  asyncHandler(albumsController.deleteAlbum)
);

module.exports = router;
