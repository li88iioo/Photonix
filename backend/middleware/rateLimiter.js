/**
 * @file rateLimiter.js
 * @module middleware/rateLimiter
 * @description 速率限制中间件，基于 express-rate-limit，实现 API 请求频率的限制，防止恶意攻击与资源滥用。
 * 支持 Redis 高可用限流，自动降级至内存模式。
 */

const rateLimit = require('express-rate-limit');
const logger = require('../config/logger');
const { redis, isRedisAvailable } = require('../config/redis');

/**
 * @const {number} REDIS_WAIT_MS
 * 等待 Redis 就绪的最大时长（毫秒）
 */
const REDIS_WAIT_MS = Number(process.env.RATE_LIMIT_REDIS_WAIT_MS || 5000);

/**
 * @const {number} REDIS_POLL_INTERVAL_MS
 * 轮询检测 Redis 就绪状态的间隔时间（毫秒）
 */
const REDIS_POLL_INTERVAL_MS = Math.max(50, Number(process.env.RATE_LIMIT_REDIS_POLL_INTERVAL_MS || 200));

/**
 * 构建速率限制器
 * @function buildLimiter
 * @param {Object} store - 限流存储实例（支持内存/Redis）
 * @returns {Function} Express中间件
 */
function buildLimiter(store) {
    return rateLimit({
        store,
        windowMs: Number(process.env.RATE_LIMIT_WINDOW_MINUTES || 1) * 60 * 1000,
        max: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 3000),
        message: { error: '请求过于频繁，请稍后再试。' },
        standardHeaders: true,
        legacyHeaders: false,
        /**
         * 跳过带认证头的缩略图请求（GET /api/.../thumbnail?xxx）
         * 只要 URL 中包含 /thumbnail 且请求已认证则放行
         * @param {import('express').Request} req 
         * @returns {boolean}
         */
        skip: (req) => {
            try {
                if (req.method !== 'GET') return false;
                const rawUrl = (req.originalUrl || req.url || '').toLowerCase();
                const isThumbnailRequest = typeof rawUrl === 'string' && rawUrl.includes('/thumbnail');
                if (!isThumbnailRequest) return false;
                return Boolean(req.header('Authorization'));
            } catch (skipErr) {
                logger.debug('[RateLimiter] 判断缩略图限流跳过条件失败（忽略）:', skipErr && skipErr.message);
                return false;
            }
        }
    });
}

/**
 * 等待 Redis 服务就绪
 * @function waitForRedisReady
 * @param {number} timeoutMs - 最大等待时长（毫秒）
 * @returns {Promise<boolean>} 是否就绪
 */
async function waitForRedisReady(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (isRedisAvailable(true) && redis && !redis.isNoRedis) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, REDIS_POLL_INTERVAL_MS));
    }
    return isRedisAvailable(true) && redis && !redis.isNoRedis;
}

/**
 * 根据配置选择并初始化限流存储（优先 Redis，无则降级为内存）
 * @function resolveStore
 * @returns {Promise<Object>} 限流存储实例
 */
async function resolveStore() {
    const useRedis = (process.env.RATE_LIMIT_USE_REDIS || 'false').toLowerCase() === 'true';
    if (!useRedis) {
        logger.debug('[RateLimiter] 使用进程内令牌桶存储');
        return new rateLimit.MemoryStore();
    }

    const ready = await waitForRedisReady(REDIS_WAIT_MS);
    if (ready) {
        try {
            const RedisStore = require('rate-limit-redis');
            logger.info('[RateLimiter] 已启用 Redis 限流存储');
            return new RedisStore({ sendCommand: (...args) => redis.call(...args) });
        } catch (error) {
            logger.debug('[RateLimiter] 初始化 Redis 限流存储失败，已降级为本地内存限流', { error: error && error.message });
        }
    } else {
        logger.warn(`[RateLimiter] Redis 在 ${REDIS_WAIT_MS}ms 内未就绪，已降级为本地内存限流。`);
    }

    logger.debug('[RateLimiter] 使用进程内令牌桶存储，建议在生产环境启用 Redis');
    return new rateLimit.MemoryStore();
}

/**
 * 限流器实例承诺（根据 Redis 或内存模式初始化）
 * 创建时自动选择最优的 Store
 * @type {Promise<import('express').RequestHandler>}
 */
const limiterPromise = resolveStore().then(store => buildLimiter(store)).catch(error => {
    logger.error('[RateLimiter] 创建限流器失败，使用进程内限定作为兜底。', { error: error && error.message });
    return buildLimiter(new rateLimit.MemoryStore());
});

/**
 * Express 速率限制中间件主函数
 * 内部自动选择限流 Store，降级兜底
 * @function rateLimiterMiddleware
 */
const rateLimiterMiddleware = (req, res, next) => {
    limiterPromise.then(limiter => limiter(req, res, next)).catch(err => {
        logger.error('[RateLimiter] 执行限流器失败，使用兜底内存限流。', { error: err && err.message });
        const fallbackLimiter = buildLimiter(new rateLimit.MemoryStore());
        fallbackLimiter(req, res, next);
    });
};

module.exports = {
    rateLimiterMiddleware,   // 速率限制 Express 中间件
    rateLimiterReady: limiterPromise // 内部限流器初始化承诺（可供外部 await）
};