const { parentPort } = require('worker_threads');
const path = require('path');
const winston = require('winston');
const { TraceManager } = require('../utils/trace');
const { initializeConnections, getDB, runPreparedBatch } = require('../db/multi-db');
const { withTransaction } = require('../services/tx.manager');
const { redis } = require('../config/redis');
const { safeRedisDel } = require('../utils/helpers');
const { runPreparedBatchWithRetry } = require('../db/sqlite-retry');

(async () => {
    await initializeConnections();
    // 兜底：确保主库核心表存在，避免并发竞态导致其他模块引用时报错
    try {
        const { ensureCoreTables } = require('../db/migrations');
        await ensureCoreTables();
    } catch (error) {
        // 表初始化失败，记录但不阻止worker启动
        // 注意：此时logger尚未初始化，需要先加载logger模块
        const { formatLog, LOG_PREFIXES } = require('../config/logger');
        const tempLogger = require('../config/logger');
        tempLogger.error(`${LOG_PREFIXES.HISTORY_WORKER || '[历史线程]'} 初始化核心表失败:`, error.message);
    }
    // --- 日志配置 ---
    const { formatLog, LOG_PREFIXES, normalizeMessagePrefix } = require('../config/logger');
    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp(),
            winston.format.printf(info => {
                const date = new Date(info.timestamp);
                const time = date.toTimeString().split(' ')[0];
                const normalized = normalizeMessagePrefix(info.message);
                return `[${time}] ${info.level}: ${LOG_PREFIXES.HISTORY_WORKER || '历史线程'} ${normalized}`;
            })
        ),
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
                await withTransaction('history', async () => {
                    await runPreparedBatchWithRetry(runPreparedBatch, 'history', sql, rows, { chunkSize: 800 }, redis);
                }, { mode: 'IMMEDIATE' });
                
                logger.debug(`批量更新了 ${pathsToUpdate.length} 个路径的查看时间 for user ${userId}`);

                // 清理缓存的逻辑 - 从旧版本迁移的重要功能
                const parentDirectoriesToClear = pathsToUpdate.map(p => path.dirname(p)).map(p => p === '.' ? '' : p);
                const uniqueParentDirs = [...new Set(parentDirectoriesToClear)];
                const keysToClear = new Set();
                
                for (const dir of uniqueParentDirs) {
                    const pattern = `route_cache:${userId}:/api/browse/${dir}*`;

                    // 当 Redis 可用时使用事件模型消费 scanStream；No-Op 或无此方法时跳过
                    if (redis && !redis.isNoRedis && typeof redis.scanStream === 'function') {
                        const stream = redis.scanStream({ match: pattern });
                        await new Promise((resolve, reject) => {
                            try {
                                stream.on('data', (keys) => {
                                    try {
                                        for (const key of keys) keysToClear.add(key);
                                    } catch (collectErr) {
                                        logger.silly(`[历史线程] 缓存键采集失败（忽略）: ${collectErr && collectErr.message}`);
                                    }
                                });
                                stream.on('end', resolve);
                                stream.on('error', reject);
                            } catch (scanErr) {
                                logger.debug(`[历史线程] 缓存扫描降级: ${scanErr && scanErr.message}`);
                                resolve();
                            }
                        });
                    }
                    // else: 无 Redis 或不支持 scanStream，直接跳过清理（功能性退化）
                }
                
                if (keysToClear.size > 0) {
                    await safeRedisDel(redis, Array.from(keysToClear), '查看历史缓存清理');
                    logger.info(`因查看操作，清除了 ${keysToClear.size} 个相关缓存键`);
                }
                
            } catch (error) {
                logger.error(`更新查看时间失败 for user ${userId}, path ${itemPath}: ${error.message}`);
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
                logger.warn(`收到未知任务类型: ${task.type}`);
            }
        } catch (e) {
            logger.error(`执行任务 ${task.type} 时发生未捕获的错误:`, e);
        } finally {
            processing = false;
            // 递归拉下一条，持续串行
            processNext();
        }
    }

    parentPort.on('message', (message) => {
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
        
        // 如果有追踪上下文，在上下文中执行
        if (traceContext) {
            TraceManager.run(traceContext, () => {
                taskQueue.push(task);
                processNext();
            });
        } else {
            taskQueue.push(task);
            processNext();
        }
    });
})(); 