const { parentPort } = require('worker_threads');
const path = require('path');
const os = require('os');
const winston = require('winston');
const baseLogger = require('../config/logger');
const { LOG_PREFIXES, formatLog, normalizeMessagePrefix } = baseLogger;
const sharp = require('sharp');
const { TraceManager } = require('../utils/trace');
// 控制 sharp 缓存与并行，避免首扫堆积内存
try {
    const memMb = Number(process.env.SHARP_CACHE_MEMORY_MB || 32);
    const items = Number(process.env.SHARP_CACHE_ITEMS || 100);
    const files = Number(process.env.SHARP_CACHE_FILES || 0);
    sharp.cache({ memory: memMb, items, files });
    const { SHARP_CONCURRENCY } = require('../config');
    if (Number(SHARP_CONCURRENCY) > 0) sharp.concurrency(Number(SHARP_CONCURRENCY));
} catch (sharpConfigError) {
    baseLogger.debug('[索引线程] 初始化 Sharp 配置失败，已使用默认设置', sharpConfigError && sharpConfigError.message ? { error: sharpConfigError.message } : sharpConfigError);
}
const { initializeConnections, getDB, dbRun, dbGet, runPreparedBatch } = require('../db/multi-db');
const { tempFileManager } = require('../utils/tempFileManager');
const { redis, getAvailability } = require('../config/redis');
const { safeRedisGet, safeRedisSet, safeRedisDel } = require('../utils/helpers');
const { createNgrams } = require('../utils/search.utils');
const { getVideoDimensions } = require('../utils/media.utils.js');
const { invalidateTags } = require('../services/cache.service.js');
const idxRepo = require('../repositories/indexStatus.repo');
const { withTransaction } = require('../services/tx.manager');
const { getCount } = require('../repositories');
const { createWorkerResult, createWorkerError, createWorkerLog } = require('../utils/workerMessage');

const INDEX_PROGRESS_LOG_STEP = Math.max(1000, Number(process.env.INDEX_PROGRESS_LOG_STEP || 5000));
const INDEX_CACHE_LOG_INTERVAL_MS = Math.max(1000, Number(process.env.INDEX_CACHE_LOG_INTERVAL_MS || 20000));

(async () => {
    await initializeConnections();
    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'debug',
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp(),
            winston.format.printf(info => {
                const date = new Date(info.timestamp);
                const time = date.toTimeString().split(' ')[0];
                const normalized = normalizeMessagePrefix(info.message);
                return `[${time}] ${info.level}: ${LOG_PREFIXES.INDEXING_WORKER || '索引线程'} ${normalized}`;
            })
        ),
        transports: [new winston.transports.Console()]
    });
    const { dbAll } = require('../db/multi-db');
    const { promises: fs } = require('fs');

    // 缓存上次的并发数，用于检测变化
    let lastIndexConcurrency = null;

    // 缓存上次的 debug 日志状态，用于节流降噪
    let lastDebugLogState = null;

    // 动态索引并发获取（支持降级）
    async function resolveIndexConcurrency(scenario = 'initial') {
        try {
            // 尝试从 adaptive.service 获取动态并发数
            const { getIndexConcurrency } = require('../services/adaptive.service');
            const concurrency = getIndexConcurrency(scenario);

            // 检测并发数变化，输出提示日志
            if (lastIndexConcurrency !== null && lastIndexConcurrency !== concurrency) {
                if (concurrency > lastIndexConcurrency) {
                    logger.info(`[索引并发] ⚡ 检测到前台空闲，加速索引: ${lastIndexConcurrency} → ${concurrency} 并发`);
                } else {
                    logger.info(`[索引并发] 🎯 检测到前台任务，降低索引并发为前台让路: ${lastIndexConcurrency} → ${concurrency} 并发`);
                }
            }

            lastIndexConcurrency = concurrency;
            return concurrency;
        } catch (error) {
            // 降级：使用静态配置
            logger.debug(`[索引并发] 动态获取失败，使用静态配置: ${error.message}`);
            return require('../config').INDEX_CONCURRENCY || 8;
        }
    }

    // 内存优化：限制缓存大小，避免内存无限增长
    const MAX_CACHE_SIZE = 2000; // 最大缓存2000个条目
    const FFPROBE_TIMEOUT_MS = 30 * 1000;
    const CHILD_PROCESS_MAX_BUFFER = 5 * 1024 * 1024; // 5MB

    // 缓存外部化：结合Redis和本地缓存
    class ExternalDimensionCache {
        constructor() {
            this.redis = null;
            this.localCache = new Map(); // 小型本地缓存，快速访问
            this.LOCAL_CACHE_SIZE = 500; // 本地缓存最大500个条目
            this.REDIS_TTL = 3600; // Redis缓存1小时
            this.redisReadyLogged = false;
            this.redisUnavailableLogged = false;
            this.redisWaitMs = Number(process.env.INDEX_WORKER_REDIS_WAIT_MS || 5000);
            this.redisPollMs = Math.max(50, Number(process.env.INDEX_WORKER_REDIS_POLL_INTERVAL_MS || 200));
            this.readyPromise = this.bindRedisWithWait(this.redisWaitMs);
        }

        async bindRedisWithWait(timeoutMs = this.redisWaitMs) {
            const start = Date.now();
            const effectiveTimeout = Math.max(0, Number(timeoutMs) || 0);

            if (this.tryAttachRedis()) {
                return;
            }

            while (Date.now() - start < effectiveTimeout) {
                await new Promise(resolve => setTimeout(resolve, this.redisPollMs));
                if (this.tryAttachRedis()) {
                    return;
                }
            }

            // 最后一轮尝试
            if (this.tryAttachRedis()) {
                return;
            }

            if (!this.redisUnavailableLogged) {
                logger.debug('Redis不可用，使用本地缓存');
                this.redisUnavailableLogged = true;
            }
        }

        tryAttachRedis() {
            try {
                const availability = typeof getAvailability === 'function' ? getAvailability() : null;
                if (redis && !redis.isNoRedis && availability === 'ready') {
                    this.redis = redis;
                    if (!this.redisReadyLogged) {
                        logger.debug('Redis缓存已启用');
                        this.redisReadyLogged = true;
                    }
                    return true;
                }
            } catch (error) {
                if (!this.redisUnavailableLogged) {
                    logger.debug('Redis加载失败，使用本地缓存');
                    this.redisUnavailableLogged = true;
                }
            }
            return false;
        }

        async ensureRedisBound() {
            if (this.redis && !this.redis.isNoRedis) {
                return true;
            }

            await this.readyPromise;

            if (this.redis && !this.redis.isNoRedis) {
                return true;
            }

            try {
                if (typeof getAvailability === 'function' && getAvailability() === 'ready') {
                    this.readyPromise = this.bindRedisWithWait(0);
                    await this.readyPromise;
                }
            } catch (redisAvailabilityError) {
                logger.debug(`${LOG_PREFIXES.INDEXING_WORKER} Redis 可用性检测失败（忽略）: ${redisAvailabilityError && redisAvailabilityError.message}`);
            }

            return this.redis && !this.redis.isNoRedis;
        }

        async get(key) {
            await this.ensureRedisBound();
            // 1. 先查本地缓存（最快）
            if (this.localCache.has(key)) {
                return this.localCache.get(key);
            }

            // 2. 再查Redis缓存
            if (this.redis) {
                try {
                    const data = await safeRedisGet(this.redis, `dim:${key}`, '缓存尺寸读取');
                    if (data) {
                        const parsed = JSON.parse(data);
                        // 同步到本地缓存
                        this._addToLocalCache(key, parsed);
                        return parsed;
                    }
                } catch (e) {
                    logger.debug('Redis查询失败:', e.message);
                }
            }

            return null;
        }

        async set(key, value) {
            await this.ensureRedisBound();
            // 1. 本地缓存
            this._addToLocalCache(key, value);

            // 2. Redis缓存（异步，不阻塞）
            if (this.redis) {
                try {
                    await safeRedisSet(this.redis, `dim:${key}`, JSON.stringify(value), 'EX', this.REDIS_TTL, '缓存尺寸写入');
                } catch (e) {
                    // Redis失败不影响本地缓存
                    logger.debug('Redis缓存失败:', e.message);
                }
            }
        }

        _addToLocalCache(key, value) {
            // 控制本地缓存大小
            if (this.localCache.size >= this.LOCAL_CACHE_SIZE) {
                // LRU: 删除最旧的条目
                const firstKey = this.localCache.keys().next().value;
                if (firstKey !== undefined) {
                    this.localCache.delete(firstKey);
                }
            }
            this.localCache.set(key, value);
        }

        clear() {
            this.localCache.clear();
            // Redis缓存保留，不清理（重启后仍然有效）
        }
    }

    const externalCache = new ExternalDimensionCache();



    // --- 专用表：预计算相册封面（根治运行时重负载计算） ---
    async function ensureAlbumCoversTable() {
        try {
            await dbRun('main', `CREATE TABLE IF NOT EXISTS album_covers (
                album_path TEXT PRIMARY KEY,
                cover_path TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                mtime INTEGER NOT NULL
            );`);
            await dbRun('main', `CREATE INDEX IF NOT EXISTS idx_album_covers_album_path ON album_covers(album_path);`);
        } catch (e) {
            // 容错：若表不存在导致后续写入失败，则在使用处重试一次创建
            logger.debug('确保 album_covers 表或索引存在时出错，将在使用处重试:', e && e.message);
        }
    }

    // 计算一个相对路径的所有父相册路径（不含空路径）
    function enumerateParentAlbums(relativeMediaPath) {
        const parts = (relativeMediaPath || '').replace(/\\/g, '/').split('/');
        if (parts.length <= 1) return [];
        const parents = [];
        for (let i = 0; i < parts.length - 1; i++) {
            const albumPath = parts.slice(0, i + 1).join('/');
            parents.push(albumPath);
        }
        return parents;
    }

    // 从 items 表一次性重建 album_covers：
    // 思路：先取所有相册路径集合；再将所有媒体按 mtime DESC 扫描，
    // 将尚未设置封面的父相册依次设置为当前媒体。
    async function rebuildAlbumCoversFromItems() {
        logger.debug('[INDEXING-WORKER] 开始重建 album_covers（基于 items 表）...');
        const t0 = Date.now();
        try {
            await ensureAlbumCoversTable();

            const albumRows = await dbAll('main', `SELECT path FROM items WHERE type='album'`);
            const albumSet = new Set(albumRows.map(r => (r.path || '').replace(/\\/g, '/')));
            if (albumSet.size === 0) {
                logger.debug('[INDEXING-WORKER] 无相册条目，跳过封面重建。');
                return;
            }

            // 读取所有媒体，按 mtime DESC 保证先赋值最新的
            const mediaRows = await dbAll('main', `SELECT path, mtime, width, height FROM items WHERE type IN ('photo','video') ORDER BY mtime DESC`);
            const coverMap = new Map(); // album_path -> {cover_path,width,height,mtime}

            for (const m of mediaRows) {
                const mediaPath = (m.path || '').replace(/\\/g, '/');
                const parents = enumerateParentAlbums(mediaPath);
                if (parents.length === 0) continue;
                for (const albumPath of parents) {
                    if (!albumSet.has(albumPath)) continue;
                    if (!coverMap.has(albumPath)) {
                        coverMap.set(albumPath, {
                            cover_path: mediaPath,
                            width: Number(m.width) || 1,
                            height: Number(m.height) || 1,
                            mtime: Number(m.mtime) || 0,
                        });
                    }
                }
                // 小优化：全部相册都已被设置封面则可提前结束
                if (coverMap.size >= albumSet.size) break;
            }

            // 批量写入（UPSERT）— 通过统一事务与批处理执行器，杜绝嵌套事务
            const upsertSql = `INSERT INTO album_covers (album_path, cover_path, width, height, mtime)
                               VALUES (?, ?, ?, ?, ?)
                               ON CONFLICT(album_path) DO UPDATE SET
                                   cover_path=excluded.cover_path,
                                   width=excluded.width,
                                   height=excluded.height,
                                   mtime=excluded.mtime`;
            const rows = Array.from(coverMap.entries()).map(([albumPath, info]) => [
                albumPath,
                info.cover_path,
                info.width,
                info.height,
                info.mtime
            ]);

            // 删除已无媒体的相册的旧封面记录，避免残留指向已删除文件的封面
            const staleAlbums = Array.from(albumSet).filter(albumPath => !coverMap.has(albumPath));
            if (staleAlbums.length > 0) {
                try {
                    const CHUNK = 800;
                    for (let i = 0; i < staleAlbums.length; i += CHUNK) {
                        const slice = staleAlbums.slice(i, i + CHUNK);
                        const placeholders = slice.map(() => '?').join(',');
                        await dbRun('main', `DELETE FROM album_covers WHERE album_path IN (${placeholders})`, slice);
                    }
                } catch (e) {
                    logger.error('[INDEXING-WORKER] 清理失效相册封面失败（忽略）:', e && e.message);
                }
            }

            let coversUpsertOk = false;
            if (rows.length > 0) {
                try {
                    // 直接使用runPreparedBatch，它内部会管理事务
                    // 不使用withAdmission/withTransaction包裹，避免嵌套事务问题
                    await runPreparedBatch('main', upsertSql, rows, { manageTransaction: true, chunkSize: 800 });
                    coversUpsertOk = true;
                } catch (e) {
                    logger.error('[INDEXING-WORKER] 重建 album_covers 失败（已回滚）：' + (e && e.message));
                }
            } else {
                logger.debug('[INDEXING-WORKER] 无需更新 album_covers（无可用媒体或无需变更）');
            }

            const dtCovers = ((Date.now() - t0) / 1000).toFixed(1);
            if (coversUpsertOk) {
                logger.debug(`[INDEXING-WORKER] album_covers 重建完成，用时 ${dtCovers}s，生成 ${coverMap.size} 条。`);
            } else {
                logger.debug('[INDEXING-WORKER] album_covers 重建未完成，已记录失败并回滚');
            }

        } catch (e) {
            logger.error('[INDEXING-WORKER] 重建 album_covers 失败:', e);
        }
    }

    /**
     * 更新 is_leaf 标志
     * 默认行为：全量刷新（所有 album 设置为叶子，再标记有子相册的为非叶子）
     * 优化：当提供 affectedAlbums 时，仅对受影响相册及其父链做增量计算，避免全表写锁
     */
    async function updateIsLeafFlags(affectedAlbums = null) {
        const t0 = Date.now();
        try {
            const candidatesInput = Array.isArray(affectedAlbums)
                ? affectedAlbums
                : (affectedAlbums instanceof Set ? Array.from(affectedAlbums) : null);

            const candidates = (candidatesInput || [])
                .map(rel => String(rel || '').replace(/^\/+/, ''))
                .filter(rel => rel && rel !== '.' && rel !== '/');

            // 如果未提供受影响范围或范围过大，退回全量刷新（兼容原行为）
            const FULL_REFRESH_THRESHOLD = Number(process.env.IS_LEAF_FULL_THRESHOLD || 500);
            if (!candidates || candidates.length === 0 || candidates.length >= FULL_REFRESH_THRESHOLD) {
                await dbRun('main', `UPDATE items SET is_leaf = 1 WHERE type = 'album'`);
                await dbRun('main', `
                    UPDATE items SET is_leaf = 0
                    WHERE type = 'album' AND path IN (
                        SELECT DISTINCT parent.path
                        FROM items parent
                        JOIN items child ON child.type = 'album'
                            AND SUBSTR(child.path, 1, LENGTH(parent.path) + 1) = parent.path || '/'
                            AND instr(substr(child.path, length(parent.path) + 2), '/') = 0
                        WHERE parent.type = 'album'
                    )
                `);

                const dt = ((Date.now() - t0) / 1000).toFixed(2);
                const leafCount = await dbGet('main', `SELECT COUNT(*) as count FROM items WHERE type='album' AND is_leaf=1`);
                const parentCount = await dbGet('main', `SELECT COUNT(*) as count FROM items WHERE type='album' AND is_leaf=0`);
                const total = (leafCount?.count || 0) + (parentCount?.count || 0);
                if (total > 0) {
                    logger.debug(`[INDEXING-WORKER] is_leaf 标志更新完成（全量），用时 ${dt}s，叶子相册: ${leafCount?.count || 0}，父相册: ${parentCount?.count || 0}`);
                }
                return;
            }

            // 增量模式：仅更新受影响相册的 is_leaf
            const normalized = Array.from(new Set(candidates));
            const updates = [];
            for (const rel of normalized) {
                const hasChild = await dbGet('main',
                    `SELECT 1 as has_child
                     FROM items
                     WHERE type = 'album'
                       AND SUBSTR(path, 1, LENGTH(?) + 1) = ? || '/'
                       AND instr(substr(path, length(?) + 2), '/') = 0
                     LIMIT 1`,
                    [rel, rel, rel]
                );
                const isLeaf = hasChild ? 0 : 1;
                updates.push([isLeaf, rel]);
            }

            if (updates.length > 0) {
                await runPreparedBatch('main', 'UPDATE items SET is_leaf = ? WHERE path = ?', updates, { manageTransaction: true, chunkSize: 200 });
            }

            const dt = ((Date.now() - t0) / 1000).toFixed(2);
            logger.debug(`[INDEXING-WORKER] is_leaf 增量更新完成，用时 ${dt}s，范围=${updates.length}`);
        } catch (e) {
            logger.error('[INDEXING-WORKER] 更新 is_leaf 标志失败:', e);
        }
    }

    // 内存优化：本地缓存清理（每2分钟一次）
    const cacheCleanupInterval = setInterval(() => {
        // 清理本地缓存大小（externalCache会自动管理）
        const localCacheSize = externalCache.localCache.size;
        if (localCacheSize > externalCache.LOCAL_CACHE_SIZE * 0.8) {
            // 清理最旧的20%条目
            const entriesToDelete = Math.floor(localCacheSize * 0.2);
            const entries = Array.from(externalCache.localCache.entries())
                .sort((a, b) => a[1].timestamp - b[1].timestamp);

            for (let i = 0; i < entriesToDelete && i < entries.length; i++) {
                externalCache.localCache.delete(entries[i][0]);
            }

            logger.debug(`定期清理本地缓存: ${localCacheSize} → ${externalCache.localCache.size}/${externalCache.LOCAL_CACHE_SIZE}`);
        }
    }, 2 * 60 * 1000); // 每2分钟清理一次

    process.on('exit', () => clearInterval(cacheCleanupInterval));

    async function getMediaDimensions(filePath, type, mtime) {
        const cacheKey = `${filePath}:${mtime}`;

        // 使用外部缓存（Redis + 本地缓存）
        const cached = await externalCache.get(cacheKey);
        if (cached) return cached;

        try {
            let dimensions = type === 'video'
                ? await getVideoDimensions(filePath)
                : await sharp(filePath).metadata().then(m => ({ width: m.width, height: m.height }));

            // 异步缓存，不阻塞主流程
            externalCache.set(cacheKey, dimensions).catch(e =>
                logger.debug('缓存存储失败:', e.message)
            );

            return dimensions;
        } catch (error) {
            logger.debug(`获取文件尺寸失败: ${path.basename(filePath)}, ${error.message}`);
            return { width: 1920, height: 1080 };
        }
    }

    async function processConcurrentBatch(items, concurrency, processor) {
        const results = [];
        for (let i = 0; i < items.length; i += concurrency) {
            const batch = items.slice(i, i + concurrency);
            results.push(...await Promise.all(batch.map(processor)));
        }
        return results;
    }

    /**
     * 并行处理文件尺寸信息
     * @param {Array} items - 待处理文件列表
     * @param {string} photosDir - 照片根目录
     * @param {string} scenario - 场景类型（'initial' | 'rebuild' | 'incremental'）
     * @returns {Promise<Array>} 包含尺寸信息的文件列表
     */
    async function processDimensionsInParallel(items, photosDir, scenario = 'initial') {
        const concurrency = await resolveIndexConcurrency(scenario);

        // 获取前台任务状态（用于日志）
        let foregroundStatus = 'unknown';
        try {
            const state = require('../services/state.manager');
            const thumbPending = (state.thumbnail.getActiveCount() || 0) + (state.thumbnail.getQueueLen() || 0);
            foregroundStatus = thumbPending > 5 ? `繁忙(缩略图:${thumbPending})` : '空闲';
        } catch (e) {
            // 忽略状态获取失败
        }

        // 只在状态变化时输出 debug 日志（降噪）
        const currentLogState = `${scenario}:${concurrency}:${foregroundStatus}`;
        if (lastDebugLogState !== currentLogState) {
            logger.debug(`[索引并发] scenario=${scenario}, concurrency=${concurrency}, items=${items.length}, 前台=${foregroundStatus}`);
            lastDebugLogState = currentLogState;
        }

        return processConcurrentBatch(items, concurrency, async (item) => {
            let width = null, height = null;
            if (item.type === 'photo' || item.type === 'video') {
                const fullPath = path.resolve(photosDir, item.path);
                const dimensions = await getMediaDimensions(fullPath, item.type, item.mtime);
                width = dimensions.width;
                height = dimensions.height;
            }
            return { ...item, width, height };
        });
    }

    async function* walkDirStream(dir, relativePath = '') {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                // 跳过系统目录、隐藏目录和临时目录
                if (entry.name === '@eaDir' || entry.name === '.tmp' || entry.name.startsWith('.')) continue;

                const fullPath = path.join(dir, entry.name);
                const entryRelativePath = path.join(relativePath, entry.name);
                const stats = await fs.stat(fullPath).catch(() => ({ mtimeMs: 0 }));

                if (entry.isDirectory()) {
                    yield { type: 'album', path: entryRelativePath, name: entry.name, mtime: stats.mtimeMs };
                    yield* walkDirStream(fullPath, entryRelativePath);
                } else if (entry.isFile() && /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(entry.name)) {
                    // 跳过临时文件
                    if (tempFileManager.isTempFile(entry.name)) continue;

                    const type = /\.(jpe?g|png|webp|gif)$/i.test(entry.name) ? 'photo' : 'video';
                    yield { type, path: entryRelativePath, name: entry.name, mtime: stats.mtimeMs };
                }
            }
        } catch (e) {
            logger.error(`[INDEXING-WORKER] 遍历目录失败: ${dir}`, e);
        }
    }

    /**
     * 递归统计指定目录下的媒体文件和相册总数，仅用于预扫描。
     * 
     * @param {string} dir - 需要遍历的目录的绝对路径
     * @param {string} [relativePath=''] - 当前递归相对路径（默认为空）
     * @returns {Promise<number>} - 文件及相册的总数
     */
    async function countFilesOnly(dir, relativePath = '') {
        let count = 0;
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                // 跳过系统目录、隐藏目录及临时目录
                if (entry.name === '@eaDir' || entry.name === '.tmp' || entry.name.startsWith('.')) continue;

                if (entry.isDirectory()) {
                    count++; // 相册目录计为1
                    count += await countFilesOnly(path.join(dir, entry.name), path.join(relativePath, entry.name));
                } else if (/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(entry.name)) {
                    // 跳过临时文件
                    if (tempFileManager.isTempFile(entry.name)) continue;
                    count++;
                }
            }
        } catch (e) {
            logger.debug(`[INDEXING-WORKER] 预扫描目录失败: ${dir}, ${e.message}`);
        }
        return count;
    }

    const tasks = {

        async get_all_media_items() {
            try {
                // 仅返回必要字段，降低消息体体积
                const rows = await dbAll('main', `SELECT path, type FROM items WHERE type IN ('photo','video')`);
                const payload = (rows || []).map(r => ({ path: (r.path || '').replace(/\\/g, '/'), type: r.type }));
                parentPort.postMessage(createWorkerResult({
                    type: 'all_media_items_result',
                    payload
                }));
            } catch (e) {
                logger.error('[INDEXING-WORKER] 获取全部媒体列表失败:', e && e.message);
                parentPort.postMessage(createWorkerError({
                    type: 'all_media_items_error',
                    error: e,
                }));
            }
        },
        async rebuild_index({ photosDir, syncThumbnails = false } = {}) {
            logger.info('[INDEXING-WORKER] 开始执行索引重建任务...');
            try {
                const idxRepo = require('../repositories/indexStatus.repo');
                const lastProcessedPath = await idxRepo.getResumeValue('last_processed_path');

                if (lastProcessedPath) {
                    logger.debug(`[INDEXING-WORKER] 检测到上次索引断点，将从 ${lastProcessedPath} 继续`);
                } else {
                    logger.info('[INDEXING-WORKER] 开始统计文件总数（预扫描）...');
                    const t0 = Date.now();
                    const totalFiles = await countFilesOnly(photosDir);
                    const dt = ((Date.now() - t0) / 1000).toFixed(1);
                    await idxRepo.setTotalFiles(totalFiles);
                    logger.info(`[INDEXING-WORKER] 预扫描完成，共发现 ${totalFiles} 个条目，用时 ${dt}s`);

                    logger.debug('[INDEXING-WORKER] 未发现索引断点，将从头开始');
                    await idxRepo.setIndexStatus('building');
                    await idxRepo.setProcessedFiles(0);

                    // 使用事务确保items和items_fts的删除是原子的
                    await withTransaction('main', async () => {
                        await dbRun('main', "DELETE FROM items");
                        await dbRun('main', "DELETE FROM items_fts");
                    });
                }

                let count = await idxRepo.getProcessedFiles();
                // 统一从运行参数派生（支持 env 覆盖）
                const { INDEX_BATCH_SIZE } = require('../config');
                const batchSize = INDEX_BATCH_SIZE;

                // 使用 OR IGNORE 避免断点续跑时重复插入 items；FTS 使用 OR REPLACE 确保令牌更新
                const itemsStmt = getDB('main').prepare("INSERT OR IGNORE INTO items (name, path, type, mtime, width, height) VALUES (?, ?, ?, ?, ?, ?)");
                const thumbUpsertStmt = getDB('main').prepare("INSERT INTO thumb_status(path, mtime, status, last_checked) VALUES(?, ?, 'pending', 0) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, status='pending'");
                const ftsStmt = getDB('main').prepare("INSERT OR REPLACE INTO items_fts (rowid, name) VALUES (?, ?)");

                let batch = [];
                let lastProgressLogCount = 0;
                let lastCacheLogAt = 0;
                let shouldProcess = !lastProcessedPath;

                for await (const item of walkDirStream(photosDir)) {
                    if (!shouldProcess && item.path === lastProcessedPath) {
                        shouldProcess = true;
                    }
                    if (!shouldProcess) continue;

                    batch.push(item);
                    if (batch.length >= batchSize) {
                        const processedBatch = await processDimensionsInParallel(batch, photosDir, 'rebuild');
                        await withTransaction('main', async () => {
                            await tasks.processBatchInTransactionOptimized(processedBatch, itemsStmt, ftsStmt, thumbUpsertStmt);
                        }, { mode: 'IMMEDIATE' });
                        const lastItemInBatch = processedBatch[processedBatch.length - 1];
                        if (lastItemInBatch) {
                            await idxRepo.setResumeValue('last_processed_path', lastItemInBatch.path);
                        }
                        count += batch.length;
                        await idxRepo.setProcessedFiles(count);
                        if ((count - lastProgressLogCount) >= INDEX_PROGRESS_LOG_STEP) {
                            logger.debug(`[INDEXING-WORKER] 已处理 ${count} 个条目`);
                            lastProgressLogCount = count;
                        }

                        // 内存优化：分批清理本地缓存（每处理一批就清理一次）
                        const localCacheSize = externalCache.localCache.size;
                        const batchCleanupCount = Math.floor(localCacheSize * 0.1); // 清理10%的本地缓存
                        if (batchCleanupCount > 0) {
                            const entries = Array.from(externalCache.localCache.entries())
                                .sort((a, b) => a[1].timestamp - b[1].timestamp)
                                .slice(0, batchCleanupCount);

                            entries.forEach(([key]) => externalCache.localCache.delete(key));
                            const now = Date.now();
                            if (now - lastCacheLogAt >= INDEX_CACHE_LOG_INTERVAL_MS) {
                                logger.debug(`批处理后清理本地缓存: ${batchCleanupCount}个条目，当前大小: ${externalCache.localCache.size}/${externalCache.LOCAL_CACHE_SIZE}`);
                                lastCacheLogAt = now;
                            }
                        }

                        batch = [];
                    }
                }
                if (batch.length > 0) {
                    const processedBatch = await processDimensionsInParallel(batch, photosDir, 'rebuild');
                    await withTransaction('main', async () => {
                        await tasks.processBatchInTransactionOptimized(processedBatch, itemsStmt, ftsStmt, thumbUpsertStmt);
                    }, { mode: 'IMMEDIATE' });
                    count += batch.length;
                    await idxRepo.setProcessedFiles(count);
                }

                await idxRepo.deleteResumeKey('last_processed_path');
                await idxRepo.setIndexStatus('complete');
                await idxRepo.setProcessedFiles(count);

                // 内存优化：索引完成后清理本地缓存（Redis缓存保留）
                const finalCacheSize = externalCache.localCache.size;
                externalCache.clear();
                logger.debug(`索引完成后清理本地缓存: ${finalCacheSize}个条目已清理`);

                // 清理 Sharp 缓存，释放 libvips 内存
                try {
                    // 安全的缓存清理：先设为0，等待100ms后重新启用
                    // 避免在禁用期间其他请求调用 Sharp 导致未定义行为
                    sharp.cache({ memory: 0, items: 0, files: 0 });

                    await new Promise(resolve => setTimeout(resolve, 100));

                    // 从环境变量读取配置，提供灵活性
                    const cacheMemory = parseInt(process.env.SHARP_CACHE_MEMORY_MB || '16', 10);
                    const cacheItems = parseInt(process.env.SHARP_CACHE_ITEMS || '50', 10);
                    sharp.cache({ memory: cacheMemory, items: cacheItems, files: 0 });
                    logger.debug(`[INDEXING-WORKER] 已清理 Sharp 缓存 (memory: ${cacheMemory}MB, items: ${cacheItems})`);
                } catch (e) {
                    logger.debug('[INDEXING-WORKER] 清理 Sharp 缓存失败（忽略）:', e && e.message);
                }
                // 注意：Worker 环境下 global.gc 不可用（需要主进程的 --expose-gc）
                // Worker 有独立内存空间，Node.js 会自动进行垃圾回收


                logger.info(`[INDEXING-WORKER] 索引重建完成，共处理 ${count} 个条目。`);

                if (syncThumbnails) {
                    try {
                        logger.info('[INDEXING-WORKER] 开始同步缩略图状态（手动触发）...');
                        const { thumbnailSyncService } = require('../services/settings/maintenance.service');
                        const { syncedCount, existsCount, missingCount } = await thumbnailSyncService.resyncThumbnailStatus();
                        logger.info(`[INDEXING-WORKER] 缩略图状态同步完成: 总计=${syncedCount}, 存在=${existsCount}, 缺失=${missingCount}`);
                    } catch (syncError) {
                        logger.warn('[INDEXING-WORKER] 缩略图状态同步失败（不影响索引）:', syncError.message);
                    }
                } else {
                    logger.debug('[INDEXING-WORKER] 跳过缩略图状态同步（syncThumbnails 标志未启用）');
                }

                // 重建完成后，顺带重建一次 album_covers（确保首次体验不卡）
                await rebuildAlbumCoversFromItems();
                // 更新 is_leaf 标志，标记叶子相册
                await updateIsLeafFlags();
                parentPort.postMessage(createWorkerResult({
                    type: 'rebuild_complete',
                    count,
                }));
            } catch (error) {
                logger.error('[INDEXING-WORKER] 重建索引失败:', error.message, error.stack);
                parentPort.postMessage(createWorkerError({
                    type: 'rebuild_failed',
                    error,
                }));
            }
        },

        async processBatchInTransactionOptimized(processedBatch, itemsStmt, ftsStmt, thumbUpsertStmt) {
            for (const item of processedBatch) {
                // 1) 尝试插入 items（OR IGNORE）
                let rowId;
                try {
                    const info = itemsStmt.run(item.name, item.path, item.type, item.mtime, item.width, item.height);
                    rowId = info.lastInsertRowid;
                } catch (err) {
                    throw err;
                }

                // 2) 获取 rowid：若忽略（已存在），查询现有 id
                if (!rowId || rowId.toString() === '0') { // lastInsertRowid is 0 if no row inserted (OR IGNORE)
                    const ItemsRepository = require('../repositories/items.repo');
                    const itemsRepo = new ItemsRepository();
                    const existingId = await itemsRepo.getIdByPath(item.path);
                    rowId = existingId != null ? existingId : null;
                    if (!rowId) {
                        // 理论上不应发生；安全跳过以防止崩溃
                        continue;
                    }
                }

                // 3) 写入/更新 FTS 令牌（OR REPLACE）
                // 移除扩展名，保持路径名搜索
                const baseText = item.path.replace(/\.[^.]+$/, '').replace(/[\\/]/g, ' ');
                // 只为视频添加扩展名标签，支持按 mp4/mov/webm 等搜索视频
                let searchableText = baseText;
                if (item.type === 'video') {
                    const ext = (item.path.match(/\.([^.]+)$/i) || [])[1] || '';
                    if (ext) searchableText += ` ${ext.toLowerCase()}`;
                }
                const tokenizedName = createNgrams(searchableText, 1, 2);
                ftsStmt.run(rowId, tokenizedName);

                // 4) 标记缩略图状态（只在 photo/video 上更新）
                if (item.type === 'photo' || item.type === 'video') {
                    thumbUpsertStmt.run(item.path, item.mtime);
                }
            }
        },

        async process_changes({ changes, photosDir }) {
            if (!changes || changes.length === 0) return;
            logger.debug(`[INDEXING-WORKER] 开始处理 ${changes.length} 个索引变更`);
            const tagsToInvalidate = new Set();
            const affectedAlbums = new Set();
            const videoAdds = [];

            try {
                // 标记“索引进行中”，以便其它后台任务让路
                await safeRedisSet(redis, 'indexing_in_progress', '1', 'EX', 60, '索引进行中标记');

                await withTransaction('main', async () => {

                    const addOperations = [];
                    const deletePaths = [];

                    for (const change of changes) {
                        if (!change || typeof change.filePath !== 'string' || change.filePath.length === 0) {
                            continue;
                        }
                        const relativePath = path.relative(photosDir, change.filePath).replace(/\\/g, '/');
                        if (!relativePath || relativePath === '..' || relativePath.startsWith('..')) {
                            // 不在照片目录下，忽略
                            continue;
                        }
                        // 统一忽略数据库相关文件（避免误入索引管道）
                        if (/\.(db|db3|sqlite|sqlite3|wal|shm)$/i.test(relativePath)) {
                            continue;
                        }
                        // 增加对 HLS 文件的忽略，防止索引器自我循环
                        if (/\.(m3u8|ts)$/i.test(relativePath)) {
                            continue;
                        }
                        tagsToInvalidate.add(`item:${relativePath}`);
                        // 自身目录（若为相册）也参与受影响集合，确保删除时清理 album_covers/缓存
                        if (change.type === 'addDir' || change.type === 'unlinkDir') {
                            affectedAlbums.add(relativePath);
                            tagsToInvalidate.add(`album:/${relativePath}`);
                            tagsToInvalidate.add(`album:${relativePath}`);
                            tagsToInvalidate.add(`album:${relativePath}/`);
                        }

                        let parentDir = path.dirname(relativePath);
                        while (parentDir !== '.') {
                            tagsToInvalidate.add(`album:/${parentDir}`);
                            tagsToInvalidate.add(`album:${parentDir}`);
                            tagsToInvalidate.add(`album:${parentDir}/`);
                            affectedAlbums.add(parentDir);
                            parentDir = path.dirname(parentDir);
                        }
                        tagsToInvalidate.add('album:/');

                        if (change.type === 'add' || change.type === 'addDir') {
                            const stats = await fs.stat(change.filePath).catch(() => ({ mtimeMs: Date.now() }));
                            const name = path.basename(relativePath);
                            const type = change.type === 'addDir' ? 'album' : (/\.(jpe?g|png|webp|gif)$/i.test(name) ? 'photo' : 'video');
                            addOperations.push({ name, path: relativePath, type, mtime: stats.mtimeMs });
                            if (type === 'video') {
                                videoAdds.push(relativePath);
                            }
                        } else if (change.type === 'unlink' || change.type === 'unlinkDir') {
                            deletePaths.push(relativePath);
                        }
                    }

                    if (deletePaths.length > 0) {
                        const ItemsRepository = require('../repositories/items.repo');
                        const ThumbStatusRepository = require('../repositories/thumbStatus.repo');

                        const itemsRepo = new ItemsRepository();
                        const thumbStatusRepo = new ThumbStatusRepository();

                        const CHUNK = 500;
                        for (let i = 0; i < deletePaths.length; i += CHUNK) {
                            const slice = deletePaths.slice(i, i + CHUNK);

                            // 使用Repository层进行事务保护的批量删除
                            await withTransaction('main', async () => {
                                await itemsRepo.deleteBatch(slice, true); // includeSubpaths=true
                                await thumbStatusRepo.deleteBatch(slice, false);
                            });
                        }
                    }

                    if (addOperations.length > 0) {
                        const itemsStmt = getDB('main').prepare("INSERT OR IGNORE INTO items (name, path, type, mtime, width, height) VALUES (?, ?, ?, ?, ?, ?)");
                        const ftsStmt = getDB('main').prepare("INSERT OR REPLACE INTO items_fts (rowid, name) VALUES (?, ?)");
                        const thumbUpsertStmt = getDB('main').prepare("INSERT INTO thumb_status(path, mtime, status, last_checked) VALUES(?, ?, 'pending', 0) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, status='pending'");
                        const processedAdds = await processDimensionsInParallel(addOperations, photosDir, 'incremental');
                        await tasks.processBatchInTransactionOptimized(processedAdds, itemsStmt, ftsStmt, thumbUpsertStmt);

                        // 通用finalize处理函数
                        const finalizeWithErrorHandling = (stmt, stmtName) => {
                            try {
                                stmt.finalize();
                            } catch (e) {
                                logger.debug(`Finalizing ${stmtName} failed (ignored):`, e.message);
                            }
                        };

                        // 并行finalize所有语句
                        finalizeWithErrorHandling(itemsStmt, 'itemsStmt');
                        finalizeWithErrorHandling(ftsStmt, 'ftsStmt');
                        finalizeWithErrorHandling(thumbUpsertStmt, 'thumbUpsertStmt');
                    }

                    // 基于变更的相册集，增量维护 album_covers（UPSERT）
                    await ensureAlbumCoversTable();
                    const upsertSql = `INSERT INTO album_covers (album_path, cover_path, width, height, mtime)
                                   VALUES (?, ?, ?, ?, ?)
                                   ON CONFLICT(album_path) DO UPDATE SET
                                     cover_path=excluded.cover_path,
                                     width=excluded.width,
                                     height=excluded.height,
                                     mtime=excluded.mtime`;
                    const upsertRows = [];
                    const deleteAlbumPaths = [];
                    for (const albumPath of affectedAlbums) {
                        // 重新计算该相册的封面（取最新媒体）
                        const row = await dbGet('main',
                            `SELECT path, width, height, mtime
                         FROM items
                         WHERE type IN ('photo','video') AND SUBSTR(path, 1, LENGTH(?) + 1) = ? || '/'
                         ORDER BY mtime DESC
                         LIMIT 1`,
                            [albumPath, albumPath]
                        );
                        if (row && row.path) {
                            upsertRows.push([albumPath, row.path, row.width || 1, row.height || 1, row.mtime || 0]);
                        } else {
                            deleteAlbumPaths.push(albumPath);
                        }
                    }
                    if (upsertRows.length > 0) {
                        try {
                            const orchestrator = require('../services/orchestrator');
                            await orchestrator.withAdmission('album-covers-upsert', async () => {
                                await runPreparedBatch('main', upsertSql, upsertRows, { manageTransaction: false, chunkSize: 800 });
                            });
                        } catch (err) {
                            if (/no such table: .*album_covers/i.test(err && err.message)) {
                                await ensureAlbumCoversTable();
                                const orchestrator = require('../services/orchestrator');
                                await orchestrator.withAdmission('album-covers-upsert', async () => {
                                    await runPreparedBatch('main', upsertSql, upsertRows, { manageTransaction: false, chunkSize: 800 });
                                });
                            } else {
                                throw err;
                            }
                        }
                    }
                    if (deleteAlbumPaths.length > 0) {
                        const placeholders = deleteAlbumPaths.map(() => '?').join(',');
                        await dbRun('main', `DELETE FROM album_covers WHERE album_path IN (${placeholders})`, deleteAlbumPaths).catch(async (err) => {
                            if (/no such table: .*album_covers/i.test(err && err.message)) {
                                await ensureAlbumCoversTable();
                                await dbRun('main', `DELETE FROM album_covers WHERE album_path IN (${placeholders})`, deleteAlbumPaths).catch(() => { });
                            }
                        });
                    }

                    // 当子文件变化时，递归更新所有父级目录的 mtime 为当前时间
                    const parentUpdateRows = [];
                    const now = Date.now();
                    for (const albumPath of affectedAlbums) {
                        // 根目录通常不作为 item 存储，或者有特殊处理，这里只更新非根路径
                        if (albumPath && albumPath !== '.' && albumPath !== '/') {
                            parentUpdateRows.push([now, albumPath]);
                        }
                    }

                    if (parentUpdateRows.length > 0) {
                        const updateParentsSql = `UPDATE items SET mtime = ? WHERE path = ?`;
                        // 使用 runPreparedBatch 确保在高并发下也能成功更新
                        await runPreparedBatch('main', updateParentsSql, parentUpdateRows, { manageTransaction: false, chunkSize: 800 });
                    }

                }, { mode: 'IMMEDIATE' });

                if (tagsToInvalidate.size > 0) {
                    await invalidateTags(Array.from(tagsToInvalidate));
                }

                // 增量索引后更新 is_leaf 标志（仅针对受影响相册）
                if (affectedAlbums.size > 0) {
                    await updateIsLeafFlags(affectedAlbums);
                }

                logger.info('[INDEXING-WORKER] 索引增量更新完成。');

                const response = { type: 'process_changes_complete', needsMaintenance: true };
                if (videoAdds.length > 0) {
                    response.videoPaths = videoAdds.map(rel => path.join(photosDir, rel));
                }

                parentPort.postMessage(createWorkerResult(response));
                await safeRedisDel(redis, 'indexing_in_progress', '清理索引标记');
            } catch (error) {
                logger.error('[INDEXING-WORKER] 处理索引变更失败:', error.message, error.stack);
                parentPort.postMessage(createWorkerError({
                    type: 'process_changes_failed',
                    error,
                }));
                await safeRedisDel(redis, 'indexing_in_progress', '清理索引标记');
            }
        },

        // 后台回填缺失的媒体尺寸（width/height），减少运行时探测负载
        async backfill_missing_dimensions(payload) {
            try {
                const photosDir = (payload && payload.photosDir) || process.env.PHOTOS_DIR || '/app/photos';
                const BATCH = Number(process.env.DIM_BACKFILL_BATCH || 500);
                const SLEEP_MS = Number(process.env.DIM_BACKFILL_SLEEP_MS || 200);
                let totalUpdated = 0;
                // 统一闸门：重负载时让路，避免与索引/用户请求竞争
                try { const orchestrator = require('../services/orchestrator'); await orchestrator.gate('index-batch', { checkIntervalMs: 1500 }); } catch (e) { logger.debug(`操作失败: ${e.message}`); }
                while (true) {
                    const rows = await dbAll('main',
                        `SELECT path, type, mtime
                         FROM items
                         WHERE type IN ('photo','video')
                           AND (width IS NULL OR width <= 0 OR height IS NULL OR height <= 0)
                         LIMIT ?`, [BATCH]
                    );
                    if (!rows || rows.length === 0) break;

                    const enriched = await processDimensionsInParallel(rows, photosDir, 'incremental');
                    const updates = enriched
                        .filter(r => r && r.width && r.height)
                        .map(r => [r.width, r.height, r.path]);
                    if (updates.length > 0) {
                        await runPreparedBatchWithRetry(runPreparedBatch, 'main',
                            `UPDATE items SET width = ?, height = ? WHERE path = ?`,
                            updates,
                            { chunkSize: 800 }
                        );
                        totalUpdated += updates.length;
                    }

                    if (rows.length < BATCH) break; // 已处理完
                    // 轻微歇口，避免长期压榨 IO/CPU
                    await new Promise(r => setTimeout(r, SLEEP_MS));
                }
                logger.debug(`[INDEXING-WORKER] 尺寸回填完成，更新 ${totalUpdated} 条记录。`);
                parentPort.postMessage(createWorkerResult({
                    type: 'backfill_dimensions_complete',
                    updated: totalUpdated,
                }));
            } catch (e) {
                logger.debug(`[INDEXING-WORKER] 尺寸回填失败：${e && e.message}`);
                parentPort.postMessage(createWorkerError({
                    type: 'backfill_dimensions_failed',
                    error: e,
                }));
            }
        },

        // 后台回填缺失或无效的 mtime，避免运行时频繁 fs.stat
        async backfill_missing_mtime(payload) {
            try {
                const photosDir = (payload && payload.photosDir) || process.env.PHOTOS_DIR || '/app/photos';
                const BATCH = Number(process.env.MTIME_BACKFILL_BATCH || 500);
                const SLEEP_MS = Number(process.env.MTIME_BACKFILL_SLEEP_MS || 200);
                let totalUpdated = 0;
                // 统一闸门：重负载时让路，避免与索引/用户请求竞争
                try { const orchestrator = require('../services/orchestrator'); await orchestrator.gate('index-batch', { checkIntervalMs: 1500 }); } catch (e) { logger.debug(`操作失败: ${e.message}`); }
                while (true) {
                    const rows = await dbAll('main',
                        `SELECT path
                         FROM items
                         WHERE mtime IS NULL OR mtime <= 0
                         LIMIT ?`, [BATCH]
                    );
                    if (!rows || rows.length === 0) break;

                    const updates = [];
                    for (const r of rows) {
                        try {
                            const fullPath = path.resolve(photosDir, r.path);
                            const stats = await fs.stat(fullPath);
                            const mtime = Number(stats.mtimeMs) || Date.now();
                            updates.push([mtime, r.path]);
                        } catch (statErr) {
                            logger.silly(`[INDEXING-WORKER] 更新 album_covers 时跳过缺失文件 ${r.path}: ${statErr && statErr.message}`);
                        }
                    }
                    if (updates.length > 0) {
                        await runPreparedBatchWithRetry(runPreparedBatch, 'main',
                            `UPDATE items SET mtime = ? WHERE path = ?`,
                            updates,
                            { chunkSize: 800 }
                        );
                        totalUpdated += updates.length;
                    }
                    if (rows.length < BATCH) break;
                    await new Promise(r => setTimeout(r, SLEEP_MS));
                }
                logger.debug(`[INDEXING-WORKER] mtime 回填完成，更新 ${totalUpdated} 条记录。`);
                try {
                    parentPort.postMessage(createWorkerResult({
                        type: 'backfill_mtime_complete',
                        updated: totalUpdated,
                    }));
                } catch (e) { logger.debug(`操作失败: ${e.message}`); }
            } catch (e) {
                logger.debug(`[INDEXING-WORKER] mtime 回填失败：${e && e.message}`);
            }
        },

        async post_index_backfill(payload) {
            const photosDir = (payload && payload.photosDir) || process.env.PHOTOS_DIR || '/app/photos';
            try {
                if (typeof tasks.backfill_missing_dimensions === 'function') {
                    await tasks.backfill_missing_dimensions({ photosDir, origin: 'post_index_backfill' });
                }
            } catch (e) {
                logger.debug('[INDEXING-WORKER] post_index_backfill 尺寸回填失败（忽略）：', e && e.message);
            }

            try {
                if (typeof tasks.backfill_missing_mtime === 'function') {
                    await tasks.backfill_missing_mtime({ photosDir, origin: 'post_index_backfill' });
                }
            } catch (e) {
                logger.debug('[INDEXING-WORKER] post_index_backfill mtime 回填失败（忽略）：', e && e.message);
            }

            parentPort.postMessage(createWorkerResult({
                type: 'post_index_backfill_complete',
            }));
        },
    };

    let isCriticalTaskRunning = false;

    parentPort.on('message', async (message) => {
        // 提取追踪上下文
        const traceContext = TraceManager.fromWorkerMessage(message);

        // 获取实际任务数据
        // 修复消息处理逻辑，确保能正确提取任务类型
        const task = message && message.type ?
            message :
            (message && message.payload && message.payload.type) ?
                message.payload :
                (message && message.task && message.task.type) ?
                    message.task :
                    message;

        // 定义处理函数
        const processTask = async () => {
            if (isCriticalTaskRunning) {
                logger.warn(`[INDEXING-WORKER] 关键任务正在运行，已忽略新的任务: ${task.type}`);
                return;
            }
            const handler = tasks[task.type];
            if (handler) {
                const isCritical = ['rebuild_index', 'process_changes'].includes(task.type);
                if (isCritical) isCriticalTaskRunning = true;
                try {
                    await handler(task.payload);
                } catch (e) {
                    logger.error(`[INDEXING-WORKER] 执行任务 ${task.type} 时发生未捕获的错误:`, e);
                } finally {
                    if (isCritical) isCriticalTaskRunning = false;
                }
            } else {
                logger.warn(`[INDEXING-WORKER] 收到未知任务类型: ${task.type}`);
            }
        };

        // 在追踪上下文中运行
        if (traceContext) {
            await TraceManager.run(traceContext, processTask);
        } else {
            await processTask();
        }
    });

    // 启动时确保 album_covers 存在，并在为空时后台重建
    (async () => {
        try {
            await ensureAlbumCoversTable();
            // 容错：如果表创建失败，getCount 可能抛出异常
            let count = 0;
            try {
                count = await getCount('album_covers');
            } catch (countErr) {
                if (/no such table/i.test(countErr && countErr.message)) {
                    logger.debug('[INDEXING-WORKER] album_covers 表尚未就绪，将在后台重建');
                    count = 0; // 触发重建
                } else {
                    throw countErr;
                }
            }
            if (count === 0) {
                // 非阻塞后台构建，避免影响主索引任务
                setTimeout(async () => {
                    await rebuildAlbumCoversFromItems().catch(() => { });
                    await updateIsLeafFlags().catch(() => { });
                }, 1000);
            }
        } catch (e) {
            logger.debug('[INDEXING-WORKER] 启动时检查/重建 album_covers 失败（忽略）：', e && e.message);
        }
    })();
})();
