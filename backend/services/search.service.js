/**
 * 搜索服务模块
 * 封装与搜索相关的所有业务逻辑和数据查询
 */
const path = require('path');
const { dbAll } = require('../db/multi-db');
const { createNgrams } = require('../utils/search.utils');
const { findCoverPhotosBatch } = require('./file.service');
const { PHOTOS_DIR, API_BASE } = require('../config');

/**
 * 执行全文搜索
 * @param {string} query - 搜索关键词
 * @param {number} page - 页码
 * @param {number} limit - 每页数量
 * @returns {Promise<object>} 包含搜索结果、分页信息等的对象
 */
async function performSearch(query, page, limit) {
    const offset = (page - 1) * limit;

    // 清理搜索查询，移除特殊字符
    const sanitizedQuery = query.replace(/[(){}[\]/\\."*?!:^~+-,]/g, ' ').trim();
    if (!sanitizedQuery) {
        return { query, results: [], page: 1, totalPages: 1, totalResults: 0, limit };
    }
    
    // 创建n-gram搜索查询
    const ftsQuery = createNgrams(sanitizedQuery, 1, 2);

    // 计算总数
    const totalCountSql = `
        SELECT COUNT(1) AS count
        FROM items_fts
        JOIN items i ON items_fts.rowid = i.id
        WHERE items_fts.name MATCH ?
          AND (
                i.type = 'video'
             OR (
                  i.type = 'album'
              AND NOT EXISTS (
                    SELECT 1 FROM items AS sub
                    WHERE sub.type = 'album' AND sub.path LIKE i.path || '/%'
              )
             )
          )
    `;
    const totalRow = await dbAll('main', totalCountSql, [ftsQuery]);
    const totalResults = totalRow?.[0]?.count || 0;
    const totalPages = Math.ceil(totalResults / limit);

    // 获取分页数据
    const unifiedSql = `
        SELECT i.id, i.path, i.type, i.mtime, i.width, i.height, items_fts.rank, i.name
        FROM items_fts
        JOIN items i ON items_fts.rowid = i.id
        WHERE items_fts.name MATCH ?
          AND (
                i.type = 'video'
             OR (
                  i.type = 'album'
              AND NOT EXISTS (
                    SELECT 1 FROM items AS sub
                    WHERE sub.type = 'album' AND sub.path LIKE i.path || '/%'
              )
             )
          )
        ORDER BY CASE i.type WHEN 'album' THEN 0 ELSE 1 END, items_fts.rank ASC
        LIMIT ? OFFSET ?
    `;
    const paginatedResults = await dbAll('main', unifiedSql, [ftsQuery, limit, offset]);

    // 批量获取相册封面
    const albumResultsForCover = paginatedResults.filter(r => r.type === 'album');
    const albumPaths = albumResultsForCover.map(r => path.join(PHOTOS_DIR, r.path));
    const coversMap = await findCoverPhotosBatch(albumPaths);

    // 处理结果，添加封面和URL信息
    const resultsWithData = await Promise.all(paginatedResults.map(async (result) => {
        if (!result) return null;
        
        let parentPath = path.dirname(result.path).replace(/\\/g, '/');
        if (parentPath === '.') parentPath = '';
        
        if (result.type === 'album') {
            const fullAbsPath = path.join(PHOTOS_DIR, result.path);
            const coverInfo = coversMap.get(fullAbsPath);
            
            let coverUrl = 'data:image/svg+xml,...';
            let coverWidth = 1, coverHeight = 1;
            
            if (coverInfo && coverInfo.path) {
                const relativeCoverPath = path.relative(PHOTOS_DIR, coverInfo.path);
                // 附上封面文件自身的mtime作为版本号，确保封面变更后客户端能获取最新版本（标准化为整数）
                const coverMtime = Math.floor(coverInfo.mtime || Date.now());
                coverUrl = `${API_BASE}/api/thumbnail?path=${encodeURIComponent(relativeCoverPath)}&v=${coverMtime}`;
                coverWidth = coverInfo.width;
                coverHeight = coverInfo.height;
            }
            
            return { 
                ...result, 
                path: result.path.replace(/\\/g, '/'), 
                coverUrl, 
                parentPath, 
                coverWidth, 
                coverHeight,
                mtime: result.mtime
            };
        } else { // video
            const mtime = Math.floor(result.mtime || Date.now()); // 确保mtime有效并标准化为整数
            const originalUrl = `/static/${result.path.split(path.sep).map(encodeURIComponent).join('/')}`;
            const thumbnailUrl = `${API_BASE}/api/thumbnail?path=${encodeURIComponent(result.path)}&v=${mtime}`;
            return { 
                ...result, 
                path: result.path.replace(/\\/g, '/'), 
                originalUrl, 
                thumbnailUrl, 
                parentPath,
                mtime: mtime, // 返回确保有效的mtime
                width: result.width || 1920,
                height: result.height || 1080
            };
        }
    }));
    
    return {
        query,
        results: resultsWithData.filter(Boolean),
        page,
        totalPages,
        totalResults,
        limit
    };
}

module.exports = {
    performSearch,
};
