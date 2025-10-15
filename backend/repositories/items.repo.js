/**
 * repositories/items.repo.js
 * Items表数据访问层
 * 职责：封装items表的所有数据库操作
 */
const { dbGet, dbAll, dbRun, runAsync } = require('../db/multi-db');
const { withTransaction } = require('../services/tx.manager');
const logger = require('../config/logger');

class ItemsRepository {
    /**
     * 通过path获取item的ID
     * @param {string} path - 文件路径
     * @returns {Promise<number|null>}
     */
    async getIdByPath(path) {
        try {
            const row = await dbGet('main', 'SELECT id FROM items WHERE path = ?', [String(path || '')]);
            if (row && typeof row.id === 'number') return row.id;
            if (row && row.id != null) return Number(row.id) || null;
            return null;
        } catch (error) {
            logger.debug(`[ItemsRepo] 读取item ID失败 (path=${path}): ${error && error.message}`);
            return null;
        }
    }

    /**
     * 通过path获取完整的item信息
     * @param {string} path - 文件路径
     * @returns {Promise<Object|null>}
     */
    async getByPath(path) {
        try {
            const row = await dbGet('main', 'SELECT * FROM items WHERE path = ?', [String(path || '')]);
            return row || null;
        } catch (error) {
            logger.warn(`[ItemsRepo] 获取item失败 (path=${path}):`, error.message);
            return null;
        }
    }

    /**
     * 通过ID获取item
     * @param {number} id - item ID
     * @returns {Promise<Object|null>}
     */
    async getById(id) {
        try {
            const row = await dbGet('main', 'SELECT * FROM items WHERE id = ?', [id]);
            return row || null;
        } catch (error) {
            logger.warn(`[ItemsRepo] 获取item失败 (id=${id}):`, error.message);
            return null;
        }
    }

    /**
     * 批量获取items
     * @param {Array<string>} paths - 文件路径数组
     * @returns {Promise<Array>}
     */
    async getByPaths(paths) {
        if (!Array.isArray(paths) || paths.length === 0) return [];
        
        try {
            const placeholders = paths.map(() => '?').join(',');
            const rows = await dbAll('main', `SELECT * FROM items WHERE path IN (${placeholders})`, paths);
            return rows || [];
        } catch (error) {
            logger.warn(`[ItemsRepo] 批量获取items失败:`, error.message);
            return [];
        }
    }

    /**
     * 删除单个item
     * @param {string} path - 文件路径
     * @returns {Promise<boolean>}
     */
    async deleteByPath(path) {
        try {
            await dbRun('main', 'DELETE FROM items WHERE path = ?', [String(path || '')]);
            return true;
        } catch (error) {
            logger.warn(`[ItemsRepo] 删除item失败 (path=${path}):`, error.message);
            return false;
        }
    }

    /**
     * 批量删除items（支持路径和子路径）
     * @param {Array<string>} paths - 文件路径数组
     * @param {boolean} includeSubpaths - 是否包含子路径
     * @returns {Promise<number>} 删除的记录数
     */
    async deleteBatch(paths, includeSubpaths = false) {
        if (!Array.isArray(paths) || paths.length === 0) return 0;

        try {
            const placeholders = paths.map(() => '?').join(',');
            let sql = `DELETE FROM items WHERE path IN (${placeholders})`;
            let params = [...paths];

            if (includeSubpaths) {
                const likeConditions = paths.map(() => `path LIKE ?`).join(' OR ');
                const likeParams = paths.map(p => `${p}/%`);
                sql = `DELETE FROM items WHERE path IN (${placeholders}) OR ${likeConditions}`;
                params = [...paths, ...likeParams];
            }

            await dbRun('main', sql, params);
            logger.debug(`[ItemsRepo] 批量删除items完成: ${paths.length}个路径`);
            return paths.length;
        } catch (error) {
            logger.error(`[ItemsRepo] 批量删除items失败:`, error.message);
            throw error;
        }
    }

    /**
     * 删除item及其关联数据（原子操作）
     * 包括：items表记录、thumb_status表记录、album_covers表记录
     * @param {string} path - 文件路径
     * @returns {Promise<boolean>} 删除是否成功
     */
    async deleteWithRelations(path) {
        if (!path) {
            logger.warn(`[ItemsRepo] deleteWithRelations: 路径为空`);
            return false;
        }

        try {
            return await withTransaction('main', async () => {
                const cleanPath = String(path);

                // 1. 删除items表记录
                await dbRun('main', 'DELETE FROM items WHERE path = ?', [cleanPath]);
                
                // 2. 删除thumb_status表记录
                await dbRun('main', 'DELETE FROM thumb_status WHERE path = ?', [cleanPath]);
                
                // 3. 删除相关的album_covers（如果这个path是相册）
                await dbRun('main', 'DELETE FROM album_covers WHERE album_path = ?', [cleanPath]);
                
                // 4. 删除子路径的album_covers（如果这个path包含子相册）
                await dbRun('main', 'DELETE FROM album_covers WHERE album_path LIKE ?', [`${cleanPath}/%`]);

                logger.debug(`[ItemsRepo] 删除item及关联数据成功: ${cleanPath}`);
                return true;
            });
        } catch (error) {
            logger.error(`[ItemsRepo] 删除item及关联数据失败 (path=${path}):`, error.message);
            return false;
        }
    }

    /**
     * 批量删除items及其关联数据（原子操作）
     * @param {Array<string>} paths - 文件路径数组
     * @param {boolean} includeSubpaths - 是否包含子路径
     * @returns {Promise<number>} 成功删除的数量
     */
    async deleteBatchWithRelations(paths, includeSubpaths = false) {
        if (!Array.isArray(paths) || paths.length === 0) return 0;

        try {
            return await withTransaction('main', async () => {
                const placeholders = paths.map(() => '?').join(',');
                let params = [...paths];

                // 1. 删除items表记录
                let itemsSql = `DELETE FROM items WHERE path IN (${placeholders})`;
                if (includeSubpaths) {
                    const likeConditions = paths.map(() => `path LIKE ?`).join(' OR ');
                    const likeParams = paths.map(p => `${p}/%`);
                    itemsSql = `DELETE FROM items WHERE path IN (${placeholders}) OR ${likeConditions}`;
                    params = [...paths, ...likeParams];
                }
                await dbRun('main', itemsSql, params);

                // 2. 删除thumb_status表记录
                let thumbSql = `DELETE FROM thumb_status WHERE path IN (${placeholders})`;
                let thumbParams = [...paths];
                if (includeSubpaths) {
                    const likeConditions = paths.map(() => `path LIKE ?`).join(' OR ');
                    const likeParams = paths.map(p => `${p}/%`);
                    thumbSql = `DELETE FROM thumb_status WHERE path IN (${placeholders}) OR ${likeConditions}`;
                    thumbParams = [...paths, ...likeParams];
                }
                await dbRun('main', thumbSql, thumbParams);

                // 3. 删除album_covers表记录
                let albumSql = `DELETE FROM album_covers WHERE album_path IN (${placeholders})`;
                let albumParams = [...paths];
                if (includeSubpaths) {
                    const likeConditions = paths.map(() => `album_path LIKE ?`).join(' OR ');
                    const likeParams = paths.map(p => `${p}/%`);
                    albumSql = `DELETE FROM album_covers WHERE album_path IN (${placeholders}) OR ${likeConditions}`;
                    albumParams = [...paths, ...likeParams];
                }
                await dbRun('main', albumSql, albumParams);

                logger.debug(`[ItemsRepo] 批量删除items及关联数据成功: ${paths.length}个路径`);
                return paths.length;
            });
        } catch (error) {
            logger.error(`[ItemsRepo] 批量删除items及关联数据失败:`, error.message);
            throw error;
        }
    }

    /**
     * 更新item的宽高信息
     * @param {string} path - 文件路径
     * @param {number} width - 宽度
     * @param {number} height - 高度
     * @returns {Promise<boolean>}
     */
    async updateDimensions(path, width, height) {
        try {
            await dbRun('main', 'UPDATE items SET width = ?, height = ? WHERE path = ?', [width, height, path]);
            return true;
        } catch (error) {
            logger.warn(`[ItemsRepo] 更新尺寸失败 (path=${path}):`, error.message);
            return false;
        }
    }

    /**
     * 更新item的mtime
     * @param {string} path - 文件路径
     * @param {number} mtime - 修改时间戳
     * @returns {Promise<boolean>}
     */
    async updateMtime(path, mtime) {
        try {
            await dbRun('main', 'UPDATE items SET mtime = ? WHERE path = ?', [mtime, path]);
            return true;
        } catch (error) {
            logger.warn(`[ItemsRepo] 更新mtime失败 (path=${path}):`, error.message);
            return false;
        }
    }

    /**
     * 获取所有视频类型的items
     * @param {number} limit - 限制数量
     * @returns {Promise<Array>}
     */
    async getVideos(limit = null) {
        try {
            const sql = limit 
                ? 'SELECT * FROM items WHERE type = ? LIMIT ?' 
                : 'SELECT * FROM items WHERE type = ?';
            const params = limit ? ['video', limit] : ['video'];
            const rows = await dbAll('main', sql, params);
            return rows || [];
        } catch (error) {
            logger.warn(`[ItemsRepo] 获取视频列表失败:`, error.message);
            return [];
        }
    }

    /**
     * 统计items数量（按类型）
     * @param {string|null} type - 文件类型 ('photo', 'video', null表示全部)
     * @returns {Promise<number>}
     */
    async count(type = null) {
        try {
            let sql, params;
            if (type) {
                // 使用类型索引优化COUNT查询
                sql = 'SELECT COUNT(1) as count FROM items INDEXED BY idx_items_type_id WHERE type = ?';
                params = [type];
            } else {
                // 使用专门的COUNT优化索引
                sql = 'SELECT COUNT(1) as count FROM items INDEXED BY idx_items_count_optimization';
                params = [];
            }
            const row = await dbGet('main', sql, params);
            return row ? Number(row.count) || 0 : 0;
        } catch (error) {
            logger.warn(`[ItemsRepo] 统计items失败:`, error.message);
            return 0;
        }
    }

    /**
     * 删除item及其所有关联数据（事务保护）
     * @param {string} path - 文件路径
     * @returns {Promise<boolean>}
     */
    async deleteWithRelatedData(path) {
        try {
            await withTransaction('main', async () => {
                // 导入其他Repository（延迟加载，避免循环依赖）
                const ThumbStatusRepository = require('./thumbStatus.repo');
                const AlbumCoversRepository = require('./albumCovers.repo');
                
                const thumbStatusRepo = new ThumbStatusRepository();
                const albumCoversRepo = new AlbumCoversRepository();

                // 1. 删除item
                await this.deleteByPath(path);
                
                // 2. 删除缩略图状态
                await thumbStatusRepo.deleteByPath(path);
                
                // 3. 删除相册封面（如果是目录）
                await albumCoversRepo.deleteByAlbumPath(path);
            });
            
            logger.debug(`[ItemsRepo] 已删除item及关联数据: ${path}`);
            return true;
        } catch (error) {
            logger.error(`[ItemsRepo] 删除item及关联数据失败 (path=${path}):`, error.message);
            throw error;
        }
    }

    /**
     * 批量删除items及其关联数据（事务保护）
     * @param {Array<string>} paths - 文件路径数组
     * @param {boolean} includeSubpaths - 是否包含子路径
     * @returns {Promise<number>}
     */
    async deleteBatchWithRelatedData(paths, includeSubpaths = false) {
        if (!Array.isArray(paths) || paths.length === 0) return 0;

        try {
            let deletedCount = 0;
            
            await withTransaction('main', async () => {
                const ThumbStatusRepository = require('./thumbStatus.repo');
                const thumbStatusRepo = new ThumbStatusRepository();

                // 1. 删除items
                deletedCount = await this.deleteBatch(paths, includeSubpaths);
                
                // 2. 删除对应的thumb_status记录
                await thumbStatusRepo.deleteBatch(paths, false);
            });

            logger.debug(`[ItemsRepo] 批量删除items及关联数据完成: ${deletedCount}条`);
            return deletedCount;
        } catch (error) {
            logger.error(`[ItemsRepo] 批量删除items及关联数据失败:`, error.message);
            throw error;
        }
    }
}

module.exports = ItemsRepository;
