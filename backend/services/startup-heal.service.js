const { promises: fs } = require('fs');
const path = require('path');
const logger = require('../config/logger');
const { formatLog, LOG_PREFIXES } = logger;
const { THUMBS_DIR, DB_FILE, SETTINGS_DB_FILE, PHOTOS_DIR, DATA_DIR } = require('../config');
const { initializeConnections, withTimeout, dbAllOnPath } = require('../db/multi-db');
const { initializeAllDBs, ensureCoreTables } = require('../db/migrations');
const { migrateToMultiDB } = require('../db/migrate-to-multi-db');
const { timeUtils } = require('../utils/time.utils');
const { getCount, getDataIntegrityStats } = require('../repositories/stats.repo');
const { runWhenIdle } = require('./orchestrator');
const { startAdaptiveScheduler } = require('./adaptive.service');
const { setupWorkerListeners, buildSearchIndex, runStartupBackfill } = require('./indexer.service');
const { safeRedisDel } = require('../utils/helpers');
const { redis } = require('../config/redis');

const STARTUP_INDEX_OPTIONS = {
    startDelayMs: Number(process.env.INDEX_START_DELAY_MS || 5000),
    retryIntervalMs: Number(process.env.INDEX_RETRY_INTERVAL_MS || 60000),
    timeoutMs: Number(process.env.INDEX_TIMEOUT_MS || timeUtils.minutes(20)),
    lockTtlSec: Number(process.env.INDEX_LOCK_TTL_SEC || 7200),
};
const DISABLE_STARTUP_INDEX = (process.env.DISABLE_STARTUP_INDEX || 'false').toLowerCase() === 'true';

async function performQuickDirectoryCheck(rootDir, maxDepth = 2) {
    const stack = [{ dir: rootDir, depth: 0 }];
    while (stack.length > 0) {
        const { dir, depth } = stack.pop();
        let entries;
        entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === '.writetest') continue;
            if (entry.isFile()) return false;
            if (entry.isDirectory() && depth < maxDepth) {
                stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
            }
        }
    }
    return true;
}

async function performDatabaseSampleCheck(sampleSize = 50) {
    const { dbAll } = require('../db/multi-db');
    const limit = Math.max(1, Math.min(sampleSize, 100));
    const rows = await dbAll('main', `
        SELECT path FROM thumb_status
        WHERE status='exists'
        ORDER BY rowid DESC
        LIMIT ?
    `, [limit]);
    if (!Array.isArray(rows) || rows.length === 0) {
        return true;
    }
    for (const row of rows) {
        const filePath = row?.path;
        if (!filePath) continue;
        const isVideo = /\.(mp4|webm|mov)$/i.test(filePath);
        const ext = isVideo ? '.jpg' : '.webp';
        const thumbRel = filePath.replace(/\.[^.]+$/, ext);
        const thumbAbs = path.join(THUMBS_DIR, thumbRel);
        try {
            await fs.access(thumbAbs);
            return false;
        } catch { }
    }
    return true;
}

async function isThumbsDirEffectivelyEmpty(rootDir) {
    const isQuickEmpty = await performQuickDirectoryCheck(rootDir, 2).catch((error) => {
        logger.debug(`[Startup] 快速目录检查失败，跳过本轮自愈: ${error && error.message}`);
        return null;
    });
    if (isQuickEmpty === false) return false;
    if (isQuickEmpty === null) return null;

    return await performDatabaseSampleCheck().catch((error) => {
        logger.debug(`[Startup] 缩略图数据库采样检查失败: ${error && error.message}`);
        return null;
    });
}

function shouldSkipStartupIndex() {
    if (!DISABLE_STARTUP_INDEX) return false;
    logger.info('检测到 DISABLE_STARTUP_INDEX=true，跳过启动时索引构建。');
    return true;
}

async function clearIndexingLockFlag() {
    await safeRedisDel(redis, 'indexing_in_progress', '清理索引标记');
    logger.debug('[Startup-Index] 已清理索引进行中旗标');
}

function scheduleIndexRebuild(reasonText) {
    if (shouldSkipStartupIndex()) return;
    return runWhenIdle('startup-rebuild-index', async () => {
        try {
            logger.info('[Startup-Index] 进入空闲窗口回调，准备触发全量索引...');
            await clearIndexingLockFlag();
            await buildSearchIndex();
        } catch (err) {
            logger.debug('runWhenIdle 启动索引失败（忽略）：' + (err && err.message));
        }
    }, {
        startDelayMs: STARTUP_INDEX_OPTIONS.startDelayMs,
        retryIntervalMs: STARTUP_INDEX_OPTIONS.retryIntervalMs,
        timeoutMs: STARTUP_INDEX_OPTIONS.timeoutMs,
        lockTtlSec: STARTUP_INDEX_OPTIONS.lockTtlSec,
        category: 'index-maintenance'
    }).catch((e) => {
        logger.debug('延后安排索引失败（忽略）：' + (e && e.message));
    });
}

async function resetStuckProcessingTasks() {
    const { runAsync } = require('../db/multi-db');
    const result = await runAsync('main', "UPDATE thumb_status SET status='pending' WHERE status='processing'");
    if (result.changes > 0) {
        logger.info(`[Startup] 已重置 ${result.changes} 个卡在 'processing' 状态的缩略图任务。`);
    }
}

async function healThumbnailsIfInconsistent() {
    const dirState = await isThumbsDirEffectivelyEmpty(THUMBS_DIR);
    if (dirState !== true) {
        if (dirState === null) {
            logger.info('缩略图目录检查失败，跳过本轮自愈。');
        }
        return;
    }

    const { runAsync } = require('../db/multi-db');
    const existsCount = await getCount('thumb_status', 'main', "status='exists'");
    if (existsCount > 100) {
        logger.warn('检测到缩略图目录几乎为空，但数据库中存在大量已存在标记，正在自动重置缩略图状态为 pending 以触发自愈重建...');
        await runAsync('main', "UPDATE thumb_status SET status='pending', mtime=0 WHERE status='exists'");
        logger.info('已重置缩略图状态（exists → pending）。后台生成将自动开始补齐缩略图。');
    }
}

async function checkDirectoryWritable(directory) {
    const testFile = path.join(directory, '.writetest');
    await fs.writeFile(testFile, 'test');
    await fs.unlink(testFile);
    logger.info(`目录 ${directory} 写入权限检查通过。`);
}

async function initializeDirectories() {
    logger.info('正在初始化目录结构...');
    await fs.mkdir(DATA_DIR, { recursive: true });
    await Promise.allSettled([
        fs.mkdir(PHOTOS_DIR, { recursive: true }).catch((e) => logger.debug('创建照片目录失败（忽略）:', e && e.message)),
        fs.mkdir(THUMBS_DIR, { recursive: true }).catch((e) => logger.debug('创建缩略图目录失败（忽略）:', e && e.message)),
    ]);
    await checkDirectoryWritable(THUMBS_DIR);
    logger.info('目录结构初始化完成');
}

async function handleDatabaseMigration() {
    logger.info('正在检查数据库迁移需求...');
    let oldDbExists = false;
    try { await fs.access(DB_FILE); oldDbExists = true; } catch { }
    let newDbExists = false;
    try { await fs.access(SETTINGS_DB_FILE); newDbExists = true; } catch { }

    let isMigrationNeeded = false;
    if (oldDbExists && !newDbExists) {
        const tables = await withTimeout(
            dbAllOnPath(DB_FILE, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"),
            10000,
            { sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'" }
        );
        if (tables.length > 0) isMigrationNeeded = true;
    }

    if (isMigrationNeeded) {
        logger.info('检测到包含数据的旧版数据库 gallery.db，将执行一次性迁移...');
        await migrateToMultiDB();
    } else if (oldDbExists && !newDbExists) {
        logger.info('检测到空的或无效的旧版数据库文件 gallery.db，将忽略并进行全新初始化。');
    } else {
        logger.info('数据库结构已是多库架构，无需迁移。');
    }
}

async function initializeDatabase() {
    logger.info('正在初始化数据库...');
    await initializeConnections();
    await initializeAllDBs();
    await ensureCoreTables();
    logger.info('数据库初始化完成');
}

async function startServices() {
    logger.info('正在启动后台服务...');
    await Promise.allSettled([
        (async () => { try { startAdaptiveScheduler(); } catch (e) { logger.debug('启动自适应调度器失败（忽略）:', e && e.message); } })(),
        (async () => { try { require('./orchestrator').start(); } catch (e) { logger.debug('启动编排器失败（忽略）:', e && e.message); } })(),
        (async () => { try { logger.info(`Redis 可用性: ${require('../config/redis').getAvailability()}`); } catch (e) { logger.warn('Redis 可用性检查失败，已使用降级配置继续启动。', e && e.message ? { error: e.message } : undefined); } })(),
        (async () => { try { await require('./manualSyncScheduler.service').initialize(); } catch (e) { logger.debug('启动手动同步调度器失败（忽略）:', e && e.message); } })(),
    ]);
    try { setupWorkerListeners(); } catch (error) { logger.debug('初始化索引/视频工作线程监听失败（忽略）：', error && error.message); }
}

async function setupIndexingAndMonitoring() {
    logger.info('正在设置索引监控...');
    try {
        const idxRepo = require('../repositories/indexStatus.repo');
        const itemCountResult = await getCount('items', 'main');
        const itemCount = itemCountResult || 0;
        let hasResumePoint = false;

        try {
            const status = await idxRepo.getIndexStatus();
            const resumeValue = await idxRepo.getResumeValue('last_processed_path');
            hasResumePoint = (status === 'building') || !!resumeValue;
        } catch (e) {
            logger.debug('检查索引状态失败（忽略）:', e && e.message);
        }

        if (itemCount === 0 || hasResumePoint) {
            logger.info(itemCount === 0 ? '数据库为空，开始构建搜索索引...' : '检测到未完成的索引任务，准备续跑构建搜索索引...');
            if (hasResumePoint) {
                try { await idxRepo.setIndexStatus('pending'); } catch (e) { logger.debug('重置索引状态失败（忽略）:', e && e.message); }
                try { await idxRepo.deleteResumeKey('last_processed_path'); } catch (e) { logger.debug('删除索引断点失败（忽略）:', e && e.message); }
            }
            try { await clearIndexingLockFlag(); } catch (e) { logger.debug('索引自愈过程失败（忽略）:', e && e.message); }

            if (itemCount === 0) {
                logger.info('检测到冷启动（items=0）：跳过 runWhenIdle，立即触发全量索引。');
                try {
                    const { scanAndDelete } = require('../middleware/cache');
                    const cleared = await scanAndDelete('route_cache:*browse*');
                    if (cleared > 0) logger.info(`冷启动：已清除 ${cleared} 条 browse 路由缓存`);
                } catch (e) {
                    logger.debug('冷启动清除 browse 缓存失败（忽略）:', e && e.message);
                }
                setTimeout(() => {
                    try { buildSearchIndex().catch((e) => logger.debug('冷启动索引构建失败（忽略）:', e && e.message)); } catch (e) {
                        logger.debug('冷启动索引构建异常（忽略）:', e && e.message);
                    }
                }, 1000);
            } else {
                scheduleIndexRebuild();
            }
        } else {
            logger.info(`索引已存在，跳过全量构建。当前索引包含 ${itemCount} 个条目。`);
        }

        try {
            runWhenIdle(LOG_PREFIXES.STARTUP_BACKFILL, async () => {
                const integrityStats = await getDataIntegrityStats();
                const needM = integrityStats.missingMtime > 0;
                const needD = integrityStats.missingDimensions > 0;
                if (!needM && !needD) return;
                await runStartupBackfill({ requireMtime: needM, requireDimensions: needD });
            }, { startDelayMs: 8000, retryIntervalMs: 30000, timeoutMs: 20 * 60 * 1000, lockTtlSec: 7200, category: 'index-maintenance' });
        } catch (e) {
            logger.debug(formatLog(LOG_PREFIXES.SERVER, `启动期回填装载失败（忽略）：${e && e.message}`));
        }
    } catch (dbError) {
        logger.debug('检查索引状态失败（降噪）：', dbError && dbError.message);
        logger.info('由于检查失败，开始构建搜索索引...');
        scheduleIndexRebuild();
    }
}

module.exports = {
    initializeDirectories,
    handleDatabaseMigration,
    initializeDatabase,
    resetStuckProcessingTasks,
    healThumbnailsIfInconsistent,
    startServices,
    setupIndexingAndMonitoring,
    clearIndexingLockFlag,
};
