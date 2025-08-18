const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { getCacheStats } = require('../middleware/cache');
const { aiCaptionQueue } = require('../config/redis');

// 轻量限流，避免监控轮询放大流量
const metricsLimiter = rateLimit({ windowMs: 30 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

// 缓存命中率指标
router.get('/cache', metricsLimiter, (req, res) => {
  const stats = getCacheStats();
  res.json({ success: true, data: stats });
});

// 队列指标（BullMQ）
router.get('/queue', metricsLimiter, async (req, res) => {
  try {
    const counts = await aiCaptionQueue.getJobCounts('active','waiting','delayed','completed','failed','paused');
    res.json({ success: true, data: counts });
  } catch (e) {
    res.status(500).json({ success: false, error: 'QUEUE_METRICS_ERROR', message: e.message });
  }
});

module.exports = router;


