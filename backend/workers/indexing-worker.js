const { parentPort } = require('worker_threads');
const path = require('path');
const os = require('os');
const winston = require('winston');
const sharp = require('sharp');
// 控制 sharp 缓存与并行，避免首扫堆积内存
try {
  const memMb = Number(process.env.SHARP_CACHE_MEMORY_MB || 32);
  const items = Number(process.env.SHARP_CACHE_ITEMS || 100);
  const files = Number(process.env.SHARP_CACHE_FILES || 0);
  sharp.cache({ memory: memMb, items, files });
  const { SHARP_CONCURRENCY } = require('../config');
  if (Number(SHARP_CONCURRENCY) > 0) sharp.concurrency(Number(SHARP_CONCURRENCY));
} catch {}
const { initializeConnections, getDB, dbRun, dbGet, runPreparedBatch, adaptDbTimeouts } = require('../db/multi-db');
const { tempFileManager } = require('../utils/tempFileManager');
const { redis } = require('../config/redis');
const { runPreparedBatchWithRetry } = require('../db/sqlite-retry');
const { createNgrams } = require('../utils/search.utils');
const { getVideoDimensions } = require('../utils/media.utils.js');
const { invalidateTags } = require('../services/cache.service.js');
const idxRepo = require('../repositories/indexStatus.repo');
const { withTransaction } = require('../services/tx.manager');

/**
 * 数据库超时管理器
 * 统一管理数据库超时的调整逻辑
 */
class DbTimeoutManager {
    constructor() {
        this.logger = winston.createLogger({
            level: process.env.LOG_LEVEL || 'debug',
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp(),
                winston.format.printf(info => `[${info.timestamp}] ${info.level}: ${info.message}`)
            ),
            transports: [new winston.transports.Console()],
        });
    }

    /**
     * 提升数据库超时（用于高负载操作）
     */
    boostTimeouts() {
        try {
            const result = adaptDbTimeouts({
                busyTimeoutDeltaMs: 20000,
                queryTimeoutDeltaMs: 15000
            });
            this.logger.debug(`[DbTimeoutManager] 提升超时: busy=${result.busyTimeoutMs}ms, query=${result.queryTimeoutMs}ms`);
            return result;
        } catch (error) {
            this.logger.warn(`[DbTimeoutManager] 提升超时失败: ${error.message}`);
            return null;
        }
    }

    /**
     * 恢复数据库超时到默认值
     */
    restoreTimeouts() {
        try {
            const result = adaptDbTimeouts({
                busyTimeoutDeltaMs: -20000,
                queryTimeoutDeltaMs: -15000
            });
            this.logger.debug(`[DbTimeoutManager] 恢复超时: busy=${result.busyTimeoutMs}ms, query=${result.queryTimeoutMs}ms`);
            return result;
        } catch (error) {
            this.logger.warn(`[DbTimeoutManager] 恢复超时失败: ${error.message}`);
            return null;
        }
    }

    /**
     * 在操作前自动提升超时，结束后自动恢复
     */
    async withBoostedTimeouts(operation) {
        let originalTimeouts = null;

        try {
            // 提升超时
            originalTimeouts = this.boostTimeouts();

            // 执行操作
            const result = await operation();

            return result;
        } finally {
            // 恢复超时
            if (originalTimeouts) {
                this.restoreTimeouts();
            }
        }
    }
}

// 创建单例管理器
const dbTimeoutManager = new DbTimeoutManager();

(async () => {
    await initializeConnections();
    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'debug',
        format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] [INDEXING-WORKER] ${info.level}: ${info.message}`)),
        transports: [new winston.transports.Console()]
    });
    const { dbAll } = require('../db/multi-db');
    const { promises: fs } = require('fs');
    
    const CONCURRENT_LIMIT = require('../config').INDEX_CONCURRENCY;

    // 内存优化：限制缓存大小，避免内存无限增长
    const MAX_CACHE_SIZE = 2000; // 最大缓存2000个条目
    const DIMENSION_CACHE = new Map();
    const CACHE_TTL = 1000 * 60 * 10;

    // 缓存外部化：结合Redis和本地缓存
    class ExternalDimensionCache {
        constructor() {
            this.redis = null;
            this.localCache = new Map(); // 小型本地缓存，快速访问
            this.LOCAL_CACHE_SIZE = 500; // 本地缓存最大500个条目
            this.REDIS_TTL = 3600; // Redis缓存1小时

            // 尝试获取Redis连接
            try {
                const { redis } = require('../config/redis');
                if (redis && !redis.isNoRedis && typeof redis.get === 'function' && typeof redis.setex === 'function') {
                    this.redis = redis;
                    logger.debug('[内存优化] Redis缓存已启用');
                } else {
                    logger.debug('[内存优化] Redis不可用，使用本地缓存');
                }
            } catch (e) {
                logger.debug('[内存优化] Redis加载失败，使用本地缓存');
            }
        }

        async get(key) {
            // 1. 先查本地缓存（最快）
            if (this.localCache.has(key)) {
                return this.localCache.get(key);
            }

            // 2. 再查Redis缓存
            if (this.redis) {
                try {
                    const data = await this.redis.get(`dim:${key}`);
                    if (data) {
                        const parsed = JSON.parse(data);
                        // 同步到本地缓存
                        this._addToLocalCache(key, parsed);
                        return parsed;
                    }
                } catch (e) {
                    logger.debug('[内存优化] Redis查询失败:', e.message);
                }
            }

            return null;
        }

        async set(key, value) {
            // 1. 本地缓存
            this._addToLocalCache(key, value);

            // 2. Redis缓存（异步，不阻塞）
            if (this.redis) {
                try {
                    await this.redis.setex(`dim:${key}`, this.REDIS_TTL, JSON.stringify(value));
                } catch (e) {
                    // Redis失败不影响本地缓存
                    logger.debug('[内存优化] Redis缓存失败:', e.message);
                }
            }
        }

        _addToLocalCache(key, value) {
            // 控制本地缓存大小
            if (this.localCache.size >= this.LOCAL_CACHE_SIZE) {
                // LRU: 删除最旧的条目
                const firstKey = this.localCache.keys().next().value;
                this.localCache.delete(firstKey);
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
            logger.warn('确保 album_covers 表或索引存在时出错，将在使用处重试:', e && e.message);
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

            let coversUpsertOk = false;
            if (rows.length > 0) {
                try {
                    const orchestrator = require('../services/orchestrator');
                    const { withTransaction } = require('../services/tx.manager');

                    await orchestrator.withAdmission('album-covers-rebuild', async () => {
                        await withTransaction('main', async () => {
                            await runPreparedBatchWithRetry(runPreparedBatch, 'main', upsertSql, rows, { manageTransaction: false, chunkSize: 800 }, redis);
                        }, { mode: 'IMMEDIATE' });
                    });

                    coversUpsertOk = true;
                } catch (e) {
                    logger.warn('[INDEXING-WORKER] album_covers 重建入库失败（已回退并将直接重试一次）：' + (e && e.message));
                    // 兜底：不再在执行器中开启事务，由我们显式控制一次短事务重试
                    try {
                        const { withTransaction } = require('../services/tx.manager');
                        await withTransaction('main', async () => {
                            await runPreparedBatchWithRetry(runPreparedBatch, 'main', upsertSql, rows, { manageTransaction: false, chunkSize: 800 }, redis);
                        }, { mode: 'IMMEDIATE' });
                        coversUpsertOk = true;
                    } catch (e2) {
                        logger.error('[INDEXING-WORKER] 重建 album_covers 最终失败（已回滚）：' + (e2 && e2.message));
                    }
                }
            } else {
                logger.info('[INDEXING-WORKER] 无需更新 album_covers（无可用媒体或无需变更）。');
            }

            const dtCovers = ((Date.now() - t0) / 1000).toFixed(1);
            if (coversUpsertOk) {
                logger.info(`[INDEXING-WORKER] album_covers 重建完成，用时 ${dtCovers}s，生成 ${coverMap.size} 条。`);
            } else {
                logger.warn('[INDEXING-WORKER] album_covers 重建未完成，已记录失败并回滚。');
            }


        } catch (e) {
            logger.error('[INDEXING-WORKER] 重建 album_covers 失败:', e);
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

            logger.debug(`[内存优化] 定期清理本地缓存: ${localCacheSize} → ${externalCache.localCache.size}/${externalCache.LOCAL_CACHE_SIZE}`);
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
                logger.debug('[内存优化] 缓存存储失败:', e.message)
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

    async function processDimensionsInParallel(items, photosDir) {
        return processConcurrentBatch(items, CONCURRENT_LIMIT, async (item) => {
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

    const tasks = {
        async get_all_media_items() {
            try {
                // 仅返回必要字段，降低消息体体积
                const rows = await dbAll('main', `SELECT path, type FROM items WHERE type IN ('photo','video')`);
                const payload = (rows || []).map(r => ({ path: (r.path || '').replace(/\\/g, '/'), type: r.type }));
                parentPort.postMessage({ type: 'all_media_items_result', payload });
            } catch (e) {
                logger.error('[INDEXING-WORKER] 获取全部媒体列表失败:', e && e.message);
                parentPort.postMessage({ type: 'error', error: e && e.message ? e.message : String(e) });
            }
        },
        async rebuild_index({ photosDir }) {
            logger.info('[INDEXING-WORKER] 开始执行索引重建任务...');
            try {
                const idxRepo = require('../repositories/indexStatus.repo');
                const lastProcessedPath = await idxRepo.getResumeValue('last_processed_path');

                if (lastProcessedPath) {
                    logger.info(`[INDEXING-WORKER] 检测到上次索引断点，将从 ${lastProcessedPath} 继续...`);
                } else {
                    logger.info('[INDEXING-WORKER] 未发现索引断点，将从头开始。');
                    await idxRepo.setIndexStatus('building');
                    await idxRepo.setProcessedFiles(0);
                    await dbRun('main', "DELETE FROM items");
                    await dbRun('main', "DELETE FROM items_fts");
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
                let shouldProcess = !lastProcessedPath;

                for await (const item of walkDirStream(photosDir)) {
                    if (!shouldProcess && item.path === lastProcessedPath) {
                        shouldProcess = true;
                    }
                    if (!shouldProcess) continue;

                    batch.push(item);
                    if (batch.length >= batchSize) {
                        const processedBatch = await processDimensionsInParallel(batch, photosDir);
                        await withTransaction('main', async () => {
                            await tasks.processBatchInTransactionOptimized(processedBatch, itemsStmt, ftsStmt, thumbUpsertStmt);
                        }, { mode: 'IMMEDIATE' });
                        const lastItemInBatch = processedBatch[processedBatch.length - 1];
                        if (lastItemInBatch) {
                            await idxRepo.setResumeValue('last_processed_path', lastItemInBatch.path);
                        }
                        count += batch.length;
                        await idxRepo.setProcessedFiles(count);
                        logger.info(`[INDEXING-WORKER] 已处理 ${count} 个条目...`);

                        // 内存优化：分批清理本地缓存（每处理一批就清理一次）
                        const localCacheSize = externalCache.localCache.size;
                        const batchCleanupCount = Math.floor(localCacheSize * 0.1); // 清理10%的本地缓存
                        if (batchCleanupCount > 0) {
                            const entries = Array.from(externalCache.localCache.entries())
                                .sort((a, b) => a[1].timestamp - b[1].timestamp)
                                .slice(0, batchCleanupCount);

                            entries.forEach(([key]) => externalCache.localCache.delete(key));
                            logger.debug(`[内存优化] 批处理后清理本地缓存: ${batchCleanupCount}个条目，当前大小: ${externalCache.localCache.size}/${externalCache.LOCAL_CACHE_SIZE}`);
                        }

                        batch = [];
                    }
                }
                if (batch.length > 0) {
                    const processedBatch = await processDimensionsInParallel(batch, photosDir);
                    await withTransaction('main', async () => {
                        await tasks.processBatchInTransactionOptimized(processedBatch, itemsStmt, ftsStmt, thumbUpsertStmt);
                    }, { mode: 'IMMEDIATE' });
                    count += batch.length;
                    await idxRepo.setProcessedFiles(count);
                }
                
                await new Promise((resolve, reject) => itemsStmt.finalize(err => err ? reject(err) : resolve()));
                await new Promise((resolve, reject) => ftsStmt.finalize(err => err ? reject(err) : resolve()));
                await new Promise((resolve, reject) => thumbUpsertStmt.finalize(err => err ? reject(err) : resolve()));
                
                await idxRepo.deleteResumeKey('last_processed_path');
                await idxRepo.setIndexStatus('complete');
                await idxRepo.setProcessedFiles(count);

                // 内存优化：索引完成后清理本地缓存（Redis缓存保留）
                const finalCacheSize = externalCache.localCache.size;
                externalCache.clear();
                logger.info(`[内存优化] 索引完成后清理本地缓存: ${finalCacheSize}个条目已清理`);

                logger.info(`[INDEXING-WORKER] 索引重建完成，共处理 ${count} 个条目。`);

                // 重建完成后，顺带重建一次 album_covers（确保首次体验不卡）
                await rebuildAlbumCoversFromItems();
                parentPort.postMessage({ type: 'rebuild_complete', count });
            } catch (error) {
                logger.error('[INDEXING-WORKER] 重建索引失败:', error.message, error.stack);
                parentPort.postMessage({ type: 'error', error: error.message });
            }
        },
        
        async processBatchInTransactionOptimized(processedBatch, itemsStmt, ftsStmt, thumbUpsertStmt) {
            for (const item of processedBatch) {
                // 1) 尝试插入 items（OR IGNORE）
                const insertRes = await new Promise((resolve, reject) => {
                    itemsStmt.run(item.name, item.path, item.type, item.mtime, item.width, item.height, function(err) {
                        if (err) return reject(err);
                        resolve({ lastID: this.lastID, changes: this.changes });
                    });
                });

                // 2) 获取 rowid：若忽略（已存在），查询现有 id
                let rowId = insertRes.lastID;
                if (!rowId) {
                    const existingId = await require('../repositories/items.repo').getIdByPath(item.path);
                    rowId = existingId != null ? existingId : null;
                    if (!rowId) {
                        // 理论上不应发生；安全跳过以防止崩溃
                        continue;
                    }
                }

                // 3) 写入/更新 FTS 令牌（OR REPLACE）
                const baseText = item.path.replace(/\.[^.]+$/, '').replace(/[\/\\]/g, ' ');
                const typeLabel = item.type === 'video' ? ' video' : ' photo';
                const searchableText = baseText + typeLabel;
                const tokenizedName = createNgrams(searchableText, 1, 2);
                await new Promise((resolve, reject) => {
                    ftsStmt.run(rowId, tokenizedName, (err) => {
                         if (err) return reject(err);
                         resolve();
                    });
                });

                // 4) 标记缩略图状态（只在 photo/video 上更新）
                if (item.type === 'photo' || item.type === 'video') {
                    await new Promise((resolve, reject) => {
                        thumbUpsertStmt.run(item.path, item.mtime, (err) => err ? reject(err) : resolve());
                    });
                }
            }
        },

        async process_changes({ changes, photosDir }) {
            if (!changes || changes.length === 0) return;
            logger.info(`[INDEXING-WORKER] 开始处理 ${changes.length} 个索引变更...`);
            const tagsToInvalidate = new Set();
            const affectedAlbums = new Set();
            const videoAdds = [];

            try {
                // 索引期间提升 DB 超时，并标记“索引进行中”，以便其它后台任务让路
                try { adaptDbTimeouts({ busyTimeoutDeltaMs: 20000, queryTimeoutDeltaMs: 15000 }); } catch {}
                try { await redis.set('indexing_in_progress', '1', 'EX', 60); } catch {}

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
                    let parentDir = path.dirname(relativePath);
                    while (parentDir !== '.') {
                        tagsToInvalidate.add(`album:/${parentDir}`);
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
                    const CHUNK = 500;
                    for (let i = 0; i < deletePaths.length; i += CHUNK) {
                        const slice = deletePaths.slice(i, i + CHUNK);
                        const placeholders = slice.map(() => '?').join(',');
                        const likeConditions = slice.map(() => `path LIKE ?`).join(' OR ');
                        const likeParams = slice.map(p => `${p}/%`);
                        await dbRun('main', `DELETE FROM items WHERE path IN (${placeholders}) OR ${likeConditions}`, [...slice, ...likeParams]);
                        // 同步删除 thumb_status 记录
                        await dbRun('main', `DELETE FROM thumb_status WHERE path IN (${placeholders})`, slice).catch(()=>{});
                    }
                }
                
                if (addOperations.length > 0) {
                    const itemsStmt = getDB('main').prepare("INSERT OR IGNORE INTO items (name, path, type, mtime, width, height) VALUES (?, ?, ?, ?, ?, ?)");
                    const ftsStmt = getDB('main').prepare("INSERT INTO items_fts (rowid, name) VALUES (?, ?)");
                    const thumbUpsertStmt = getDB('main').prepare("INSERT INTO thumb_status(path, mtime, status, last_checked) VALUES(?, ?, 'pending', 0) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, status='pending'");
                    const processedAdds = await processDimensionsInParallel(addOperations, photosDir);
                    await tasks.processBatchInTransactionOptimized(processedAdds, itemsStmt, ftsStmt, thumbUpsertStmt);

                    // 通用finalize处理函数
                    const finalizeWithErrorHandling = async (stmt, stmtName) => {
                        try {
                            await new Promise((resolve, reject) => stmt.finalize(err => err ? reject(err) : resolve()));
                        } catch (e) {
                            logger.warn(`Finalizing ${stmtName} failed (ignored):`, e.message);
                        }
                    };

                    // 并行finalize所有语句
                    await Promise.allSettled([
                        finalizeWithErrorHandling(itemsStmt, 'itemsStmt'),
                        finalizeWithErrorHandling(ftsStmt, 'ftsStmt'),
                        finalizeWithErrorHandling(thumbUpsertStmt, 'thumbUpsertStmt')
                    ]);
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
                         WHERE type IN ('photo','video') AND path LIKE ? || '/%'
                         ORDER BY mtime DESC
                         LIMIT 1`,
                        [albumPath]
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
                            await runPreparedBatchWithRetry(runPreparedBatch, 'main', upsertSql, upsertRows, { manageTransaction: false, chunkSize: 800 }, redis);
                        });
                    } catch (err) {
                        if (/no such table: .*album_covers/i.test(err && err.message)) {
                            await ensureAlbumCoversTable();
                            const orchestrator = require('../services/orchestrator');
                            await orchestrator.withAdmission('album-covers-upsert', async () => {
                                await runPreparedBatchWithRetry(runPreparedBatch, 'main', upsertSql, upsertRows, { manageTransaction: false, chunkSize: 800 }, redis);
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
                            await dbRun('main', `DELETE FROM album_covers WHERE album_path IN (${placeholders})`, deleteAlbumPaths).catch(()=>{});
                        }
                    });
                }
                
                }, { mode: 'IMMEDIATE' });

                if (tagsToInvalidate.size > 0) {
                    await invalidateTags(Array.from(tagsToInvalidate));
                }

                logger.info('[INDEXING-WORKER] 索引增量更新完成。');

                const response = { type: 'process_changes_complete', needsMaintenance: true };
                if (videoAdds.length > 0) {
                    response.videoPaths = videoAdds.map(rel => path.join(photosDir, rel));
                }

                parentPort.postMessage(response);
                try { await redis.del('indexing_in_progress'); } catch {}
                try { adaptDbTimeouts({ busyTimeoutDeltaMs: -20000, queryTimeoutDeltaMs: -15000 }); } catch {}
            } catch (error) {
                logger.error('[INDEXING-WORKER] 处理索引变更失败:', error.message, error.stack);

                parentPort.postMessage({ type: 'error', error: error.message });
                try { await redis.del('indexing_in_progress'); } catch {}
                try { adaptDbTimeouts({ busyTimeoutDeltaMs: -20000, queryTimeoutDeltaMs: -15000 }); } catch {}
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
                try { const orchestrator = require('../services/orchestrator'); await orchestrator.gate('index-batch', { checkIntervalMs: 1500 }); } catch {}
                while (true) {
                    const rows = await dbAll('main',
                        `SELECT path, type, mtime
                         FROM items
                         WHERE type IN ('photo','video')
                           AND (width IS NULL OR width <= 0 OR height IS NULL OR height <= 0)
                         LIMIT ?`, [BATCH]
                    );
                    if (!rows || rows.length === 0) break;

                    const enriched = await processDimensionsInParallel(rows, photosDir);
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
                parentPort.postMessage({ type: 'backfill_dimensions_complete', updated: totalUpdated });
            } catch (e) {
                logger.warn(`[INDEXING-WORKER] 尺寸回填失败：${e && e.message}`);
                parentPort.postMessage({ type: 'error', error: e && e.message });
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
                try { const orchestrator = require('../services/orchestrator'); await orchestrator.gate('index-batch', { checkIntervalMs: 1500 }); } catch {}
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
                        } catch (_) {
                            // 文件可能不存在，跳过
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
                try { parentPort.postMessage({ type: 'backfill_mtime_complete', updated: totalUpdated }); } catch {}
            } catch (e) {
                logger.warn(`[INDEXING-WORKER] mtime 回填失败：${e && e.message}`);
            }
        },

        async post_index_backfill(payload) {
            const photosDir = (payload && payload.photosDir) || process.env.PHOTOS_DIR || '/app/photos';
            try {
                if (typeof tasks.backfill_missing_dimensions === 'function') {
                    await tasks.backfill_missing_dimensions({ photosDir, origin: 'post_index_backfill' });
                }
            } catch (e) {
                logger.warn('[INDEXING-WORKER] post_index_backfill 尺寸回填失败（忽略）：', e && e.message);
            }

            try {
                if (typeof tasks.backfill_missing_mtime === 'function') {
                    await tasks.backfill_missing_mtime({ photosDir, origin: 'post_index_backfill' });
                }
            } catch (e) {
                logger.warn('[INDEXING-WORKER] post_index_backfill mtime 回填失败（忽略）：', e && e.message);
            }

            parentPort.postMessage({ type: 'post_index_backfill_complete' });
        },
    };

    let isCriticalTaskRunning = false;

    parentPort.on('message', async (task) => {
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
    });

    // 启动时确保 album_covers 存在，并在为空时后台重建
    (async () => {
        try {
            await ensureAlbumCoversTable();
            const rows = await dbAll('main', `SELECT COUNT(1) AS c FROM album_covers`);
            const count = rows && rows[0] ? Number(rows[0].c) : 0;
            if (count === 0) {
                // 非阻塞后台构建，避免影响主索引任务
                setTimeout(() => {
                    rebuildAlbumCoversFromItems().catch(()=>{});
                }, 1000);
            }
        } catch (e) {
            logger.warn('[INDEXING-WORKER] 启动时检查/重建 album_covers 失败（忽略）：', e && e.message);
        }
    })();
})();