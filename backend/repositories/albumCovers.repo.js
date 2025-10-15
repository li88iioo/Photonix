/**
 * repositories/albumCovers.repo.js
 * AlbumCovers表数据访问层
 * 职责：封装album_covers表的所有数据库操作
 */
const { dbGet, dbAll, dbRun } = require('../db/multi-db');
const logger = require('../config/logger');

class AlbumCoversRepository {
    /**
     * 通过album_path获取封面信息
     * @param {string} albumPath - 相册路径
     * @returns {Promise<Object|null>}
     */
    async getByAlbumPath(albumPath) {
        try {
            const row = await dbGet('main', 'SELECT * FROM album_covers WHERE album_path = ?', [String(albumPath || '')]);
            return row || null;
        } catch (error) {
            logger.warn(`[AlbumCoversRepo] 获取封面失败 (albumPath=${albumPath}):`, error.message);
            return null;
        }
    }

    /**
     * 批量获取封面信息
     * @param {Array<string>} albumPaths - 相册路径数组
     * @returns {Promise<Array>}
     */
    async getByAlbumPaths(albumPaths) {
        if (!Array.isArray(albumPaths) || albumPaths.length === 0) return [];
        
        try {
            const placeholders = albumPaths.map(() => '?').join(',');
            const rows = await dbAll('main', `SELECT * FROM album_covers WHERE album_path IN (${placeholders})`, albumPaths);
            return rows || [];
        } catch (error) {
            logger.warn(`[AlbumCoversRepo] 批量获取封面失败:`, error.message);
            return [];
        }
    }

    /**
     * 插入或更新封面信息
     * @param {string} albumPath - 相册路径
     * @param {string} coverPath - 封面文件路径
     * @param {number} width - 宽度
     * @param {number} height - 高度
     * @param {number} mtime - 修改时间
     * @returns {Promise<boolean>}
     */
    async upsert(albumPath, coverPath, width, height, mtime) {
        try {
            await dbRun('main', 
                `INSERT INTO album_covers (album_path, cover_path, width, height, mtime)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(album_path) DO UPDATE SET
                   cover_path = excluded.cover_path,
                   width = excluded.width,
                   height = excluded.height,
                   mtime = excluded.mtime`,
                [albumPath, coverPath, width, height, mtime]
            );
            return true;
        } catch (error) {
            logger.warn(`[AlbumCoversRepo] upsert封面失败 (albumPath=${albumPath}):`, error.message);
            return false;
        }
    }

    /**
     * 删除封面记录
     * @param {string} albumPath - 相册路径
     * @returns {Promise<boolean>}
     */
    async deleteByAlbumPath(albumPath) {
        try {
            await dbRun('main', 'DELETE FROM album_covers WHERE album_path = ?', [String(albumPath || '')]);
            return true;
        } catch (error) {
            logger.warn(`[AlbumCoversRepo] 删除封面失败 (albumPath=${albumPath}):`, error.message);
            return false;
        }
    }

    /**
     * 批量删除封面记录
     * @param {Array<string>} albumPaths - 相册路径数组
     * @returns {Promise<number>}
     */
    async deleteBatch(albumPaths) {
        if (!Array.isArray(albumPaths) || albumPaths.length === 0) return 0;

        try {
            const placeholders = albumPaths.map(() => '?').join(',');
            await dbRun('main', `DELETE FROM album_covers WHERE album_path IN (${placeholders})`, albumPaths);
            logger.debug(`[AlbumCoversRepo] 批量删除封面完成: ${albumPaths.length}个路径`);
            return albumPaths.length;
        } catch (error) {
            logger.error(`[AlbumCoversRepo] 批量删除封面失败:`, error.message);
            throw error;
        }
    }

    /**
     * 删除目录及其子目录的封面记录
     * @param {string} dirPath - 目录路径
     * @returns {Promise<boolean>}
     */
    async deleteByDirectory(dirPath) {
        try {
            await dbRun('main', 
                `DELETE FROM album_covers WHERE album_path = ? OR album_path LIKE ? || '/%'`, 
                [dirPath, dirPath]
            );
            logger.debug(`[AlbumCoversRepo] 已删除目录及子目录的封面: ${dirPath}`);
            return true;
        } catch (error) {
            logger.warn(`[AlbumCoversRepo] 删除目录封面失败 (dirPath=${dirPath}):`, error.message);
            return false;
        }
    }

    /**
     * 删除目录及其子目录的封面记录（批量，支持多个目录）
     * @param {Array<string>} dirPaths - 目录路径数组
     * @returns {Promise<number>}
     */
    async deleteByDirectories(dirPaths) {
        if (!Array.isArray(dirPaths) || dirPaths.length === 0) return 0;

        try {
            const conditions = [];
            const params = [];
            
            dirPaths.forEach(dirPath => {
                conditions.push('album_path = ?');
                conditions.push('album_path LIKE ?');
                params.push(dirPath);
                params.push(`${dirPath}/%`);
            });

            const sql = `DELETE FROM album_covers WHERE ${conditions.join(' OR ')}`;
            await dbRun('main', sql, params);
            
            logger.debug(`[AlbumCoversRepo] 批量删除目录封面完成: ${dirPaths.length}个目录`);
            return dirPaths.length;
        } catch (error) {
            logger.error(`[AlbumCoversRepo] 批量删除目录封面失败:`, error.message);
            throw error;
        }
    }

    /**
     * 统计封面记录数量
     * @returns {Promise<number>}
     */
    async count() {
        try {
            // 使用album_path索引优化COUNT查询
            const row = await dbGet('main', 'SELECT COUNT(1) as count FROM album_covers INDEXED BY idx_album_covers_album_path');
            return row ? Number(row.count) || 0 : 0;
        } catch (error) {
            logger.warn(`[AlbumCoversRepo] 统计album_covers失败:`, error.message);
            return 0;
        }
    }

    /**
     * 获取所有封面记录
     * @param {number|null} limit - 限制数量
     * @returns {Promise<Array>}
     */
    async getAll(limit = null) {
        try {
            const sql = limit 
                ? 'SELECT * FROM album_covers LIMIT ?' 
                : 'SELECT * FROM album_covers';
            const params = limit ? [limit] : [];
            const rows = await dbAll('main', sql, params);
            return rows || [];
        } catch (error) {
            logger.warn(`[AlbumCoversRepo] 获取所有封面失败:`, error.message);
            return [];
        }
    }
}

module.exports = AlbumCoversRepository;
