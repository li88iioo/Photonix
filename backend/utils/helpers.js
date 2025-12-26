/**
 * 通用助手函数
 * 用于消除重复代码模式
 */

const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
// 注意：不在此处导入 RetryManager，避免与 retry.js 形成循环依赖
// RetryManager 在 retry() 函数内动态加载

/**
 * 安全执行函数并捕获错误（日志输出）
 * @param {Function} fn - 要执行的函数
 * @param {string} context - 上下文描述
 * @param {string} level - 日志级别 (debug|info|warn|error)
 * @returns {Promise<any>} 返回函数结果，失败返回undefined
 */
async function safeExecute(fn, context = '操作', level = 'debug') {
    try {
        return await fn();
    } catch (error) {
        const message = `${context}失败: ${error.message}`;
        switch (level) {
            case 'error':
                logger.error(message, error);
                break;
            case 'warn':
                logger.warn(message);
                break;
            case 'info':
                logger.info(message);
                break;
            default:
                logger.debug(message);
        }
        return undefined;
    }
}

/**
 * 安全执行同步函数并捕获错误
 * @param {Function} fn - 要执行的同步函数
 * @param {string} context - 上下文描述
 * @param {string} level - 日志级别
 * @returns {any} 返回函数结果，失败返回undefined
 */
function safeExecuteSync(fn, context = '操作', level = 'debug') {
    try {
        return fn();
    } catch (error) {
        const message = `${context}失败: ${error.message}`;
        switch (level) {
            case 'error':
                logger.error(message, error);
                break;
            case 'warn':
                logger.warn(message);
                break;
            case 'info':
                logger.info(message);
                break;
            default:
                logger.debug(message);
        }
        return undefined;
    }
}

/**
 * 忽略特定错误的执行包装器
 * @param {Function} fn - 要执行的函数
 * @param {Array<string>} ignoredErrors - 要忽略的错误消息模式（正则）
 * @returns {Promise<any>}
 */
async function executeIgnoringErrors(fn, ignoredErrors = []) {
    try {
        return await fn();
    } catch (error) {
        const shouldIgnore = ignoredErrors.some(pattern =>
            new RegExp(pattern, 'i').test(error.message)
        );
        if (!shouldIgnore) {
            throw error;
        }
        return undefined;
    }
}

// ============= Redis 助手函数 =============

/**
 * 安全的Redis GET操作
 * @param {Object} redis - Redis客户端
 * @param {string} key - 键名
 * @param {string} context - 上下文（用于日志）
 * @returns {Promise<string|null>} 返回值或null
 */
async function safeRedisGet(redis, key, context = 'Redis GET') {
    if (!redis || redis.isNoRedis) {
        return null;
    }
    return await safeExecute(
        () => redis.get(key),
        `${context} (${key})`
    );
}

/**
 * 安全的Redis SET操作
 * @param {Object} redis - Redis客户端
 * @param {string} key - 键名
 * @param {string} value - 值
 * @param {string} mode - 模式 ('EX'表示秒, 'PX'表示毫秒, null表示无过期时间)
 * @param {number|string} ttl - 过期时间或额外参数(如'NX')
 * @param {string} context - 上下文
 * @param {string} extraFlag - 额外标志(如'NX'用于仅在键不存在时设置)
 * @returns {Promise<boolean>} 是否成功，对于NX模式返回是否设置成功
 */
async function safeRedisSet(redis, key, value, mode = 'EX', ttl = 3600, context = 'Redis SET', extraFlag = null) {
    if (!redis || redis.isNoRedis) {
        return false;
    }

    let result;
    if (extraFlag) {
        // 支持 NX/XX 等额外标志
        result = await safeExecute(
            () => mode && ttl ? redis.set(key, value, mode, ttl, extraFlag) : redis.set(key, value, extraFlag),
            `${context} (${key})`
        );
        // NX模式返回'OK'表示成功，null表示键已存在
        return result === 'OK' || result === true;
    } else {
        result = await safeExecute(
            () => mode && ttl ? redis.set(key, value, mode, ttl) : redis.set(key, value),
            `${context} (${key})`
        );
        return result !== undefined;
    }
}

/**
 * 安全的Redis DEL操作
 * @param {Object} redis - Redis客户端
 * @param {string|Array<string>} keys - 键名或键名数组
 * @param {string} context - 上下文
 * @returns {Promise<number>} 删除的键数量
 */
async function safeRedisDel(redis, keys, context = 'Redis DEL') {
    if (!redis || redis.isNoRedis) {
        return 0;
    }
    const keyArray = Array.isArray(keys) ? keys : [keys];
    if (keyArray.length === 0) {
        return 0; // 空数组直接返回
    }
    const result = await safeExecute(
        () => redis.del(...keyArray),
        `${context} (${keyArray.length}个键)`
    );
    return result || 0;
}

/**
 * 安全的Redis INCR操作
 * @param {Object} redis - Redis客户端
 * @param {string} key - 键名
 * @param {string} context - 上下文
 * @returns {Promise<number|null>} 增加后的值或null
 */
async function safeRedisIncr(redis, key, context = 'Redis INCR') {
    if (!redis || redis.isNoRedis) {
        return null;
    }
    return await safeExecute(
        () => redis.incr(key),
        `${context} (${key})`
    );
}

/**
 * 安全的Redis EXPIRE操作
 * @param {Object} redis - Redis客户端
 * @param {string} key - 键名
 * @param {number} seconds - 过期秒数
 * @param {string} context - 上下文
 * @returns {Promise<boolean>} 是否成功
 */
async function safeRedisExpire(redis, key, seconds, context = 'Redis EXPIRE') {
    if (!redis || redis.isNoRedis) {
        return false;
    }
    const result = await safeExecute(
        () => redis.expire(key, seconds),
        `${context} (${key}, ${seconds}s)`
    );
    return result === 1;
}

/**
 * 安全的Redis TTL操作
 * @param {Object} redis - Redis客户端
 * @param {string} key - 键名
 * @param {string} context - 上下文
 * @returns {Promise<number>} TTL秒数，-2表示不存在，-1表示无过期时间
 */
async function safeRedisTtl(redis, key, context = 'Redis TTL') {
    if (!redis || redis.isNoRedis) {
        return -2;
    }
    const result = await safeExecute(
        () => redis.ttl(key),
        `${context} (${key})`
    );
    return result !== undefined ? result : -2;
}

/**
 * 批量获取Redis键值
 * @param {Object} redis - Redis客户端
 * @param {Array<string>} keys - 键名数组
 * @param {string} context - 上下文
 * @returns {Promise<Map<string, string>>} 键值Map
 */
async function safeBatchRedisGet(redis, keys, context = 'Redis批量GET') {
    const result = new Map();
    if (!redis || redis.isNoRedis || !keys || keys.length === 0) {
        return result;
    }

    try {
        const values = await redis.mget(...keys);
        keys.forEach((key, index) => {
            if (values[index] !== null) {
                result.set(key, values[index]);
            }
        });
    } catch (error) {
        logger.debug(`${context}失败: ${error.message}`);
    }

    return result;
}

// ============= 通用工具函数 =============

/**
 * 延迟执行
 * @param {number} ms - 毫秒数
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带超时的Promise
 * @param {Promise} promise - 原Promise
 * @param {number} timeoutMs - 超时毫秒数
 * @param {string} timeoutMessage - 超时错误消息
 * @returns {Promise<any>}
 */
async function withTimeout(promise, timeoutMs, timeoutMessage = '操作超时') {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });

    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timeoutId);
        return result;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

/**
 * 重试执行函数（兼容性别名，实际使用 RetryManager）
 *
 * 注意：此函数已迁移到 utils/retry.js 的 RetryManager.executeWithRetry
 * 保留此导出仅为向后兼容，新代码请直接使用 RetryManager
 *
 * @deprecated 请使用 RetryManager.executeWithRetry 替代
 * @param {Function} fn - 要执行的函数
 * @param {Object} options - 选项
 * @param {string} options.context - 操作上下文（用于日志）
 * @param {number} options.maxRetries - 最大重试次数
 * @param {number} options.baseDelay - 基础延迟（毫秒）
 * @param {number} options.maxDelay - 最大延迟（毫秒）
 * @returns {Promise<any>}
 */
async function retry(fn, options = {}) {
    // 动态加载 RetryManager，避免循环依赖
    const { RetryManager } = require('./retry');

    // 兼容旧的 API 参数格式
    const {
        context = 'unknown',
        maxRetries = options.maxRetries || 3,
        baseDelay = options.delay || 1000,
        maxDelay = 30000
    } = options;

    return RetryManager.executeWithRetry(fn, {
        context,
        maxRetries,
        baseDelay,
        maxDelay
    });
}

module.exports = {
    // 错误处理
    safeExecute,
    safeExecuteSync,
    executeIgnoringErrors,

    // Redis助手
    safeRedisGet,
    safeRedisSet,
    safeRedisDel,
    safeRedisIncr,
    safeRedisExpire,
    safeRedisTtl,
    safeBatchRedisGet,

    // 工具函数
    sleep,
    withTimeout,
    retry
};
