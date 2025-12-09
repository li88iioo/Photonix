/**
 * 文件服务模块
 * 处理文件系统操作、目录浏览、封面查找和媒体文件管理
 */
// backend/services/file.service.js

const { promises: fs } = require('fs');
const path = require('path');
const sharp = require('sharp');
const logger = require('../config/logger');
// 限制 file.service 中偶发 metadata 读取的缓存影响
try {
    const memMb = Number(process.env.SHARP_CACHE_MEMORY_MB || 16);
    const items = Number(process.env.SHARP_CACHE_ITEMS || 50);
    const files = Number(process.env.SHARP_CACHE_FILES || 0);
    sharp.cache({ memory: memMb, items, files });
} catch (error) {
    logger.silly(`[FileService] Sharp 缓存配置失败，使用默认值: ${error && error.message}`);
}
const { redis } = require('../config/redis');
const { safeRedisSet, safeRedisDel } = require('../utils/helpers');
const { PHOTOS_DIR, API_BASE, COVER_INFO_LRU_SIZE } = require('../config');
const { isPathSafe } = require('../utils/path.utils');
const { dbAll, dbGet, runAsync } = require('../db/multi-db');
const { getVideoDimensions } = require('../utils/media.utils.js');



// 缓存配置
const CACHE_DURATION = Number(process.env.FILE_CACHE_DURATION || 604800); // 7天缓存
// 外部化缓存：移除进程内大 LRU，统一使用 Redis 作为封面缓存后端




// 确保用于浏览/封面的关键索引，仅执行一次
let browseIndexesEnsured = false;
async function ensureBrowseIndexes() {
    if (browseIndexesEnsured) return;
    try {
        await runAsync('main', `CREATE INDEX IF NOT EXISTS idx_items_path ON items(path)`)
        await runAsync('main', `CREATE INDEX IF NOT EXISTS idx_items_type ON items(type)`)
        await runAsync('main', `CREATE INDEX IF NOT EXISTS idx_items_type_path ON items(type, path)`)
        await runAsync('main', `CREATE INDEX IF NOT EXISTS idx_items_path_mtime ON items(path, mtime DESC)`)
        await runAsync('main', `CREATE INDEX IF NOT EXISTS idx_items_type_path_mtime ON items(type, path, mtime DESC)`)
        browseIndexesEnsured = true;
    } catch (e) {
        logger.debug('创建浏览相关索引失败（忽略，不影响功能）:', e && e.message);
    }
}

/**
 * 批量查找相册封面图片 (已优化)
 * 此函数现在是 findCoverPhotosBatchDb 的一个包装器, 完全依赖数据库, 移除了文件系统扫描.
 * @param {Array<string>} directoryPaths - 目录的绝对路径数组
 * @returns {Promise<Map>} 目录路径到封面信息的映射
 */
async function findCoverPhotosBatch(directoryPaths) {
    if (!Array.isArray(directoryPaths) || directoryPaths.length === 0) {
        return new Map();
    }
    const relativeDirs = directoryPaths.map(p => path.relative(PHOTOS_DIR, p));
    return findCoverPhotosBatchDb(relativeDirs);
}

async function findCoverPhotosBatchSafe(directoryPaths) {
    try {
        return await findCoverPhotosBatch(directoryPaths);
    } catch (error) {
        logger.warn('FileService.findCoverPhotosBatch 执行失败', {
            error: error.message,
            stack: error.stack
        });
        return new Map();
    }
}

/**
 * 使用数据库查找相册封面（基于相对路径，避免递归 FS 扫描）
 * @param {Array<string>} relativeDirs - 相册相对路径数组（例如 'AlbumA' 或 'Parent/AlbumB'）
 * @returns {Promise<Map>} key 为相册绝对路径（PHOTOS_DIR 拼接），value 为封面信息
 */
async function findCoverPhotosBatchDb(relativeDirs) {
    await ensureBrowseIndexes();
    const coversMap = new Map();
    if (!Array.isArray(relativeDirs) || relativeDirs.length === 0) return coversMap;

    // 过滤并规范路径
    const safeRels = relativeDirs
        .map(rel => (rel || '').replace(/\\/g, '/'))
        .filter(rel => isPathSafe(rel));
    if (safeRels.length === 0) return coversMap;

    const relToAbs = new Map();
    const remainingForRedis = [];
    for (const rel of safeRels) {
        const absAlbumPath = path.join(PHOTOS_DIR, rel);
        relToAbs.set(rel, absAlbumPath);
        remainingForRedis.push(rel);
    }

    // 对剩余项优先读取 Redis
    const cacheKeys = remainingForRedis.map(rel => `cover_info:/${rel}`);
    let cachedResults = [];
    if (cacheKeys.length > 0) {
        try {
            cachedResults = await redis.mget(cacheKeys);
        } catch (e) {
            logger.debug('批量读取封面缓存失败:', e.message);
            cachedResults = new Array(cacheKeys.length).fill(null);
        }
    }

    const missing = [];
    remainingForRedis.forEach((rel, idx) => {
        const absAlbumPath = relToAbs.get(rel);
        const cached = cachedResults[idx];
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (parsed && parsed.path) {
                    coversMap.set(absAlbumPath, parsed);
                    return;
                }
            } catch (error) {
                logger.debug(`[FileService] 尝试使用相册封面缓存失败，忽略: ${error && error.message}`);
            }
        }
        missing.push(rel);
    });

    if (missing.length > 0) {
        // 优先从 album_covers 表按 IN 批量查找，分批避免超长 SQL
        const BATCH = Number(process.env.FILE_BATCH_SIZE || 200);
        try {
            for (let i = 0; i < missing.length; i += BATCH) {
                const batch = missing.slice(i, i + BATCH);
                const placeholders = batch.map(() => '?').join(',');
                const rows = await dbAll(
                    'main',
                    `SELECT album_path, cover_path, width, height, mtime
                     FROM album_covers
                     WHERE album_path IN (${placeholders})`,
                    batch
                );
                for (const row of rows || []) {
                    const absAlbumPath = path.join(PHOTOS_DIR, row.album_path);
                    const absMedia = path.join(PHOTOS_DIR, row.cover_path);
                    const info = { path: absMedia, width: row.width || 1, height: row.height || 1, mtime: row.mtime || Date.now() };
                    coversMap.set(absAlbumPath, info);
                    await safeRedisSet(redis, `cover_info:/${row.album_path}`, JSON.stringify(info), 'EX', CACHE_DURATION, '封面信息缓存');
                }
            }
        } catch (e) {
            logger.debug('从 album_covers 表批量读取失败，将回退逐相册计算: ' + (e && e.message));
        }

        // 对仍未命中的相册，使用批量查询代替逐个 LIKE 查询（性能优化）
        const stillMissing = missing.filter(rel => !coversMap.has(path.join(PHOTOS_DIR, rel)));

        if (stillMissing.length > 0) {
            try {
                // 使用 Window Function 一次性获取所有相册的最新封面
                // 通过 SUBSTR + INSTR 提取每个媒体所属的直接父相册路径
                const coverExcludePermanent = `NOT EXISTS (SELECT 1 FROM thumb_status ts WHERE ts.path = i.path AND ts.status = 'permanent_failed')`;

                // 构建批量查询：为每个相册找到其下最新的媒体文件
                const BATCH_SIZE = 50;
                for (let batchStart = 0; batchStart < stillMissing.length; batchStart += BATCH_SIZE) {
                    const batchRels = stillMissing.slice(batchStart, batchStart + BATCH_SIZE);

                    // 使用 UNION ALL 合并每个相册的查询（子查询需括号包裹）
                    const unionParts = batchRels.map((rel, idx) => {
                        const likeParam = rel ? `${rel}/%` : '%';
                        return `(
                            SELECT '${rel.replace(/'/g, "''")}' AS album_rel, path, width, height, mtime
                            FROM items
                            WHERE type IN ('photo','video')
                              AND path LIKE '${likeParam.replace(/'/g, "''")}'
                              AND ${coverExcludePermanent}
                            ORDER BY mtime DESC
                            LIMIT 1
                        )`;
                    });

                    const batchSql = unionParts.join(' UNION ALL ');
                    const rows = await dbAll('main', batchSql, []);

                    // 处理结果并缓存
                    for (const r of rows || []) {
                        if (!r || !r.path) continue;
                        const rel = r.album_rel;
                        const absAlbumPath = path.join(PHOTOS_DIR, rel);
                        const abs = path.join(PHOTOS_DIR, r.path);
                        const info = { path: abs, width: r.width || 1, height: r.height || 1, mtime: r.mtime || Date.now() };
                        coversMap.set(absAlbumPath, info);
                        // 异步缓存，不阻塞主流程
                        safeRedisSet(redis, `cover_info:/${rel}`, JSON.stringify(info), 'EX', CACHE_DURATION, '封面信息缓存').catch(() => { });
                    }
                }
            } catch (err) {
                logger.debug('批量封面查询失败，跳过: ' + (err && err.message));
            }
        }
    }

    return coversMap;
}

/**
 * 直接子项（相册/媒体）分页，排序全部在 SQL 完成
 * @param {string} relativePathPrefix 相对路径前缀（'' 表示根）
 * @param {string} userId 用户ID
 * @param {string} sort 排序策略：smart | name_asc | name_desc | mtime_asc | mtime_desc
 * @param {number} limit 分页大小
 * @param {number} offset 偏移量
 * @returns {Promise<{ total:number, rows:Array }>}
 */
async function getDirectChildrenFromDb(relativePathPrefix, userId, sort, limit, offset) {
    await ensureBrowseIndexes();
    const prefix = (relativePathPrefix || '').replace(/\\/g, '/');

    const whereClause = !prefix
        ? `instr(path, '/') = 0`
        : `path LIKE ? || '/%' AND instr(substr(path, length(?) + 2), '/') = 0`;
    const whereParams = !prefix ? [] : [prefix, prefix];
    const mediaExclusionCondition = `NOT EXISTS (SELECT 1 FROM thumb_status ts WHERE ts.path = i.path AND ts.status = 'permanent_failed')`;

    // 构建排序表达式：目录遵循用户选择，媒体固定为时间倒序，确保相册内部照片顺序稳定
    let albumOrderExpr = 'mtime';
    let albumOrderDirection = 'DESC';
    const mediaOrderExpr = 'mtime';
    const mediaOrderDirection = 'DESC';

    switch (sort) {
        case 'name_asc':
            albumOrderExpr = 'name COLLATE NOCASE';
            albumOrderDirection = 'ASC';
            break;
        case 'name_desc':
            albumOrderExpr = 'name COLLATE NOCASE';
            albumOrderDirection = 'DESC';
            break;
        case 'mtime_asc':
            albumOrderExpr = 'mtime';
            albumOrderDirection = 'ASC';
            break;
        case 'mtime_desc':
        default: // smart 或其他未知值 -> 默认为 mtime_desc
            albumOrderExpr = 'mtime';
            albumOrderDirection = 'DESC';
            break;
    }

    const orderBy = `
        ORDER BY
            is_dir DESC,
            CASE WHEN is_dir = 1 THEN ${albumOrderExpr} END ${albumOrderDirection},
            CASE WHEN is_dir = 0 THEN ${mediaOrderExpr} END ${mediaOrderDirection},
            name COLLATE NOCASE ASC
    `;

    // albums 子查询（不跨库 JOIN）
    const albumsSelect = `SELECT 1 AS is_dir, i.name, i.path, i.mtime, i.width, i.height, NULL AS last_viewed
           FROM items i
           WHERE i.type = 'album' AND (${whereClause})`;

    const mediaSelect = `SELECT 0 AS is_dir, i.name, i.path, i.mtime, i.width, i.height, NULL AS last_viewed
                         FROM items i
                         WHERE i.type IN ('photo','video') AND (${whereClause}) AND ${mediaExclusionCondition}`;

    const totalSql = `SELECT COUNT(1) AS count FROM (
                          ${albumsSelect}
                          UNION ALL
                          ${mediaSelect}
                      ) aggregated_entries`;
    const totalRow = await dbGet('main', totalSql, [...whereParams, ...whereParams]);
    const total = Number(totalRow?.count || 0);

    const unionSql = `SELECT * FROM (
                          ${albumsSelect}
                          UNION ALL
                          ${mediaSelect}
                      ) t
                      ${orderBy}
                      LIMIT ? OFFSET ?`;

    const params = [...whereParams, ...whereParams, limit, offset];

    const rows = await dbAll('main', unionSql, params);
    return { total, rows };
}




// 已下沉到 SQL：旧的 getSortedDirectoryEntries 已移除

/**
 * 回退到数据库检查HLS状态
 * @param {Array} videoRows - 视频行数据
 * @param {Set} hlsReadySet - HLS就绪集合
 */
async function fallbackToDatabaseCheck(videoRows, hlsReadySet) {
    try {
        const videoPaths = videoRows.map(r => r.path);
        const placeholders = videoPaths.map(() => '?').join(',');
        const processedRows = await dbAll(
            'main',
            `SELECT path FROM processed_videos WHERE path IN (${placeholders})`,
            videoPaths
        );
        processedRows.forEach(r => hlsReadySet.add(r.path));
        logger.debug(`数据库检查HLS状态: ${hlsReadySet.size}/${videoPaths.length} 个视频已就绪`);
    } catch (e) {
        logger.debug(`数据库检查HLS状态失败: ${e.message}`);
    }
}

/**
 * 获取目录内容
 * 获取指定目录的分页内容，包括相册和媒体文件，支持封面图片和尺寸信息
 * @param {string} directory - 目录路径
 * @param {string} relativePathPrefix - 相对路径前缀
 * @param {number} page - 页码
 * @param {number} limit - 每页数量
 * @param {string} userId - 用户ID
 * @returns {Promise<Object>} 包含items、totalPages、totalResults的对象
 */
async function getDirectoryContents(relativePathPrefix, page, limit, userId, sort = 'smart') {
    // 验证路径安全性
    if (!isPathSafe(relativePathPrefix)) {
        const { ValidationError } = require('../utils/errors');
        throw new ValidationError(`不安全的路径访问: ${relativePathPrefix}`, { path: relativePathPrefix });
    }

    // 验证并获取目录信息
    const directoryInfo = await validateDirectory(relativePathPrefix);
    if (!directoryInfo.exists) {
        return { items: [], totalPages: 1, totalResults: 0 };
    }

    // 获取数据库数据
    const offset = (page - 1) * limit;
    const { total: totalResults, rows } = await getDirectChildrenFromDb(relativePathPrefix, userId, sort, limit, offset);

    if (totalResults === 0 || rows.length === 0) {
        return { items: [], totalPages: 1, totalResults: 0 };
    }

    // 4. 构造返回结果
    // 处理视频HLS状态
    const hlsReadySet = await processHlsStatus(rows);

    // 处理相册封面
    const coversMap = await processAlbumCovers(rows);

    // 构建最终结果
    const items = await buildItems(rows, hlsReadySet, coversMap);

    return {
        items,
        totalPages: Math.ceil(totalResults / limit) || 1,
        totalResults
    };
}

/**
 * 验证目录是否存在且可访问
 */
async function validateDirectory(relativePathPrefix) {
    const directory = path.join(PHOTOS_DIR, relativePathPrefix);
    const stats = await fs.stat(directory).catch(() => null);

    if (!stats || !stats.isDirectory()) {
        if (relativePathPrefix === '') {
            logger.warn('照片根目录似乎不存在或不可读，返回空列表。');
            return { exists: false };
        }
        const { NotFoundError } = require('../utils/errors');
        throw new NotFoundError(`路径 ${relativePathPrefix}`, { path: relativePathPrefix });
    }

    return { exists: true, directory };
}



/**
 * 处理视频HLS状态
 */
async function processHlsStatus(rows) {
    const videoRows = rows.filter(r => !r.is_dir && /\.(mp4|webm|mov)$/i.test(r.name));
    const hlsReadySet = new Set();

    if (videoRows.length === 0) {
        return hlsReadySet;
    }

    const { USE_FILE_SYSTEM_HLS_CHECK } = require('../config');

    if (USE_FILE_SYSTEM_HLS_CHECK) {
        try {
            const { batchCheckHlsStatus } = require('../utils/hls.utils');
            const videoPaths = videoRows.map(r => r.path);
            const result = await batchCheckHlsStatus(videoPaths);
            result.forEach(path => hlsReadySet.add(path));
            logger.debug(`文件系统检查HLS状态: ${hlsReadySet.size}/${videoPaths.length} 个视频已就绪`);
        } catch (e) {
            logger.debug(`文件系统检查HLS状态失败，回退到数据库查询: ${e.message}`);
            await fallbackToDatabaseCheck(videoRows, hlsReadySet);
        }
    } else {
        await fallbackToDatabaseCheck(videoRows, hlsReadySet);
    }

    return hlsReadySet;
}

/**
 * 处理相册封面
 */
async function processAlbumCovers(rows) {
    const albumRows = rows.filter(r => r.is_dir === 1);
    const albumPathsRel = albumRows.map(r => r.path);
    return await findCoverPhotosBatchDb(albumPathsRel);
}

/**
 * 构建最终的项目列表
 */
async function buildItems(rows, hlsReadySet, coversMap) {
    return await Promise.all(rows.map(async (row) => {
        const entryRelativePath = row.path;
        const fullAbsPath = path.join(PHOTOS_DIR, entryRelativePath);

        if (row.is_dir === 1) {
            return await buildAlbumItem(row, coversMap, entryRelativePath);
        } else {
            return await buildMediaItem(row, hlsReadySet, entryRelativePath, fullAbsPath);
        }
    }));
}

/**
 * 构建相册项目
 */
async function buildAlbumItem(row, coversMap, entryRelativePath) {
    const fullAbsPath = path.join(PHOTOS_DIR, entryRelativePath);
    const coverInfo = coversMap.get(fullAbsPath);

    let coverUrl = 'data:image/svg+xml,...';
    let coverWidth = 1, coverHeight = 1;

    if (coverInfo && coverInfo.path) {
        const relativeCoverPath = path.relative(PHOTOS_DIR, coverInfo.path);
        let coverMtime = coverInfo.mtime;

        if (coverMtime == null) {
            logger.debug(`封面信息中缺少 mtime，回退到 fs.stat: ${coverInfo.path}`);
            coverMtime = await fs.stat(coverInfo.path).then(s => s.mtimeMs).catch(() => Date.now());
        }

        coverUrl = `${API_BASE}/api/thumbnail?path=${encodeURIComponent(relativeCoverPath)}&v=${Math.floor(coverMtime)}`;
        coverWidth = coverInfo.width;
        coverHeight = coverInfo.height;
    }

    return {
        type: 'album',
        data: {
            name: row.name || path.basename(entryRelativePath),
            path: entryRelativePath,
            coverUrl,
            mtime: row.mtime || 0,
            coverWidth,
            coverHeight
        }
    };
}

/**
 * 构建媒体项目
 */
async function buildMediaItem(row, hlsReadySet, entryRelativePath, fullAbsPath) {
    const isVideo = /\.(mp4|webm|mov)$/i.test(row.name || path.basename(entryRelativePath));
    let mtime = row.mtime;

    if (!mtime) {
        try {
            const stats = await fs.stat(fullAbsPath);
            mtime = stats.mtimeMs;
        } catch (e) {
            logger.debug(`无法获取文件状态: ${fullAbsPath}`, e);
            mtime = Date.now();
        }
    }

    // 获取尺寸信息，传入数据库中的尺寸信息
    const dbDimensions = { width: row.width, height: row.height };
    const dimensions = await getMediaDimensions(entryRelativePath, fullAbsPath, isVideo, mtime, dbDimensions);

    const originalUrl = `/static/${entryRelativePath.split(path.sep).map(encodeURIComponent).join('/')}`;
    const thumbnailUrl = `${API_BASE}/api/thumbnail?path=${encodeURIComponent(entryRelativePath)}&v=${Math.floor(mtime)}`;

    return {
        type: isVideo ? 'video' : 'photo',
        data: {
            originalUrl,
            thumbnailUrl,
            width: dimensions.width,
            height: dimensions.height,
            mtime,
            hlsReady: isVideo ? hlsReadySet.has(entryRelativePath) : false
        }
    };
}

/**
 * 获取媒体文件尺寸
 * @param {string} entryRelativePath - 相对路径
 * @param {string} fullAbsPath - 绝对路径
 * @param {boolean} isVideo - 是否为视频
 * @param {number} mtime - 文件修改时间
 * @param {Object} dbDimensions - 从数据库查询到的尺寸信息
 * @returns {Promise<Object>} 包含width和height的对象
 */
/**
 * 媒体尺寸管理器
 * 处理媒体文件的尺寸获取和缓存逻辑
 */
class MediaDimensionsManager {
    constructor() {
        this.redis = redis;
        this.logger = logger;
    }

    /**
     * 检查数据库尺寸是否有效
     */
    isValidDbDimensions(dimensions) {
        return dimensions &&
            typeof dimensions.width === 'number' &&
            typeof dimensions.height === 'number' &&
            dimensions.width > 0 &&
            dimensions.height > 0;
    }

    /**
     * 从数据库提取尺寸信息
     */
    extractDimensionsFromDb(dbDimensions, entryRelativePath) {
        if (!dbDimensions) return null;

        const dimensions = {
            width: dbDimensions.width,
            height: dbDimensions.height
        };

        if (this.isValidDbDimensions(dimensions)) {
            return dimensions;
        }

        return null;
    }

    /**
     * 生成缓存键
     */
    generateCacheKey(entryRelativePath, mtime) {
        return `dim:${entryRelativePath}:${mtime}`;
    }

    /**
     * 从Redis缓存获取尺寸
     */
    async getDimensionsFromCache(cacheKey, entryRelativePath) {
        const { safeRedisGet } = require('../utils/helpers');
        const cachedData = await safeRedisGet(this.redis, cacheKey, '尺寸缓存读取');
        if (!cachedData) return null;

        try {
            const dimensions = JSON.parse(cachedData);
            if (this.isValidDbDimensions(dimensions)) {
                return dimensions;
            } else {
                this.logger.debug(`无效的缓存尺寸数据 for ${entryRelativePath}, 将重新计算。`);
                return null;
            }
        } catch (e) {
            this.logger.debug(`解析缓存尺寸失败 for ${entryRelativePath}, 将重新计算。`, e);
            return null;
        }
    }

    /**
     * 计算媒体文件的实际尺寸
     */
    async calculateDimensions(fullAbsPath, isVideo) {
        if (isVideo) {
            return await getVideoDimensions(fullAbsPath);
        } else {
            const metadata = await sharp(fullAbsPath).metadata();
            return { width: metadata.width, height: metadata.height };
        }
    }

    /**
     * 缓存尺寸到Redis
     */
    async cacheDimensions(cacheKey, dimensions, entryRelativePath) {
        const { safeRedisSet } = require('../utils/helpers');
        await safeRedisSet(this.redis, cacheKey, JSON.stringify(dimensions), 'EX', Number(process.env.DIMENSION_CACHE_TTL || 60 * 60 * 24 * 30), '尺寸缓存写入');
    }

    /**
     * 获取默认尺寸（兜底）
     */
    getDefaultDimensions() {
        return { width: 1920, height: 1080 };
    }

    /**
     * 获取媒体文件的尺寸（主要入口函数）
     */
    async getMediaDimensions(entryRelativePath, fullAbsPath, isVideo, mtime, dbDimensions = null) {
        // 1. 尝试从数据库获取
        let dimensions = this.extractDimensionsFromDb(dbDimensions, entryRelativePath);
        if (dimensions) return dimensions;

        // 2. 记录数据库未命中
        // this.batchLogStats.recordDbMiss(entryRelativePath); // Removed debug bloat

        // 3. 尝试从缓存获取
        const cacheKey = this.generateCacheKey(entryRelativePath, mtime);
        dimensions = await this.getDimensionsFromCache(cacheKey, entryRelativePath);
        if (dimensions) return dimensions;

        // 4. 计算实际尺寸
        try {
            dimensions = await this.calculateDimensions(fullAbsPath, isVideo);

            // 5. 缓存计算结果
            await this.cacheDimensions(cacheKey, dimensions, entryRelativePath);

            this.logger.debug(`动态获取 ${entryRelativePath} 的尺寸: ${dimensions.width}x${dimensions.height}`);
            return dimensions;
        } catch (e) {
            this.logger.error(`无法获取媒体文件尺寸: ${entryRelativePath}`, e);
            return this.getDefaultDimensions();
        }
    }
}

// 创建单例管理器
const mediaDimensionsManager = new MediaDimensionsManager();

// 兼容旧用法
async function getMediaDimensions(entryRelativePath, fullAbsPath, isVideo, mtime, dbDimensions = null) {
    return await mediaDimensionsManager.getMediaDimensions(entryRelativePath, fullAbsPath, isVideo, mtime, dbDimensions);
}



/**
 * 智能失效封面缓存
 * @param {string} changedPath - 变化的文件路径
 */
async function invalidateCoverCache(changedPath) {
    try {
        // 获取所有受影响的目录路径
        const affectedPaths = getAllParentPaths(changedPath);
        const cacheKeys = affectedPaths.map(p => `cover_info:${p.replace(PHOTOS_DIR, '').replace(/\\/g, '/')}`);

        if (cacheKeys.length > 0) {
            await safeRedisDel(redis, cacheKeys, '封面缓存清理');
            logger.debug(`已清除 ${cacheKeys.length} 个封面缓存: ${changedPath}`);
        }
        // 已移除进程内 LRU，封面缓存统一改为 Redis，无需本地清理
    } catch (error) {
        logger.error(`清除封面缓存失败: ${changedPath}`, error);
    }
}

/**
 * 获取所有父目录路径
 * @param {string} filePath - 文件路径
 * @returns {Array<string>} 父目录路径数组
 */
function getAllParentPaths(filePath) {
    const paths = [];
    let currentPath = path.dirname(filePath);

    while (currentPath !== PHOTOS_DIR && currentPath.startsWith(PHOTOS_DIR)) {
        paths.push(currentPath);
        currentPath = path.dirname(currentPath);
    }

    return paths;
}

// 导出文件服务函数
module.exports = {
    findCoverPhotosBatch: findCoverPhotosBatchSafe,
    findCoverPhotosBatchDb,
    getDirectoryContents,
    invalidateCoverCache
};
