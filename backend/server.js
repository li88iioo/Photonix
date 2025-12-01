/**
 * 后端服务器主入口文件
 *
 * 主要职责：
 * - 启动与初始化服务器
 * - 管理数据库连接
 * - 创建并管理工作线程池
 * - 检查文件系统权限
 * - 实现优雅关闭处理
 * - 统一错误处理与日志记录
 *
 * @module server
 * @author Photonix
 * @version 1.0.0
 */

const app = require('./app');
const { promises: fs } = require('fs');
const path = require('path');
const baseLogger = require('./config/logger');
const { formatLog, LOG_PREFIXES } = baseLogger;
const logger = baseLogger;
const { validateCriticalConfig } = require('./config/validator');
const { handleUncaughtException, handleUnhandledRejection } = require('./middleware/errorHandler');
// 延后加载 Redis，避免无 Redis 环境下启动即触发连接
const { PORT, THUMBS_DIR, DB_FILE, SETTINGS_DB_FILE, PHOTOS_DIR, DATA_DIR } = require('./config');
const { initializeConnections, closeAllConnections, withTimeout, dbAllOnPath } = require('./db/multi-db');
const { initializeAllDBs } = require('./db/migrations');
const { migrateToMultiDB } = require('./db/migrate-to-multi-db');
const { startAdaptiveScheduler } = require('./services/adaptive.service');
const { setupWorkerListeners } = require('./services/indexer.service');
const { timeUtils, TIME_CONSTANTS } = require('./utils/time.utils');
const { getCount, getThumbProcessingStats, getDataIntegrityStats } = require('./repositories/stats.repo');

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
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error) {
            // 如果目录不存在或无法访问，交给上层判断
            throw error;
        }
        for (const entry of entries) {
            if (entry.name === '.writetest') continue;
            if (entry.isFile()) {
                return false; // 发现真实文件，目录非空
            }
            if (entry.isDirectory() && depth < maxDepth) {
                stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
            }
        }
    }
    return true;
}

async function performDatabaseSampleCheck(sampleSize = 50) {
    const { dbAll } = require('./db/multi-db');
    const limit = Math.max(1, Math.min(sampleSize, 100));
    try {
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
            if (!filePath) {
                continue;
            }
            const isVideo = /\.(mp4|webm|mov)$/i.test(filePath);
            const ext = isVideo ? '.jpg' : '.webp';
            const thumbRel = filePath.replace(/\.[^.]+$/, ext);
            const thumbAbs = path.join(THUMBS_DIR, thumbRel);
            try {
                await fs.access(thumbAbs);
                return false; // 找到至少一个真实文件，说明目录非空
            } catch (err) {
                if (err.code && err.code !== 'ENOENT') {
                    logger.debug(`[Startup] 检查缩略图样本失败: ${thumbAbs} -> ${err.message}`);
                }
            }
        }
        return true;
    } catch (error) {
        const message = error?.message || '';
        if (/no such table/i.test(message)) {
            logger.debug('[Startup] thumb_status 表不存在，跳过缩略图采样检查');
            return true;
        }
        if (/no such column: rowid/i.test(message)) {
            try {
                const rows = await dbAll('main', `
                    SELECT path FROM thumb_status
                    WHERE status='exists'
                    ORDER BY mtime DESC
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
            } catch (fallbackError) {
                logger.debug(`[Startup] 缩略图采样回退失败: ${fallbackError && fallbackError.message}`);
            }
        }
        throw error;
    }
}

async function isThumbsDirEffectivelyEmpty(rootDir) {
    try {
        const isQuickEmpty = await performQuickDirectoryCheck(rootDir, 2);
        if (!isQuickEmpty) {
            return false;
        }
    } catch (error) {
        logger.debug(`[Startup] 快速目录检查失败，跳过本轮自愈: ${error && error.message}`);
        return null;
    }

    try {
        return await performDatabaseSampleCheck();
    } catch (error) {
        logger.debug(`[Startup] 缩略图数据库采样检查失败: ${error && error.message}`);
        return null;
    }
}

function shouldSkipStartupIndex() {
    if (!DISABLE_STARTUP_INDEX) {
        return false;
    }
    logger.info('检测到 DISABLE_STARTUP_INDEX=true，跳过启动时索引构建。');
    return true;
}

async function clearIndexingLockFlag() {
    try {
        const { redis } = require('./config/redis');
        const { safeRedisDel } = require('./utils/helpers');
        await safeRedisDel(redis, 'indexing_in_progress', '清理索引标记');
        logger.debug('[Startup-Index] 已清理索引进行中旗标');
    } catch (e) {
        logger.debug('[Startup-Index] 清理索引旗标失败：' + (e && e.message));
    }
}

function scheduleIndexRebuild(reasonText) {
    if (shouldSkipStartupIndex()) {
        return;
    }

    try {
        const { runWhenIdle } = require('./services/orchestrator');
        logger.info(reasonText || '计划在空闲窗口重建索引（runWhenIdle）。');
        return runWhenIdle('startup-rebuild-index', async () => {
            try {
                logger.info('[Startup-Index] 进入空闲窗口回调，准备触发全量索引...');
                await clearIndexingLockFlag();
                const { buildSearchIndex } = require('./services/indexer.service');
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
        });
    } catch (e) {
        logger.debug('延后安排索引失败（忽略）：' + (e && e.message));
    }
}


/**
 * 重置卡在'processing'状态的缩略图记录
 * 这种情况通常发生在服务器异常退出时
 */
async function resetStuckProcessingTasks() {
    try {
        const { runAsync } = require('./db/multi-db');
        const result = await runAsync('main', "UPDATE thumb_status SET status='pending' WHERE status='processing'");
        if (result.changes > 0) {
            logger.info(`[Startup] 已重置 ${result.changes} 个卡在 'processing' 状态的缩略图任务。`);
        }
    } catch (e) {
        logger.debug('[Startup] 重置缩略图状态失败（忽略）：', e && e.message);
    }
}

/**
 * 启动期缩略图一致性自愈检查
 * - 如缩略图目录“几乎为空”但 DB 里存在大量 exists 标记，则自动重置为 pending
 */
async function healThumbnailsIfInconsistent() {
    try {
        const dirState = await isThumbsDirEffectivelyEmpty(THUMBS_DIR);
        // 仅在有效判定为空时才触发 DB 检查
        if (dirState !== true) {
            if (dirState === null) {
                logger.info('缩略图目录检查失败，跳过本轮自愈。');
            }
            return;
        }

        const { dbAll, runAsync } = require('./db/multi-db');
        const existsCount = await getCount('thumb_status', 'main', "status='exists'");
        if (existsCount > 100) {
            logger.warn('检测到缩略图目录几乎为空，但数据库中存在大量已存在标记，正在自动重置缩略图状态为 pending 以触发自愈重建...');
            await runAsync('main', "UPDATE thumb_status SET status='pending', mtime=0 WHERE status='exists'");
            logger.info('已重置缩略图状态（exists → pending）。后台生成将自动开始补齐缩略图。');
        }
    } catch (e) {
        logger.debug('缩略图自愈检查失败（忽略）：', e && e.message);
    }
}

/**
 * 检查指定目录可写性
 * @param {string} directory 待检测目录路径
 * @throws 无写权限时报错
 */
async function checkDirectoryWritable(directory) {
    const testFile = path.join(directory, '.writetest');
    try {
        await fs.writeFile(testFile, 'test');
        await fs.unlink(testFile);
        logger.info(`目录 ${directory} 写入权限检查通过。`);
    } catch (error) {
        logger.error(`!!!!!!!!!!!!!!!!!!!! 致命错误：权限不足 !!!!!!!!!!!!!!!!!!!!`);
        logger.error(`无法写入目录: ${directory}`);
        logger.error(`错误详情: ${error.message}`);
        logger.error(`请检查您的 Docker 挂载设置，并确保运行容器的用户对该目录有完全的读写权限。`);
        throw error;
    }
}

/**
 * 初始化关键目录结构（数据目录/照片目录/缩略图目录等）
 * @async
 */
async function initializeDirectories() {
    logger.info('正在初始化目录结构...');

    // 数据目录：递归创建
    await fs.mkdir(DATA_DIR, { recursive: true });

    await Promise.allSettled([
        // 照片目录
        (async () => {
            try {
                await fs.mkdir(PHOTOS_DIR, { recursive: true });
            } catch (e) {
                logger.debug('创建照片目录失败（忽略）:', e && e.message);
            }
        })(),
        // 缩略图目录
        (async () => {
            try {
                await fs.mkdir(THUMBS_DIR, { recursive: true });
            } catch (e) {
                logger.debug('创建缩略图目录失败（忽略）:', e && e.message);
            }
        })()
    ]);

    await checkDirectoryWritable(THUMBS_DIR);

    logger.info('目录结构初始化完成');
}

/**
 * 检查/执行数据库迁移逻辑
 * - 判断是否需从旧版 gallery.db 迁移
 * - 多库结构时跳过
 * @async
 */
async function handleDatabaseMigration() {
    logger.info('正在检查数据库迁移需求...');

    // 检查旧、新数据库文件存在性
    let oldDbExists = false;
    try {
        await fs.access(DB_FILE);
        oldDbExists = true;
    } catch (e) {
        logger.debug('旧数据库文件不存在（正常）:', e && e.message);
    }

    let newDbExists = false;
    try {
        await fs.access(SETTINGS_DB_FILE);
        newDbExists = true;
    } catch (e) {
        logger.debug('新数据库文件不存在（正常）:', e && e.message);
    }

    let isMigrationNeeded = false;

    // 仅当旧库存在且新库不存在时进一步判断需不需要迁移
    if (oldDbExists && !newDbExists) {
        // 旧库存在但新库不存在，需确认旧库非空
        const tables = await withTimeout(
            dbAllOnPath(DB_FILE, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"),
            10000,
            { sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'" }
        );

        if (tables.length > 0) {
            isMigrationNeeded = true;
        }
    }

    if (isMigrationNeeded) {
        logger.info('检测到包含数据的旧版数据库 gallery.db，将执行一次性迁移...');
        await migrateToMultiDB();
    } else {
        if (oldDbExists && !newDbExists) {
            logger.info('检测到空的或无效的旧版数据库文件 gallery.db，将忽略并进行全新初始化。');
        } else {
            logger.info('数据库结构已是多库架构，无需迁移。');
        }
    }
}

/**
 * 初始化所有数据库连接及表结构
 * @async
 */
async function initializeDatabase() {
    logger.info('正在初始化数据库...');

    // 初始化数据库连接
    await initializeConnections();

    // 初始化/建表等迁移步骤
    await initializeAllDBs();

    logger.info('数据库初始化完成');
}

/**
 * 启动后台服务与调度器
 * @async
 */
async function startServices() {
    logger.info('正在启动后台服务...');

    const tasks = [
        // 自适应任务调度
        (async () => {
            try {
                startAdaptiveScheduler();
            } catch (e) {
                logger.debug('启动自适应调度器失败（忽略）:', e && e.message);
            }
        })(),
        // 编排器服务
        (async () => {
            try {
                require('./services/orchestrator').start();
            } catch (e) {
                logger.debug('启动编排器失败（忽略）:', e && e.message);
            }
        })(),
        // Redis 可用性探测
        (async () => {
            try {
                const { getAvailability } = require('./config/redis');
                logger.info(`Redis 可用性: ${getAvailability()}`);
            } catch (e) {
                logger.warn('Redis 可用性检查失败，已使用降级配置继续启动。', e && e.message ? { error: e.message } : undefined);
            }
        })(),
        // 手动同步调度器
        (async () => {
            try {
                await require('./services/manualSyncScheduler.service').initialize();
            } catch (e) {
                logger.debug('启动手动同步调度器失败（忽略）:', e && e.message);
            }
        })()
    ];

    await Promise.allSettled(tasks);

    try {
        setupWorkerListeners();
    } catch (error) {
        logger.debug('初始化索引/视频工作线程监听失败（忽略）：', error && error.message);
    }
}

/**
 * 设置搜索索引监控与文件监听，
 * 冷启动时自动构建。
 * @async
 */
async function setupIndexingAndMonitoring() {
    logger.info('正在设置索引监控...');

    try {
        const idxRepo = require('./repositories/indexStatus.repo');
        // 获取 items 总数，利用优化查询
        const itemCountResult = await getCount('items', 'main');
        const itemCount = itemCountResult || 0;
        let hasResumePoint = false;

        // 检查索引状态与断点
        try {
            const status = await idxRepo.getIndexStatus();
            const resumeValue = await idxRepo.getResumeValue('last_processed_path');
            hasResumePoint = (status === 'building') || !!resumeValue;
        } catch (e) {
            logger.debug('检查索引状态失败（忽略）:', e && e.message);
        }

        if (itemCount === 0 || hasResumePoint) {
            logger.info(itemCount === 0 ? '数据库为空，开始构建搜索索引...' : '检测到未完成的索引任务，准备续跑构建搜索索引...');

            // 自愈处理残留状态
            try {
                const idxRepo = require('./repositories/indexStatus.repo');
                if (hasResumePoint) {
                    try { await idxRepo.setIndexStatus('pending'); } catch (e) {
                        logger.debug('重置索引状态失败（忽略）:', e && e.message);
                    }
                    try { await idxRepo.deleteResumeKey('last_processed_path'); } catch (e) {
                        logger.debug('删除索引断点失败（忽略）:', e && e.message);
                    }
                }
                await clearIndexingLockFlag();
            } catch (e) {
                logger.debug('索引自愈过程失败（忽略）:', e && e.message);
            }

            // 冷启动立即索引，非冷启动走 idle 调度
            if (itemCount === 0) {
                logger.info('检测到冷启动（items=0）：跳过 runWhenIdle，立即触发全量索引。');
                setTimeout(() => {
                    try {
                        require('./services/indexer.service').buildSearchIndex().catch((e) => {
                            logger.debug('冷启动索引构建失败（忽略）:', e && e.message);
                        });
                    } catch (e) {
                        logger.debug('冷启动索引构建异常（忽略）:', e && e.message);
                    }
                }, 1000);
            } else {
                scheduleIndexRebuild();
            }
        } else {
            logger.info(`索引已存在，跳过全量构建。当前索引包含 ${itemCount} 个条目。`);
        }

        // 启动期自动回填任务（runWhenIdle触发）
        try {
            const { runWhenIdle } = require('./services/orchestrator');
            const { runStartupBackfill } = require('./services/indexer.service');
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

/**
 * 服务主启动流程
 * - 初始化目录与数据库
 * - 启动服务及后端进程
 * - 启动 HTTP 监听
 * @async
 */
async function startServer() {
    logger.info('后端服务正在启动...');

    try {
        // 1. 初始化目录结构
        await initializeDirectories();

        // 2. 处理数据库迁移
        await handleDatabaseMigration();

        // 3. 初始化数据库连接与结构
        await initializeDatabase();

        // 4. 校验关键参数配置
        await validateCriticalConfig();

        // 5. 缩略图一致性自愈检查与后台服务并发启动
        await Promise.allSettled([
            resetStuckProcessingTasks().catch((err) => {
                logger.debug('重置卡死任务失败（降噪）:', err && err.message);
            }),
            healThumbnailsIfInconsistent().catch((err) => {
                logger.debug('缩略图自愈检查异步失败（降噪）:', err && err.message);
            }),
            startServices().catch((err) => {
                logger.debug('后台服务启动流程捕获异常（忽略）:', err && err.message);
            })
        ])

            ;

        // 6. 启动 HTTP 服务监听
        app.listen(PORT, () => {
            logger.info(`服务已启动在 http://localhost:${PORT}`);
            logger.info(`照片目录: ${PHOTOS_DIR}`);
            logger.info(`数据目录: ${DATA_DIR}`);
        });

        // 7. 启动索引监控与监听
        await setupIndexingAndMonitoring();

        setTimeout(async () => {
            try {
                const itemCount = await getCount('items', 'main');
                const ftsCount = await getCount('items_fts', 'main');
                logger.debug(`索引状态检查 - items表: ${itemCount} 条记录, FTS表: ${ftsCount} 条记录`);
            } catch (error) {
                logger.debug('索引状态检查失败（降噪）：', error && error.message);
            }
        }, 10000);

    } catch (error) {
        logger.error('启动过程中发生致命错误:', error.message);
        process.exit(1);
    }
}

// 进程异常与信号处理
process.on('uncaughtException', handleUncaughtException);
process.on('unhandledRejection', handleUnhandledRejection);

process.on('SIGINT', async () => {
    logger.info('收到关闭信号，正在优雅关闭...');
    try {
        await closeAllConnections();
        logger.info('所有数据库连接已关闭');
        process.exit(0);
    } catch (error) {
        logger.error('关闭数据库连接时出错:', error.message);
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    logger.info('收到终止信号，正在优雅关闭...');
    try {
        await closeAllConnections();
        logger.info('所有数据库连接已关闭');
        process.exit(0);
    } catch (error) {
        logger.error('关闭数据库连接时出错:', error.message);
        process.exit(1);
    }
});

// 启动主流程
startServer();
