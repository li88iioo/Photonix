/**
 * 缓存服务模块
 * 提供基于标签的、更精细的缓存管理策略
 */
const { redis } = require('../config/redis');
const logger = require('../config/logger');

const TAG_PREFIX = 'tag:';

/**
 * 根据一个或多个标签，使关联的缓存失效
 * @param {string|string[]} tags - 要使其失效的单个标签或标签数组
 */
async function invalidateTags(tags) {
    if (!redis) {
        logger.warn('Redis 未连接，跳过缓存失效操作。');
        return;
    }

    const tagsToInvalidate = Array.isArray(tags) ? tags : [tags];
    if (tagsToInvalidate.length === 0) {
        return;
    }

    const tagKeys = tagsToInvalidate.map(t => `${TAG_PREFIX}${t}`);

    try {
        // 使用 pipeline 提高效率
        const pipeline = redis.pipeline();

        // 1. 获取所有标签下的缓存键
        tagKeys.forEach(tagKey => {
            pipeline.smembers(tagKey);
        });
        const results = await pipeline.exec();

        const cacheKeysToDelete = new Set();
        results.forEach(([err, keys]) => {
            if (!err && keys && keys.length > 0) {
                keys.forEach(key => cacheKeysToDelete.add(key));
            }
        });

        const finalKeys = Array.from(cacheKeysToDelete);
        if (finalKeys.length === 0 && tagKeys.length === 0) {
            return;
        }

        // 2. 删除所有收集到的缓存键和标签键本身
        const deletePipeline = redis.pipeline();
        if (finalKeys.length > 0) {
            deletePipeline.del(finalKeys);
        }
        if (tagKeys.length > 0) {
            deletePipeline.del(tagKeys);
        }
        await deletePipeline.exec();

        logger.info(`[Cache] 已根据标签失效 ${finalKeys.length} 个缓存键: ${tagsToInvalidate.join(', ')}`);

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
    if (!redis) return;

    const tagsToAdd = Array.isArray(tags) ? tags : [tags];
    if (tagsToAdd.length === 0) {
        return;
    }

    try {
        const pipeline = redis.pipeline();
        tagsToAdd.forEach(tag => {
            pipeline.sadd(`${TAG_PREFIX}${tag}`, key);
        });
        await pipeline.exec();
    } catch (error) {
        logger.error(`为键 ${key} 添加缓存标签时出错:`, error);
    }
}

module.exports = {
    invalidateTags,
    addTagsToKey,
};