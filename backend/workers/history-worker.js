const { parentPort } = require('worker_threads');
const winston = require('winston');
const { initializeConnections } = require('../db/multi-db');

(async () => {
    // 初始化连接（不包括 history.db）
    await initializeConnections();

    // --- 日志配置 ---
    const { LOG_PREFIXES, normalizeMessagePrefix } = require('../config/logger');
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

    // --- 历史记录任务处理器 ---
    const tasks = {
        async update_view_time({ userId, path: itemPath }) {
            // 空操作：后端不再记录历史
            // logger.debug(`[历史线程] 忽略后端历史记录写入: ${itemPath}`);
        }
    };

    // --- 消息处理 ---
    parentPort.on('message', async (message) => {
        const task = message && message.type ? message : (message && message.payload ? message.payload : message);
        const handler = tasks[task.type];
        if (handler) {
            try {
                await handler(task.payload);
            } catch (e) {
                logger.error(`执行任务 ${task.type} 失败:`, e);
            }
        }
    });
})(); 