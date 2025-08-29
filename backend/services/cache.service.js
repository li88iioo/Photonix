/**
 * 缓存服务模块
 * 提供基于标签的、更精细的缓存管理策略
 */
const { redis } = require('../config/redis');
const logger = require('../config/logger');

const TAG_PREFIX = 'tag:';

/**
 * 根据一个或多个标签，使关联的缓存失效（高效、非阻塞版）
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
        // 1. 使用 SUNION 一次性高效获取所有相关缓存键的并集
        const allCacheKeys = await redis.sunion(tagKeys);

        const keysToDelete = Array.from(allCacheKeys);
        if (keysToDelete.length === 0 && tagKeys.length === 0) {
            return;
        }

        // 2. 使用单个 pipeline 和非阻塞的 UNLINK 命令来删除所有键
        const pipeline = redis.pipeline();
        
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

        logger.info(`[Cache] 已根据 ${tagKeys.length} 个标签，失效 ${keysToDelete.length} 个缓存键。`);

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