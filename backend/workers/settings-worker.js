const { parentPort } = require('worker_threads');
const { Worker } = require('bullmq');
const winston = require('winston');
const { initializeConnections, getDB, runPreparedBatch } = require('../db/multi-db');
const { redis } = require('../config/redis');
const { invalidateTags } = require('../services/cache.service.js');

(async () => {
    await initializeConnections();
    // --- 日志配置 ---
    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] [SETTINGS-WORKER] ${info.level}: ${info.message}`)),
        transports: [new winston.transports.Console()]
    });
    // --- 数据库配置 ---
    const db = getDB('settings');

    const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) { if (err) rej(err); else res(this); }));

    const tasks = {
        async update_settings({ settingsToUpdate, updateId } = {}) {
            logger.info(`[SETTINGS-WORKER] 开始更新配置...`);
            
            const maxRetries = 3;
            let retryCount = 0;

            // 标记任务处理中
            try {
                if (updateId) await redis.set(`settings_update_status:${updateId}` , JSON.stringify({ status: 'processing', updatedKeys: Object.keys(settingsToUpdate||{}), ts: Date.now() }), 'EX', 60);
            } catch {}
            
            while (retryCount < maxRetries) {
                try {
                    const sql = 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)';
                    const rows = Object.entries(settingsToUpdate).map(([k, v]) => [k, String(v)]);
                    // 交由通用批处理托管事务
                    await runPreparedBatch('settings', sql, rows, { chunkSize: 500 });

                    logger.info('[SETTINGS-WORKER] 配置更新成功:', Object.keys(settingsToUpdate).join(', '));

                    // 清理 Redis 中的 settings_cache_v1 (如果存在)
                    await redis.del('settings_cache_v1').catch(e => logger.warn(`删除 Redis 设置缓存失败: ${e && e.message}`));

                    // 使用新的基于标签的缓存失效机制
                    // 任何设置变更都只影响被打上 'settings' 标签的缓存
                    await invalidateTags('settings');
                    
                    parentPort && parentPort.postMessage({ 
                        type: 'settings_update_complete', 
                        success: true, 
                        updatedKeys: Object.keys(settingsToUpdate) 
                    });

                    try {
                        if (updateId) await redis.set(`settings_update_status:${updateId}` , JSON.stringify({ status: 'success', updatedKeys: Object.keys(settingsToUpdate||{}), ts: Date.now() }), 'EX', 300);
                    } catch {}
                    
                    return; // 成功，退出循环
                    
                } catch (error) {
                    retryCount++;
                    
                    if (error.message.includes('SQLITE_BUSY') && retryCount < maxRetries) {
                        const delay = retryCount * 2000;
                        logger.warn(`[SETTINGS-WORKER] 数据库繁忙，${delay}ms后重试 (${retryCount}/${maxRetries}): ${error.message}`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                    
                    logger.error('[SETTINGS-WORKER] 更新配置时发生错误:', error.message);
                    parentPort && parentPort.postMessage({ 
                        type: 'settings_update_failed', 
                        error: error.message,
                        updatedKeys: Object.keys(settingsToUpdate)
                    });
                    try {
                        if (updateId) await redis.set(`settings_update_status:${updateId}` , JSON.stringify({ status: 'failed', message: error.message, updatedKeys: Object.keys(settingsToUpdate||{}), ts: Date.now() }), 'EX', 300);
                    } catch {}
                    return; // 失败，退出循环
                }
            }
        }
    };

    parentPort.on('message', async (task) => {
        const handler = tasks[task.type];
        if (handler) {
            try {
                await handler(task.payload);
            } catch (e) {
                logger.error(`[SETTINGS-WORKER] 执行任务 ${task.type} 时发生未捕获的错误:`, e);
            }
        } else {
            logger.warn(`[SETTINGS-WORKER] 收到未知任务类型: ${task.type}`);
        }
    });

    // 兼容 BullMQ 队列消费（可与线程消息并存，避免迁移中断）
    try {
        const { bullConnection } = require('../config/redis');
        const { SETTINGS_QUEUE_NAME } = require('../config');
        // 创建一个 BullMQ Worker 监听设置队列
        new Worker(SETTINGS_QUEUE_NAME, async job => {
            const { settingsToUpdate, updateId } = job.data || {};
            if (!settingsToUpdate || typeof settingsToUpdate !== 'object') {
                throw new Error('无效的设置任务数据');
            }
            await tasks.update_settings({ settingsToUpdate, updateId });
            return { success: true, updatedKeys: Object.keys(settingsToUpdate), updateId };
        }, { connection: bullConnection });
        logger.info(`[SETTINGS-WORKER] 已启动 BullMQ 队列消费者：${SETTINGS_QUEUE_NAME}`);
    } catch (e) {
        logger.warn('[SETTINGS-WORKER] 启动 BullMQ 队列消费者失败（忽略，仍支持线程消息）：', e && e.message);
    }
})();