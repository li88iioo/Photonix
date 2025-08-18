const express = require('express');
const router = express.Router();

const browseRoutes = require('./browse.routes');
const searchRoutes = require('./search.routes');
const thumbnailRoutes = require('./thumbnail.routes');
const aiRoutes = require('./ai.routes');
const settingsRoutes = require('./settings.routes');
const cacheRoutes = require('./cache.routes');
const metricsRoutes = require('./metrics.routes');
const eventRoutes = require('./event.routes'); // 新增事件路由
const loginBgController = require('../controllers/login.controller.js');

router.use('/browse', browseRoutes);
router.use('/search', searchRoutes);
router.use('/thumbnail', thumbnailRoutes);
router.use('/ai', aiRoutes);
router.use('/settings', settingsRoutes);
router.use('/cache', cacheRoutes);
router.use('/metrics', metricsRoutes);
router.use('/events', eventRoutes); // 挂载事件路由
// 登录页背景图（公开访问）
router.get('/login-bg', loginBgController.serveLoginBackground);

module.exports = router;