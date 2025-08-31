/**
 * 文件服务模块
 * 处理文件系统操作、目录浏览、封面查找和媒体文件管理
 */
// backend/services/file.service.js

const { promises: fs } = require('fs');
const path = require('path');
const sharp = require('sharp');
// 限制 file.service 中偶发 metadata 读取的缓存影响
try {
  const memMb = Number(process.env.SHARP_CACHE_MEMORY_MB || 16);
  const items = Number(process.env.SHARP_CACHE_ITEMS || 50);
  const files = Number(process.env.SHARP_CACHE_FILES || 0);
  sharp.cache({ memory: memMb, items, files });
} catch {}
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { PHOTOS_DIR, API_BASE, COVER_INFO_LRU_SIZE } = require('../config');
const { isPathSafe } = require('../utils/path.utils');
const { dbAll, runAsync } = require('../db/multi-db');
const { getVideoDimensions } = require('../utils/media.utils.js');

// 限制重型尺寸探测的并发量，降低冷启动高 IO/CPU 冲击
const DIMENSION_PROBE_CONCURRENCY = Number(process.env.DIMENSION_PROBE_CONCURRENCY || 4);
function createConcurrencyLimiter(maxConcurrent) {
    let activeCount = 0;
    const pendingQueue = [];
    const next = () => {
        if (activeCount >= maxConcurrent) return;
        const job = pendingQueue.shift();
        if (!job) return;
        activeCount++;
        Promise.resolve()
            .then(job.fn)
            .then(job.resolve, job.reject)
            .finally(() => { activeCount--; next(); });
    };
    return (fn) => new Promise((resolve, reject) => {
        pendingQueue.push({ fn, resolve, reject });
        next();
    });
}
const limitDimensionProbe = createConcurrencyLimiter(DIMENSION_PROBE_CONCURRENCY);

// 缓存配置
const CACHE_DURATION = 604800; // 7天缓存
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
        logger.warn('创建浏览相关索引失败（忽略，不影响功能）:', e && e.message);
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
    // 将绝对路径转换为 findCoverPhotosBatchDb 所需的相对路径
    const relativeDirs = directoryPaths.map(p => path.relative(PHOTOS_DIR, p));
    
    // 直接调用基于数据库的实现
    return findCoverPhotosBatchDb(relativeDirs);
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
    try {
        cachedResults = cacheKeys.length > 0 ? await redis.mget(cacheKeys) : [];
    } catch {
        cachedResults = new Array(cacheKeys.length).fill(null);
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
            } catch {}
        }
        missing.push(rel);
    });

    if (missing.length > 0) {
        // 优先从 album_covers 表按 IN 批量查找，分批避免超长 SQL
        const BATCH = 200;
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
                    try { await redis.set(`cover_info:/${row.album_path}`, JSON.stringify(info), 'EX', CACHE_DURATION); } catch {}
                }
            }
        } catch (e) {
            logger.warn('从 album_covers 表批量读取失败，将回退逐相册计算: ' + (e && e.message));
        }

        // 对仍未命中的相册，回退为逐相册计算（仅个别漏网）
        const stillMissing = missing.filter(rel => !coversMap.has(path.join(PHOTOS_DIR, rel)));
        for (const rel of stillMissing) {
            try {
                const likeParam = rel ? `${rel}/%` : '%';
                const rows = await dbAll('main',
                    `SELECT path, width, height, mtime
                     FROM items
                     WHERE type IN ('photo','video') AND path LIKE ?
                     ORDER BY mtime DESC
                     LIMIT 1`,
                    [likeParam]
                );
                if (rows && rows.length) {
                    const r = rows[0];
                    const absAlbumPath = path.join(PHOTOS_DIR, rel);
                    const abs = path.join(PHOTOS_DIR, r.path);
                    const info = { path: abs, width: r.width || 1, height: r.height || 1, mtime: r.mtime || Date.now() };
                    coversMap.set(absAlbumPath, info);
                    try { await redis.set(`cover_info:/${rel}`, JSON.stringify(info), 'EX', CACHE_DURATION); } catch {}
                }
            } catch (err) {
                logger.debug('DB 封面逐条查询失败:', rel, err && err.message);
            }
        }
    }

    return coversMap;
}

/**
 * 直接子项（相册/媒体）分页，排序全部在 SQL 完成
 * @param {string} relativePathPrefix 相对路径前缀（'' 表示根）
 * @param {string} userId 用户ID（用于最近浏览排序）
 * @param {string} sort 排序策略：smart | name_asc | name_desc | mtime_asc | mtime_desc | viewed_desc
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

    // 总数（albums + media）
    const totalRows = await dbAll('main',
        `SELECT COUNT(1) as c FROM items
         WHERE (${whereClause}) AND type IN ('album','photo','video')`,
        whereParams
    );
    const total = totalRows?.[0]?.c || 0;

    // 构建排序表达式
    const now = Date.now();
    const dayAgo = Math.floor(now - 24 * 60 * 60 * 1000);
    let orderBy = '';

    switch (sort) {
        case 'name_asc':
            orderBy = `ORDER BY is_dir DESC, name COLLATE NOCASE ASC`;
            break;
        case 'name_desc':
            orderBy = `ORDER BY is_dir DESC, name COLLATE NOCASE DESC`;
            break;
        case 'mtime_asc':
            orderBy = `ORDER BY is_dir DESC, mtime ASC`;
            break;
        case 'mtime_desc':
            orderBy = `ORDER BY is_dir DESC, mtime DESC`;
            break;
        case 'viewed_desc':
            // 不跨库 JOIN，先按名称排序，稍后在页面内做二次排序
            orderBy = `ORDER BY is_dir DESC, name COLLATE NOCASE ASC`;
            break;
        default: // smart
            if (!prefix) {
                orderBy = `ORDER BY is_dir DESC,
                                   CASE WHEN is_dir=1 THEN CASE WHEN mtime > ${dayAgo} THEN 0 ELSE 1 END END ASC,
                                   CASE WHEN is_dir=1 AND mtime > ${dayAgo} THEN mtime END DESC,
                                   CASE WHEN is_dir=1 AND mtime <= ${dayAgo} THEN name END COLLATE NOCASE ASC,
                                   CASE WHEN is_dir=0 THEN name END COLLATE NOCASE ASC`;
            } else {
                // 子目录 smart：历史优先改为名称排序，稍后在页面内做二次排序
                orderBy = `ORDER BY is_dir DESC, name COLLATE NOCASE ASC`;
            }
    }

    // albums 子查询（不跨库 JOIN）
    const albumsSelect = `SELECT 1 AS is_dir, i.name, i.path, i.mtime, i.width, i.height, NULL AS last_viewed
           FROM items i
           WHERE i.type = 'album' AND (${whereClause})`;

    // media 子查询
    const mediaSelect = `SELECT 0 AS is_dir, i.name, i.path, i.mtime, i.width, i.height, NULL AS last_viewed
                         FROM items i
                         WHERE i.type IN ('photo','video') AND (${whereClause})`;

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
        logger.warn(`数据库检查HLS状态失败: ${e.message}`);
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
        throw new Error(`不安全的路径访问: ${relativePathPrefix}`);
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

    // 处理排序
    const rowsEffective = await processSorting(rows, sort, relativePathPrefix, userId);

    // 处理视频HLS状态
    const hlsReadySet = await processHlsStatus(rowsEffective);

    // 处理相册封面
    const coversMap = await processAlbumCovers(rowsEffective);

    // 构建最终结果
    const items = await buildItems(rowsEffective, hlsReadySet, coversMap);

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
        throw new Error(`路径未找到或不是目录: ${relativePathPrefix}`);
    }

    return { exists: true, directory };
}

/**
 * 处理排序逻辑
 */
async function processSorting(rows, sort, relativePathPrefix, userId) {
    const isSubdirSmart = sort === 'smart' && (relativePathPrefix || '').length > 0;
    const needViewedSort = sort === 'viewed_desc' || isSubdirSmart;

    if (!needViewedSort || !userId) {
        return rows;
    }

    const albumRows = rows.filter(r => r.is_dir === 1);
    if (albumRows.length === 0) {
        return rows;
    }

    try {
        const albumPaths = albumRows.map(r => r.path);
        const placeholders = albumPaths.map(() => '?').join(',');
        const viewRows = await dbAll(
            'history',
            `SELECT item_path, MAX(viewed_at) AS last_viewed FROM view_history WHERE user_id = ? AND item_path IN (${placeholders}) GROUP BY item_path`,
            [userId, ...albumPaths]
        );

        const lastViewedMap = new Map(viewRows.map(v => [v.item_path, v.last_viewed || 0]));
        const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

        const albumsSorted = albumRows.slice().sort((a, b) =>
            (lastViewedMap.get(b.path) || 0) - (lastViewedMap.get(a.path) || 0) ||
            collator.compare(a.name, b.name)
        );

        const mediaRows = rows.filter(r => r.is_dir === 0).slice().sort((a, b) =>
            collator.compare(a.name, b.name)
        );

        return [...albumsSorted, ...mediaRows];
    } catch (e) {
        logger.warn('读取最近浏览排序信息失败，回退为名称排序', e);
        return rows;
    }
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
            logger.warn(`文件系统检查HLS状态失败，回退到数据库查询: ${e.message}`);
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
            logger.warn(`无法获取文件状态: ${fullAbsPath}`, e);
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
async function getMediaDimensions(entryRelativePath, fullAbsPath, isVideo, mtime, dbDimensions = null) {
    // 优先使用数据库中的预存储宽高信息
    let dimensions = dbDimensions ? { width: dbDimensions.width, height: dbDimensions.height } : { width: null, height: null };

    // 如果数据库中有有效的尺寸信息，直接使用
    if (dimensions.width && dimensions.height && dimensions.width > 0 && dimensions.height > 0) {
        logger.debug(`使用数据库预存储的 ${entryRelativePath} 尺寸: ${dimensions.width}x${dimensions.height}`);
        return dimensions;
    }

    // 如果数据库中没有宽高信息或数据无效，则动态获取
    logger.debug(`数据库中没有尺寸信息，开始动态获取 ${entryRelativePath}`);
    const cacheKey = `dim:${entryRelativePath}:${mtime}`;
    let cachedDimensions = null;

    try {
        cachedDimensions = await redis.get(cacheKey);
    } catch (e) {
        logger.warn(`获取尺寸Redis缓存失败: ${cacheKey}`, e.message);
    }

    if (cachedDimensions) {
        try {
            dimensions = JSON.parse(cachedDimensions);
            if (!dimensions || typeof dimensions.width !== 'number' || typeof dimensions.height !== 'number') {
                logger.debug(`无效的缓存尺寸数据 for ${entryRelativePath}, 将重新计算。`);
                dimensions = null;
            }
        } catch (e) {
            logger.debug(`解析缓存尺寸失败 for ${entryRelativePath}, 将重新计算。`, e);
            dimensions = null;
        }
    }

    if (!dimensions) {
        try {
            dimensions = await limitDimensionProbe(async () => {
                if (isVideo) {
                    return await getVideoDimensions(fullAbsPath);
                } else {
                    const metadata = await sharp(fullAbsPath).metadata();
                    return { width: metadata.width, height: metadata.height };
                }
            });

            try {
                await redis.set(cacheKey, JSON.stringify(dimensions), 'EX', 60 * 60 * 24 * 30);
            } catch (e) {
                logger.warn(`设置尺寸Redis缓存失败: ${cacheKey}`, e.message);
            }

            logger.debug(`动态获取 ${entryRelativePath} 的尺寸: ${dimensions.width}x${dimensions.height}`);
        } catch (e) {
            logger.error(`无法获取媒体文件尺寸: ${entryRelativePath}`, e);
            dimensions = { width: 1920, height: 1080 };
        }
    }

    return dimensions;
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
            await redis.del(...cacheKeys); // 使用扩展运算符展开数组
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
    findCoverPhotosBatch,
    findCoverPhotosBatchDb,
    getDirectoryContents,
    invalidateCoverCache
};
