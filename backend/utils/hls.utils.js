/**
 * HLS状态检查工具
 * 基于文件系统检查HLS文件是否存在，避免数据库查询
 * 支持Redis持久化缓存和跨进程同步
 */
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const { THUMBS_DIR } = require('../config');
const { safeRedisGet, safeRedisSet, safeRedisDel } = require('./helpers');

// Redis客户端（延迟初始化）
let redisClient = null;
const getRedisClient = () => {
    if (!redisClient) {
        try {
            redisClient = require('../config/redis').redis;
        } catch (e) {
            logger.debug('Redis客户端初始化失败，将使用纯内存缓存模式');
            return null;
        }
    }
    return redisClient;
};

// 内存缓存，避免重复文件系统检查
const hlsCache = new Map();
const { HLS_CACHE_TTL_MS, HLS_CHECK_BATCH_SIZE } = require('../config');
const CACHE_TTL = HLS_CACHE_TTL_MS; // 从配置读取缓存TTL

// 缓存大小限制（防止内存无限增长）
const HLS_CACHE_MAX_SIZE = Number(process.env.HLS_CACHE_MAX_SIZE || 10000);

/**
 * 安全设置 hlsCache，带 LRU 淘汰
 * @param {string} key 
 * @param {object} value 
 */
function setHlsCache(key, value) {
    // 触碰已存在 key 以更新访问顺序（Map 的插入顺序即 LRU 顺序）
    if (hlsCache.has(key)) {
        hlsCache.delete(key);
    }
    if (hlsCache.size >= HLS_CACHE_MAX_SIZE) {
        // LRU: 删除最旧的条目
        const firstKey = hlsCache.keys().next().value;
        if (firstKey !== undefined) {
            hlsCache.delete(firstKey);
        }
    }
    hlsCache.set(key, value);
}

// 硬盘保护：限制文件系统检查频率
const lastCheckTimes = new Map();
const { HLS_MIN_CHECK_INTERVAL_MS, HLS_BATCH_DELAY_MS } = require('../config');
const MIN_CHECK_INTERVAL = HLS_MIN_CHECK_INTERVAL_MS; // 从配置读取最小检查间隔

/**
 * 安全设置 lastCheckTimes，带 LRU 淘汰
 * @param {string} key 
 * @param {number} timestamp 
 */
function setLastCheckTime(key, timestamp) {
    // 触碰已存在 key 以更新访问顺序
    if (lastCheckTimes.has(key)) {
        lastCheckTimes.delete(key);
    }
    if (lastCheckTimes.size >= HLS_CACHE_MAX_SIZE) {
        // LRU: 删除最旧的条目
        const firstKey = lastCheckTimes.keys().next().value;
        if (firstKey !== undefined) {
            lastCheckTimes.delete(firstKey);
        }
    }
    lastCheckTimes.set(key, timestamp);
}

// Redis缓存键前缀
const HLS_CACHE_PREFIX = 'hls_cache:';
const HLS_LAST_CHECK_PREFIX = 'hls_last_check:';

/**
 * Redis缓存操作辅助函数
 */
class RedisCacheHelper {
    constructor() {
        this.redis = getRedisClient();
        this.enabled = !!this.redis;
    }

    /**
     * 从Redis获取缓存值
     */
    async get(key) {
        if (!this.enabled) return null;
        const value = await safeRedisGet(this.redis, key, 'HLS缓存读取');
        if (value) {
            try {
                return JSON.parse(value);
            } catch (e) {
                logger.debug(`HLS缓存数据解析失败: ${key}`, e.message);
                return null;
            }
        }
        return null;
    }

    /**
     * 设置Redis缓存值
     */
    async set(key, value, ttlMs = CACHE_TTL) {
        if (!this.enabled) return false;
        const serialized = JSON.stringify(value);
        if (ttlMs > 0) {
            return await safeRedisSet(this.redis, key, serialized, 'PX', ttlMs, 'HLS缓存写入');
        } else {
            return await safeRedisSet(this.redis, key, serialized, null, null, 'HLS缓存写入');
        }
    }

    /**
     * 删除Redis缓存值
     */
    async del(key) {
        if (!this.enabled) return false;
        const result = await safeRedisDel(this.redis, key, 'HLS缓存删除');
        return result > 0;
    }

    /**
     * 获取HLS缓存键
     */
    getHlsCacheKey(videoPath) {
        return `${HLS_CACHE_PREFIX}${videoPath}`;
    }

    /**
     * 获取最后检查时间缓存键
     */
    getLastCheckKey(videoPath) {
        return `${HLS_LAST_CHECK_PREFIX}${videoPath}`;
    }
}

// 创建全局缓存助手实例
const redisCache = new RedisCacheHelper();

/**
 * 清理过期的缓存项
 * 同时清理 hlsCache 和 lastCheckTimes
 */
function cleanupCache() {
    const now = Date.now();
    let cleanedHls = 0;
    let cleanedTimes = 0;

    // 清理 HLS 缓存
    for (const [key, value] of hlsCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            hlsCache.delete(key);
            cleanedHls++;
        }
    }

    // 清理检查时间记录
    for (const [key, timestamp] of lastCheckTimes.entries()) {
        if (now - timestamp > CACHE_TTL) {
            lastCheckTimes.delete(key);
            cleanedTimes++;
        }
    }

    if (cleanedHls > 0 || cleanedTimes > 0) {
        logger.debug(`[HLS_CACHE_CLEANUP] 清理了 ${cleanedHls} 个 HLS 缓存项和 ${cleanedTimes} 个检查时间记录`);
    }
}

// 定期清理过期缓存（每 30 分钟）
const HLS_CACHE_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const hlsCacheCleanupTimer = setInterval(cleanupCache, HLS_CACHE_CLEANUP_INTERVAL_MS);
if (typeof hlsCacheCleanupTimer.unref === 'function') {
    hlsCacheCleanupTimer.unref(); // 防止阻止进程退出
}

/**
 * 检查视频的HLS文件是否存在
 * @param {string} videoPath - 视频文件的相对路径
 * @returns {boolean} - 如果HLS文件存在返回true
 */
async function checkHlsExists(videoPath) {
    const now = Date.now();

    // 1. 检查内存缓存
    const memoryCached = hlsCache.get(videoPath);
    if (memoryCached && (now - memoryCached.timestamp) < CACHE_TTL) {
        // 命中时触碰以更新 LRU 顺序
        setHlsCache(videoPath, memoryCached);
        return memoryCached.exists;
    }

    // 2. 检查Redis缓存（如果可用）
    let redisCached = null;
    if (redisCache.enabled) {
        try {
            redisCached = await redisCache.get(redisCache.getHlsCacheKey(videoPath));
            if (redisCached && (now - redisCached.timestamp) < CACHE_TTL) {
                // 同步到内存缓存
                setHlsCache(videoPath, redisCached);
                return redisCached.exists;
            }
        } catch (e) {
            logger.debug(`Redis缓存检查失败: ${videoPath}`, e.message);
        }
    }

    // 3. 硬盘保护：限制检查频率
    let lastCheckTime = lastCheckTimes.get(videoPath);

    // 如果Redis可用，也检查Redis中的最后检查时间
    if (!lastCheckTime && redisCache.enabled) {
        try {
            const redisLastCheck = await redisCache.get(redisCache.getLastCheckKey(videoPath));
            if (redisLastCheck) {
                lastCheckTime = redisLastCheck.timestamp;
                setLastCheckTime(videoPath, lastCheckTime); // 同步到内存，并应用 LRU 上限
            }
        } catch (e) {
            logger.debug(`Redis最后检查时间读取失败: ${videoPath}`, e.message);
        }
    }

    if (lastCheckTime && (now - lastCheckTime) < MIN_CHECK_INTERVAL) {
        // 触碰该 key，避免热点条目在 LRU 中被提前淘汰
        setLastCheckTime(videoPath, lastCheckTime);
        // 如果距离上次检查时间太短，返回缓存结果或false
        if (memoryCached) {
            setHlsCache(videoPath, memoryCached);
        }
        return memoryCached ? memoryCached.exists : false;
    }

    // 更新最后检查时间
    setLastCheckTime(videoPath, now);
    if (redisCache.enabled) {
        try {
            await redisCache.set(redisCache.getLastCheckKey(videoPath), { timestamp: now }, CACHE_TTL);
        } catch (e) {
            logger.debug(`Redis最后检查时间更新失败: ${videoPath}`, e.message);
        }
    }

    try {
        // 构建HLS目录路径
        const hlsDir = path.join(THUMBS_DIR, 'hls', videoPath);

        // 检查主播放列表是否存在
        const masterPlaylist = path.join(hlsDir, 'master.m3u8');
        const masterExists = await fs.access(masterPlaylist).then(() => true).catch(() => false);

        if (!masterExists) {
            const result = { exists: false, timestamp: now };
            setHlsCache(videoPath, result);
            if (redisCache.enabled) {
                redisCache.set(redisCache.getHlsCacheKey(videoPath), result, CACHE_TTL);
            }
            return false;
        }

        // 检查至少一个分辨率目录存在
        const resolutions = ['480p', '720p'];
        for (const res of resolutions) {
            const resDir = path.join(hlsDir, res);
            const streamPlaylist = path.join(resDir, 'stream.m3u8');
            const streamExists = await fs.access(streamPlaylist).then(() => true).catch(() => false);

            if (streamExists) {
                // 检查是否有至少一个分片文件
                try {
                    const files = await fs.readdir(resDir);
                    const hasSegments = files.some(file => file.endsWith('.ts'));
                    if (hasSegments) {
                        const result = { exists: true, timestamp: now };
                        setHlsCache(videoPath, result);
                        if (redisCache.enabled) {
                            redisCache.set(redisCache.getHlsCacheKey(videoPath), result, CACHE_TTL);
                        }
                        return true; // 找到有效的HLS流
                    }
                } catch (e) {
                    logger.debug(`无法读取HLS目录: ${resDir}, 错误: ${e.message}`);
                    // 继续检查下一个分辨率目录
                }
            }
        }

        const result = { exists: false, timestamp: now };
        setHlsCache(videoPath, result);
        if (redisCache.enabled) {
            redisCache.set(redisCache.getHlsCacheKey(videoPath), result, CACHE_TTL);
        }
        return false;
    } catch (error) {
        logger.debug(`检查HLS状态失败: ${videoPath}`, error.message);
        // 缓存失败结果，但使用较短的TTL
        const result = { exists: false, timestamp: now - CACHE_TTL + 30000 };
        setHlsCache(videoPath, result);
        if (redisCache.enabled) {
            redisCache.set(redisCache.getHlsCacheKey(videoPath), result, 30000); // 30秒TTL
        }
        return false;
    }
}

/**
 * 批量检查多个视频的HLS状态
 * @param {Array<string>} videoPaths - 视频文件路径数组
 * @returns {Promise<Set<string>>} - 已处理视频路径的Set
 */
async function batchCheckHlsStatus(videoPaths) {
    const hlsReadySet = new Set();

    // 清理过期缓存
    cleanupCache();

    // 并行检查，但限制并发数避免系统压力
    const batchSize = HLS_CHECK_BATCH_SIZE;
    for (let i = 0; i < videoPaths.length; i += batchSize) {
        const batch = videoPaths.slice(i, i + batchSize);

        // 硬盘保护：串行处理批次，避免并发I/O压力
        for (const videoPath of batch) {
            const exists = await checkHlsExists(videoPath);
            if (exists) {
                hlsReadySet.add(videoPath);
            }
        }

        // 批次间延迟，给硬盘休息时间
        if (i + batchSize < videoPaths.length) {
            await new Promise(resolve => setTimeout(resolve, HLS_BATCH_DELAY_MS));
        }
    }

    return hlsReadySet;
}

/**
 * 创建HLS处理记录文件
 * @param {string} videoPath - 视频路径
 * @param {Object} metadata - 处理元数据
 */
async function createHlsRecord(videoPath, metadata = {}) {
    try {
        const recordDir = path.join(THUMBS_DIR, 'hls', '_records');
        await fs.mkdir(recordDir, { recursive: true });

        const recordFile = path.join(recordDir, `${videoPath.replace(/[\/\\]/g, '_')}.json`);
        const record = {
            videoPath,
            processedAt: new Date().toISOString(),
            ...metadata
        };

        await fs.writeFile(recordFile, JSON.stringify(record, null, 2));

        // 更新缓存
        const cacheResult = { exists: true, timestamp: Date.now() };
        setHlsCache(videoPath, cacheResult);

        // 同步到Redis缓存
        if (redisCache.enabled) {
            try {
                await redisCache.set(redisCache.getHlsCacheKey(videoPath), cacheResult, CACHE_TTL);
            } catch (e) {
                logger.debug(`Redis缓存同步失败: ${videoPath}`, e.message);
            }
        }

        logger.debug(`HLS处理记录已创建: ${recordFile}`);
    } catch (error) {
        logger.warn(`创建HLS处理记录失败: ${videoPath}`, error.message);
    }
}

/**
 * 检查HLS处理记录是否存在
 * @param {string} videoPath - 视频路径
 * @returns {boolean} - 如果记录存在返回true
 */
async function checkHlsRecord(videoPath) {
    try {
        const recordDir = path.join(THUMBS_DIR, 'hls', '_records');
        const recordFile = path.join(recordDir, `${videoPath.replace(/[\/\\]/g, '_')}.json`);

        return await fs.access(recordFile).then(() => true).catch(() => false);
    } catch (error) {
        return false;
    }
}

/**
 * 清理过期的HLS处理记录
 * @param {number} maxAge - 最大保留天数，默认30天
 */
async function cleanupHlsRecords(maxAge = 30) {
    try {
        const recordDir = path.join(THUMBS_DIR, 'hls', '_records');
        const files = await fs.readdir(recordDir).catch(() => []);

        const cutoffTime = Date.now() - (maxAge * 24 * 60 * 60 * 1000);
        let cleanedCount = 0;

        for (const file of files) {
            if (!file.endsWith('.json')) continue;

            const filePath = path.join(recordDir, file);
            try {
                const stats = await fs.stat(filePath);
                if (stats.mtimeMs < cutoffTime) {
                    await fs.unlink(filePath);
                    cleanedCount++;
                }
            } catch (e) {
                logger.debug(`清理HLS记录失败: ${file}`, e.message);
            }
        }

        if (cleanedCount > 0) {
            logger.info(`清理了 ${cleanedCount} 个过期的HLS处理记录`);
        }
    } catch (error) {
        logger.warn('清理HLS记录失败', error.message);
    }
}

/**
 * 清除指定视频的缓存
 * @param {string} videoPath - 视频路径，如果为空则清除所有缓存
 */
async function clearHlsCache(videoPath) {
    if (videoPath) {
        // 清除单个视频的缓存
        hlsCache.delete(videoPath);
        lastCheckTimes.delete(videoPath);

        // 清除Redis缓存
        if (redisCache.enabled) {
            try {
                await redisCache.del(redisCache.getHlsCacheKey(videoPath));
                await redisCache.del(redisCache.getLastCheckKey(videoPath));
            } catch (e) {
                logger.debug(`Redis缓存清理失败: ${videoPath}`, e.message);
            }
        }
    } else {
        // 清除所有缓存
        hlsCache.clear();
        lastCheckTimes.clear();

        // 清除Redis缓存（使用通配符删除，但这里简化处理）
        if (redisCache.enabled) {
            try {
                // 注意：Redis不支持通配符删除，这里只是示例
                // 在生产环境中，可能需要使用SCAN命令或维护缓存键列表
                logger.debug('Redis全局缓存清理：建议重启服务以完全清理');
            } catch (e) {
                logger.debug('Redis全局缓存清理失败', e.message);
            }
        }
    }
}

module.exports = {
    checkHlsExists,
    batchCheckHlsStatus,
    createHlsRecord,
    checkHlsRecord,
    cleanupHlsRecords,
    clearHlsCache
};
