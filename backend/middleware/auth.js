/**
 * 认证中间件模块
 * 处理用户认证和授权，支持密码保护、公开访问控制和JWT令牌验证
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getAllSettings } = require('../services/settings.service');
const logger = require('../config/logger');
const { ENABLE_AUTH_DEBUG_LOGS } = require('../config');
const { getUserRole } = require('./permissions');
const state = require('../services/state.manager');

const shouldLogVerbose = () => ENABLE_AUTH_DEBUG_LOGS;

// 认证缓存，避免重复验证相同的token
const authCache = new Map();
const AUTH_CACHE_TTL = 30000; // 30秒缓存

/**
 * JWT密钥配置
 * 提示：仅在需要验证/签发 Token 时才要求存在，避免在“无密码模式”下阻止启动
 */
const JWT_SECRET = process.env.JWT_SECRET;

/**
 * 认证中间件函数
 * 根据系统设置和请求类型进行认证检查，支持多种访问模式
 * @param {Object} req - Express请求对象
 * @param {Object} res - Express响应对象
 * @param {Function} next - Express下一个中间件函数
 * @returns {void} 继续处理请求或返回错误响应
 */
module.exports = async function (req, res, next) {
    try {
        // 1. 初始化默认用户上下文，确保下游始终可以安全访问 req.user
        // 默认身份为匿名用户
        req.user = { id: 'anonymous' };
        req.userRole = 'guest';
        req.userPermissions = [];

        // 2. 获取系统设置
        const { PASSWORD_ENABLED, ALLOW_PUBLIC_ACCESS } = await getAllSettings();
        const isPasswordEnabled = PASSWORD_ENABLED === 'true';
        const isPublicAccessAllowed = ALLOW_PUBLIC_ACCESS !== 'false';

        // 3. 定义路由特征
        // 始终放行的公共只读/状态接口
        const isPublicReadonly =
            (req.method === 'GET' && req.path === '/settings') ||
            (req.method === 'GET' && req.path === '/settings/status') ||
            (req.method === 'GET' && req.path === '/login-bg') ||
            (req.method === 'GET' && req.path === '/auth/status');

        // 登录接口 (必须始终放行，否则无法登录)
        const isLoginRequest = req.method === 'POST' && req.path === '/auth/login';

        // 允许公开访问的资源接口 (仅在 ALLOW_PUBLIC_ACCESS 为 true 时放行)
        const isPublicResource =
            (req.method === 'GET' && (req.path === '/browse' || req.path === '/browse/')) ||
            (req.method === 'GET' && req.path === '/thumbnail') ||
            (req.method === 'GET' && req.path === '/events');

        // 4. 优先处理绝对放行的接口
        if (isPublicReadonly || isLoginRequest) {
            logger.debug(`[Auth] 绝对放行接口: ${req.method} ${req.path}`);
            return next();
        }

        // 5. 如果密码功能未开启，视为全站公开，但仍需保留 req.user 为 anonymous
        if (!isPasswordEnabled) {
            // 可以在此添加日志，但为了性能通常省略
            return next();
        }

        // 6. 获取 Token
        let token = req.header('Authorization')?.replace('Bearer ', '');

        // 7. 处理公开访问模式
        if (isPublicAccessAllowed && isPublicResource && !token) {
            // 允许公开访问，且请求的是公共资源，且未携带 Token -> 以匿名身份放行
            logger.debug(`[Auth] 公开模式放行匿名请求: ${req.method} ${req.originalUrl}`);
            return next();
        }

        // 8. 必须认证的场景
        // - 不允许公开访问
        // - 或者请求的不是公共资源
        // - 或者虽然是公共资源但携带了 Token (尝试提权)

        if (!token) {
            // 无 Token，且不满足上述放行条件 -> 拒绝
            logger.warn(`[${req.requestId || '-'}] [Auth] 访问被拒绝 (无Token): ${req.method} ${req.originalUrl}`);
            const msg = isPublicAccessAllowed ? '未授权，请提供 Token' : '未授权，管理员已关闭公开访问';
            return res.status(401).json({ code: 'UNAUTHORIZED', message: msg, requestId: req.requestId });
        }

        // 9. 验证 Token
        if (!JWT_SECRET) {
            logger.error(`[${req.requestId || '-'}] [Auth] 服务器缺少 JWT_SECRET 配置，无法验证 Token`);
            return res.status(500).json({ code: 'SERVER_CONFIG_MISSING', message: '服务器缺少 JWT 配置', requestId: req.requestId });
        }

        // 检查缓存
        const cacheKey = crypto.createHash('sha256').update(token).digest('hex');
        const cachedAuth = authCache.get(cacheKey);
        const now = Date.now();

        if (cachedAuth && cachedAuth.token === token && (now - cachedAuth.timestamp) < AUTH_CACHE_TTL) {
            req.user = cachedAuth.user;
            req.userRole = cachedAuth.userRole;
            req.userPermissions = cachedAuth.userPermissions;
            return next();
        }

        // 验证 JWT
        const decoded = jwt.verify(token, JWT_SECRET);

        // 更新用户上下文
        const userId = decoded?.sub || 'anonymous';
        req.user = { id: String(userId) };
        req.userRole = getUserRole(req);
        req.userPermissions = [];

        // 写入缓存
        authCache.set(cacheKey, {
            token,
            user: req.user,
            userRole: req.userRole,
            userPermissions: req.userPermissions,
            timestamp: now
        });

        // 清理缓存
        if (authCache.size > 100) {
            for (const [key, value] of authCache.entries()) {
                if (now - value.timestamp > AUTH_CACHE_TTL) {
                    authCache.delete(key);
                }
            }
        }

        next();

    } catch (err) {
        if (err.name === 'JsonWebTokenError') {
            logger.warn(`[${req.requestId || '-'}] [Auth] 访问被拒绝 (Token无效): ${req.method} ${req.originalUrl}`);
            return res.status(401).json({ code: 'INVALID_TOKEN', message: 'Token 无效', requestId: req.requestId });
        }
        if (err.name === 'TokenExpiredError') {
            logger.warn(`[${req.requestId || '-'}] [Auth] 访问被拒绝 (Token过期): ${req.method} ${req.originalUrl}`);
            return res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'Token 已过期', requestId: req.requestId });
        }
        logger.error(`[${req.requestId || '-'}] [Auth] 认证中间件发生未知错误:`, err);
        return res.status(500).json({ code: 'AUTH_ERROR', message: '服务器认证时出错', requestId: req.requestId });
    }
};