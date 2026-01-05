/**
 * 统计查询仓库模块
 * 提供常用的统计查询方法，避免代码重复
 */
const { dbAll, dbGet } = require('../db/multi-db');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const { RetryManager } = require('../utils/retry');

/**
 * 获取表中记录总数
 * @param {string} tableName - 表名
 * @param {string} dbType - 数据库类型，默认为'main'
 * @param {string} condition - 查询条件（可选）
 * @param {Array} params - 查询参数
 * @returns {Promise<number>} 记录总数
 */
async function getCount(tableName, dbType = 'main', condition = '', params = []) {
    try {
        let sql;

        // 优化常用查询的SQL
        if (tableName === 'thumb_status' && !condition) {
            // 针对thumb_status表的优化查询
            sql = `SELECT COUNT(*) as count FROM thumb_status INDEXED BY idx_thumb_status_count_optimization`;
        } else if (tableName === 'items' && !condition) {
            // 针对items表的优化查询
            sql = `SELECT COUNT(*) as count FROM items INDEXED BY idx_items_count_optimization`;
        } else if (tableName === 'items' && condition.includes("type='video'")) {
            // 针对视频类型查询的优化
            sql = `SELECT COUNT(*) as count FROM items INDEXED BY idx_items_type_id WHERE type='video'`;
        } else if (tableName === 'items' && condition.includes("type='photo'")) {
            // 针对图片类型查询的优化
            sql = `SELECT COUNT(*) as count FROM items INDEXED BY idx_items_type_id WHERE type='photo'`;
        } else {
            // 默认查询
            sql = `SELECT COUNT(*) as count FROM ${tableName} ${condition ? 'WHERE ' + condition : ''}`;
        }

        const row = await dbGet(dbType, sql, params);
        return row ? Number(row.count) || 0 : 0;
    } catch (error) {
        logger.debug(`获取${tableName}表记录数失败:`, error.message);
        return 0;
    }
}

/**
 * 获取多个条件的统计数据
 * @param {string} tableName - 表名
 * @param {string} fieldName - 字段名
 * @param {Array} values - 字段值数组
 * @param {string} dbType - 数据库类型，默认为'main'
 * @returns {Promise<Object>} 统计结果对象
 */
async function getStatsByField(tableName, fieldName, values, dbType = 'main') {
    try {
        const stats = {};

        // 防御性检查：空数组直接返回，避免生成无效 SQL（IN () 语法错误）
        if (!Array.isArray(values) || values.length === 0) {
            return stats;
        }

        // 初始化所有请求的值为0
        values.forEach(value => {
            stats[value] = 0;
        });

        // 使用 GROUP BY 单次查询替代 N 次独立查询
        // 性能优化：SQLite 单线程特性使并行查询无实际收益，GROUP BY 更高效
        const placeholders = values.map(() => '?').join(',');
        const sql = `SELECT ${fieldName}, COUNT(*) as count FROM ${tableName} WHERE ${fieldName} IN (${placeholders}) GROUP BY ${fieldName}`;
        const rows = await dbAll(dbType, sql, values);

        // 合并结果
        rows.forEach(row => {
            const key = row[fieldName];
            if (key in stats) {
                stats[key] = Number(row.count || 0);
            }
        });

        return stats;
    } catch (error) {
        logger.debug(`获取${tableName}表${fieldName}字段统计失败:`, error.message);
        return {};
    }
}

/**
 * 获取分组统计数据
 * @param {string} tableName - 表名
 * @param {string} groupField - 分组字段
 * @param {string} dbType - 数据库类型，默认为'main'
 * @param {string} condition - 查询条件（可选）
 * @param {Array} params - 查询参数
 * @returns {Promise<Array>} 分组统计结果
 */
async function getGroupStats(tableName, groupField, dbType = 'main', condition = '', params = []) {
    try {
        const sql = `SELECT ${groupField}, COUNT(*) as count FROM ${tableName} ${condition ? 'WHERE ' + condition : ''} GROUP BY ${groupField}`;
        const rows = await dbAll(dbType, sql, params);
        return rows || [];
    } catch (error) {
        logger.debug(`获取${tableName}表分组统计失败:`, error.message);
        return [];
    }
}

/**
 * 获取媒体文件统计
 * @param {Array} types - 文件类型数组，如 ['photo', 'video']
 * @returns {Promise<Object>} 统计结果
 */
async function getMediaStats(types = ['photo', 'video']) {
    try {
        const placeholders = types.map(() => '?').join(',');
        const sql = `SELECT type, COUNT(*) as count FROM items WHERE type IN (${placeholders}) GROUP BY type`;

        const rows = await dbAll('main', sql, types);

        const stats = {};
        rows.forEach(row => {
            stats[row.type] = Number(row.count);
        });

        // 确保所有请求的类型都有返回值
        types.forEach(type => {
            if (!(type in stats)) {
                stats[type] = 0;
            }
        });

        return stats;
    } catch (error) {
        logger.debug('获取媒体文件统计失败:', error.message);
        return {};
    }
}

/**
 * 获取缩略图状态统计
 * @returns {Promise<Object>} 缩略图状态统计
 */
async function getThumbStatusStats() {
    try {
        return await getStatsByField('thumb_status', 'status', ['exists', 'missing', 'failed', 'pending', 'processing', 'permanent_failed']);
    } catch (error) {
        logger.debug('获取缩略图状态统计失败:', error.message);
        return {};
    }
}

/**
 * 缩略图统计缓存，避免高频查询数据库
 */
let thumbStatsCache = {
    count: 0,
    timestamp: 0
};
const STATS_CACHE_TTL = 5000; // 5秒缓存

/**
 * 获取缩略图处理状态统计（用于自适应调度）
 * @returns {Promise<number>} 需要处理的缩略图数量
 */
async function getThumbProcessingStats() {
    const now = Date.now();

    // 检查缓存是否有效
    if (now - thumbStatsCache.timestamp < STATS_CACHE_TTL) {
        return thumbStatsCache.count;
    }

    // 缓存失效，执行查询（带重试机制）
    try {
        const count = await RetryManager.executeWithRetry(
            async () => {
                const row = await dbGet('main', "SELECT COUNT(*) as count FROM thumb_status WHERE status IN ('missing','pending','failed','processing')");
                const result = Number(row?.count || 0);

                // 更新缓存
                thumbStatsCache = {
                    count: result,
                    timestamp: now
                };

                return result;
            },
            {
                context: 'thumb-processing-stats-query',
                maxRetries: 3,
                baseDelay: 1000,
                maxDelay: 8000
            }
        );

        return count;
    } catch (error) {
        // 查询失败时返回缓存的旧值（降级策略）
        logger.debug(`获取缩略图处理状态统计失败，返回缓存值 (${thumbStatsCache.count}):`, error.message);
        return thumbStatsCache.count;
    }
}

/**
 * 获取数据完整性统计
 * @returns {Promise<Object>} 数据完整性统计
 */
async function getDataIntegrityStats() {
    try {
        const stats = {};

        // 检查缺失mtime的记录数
        const mtimeStats = await dbGet('main', "SELECT COUNT(1) AS count FROM items WHERE mtime IS NULL OR mtime <= 0");
        stats.missingMtime = Number(mtimeStats?.count || 0);

        // 检查缺失尺寸的记录数
        const dimensionStats = await dbGet('main', "SELECT COUNT(1) AS count FROM items WHERE type IN ('photo','video') AND (width IS NULL OR width <= 0 OR height IS NULL OR height <= 0)");
        stats.missingDimensions = Number(dimensionStats?.count || 0);

        return stats;
    } catch (error) {
        logger.debug('获取数据完整性统计失败:', error.message);
        return { missingMtime: 0, missingDimensions: 0 };
    }
}

module.exports = {
    getCount,
    getStatsByField,
    getGroupStats,
    getMediaStats,
    getThumbStatusStats,
    getThumbProcessingStats,
    getDataIntegrityStats
};
