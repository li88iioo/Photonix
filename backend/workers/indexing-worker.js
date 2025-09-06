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
  const conc = Number(process.env.SHARP_CONCURRENCY || 1);
  if (conc > 0) sharp.concurrency(conc);
} catch {}
const { initializeConnections, getDB, dbRun, dbGet, runPreparedBatch, adaptDbTimeouts } = require('../db/multi-db');
const { redis } = require('../config/redis');
const { runPreparedBatchWithRetry } = require('../db/sqlite-retry');
const { createNgrams } = require('../utils/search.utils');
const { getVideoDimensions } = require('../utils/media.utils.js');
const { invalidateTags } = require('../services/cache.service.js');

(async () => {
    await initializeConnections();
    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'debug',
        format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] [INDEXING-WORKER] ${info.level}: ${info.message}`)),
        transports: [new winston.transports.Console()]
    });
    const { dbAll } = require('../db/multi-db');
    const { promises: fs } = require('fs');
    
    const CONCURRENT_LIMIT = 50;
    const DIMENSION_CACHE = new Map();
    const CACHE_TTL = 1000 * 60 * 10;

    try {
        await dbRun('index', `CREATE TABLE IF NOT EXISTS index_progress (key TEXT PRIMARY KEY, value TEXT);`);
    } catch (e) {
        logger.error('创建 index_progress 表失败:', e);
    }

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
        logger.info('[INDEXING-WORKER] 开始重建 album_covers（基于 items 表）...');
        const t0 = Date.now();
        try {
            await ensureAlbumCoversTable();

            const albumRows = await dbAll('main', `SELECT path FROM items WHERE type='album'`);
            const albumSet = new Set(albumRows.map(r => (r.path || '').replace(/\\/g, '/')));
            if (albumSet.size === 0) {
                logger.info('[INDEXING-WORKER] 无相册条目，跳过封面重建。');
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

            // 批量写入（UPSERT）— 统一使用通用 Prepared 批处理
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
            await runPreparedBatchWithRetry(runPreparedBatch, 'main', upsertSql, rows, { chunkSize: 800 }, redis);

            const dt = ((Date.now() - t0) / 1000).toFixed(1);
            logger.info(`[INDEXING-WORKER] album_covers 重建完成，用时 ${dt}s，生成 ${coverMap.size} 条。`);
        } catch (e) {
            logger.error('[INDEXING-WORKER] 重建 album_covers 失败:', e);
        }
    }
    
    const cacheCleanupInterval = setInterval(() => {
        const now = Date.now();
        DIMENSION_CACHE.forEach((value, key) => {
            if (now - value.timestamp > CACHE_TTL) {
                DIMENSION_CACHE.delete(key);
            }
        });
    }, CACHE_TTL);

    process.on('exit', () => clearInterval(cacheCleanupInterval));

    async function getMediaDimensions(filePath, type, mtime) {
        const cacheKey = `${filePath}:${mtime}`;
        const cached = DIMENSION_CACHE.get(cacheKey);
        if (cached) return cached.dimensions;
        try {
            let dimensions = type === 'video'
                ? await getVideoDimensions(filePath)
                : await sharp(filePath).metadata().then(m => ({ width: m.width, height: m.height }));
            DIMENSION_CACHE.set(cacheKey, { dimensions, timestamp: Date.now() });
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
                    if (entry.name.startsWith('temp_opt_') || entry.name.includes('.tmp')) continue;
                    
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
                const resumeRow = await dbGet('index', "SELECT value FROM index_progress WHERE key = 'last_processed_path'");
                const lastProcessedPath = resumeRow ? resumeRow.value : null;

                if (lastProcessedPath) {
                    logger.info(`[INDEXING-WORKER] 检测到上次索引断点，将从 ${lastProcessedPath} 继续...`);
                } else {
                    logger.info('[INDEXING-WORKER] 未发现索引断点，将从头开始。');
                    await dbRun('index', "DELETE FROM index_status");
                    await dbRun('index', "INSERT INTO index_status (id, status, processed_files) VALUES (1, 'building', 0)");
                    await dbRun('main', "DELETE FROM items");
                    await dbRun('main', "DELETE FROM items_fts");
                }

                const statusRow = await dbGet('index', "SELECT processed_files FROM index_status WHERE id = 1");
                let count = statusRow ? statusRow.processed_files : 0;
                const batchSize = 1000;
                
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
                        await dbRun('main', 'BEGIN IMMEDIATE');
                        try {
                            await tasks.processBatchInTransactionOptimized(processedBatch, itemsStmt, ftsStmt, thumbUpsertStmt);
                            await dbRun('main', 'COMMIT');
                            const lastItemInBatch = processedBatch[processedBatch.length - 1];
                            if (lastItemInBatch) {
                                await dbRun('index', "INSERT OR REPLACE INTO index_progress (key, value) VALUES ('last_processed_path', ?)", [lastItemInBatch.path]);
                            }
                        } catch (e) {
                            await dbRun('main', 'ROLLBACK').catch(()=>{});
                            throw e;
                        }
                        count += batch.length;
                        await dbRun('index', "UPDATE index_status SET processed_files = ? WHERE id = 1", [count]);
                        logger.info(`[INDEXING-WORKER] 已处理 ${count} 个条目...`);
                        batch = [];
                    }
                }
                if (batch.length > 0) {
                    const processedBatch = await processDimensionsInParallel(batch, photosDir);
                    await dbRun('main', 'BEGIN IMMEDIATE');
                    try {
                        await tasks.processBatchInTransactionOptimized(processedBatch, itemsStmt, ftsStmt, thumbUpsertStmt);
                        await dbRun('main', 'COMMIT');
                    } catch (e) {
                        await dbRun('main', 'ROLLBACK').catch(()=>{});
                        throw e;
                    }
                    count += batch.length;
                    await dbRun('index', "UPDATE index_status SET processed_files = ? WHERE id = 1", [count]);
                }
                
                await new Promise((resolve, reject) => itemsStmt.finalize(err => err ? reject(err) : resolve()));
                await new Promise((resolve, reject) => ftsStmt.finalize(err => err ? reject(err) : resolve()));
                await new Promise((resolve, reject) => thumbUpsertStmt.finalize(err => err ? reject(err) : resolve()));
                
                await dbRun('index', "DELETE FROM index_progress WHERE key = 'last_processed_path'");
                await dbRun('index', "UPDATE index_status SET status = 'complete', processed_files = ? WHERE id = 1", [count]);

                logger.info(`[INDEXING-WORKER] 索引重建完成，共处理 ${count} 个条目。`);

                // 重建完成后，顺带重建一次 album_covers（确保首次体验不卡）
                await rebuildAlbumCoversFromItems();
                parentPort.postMessage({ type: 'rebuild_complete', count });
            } catch (error) {
                logger.error('[INDEXING-WORKER] 重建索引失败:', error.message, error.stack);
                await dbRun('main', 'ROLLBACK').catch(()=>{});
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
                    const existing = await dbGet('main', 'SELECT id FROM items WHERE path = ?', [item.path]).catch(() => null);
                    rowId = existing && existing.id ? existing.id : null;
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

            try {
                // 索引期间提升 DB 超时，并标记“索引进行中”，以便其它后台任务让路
                try { adaptDbTimeouts({ busyTimeoutDeltaMs: 20000, queryTimeoutDeltaMs: 15000 }); } catch {}
                try { await redis.set('indexing_in_progress', '1', 'EX', 60); } catch {}

                await dbRun('main', "BEGIN IMMEDIATE");
                
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
                    try { await new Promise((resolve, reject) => itemsStmt.finalize(err => err ? reject(err) : resolve())); } catch (e) { logger.warn('Finalizing itemsStmt failed (ignored):', e.message); }
                    try { await new Promise((resolve, reject) => ftsStmt.finalize(err => err ? reject(err) : resolve())); } catch (e) { logger.warn('Finalizing ftsStmt failed (ignored):', e.message); }
                    try { await new Promise((resolve, reject) => thumbUpsertStmt.finalize(err => err ? reject(err) : resolve())); } catch (e) { logger.warn('Finalizing thumbUpsertStmt failed (ignored):', e.message); }
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
                        await runPreparedBatchWithRetry(runPreparedBatch, 'main', upsertSql, upsertRows, { manageTransaction: false, chunkSize: 800 }, redis);
                    } catch (err) {
                        if (/no such table: .*album_covers/i.test(err && err.message)) {
                            await ensureAlbumCoversTable();
                            await runPreparedBatchWithRetry(runPreparedBatch, 'main', upsertSql, upsertRows, { manageTransaction: false, chunkSize: 800 }, redis);
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
                
                await dbRun('main', "COMMIT");

                if (tagsToInvalidate.size > 0) {
                    await invalidateTags(Array.from(tagsToInvalidate));
                }

                logger.info('[INDEXING-WORKER] 索引增量更新完成。');
                parentPort.postMessage({ type: 'process_changes_complete' });
                try { await redis.del('indexing_in_progress'); } catch {}
                try { adaptDbTimeouts({ busyTimeoutDeltaMs: -20000, queryTimeoutDeltaMs: -15000 }); } catch {}
            } catch (error) {
                logger.error('[INDEXING-WORKER] 处理索引变更失败:', error.message, error.stack);
                await dbRun('main', "ROLLBACK").catch(rbError => logger.error('[INDEXING-WORKER] 变更处理事务回滚失败:', rbError.message));
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
                logger.info(`[INDEXING-WORKER] 尺寸回填完成，更新 ${totalUpdated} 条记录。`);
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
                logger.info(`[INDEXING-WORKER] mtime 回填完成，更新 ${totalUpdated} 条记录。`);
            } catch (e) {
                logger.warn(`[INDEXING-WORKER] mtime 回填失败：${e && e.message}`);
            }
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