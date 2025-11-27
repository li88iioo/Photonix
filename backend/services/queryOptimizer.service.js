/**
 * 查询优化服务模块
 * 提供数据库查询性能优化和索引建议
 */

const { dbAll, dbGet } = require('../db/multi-db');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const { safeRedisGet, safeRedisSet } = require('../utils/helpers');

/**
 * 查询性能分析器
 */
class QueryPerformanceAnalyzer {
    constructor() {
        this.queryStats = new Map();
        this.slowQueryThreshold = 1000; // 1秒
    }

    /**
     * 记录查询性能
     * @param {string} queryId - 查询ID
     * @param {number} duration - 执行时间（毫秒）
     * @param {Object} metadata - 元数据
     */
    recordQueryPerformance(queryId, duration, metadata = {}) {
        if (!this.queryStats.has(queryId)) {
            this.queryStats.set(queryId, {
                count: 0,
                totalDuration: 0,
                maxDuration: 0,
                minDuration: Infinity,
                slowCount: 0
            });
        }

        const stats = this.queryStats.get(queryId);
        stats.count++;
        stats.totalDuration += duration;
        stats.maxDuration = Math.max(stats.maxDuration, duration);
        stats.minDuration = Math.min(stats.minDuration, duration);

        if (duration > this.slowQueryThreshold) {
            stats.slowCount++;
        }

        // 记录慢查询详情
        if (duration > this.slowQueryThreshold) {
            logger.warn(`${LOG_PREFIXES.SLOW_QUERY} ${queryId}: ${duration}ms`, metadata);
        }
    }

    /**
     * 获取查询性能统计
     * @param {string} queryId - 查询ID（可选，获取所有）
     * @returns {Object} 性能统计
     */
    getQueryStats(queryId = null) {
        if (queryId) {
            const stats = this.queryStats.get(queryId);
            return stats ? { ...stats, avgDuration: stats.totalDuration / stats.count } : null;
        }

        const allStats = {};
        for (const [id, stats] of this.queryStats.entries()) {
            allStats[id] = { ...stats, avgDuration: stats.totalDuration / stats.count };
        }
        return allStats;
    }

    /**
     * 重置性能统计
     */
    resetStats() {
        this.queryStats.clear();
    }
}

/**
 * 数据库索引优化器
 */
class DatabaseIndexOptimizer {
    /**
     * 分析表结构并建议索引
     * @param {string} dbType - 数据库类型
     * @param {string} tableName - 表名
     * @returns {Promise<Array>} 索引建议
     */
    async analyzeTableIndexes(dbType, tableName) {
        try {
            const suggestions = [];

            // 获取现有索引
            const existingIndexes = await dbAll(dbType, `
                SELECT name, sql
                FROM sqlite_master
                WHERE type = 'index'
                  AND tbl_name = ?
                  AND sql IS NOT NULL
            `, [tableName]);

            // 获取表结构
            const columns = await dbAll(dbType, `PRAGMA table_info(${tableName})`);

            // 分析常用查询模式并建议索引
            const commonPatterns = [
                { columns: ['type'], name: 'idx_type' },
                { columns: ['path'], name: 'idx_path' },
                { columns: ['mtime'], name: 'idx_mtime' },
                { columns: ['status'], name: 'idx_status' },
                { columns: ['type', 'status'], name: 'idx_type_status' },
                { columns: ['path', 'type'], name: 'idx_path_type' }
            ];

            for (const pattern of commonPatterns) {
                const indexExists = existingIndexes.some(idx =>
                    idx.sql && idx.sql.includes(`(${pattern.columns.join(', ')})`)
                );

                if (!indexExists) {
                    suggestions.push({
                        type: 'CREATE_INDEX',
                        table: tableName,
                        name: pattern.name,
                        columns: pattern.columns,
                        sql: `CREATE INDEX ${pattern.name} ON ${tableName} (${pattern.columns.join(', ')})`
                    });
                }
            }

            return suggestions;
        } catch (error) {
            logger.warn(`分析表${tableName}索引失败:`, error.message);
            return [];
        }
    }

    /**
     * 执行索引优化建议
     * @param {string} dbType - 数据库类型
     * @param {Array} suggestions - 优化建议
     * @returns {Promise<Array>} 执行结果
     */
    async executeIndexOptimizations(dbType, suggestions) {
        const results = [];

        for (const suggestion of suggestions) {
            if (suggestion.type === 'CREATE_INDEX') {
                try {
                    await dbAll(dbType, suggestion.sql);
                    results.push({
                        success: true,
                        suggestion,
                        message: `成功创建索引: ${suggestion.name}`
                    });
                    logger.info(`创建索引成功: ${suggestion.name} ON ${suggestion.table}`);
                } catch (error) {
                    results.push({
                        success: false,
                        suggestion,
                        error: error.message,
                        message: `创建索引失败: ${suggestion.name}`
                    });
                    logger.warn(`创建索引失败: ${suggestion.name}`, error.message);
                }
            }
        }

        return results;
    }
}

/**
 * 查询结果缓存优化器
 */
class QueryCacheOptimizer {
    constructor(redis) {
        this.redis = redis;
        this.cacheHitRatio = 0;
        this.totalQueries = 0;
        this.cacheHits = 0;
    }

    /**
     * 生成查询缓存键
     * @param {string} queryType - 查询类型
     * @param {Object} params - 查询参数
     * @returns {string} 缓存键
     */
    generateCacheKey(queryType, params) {
        const paramStr = Object.keys(params)
            .sort()
            .map(key => `${key}:${JSON.stringify(params[key])}`)
            .join('|');
        return `query_cache:${queryType}:${Buffer.from(paramStr).toString('base64').substring(0, 32)}`;
    }

    /**
     * 获取缓存的查询结果
     * @param {string} cacheKey - 缓存键
     * @returns {Promise<Object|null>} 缓存的结果
     */
    async getCachedResult(cacheKey) {
        try {
            this.totalQueries++;

            if (!this.redis || this.redis.isNoRedis) {
                return null;
            }

            const cached = await safeRedisGet(this.redis, cacheKey, '查询优化器缓存读取');
            if (cached) {
                try {
                    this.cacheHits++;
                    this.updateCacheHitRatio();
                    return JSON.parse(cached);
                } catch (error) {
                    logger.debug('解析缓存数据失败:', error.message);
                    return null;
                }
            }

            return null;
        } catch (error) {
            logger.debug('获取查询缓存失败:', error.message);
            return null;
        }
    }

    /**
     * 缓存查询结果
     * @param {string} cacheKey - 缓存键
     * @param {Object} result - 查询结果
     * @param {number} ttlSeconds - 缓存时间（秒）
     */
    async cacheResult(cacheKey, result, ttlSeconds = 300) {
        if (!this.redis || this.redis.isNoRedis) {
            return;
        }

        await safeRedisSet(this.redis, cacheKey, JSON.stringify(result), 'EX', ttlSeconds, '查询优化器缓存写入');
    }

    /**
     * 更新缓存命中率
     */
    updateCacheHitRatio() {
        if (this.totalQueries > 0) {
            this.cacheHitRatio = this.cacheHits / this.totalQueries;
        }
    }

    /**
     * 获取缓存统计信息
     * @returns {Object} 缓存统计
     */
    getCacheStats() {
        return {
            totalQueries: this.totalQueries,
            cacheHits: this.cacheHits,
            cacheHitRatio: this.cacheHitRatio,
            cacheMisses: this.totalQueries - this.cacheHits
        };
    }

    /**
     * 重置缓存统计
     */
    resetStats() {
        this.totalQueries = 0;
        this.cacheHits = 0;
        this.cacheHitRatio = 0;
    }
}

// 创建单例实例
const queryAnalyzer = new QueryPerformanceAnalyzer();
const indexOptimizer = new DatabaseIndexOptimizer();

module.exports = {
    QueryPerformanceAnalyzer,
    DatabaseIndexOptimizer,
    QueryCacheOptimizer,
    queryAnalyzer,
    indexOptimizer
};
