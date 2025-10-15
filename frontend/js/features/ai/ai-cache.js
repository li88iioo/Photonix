/**
 * @file ai-cache.js
 * @description
 *   AI 缓存管理模块，提供前端优先的 AI 密语缓存策略。
 *   支持 IndexedDB 持久化存储与智能缓存管理。
 */

import { MATH, AI_CACHE } from '../../core/constants.js';
import { createModuleLogger } from '../../core/logger.js';

const aiCacheLogger = createModuleLogger('AI-Cache');

/**
 * @typedef {Object} CacheStats
 * @property {number} hits - 缓存命中次数
 * @property {number} misses - 缓存未命中次数
 * @property {number} totalRequests - 总请求次数
 * @property {number} lastCleanup - 上次清理时间戳
 */

/** @type {CacheStats} */
let cacheStats = {
    hits: 0,
    misses: 0,
    totalRequests: 0,
    lastCleanup: Date.now()
};

/**
 * AI 缓存管理器
 * @class
 */
class AICacheManager {
    constructor() {
        /** @type {IDBDatabase|null} */
        this.db = null;
        /** @type {boolean} */
        this.isInitialized = false;
        /** @type {number|null} */
        this.cleanupTimer = null;
        /** @type {Promise<void>} */
        this.initPromise = this.initialize();
        this.startPeriodicCleanup();
    }

    /**
     * 初始化 IndexedDB 数据库
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isInitialized) return;
        try {
            this.db = await this.openDatabase();
            this.isInitialized = true;
        } catch (error) {
            throw error;
        }
    }

    /**
     * 打开 IndexedDB 数据库
     * @returns {Promise<IDBDatabase>}
     */
    async openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(AI_CACHE.DB_NAME, AI_CACHE.VERSION);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // 创建 AI 密语存储表
                if (!db.objectStoreNames.contains(AI_CACHE.CAPTIONS_STORE_NAME)) {
                    const captionStore = db.createObjectStore(AI_CACHE.CAPTIONS_STORE_NAME, { keyPath: 'cacheKey' });
                    captionStore.createIndex('byImagePath', 'imagePath', { unique: false });
                    captionStore.createIndex('byTimestamp', 'timestamp', { unique: false });
                    captionStore.createIndex('byConfigHash', 'configHash', { unique: false });
                }

                // 创建 AI 配置存储表
                if (!db.objectStoreNames.contains(AI_CACHE.CONFIGS_STORE_NAME)) {
                    const configStore = db.createObjectStore(AI_CACHE.CONFIGS_STORE_NAME, { keyPath: 'configKey' });
                    configStore.createIndex('byTimestamp', 'timestamp', { unique: false });
                }
            };
        });
    }

    /**
     * 生成缓存键
     * @param {string} imagePath 图片路径
     * @param {Object} aiConfig AI 配置
     * @returns {string} 缓存键
     */
    generateCacheKey(imagePath, aiConfig) {
        // 生成配置哈希
        const configStr = JSON.stringify({
            url: aiConfig.url,
            model: aiConfig.model,
            prompt: aiConfig.prompt
        });
        const configHash = this.hashString(configStr);

        return `${imagePath}::${configHash}`;
    }

    /**
     * 字符串哈希函数
     * @param {string} str 输入字符串
     * @returns {string} 哈希值
     */
    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 转换为32位整数
        }
        return Math.abs(hash).toString(36);
    }

    /**
     * 检查缓存是否命中
     * @param {string} imagePath 图片路径
     * @param {Object} aiConfig AI 配置
     * @returns {Promise<Object|null>} 命中时返回缓存对象，否则返回 null
     */
    async checkCache(imagePath, aiConfig) {
        await this.initPromise;
        cacheStats.totalRequests++;

        try {
            const cacheKey = this.generateCacheKey(imagePath, aiConfig);
            const transaction = this.db.transaction([AI_CACHE.CAPTIONS_STORE_NAME], 'readonly');
            const store = transaction.objectStore(AI_CACHE.CAPTIONS_STORE_NAME);

            const result = await new Promise((resolve, reject) => {
                const request = store.get(cacheKey);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });

            if (result && this.isCacheValid(result)) {
                cacheStats.hits++;
                return {
                    caption: result.caption,
                    source: 'cache',
                    cachedAt: result.timestamp,
                    configHash: result.configHash
                };
            } else {
                cacheStats.misses++;
                if (result) {
                    // 缓存存在但已过期，删除
                    await this.deleteCacheEntry(cacheKey);
                }
                return null;
            }
        } catch (error) {
            return null;
        }
    }

    /**
     * 判断缓存条目是否有效
     * @param {Object} cacheEntry 缓存条目
     * @returns {boolean} 有效返回 true，否则 false
     */
    isCacheValid(cacheEntry) {
        const now = Date.now();
        const age = now - cacheEntry.timestamp;
        const maxAge = AI_CACHE.CONFIG.MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
        return age < maxAge;
    }

    /**
     * 保存 AI 结果到缓存
     * @param {string} imagePath 图片路径
     * @param {Object} aiConfig AI 配置
     * @param {string} caption 生成的密语
     * @returns {Promise<void>}
     */
    async saveToCache(imagePath, aiConfig, caption) {
        await this.initPromise;

        try {
            const cacheKey = this.generateCacheKey(imagePath, aiConfig);
            const configHash = this.hashString(JSON.stringify({
                url: aiConfig.url,
                model: aiConfig.model,
                prompt: aiConfig.prompt
            }));

            const cacheEntry = {
                cacheKey,
                imagePath,
                configHash,
                caption: caption.trim(),
                timestamp: Date.now(),
                config: {
                    model: aiConfig.model,
                    url: aiConfig.url,
                    promptLength: aiConfig.prompt.length
                },
                metadata: {
                    userAgent: navigator.userAgent,
                    language: navigator.language,
                    platform: navigator.platform
                }
            };

            const transaction = this.db.transaction([AI_CACHE.CAPTIONS_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(AI_CACHE.CAPTIONS_STORE_NAME);

            await new Promise((resolve, reject) => {
                const request = store.put(cacheEntry);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });

            // 触发异步清理
            this.scheduleCleanup();

        } catch (error) {
            // 忽略保存异常
        }
    }

    /**
     * 删除指定缓存条目
     * @param {string} cacheKey 缓存键
     * @returns {Promise<void>}
     */
    async deleteCacheEntry(cacheKey) {
        await this.initPromise;

        try {
            const transaction = this.db.transaction([AI_CACHE.CAPTIONS_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(AI_CACHE.CAPTIONS_STORE_NAME);

            await new Promise((resolve, reject) => {
                const request = store.delete(cacheKey);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });

        } catch (error) {
            // 忽略删除异常
        }
    }

    /**
     * 清理过期缓存条目
     * @returns {Promise<number>} 被清理的条目数量
     */
    async cleanupExpired() {
        await this.initPromise;

        try {
            const transaction = this.db.transaction([AI_CACHE.CAPTIONS_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(AI_CACHE.CAPTIONS_STORE_NAME);
            const index = store.index('byTimestamp');

            const now = Date.now();
            const maxAge = AI_CACHE.CONFIG.MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
            const cutoff = now - maxAge;

            let deletedCount = 0;

            await new Promise((resolve, reject) => {
                const request = index.openCursor();
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        const entry = cursor.value;
                        if (entry.timestamp < cutoff) {
                            cursor.delete();
                            deletedCount++;
                        }
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
                request.onerror = () => reject(request.error);
            });

            return deletedCount;
        } catch (error) {
            return 0;
        }
    }

    /**
     * 清理最旧的缓存条目以控制存储大小
     * @returns {Promise<number>} 被清理的条目数量
     */
    async cleanupOldest() {
        await this.initPromise;

        try {
            const transaction = this.db.transaction([AI_CACHE.CAPTIONS_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(AI_CACHE.CAPTIONS_STORE_NAME);
            const index = store.index('byTimestamp');

            // 获取所有条目数量
            const count = await new Promise((resolve, reject) => {
                const request = store.count();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });

            if (count <= AI_CACHE.CONFIG.MAX_ENTRIES) {
                return 0; // 未超过限制
            }

            const toDelete = count - AI_CACHE.CONFIG.MAX_ENTRIES;
            let deletedCount = 0;

            await new Promise((resolve, reject) => {
                const request = index.openCursor();
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor && deletedCount < toDelete) {
                        cursor.delete();
                        deletedCount++;
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
                request.onerror = () => reject(request.error);
            });

            aiCacheLogger.info('清理最旧条目', { deletedCount });
            return deletedCount;
        } catch (error) {
            aiCacheLogger.error('清理最旧缓存失败', error);
            return 0;
        }
    }

    /**
     * 调度缓存清理任务（延迟执行）
     */
    scheduleCleanup() {
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
        }

        this.cleanupTimer = setTimeout(async () => {
            try {
                const expiredCount = await this.cleanupExpired();
                const oldestCount = await this.cleanupOldest();
                cacheStats.lastCleanup = Date.now();

                if (expiredCount > 0 || oldestCount > 0) {
                    aiCacheLogger.info('清理完成', { expiredCount, oldestCount });
                }
            } catch (error) {
                aiCacheLogger.error('自动清理失败', error);
            }
        }, 1000); // 1 秒后执行清理
    }

    /**
     * 启动定期自动清理
     */
    startPeriodicCleanup() {
        setInterval(() => {
            this.scheduleCleanup();
        }, AI_CACHE.CONFIG.CLEANUP_INTERVAL);
    }

    /**
     * 获取缓存统计信息
     * @returns {Object} 缓存统计数据
     */
    getCacheStats() {
        const hitRate = cacheStats.totalRequests > 0
            ? (cacheStats.hits / cacheStats.totalRequests * 100).toFixed(MATH.CACHE_HIT_RATIO_PRECISION)
            : 0;

        return {
            ...cacheStats,
            hitRate: `${hitRate}%`,
            maxEntries: AI_CACHE.CONFIG.MAX_ENTRIES,
            maxAgeDays: AI_CACHE.CONFIG.MAX_AGE_DAYS,
            lastCleanup: new Date(cacheStats.lastCleanup).toLocaleString()
        };
    }

    /**
     * 清空所有缓存
     * @returns {Promise<void>}
     */
    async clearAllCache() {
        await this.initPromise;

        try {
            const transaction = this.db.transaction([AI_CACHE.CAPTIONS_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(AI_CACHE.CAPTIONS_STORE_NAME);

            await new Promise((resolve, reject) => {
                const request = store.clear();
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });

            // 重置统计信息
            cacheStats = {
                hits: 0,
                misses: 0,
                totalRequests: 0,
                lastCleanup: Date.now()
            };

            aiCacheLogger.info('所有缓存已清空');
        } catch (error) {
            aiCacheLogger.error('清空缓存失败', error);
            throw error;
        }
    }

    /**
     * 获取缓存条目详情（调试用）
     * @param {number} [limit=50] 限制返回数量
     * @returns {Promise<Array>} 缓存条目列表
     */
    async getCacheEntries(limit = 50) {
        await this.initPromise;

        try {
            const transaction = this.db.transaction([AI_CACHE.CAPTIONS_STORE_NAME], 'readonly');
            const store = transaction.objectStore(AI_CACHE.CAPTIONS_STORE_NAME);
            const index = store.index('byTimestamp');

            const entries = [];
            await new Promise((resolve, reject) => {
                const request = index.openCursor(null, 'prev'); // 最新的在前
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor && entries.length < limit) {
                        const entry = cursor.value;
                        entries.push({
                            cacheKey: entry.cacheKey.substring(0, 50) + '...',
                            imagePath: entry.imagePath,
                            timestamp: new Date(entry.timestamp).toLocaleString(),
                            captionLength: entry.caption.length,
                            configHash: entry.configHash
                        });
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
                request.onerror = () => reject(request.error);
            });

            return entries;
        } catch (error) {
            aiCacheLogger.error('获取缓存条目失败', error);
            return [];
        }
    }
}

// 创建单例实例
const aiCacheManager = new AICacheManager();

/**
 * aiCache 命名空间，导出主要方法
 * @namespace aiCache
 */
export const aiCache = {
    /**
     * 检查缓存
     * @param {string} imagePath 图片路径
     * @param {Object} aiConfig AI 配置
     * @returns {Promise<Object|null>} 缓存结果
     */
    async check(imagePath, aiConfig) {
        return aiCacheManager.checkCache(imagePath, aiConfig);
    },

    /**
     * 保存到缓存
     * @param {string} imagePath 图片路径
     * @param {Object} aiConfig AI 配置
     * @param {string} caption AI 生成的密语
     * @returns {Promise<void>}
     */
    async save(imagePath, aiConfig, caption) {
        return aiCacheManager.saveToCache(imagePath, aiConfig, caption);
    },

    /**
     * 获取缓存统计信息
     * @returns {Object} 统计信息
     */
    getStats() {
        return aiCacheManager.getCacheStats();
    },

    /**
     * 清空所有缓存
     * @returns {Promise<void>}
     */
    async clear() {
        return aiCacheManager.clearAllCache();
    },

    /**
     * 获取缓存条目（调试用）
     * @param {number} [limit=50] 限制数量
     * @returns {Promise<Array>} 缓存条目列表
     */
    async getEntries(limit = 50) {
        return aiCacheManager.getCacheEntries(limit);
    },

    /**
     * 手动触发清理
     * @returns {Promise<void>}
     */
    async cleanup() {
        await aiCacheManager.cleanupExpired();
        await aiCacheManager.cleanupOldest();
    }
};

export default aiCache;
