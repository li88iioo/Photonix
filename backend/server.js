/**
 * 后端服务器主入口文件
 * 
 * 负责：
 * - 服务器启动和初始化
 * - 数据库连接管理
 * - 工作线程池创建和管理
 * - 文件系统权限检查
 * - 优雅关闭处理
 * - 错误处理和日志记录
 * 
 * @module server
 * @author Photonix
 * @version 1.0.0
 */

const app = require('./app');
const { promises: fs } = require('fs');
const path = require('path');
const logger = require('./config/logger');
/* 延后加载 Redis，避免无 Redis 环境下启动即触发连接 */
const { PORT, THUMBS_DIR, DB_FILE, SETTINGS_DB_FILE, HISTORY_DB_FILE, INDEX_DB_FILE, PHOTOS_DIR, DATA_DIR } = require('./config');
const { initializeConnections, closeAllConnections } = require('./db/multi-db');
const { initializeAllDBs, ensureCoreTables } = require('./db/migrations');
const { migrateToMultiDB } = require('./db/migrate-to-multi-db');
const { createThumbnailWorkerPool, ensureCoreWorkers, getVideoWorker } = require('./services/worker.manager');
const { startAdaptiveScheduler } = require('./services/adaptive.service');
const { setupThumbnailWorkerListeners, startIdleThumbnailGeneration } = require('./services/thumbnail.service');
const { setupWorkerListeners, buildSearchIndex, watchPhotosDir } = require('./services/indexer.service');
const { withTimeout, dbAllOnPath } = require('./db/multi-db');
const { timeUtils, TIME_CONSTANTS } = require('./utils/time.utils');
const { getCount, getThumbProcessingStats, getDataIntegrityStats } = require('./repositories/stats.repo');

/**
 * 索引调度器
 * 管理启动期索引重建调度逻辑
 */
class IndexScheduler {
    constructor() {
        // 配置参数
        this.disableStartupIndex = (process.env.DISABLE_STARTUP_INDEX || 'false').toLowerCase() === 'true';
        this.startDelayMs = Number(process.env.INDEX_START_DELAY_MS || 5000);
        this.retryIntervalMs = Number(process.env.INDEX_RETRY_INTERVAL_MS || 60000);
        this.timeoutMs = Number(process.env.INDEX_TIMEOUT_MS || timeUtils.minutes(20));
        this.lockTtlSec = Number(process.env.INDEX_LOCK_TTL_SEC || 7200);
        this.hasPendingJob = false;
    }

    /**
     * 检查是否应该跳过启动索引
     */
    shouldSkipStartupIndex() {
        if (this.disableStartupIndex) {
            logger.info('检测到 DISABLE_STARTUP_INDEX=true，跳过启动时索引构建。');
            return true;
        }
        return false;
    }

    /**
     * 执行索引清理（自愈）
     */
    async performIndexCleanup() {
        try {
            const { redis } = require('./config/redis');
            await redis.del('indexing_in_progress');
            logger.debug('[IndexScheduler] 已清理索引进行中旗标');
        } catch (e) {
            logger.warn('[IndexScheduler] 清理索引旗标失败：' + (e && e.message));
        }
    }

    /**
     * 执行索引构建
     */
    async performIndexBuild() {
        try {
            const { buildSearchIndex } = require('./services/indexer.service');
            await buildSearchIndex();
        } catch (err) {
            throw new Error('索引构建失败：' + (err && err.message));
        }
    }

    /**
     * 调度索引重建任务
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
                    logger.warn('runWhenIdle 启动索引失败（忽略）：' + (err && err.message));
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
            logger.warn('延后安排索引失败（忽略）：' + (e && e.message));
        }
    }
}

// 创建单例调度器
const indexScheduler = new IndexScheduler();

// 兼容旧用法
function scheduleIndexRebuild(reasonText) {
    return indexScheduler.scheduleIndexRebuild(reasonText);
}

/**
 * 执行快速目录检查
 * @param {string} rootDir - 根目录
 * @param {number} maxDepth - 最大深度
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
                    return false; // 找到文件，不为空
                }

                if (entry.isDirectory() && depth < maxDepth) {
                    directoryStack.push({ dir: fullPath, depth: depth + 1 });
                }
            }
        }

        return true; // 遍历完成，无文件
    } catch (error) {
        logger.warn(`[Startup] 快速目录检查失败 (${rootDir}): ${error && error.message}`);
        const wrapped = new Error('QUICK_DIR_CHECK_FAILED');
        wrapped.cause = error;
        wrapped.code = 'QUICK_DIR_CHECK_FAILED';
        throw wrapped;
    }
}

/**
 * 执行数据库采样检查
 * @param {number} sampleSize - 采样大小
 * @returns {Promise<boolean>} 是否有效
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
            if (!filePath) {
                continue;
            }
            const isVideoFile = /\.(mp4|webm|mov)$/i.test(filePath);
            const thumbnailExtension = isVideoFile ? '.jpg' : '.webp';
            const thumbnailRelativePath = filePath.replace(/\.[^.]+$/, thumbnailExtension);
            const thumbnailAbsolutePath = path.join(THUMBS_DIR, thumbnailRelativePath);

            try {
                await fs.access(thumbnailAbsolutePath);
                return false;
            } catch {
                // 未找到对应缩略图，继续检查其他样本
            }
        }

        return true;
    } catch (err) {
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
                    if (!filePath) {
                        continue;
                    }
                    const isVideoFile = /\.(mp4|webm|mov)$/i.test(filePath);
                    const thumbnailExtension = isVideoFile ? '.jpg' : '.webp';
                    const thumbnailRelativePath = filePath.replace(/\.[^.]+$/, thumbnailExtension);
                    const thumbnailAbsolutePath = path.join(THUMBS_DIR, thumbnailRelativePath);

                    try {
                        await fs.access(thumbnailAbsolutePath);
                        return false;
                    } catch {}
                }
                return true;
            } catch (fallbackError) {
                logger.debug('[Startup] rowid 查询失败后回退亦失败:', fallbackError && fallbackError.message);
            }
        }
        const message = err && err.message ? err.message : '';
        if (/no such table/i.test(message)) {
            logger.warn('[Startup] thumb_status 表不存在，跳过缩略图采样检查');
            return true;
        }
        logger.warn(`[Startup] 数据库采样检查失败: ${message}`);
        const wrapped = err instanceof Error ? err : new Error(message || 'DB_SAMPLE_CHECK_FAILED');
        if (!wrapped.code) {
            wrapped.code = 'DB_SAMPLE_CHECK_FAILED';
        }
        throw wrapped;
    }
}

/**
 * 检测 `THUMBS_DIR` 是否几乎为空（快速早停）
 * 递归向下最多两层，找到任意一个文件即返回 false
 */
async function isThumbsDirEffectivelyEmpty(rootDir) {
    try {
        // 1. 执行快速目录结构检查
        const isQuickEmpty = await performQuickDirectoryCheck(rootDir);
        if (!isQuickEmpty) {
            return false;
        }
    } catch (error) {
        logger.warn(`[Startup] 缩略图目录快速检查失败，暂不触发自愈: ${error && error.message}`);
        return null;
    }

    try {
        // 2. 快速检查为空，再做一次 DB 抽样深层核验，减少误判
        return await performDatabaseSampleCheck();
    } catch (error) {
        logger.warn(`[Startup] 缩略图数据库采样检查失败，暂不触发自愈: ${error && error.message}`);
        return null;
    }
}

/**
 * 启动期缩略图自愈：
 * - 如果检测到缩略图目录几乎为空，但 DB 里有大量 thumb_status=exists，则自动重置为 pending
 * - 避免用户误删缩略图目录后，后台补齐无法触发的问题
 */
async function healThumbnailsIfInconsistent() {
	try {
        const dirState = await isThumbsDirEffectivelyEmpty(THUMBS_DIR);
        // 仅当目录几乎为空时再去查询 DB，避免无谓 IO
        if (dirState !== true) {
            if (dirState === null) {
                logger.info('缩略图目录检查失败，跳过本轮自愈。');
            }
            return;
        }

		const { dbAll, runAsync } = require('./db/multi-db');
		const existsCount = await getCount('thumb_status', 'main', "status='exists'");
		if (existsCount > 100) {
			logger.warn('检测到缩略图目录几乎为空，但数据库中存在大量已存在标记，正在自动重置 thumb_status 为 pending 以触发自愈重建...');
			await runAsync('main', "UPDATE thumb_status SET status='pending', mtime=0 WHERE status='exists'");
			logger.info('已重置 thumb_status（exists -> pending）。后台生成将自动开始补齐缩略图。');
		}
	} catch (e) {
		logger.warn('缩略图自愈检查失败（忽略）：', e && e.message);
	}
}


/**
 * 检查目录是否可写
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
 * 初始化必要的目录结构
 */
async function initializeDirectories() {
	logger.info('正在初始化目录结构...');

	// 创建数据目录
	await fs.mkdir(DATA_DIR, { recursive: true });

	await Promise.allSettled([
		(async () => {
			try {
				await fs.mkdir(PHOTOS_DIR, { recursive: true });
			} catch (e) {
				logger.warn('创建照片目录失败（忽略）:', e && e.message);
			}
		})(),
		(async () => {
			try {
				await fs.mkdir(THUMBS_DIR, { recursive: true });
			} catch (e) {
				logger.warn('创建缩略图目录失败（忽略）:', e && e.message);
			}
		})()
	]);

	await checkDirectoryWritable(THUMBS_DIR);

	logger.info('目录结构初始化完成');
}

/**
 * 处理数据库迁移逻辑
 */
async function handleDatabaseMigration() {
	logger.info('正在检查数据库迁移需求...');

	// 检查是否需要从旧版 gallery.db 迁移
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

	if (oldDbExists && !newDbExists) {
		// 旧DB文件存在，但新DB文件不存在。需要进一步检查旧DB是否为空
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
 * 初始化数据库连接和表结构
 */
async function initializeDatabase() {
	logger.info('正在初始化数据库...');

	// 初始化所有数据库连接
	await initializeConnections();

	// 初始化所有数据库
	await initializeAllDBs();

	logger.info('数据库初始化完成');
}

/**
 * 启动各种调度器和服务
 */
async function startServices() {
	logger.info('正在启动后台服务...');

	const tasks = [
		(async () => {
			try {
				startAdaptiveScheduler();
			} catch (e) {
				logger.warn('启动自适应调度器失败（忽略）:', e && e.message);
			}
		})(),
		(async () => {
			try {
				require('./services/orchestrator').start();
			} catch (e) {
				logger.warn('启动编排器失败（忽略）:', e && e.message);
			}
		})(),
		(async () => {
			try {
				const { getAvailability } = require('./config/redis');
				logger.info(`[Startup] Redis availability: ${getAvailability()}`);
			} catch (e) {
				logger.warn('Redis 可用性检查失败，已使用降级配置继续启动。', e && e.message ? { error: e.message } : undefined);
			}
		})()
	];

	await Promise.allSettled(tasks);
}

/**
 * 设置索引监控和文件监听
 */
async function setupIndexingAndMonitoring() {
	logger.info('正在设置索引监控...');

	try {
		const { dbAll } = require('./db/multi-db');
		const idxRepo = require('./repositories/indexStatus.repo');
		const itemCount = await dbAll('main', "SELECT COUNT(*) as count FROM items");
		let hasResumePoint = false;

		try {
			const status = await idxRepo.getIndexStatus();
			const resumeValue = await idxRepo.getResumeValue('last_processed_path');
			hasResumePoint = (status === 'building') || !!resumeValue;
		} catch (e) {
			logger.debug('检查索引状态失败（忽略）:', e && e.message);
		}

		if (itemCount[0].count === 0 || hasResumePoint) {
			logger.info(itemCount[0].count === 0 ? '数据库为空，开始构建搜索索引...' : '检测到未完成的索引任务，准备续跑构建搜索索引...');

			// 自愈：清理可能残留的"building/断点/旗标"，避免 orchestrator.isHeavy 一直判定重负载而不触发
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
				try { const { redis } = require('./config/redis'); await redis.del('indexing_in_progress'); } catch (e) {
					logger.debug('清理Redis索引旗标失败（忽略）:', e && e.message);
				}
			} catch (e) {
				logger.debug('索引自愈过程失败（忽略）:', e && e.message);
			}

			// 冷启动（items=0）默认立即触发全量索引；续跑场景仍走空闲窗口调度
			if (itemCount[0].count === 0) {
				logger.info('检测到冷启动（items=0）：跳过 runWhenIdle，立即触发全量索引。');
				setTimeout(() => {
					try {
						require('./services/indexer.service').buildSearchIndex().catch((e) => {
							logger.warn('冷启动索引构建失败（忽略）:', e && e.message);
						});
					} catch (e) {
						logger.warn('冷启动索引构建异常（忽略）:', e && e.message);
					}
				}, 1000);
			} else {
				scheduleIndexRebuild();
			}
		} else {
			logger.info(`索引已存在，跳过全量构建。当前索引包含 ${itemCount[0].count} 个条目。`);
		}

		watchPhotosDir();

		// 启动期自动回填（由 orchestrator 托管，空闲窗口执行一次性回填任务）
		try {
			const { runWhenIdle } = require('./services/orchestrator');
			runWhenIdle('startup-backfill', async () => {
				const integrityStats = await getDataIntegrityStats();
				const needM = integrityStats.missingMtime > 0;
				const needD = integrityStats.missingDimensions > 0;
				if (!needM && !needD) return;

				const { createDisposableWorker } = require('./services/worker.manager');
				const w = createDisposableWorker('indexing', { reason: 'startup-backfill' });
				const photosDir = PHOTOS_DIR;
				const TIMEOUT_MS = 20 * 60 * 1000;

				await new Promise((resolve) => {
					const timer = setTimeout(() => {
						logger.warn('[SERVER] 回填任务超时，终止 worker');
						try { w.terminate(); } catch (e) {
							logger.debug('[SERVER] 终止回填worker失败（忽略）:', e && e.message);
						}
						resolve();
					}, TIMEOUT_MS);

					w.on('message', (msg) => {
						if (!msg || !msg.type) return;
						if (msg.type === 'backfill_mtime_complete') {
							logger.info(`[SERVER] mtime 回填完成（更新 ${msg.updated} 条），开始尺寸回填`);
							try { w.postMessage({ type: 'backfill_missing_dimensions', payload: { photosDir } }); } catch (e) {
								logger.debug('[SERVER] 发送尺寸回填消息失败（忽略）:', e && e.message);
							}
						} else if (msg.type === 'backfill_dimensions_complete') {
							logger.info(`[SERVER] 尺寸回填完成（更新 ${msg.updated} 条），回填任务结束`);
							clearTimeout(timer);
							try { w.terminate(); } catch (e) {
								logger.debug('[SERVER] 终止回填worker失败（忽略）:', e && e.message);
							}
							resolve();
						} else if (msg.type === 'error') {
							logger.warn(`[SERVER] 回填任务子消息错误：${msg.error}`);
						}
					});
					w.on('error', (e) => logger.warn(`[SERVER] 回填 worker 错误：${e && e.message}`));
					w.on('exit', (code) => { if (code !== 0) logger.warn(`[SERVER] 回填 worker 非零退出码：${code}`); });

					if (needM) {
						w.postMessage({ type: 'backfill_missing_mtime', payload: { photosDir } });
						logger.info('[SERVER] 启动期回填任务已触发：mtime → dimensions');
					} else {
						w.postMessage({ type: 'backfill_missing_dimensions', payload: { photosDir } });
						logger.info('[SERVER] 启动期回填任务已触发：dimensions');
					}
				});
			}, { startDelayMs: 8000, retryIntervalMs: 30000, timeoutMs: 20 * 60 * 1000, lockTtlSec: 7200, category: 'index-maintenance' });
		} catch (e) {
			logger.warn('[SERVER] 启动期回填装载失败（忽略）：', e && e.message);
		}

		// 启动时后台回填缺失的 mtime/width/height，降低运行时 fs.stat 与动态尺寸探测
		try {
			const { getIndexingWorker } = require('./services/worker.manager');
			const worker = getIndexingWorker();
			worker.postMessage({ type: 'backfill_missing_mtime', payload: { photosDir: PHOTOS_DIR } });
			worker.postMessage({ type: 'backfill_missing_dimensions', payload: { photosDir: PHOTOS_DIR } });
			logger.info('已触发启动期的 mtime 与 尺寸 回填后台任务。');
		} catch (e) {
			logger.warn('触发启动期回填任务失败（忽略）：', e && e.message);
		}
	} catch (dbError) {
		logger.debug('检查索引状态失败（降噪）：', dbError && dbError.message);
		logger.info('由于检查失败，开始构建搜索索引...');
		scheduleIndexRebuild();
		watchPhotosDir();
	}
}

/**
 * 主启动函数
 */
async function startServer() {
	logger.info(`后端服务正在启动...`);

	try {
		// 1. 初始化目录结构
		await initializeDirectories();

		// 2. 处理数据库迁移
		await handleDatabaseMigration();

		// 3. 初始化数据库
		await initializeDatabase();

		// 4. 自愈检查（缩略图一致性）与后台服务启动并行执行
		await Promise.allSettled([
			healThumbnailsIfInconsistent().catch((err) => {
				logger.debug('缩略图自愈检查异步失败（降噪）:', err && err.message);
			}),
			startServices().catch((err) => {
				logger.warn('后台服务启动流程捕获异常（忽略）:', err && err.message);
			})
		]);

		// 6. 启动HTTP服务器
		app.listen(PORT, () => {
			logger.info(`服务已启动在 http://localhost:${PORT}`);
			logger.info(`照片目录: ${PHOTOS_DIR}`);
			logger.info(`数据目录: ${DATA_DIR}`);

			// 记录HLS自适应配置状态
			try {
				const { getAdaptiveHlsConfig } = require('./config');
				const hlsConfig = getAdaptiveHlsConfig();
				const loadLevel = hlsConfig.loadFactor > 0.8 ? '高' :
				                 hlsConfig.loadFactor > 0.5 ? '中' : '低';

				logger.info(`HLS自适应配置已激活 - 当前负载等级: ${loadLevel} (${(hlsConfig.loadFactor * 100).toFixed(1)}%)`);
				logger.info(`  - 缓存TTL: ${(hlsConfig.HLS_CACHE_TTL_MS / 1000 / 60).toFixed(1)}分钟`);
				logger.info(`  - 最小检查间隔: ${(hlsConfig.HLS_MIN_CHECK_INTERVAL_MS / 1000).toFixed(1)}秒`);
				logger.info(`  - 批处理延迟: ${hlsConfig.HLS_BATCH_DELAY_MS}毫秒`);
			} catch (e) {
				logger.debug('HLS配置状态记录失败（忽略）:', e.message);
			}
		});

		// 7. 设置索引监控和文件监听
		await setupIndexingAndMonitoring();

		setTimeout(async () => {
			try {
				const { dbAll } = require('./db/multi-db');
				const itemCount = await dbAll('main', "SELECT COUNT(*) as count FROM items");
				const ftsCount = await dbAll('main', "SELECT COUNT(*) as count FROM items_fts");
				logger.debug(`索引状态检查 - items表: ${itemCount[0].count} 条记录, FTS表: ${ftsCount[0].count} 条记录`);
			} catch (error) {
				logger.debug('索引状态检查失败（降噪）：', error && error.message);
			}
		}, 10000);

	} catch (error) {
		logger.error('启动过程中发生致命错误:', error.message);
		process.exit(1);
	}
}

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

startServer();
