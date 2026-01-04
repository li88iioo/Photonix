/**
 * @file staticAuth.js
 * @description 静态资源鉴权中间件
 *
 * 当 PASSWORD_ENABLED=true 且 ALLOW_PUBLIC_ACCESS=false 时，
 * 要求访问 /static 和 /thumbs 的请求必须携带有效的 JWT Token。
 */

const jwt = require('jsonwebtoken');
const { getAllSettings } = require('../services/settings.service');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;

const JWT_SECRET = process.env.JWT_SECRET;

// ==================== 性能优化：模块级缓存 ====================
// 缓存认证相关设置，避免每个静态资源请求都调用 getAllSettings()
let cachedAuthSettings = null;
let authCacheExpiry = 0;
let pendingAuthSettingsPromise = null; // Promise 缓存：避免并发重复加载
const AUTH_CACHE_TTL = 30000; // 30 秒 TTL（平衡实时性和性能）

/**
 * 获取认证设置（带本地缓存 + Promise 去重）
 * @returns {Promise<{PASSWORD_ENABLED: string, ALLOW_PUBLIC_ACCESS: string}>}
 */
async function getAuthSettings() {
    const now = Date.now();

    // 缓存命中，直接返回
    if (cachedAuthSettings && now < authCacheExpiry) {
        return cachedAuthSettings;
    }

    // 如果有正在进行的加载，复用同一个 Promise（避免并发重复调用）
    if (pendingAuthSettingsPromise) {
        return pendingAuthSettingsPromise;
    }

    // 缓存失效，发起新的加载
    pendingAuthSettingsPromise = (async () => {
        try {
            // 使用 preferFreshSensitive 确保认证相关设置使用 30 秒 TTL
            const settings = await getAllSettings({ preferFreshSensitive: true });
            cachedAuthSettings = {
                PASSWORD_ENABLED: settings.PASSWORD_ENABLED,
                ALLOW_PUBLIC_ACCESS: settings.ALLOW_PUBLIC_ACCESS
            };
            authCacheExpiry = Date.now() + AUTH_CACHE_TTL;
            return cachedAuthSettings;
        } finally {
            // 无论成功失败，都清除 pending 状态
            pendingAuthSettingsPromise = null;
        }
    })();

    return pendingAuthSettingsPromise;
}

/**
 * 静态资源鉴权中间件
 * - 密码未启用：放行
 * - 密码启用 + 允许公开访问：放行
 * - 密码启用 + 不允许公开访问：需要有效 Token
 */
async function staticAuthMiddleware(req, res, next) {
    try {
        const { PASSWORD_ENABLED, ALLOW_PUBLIC_ACCESS } = await getAuthSettings();
        const isPasswordEnabled = PASSWORD_ENABLED === 'true';
        const isPublicAccessAllowed = ALLOW_PUBLIC_ACCESS !== 'false';

        // 密码未启用或允许公开访问 -> 放行
        if (!isPasswordEnabled || isPublicAccessAllowed) {
            return next();
        }

        // 私有模式：需要验证 Token
        let token = req.header('Authorization')?.replace('Bearer ', '');

        // 从 cookie 读取
        if (!token && req.cookies?.auth_token) {
            token = req.cookies.auth_token;
        }

        if (!token) {
            logger.debug(`${LOG_PREFIXES.AUTH} 静态资源访问被拒绝 (无Token): ${req.originalUrl}`);
            // 禁止缓存错误响应，避免浏览器缓存 401 导致后续请求返回 304
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            return res.status(401).json({
                code: 'UNAUTHORIZED',
                message: '私有模式下需要登录才能访问资源'
            });
        }

        if (!JWT_SECRET) {
            logger.error(`${LOG_PREFIXES.AUTH} 服务器缺少 JWT_SECRET 配置`);
            return res.status(500).json({
                code: 'SERVER_CONFIG_MISSING',
                message: '服务器配置错误'
            });
        }

        try {
            jwt.verify(token, JWT_SECRET);
            // 标记当前请求处于私有模式（已鉴权），供后续中间件调整缓存策略
            req.isPrivateMode = true;
            return next();
        } catch (error) {
            logger.debug(`${LOG_PREFIXES.AUTH} 静态资源 Token 无效: ${error.message}`);
            // 禁止缓存错误响应
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            return res.status(401).json({
                code: 'INVALID_TOKEN',
                message: 'Token 无效或已过期'
            });
        }
    } catch (error) {
        logger.error(`${LOG_PREFIXES.AUTH} staticAuth 中间件错误`, { error: error?.message });
        // fail-closed: 私有模式下异常应拒绝访问，防止安全绕过
        return res.status(503).json({
            code: 'SERVICE_UNAVAILABLE',
            message: '服务暂时不可用，请稍后重试'
        });
    }
}

module.exports = staticAuthMiddleware;
