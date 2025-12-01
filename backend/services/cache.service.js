/**
 * 缓存服务模块
 * 提供基于标签的、更精细的缓存管理策略
 */
const { redis } = require('../config/redis');
const logger = require('../config/logger');
const { safeRedisGet, safeRedisDel, safeRedisSet } = require('../utils/helpers');

const TAG_PREFIX = 'tag:';
const QUERY_CACHE_PREFIX = 'query:';
const QUERY_CACHE_TTL = 300; // 5分钟缓存时间
let redisNoOpWarned = false;

function resolveRedisClient(scope = '缓存操作') {
    if (!redis || redis.isNoRedis) {
        if (!redisNoOpWarned) {
            redisNoOpWarned = true;
            logger.info(`Redis 未连接或处于 No-Op 模式，已跳过${scope}。`);
        }
        return null;
    }
    return redis;
}

/**
 * 根据一个或多个标签，使关联的缓存失效（高效、非阻塞版）
 * @param {string|string[]} tags - 要使其失效的单个标签或标签数组
 */
async function invalidateTags(tags) {
    const client = resolveRedisClient('路由缓存失效操作');
    if (!client) return;
    const tagsToInvalidate = Array.isArray(tags) ? tags : [tags];
    if (tagsToInvalidate.length === 0) {
        return;
    }

    const tagKeys = tagsToInvalidate.map(t => `${TAG_PREFIX}${t}`);

    try {
        // 1. 使用 SUNION 一次性高效获取所有相关缓存键的并集
        const allCacheKeys = await client.sunion(tagKeys);

        const keysToDelete = Array.from(allCacheKeys);

        // 2. 使用单个 pipeline 和非阻塞的 UNLINK 命令来删除所有键
        const pipeline = client.pipeline();

        // 分批次删除缓存键，避免单次命令的参数列表过长
        if (keysToDelete.length > 0) {
            const chunkSize = 500;
            for (let i = 0; i < keysToDelete.length; i += chunkSize) {
                const chunk = keysToDelete.slice(i, i + chunkSize);
                pipeline.unlink(...chunk);
            }
        }
        
        // 删除标签键本身
        if (tagKeys.length > 0) {
            pipeline.unlink(...tagKeys);
        }

        await pipeline.exec();

        if ((keysToDelete.length || 0) > 0) {
            logger.debug(`[Cache] 已根据 ${tagKeys.length} 个标签，失效 ${keysToDelete.length} 个缓存键。`);
        } else {
            logger.debug(`[Cache] 根据 ${tagKeys.length} 个标签，无可失效的缓存键。`);
        }

    } catch (error) {
        logger.error('根据标签失效缓存时出错:', error);
    }
}

/**
 * 为给定的缓存键添加一个或多个标签
 * @param {string} key - 要被标记的缓存键
 * @param {string|string[]} tags - 应用到该键上的一个或多个标签
 * @returns {Promise<void>}
 */
async function addTagsToKey(key, tags) {
    const client = resolveRedisClient('缓存标签添加');
    if (!client) return;
    const tagsToAdd = Array.isArray(tags) ? tags : [tags];
    if (tagsToAdd.length === 0) {
        return;
    }

    try {
        const pipeline = client.pipeline();
        tagsToAdd.forEach(tag => {
            pipeline.sadd(`${TAG_PREFIX}${tag}`, key);
        });
        await pipeline.exec();
    } catch (error) {
        logger.error(`为键 ${key} 添加缓存标签时出错:`, error);
    }
}

/**
 * 缓存查询结果
 * @param {string} queryKey - 查询缓存键
 * @param {any} data - 要缓存的数据
 * @param {string[]} tags - 关联的缓存标签
 * @param {number} ttl - 缓存时间（秒）
 */
async function cacheQueryResult(queryKey, data, tags = [], ttl = QUERY_CACHE_TTL) {
    const client = resolveRedisClient('查询结果缓存写入');
    if (!client) return;
    try {
        const cacheKey = `${QUERY_CACHE_PREFIX}${queryKey}`;
        const serializedData = JSON.stringify(data);

        // 设置缓存数据
        await safeRedisSet(client, cacheKey, serializedData, 'EX', ttl, '查询缓存写入');

        // 添加标签关联
        if (tags.length > 0) {
            await addTagsToKey(cacheKey, tags);
        }

        logger.debug(`[Cache] 查询结果已缓存: ${queryKey}`);
    } catch (error) {
        logger.debug('缓存查询结果失败:', error);
    }
}

/**
 * 获取缓存的查询结果
 * @param {string} queryKey - 查询缓存键
 * @returns {Promise<any|null>} 缓存的数据或null
 */
async function getCachedQueryResult(queryKey) {
    const client = resolveRedisClient('查询缓存读取');
    if (!client) return null;

    const cacheKey = `${QUERY_CACHE_PREFIX}${queryKey}`;
    const cachedData = await safeRedisGet(client, cacheKey, '查询缓存读取');

    if (cachedData) {
        try {
            const data = JSON.parse(cachedData);
            logger.debug(`[Cache] 查询结果命中缓存: ${queryKey}`);
            return data;
        } catch (error) {
            logger.debug('解析缓存数据失败:', error);
            return null;
        }
    }

    return null;
}

/**
 * 使查询缓存失效
 * @param {string|string[]} queryKeys - 要失效的查询键
 */
async function invalidateQueryCache(queryKeys) {
    const client = resolveRedisClient('查询缓存失效');
    if (!client) return;

    const keysToInvalidate = Array.isArray(queryKeys) ? queryKeys : [queryKeys];
    if (keysToInvalidate.length === 0) return;

    const cacheKeys = keysToInvalidate.map(key => `${QUERY_CACHE_PREFIX}${key}`);
    await safeRedisDel(client, cacheKeys, '失效查询缓存');
    logger.debug(`[Cache] 已失效 ${cacheKeys.length} 个查询缓存`);
}

/**
 * 生成查询缓存键
 * @param {string} sql - SQL查询语句
 * @param {Array} params - 查询参数
 * @returns {string} 缓存键
 */
function generateQueryKey(sql, params = []) {
    // 简化SQL（移除多余空格）并与参数结合生成键
    const simplifiedSql = sql.replace(/\s+/g, ' ').trim();
    const paramsStr = params.length > 0 ? `:${JSON.stringify(params)}` : '';
    return `${simplifiedSql}${paramsStr}`;
}

module.exports = {
    invalidateTags,
    addTagsToKey,
    cacheQueryResult,
    getCachedQueryResult,
    invalidateQueryCache,
    generateQueryKey,
};
