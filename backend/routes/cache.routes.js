const express = require('express');
const router = express.Router();
const { getCacheStats, clearCache } = require('../middleware/cache');
const logger = require('../config/logger');
const rateLimit = require('express-rate-limit');

/**
 * 获取缓存统计信息
 * GET /api/cache/stats
 */
const adminLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

router.get('/stats', adminLimiter, (req, res) => {
    try {
        const stats = getCacheStats();
        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        logger.error('获取缓存统计失败:', error);
        res.status(500).json({ error: '获取缓存统计失败' });
    }
});

/**
 * 清理缓存
 * POST /api/cache/clear
 */
// 方案B：保持中间件直接响应，移除多余的路由处理器，避免二次响应
router.post('/clear', adminLimiter, clearCache('route_cache:*'));

/**
 * 清理特定模式的缓存
 * POST /api/cache/clear/:pattern
 */
router.post('/clear/:pattern', adminLimiter, (req, res) => {
    const pattern = req.params.pattern;
    return clearCache(pattern)(req, res, () => {});
});

module.exports = router; 