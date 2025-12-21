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
// 认证缓存 TTL - 添加边界验证防止环境变量攻击
const RAW_CACHE_TTL = Number(process.env.AUTH_CACHE_TTL) || 30000;
const MIN_CACHE_TTL = 5000;   // 最小 5 秒
const MAX_CACHE_TTL = 3600000; // 最大 1 小时
const AUTH_CACHE_TTL = Math.max(MIN_CACHE_TTL, Math.min(RAW_CACHE_TTL, MAX_CACHE_TTL));

// 认证缓存上限，防止高并发下无限增长（默认 5000，范围 100-100000）
const RAW_CACHE_MAX_SIZE = Number(process.env.AUTH_CACHE_MAX_SIZE) || 5000;
const AUTH_CACHE_MAX_SIZE = Math.max(100, Math.min(RAW_CACHE_MAX_SIZE, 100000));
if (AUTH_CACHE_MAX_SIZE !== RAW_CACHE_MAX_SIZE) {
    logger.warn(`[Auth] AUTH_CACHE_MAX_SIZE (${RAW_CACHE_MAX_SIZE}) 超出范围，已限制为 ${AUTH_CACHE_MAX_SIZE} (范围: 100-100000)`);
}

// 如果配置值超出范围，记录警告
if (AUTH_CACHE_TTL !== RAW_CACHE_TTL) {
    logger.warn(`[Auth] AUTH_CACHE_TTL (${RAW_CACHE_TTL}ms) 超出安全范围，已限制为 ${AUTH_CACHE_TTL}ms (范围: ${MIN_CACHE_TTL}-${MAX_CACHE_TTL}ms)`);
}

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
        const isPasswordResetRequest = req.method === 'POST' && req.path === '/settings/reset-password';

        // 允许公开访问的资源接口 (仅在 ALLOW_PUBLIC_ACCESS 为 true 时放行)
        const isPublicResource =
            (req.method === 'GET' && (req.path === '/browse' || req.path === '/browse/' || req.path.startsWith('/browse/'))) ||
            (req.method === 'GET' && req.path === '/thumbnail') ||
            (req.method === 'GET' && req.path === '/events');

        // 4. 优先处理绝对放行的接口
        if (isPublicReadonly || isLoginRequest || isPasswordResetRequest) {
            logger.debug(`[Auth] 绝对放行接口: ${req.method} ${req.path}`);
            return next();
        }

        // 5. 如果密码功能未开启，视为全站公开，但仍需保留 req.user 为 anonymous
        if (!isPasswordEnabled) {
            // 可以在此添加日志，但为了性能通常省略
            return next();
        }

        // 6. 获取 Token (优先级: Authorization Header > Cookie > Query Param)
        let token = req.header('Authorization')?.replace('Bearer ', '');

        // 优先从 httpOnly cookie 读取（安全的SSE认证）
        if (!token && req.cookies?.auth_token) {
            token = req.cookies.auth_token;
        }

        // 最后从 query parameters 读取（向后兼容，但不推荐）
        if (!token) {
            const queryToken = req.query?.access_token || req.query?.token;
            if (typeof queryToken === 'string' && queryToken.trim()) {
                token = queryToken.trim();
            }
        }

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
            // 更新 LRU 顺序
            authCache.delete(cacheKey);
            authCache.set(cacheKey, { ...cachedAuth, timestamp: now });
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
        // 先清理过期或超限条目，确保缓存规模可控
        if (authCache.size >= AUTH_CACHE_MAX_SIZE) {
            // 批量清理策略：腾出约 10% 的空间，减少频繁清理的开销
            const targetSize = Math.floor(AUTH_CACHE_MAX_SIZE * 0.9);
            const toRemove = authCache.size - targetSize;
            let removed = 0;

            // 阶段1: 收集过期条目（避免迭代中修改）
            const expiredKeys = [];
            for (const [key, value] of authCache.entries()) {
                if ((now - value.timestamp) > AUTH_CACHE_TTL) {
                    expiredKeys.push(key);
                    if (expiredKeys.length >= toRemove) break;  // 提前退出优化
                }
            }

            // 阶段2: 删除过期条目
            for (const key of expiredKeys) {
                authCache.delete(key);
                removed++;
            }

            // 阶段3: 如果还需要删除更多，按LRU删除
            if (authCache.size > targetSize) {
                const toDeleteCount = authCache.size - targetSize;
                const keysToDelete = Array.from(authCache.keys()).slice(0, toDeleteCount);
                for (const key of keysToDelete) {
                    authCache.delete(key);
                    removed++;
                }
            }

            if (removed > 0) {
                logger.debug(
                    `[Auth] 缓存清理: 删除${removed}条 ` +
                    `(过期:${expiredKeys.length}, LRU:${removed - expiredKeys.length}), ` +
                    `当前:${authCache.size}/${AUTH_CACHE_MAX_SIZE}`
                );
            }
        }

        authCache.set(cacheKey, {
            token,
            user: req.user,
            userRole: req.userRole,
            userPermissions: req.userPermissions,
            timestamp: now
        });

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

// 定期清理过期缓存，避免在请求路径上清理影响性能
const AUTH_CACHE_CLEANUP_INTERVAL_MS = Math.min(AUTH_CACHE_TTL, 60000); // 至少按 TTL，至多每 60 秒
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of authCache.entries()) {
        if (now - value.timestamp > AUTH_CACHE_TTL) {
            authCache.delete(key);
            cleaned++;
        }
    }
    // 小量清理静默处理，避免日志刷屏（每分钟清理 1-2 个是正常现象）
    if (cleaned >= 5) {
        logger.debug(`[Auth] 清理了 ${cleaned} 个过期认证缓存`);
    }
}, AUTH_CACHE_CLEANUP_INTERVAL_MS);

// 允许进程退出
if (typeof cleanupInterval.unref === 'function') {
    cleanupInterval.unref();
}
