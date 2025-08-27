/**
 * 认证中间件模块
 * 处理用户认证和授权，支持密码保护、公开访问控制和JWT令牌验证
 */
const jwt = require('jsonwebtoken');
const { getAllSettings } = require('../services/settings.service');
const logger = require('../config/logger');

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
module.exports = async function(req, res, next) {
    try {
        // 获取系统设置：密码保护和公开访问控制
        const { PASSWORD_ENABLED, ALLOW_PUBLIC_ACCESS } = await getAllSettings();

        // 如果密码功能未开启，则所有请求都直接放行
        if (PASSWORD_ENABLED !== 'true') {
            return next();
        }

        // 允许公开访问的配置（默认 true）
        // 当设置为false时，所有非登录请求都需要认证
        const allowPublic = ALLOW_PUBLIC_ACCESS !== 'false';

        // 定义公共路由的检查
        // 这些路由在允许公开访问时可以被未认证用户访问
        const isRootBrowseRequest = req.method === 'GET' && (req.path === '/browse' || req.path === '/browse/');
        const isCoversRequest = false; // 旧的封面API已移除
        const isThumbnailRequest = req.method === 'GET' && req.path === '/thumbnail'; // 新增对缩略图路由的检查
        const isEventsRequest = req.method === 'GET' && req.path === '/events'; // SSE 事件流
        const isSettingsGetRequest = req.method === 'GET' && req.path === '/settings'; // 公开：仅 GET /api/settings（非敏感字段）
            const isSettingsStatusRequest = req.method === 'GET' && req.path === '/settings/status'; // 公开：设置更新状态轮询（只读、非敏感）
        const isLoginBgRequest = req.method === 'GET' && req.path === '/login-bg';
        const isLoginRequest = req.method === 'POST' && req.path === '/auth/login';
        
        // 从请求头获取JWT令牌（不再允许通过 URL 查询参数传递 Token）
        let token = req.header('Authorization')?.replace('Bearer ', '');

        // 无论是否允许公开访问，GET /api/settings 与 /api/auth/status 均放行（只返回非敏感字段/布尔）
        const isAuthStatus = req.method === 'GET' && req.path === '/auth/status';
        if (isSettingsGetRequest || isSettingsStatusRequest || isLoginBgRequest || isAuthStatus) {
            logger.debug(`[Auth] 放行公共只读接口: ${req.method} ${req.path}`);
            return next();
        }

        // 如果允许公开访问，且是公共路由且未提供token，则放行
        // 这种情况适用于允许部分公开访问的场景
        if (allowPublic && (isRootBrowseRequest || isCoversRequest || isThumbnailRequest || isEventsRequest) && !token) {
            // 公开模式下不信任客户端提供的用户 ID，统一按匿名处理
            logger.debug(`[Auth] 放行未认证的公共资源请求: ${req.method} ${req.originalUrl}`);
            return next();
        }

        // 如果不允许公开访问，除登录外所有 /api 路由都必须验证 token
        // 这种情况适用于完全私有的应用场景
        if (!allowPublic && !isLoginRequest) {
            if (!token) {
            logger.warn(`[${req.requestId || '-'}] [Auth] 访问被拒绝 (全局加密/无Token): ${req.method} ${req.originalUrl}`);
            return res.status(401).json({ code: 'UNAUTHORIZED', message: '未授权，管理员已关闭公开访问', requestId: req.requestId });
            }
        }
        
        // 对于所有其他需要认证的请求，必须验证token
        // 包括非公共路由的请求和需要认证的API调用
        if (!token) {
            logger.warn(`[${req.requestId || '-'}] [Auth] 访问被拒绝 (无Token): ${req.method} ${req.originalUrl}`);
            return res.status(401).json({ code: 'UNAUTHORIZED', message: '未授权，请提供 Token', requestId: req.requestId });
        }

        // 验证 JWT token 的有效性，并注入 req.user 以便下游缓存与审计
        if (!JWT_SECRET) {
            logger.error(`[${req.requestId || '-'}] [Auth] 服务器缺少 JWT_SECRET 配置，无法验证 Token`);
            return res.status(500).json({ code: 'SERVER_CONFIG_MISSING', message: '服务器缺少 JWT 配置', requestId: req.requestId });
        }
        const decoded = jwt.verify(token, JWT_SECRET);
        // 修正：Token 中只包含 `sub` 声明，移除对 `id` 或 `user` 的无效检查
        // 如果 `sub` 不存在，则视为匿名用户，与系统单用户设计保持一致
        const userId = decoded?.sub || 'anonymous';
        req.user = { id: String(userId) };
        next(); // Token 有效，继续处理请求

    } catch (err) {
        // 处理不同类型的JWT验证错误
        if (err.name === 'JsonWebTokenError') {
            // Token格式错误或签名无效
            logger.warn(`[${req.requestId || '-'}] [Auth] 访问被拒绝 (Token无效): ${req.method} ${req.originalUrl}`);
            return res.status(401).json({ code: 'INVALID_TOKEN', message: 'Token 无效', requestId: req.requestId });
        }
        if (err.name === 'TokenExpiredError') {
            // Token已过期
            logger.warn(`[${req.requestId || '-'}] [Auth] 访问被拒绝 (Token过期): ${req.method} ${req.originalUrl}`);
            return res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'Token 已过期', requestId: req.requestId });
        }
        // 其他未知错误
        logger.error(`[${req.requestId || '-'}] [Auth] 认证中间件发生未知错误:`, err);
        return res.status(500).json({ code: 'AUTH_ERROR', message: '服务器认证时出错', requestId: req.requestId });
    }
};