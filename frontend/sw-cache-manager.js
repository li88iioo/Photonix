// frontend/sw-cache-manager.js
// Service Worker缓存管理器 - 统一LRU清理和缓存策略

/**
 * 缓存配置 - 集中管理所有缓存阈值和策略
 */
const CACHE_CONFIG = {
    // API缓存配置
    API: {
        MAX_ENTRIES: 500,
        MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000, // 7天
        CLEANUP_INTERVAL_MS: 60 * 60 * 1000 // 1小时清理一次
    },

    // 媒体缓存配置
    MEDIA: {
        MAX_ENTRIES: 800,
        MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000, // 30天
        CLEANUP_INTERVAL_MS: 2 * 60 * 60 * 1000 // 2小时清理一次
    },

    // 缩略图缓存配置
    THUMBNAIL: {
        MAX_ENTRIES: 2000,
        MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000, // 30天
        CLEANUP_INTERVAL_MS: 2 * 60 * 60 * 1000 // 2小时清理一次
    },

    // 静态资源缓存配置
    STATIC: {
        MAX_ENTRIES: 100,
        MAX_AGE_MS: 24 * 60 * 60 * 1000, // 1天
        CLEANUP_INTERVAL_MS: 6 * 60 * 60 * 1000 // 6小时清理一次
    }
};

/**
 * 缓存统计信息
 */
const cacheStats = {
    api: { hits: 0, misses: 0, evictions: 0, size: 0 },
    media: { hits: 0, misses: 0, evictions: 0, size: 0 },
    thumbnail: { hits: 0, misses: 0, evictions: 0, size: 0 },
    static: { hits: 0, misses: 0, evictions: 0, size: 0 }
};

/**
 * 获取缓存配置，支持全局覆盖
 * @param {string} cacheType - 缓存类型
 * @returns {object} 缓存配置
 */
function getCacheConfig(cacheType) {
    const config = CACHE_CONFIG[cacheType.toUpperCase()];
    if (!config) {
        throw new Error(`Unknown cache type: ${cacheType}`);
    }

    // 支持全局配置覆盖
    try {
        const globalConfig = self.__APP_SETTINGS?.cache?.[cacheType.toLowerCase()];
        if (globalConfig) {
            return { ...config, ...globalConfig };
        }
    } catch {}

    return config;
}

/**
 * 获取时间戳（支持多种时间戳格式）
 * @param {Response} response - 缓存响应
 * @returns {number} 时间戳
 */
function getTimestamp(response) {
    // 优先使用自定义时间戳头
    const customTimestamp = response.headers.get('x-cached-at');
    if (customTimestamp && !Number.isNaN(Number(customTimestamp))) {
        return Number(customTimestamp);
    }

    // 使用响应时间戳
    const dateHeader = response.headers.get('date');
    if (dateHeader) {
        const date = new Date(dateHeader).getTime();
        if (!Number.isNaN(date)) {
            return date;
        }
    }

    // 默认使用当前时间
    return Date.now();
}

/**
 * 检查响应是否适合缓存
 * @param {Response} response - HTTP响应
 * @param {Request} request - HTTP请求
 * @returns {boolean} 是否适合缓存
 */
function isCacheableResponse(response, request) {
    // 只缓存成功的响应
    if (!response.ok) return false;

    // 不缓存206 Partial Content响应
    if (response.status === 206) return false;

    // 不缓存非GET请求
    if (request && request.method !== 'GET') return false;

    // 不缓存非基本或CORS响应
    if (response.type !== 'basic' && response.type !== 'cors') return false;

    return true;
}

/**
 * 执行LRU清理
 * @param {string} cacheName - 缓存名称
 * @param {object} limits - 清理限制
 * @returns {Promise<object>} 清理统计信息
 */
async function performLRUCleanup(cacheName, limits) {
    const { MAX_ENTRIES, MAX_AGE_MS } = limits;
    let evictedCount = 0;
    let expiredCount = 0;
    let totalEntries = 0;

    try {
        const cache = await caches.open(cacheName);
        const keys = await cache.keys();

        if (!keys || keys.length === 0) {
            return { evictedCount: 0, expiredCount: 0, totalEntries: 0 };
        }

        const now = Date.now();
        const entries = [];

        // 收集所有缓存条目的时间戳
        for (const request of keys) {
            try {
                const response = await cache.match(request);
                if (!response) continue;

                const timestamp = getTimestamp(response);
                entries.push({ request, response, timestamp });
            } catch (error) {
                // 如果无法读取响应，跳过此条目
                continue;
            }
        }

        totalEntries = entries.length;

        // 过期清理
        const expired = entries.filter(entry => now - entry.timestamp > MAX_AGE_MS);
        expiredCount = expired.length;
        await Promise.allSettled(expired.map(entry =>
            cache.delete(entry.request).catch(() => {})
        ));

        // 超额裁剪（按LRU策略）
        const remaining = entries
            .filter(entry => now - entry.timestamp <= MAX_AGE_MS)
            .sort((a, b) => b.timestamp - a.timestamp); // 按访问时间降序排序

        if (remaining.length > MAX_ENTRIES) {
            const toEvict = remaining.slice(MAX_ENTRIES);
            evictedCount = toEvict.length;
            await Promise.allSettled(toEvict.map(entry =>
                cache.delete(entry.request).catch(() => {})
            ));
        }

        // 更新统计信息
        const cacheType = getCacheTypeFromName(cacheName);
        if (cacheType && cacheStats[cacheType]) {
            cacheStats[cacheType].evictions += evictedCount;
            cacheStats[cacheType].size = Math.max(0, entries.length - expiredCount - evictedCount);
        }

    } catch (error) {
        // 清理过程中出错，记录但不抛出
        console.warn(`[SW Cache] 缓存清理失败 ${cacheName}:`, error);
    }

    return { evictedCount, expiredCount, totalEntries };
}

/**
 * 从缓存名称获取缓存类型
 * @param {string} cacheName - 缓存名称
 * @returns {string|null} 缓存类型
 */
function getCacheTypeFromName(cacheName) {
    if (cacheName.includes('api')) return 'api';
    if (cacheName.includes('media')) return 'media';
    if (cacheName.includes('thumb')) return 'thumbnail';
    if (cacheName.includes('static')) return 'static';
    return null;
}

/**
 * 统一的缓存写入接口
 * @param {string} cacheType - 缓存类型
 * @param {Request} request - 请求对象
 * @param {Response} response - 响应对象
 * @returns {Promise<void>}
 */
async function putWithLRU(cacheType, request, response, options = {}) {
    try {
        const baseConfig = getCacheConfig(cacheType);
        const config = {
            ...baseConfig,
            ...(options.maxAgeMs ? { MAX_AGE_MS: options.maxAgeMs } : null),
            ...(options.maxEntries ? { MAX_ENTRIES: options.maxEntries } : null)
        };
        const cacheName = options.cacheName || getCacheNameForType(cacheType, options.version || null);

        // 检查响应是否适合缓存
        if (!isCacheableResponse(response, request)) {
            return;
        }

        const cache = await caches.open(cacheName);

        // 为响应添加时间戳
        const cachedAt = Date.now();
        const headersObject = Object.fromEntries(response.headers.entries());
        headersObject['x-cached-at'] = cachedAt.toString();
        if (options.maxAgeMs && Number.isFinite(options.maxAgeMs)) {
            headersObject['x-cache-expires-at'] = (cachedAt + options.maxAgeMs).toString();
        }
        const responseWithTimestamp = new Response(response.clone().body, {
            status: response.status,
            statusText: response.statusText,
            headers: headersObject
        });

        // 写入缓存
        await cache.put(request, responseWithTimestamp);

        // 更新统计信息
        if (cacheStats[cacheType]) {
            cacheStats[cacheType].size++;
        }

        // 执行LRU清理
        await performLRUCleanup(cacheName, config);

    } catch (error) {
        console.warn(`[SW Cache] 缓存失败 ${cacheType}:`, error);
    }
}

/**
 * 获取缓存类型的缓存名称
 * @param {string} cacheType - 缓存类型
 * @param {string} version - 可选的版本标识，默认使用构建版本
 * @returns {string} 缓存名称
 */
function getCacheNameForType(cacheType, version = null) {
    // 如果提供了版本，使用版本；否则使用构建版本或默认值
    const cacheVersion = version || ((self.swCacheManager && self.swCacheManager.__BUILD_REV) || (self.__BUILD_REV || 'v1'));
    switch (cacheType) {
        case 'api': return `api-${cacheVersion}`;
        case 'media': return `media-${cacheVersion}`;
        case 'thumbnail': return `thumb-${cacheVersion}`;
        case 'static': return `static-${cacheVersion}`;
        default: return `cache-${cacheType}-${cacheVersion}`;
    }
}

/**
 * 初始化定期清理任务
 */
function initializePeriodicCleanup() {
    // 为每个缓存类型设置定期清理
    Object.entries(CACHE_CONFIG).forEach(([cacheType, config]) => {
        setInterval(async () => {
            try {
                const cacheName = getCacheNameForType(cacheType.toLowerCase());
                await performLRUCleanup(cacheName, config);
            } catch (error) {
                console.warn(`[SW Cache] 定时清理失败 ${cacheType}:`, error);
            }
        }, config.CLEANUP_INTERVAL_MS);
    });
}

/**
 * 获取缓存统计信息
 * @returns {object} 统计信息
 */
function getCacheStats() {
    return { ...cacheStats };
}

/**
 * 手动触发缓存清理
 * @param {string} cacheType - 缓存类型（可选，默认清理所有）
 * @returns {Promise<object>} 清理结果
 */
async function manualCleanup(cacheType = null) {
    const results = {};

    if (cacheType) {
        const config = getCacheConfig(cacheType);
        const cacheName = getCacheNameForType(cacheType);
        results[cacheType] = await performLRUCleanup(cacheName, config);
    } else {
        // 清理所有缓存类型
        for (const [type, config] of Object.entries(CACHE_CONFIG)) {
            const cacheName = getCacheNameForType(type.toLowerCase());
            results[type.toLowerCase()] = await performLRUCleanup(cacheName, config);
        }
    }

    return results;
}

// 将接口挂载到全局对象，使其可通过importScripts访问
self.swCacheManager = {
    CACHE_CONFIG,
    putWithLRU,
    performLRUCleanup,
    getCacheStats,
    manualCleanup,
    getCacheConfig,
    getCacheNameForType,
    initializePeriodicCleanup,
    isCacheableResponse
};

// 默认导出等价物
self.getCacheStatsDefault = getCacheStats;
