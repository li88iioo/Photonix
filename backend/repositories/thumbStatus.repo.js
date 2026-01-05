/**
 * repositories/thumbStatus.repo.js
 * ThumbStatus表数据访问层
 * 职责：封装thumb_status表的所有数据库操作
 */
const { dbGet, dbAll, dbRun, runPreparedBatch } = require('../db/multi-db');
const logger = require('../config/logger');
const { LOG_PREFIXES, LOG_TABLE_LABELS } = logger;

const UPSERT_SQL = `INSERT INTO thumb_status(path, mtime, status, last_checked)
                    VALUES(?, ?, ?, strftime('%s','now')*1000)
                    ON CONFLICT(path) DO UPDATE SET
                      mtime=excluded.mtime,
                      status=excluded.status,
                      last_checked=excluded.last_checked`;
const LOG_LABEL = LOG_PREFIXES.THUMB_STATUS_REPO || '[缩略图状态仓库]';
const TABLE_LABEL = LOG_TABLE_LABELS.THUMB_STATUS || '缩略图状态表';

class ThumbStatusRepository {
    /**
     * 通过path获取缩略图状态
     * @param {string} path - 文件路径
     * @returns {Promise<Object|null>}
     */
    async getByPath(path) {
        try {
            const row = await dbGet('main', 'SELECT * FROM thumb_status WHERE path = ?', [String(path || '')]);
            return row || null;
        } catch (error) {
            logger.debug(`${LOG_LABEL} 获取${TABLE_LABEL}记录失败 (path=${path}):`, error.message);
            return null;
        }
    }

    /**
     * 批量获取缩略图状态
     * @param {Array<string>} paths - 文件路径数组
     * @returns {Promise<Array>}
     */
    async getByPaths(paths) {
        if (!Array.isArray(paths) || paths.length === 0) return [];

        try {
            const placeholders = paths.map(() => '?').join(',');
            const rows = await dbAll('main', `SELECT * FROM thumb_status WHERE path IN (${placeholders})`, paths);
            return rows || [];
        } catch (error) {
            logger.debug(`${LOG_LABEL} 批量获取${TABLE_LABEL}记录失败:`, error.message);
            return [];
        }
    }

    /**
     * 获取指定状态的缩略图记录
     * @param {string|Array<string>} status - 状态或状态数组
     * @param {number} limit - 限制数量
     * @returns {Promise<Array>}
     */
    async getByStatus(status, limit = null) {
        try {
            let sql, params;

            if (Array.isArray(status)) {
                const placeholders = status.map(() => '?').join(',');
                // LEFT JOIN album_covers to prioritize cover images
                sql = `SELECT ts.* 
                   FROM thumb_status ts
                   LEFT JOIN album_covers ac ON ts.path = ac.cover_path
                   WHERE ts.status IN (${placeholders})`;
                params = status;
            } else {
                sql = `SELECT ts.* 
                   FROM thumb_status ts
                   LEFT JOIN album_covers ac ON ts.path = ac.cover_path
                   WHERE ts.status = ?`;
                params = [status];
            }

            if (limit) {
                // ORDER BY: covers first (ac.album_path IS NOT NULL), then by last_checked
                sql += ` ORDER BY 
                        CASE WHEN ac.album_path IS NOT NULL THEN 0 ELSE 1 END,
                        ts.last_checked ASC 
                     LIMIT ?`;
                params.push(limit);
            }

            const rows = await dbAll('main', sql, params);
            return rows || [];
        } catch (error) {
            logger.debug(`${LOG_LABEL} 获取${TABLE_LABEL}记录失败 (status=${status}):`, error.message);
            return [];
        }
    }

    /**
     * 批量upsert缩略图状态
     * @param {Array<[string, number, string]>} rows - [path, mtime, status]
     * @param {Object} options - 选项
     * @param {boolean} options.manageTransaction - 是否管理事务
     * @param {number} options.chunkSize - 分块大小
     * @param {boolean} options.silent - 静默模式，不输出日志
     * @param {Object} redis - Redis实例
     * @returns {Promise<void>}
     */
    async upsertBatch(rows, options = {}, redis = null) {
        if (!Array.isArray(rows) || rows.length === 0) return;

        const opts = {
            manageTransaction: Boolean(options.manageTransaction),
            chunkSize: Math.max(1, Number(options.chunkSize || 400)),
        };
        const silent = Boolean(options.silent);

        try {
            // Native DB handling (busy_timeout) replaces application-layer retry
            await runPreparedBatch('main', UPSERT_SQL, rows, opts);
            // 静默模式下不输出日志，避免刷屏
            if (!silent && rows.length >= 10) {
                logger.debug(`${LOG_LABEL} 批量写入${TABLE_LABEL}完成: ${rows.length}条`);
            }
        } catch (error) {
            logger.error(`${LOG_LABEL} 批量写入${TABLE_LABEL}失败:`, error.message);
            throw error;
        }
    }

    /**
     * 单条upsert缩略图状态（用于批量失败时的回退）
     * @param {string} path - 文件路径
     * @param {number} mtime - 修改时间
     * @param {string} status - 状态
     * @param {Object} redis - Redis实例
     * @returns {Promise<void>}
     */
    async upsertSingle(path, mtime, status, redis = null) {
        try {
            // Native DB handling (busy_timeout) replaces application-layer retry
            await dbRun('main', UPSERT_SQL, [
                String(path || '').trim(),
                Number(mtime) || Date.now(),
                String(status || 'pending')
            ]);
        } catch (error) {
            logger.debug(`${LOG_LABEL} 写入${TABLE_LABEL}失败 (path=${path}):`, error.message);
            throw error;
        }
    }

    /**
     * 更新缩略图状态
     * @param {string} path - 文件路径
     * @param {string} status - 新状态
     * @returns {Promise<boolean>}
     */
    async updateStatus(path, status) {
        try {
            await dbRun('main',
                'UPDATE thumb_status SET status = ?, last_checked = strftime("%s","now")*1000 WHERE path = ?',
                [status, path]
            );
            return true;
        } catch (error) {
            logger.debug(`${LOG_LABEL} 更新${TABLE_LABEL}失败 (path=${path}):`, error.message);
            return false;
        }
    }

    /**
     * 删除缩略图状态记录
     * @param {string} path - 文件路径
     * @returns {Promise<boolean>}
     */
    async deleteByPath(path) {
        try {
            await dbRun('main', 'DELETE FROM thumb_status WHERE path = ?', [String(path || '')]);
            return true;
        } catch (error) {
            logger.debug(`${LOG_LABEL} 删除${TABLE_LABEL}记录失败 (path=${path}):`, error.message);
            return false;
        }
    }

    /**
     * 批量删除缩略图状态记录
     * @param {Array<string>} paths - 文件路径数组
     * @param {boolean} includeSubpaths - 是否包含子路径（LIKE匹配）
     * @returns {Promise<number>}
     */
    async deleteBatch(paths, includeSubpaths = false) {
        if (!Array.isArray(paths) || paths.length === 0) return 0;

        try {
            const placeholders = paths.map(() => '?').join(',');
            let sql = `DELETE FROM thumb_status WHERE path IN (${placeholders})`;
            let params = [...paths];

            if (includeSubpaths) {
                const likeConditions = paths.map(() => `path LIKE ?`).join(' OR ');
                const likeParams = paths.map(p => `${p}/%`);
                sql = `DELETE FROM thumb_status WHERE path IN (${placeholders}) OR ${likeConditions}`;
                params = [...paths, ...likeParams];
            }

            await dbRun('main', sql, params);
            logger.debug(`${LOG_LABEL} 批量删除${TABLE_LABEL}记录完成: ${paths.length}个路径`);
            return paths.length;
        } catch (error) {
            logger.error(`${LOG_LABEL} 批量删除${TABLE_LABEL}记录失败:`, error.message);
            throw error;
        }
    }

    /**
     * 删除目录下的所有缩略图状态记录
     * @param {string} dirPath - 目录路径
     * @returns {Promise<boolean>}
     */
    async deleteByDirectory(dirPath) {
        try {
            await dbRun('main',
                `DELETE FROM thumb_status WHERE path LIKE ? || '/%'`,
                [dirPath]
            );
            logger.debug(`${LOG_LABEL} 已删除目录 ${dirPath} 下的${TABLE_LABEL}记录`);
            return true;
        } catch (error) {
            logger.debug(`${LOG_LABEL} 删除目录 ${dirPath} 的${TABLE_LABEL}记录失败:`, error.message);
            return false;
        }
    }

    /**
     * 统计缩略图状态数量
     * @param {string|null} status - 状态筛选（null表示全部）
     * @returns {Promise<number>}
     */
    async count(status = null) {
        try {
            let sql, params;
            if (status) {
                // 使用status索引优化COUNT查询
                sql = 'SELECT COUNT(1) as count FROM thumb_status INDEXED BY idx_thumb_status_status WHERE status = ?';
                params = [status];
            } else {
                // 使用专门的COUNT优化索引
                sql = 'SELECT COUNT(1) as count FROM thumb_status INDEXED BY idx_thumb_status_count_optimization';
                params = [];
            }
            const row = await dbGet('main', sql, params);
            return row ? Number(row.count) || 0 : 0;
        } catch (error) {
            logger.debug(`${LOG_LABEL} 统计${TABLE_LABEL}失败:`, error.message);
            return 0;
        }
    }

    /**
     * 获取状态分组统计
     * @returns {Promise<Object>} { 'exists': 100, 'missing': 50, ... }
     */
    async getStatusStats() {
        try {
            // 使用status索引优化GROUP BY查询
            const rows = await dbAll('main', 'SELECT status, COUNT(1) as count FROM thumb_status INDEXED BY idx_thumb_status_status GROUP BY status');
            const stats = {};
            (rows || []).forEach(row => {
                stats[row.status] = Number(row.count) || 0;
            });
            return stats;
        } catch (error) {
            logger.debug(`${LOG_LABEL} 获取${TABLE_LABEL}状态统计失败:`, error.message);
            return {};
        }
    }

    /**
     * 获取所有缩略图状态记录（支持指定字段）
     * @param {Array<string>|null} fields - 要查询的字段数组，null表示所有字段
     * @param {number|null} limit - 限制数量
     * @returns {Promise<Array>}
     */
    async getAll(fields = null, limit = null) {
        try {
            const selectFields = Array.isArray(fields) && fields.length > 0
                ? fields.join(', ')
                : '*';

            let sql = `SELECT ${selectFields} FROM thumb_status`;
            const params = [];

            if (limit) {
                sql += ' LIMIT ?';
                params.push(limit);
            }

            const rows = await dbAll('main', sql, params);
            return rows || [];
        } catch (error) {
            logger.debug(`${LOG_LABEL} 获取全部${TABLE_LABEL}记录失败:`, error.message);
            return [];
        }
    }

    /**
     * 分批迭代所有缩略图状态记录（内存友好，支持迭代中删除）
     * 使用 keyset 分页（基于 path 排序）避免 OFFSET 在删除时跳过记录
     * @param {Array<string>|null} fields - 要查询的字段数组（必须包含 path）
     * @param {number} batchSize - 每批数量，默认1000
     * @param {Function} callback - 每批回调函数 async (batch) => void
     * @returns {Promise<number>} 处理的总记录数
     */
    async iterateAll(fields = null, batchSize = 1000, callback) {
        // 确保 path 字段在查询中（keyset 分页需要）
        let selectFields = '*';
        if (Array.isArray(fields) && fields.length > 0) {
            const fieldSet = new Set(fields.map(f => f.toLowerCase()));
            if (!fieldSet.has('path')) {
                fields = ['path', ...fields];
            }
            selectFields = fields.join(', ');
        }

        let lastPath = '';
        let totalProcessed = 0;

        while (true) {
            // 使用 keyset 分页：WHERE path > lastPath ORDER BY path
            // 这样即使删除了记录，也不会跳过后续记录
            const sql = lastPath
                ? `SELECT ${selectFields} FROM thumb_status WHERE path > ? ORDER BY path LIMIT ?`
                : `SELECT ${selectFields} FROM thumb_status ORDER BY path LIMIT ?`;
            const params = lastPath ? [lastPath, batchSize] : [batchSize];
            const rows = await dbAll('main', sql, params);

            if (!rows || rows.length === 0) break;

            await callback(rows);
            totalProcessed += rows.length;

            // 记录本批最后一条的 path，作为下一批的起点
            lastPath = rows[rows.length - 1].path;

            // 如果返回的记录少于 batchSize，说明已经是最后一批
            if (rows.length < batchSize) break;
        }

        return totalProcessed;
    }
}

module.exports = ThumbStatusRepository;
