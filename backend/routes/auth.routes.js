/**
 * 认证路由模块
 * 处理用户认证相关的API请求，包括登录状态检查和用户登录
 */
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const rateLimit = require('express-rate-limit');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
let refreshStore;
try {
  const { redis } = require('../config/redis');
  const ENABLE_REDIS = (process.env.ENABLE_REDIS || 'false').toLowerCase() === 'true';
  if (redis && !redis.isNoRedis && ENABLE_REDIS) {
    const RedisStore = require('rate-limit-redis');
    refreshStore = new RedisStore({ sendCommand: (...args) => redis.call(...args) });
  }
} catch (error) {
  logger.debug(`${LOG_PREFIXES.AUTH} Redis限流存储初始化失败`, { error: error && error.message });
}
const { validate, Joi, asyncHandler } = require('../middleware/validation');

// 定义认证相关的路由端点
router.get('/status', asyncHandler(authController.getAuthStatus));  // 获取认证状态
// 刷新接口限流配置
const REFRESH_RATE_WINDOW_MS = Number(process.env.REFRESH_RATE_WINDOW_MS || 60 * 1000);
const REFRESH_RATE_MAX = Number(process.env.REFRESH_RATE_MAX || 60);

// 刷新接口限流（与登录不同的更宽限额）
const refreshLimiter = rateLimit({
  windowMs: REFRESH_RATE_WINDOW_MS,
  max: REFRESH_RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: refreshStore,
  // 成功刷新不计入配额，避免正常续期触发429
  skipSuccessfulRequests: true,
  handler: (req, res, _next, options) => {
    let retryAfterSeconds = undefined;
    try {
      const rt = req && req.rateLimit && req.rateLimit.resetTime;
      const ts = rt instanceof Date ? rt.getTime() : (typeof rt === 'number' ? rt : null);
      if (ts) {
        const diff = Math.ceil((ts - Date.now()) / 1000);
        if (diff > 0 && diff < 24 * 3600) retryAfterSeconds = diff;
      }
    } catch (error) {
      logger.debug(`${LOG_PREFIXES.AUTH} 计算retryAfter失败`, { error: error && error.message });
    }
    if (typeof retryAfterSeconds === 'number') res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(options.statusCode).json({ code: 'TOO_MANY_REQUESTS', message: '尝试过于频繁，请稍后重试', retryAfterSeconds });
  }
});
router.post('/refresh', refreshLimiter, asyncHandler(authController.refresh)); // 刷新 Token（简易滑动续期）

// 登录参数校验
const loginSchema = Joi.object({
  // 由控制器统一处理密码长度和错误计数，避免 Joi 直接报错导致提示不一致
  password: Joi.string().max(256).required()
});

// 移除 express-rate-limit 的登录限流，完全依赖控制器内的 Redis 防爆破机制
// 这样可以确保只有密码错误才会触发限流，密码正确时会清除限流状态
router.post('/login', validate(loginSchema), asyncHandler(authController.login));          // 用户登录

// 导出认证路由模块
module.exports = router;
