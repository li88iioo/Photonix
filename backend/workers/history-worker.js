const { parentPort } = require('worker_threads');
const path = require('path');
const winston = require('winston');
const { initializeConnections, getDB, runPreparedBatch } = require('../db/multi-db');
const { redis } = require('../config/redis');

(async () => {
    await initializeConnections();
    // 兜底：确保主库核心表存在，避免并发竞态导致其他模块引用时报错
    try {
        const { ensureCoreTables } = require('../db/migrations');
        await ensureCoreTables();
    } catch (_) {}
    // --- 日志配置 ---
    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] [HISTORY-WORKER] ${info.level}: ${info.message}`)),
        transports: [new winston.transports.Console()]
    });
    // --- 数据库配置 ---
    const db = getDB('history');

    // --- 辅助函数 ---
    const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) { if (err) rej(err); else res(this); }));

    // --- 历史记录任务处理器 ---
    const tasks = {
        async update_view_time({ userId, path: itemPath }) {
            if (!itemPath || !userId) return;
            try {
                // 收集所有需要更新的路径
                const pathParts = itemPath.split('/');
                const pathsToUpdate = [];
                
                for (let i = 1; i <= pathParts.length; i++) {
                    const p = pathParts.slice(0, i).join('/');
                    if (p) pathsToUpdate.push(p);
                }
                // 批量执行所有更新（交由通用批处理托管事务）
                const sql = "INSERT OR REPLACE INTO view_history (user_id, item_path, viewed_at) VALUES (?, ?, CURRENT_TIMESTAMP)";
                const rows = pathsToUpdate.map(p => [userId, p]);
                await runPreparedBatch('history', sql, rows, { chunkSize: 800 });
                
                logger.debug(`[HISTORY-WORKER] 批量更新了 ${pathsToUpdate.length} 个路径的查看时间 for user ${userId}`);

                // 清理缓存的逻辑 - 从旧版本迁移的重要功能
                const parentDirectoriesToClear = pathsToUpdate.map(p => path.dirname(p)).map(p => p === '.' ? '' : p);
                const uniqueParentDirs = [...new Set(parentDirectoriesToClear)];
                const keysToClear = new Set();
                
                for (const dir of uniqueParentDirs) {
                     const pattern = `route_cache:${userId}:/api/browse/${dir}*`;
                     const stream = redis.scanStream({ match: pattern });
                     for await (const keys of stream) {
                        keys.forEach(key => keysToClear.add(key));
                     }
                }
                
                if (keysToClear.size > 0) {
                    await redis.del(...keysToClear);
                    logger.info(`[HISTORY-WORKER] 因查看操作，清除了 ${keysToClear.size} 个相关缓存键`);
                }
                
            } catch (error) {
                logger.error(`[HISTORY-WORKER] 更新查看时间失败 for user ${userId}, path ${itemPath}: ${error.message}`);
            }
        }
    };

    // --- 严格串行处理队列，避免并发事务互相嵌套 ---
    const taskQueue = [];
    let processing = false;

    async function processNext() {
        if (processing || taskQueue.length === 0) return;
        processing = true;
        const task = taskQueue.shift();
        const handler = tasks[task.type];
        try {
            if (handler) {
                await handler(task.payload);
            } else {
                logger.warn(`[HISTORY-WORKER] 收到未知任务类型: ${task.type}`);
            }
        } catch (e) {
            logger.error(`[HISTORY-WORKER] 执行任务 ${task.type} 时发生未捕获的错误:`, e);
        } finally {
            processing = false;
            // 递归拉下一条，持续串行
            processNext();
        }
    }

    parentPort.on('message', (task) => {
        taskQueue.push(task);
        processNext();
    });
})(); 