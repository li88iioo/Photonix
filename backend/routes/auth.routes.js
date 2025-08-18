/**
 * 认证路由模块
 * 处理用户认证相关的API请求，包括登录状态检查和用户登录
 */
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const rateLimit = require('express-rate-limit');
const { validate, Joi, asyncHandler } = require('../middleware/validation');

// 定义认证相关的路由端点
router.get('/status', asyncHandler(authController.getAuthStatus));  // 获取认证状态
// 刷新接口限流（与登录不同的更宽限额）
const refreshLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
router.post('/refresh', refreshLimiter, asyncHandler(authController.refresh)); // 刷新 Token（简易滑动续期）

// 登录参数校验
const loginSchema = Joi.object({
  password: Joi.string().min(4).max(256).required()
});

// 登录接口专用限流（覆盖全局）：更短窗口、更小配额，叠加 Redis 锁
const loginLimiter = rateLimit({
  windowMs: 2 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false
});

router.post('/login', loginLimiter, validate(loginSchema), asyncHandler(authController.login));          // 用户登录

// 导出认证路由模块
module.exports = router;