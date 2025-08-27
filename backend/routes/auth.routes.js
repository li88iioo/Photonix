/**
 * 认证路由模块
 * 处理用户认证相关的API请求，包括登录状态检查和用户登录
 */
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const { redis } = require('../config/redis');
const { validate, Joi, asyncHandler } = require('../middleware/validation');

// 定义认证相关的路由端点
router.get('/status', asyncHandler(authController.getAuthStatus));  // 获取认证状态
// 允许通过环境变量调参，避免误伤正常操作
const LOGIN_RATE_WINDOW_MS = Number(process.env.LOGIN_RATE_WINDOW_MS || 2 * 60 * 1000);
const LOGIN_RATE_MAX = Number(process.env.LOGIN_RATE_MAX || 8);
const REFRESH_RATE_WINDOW_MS = Number(process.env.REFRESH_RATE_WINDOW_MS || 60 * 1000);
const REFRESH_RATE_MAX = Number(process.env.REFRESH_RATE_MAX || 60);

// 刷新接口限流（与登录不同的更宽限额）
const refreshLimiter = rateLimit({
  windowMs: REFRESH_RATE_WINDOW_MS,
  max: REFRESH_RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
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
    } catch {}
    if (typeof retryAfterSeconds === 'number') res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(options.statusCode).json({ code: 'TOO_MANY_REQUESTS', message: '尝试过于频繁，请稍后重试', retryAfterSeconds });
  }
});
router.post('/refresh', refreshLimiter, asyncHandler(authController.refresh)); // 刷新 Token（简易滑动续期）

// 登录参数校验
const loginSchema = Joi.object({
  password: Joi.string().min(4).max(256).required()
});

// 登录接口专用限流（覆盖全局）：更短窗口、更小配额，叠加 Redis 锁
const loginLimiter = rateLimit({
  windowMs: LOGIN_RATE_WINDOW_MS,
  max: LOGIN_RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
  // 仅失败计数：成功登录不占用额度
  skipSuccessfulRequests: true,
  // 使用真实来源IP作为键（默认即为 req.ip，这里显式声明，便于未来调整）
  keyGenerator: (req /*, res*/) => req.ip,
  handler: (req, res, _next, options) => {
    let retryAfterSeconds = undefined;
    try {
      const rt = req && req.rateLimit && req.rateLimit.resetTime;
      const ts = rt instanceof Date ? rt.getTime() : (typeof rt === 'number' ? rt : null);
      if (ts) {
        const diff = Math.ceil((ts - Date.now()) / 1000);
        if (diff > 0 && diff < 24 * 3600) retryAfterSeconds = diff;
      }
    } catch {}
    if (typeof retryAfterSeconds === 'number') res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(options.statusCode).json({ code: 'TOO_MANY_REQUESTS', message: '尝试过于频繁，请稍后重试', retryAfterSeconds });
  }
});

router.post('/login', loginLimiter, validate(loginSchema), asyncHandler(authController.login));          // 用户登录

// 导出认证路由模块
module.exports = router;