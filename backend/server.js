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
const { TraceManager } = require('./utils/trace');
const { normalizeWorkerMessage } = require('./utils/workerMessage');
const { validateCriticalConfig } = require('./config/validator');
const { handleUncaughtException, handleUnhandledRejection } = require('./middleware/errorHandler');
// 延后加载 Redis，避免无 Redis 环境下启动即触发连接
const { PORT, THUMBS_DIR, DB_FILE, SETTINGS_DB_FILE, PHOTOS_DIR, DATA_DIR } = require('./config');
const { initializeConnections, closeAllConnections } = require('./db/multi-db');
const { initializeAllDBs, ensureCoreTables } = require('./db/migrations');
const { migrateToMultiDB } = require('./db/migrate-to-multi-db');
const { createThumbnailWorkerPool, ensureCoreWorkers } = require('./services/worker.manager');
const { startAdaptiveScheduler } = require('./services/adaptive.service');
const { setupThumbnailWorkerListeners, startIdleThumbnailGeneration } = require('./services/thumbnail.service');
const { setupWorkerListeners, buildSearchIndex } = require('./services/indexer.service');
const { withTimeout, dbAllOnPath } = require('./db/multi-db');
const { timeUtils, TIME_CONSTANTS } = require('./utils/time.utils');
const { getCount, getThumbProcessingStats, getDataIntegrityStats } = require('./repositories/stats.repo');

/**
 * 索引调度器类
 * 管理启动时索引重建的调度逻辑
 */
class IndexScheduler {
    constructor() {
        // 调度相关配置参数
        this.disableStartupIndex = (process.env.DISABLE_STARTUP_INDEX || 'false').toLowerCase() === 'true';
        this.startDelayMs = Number(process.env.INDEX_START_DELAY_MS || 5000);
        this.retryIntervalMs = Number(process.env.INDEX_RETRY_INTERVAL_MS || 60000);
        this.timeoutMs = Number(process.env.INDEX_TIMEOUT_MS || timeUtils.minutes(20));
        this.lockTtlSec = Number(process.env.INDEX_LOCK_TTL_SEC || 7200);
        this.hasPendingJob = false;
    }

    /**
     * 判断是否应跳过启动时的索引构建
     * @returns {boolean}
     */
    shouldSkipStartupIndex() {
        if (this.disableStartupIndex) {
            logger.info('检测到 DISABLE_STARTUP_INDEX=true，跳过启动时索引构建。');
            return true;
        }
        return false;
    }

    /**
     * 清理索引中间进度标记（自愈流程用）
     * @async
     */
    async performIndexCleanup() {
        try {
            const { redis } = require('./config/redis');
            const { safeRedisDel } = require('./utils/helpers');
            await safeRedisDel(redis, 'indexing_in_progress', '清理索引标记');
            logger.debug('[IndexScheduler] 已清理索引进行中旗标');
        } catch (e) {
            logger.debug('[IndexScheduler] 清理索引旗标失败：' + (e && e.message));
        }
    }

    /**
     * 执行索引构建过程
     * @async
     */
    async performIndexBuild() {
        try {
            const { buildSearchIndex } = require('./services/indexer.service');
            await buildSearchIndex();
        } catch (err) {
            const { fromNativeError } = require('./utils/errors');
            throw fromNativeError(err, { operation: 'buildSearchIndex' });
        }
    }

    /**
     * 调度索引重建任务（runWhenIdle机制）
     * @param {string} reasonText - 调度原因描述（可选）
     */
    scheduleIndexRebuild(reasonText) {
        if (this.shouldSkipStartupIndex()) {
            return;
        }

        if (this.hasPendingJob) {
            if (reasonText) {
                logger.debug(`[IndexScheduler] 已存在待执行的索引任务，忽略新的调度请求：${reasonText}`);
            }
            return;
        }

        const releasePending = () => {
            if (this.hasPendingJob) {
                this.hasPendingJob = false;
            }
        };

        try {
            const { runWhenIdle } = require('./services/orchestrator');
            logger.info(reasonText || '计划在空闲窗口重建索引（runWhenIdle）。');

            this.hasPendingJob = true;

            runWhenIdle('startup-rebuild-index', async () => {
                try {
                    logger.info('[Startup-Index] 进入空闲窗口回调，准备触发全量索引...');

                    // 冷启动自愈：清理可能残留的索引进行中旗标
                    await this.performIndexCleanup();

                    // 执行索引构建
                    await this.performIndexBuild();

                } catch (err) {
                    logger.debug('runWhenIdle 启动索引失败（忽略）：' + (err && err.message));
                } finally {
                    releasePending();
                }
            }, {
                startDelayMs: this.startDelayMs,
                retryIntervalMs: this.retryIntervalMs,
                timeoutMs: this.timeoutMs,
                lockTtlSec: this.lockTtlSec,
                category: 'index-maintenance'
            });
        } catch (e) {
            releasePending();
            logger.debug('延后安排索引失败（忽略）：' + (e && e.message));
        }
    }
}

// 单例索引调度器实例
const indexScheduler = new IndexScheduler();

/**
 * 兼容性外部调度方法
 * @param {string} reasonText
 */
function scheduleIndexRebuild(reasonText) {
    return indexScheduler.scheduleIndexRebuild(reasonText);
}

/**
 * 快速检查目标目录是否为空（最多递归 maxDepth 层）
 * @param {string} rootDir - 根目录
 * @param {number} maxDepth - 最大递归深度
 * @returns {Promise<boolean>} 是否为空
 */
async function performQuickDirectoryCheck(rootDir, maxDepth = 2) {
    try {
        const directoryStack = [{ dir: rootDir, depth: 0 }];

        while (directoryStack.length > 0) {
            const { dir, depth } = directoryStack.pop();
            const entries = await fs.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.name === '.writetest') continue;

                const fullPath = path.join(dir, entry.name);

                if (entry.isFile()) {
                    return false; // 任意文件视为非空
                }

                if (entry.isDirectory() && depth < maxDepth) {
                    directoryStack.push({ dir: fullPath, depth: depth + 1 });
                }
            }
        }

        return true; // 深度遍历完无文件
    } catch (error) {
        logger.warn(`[Startup] 快速目录检查失败 (${rootDir}): ${error && error.message}`);
        const wrapped = new Error('QUICK_DIR_CHECK_FAILED');
        wrapped.cause = error;
        wrapped.code = 'QUICK_DIR_CHECK_FAILED';
        throw wrapped;
    }
}

/**
 * 数据库采样校验缩略图真实存在性（抽取部分条目做存在性校验）
 * @param {number} sampleSize - 采样数量
 * @returns {Promise<boolean>} 样本条目指向缩略图是否都不存在
 */
async function performDatabaseSampleCheck(sampleSize = 50) {
    const { dbAll } = require('./db/multi-db');
    const effectiveLimit = Math.max(1, Math.min(sampleSize, 100));

    try {
        const rows = await dbAll(
            'main',
            `SELECT path FROM thumb_status
             WHERE status='exists'
             ORDER BY rowid DESC
             LIMIT ?`,
            [effectiveLimit]
        );

        if (!Array.isArray(rows) || rows.length === 0) {
            return true;
        }

        for (const row of rows) {
            const filePath = row && row.path ? String(row.path) : '';
            if (!filePath) continue;
            const isVideoFile = /\.(mp4|webm|mov)$/i.test(filePath);
            const thumbnailExtension = isVideoFile ? '.jpg' : '.webp';
            const thumbnailRelativePath = filePath.replace(/\.[^.]+$/, thumbnailExtension);
            const thumbnailAbsolutePath = path.join(THUMBS_DIR, thumbnailRelativePath);

            try {
                await fs.access(thumbnailAbsolutePath);
                return false;
            } catch (thumbCheckErr) {
                logger.silly(`[Startup] 样本 ${thumbnailRelativePath || '未知'} 缺少缩略图（忽略）: ${thumbCheckErr && thumbCheckErr.message}`);
            }
        }

        return true;
    } catch (err) {
        // 兼容 rowid 不存在的情况
        if (err && /no such column: rowid/i.test(String(err.message || err))) {
            try {
                const fallbackRows = await dbAll(
                    'main',
                    `SELECT path FROM thumb_status
                     WHERE status='exists'
                     ORDER BY mtime DESC
                     LIMIT ?`,
                    [effectiveLimit]
                );
                if (!Array.isArray(fallbackRows) || fallbackRows.length === 0) {
                    return true;
                }
                for (const row of fallbackRows) {
                    const filePath = row && row.path ? String(row.path) : '';
                    if (!filePath) continue;
                    const isVideoFile = /\.(mp4|webm|mov)$/i.test(filePath);
                    const thumbnailExtension = isVideoFile ? '.jpg' : '.webp';
                    const thumbnailRelativePath = filePath.replace(/\.[^.]+$/, thumbnailExtension);
                    const thumbnailAbsolutePath = path.join(THUMBS_DIR, thumbnailRelativePath);

                    try {
                        await fs.access(thumbnailAbsolutePath);
                        return false;
                    } catch (sampleThumbErr) {
                        logger.silly(`[Startup] 样本 ${thumbnailRelativePath || '未知'} 缺少缩略图（忽略）: ${sampleThumbErr && sampleThumbErr.message}`);
                    } // 不存在时忽略
                }
                return true;
            } catch (fallbackError) {
                logger.debug('[Startup] rowid 查询失败后回退亦失败:', fallbackError && fallbackError.message);
            }
        }
        // 兼容旧表不存在
        const message = err && err.message ? err.message : '';
        if (/no such table/i.test(message)) {
            logger.debug('[Startup] 缩略图状态表不存在，跳过缩略图采样检查');
            return true;
        }
        logger.debug(`[Startup] 数据库采样检查失败: ${message}`);
        const wrapped = err instanceof Error ? err : new Error(message || 'DB_SAMPLE_CHECK_FAILED');
        if (!wrapped.code) {
            wrapped.code = 'DB_SAMPLE_CHECK_FAILED';
        }
        throw wrapped;
    }
}

/**
 * 判断缩略图目录是否“几乎为空”
 * - 快速遍历最多两层目录发现有文件就视为非空
 * - 若目录为空，再抽样 DB 进一步校验缩略图实际缺失性
 * @param {string} rootDir
 * @returns {Promise<boolean|null>} true:有效为空，false:非空，null:无法判断
 */
async function isThumbsDirEffectivelyEmpty(rootDir) {
    try {
        // 步骤1: 目录层面快速检查
        const isQuickEmpty = await performQuickDirectoryCheck(rootDir);
        if (!isQuickEmpty) return false;
    } catch (error) {
        logger.debug(`[Startup] 缩略图目录快速检查失败，暂不触发自愈: ${error && error.message}`);
        return null;
    }

    try {
        // 步骤2: 对应 DB 采样二次核验，降低误判
        return await performDatabaseSampleCheck();
    } catch (error) {
        logger.debug(`[Startup] 缩略图数据库采样检查失败，暂不触发自愈: ${error && error.message}`);
        return null;
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
                try { const { redis } = require('./config/redis'); const { safeRedisDel } = require('./utils/helpers'); await safeRedisDel(redis, 'indexing_in_progress', '清理索引标记'); } catch (e) {
                    logger.debug('清理Redis索引旗标失败（忽略）:', e && e.message);
                }
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
            runWhenIdle(LOG_PREFIXES.STARTUP_BACKFILL, async () => {
                const integrityStats = await getDataIntegrityStats();
                const needM = integrityStats.missingMtime > 0;
                const needD = integrityStats.missingDimensions > 0;
                if (!needM && !needD) return;

                const { createDisposableWorker } = require('./services/worker.manager');
                const w = createDisposableWorker('indexing', { reason: LOG_PREFIXES.STARTUP_BACKFILL });
                const photosDir = PHOTOS_DIR;
                const TIMEOUT_MS = 20 * 60 * 1000;

                await new Promise((resolve) => {
                    const timer = setTimeout(() => {
                        logger.warn(formatLog(LOG_PREFIXES.SERVER, '回填任务超时，终止 worker'));
                        try { w.terminate(); } catch (e) {
                            logger.debug(formatLog(LOG_PREFIXES.SERVER, `终止回填worker失败（忽略）：${e && e.message}`));
                        }
                        resolve();
                    }, TIMEOUT_MS);

                    w.on('message', (rawMessage) => {
                        const processMessage = () => {
                            try {
                                const message = normalizeWorkerMessage(rawMessage);
                                const payload = message.payload || {};
                                const eventType = payload.type || (rawMessage && rawMessage.type) || message.kind;

                                if (message.kind === 'log') {
                                    const level = (payload.level || 'debug').toLowerCase();
                                    const text = payload.message || payload.text || '';
                                    const fn = typeof logger[level] === 'function' ? level : 'debug';
                                    logger[fn](formatLog(LOG_PREFIXES.SERVER, `回填worker日志: ${text}`));
                                    return;
                                }

                                if (message.kind === 'error') {
                                    const errMsg = (payload.error && payload.error.message) || payload.message || JSON.stringify(payload);
                                    logger.warn(formatLog(LOG_PREFIXES.SERVER, `回填任务子消息错误：${errMsg}`));
                                    return;
                                }

                                if (eventType === 'backfill_mtime_complete') {
                                    const updated = typeof payload.updated === 'number' ? payload.updated : rawMessage && rawMessage.updated;
                                    logger.info(formatLog(LOG_PREFIXES.SERVER, `mtime 回填完成（更新 ${updated} 条），开始尺寸回填`));
                                    try {
                                        const nextMessage = TraceManager.injectToWorkerMessage({ type: 'backfill_missing_dimensions', payload: { photosDir } });
                                        w.postMessage(nextMessage);
                                    } catch (e) {
                                        logger.debug(formatLog(LOG_PREFIXES.SERVER, `发送尺寸回填消息失败（忽略）：${e && e.message}`));
                                    }
                                    return;
                                }

                                if (eventType === 'backfill_dimensions_complete') {
                                    const updated = typeof payload.updated === 'number' ? payload.updated : rawMessage && rawMessage.updated;
                                    logger.info(formatLog(LOG_PREFIXES.SERVER, `尺寸回填完成（更新 ${updated} 条），回填任务结束`));
                                    clearTimeout(timer);
                                    try { w.terminate(); } catch (e) {
                                        logger.debug(formatLog(LOG_PREFIXES.SERVER, `终止回填worker失败（忽略）：${e && e.message}`));
                                    }
                                    resolve();
                                    return;
                                }

                                logger.debug(formatLog(LOG_PREFIXES.SERVER, `回填任务收到未知事件: ${eventType}`));
                            } catch (error) {
                                logger.debug(formatLog(LOG_PREFIXES.SERVER, `回填worker消息解析失败（忽略）：${error && error.message}`));
                            }
                        };

                        try {
                            const traceContext = TraceManager.fromWorkerMessage(rawMessage);
                            if (traceContext) {
                                TraceManager.run(traceContext, processMessage);
                            } else {
                                processMessage();
                            }
                        } catch (error) {
                            logger.debug(formatLog(LOG_PREFIXES.SERVER, `回填worker追踪恢复失败（忽略）：${error && error.message}`));
                            processMessage();
                        }
                    });
                    w.on('error', (e) => logger.debug(formatLog(LOG_PREFIXES.SERVER, `回填 worker 错误：${e && e.message}`)));
                    w.on('exit', (code) => { if (code !== 0) logger.warn(formatLog(LOG_PREFIXES.SERVER, `回填 worker 非零退出码：${code}`)); });

                    if (needM) {
                        const message = TraceManager.injectToWorkerMessage({ type: 'backfill_missing_mtime', payload: { photosDir } });
                        w.postMessage(message);
                        logger.info(formatLog(LOG_PREFIXES.SERVER, '启动期回填任务已触发：mtime → dimensions'));
                    } else {
                        const message = TraceManager.injectToWorkerMessage({ type: 'backfill_missing_dimensions', payload: { photosDir } });
                        w.postMessage(message);
                        logger.info(formatLog(LOG_PREFIXES.SERVER, '启动期回填任务已触发：dimensions'));
                    }
                });
            }, { startDelayMs: 8000, retryIntervalMs: 30000, timeoutMs: 20 * 60 * 1000, lockTtlSec: 7200, category: 'index-maintenance' });
        } catch (e) {
            logger.debug(formatLog(LOG_PREFIXES.SERVER, `启动期回填装载失败（忽略）：${e && e.message}`));
        }

        // 启动时后台回填缺失的 mtime/width/height，降低运行时 fs.stat 与动态尺寸探测
        try {
            const { getIndexingWorker } = require('./services/worker.manager');
            const worker = getIndexingWorker();
            const mtimeMessage = TraceManager.injectToWorkerMessage({ type: 'backfill_missing_mtime', payload: { photosDir: PHOTOS_DIR } });
            const dimensionsMessage = TraceManager.injectToWorkerMessage({ type: 'backfill_missing_dimensions', payload: { photosDir: PHOTOS_DIR } });
            worker.postMessage(mtimeMessage);
            worker.postMessage(dimensionsMessage);
            logger.info('已触发启动期的 mtime 与 尺寸 回填后台任务。');
        } catch (e) {
            logger.debug('触发启动期回填任务失败（忽略）：', e && e.message);
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
