/**
 * 搜索服务模块
 * 封装与搜索相关的所有业务逻辑和数据查询
 */
const path = require('path');
const { dbAll } = require('../db/multi-db');
const logger = require('../config/logger');
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
function normalizeQuery(rawQuery) {
    if (!rawQuery || typeof rawQuery !== 'string') return '';
    return rawQuery
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}\s._-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isFtsSyntaxError(error) {
    const message = error && error.message ? String(error.message) : '';
    return /fts/i.test(message) && (/syntax error/i.test(message) || /malformed/i.test(message));
}

async function performSearch(query, page, limit) {
    const offset = (page - 1) * limit;
    const sanitizedQuery = normalizeQuery(query);

    if (!sanitizedQuery) {
        return { query, results: [], page: 1, totalPages: 1, totalResults: 0, limit };
    }

    const ftsQuery = createNgrams(sanitizedQuery, 1, 2);
    if (!ftsQuery) {
        return { query, results: [], page: 1, totalPages: 1, totalResults: 0, limit };
    }

    let whereCondition = 'items_fts.name MATCH ?';
    const queryParams = [ftsQuery];
    const leafAlbumPredicate = `(
        i.type = 'video'
        OR (
            i.type = 'album'
            AND NOT EXISTS (
                SELECT 1 FROM items child
                WHERE child.type = 'album'
                  AND child.path LIKE i.path || '/%'
            )
        )
    )`;

    whereCondition += ` AND ${leafAlbumPredicate}`;
    const excludePermanentFailed = `NOT EXISTS (SELECT 1 FROM thumb_status ts WHERE ts.path = i.path AND ts.status = 'permanent_failed')`;
    whereCondition += ` AND ${excludePermanentFailed}`;

    try {
        const totalCountSql = `
            SELECT COUNT(1) AS count
            FROM items_fts
            JOIN items i ON items_fts.rowid = i.id
            WHERE ${whereCondition}
        `;
        const totalRow = await dbAll('main', totalCountSql, queryParams);
        const totalResults = totalRow?.[0]?.count || 0;
        const totalPages = Math.ceil(Math.max(totalResults, 1) / limit);

        const unifiedSql = `
            SELECT i.id, i.path, i.type, i.mtime, i.width, i.height, items_fts.rank, i.name
            FROM items_fts
            JOIN items i ON items_fts.rowid = i.id
            WHERE ${whereCondition}
            ORDER BY CASE i.type WHEN 'album' THEN 0 ELSE 1 END, items_fts.rank ASC
            LIMIT ? OFFSET ?
        `;

        const paginatedParams = [...queryParams, limit, offset];
        const paginatedResults = await dbAll('main', unifiedSql, paginatedParams);

        const albumResultsForCover = paginatedResults.filter(r => r.type === 'album');
        const albumPaths = albumResultsForCover.map(r => path.join(PHOTOS_DIR, r.path));
        const coversMap = await findCoverPhotosBatch(albumPaths);

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
            }

            const mtime = Math.floor(result.mtime || Date.now());
            const originalUrl = `/static/${result.path.split(path.sep).map(encodeURIComponent).join('/')}`;
            const thumbnailUrl = `${API_BASE}/api/thumbnail?path=${encodeURIComponent(result.path)}&v=${mtime}`;
            return {
                ...result,
                path: result.path.replace(/\\/g, '/'),
                originalUrl,
                thumbnailUrl,
                parentPath,
                mtime,
                width: result.width || 1920,
                height: result.height || 1080
            };
        }));

        return {
            query,
            results: resultsWithData.filter(Boolean),
            page,
            totalPages: Math.max(totalPages, 1),
            totalResults,
            limit
        };
    } catch (error) {
        if (isFtsSyntaxError(error)) {
            logger.warn('[搜索] FTS 查询包含不安全输入，已回退为空结果', {
                originalQuery: query,
                sanitizedQuery,
                message: error.message
            });
            return { query, results: [], page: 1, totalPages: 1, totalResults: 0, limit };
        }
        throw error;
    }
}

module.exports = {
    performSearch,
};
