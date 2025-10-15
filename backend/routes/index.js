/**
 * @file index.js
 * @description API 路由总入口，统一挂载各业务模块路由
 */

const express = require('express');
const router = express.Router();

const browseRoutes = require('./browse.routes');         // 浏览相关路由
const searchRoutes = require('./search.routes');         // 搜索相关路由
const thumbnailRoutes = require('./thumbnail.routes');   // 缩略图相关路由
const aiRoutes = require('./ai.routes');                 // AI 功能路由
const downloadRoutes = require('./download.routes');     // 下载服务相关路由
const settingsRoutes = require('./settings.routes');     // 系统设置路由
const cacheRoutes = require('./cache.routes');           // 缓存相关路由
const metricsRoutes = require('./metrics.routes');       // 指标监控路由
const eventRoutes = require('./event.routes');           // 事件推送相关路由
const albumRoutes = require('./albums.routes');          // 相册管理相关路由
const loginBgController = require('../controllers/login.controller.js'); // 登录页背景图控制器

// 挂载各模块 API 路由
router.use('/browse', browseRoutes);
router.use('/search', searchRoutes);
router.use('/thumbnail', thumbnailRoutes);
router.use('/ai', aiRoutes);
router.use('/download', downloadRoutes);
router.use('/settings', settingsRoutes);
router.use('/cache', cacheRoutes);
router.use('/metrics', metricsRoutes);
router.use('/events', eventRoutes);
router.use('/albums', albumRoutes);

// 登录页背景图片获取（公开接口）
router.get('/login-bg', loginBgController.serveLoginBackground);

module.exports = router;