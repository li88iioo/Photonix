/**
 * 浏览记录缓存服务
 * 使用Redis缓存用户浏览历史热数据，减少history DB查询
 * 
 * 缓存策略：
 * - 键格式：`viewed:${userId}:albums` (Hash结构)
 * - 值格式：{ albumPath: lastViewedTimestamp }
 * - TTL: 1小时（热数据）
 * - 更新策略：写时更新（浏览时同步更新缓存）
 */

const { redis } = require('../config/redis');
const { dbAll } = require('../db/multi-db');
const { safeRedisGet, safeRedisSet } = require('../utils/helpers');
const logger = require('../config/logger');

/**
 * 获取用户浏览过的相册列表（带Redis缓存）
 * @param {string} userId - 用户ID
 * @param {Array<string>} albumPaths - 需要查询的相册路径列表
 * @returns {Promise<Map<string, number>>} 相册路径 -> 最后浏览时间的Map
 */
async function getViewedAlbumsCache(userId, albumPaths) {
    if (!userId || !albumPaths || albumPaths.length === 0) {
        return new Map();
    }

    const cacheKey = `viewed:${userId}:albums`;
    
    try {
        // ✅ 优化：使用Redis Hash存储，一次查询获取所有数据
        if (redis && !redis.isNoRedis) {
            const cached = await safeRedisGet(redis, cacheKey, '浏览记录缓存读取');
            if (cached) {
                try {
                    const parsedData = JSON.parse(cached);
                    const resultMap = new Map();
                    
                    // 过滤出需要的相册路径
                    albumPaths.forEach(path => {
                        if (parsedData[path]) {
                            resultMap.set(path, parsedData[path]);
                        }
                    });
                    
                    // 缓存命中
                    logger.debug(`[ViewedCache] 缓存命中: userId=${userId}, ${resultMap.size}/${albumPaths.length}个相册`);
                    return resultMap;
                } catch (parseError) {
                    logger.warn('[ViewedCache] 缓存数据解析失败，回退到数据库查询', parseError);
                }
            }
        }
    } catch (error) {
        logger.debug('[ViewedCache] Redis查询失败，回退到数据库查询', error);
    }

    // 缓存未命中，查询数据库
    return await loadFromDatabase(userId, albumPaths, cacheKey);
}

/**
 * 从数据库加载浏览记录并更新缓存
 * @param {string} userId - 用户ID
 * @param {Array<string>} albumPaths - 相册路径列表
 * @param {string} cacheKey - Redis缓存键
 * @returns {Promise<Map<string, number>>}
 */
async function loadFromDatabase(userId, albumPaths, cacheKey) {
    try {
        const placeholders = albumPaths.map(() => '?').join(',');
        const viewRows = await dbAll(
            'history',
            `SELECT item_path, MAX(viewed_at) AS last_viewed 
             FROM view_history 
             WHERE user_id = ? AND item_path IN (${placeholders}) 
             GROUP BY item_path`,
            [userId, ...albumPaths]
        );

        const lastViewedMap = new Map(viewRows.map(v => [v.item_path, v.last_viewed || 0]));
        
        // ✅ 优化：异步更新Redis缓存（不阻塞响应）
        updateCacheAsync(userId, lastViewedMap, cacheKey).catch(err => {
            logger.debug('[ViewedCache] 缓存更新失败（异步）', err);
        });
        
        logger.debug(`[ViewedCache] 数据库查询: userId=${userId}, ${lastViewedMap.size}/${albumPaths.length}个相册有浏览记录`);
        return lastViewedMap;
    } catch (error) {
        logger.warn('[ViewedCache] 数据库查询失败，返回空结果', error);
        return new Map();
    }
}

/**
 * 异步更新Redis缓存
 * @param {string} userId - 用户ID
 * @param {Map<string, number>} viewedMap - 浏览记录Map
 * @param {string} cacheKey - Redis缓存键
 */
async function updateCacheAsync(userId, viewedMap, cacheKey) {
    if (!redis || redis.isNoRedis) {
        return;
    }

    try {
        // 转换为普通对象存储
        const dataObj = Object.fromEntries(viewedMap);
        const TTL = 3600; // 1小时
        
        await safeRedisSet(
            redis, 
            cacheKey, 
            JSON.stringify(dataObj), 
            'EX', 
            TTL, 
            '浏览记录缓存写入'
        );
        
        logger.debug(`[ViewedCache] 缓存已更新: userId=${userId}, ${viewedMap.size}个相册, TTL=${TTL}s`);
    } catch (error) {
        logger.debug('[ViewedCache] 缓存写入失败', error);
    }
}

/**
 * 增量更新缓存（用户浏览新相册时调用）
 * @param {string} userId - 用户ID
 * @param {string} albumPath - 相册路径
 * @param {number} viewedAt - 浏览时间戳
 */
async function incrementalUpdateCache(userId, albumPath, viewedAt) {
    if (!userId || !albumPath || !redis || redis.isNoRedis) {
        return;
    }

    const cacheKey = `viewed:${userId}:albums`;
    
    try {
        // 读取现有缓存
        const cached = await safeRedisGet(redis, cacheKey, '浏览记录缓存读取');
        let dataObj = {};
        
        if (cached) {
            try {
                dataObj = JSON.parse(cached);
            } catch (parseError) {
                logger.debug('[ViewedCache] 缓存解析失败，创建新缓存');
            }
        }
        
        // 更新单条记录
        dataObj[albumPath] = viewedAt;
        
        const TTL = 3600; // 1小时
        await safeRedisSet(
            redis, 
            cacheKey, 
            JSON.stringify(dataObj), 
            'EX', 
            TTL, 
            '浏览记录缓存增量更新'
        );
        
        logger.debug(`[ViewedCache] 增量更新成功: userId=${userId}, path=${albumPath}`);
    } catch (error) {
        logger.debug('[ViewedCache] 增量更新失败', error);
    }
}

/**
 * 清除用户浏览记录缓存
 * @param {string} userId - 用户ID
 */
async function invalidateUserCache(userId) {
    if (!userId || !redis || redis.isNoRedis) {
        return;
    }

    const cacheKey = `viewed:${userId}:albums`;
    
    try {
        await redis.del(cacheKey);
        logger.debug(`[ViewedCache] 缓存已清除: userId=${userId}`);
    } catch (error) {
        logger.debug('[ViewedCache] 缓存清除失败', error);
    }
}

module.exports = {
    getViewedAlbumsCache,
    incrementalUpdateCache,
    invalidateUserCache
};
