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
const { PORT, THUMBS_DIR, DB_FILE, SETTINGS_DB_FILE, HISTORY_DB_FILE, INDEX_DB_FILE, PHOTOS_DIR, DATA_DIR } = require('./config');
const { initializeConnections, closeAllConnections } = require('./db/multi-db');
const { initializeAllDBs, ensureCoreTables } = require('./db/migrations');
const { migrateToMultiDB } = require('./db/migrate-to-multi-db');
const { createThumbnailWorkerPool, ensureCoreWorkers, getVideoWorker } = require('./services/worker.manager');
const { startAdaptiveScheduler } = require('./services/adaptive.service');
const { setupThumbnailWorkerListeners, startIdleThumbnailGeneration } = require('./services/thumbnail.service');
const { setupWorkerListeners, buildSearchIndex, watchPhotosDir } = require('./services/indexer.service');
const sqlite3 = require('sqlite3');

/**
 * 检测 `THUMBS_DIR` 是否几乎为空（快速早停）
 * 递归向下最多两层，找到任意一个文件即返回 false
 */
async function isThumbsDirEffectivelyEmpty(rootDir) {
    // 先做快速两层采样，如检测到文件则直接非空
    const quickCheck = async () => {
        try {
            const stack = [{ dir: rootDir, depth: 0 }];
            while (stack.length > 0) {
                const { dir, depth } = stack.pop();
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.name === '.writetest') continue;
                    const full = path.join(dir, entry.name);
                    if (entry.isFile()) return false;
                    if (entry.isDirectory() && depth < 2) stack.push({ dir: full, depth: depth + 1 });
                }
            }
            return true;
        } catch {
            return true;
        }
    };

    const deepSampleCheck = async () => {
        // 从 DB 抽样 50 条 exists 路径，映射到缩略图路径，检查是否存在任意一个
        try {
            const { dbAll } = require('./db/multi-db');
            const rows = await dbAll('main', `SELECT path FROM thumb_status WHERE status='exists' ORDER BY RANDOM() LIMIT 50`);
            if (!rows || rows.length === 0) return true; // 无数据等同空
            for (const r of rows) {
                const isVideo = /\.(mp4|webm|mov)$/i.test(r.path || '');
                const extension = isVideo ? '.jpg' : '.webp';
                const thumbRel = (r.path || '').replace(/\.[^.]+$/, extension);
                const abs = path.join(THUMBS_DIR, thumbRel);
                try { await fs.access(abs); return false; } catch { /* continue */ }
            }
            return true;
        } catch {
            return true;
        }
    };

    const quickEmpty = await quickCheck();
    if (!quickEmpty) return false;
    // 快速检查为空，再做一次 DB 抽样深层核验，减少误判
    return await deepSampleCheck();
}

/**
 * 启动期缩略图自愈：
 * - 如果检测到缩略图目录几乎为空，但 DB 里有大量 thumb_status=exists，则自动重置为 pending
 * - 避免用户误删缩略图目录后，后台补齐无法触发的问题
 */
async function healThumbnailsIfInconsistent() {
	try {
		const dirEmpty = await isThumbsDirEffectivelyEmpty(THUMBS_DIR);
		// 仅当目录几乎为空时再去查询 DB，避免无谓 IO
		if (!dirEmpty) return;

		const { dbAll, runAsync } = require('./db/multi-db');
		const rows = await dbAll('main', "SELECT COUNT(*) AS c FROM thumb_status WHERE status='exists'");
		const existsCount = (rows && rows[0] && rows[0].c) ? Number(rows[0].c) : 0;
		if (existsCount > 100) {
			logger.warn('检测到缩略图目录几乎为空，但数据库中存在大量已存在标记，正在自动重置 thumb_status 为 pending 以触发自愈重建...');
			await runAsync('main', "UPDATE thumb_status SET status='pending', mtime=0 WHERE status='exists'");
			logger.info('已重置 thumb_status（exists -> pending）。后台生成将自动开始补齐缩略图。');
		}
	} catch (e) {
		logger.warn('缩略图自愈检查失败（忽略）：', e && e.message);
	}
}

// 常驻缩略图对账循环已移除，改由 maintenance 任务定时执行低频批处理。

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

async function startServer() {
	logger.info(`后端服务正在启动...`);
	try {
		// 1. 目录
		await fs.mkdir(THUMBS_DIR, { recursive: true });
		await checkDirectoryWritable(THUMBS_DIR);

		// 2. 检查是否需要从旧版 gallery.db 迁移
        const oldDbExists = require('fs').existsSync(DB_FILE);
        const newDbExists = require('fs').existsSync(SETTINGS_DB_FILE);
        let isMigrationNeeded = false;

        if (oldDbExists && !newDbExists) {
            // 旧DB文件存在，但新DB文件不存在。需要进一步检查旧DB是否为空
            const db = new sqlite3.Database(DB_FILE);
            const tables = await new Promise((resolve, reject) => {
                db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                });
            });
            db.close();

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

        // 3. DB 初始化 (无论是否迁移，都确保初始化)
        await initializeConnections();
        await initializeAllDBs();
        await ensureCoreTables();

		// 自愈（仅启动时一次）
		await healThumbnailsIfInconsistent();

		// 4. Workers
		ensureCoreWorkers();
		createThumbnailWorkerPool();
        // 4.1 自适应调度器
        try { startAdaptiveScheduler(); } catch {}

		// 5. 监听器
		setupWorkerListeners();
		setupThumbnailWorkerListeners();

		// 6. 启动 HTTP
		app.listen(PORT, () => {
			logger.info(`服务已启动在 http://localhost:${PORT}`);
			logger.info(`照片目录: ${PHOTOS_DIR}`);
			logger.info(`数据目录: ${DATA_DIR}`);
		});

		// 7. 索引检查与监控 (必须在所有DB和服务初始化之后)
		try {
			const { dbAll, dbGet } = require('./db/multi-db');
			const itemCount = await dbAll('main', "SELECT COUNT(*) as count FROM items");
			let hasResumePoint = false;
			try {
				const statusRow = await dbGet('index', "SELECT status FROM index_status WHERE id = 1");
				const resumeRow = await dbGet('index', "SELECT value FROM index_progress WHERE key = 'last_processed_path'");
				hasResumePoint = (statusRow && statusRow.status === 'building') || !!(resumeRow && resumeRow.value);
			} catch {}

			if (itemCount[0].count === 0 || hasResumePoint) {
				logger.info(itemCount[0].count === 0 ? '数据库为空，开始构建搜索索引...' : '检测到未完成的索引任务，准备续跑构建搜索索引...');
				buildSearchIndex();
			} else {
				logger.info(`索引已存在，跳过全量构建。当前索引包含 ${itemCount[0].count} 个条目。`);
			}

			watchPhotosDir();
		} catch (dbError) {
			logger.debug('检查索引状态失败（降噪）：', dbError && dbError.message);
			logger.info('由于检查失败，开始构建搜索索引...');
			buildSearchIndex();
			watchPhotosDir();
		}

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
