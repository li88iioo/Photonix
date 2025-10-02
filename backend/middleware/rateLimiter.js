/**
 * 速率限制中间件模块
 * 使用express-rate-limit库实现API请求频率限制，防止恶意攻击和资源滥用
 */
const rateLimit = require('express-rate-limit');
const logger = require('../config/logger');

let store;
let usingRedisStore = false;

try {
  const { redis, isRedisAvailable } = require('../config/redis');
  const useRedis = (process.env.RATE_LIMIT_USE_REDIS || 'false').toLowerCase() === 'true';
  if (useRedis && isRedisAvailable(true) && redis && !redis.isNoRedis) {
    const RedisStore = require('rate-limit-redis');
    store = new RedisStore({
      sendCommand: (...args) => redis.call(...args)
    });
    usingRedisStore = true;
    logger.info('[RateLimiter] 已启用 Redis 限流存储。');
  } else if (useRedis) {
    logger.warn('[RateLimiter] 配置要求使用 Redis 进行限流，但 Redis 不可用，已自动降级为本地内存限流。');
  }
} catch (error) {
  logger.warn('[RateLimiter] 初始化 Redis 限流存储失败，已降级为本地内存限流。', { error: error && error.message });
}

if (!store) {
  store = new rateLimit.MemoryStore();
  if (!usingRedisStore) {
    logger.info('[RateLimiter] 使用进程内令牌桶存储。建议在生产环境启用 ENABLE_REDIS 与 RATE_LIMIT_USE_REDIS=true。');
  }
}

/**
 * API速率限制器配置
 * 限制客户端在指定时间窗口内的请求次数，保护服务器资源
 */
const apiLimiter = rateLimit({
    // 使用 Redis 作为共享存储，支持多进程/多实例一致限流
    // 默认使用内存存储；仅在 RATE_LIMIT_USE_REDIS=true 且 Redis 可用时启用 RedisStore
    store,
    // 时间窗口：默认1分钟，可通过环境变量RATE_LIMIT_WINDOW_MINUTES配置
    // 单位：毫秒
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MINUTES || 1) * 60 * 1000,
    
    // 最大请求次数：默认800次，可通过环境变量RATE_LIMIT_MAX_REQUESTS配置
    // 在时间窗口内超过此次数将被限制
    max: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 800),
    
    // 限制响应消息：当请求被限制时返回的错误信息
    message: {
        error: '请求过于频繁，请稍后再试。'
    },
    
    // 启用标准HTTP头：在响应中包含速率限制信息
    // 包括 X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
    standardHeaders: true,
    
    // 禁用旧版HTTP头：不包含 X-RateLimit-* 格式的旧版头信息
    legacyHeaders: false,

    // 登录后缩略图会在短时间内产生大量 GET 请求，为避免 429 限流造成感知卡顿，
    // 仅对已认证（有 Authorization）请求跳过限流（禁止使用 query token 绕过）
    skip: (req) => {
        try {
            // 该中间件挂载在 "/api"，此处的 req.path 为去掉 "/api" 的子路径
            const isThumb = req.method === 'GET' && req.path === '/thumbnail';
            if (!isThumb) return false;
            const hasAuthHeader = !!req.header('Authorization');
            return hasAuthHeader;
        } catch { return false; }
    }
});

// 导出配置好的速率限制中间件
module.exports = apiLimiter;