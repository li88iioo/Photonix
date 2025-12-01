const express = require('express');
const router = express.Router();
const eventController = require('../controllers/event.controller.js');
const authenticateToken = require('../middleware/auth');

// @route   GET /api/events
// @desc    建立 SSE 连接以接收服务器事件
// @access  Public when ALLOW_PUBLIC_ACCESS is true; otherwise protected by JWT
router.get('/', eventController.streamEvents);

// @route   GET /api/events/status
// @desc    获取当前SSE连接状态（需要认证以验证token有效性）
// @access  Protected by JWT
router.get('/status', authenticateToken, (req, res) => {
    const status = eventController.getConnectionStatus();
    res.json({ ...status, authenticated: true, userId: req.user?.id });
});

module.exports = router;
