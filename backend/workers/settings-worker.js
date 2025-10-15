const { parentPort } = require('worker_threads');
/* BullMQ 将在启用 Redis 时按需加载 */
const winston = require('winston');
const { TraceManager } = require('../utils/trace');
const { initializeConnections, getDB, runPreparedBatch } = require('../db/multi-db');
const { withTransaction } = require('../services/tx.manager');
const { redis } = require('../config/redis');
const { runPreparedBatchWithRetry } = require('../db/sqlite-retry');
const { invalidateTags } = require('../services/cache.service.js');
const { safeRedisSet, safeRedisDel } = require('../utils/helpers');
const { createWorkerResult, createWorkerError } = require('../utils/workerMessage');

(async () => {
    await initializeConnections();
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
                return `[${time}] ${info.level}: ${LOG_PREFIXES.SETTINGS_WORKER || '设置线程'} ${normalized}`;
            })
        ),
        transports: [new winston.transports.Console()]
    });
    // --- 数据库配置 ---
    const db = getDB('settings');

    const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) { if (err) rej(err); else res(this); }));

    const tasks = {
        async update_settings({ settingsToUpdate, updateId } = {}) {
            logger.info('开始更新配置...');
            
            const maxRetries = 3;
            let retryCount = 0;

            // 标记任务处理中
            try {
                if (updateId) await safeRedisSet(redis, `settings_update_status:${updateId}`, JSON.stringify({ status: 'processing', updatedKeys: Object.keys(settingsToUpdate||{}), ts: Date.now() }), 'EX', 60, '设置更新状态-处理中');
            } catch (err) {
                logger.debug(`[SettingsWorker] 设置Redis处理中状态失败: ${err.message}`);
            }
            
            while (retryCount < maxRetries) {
                try {
                    const sql = 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)';
                    const rows = Object.entries(settingsToUpdate).map(([k, v]) => [k, String(v)]);
                    // 统一事务边界：用 withTransaction 包裹批写（runPreparedBatch 将感知外层事务）
                    await withTransaction('settings', async () => {
                        await runPreparedBatchWithRetry(runPreparedBatch, 'settings', sql, rows, { chunkSize: 500 }, redis);
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
                        if (updateId) await safeRedisSet(redis, `settings_update_status:${updateId}`, JSON.stringify({ status: 'success', updatedKeys: Object.keys(settingsToUpdate||{}), ts: Date.now() }), 'EX', 300, '设置更新状态-成功');
                    } catch (err) {
                        logger.debug(`[SettingsWorker] 设置Redis成功状态失败: ${err.message}`);
                    }
                    
                    return; // 成功，退出循环
                    
                } catch (error) {
                    retryCount++;
                    
                    if (error.message.includes('SQLITE_BUSY') && retryCount < maxRetries) {
                        const delay = retryCount * 2000;
                        logger.warn(`数据库繁忙，${delay}ms后重试 (${retryCount}/${maxRetries}): ${error.message}`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                    
                    logger.error(`更新配置时发生错误: ${error.message}`);
                    parentPort && parentPort.postMessage(createWorkerError({
                        type: 'settings_update_failed',
                        error,
                        updatedKeys: Object.keys(settingsToUpdate),
                        updateId
                    }));
                    try {
                        if (updateId) await safeRedisSet(redis, `settings_update_status:${updateId}`, JSON.stringify({ status: 'failed', message: error.message, updatedKeys: Object.keys(settingsToUpdate||{}), ts: Date.now() }), 'EX', 300, '设置更新状态-失败');
                    } catch (err) {
                        logger.debug(`[SettingsWorker] 设置Redis失败状态失败: ${err.message}`);
                    }
                    return; // 失败，退出循环
                }
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

    // 兼容 BullMQ 队列消费（可与线程消息并存，避免迁移中断）
    try {
        const { bullConnection, getAvailability } = require('../config/redis');
        const { SETTINGS_QUEUE_NAME } = require('../config');
        // 创建一个 BullMQ Worker 监听设置队列（仅在 Redis 启用且就绪时）
        const availability = typeof getAvailability === 'function' ? getAvailability() : (bullConnection ? 'ready' : 'disabled');
        if (bullConnection && availability === 'ready') {
            const { Worker } = require('bullmq');
            new Worker(SETTINGS_QUEUE_NAME, async job => {
                const { settingsToUpdate, updateId } = job.data || {};
                if (!settingsToUpdate || typeof settingsToUpdate !== 'object') {
                    const { ValidationError } = require('../utils/errors');
                    throw new ValidationError('无效的设置任务数据', { jobData: job.data });
                }
                await tasks.update_settings({ settingsToUpdate, updateId });
                return { success: true, updatedKeys: Object.keys(settingsToUpdate), updateId };
            }, { connection: bullConnection });
            logger.info(`已启动 BullMQ 队列消费者：${SETTINGS_QUEUE_NAME}`);
        } else {
            logger.info(`跳过 BullMQ 消费者（Redis 未启用或未就绪: ${typeof availability !== 'undefined' ? availability : 'unknown'}），使用线程消息回退`);
        }
    } catch (e) {
        logger.warn(`启动 BullMQ 队列消费者失败（忽略，仍支持线程消息）：${e && e.message}`);
    }
})();