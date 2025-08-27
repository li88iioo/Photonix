/**
 * 维护脚本（维护中心）
 * - 数据库空间整理（VACUUM）
 * - NFS 模式下的目录级对账（可选）
 * - 缩略图存在性低频对账（批量）
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { 
    DB_FILE, 
    SETTINGS_DB_FILE, 
    HISTORY_DB_FILE, 
    INDEX_DB_FILE 
} = require('../config');
const { cleanupHlsRecords } = require('../utils/hls.utils');
const logger = require('../config/logger');
const { Queue } = require('bullmq');
const { bullConnection } = require('../config/redis');
const { QUEUE_MODE, THUMBS_DIR, PHOTOS_DIR, THUMBNAIL_QUEUE_NAME, VIDEO_QUEUE_NAME } = require('../config');

/**
 * 执行数据库维护
 * 对所有数据库文件执行 VACUUM 命令以回收空间
 */
async function performDatabaseMaintenance() {
    const databases = [
        { name: '主数据库', path: DB_FILE },
        { name: '设置数据库', path: SETTINGS_DB_FILE },
        { name: '历史记录数据库', path: HISTORY_DB_FILE },
        { name: '索引数据库', path: INDEX_DB_FILE }
    ];

    logger.info('开始执行数据库维护任务...');

    for (const db of databases) {
        try {
            // 检查数据库文件是否存在
            if (!fs.existsSync(db.path)) {
                logger.info(`${db.name} 文件不存在，跳过维护: ${db.path}`);
                continue;
            }

            // 获取维护前的文件大小
            const statsBefore = fs.statSync(db.path);
            const sizeBeforeMB = (statsBefore.size / (1024 * 1024)).toFixed(2);

            logger.info(`开始维护 ${db.name} (${sizeBeforeMB}MB)...`);

            // 执行 VACUUM 命令
            await new Promise((resolve, reject) => {
                const database = new sqlite3.Database(db.path, (err) => {
                    if (err) {
                        logger.error(`无法打开 ${db.name}: ${err.message}`);
                        reject(err);
                        return;
                    }

                    // 执行 VACUUM 命令
                    database.run('VACUUM;', (err) => {
                        if (err) {
                            logger.error(`VACUUM 命令执行失败 (${db.name}): ${err.message}`);
                            reject(err);
                        } else {
                            logger.info(`${db.name} VACUUM 命令执行成功`);
                        }
                        
                        // 关闭数据库连接
                        database.close((closeErr) => {
                            if (closeErr) {
                                logger.warn(`关闭 ${db.name} 连接时出错: ${closeErr.message}`);
                            }
                            resolve();
                        });
                    });
                });
            });

            // 获取维护后的文件大小
            const statsAfter = fs.statSync(db.path);
            const sizeAfterMB = (statsAfter.size / (1024 * 1024)).toFixed(2);
            const savedMB = (statsBefore.size - statsAfter.size) / (1024 * 1024);

            if (savedMB > 0) {
                logger.info(`${db.name} 维护完成，释放了 ${savedMB.toFixed(2)}MB 空间 (${sizeBeforeMB}MB -> ${sizeAfterMB}MB)`);
            } else {
                logger.info(`${db.name} 维护完成，文件大小无变化 (${sizeAfterMB}MB)`);
            }

        } catch (error) {
            logger.error(`维护 ${db.name} 时出错: ${error.message}`);
        }
    }

    logger.info('数据库维护任务完成');
}

/**
 * 目录级对账（用于 NFS 模式）：仅比较目录结构，派发 addDir/unlinkDir
 */
async function reconcileDirectories() {
    try {
        const { PHOTOS_DIR } = require('../config');
        const { dbAll } = require('../db/multi-db');
        const chokidarMode = (process.env.FS_MODE || 'auto').toLowerCase();
        if (chokidarMode !== 'nfs' && chokidarMode !== 'auto') {
            logger.info('FS_MODE 非 nfs/auto，跳过目录对账');
            return;
        }

        const fs = require('fs');
        const path = require('path');
        const stack = [PHOTOS_DIR];
        const fsDirs = new Set();
        while (stack.length) {
            const cur = stack.pop();
            let entries = [];
            try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
            for (const e of entries) {
                if (!e.isDirectory()) continue;
                if (e.name === '@eaDir') continue;
                const full = path.join(cur, e.name);
                const rel = full.substring(PHOTOS_DIR.length).replace(/\\/g,'/').replace(/^\/+/, '');
                fsDirs.add(rel);
                stack.push(full);
            }
        }

        const dbDirsRows = await dbAll('main', `SELECT path FROM items WHERE type='album'`);
        const dbDirs = new Set((dbDirsRows||[]).map(r => String(r.path||'').replace(/\\/g,'/')));

        const adds = [];
        const dels = [];
        for (const d of fsDirs) if (d && !dbDirs.has(d)) adds.push(d);
        for (const d of dbDirs) if (d && !fsDirs.has(d)) dels.push(d);

        if (adds.length === 0 && dels.length === 0) {
            logger.info('目录对账：无差异');
            return;
        }

        const { getIndexingWorker } = require('../services/worker.manager');
        const worker = getIndexingWorker();
        for (const d of adds) worker.postMessage({ type: 'process_changes', payload: { changes: [{ type: 'addDir', filePath: require('path').join(PHOTOS_DIR, d) }], photosDir: PHOTOS_DIR } });
        for (const d of dels) worker.postMessage({ type: 'process_changes', payload: { changes: [{ type: 'unlinkDir', filePath: require('path').join(PHOTOS_DIR, d) }], photosDir: PHOTOS_DIR } });
        logger.info(`目录对账：+${adds.length} -${dels.length} 已派发`);
    } catch (e) {
        logger.warn('目录对账失败（忽略）：', e && e.message);
    }
}

/**
 * 缩略图存在性对账（低频批量）
 */
async function reconcileThumbnails() {
    try {
        const { dbAll, runAsync, hasColumn } = require('../db/multi-db');
        const { THUMBS_DIR } = require('../config');
        const { promises: fsp } = require('fs');
        const path = require('path');
        const BATCH = Number(process.env.THUMB_RECONCILE_BATCH_SIZE || 1000);
        const hasLastChecked = await hasColumn('main', 'thumb_status', 'last_checked').catch(() => false);
        const sql = hasLastChecked
            ? `SELECT path, last_checked FROM thumb_status WHERE status='exists' ORDER BY last_checked ASC LIMIT ?`
            : `SELECT path, 0 as last_checked FROM thumb_status WHERE status='exists' LIMIT ?`;
        const rows = await dbAll('main', sql, [BATCH]);
        if (!rows || rows.length === 0) { logger.info('缩略图对账：无数据'); return; }
        let changed = 0;
        for (const r of rows) {
            const isVideo = /\.(mp4|webm|mov)$/i.test(r.path || '');
            const ext = isVideo ? '.jpg' : '.webp';
            const rel = (r.path || '').replace(/\.[^.]+$/, ext);
            const abs = path.join(THUMBS_DIR, rel);
            try {
                await fsp.access(abs);
                if (hasLastChecked) await runAsync('main', `UPDATE thumb_status SET last_checked=strftime('%s','now')*1000 WHERE path=?`, [r.path]);
            } catch {
                if (hasLastChecked) await runAsync('main', `UPDATE thumb_status SET status='pending', mtime=0, last_checked=strftime('%s','now')*1000 WHERE path=?`, [r.path]);
                else await runAsync('main', `UPDATE thumb_status SET status='pending', mtime=0 WHERE path=?`, [r.path]);
                changed++;
            }
        }
        if (changed > 0) logger.info(`缩略图对账完成：重置 ${changed} 条为 pending`);
    } catch (e) {
        logger.warn('缩略图对账失败（忽略）：', e && e.message);
    }
}

/**
 * 将缺失/待处理的缩略图入队（QUEUE_MODE 下）
 */
async function enqueuePendingThumbnails(limit = 5000) {
    if (!QUEUE_MODE) { logger.info('[enqueue-thumbs] 非队列模式，跳过'); return; }
    try {
        const { dbAll } = require('../db/multi-db');
        const rows = await dbAll('main',
            `SELECT i.path, i.type
             FROM items i
             LEFT JOIN thumb_status t ON t.path = i.path
             WHERE i.type IN ('photo','video')
               AND (t.status IS NULL OR t.status IN ('pending','failed') OR t.mtime < i.mtime)
             LIMIT ?`, [Number(limit) || 5000]
        );
        if (!rows || rows.length === 0) { logger.info('[enqueue-thumbs] 未发现待入队的缩略图任务'); return; }
        const queue = new Queue(THUMBNAIL_QUEUE_NAME, { connection: bullConnection });
        let ok = 0; let fail = 0;
        for (const r of rows) {
            const isVideo = /\.(mp4|webm|mov)$/i.test(r.path || '');
            try {
                await queue.add('thumb', { filePath: path.join(PHOTOS_DIR, r.path), relativePath: r.path, type: isVideo ? 'video' : 'photo' }, {
                    attempts: 3, removeOnComplete: 2000, removeOnFail: 500, priority: 5
                });
                ok++;
            } catch (e) {
                fail++;
            }
        }
        logger.info(`[enqueue-thumbs] 入队完成：success=${ok} fail=${fail}`);
    } catch (e) {
        logger.error('[enqueue-thumbs] 入队失败：', e);
    }
}

/**
 * 将缺失 HLS 的视频入队（QUEUE_MODE 下）
 */
async function enqueueMissingHls(limit = 3000) {
    if (!QUEUE_MODE) { logger.info('[enqueue-hls] 非队列模式，跳过'); return; }
    try {
        const { dbAll } = require('../db/multi-db');
        const { promises: fsp } = require('fs');
        const videos = await dbAll('main', `SELECT path FROM items WHERE type='video' LIMIT ?`, [Number(limit) || 3000]);
        if (!videos || videos.length === 0) { logger.info('[enqueue-hls] 未发现视频'); return; }
        const queue = new Queue(VIDEO_QUEUE_NAME, { connection: bullConnection });
        let ok = 0; let skip = 0; let fail = 0;
        for (const v of videos) {
            try {
                const master = path.join(THUMBS_DIR, 'hls', v.path, 'master.m3u8');
                try { await fsp.access(master); skip++; continue; } catch {}
                await queue.add('video', { relativePath: v.path }, { attempts: 2, removeOnComplete: 2000, removeOnFail: 500, priority: 3 });
                ok++;
            } catch (e) { fail++; }
        }
        logger.info(`[enqueue-hls] 入队完成：success=${ok} skip=${skip} fail=${fail}`);
    } catch (e) {
        logger.error('[enqueue-hls] 入队失败：', e);
    }
}

/**
 * 主函数
 */
async function main() {
    try {
        // 解析命令行
        const args = process.argv.slice(2);
        const shouldCleanLegacy = args.includes('--clean-legacy-after-migration');
        const doDirRecon = args.includes('--reconcile-dirs') || (process.env.ENABLE_NFS_SYNC || 'false').toLowerCase() === 'true';
        const doThumbRecon = args.includes('--reconcile-thumbs') || (process.env.ENABLE_THUMB_RECON || 'true').toLowerCase() === 'true';
        const doEnqueueThumbs = args.includes('--enqueue-thumbs');
        const doEnqueueHls = args.includes('--enqueue-hls');

        if (shouldCleanLegacy) {
            await cleanLegacyTablesIfMigrated();
        }

        await performDatabaseMaintenance();
        if (doDirRecon) await reconcileDirectories();
        if (doThumbRecon) await reconcileThumbnails();
        if (doEnqueueThumbs) await enqueuePendingThumbnails(Number(process.env.ENQUEUE_THUMBS_LIMIT || 5000));
        if (doEnqueueHls) await enqueueMissingHls(Number(process.env.ENQUEUE_HLS_LIMIT || 3000));
        process.exit(0);
    } catch (error) {
        logger.error('数据库维护失败:', error.message);
        process.exit(1);
    }
}

// 如果直接运行此脚本
if (require.main === module) {
    main();
}

module.exports = {
    performDatabaseMaintenance,
    reconcileDirectories,
    reconcileThumbnails
}; 

/**
 * 安全清理：在确认 settings/history 已迁移到对应独立库后，清理主库中的遗留旧表
 * - 仅当两个外部库都存在目标数据且主库存在对应旧表时执行
 * - 清理前先创建备份（copy 文件）
 */
async function cleanLegacyTablesIfMigrated() {
    logger.info('开始检测并清理主库遗留旧表（如已迁移至多库）...');
    if (!fs.existsSync(DB_FILE)) {
        logger.info('主库文件不存在，跳过清理');
        return;
    }

    const backupPath = DB_FILE.replace(/\.db$/i, `_legacy_backup_${new Date().toISOString().replace(/[:.]/g,'-')}.db`);
    try {
        fs.copyFileSync(DB_FILE, backupPath);
        logger.info(`已备份主库至: ${backupPath}`);
    } catch (e) {
        logger.error(`备份主库失败，放弃清理: ${e.message}`);
        return;
    }

    // 打开三个库进行检查
    const mainDb = new sqlite3.Database(DB_FILE);
    const settingsDb = fs.existsSync(SETTINGS_DB_FILE) ? new sqlite3.Database(SETTINGS_DB_FILE) : null;
    const historyDb = fs.existsSync(HISTORY_DB_FILE) ? new sqlite3.Database(HISTORY_DB_FILE) : null;

    function all(db, sql, params = []) { return new Promise((resolve,reject)=> db.all(sql, params, (e,rows)=> e?reject(e):resolve(rows))); }
    function run(db, sql, params = []) { return new Promise((resolve,reject)=> db.run(sql, params, function(e){ e?reject(e):resolve(this); })); }

    try {
        // 仅当外部分库存在且有数据时，才认为迁移完成
        let settingsCount = 0, historyCount = 0;
        if (settingsDb) {
            try { const r = await all(settingsDb, 'SELECT COUNT(1) as c FROM settings'); settingsCount = r?.[0]?.c || 0; } catch {}
        }
        if (historyDb) {
            try { const r = await all(historyDb, 'SELECT COUNT(1) as c FROM view_history'); historyCount = r?.[0]?.c || 0; } catch {}
        }

        // 主库存在的疑似旧表
        const legacyCandidates = ['settings', 'view_history'];
        const legacyInMain = await all(mainDb, `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${legacyCandidates.map(()=>'?').join(',')})`, legacyCandidates);
        const legacyNames = legacyInMain.map(r => r.name);

        if ((settingsCount > 0 || historyCount > 0) && legacyNames.length > 0) {
            logger.warn(`检测到主库遗留旧表: ${legacyNames.join(', ')}。将开始安全清理（已备份）...`);
            await run(mainDb, 'BEGIN');
            for (const tbl of legacyNames) {
                await run(mainDb, `DROP TABLE IF EXISTS ${tbl}`);
            }
            await run(mainDb, 'COMMIT');
            logger.info('主库遗留旧表清理完成');
        } else {
            logger.info('未发现需要清理的主库旧表，或分库数据尚未准备就绪。');
        }
    } catch (e) {
        try { await run(mainDb, 'ROLLBACK'); } catch {}
        logger.error(`清理旧表失败: ${e.message}，主库已保留备份: ${backupPath}`);
    } finally {
        try { mainDb.close(); } catch {}
        try { settingsDb && settingsDb.close(); } catch {}
        try { historyDb && historyDb.close(); } catch {}
    }
}

// 添加HLS记录清理任务
async function cleanupHlsRecordsTask() {
    try {
        logger.info('开始清理过期的HLS处理记录...');
        await cleanupHlsRecords(30); // 保留30天
        logger.info('HLS处理记录清理完成');
    } catch (error) {
        logger.error('清理HLS处理记录失败:', error);
    }
}

// 导出清理任务
module.exports = {
    cleanupHlsRecordsTask
};