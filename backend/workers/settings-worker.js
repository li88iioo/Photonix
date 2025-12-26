const { parentPort } = require('worker_threads');
const winston = require('winston');
const { TraceManager } = require('../utils/trace');
const { initializeConnections, getDB, runPreparedBatch } = require('../db/multi-db');
const { withTransaction } = require('../services/tx.manager');
const { redis } = require('../config/redis');
const { invalidateTags } = require('../services/cache.service.js');
const { safeRedisSet, safeRedisDel } = require('../utils/helpers');
const { createWorkerResult, createWorkerError } = require('../utils/workerMessage');
const maintenanceService = require('../services/settings/maintenance.service');

(async () => {
    await initializeConnections();
    // --- 日志配置 ---
    const loggerModule = require('../config/logger');
    const { formatLog, LOG_PREFIXES, normalizeMessagePrefix } = loggerModule;
    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp(),
            winston.format.printf(info => {
                const date = new Date(info.timestamp);
                const time = date.toTimeString().split(' ')[0];
                const normalized = normalizeMessagePrefix(info.message);
                return `[${time}] ${info.level}: ${LOG_PREFIXES.SETTINGS_WORKER || '设置线程'} ${normalized}`;
            })
        ),
        transports: [new winston.transports.Console()]
    });
    // --- 数据库配置 ---
    const db = getDB('settings');

    // better-sqlite3 wrapper
    const dbRun = (sql, params = []) => {
        try {
            const stmt = db.prepare(sql);
            const info = stmt.run(...params);
            return Promise.resolve({ lastID: info.lastInsertRowid, changes: info.changes });
        } catch (err) {
            return Promise.reject(err);
        }
    };

    const tasks = {
        async update_settings({ settingsToUpdate, updateId } = {}) {
            logger.info('开始更新配置...');

            // 标记任务处理中
            try {
                if (updateId) await safeRedisSet(redis, `settings_update_status:${updateId}`, JSON.stringify({ status: 'processing', updatedKeys: Object.keys(settingsToUpdate || {}), ts: Date.now() }), 'EX', 60, '设置更新状态-处理中');
            } catch (err) {
                logger.debug(`${LOG_PREFIXES.SETTINGS_WORKER} 设置Redis处理中状态失败: ${err.message}`);
            }

            try {
                const sql = 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)';
                const rows = Object.entries(settingsToUpdate).map(([k, v]) => [k, String(v)]);
                // 统一事务边界：用 withTransaction 包裹批写（runPreparedBatch 将感知外层事务）
                await withTransaction('settings', async () => {
                    // Native DB handling (busy_timeout) replaces application-layer retry
                    await runPreparedBatch('settings', sql, rows, { chunkSize: 500 });
                }, { mode: 'IMMEDIATE' });

                logger.info(`配置更新成功: ${Object.keys(settingsToUpdate).join(', ')}`);

                // 清理 Redis 中的 settings_cache_v1 (如果存在)
                await safeRedisDel(redis, 'settings_cache_v1', '删除设置缓存');

                // 使用新的基于标签的缓存失效机制
                // 任何设置变更都只影响被打上 'settings' 标签的缓存
                await invalidateTags('settings');

                parentPort && parentPort.postMessage(createWorkerResult({
                    type: 'settings_update_complete',
                    success: true,
                    updatedKeys: Object.keys(settingsToUpdate),
                    updateId
                }));

                try {
                    if (updateId) await safeRedisSet(redis, `settings_update_status:${updateId}`, JSON.stringify({ status: 'success', updatedKeys: Object.keys(settingsToUpdate || {}), ts: Date.now() }), 'EX', 300, '设置更新状态-成功');
                } catch (err) {
                    logger.debug(`${LOG_PREFIXES.SETTINGS_WORKER} 设置Redis成功状态失败: ${err.message}`);
                }

            } catch (error) {
                logger.error(`更新配置时发生错误: ${error.message}`);
                parentPort && parentPort.postMessage(createWorkerError({
                    type: 'settings_update_failed',
                    error,
                    updatedKeys: Object.keys(settingsToUpdate),
                    updateId
                }));
                try {
                    if (updateId) await safeRedisSet(redis, `settings_update_status:${updateId}`, JSON.stringify({ status: 'failed', message: error.message, updatedKeys: Object.keys(settingsToUpdate || {}), ts: Date.now() }), 'EX', 300, '设置更新状态-失败');
                } catch (err) {
                    logger.debug(`${LOG_PREFIXES.SETTINGS_WORKER} 设置Redis失败状态失败: ${err.message}`);
                }
            }
        }
        ,
        async thumbnail_reconcile({ limit } = {}) {
            try {
                const result = await maintenanceService.performThumbnailReconcileLocal({ limit });
                parentPort && parentPort.postMessage(createWorkerResult({ type: 'thumbnail_reconcile', result }));
            } catch (error) {
                parentPort && parentPort.postMessage(createWorkerError({ type: 'thumbnail_reconcile', error }));
            }
        },
        async hls_reconcile({ limit } = {}) {
            try {
                const result = await maintenanceService.performHlsReconcileOnceLocal(limit);
                parentPort && parentPort.postMessage(createWorkerResult({ type: 'hls_reconcile', result }));
            } catch (error) {
                parentPort && parentPort.postMessage(createWorkerError({ type: 'hls_reconcile', error }));
            }
        },
        async thumbnail_cleanup() {
            try {
                const result = await maintenanceService.performThumbnailCleanupLocal();
                parentPort && parentPort.postMessage(createWorkerResult({ type: 'thumbnail_cleanup', result }));
            } catch (error) {
                parentPort && parentPort.postMessage(createWorkerError({ type: 'thumbnail_cleanup', error }));
            }
        },
        async hls_cleanup() {
            try {
                const result = await maintenanceService.performHlsCleanupLocal();
                parentPort && parentPort.postMessage(createWorkerResult({ type: 'hls_cleanup', result }));
            } catch (error) {
                parentPort && parentPort.postMessage(createWorkerError({ type: 'hls_cleanup', error }));
            }
        }
    };

    parentPort.on('message', async (message) => {
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

        // 定义处理函数
        const processTask = async () => {
            const handler = tasks[task.type];
            if (handler) {
                try {
                    await handler(task.payload);
                } catch (e) {
                    logger.error(`执行任务 ${task.type} 时发生未捕获的错误:`, e);
                }
            } else {
                logger.warn(`收到未知任务类型: ${task.type}`);
            }
        };

        // 在追踪上下文中运行
        if (traceContext) {
            await TraceManager.run(traceContext, processTask);
        } else {
            await processTask();
        }
    });

})();
