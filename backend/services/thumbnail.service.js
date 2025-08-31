/**
 * 缩略图服务模块
 * 管理缩略图的生成、队列调度和工作线程协调，支持优先级队列和失败重试机制
 */
const crypto = require('crypto');
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { THUMBS_DIR, MAX_THUMBNAIL_RETRIES, INITIAL_RETRY_DELAY } = require('../config');
const { idleThumbnailWorkers } = require('./worker.manager');
const { Queue } = require('bullmq');
const { bullConnection } = require('../config/redis');
const { QUEUE_MODE, THUMBNAIL_QUEUE_NAME } = require('../config');
const { getThumbMaxConcurrency } = require('./adaptive.service');
const { indexingWorker } = require('./worker.manager');
const eventBus = require('./event.service');

// 环境检测：开发环境显示详细日志
const isDevelopment = process.env.NODE_ENV !== 'production';

// 缩略图任务队列管理
const highPriorityThumbnailQueue = [];  // 高优先级队列（浏览器直接请求）
const lowPriorityThumbnailQueue = [];   // 低优先级队列（后台批量生成）
const activeTasks = new Set();          // 正在处理的任务集合
const failureCounts = new Map();        // 任务失败次数统计
const failureTimestamps = new Map();    // 失败记录的时间戳

// 内存清理配置
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30分钟清理一次
const FAILURE_ENTRY_TTL_MS = 24 * 60 * 60 * 1000; // 失败记录保留24小时
const ACTIVE_TASK_TTL_MS = 60 * 60 * 1000; // 活动任务记录保留1小时

// 任务记录的时间戳追踪
const taskTimestamps = new Map();

// 定期清理过期记录
setInterval(() => {
    const now = Date.now();
    let cleanedFailures = 0;
    let cleanedTasks = 0;

    // 清理失败计数记录
    for (const [path, timestamp] of failureTimestamps.entries()) {
        if ((now - timestamp) > FAILURE_ENTRY_TTL_MS) {
            failureCounts.delete(path);
            failureTimestamps.delete(path);
            cleanedFailures++;
        }
    }

    // 清理活动任务记录（防止任务卡住）
    for (const path of activeTasks) {
        const timestamp = taskTimestamps.get(path);
        if (timestamp && (now - timestamp) > ACTIVE_TASK_TTL_MS) {
            activeTasks.delete(path);
            taskTimestamps.delete(path);
            cleanedTasks++;
        }
    }

    // 清理时间戳记录
    for (const [path, timestamp] of taskTimestamps.entries()) {
        if ((now - timestamp) > Math.max(FAILURE_ENTRY_TTL_MS, ACTIVE_TASK_TTL_MS)) {
            taskTimestamps.delete(path);
        }
    }

    if (cleanedFailures > 0 || cleanedTasks > 0) {
        logger.debug(`[THUMBNAIL CLEANUP] 清理了 ${cleanedFailures} 个失败记录和 ${cleanedTasks} 个过期任务`);
    }
}, CLEANUP_INTERVAL_MS);

// 更新任务时间戳的辅助函数
function updateTaskTimestamp(path) {
    taskTimestamps.set(path, Date.now());
}

// 缩略图状态批处理相关变量
const thumbStatusPending = new Map();
let thumbStatusFlushing = false;
let thumbStatusFlushScheduled = false;

// 添加锁机制防止竞态条件
const thumbStatusLock = {
    isLocked: false,
    queue: [],
    async acquire() {
        if (this.isLocked) {
            return new Promise(resolve => {
                this.queue.push(resolve);
            });
        }
        this.isLocked = true;
        return Promise.resolve();
    },
    release() {
        this.isLocked = false;
        const next = this.queue.shift();
        if (next) {
            this.isLocked = true;
            next();
        }
    }
};

function queueThumbStatusUpdate(relPath, mtime, status) {
    try {
        const prev = thumbStatusPending.get(relPath);
        if (!prev || (mtime || 0) >= (prev.mtime || 0)) {
            thumbStatusPending.set(relPath, { mtime: mtime || Date.now(), status });
        }
        if (!thumbStatusFlushScheduled) {
            thumbStatusFlushScheduled = true;
            setTimeout(flushThumbStatusBatch, 300);
        }
    } catch {}
}

async function flushThumbStatusBatch() {
    // 使用锁机制防止竞态条件
    await thumbStatusLock.acquire();
    
    try {
        if (thumbStatusPending.size === 0) return;
        
        const snapshot = Array.from(thumbStatusPending.entries());
        thumbStatusPending.clear();
        const rows = snapshot.map(([relPath, v]) => [relPath, v.mtime || Date.now(), v.status || 'pending']);
        
        if (rows.length === 0) return;
        
        try {
            const { runPreparedBatch } = require('../db/multi-db');
            const upsertSql = `INSERT INTO thumb_status(path, mtime, status, last_checked)
                               VALUES(?, ?, ?, strftime('%s','now')*1000)
                               ON CONFLICT(path) DO UPDATE SET
                                   mtime=excluded.mtime,
                                   status=excluded.status,
                                   last_checked=excluded.last_checked`;
            await runPreparedBatch('main', upsertSql, rows, { chunkSize: 800 });
        } catch (e) {
            logger.warn('批量写入缩略图状态失败，回退为逐条重试:', e.message);
            // 失败时回退为逐条重试（避免数据丢失）
            try {
                const { dbRun } = require('../db/multi-db');
                for (const [pathRel, mtime, status] of rows) {
                    try { 
                        await writeThumbStatusWithRetry(dbRun, { path: pathRel, mtime, status }); 
                    } catch (retryError) {
                        logger.error(`重试写入缩略图状态失败: ${pathRel}`, retryError.message);
                    }
                }
            } catch (fallbackError) {
                logger.error('回退重试机制也失败:', fallbackError.message);
            }
        }
    } finally {
        thumbStatusLock.release();
        
        // 如果还有待处理的数据，继续处理
        if (thumbStatusPending.size > 0 && !thumbStatusFlushScheduled) {
            thumbStatusFlushScheduled = true;
            setTimeout(flushThumbStatusBatch, 300);
        }
    }
}

/**
 * 以指数退避重试方式写入 thumb_status，自动绕过短暂的 SQLITE_BUSY
 * 并在索引进行中时适度延后以减少写-写冲突
 */
async function writeThumbStatusWithRetry(dbRun, { path: relPath, mtime, status }) {
    const maxRetries = 8;
    const baseDelay = 50; // ms
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // 索引进行中则小幅让路
            if (attempt === 0) {
                try {
                    const indexing = await redis.get('indexing_in_progress');
                    if (indexing) {
                        const delay = 150 + Math.floor(Math.random() * 150);
                        await new Promise(r => setTimeout(r, delay));
                    }
                } catch {}
            }
            await dbRun('main', `INSERT INTO thumb_status(path, mtime, status, last_checked)
                                  VALUES(?, ?, ?, strftime('%s','now')*1000)
                                  ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, status=excluded.status, last_checked=excluded.last_checked`,
                [relPath, mtime, status]);
            return; // success
        } catch (e) {
            const msg = e && e.message ? String(e.message) : '';
            if (!/SQLITE_BUSY|database is locked/i.test(msg) || attempt === maxRetries) {
                throw e;
            }
            const backoff = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 40);
            await new Promise(r => setTimeout(r, backoff));
        }
    }
}

/**
 * 设置缩略图工作线程监听器
 * 为每个空闲工作线程添加消息处理和错误监听
 */
function setupThumbnailWorkerListeners() {
    idleThumbnailWorkers.forEach((worker, index) => {
        // 监听工作线程完成消息
        worker.on('message', async (result) => {
            const { success, error, task, workerId, skipped, message } = result;
            const relativePath = task.relativePath;
            const workerLogId = `[THUMBNAIL-WORKER-${workerId || '?'}]`;
            const failureKey = `thumb_failed_permanently:${relativePath}`;

            if (success) {
                // 任务成功，从 activeTasks 中移除
                activeTasks.delete(relativePath);
                failureCounts.delete(relativePath);

                if (skipped) {
                    logger.debug(`${workerLogId} 跳过（已存在）: ${relativePath}`);
                } else {
                    logger.info(`${workerLogId} 生成完成: ${relativePath}`);
                }

                // 通过Redis发布订阅发送SSE事件通知前端（支持跨进程通信）
                await redis.publish('thumbnail-generated', JSON.stringify({ path: relativePath }));
                if (isDevelopment) {
                    logger.debug(`[THUMB] 已发布缩略图生成事件: ${relativePath}`);
                }

                // 同时在本进程内也触发事件，以防有其他监听器
                eventBus.emit('thumbnail-generated', { path: relativePath });
                await redis.del(failureKey).catch(err => logger.warn(`清理Redis永久失败标记时出错: ${err.message}`));
                try { await redis.incr('metrics:thumb:success'); } catch {}

                // 缩略图生成完成后，失效相关页面的缓存
                try {
                    const { invalidateTags } = require('./cache.service');
                    const dirname = path.dirname(relativePath);
                    const tags = [
                        `thumbnail:${relativePath}`,  // 缩略图自身缓存
                        `album:${dirname}`,           // 所属相册缓存
                        `album:/`                     // 根相册缓存
                    ];

                    await invalidateTags(tags);
                    if (isDevelopment) {
                        logger.debug(`[THUMB] 缓存失效完成，标签: ${tags.join(', ')}`);
                    }
                } catch (cacheError) {
                    logger.warn(`[CACHE] 失效缩略图缓存失败（已忽略）: ${cacheError.message}`);
                }

                try {
                    // 使用缩略图文件的mtime作为版本参数，而不是源文件的mtime
                    const isVideo = task.type === 'video';
                    const extension = isVideo ? '.jpg' : '.webp';
                    const thumbRelPath = task.relativePath.replace(/\.[^.]+$/, extension);
                    const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);
                    const thumbMtime = await fs.stat(thumbAbsPath).then(s => s.mtimeMs).catch(() => Date.now());
                    queueThumbStatusUpdate(task.relativePath, thumbMtime, 'exists');
                    logger.debug(`[THUMB] 更新缩略图状态: ${task.relativePath}, mtime: ${thumbMtime}`);
                } catch (dbErr) {
                    logger.warn(`写入 thumb_status 入队失败（成功分支，已忽略）：${dbErr && dbErr.message}`);
                }
            } else {
                // 针对“文件损坏/格式异常无法解析”的失败，进行专门的计数与阈值删除
                let deletedByCorruptionRule = false;
                try {
                    const CORRUPT_PARSE_SNIPPET = '损坏或格式异常，无法解析';
                    if (typeof message === 'string' && message.includes(CORRUPT_PARSE_SNIPPET)) {
                        const corruptionKey = `thumb_corrupt_parse_count:${relativePath}`;
                        const corruptCount = await redis.incr(corruptionKey).catch(() => 0);
                        // 设置一个较长的过期时间，便于跨进程/重启累计
                        if (corruptCount === 1) {
                            try { await redis.expire(corruptionKey, 3600 * 24 * 30); } catch {}
                        }
                        // 可观测性：输出一次计数日志，便于在容器日志中追踪累计情况
                        try {
                            logger.warn(`${workerLogId} [CORRUPT_PARSE_COUNT] 发现文件损坏: ${relativePath} | count=${corruptCount}/10 | reason=${message}`);
                        } catch {}
                        if (corruptCount >= 10) {
                            try {
                                // 达到阈值：直接删除原始文件，避免反复重试
                                await fs.unlink(task.filePath).catch(() => {});
                                logger.error(`${workerLogId} [CORRUPTED_IMAGE_DELETED] 已因出现 ${corruptCount} 次“${CORRUPT_PARSE_SNIPPET}”而删除源文件: ${task.filePath} (relative=${relativePath})`);
                                // 清理状态与计数，避免后续重复处理
                                activeTasks.delete(relativePath);
                                failureCounts.delete(relativePath);
                                try { await redis.set(failureKey, '1', 'EX', 3600 * 24 * 7); } catch {}
                                try { await redis.del(corruptionKey); } catch {}
                                deletedByCorruptionRule = true;
                            } catch (delErr) {
                                logger.warn(`${workerLogId} 触发阈值删除失败（已忽略重试逻辑）：${delErr && delErr.message}`);
                                deletedByCorruptionRule = true; // 即便删除失败，也不再重试本次任务
                            }
                        }
                    }
                } catch {}

                const currentFailures = (failureCounts.get(relativePath) || 0) + 1;
                failureCounts.set(relativePath, currentFailures);
                failureTimestamps.set(relativePath, Date.now()); // 记录时间戳用于清理
                updateTaskTimestamp(relativePath);
                logger.error(`${workerLogId} 处理任务失败: ${relativePath} (第 ${currentFailures} 次)。错误: ${error}`);
                try { await redis.incr('metrics:thumb:fail'); } catch {}

                if (deletedByCorruptionRule) {
                    // 已按“损坏阈值”策略处理（删除/跳过），不再入队重试
                } else if (currentFailures < MAX_THUMBNAIL_RETRIES) {
                    // 任务失败但可重试，暂时不从 activeTasks 移除，避免竞态条件
                    const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, currentFailures - 1);
                    logger.warn(`任务 ${relativePath} 将在 ${retryDelay / 1000}秒 后重试...`);
                    setTimeout(() => {
                        // 在真正重新入队前再从 activeTasks 移除，避免竞态且不阻塞重试派发
                        activeTasks.delete(relativePath);
                        highPriorityThumbnailQueue.unshift(task);
                        dispatchThumbnailTask();
                    }, retryDelay);
                } else {
                    // 达到最大重试次数，标记为永久失败，并从 activeTasks 移除
                    activeTasks.delete(relativePath);
                    logger.error(`任务 ${relativePath} 已达到最大重试次数 (${MAX_THUMBNAIL_RETRIES}次)，标记为永久失败。`);
                    await redis.set(failureKey, '1', 'EX', 3600 * 24 * 7); // 缓存7天
                    try { await redis.incr('metrics:thumb:permanent_fail'); } catch {}
                }

                try {
                    const srcMtime = await fs.stat(task.filePath).then(s => s.mtimeMs).catch(() => Date.now());
                    queueThumbStatusUpdate(relativePath, srcMtime, 'failed');
                } catch (dbErr) {
                    logger.warn(`写入 thumb_status 入队失败（失败分支，已忽略）：${dbErr && dbErr.message}`);
                }
            }

            // 将工作线程放回空闲队列，继续处理下一个任务
            idleThumbnailWorkers.push(worker);
            // 维护活动计数
            try {
                if (result && result.task && result.task.relativePath && activeTasks.has(result.task.relativePath)) {
                    // 已在上面 activeTasks.delete 过，这里仅做兜底
                }
            } catch {}
            global.__thumbActiveCount = Math.max(0, (global.__thumbActiveCount || 0) - 1);
            dispatchThumbnailTask();
        });

        // 监听工作线程错误和退出事件
        worker.on('error', (err) => logger.error(`缩略图工人 ${index + 1} 遇到错误:`, err));
        worker.on('exit', (code) => {
            if (code !== 0) logger.warn(`缩略图工人 ${index + 1} 退出，代码: ${code}`);
        });
    });
}

/**
 * 调度缩略图任务
 * 从队列中取出任务分配给空闲的工作线程
 */
function dispatchThumbnailTask() {
    // 自适应限制同时占用的空闲工人数量，避免低负载模式下打满
    const maxConcurrent = Math.max(1, Number(getThumbMaxConcurrency() || 1));
    while (idleThumbnailWorkers.length > 0) {
        let task = null;
        
        // 优先处理高优先级队列中的任务
        if (highPriorityThumbnailQueue.length > 0) {
            task = highPriorityThumbnailQueue.shift();
        } else if (lowPriorityThumbnailQueue.length > 0) {
            // 不占用最后一个空闲工人，预留以便随时响应用户操作（高优先级）
            if (idleThumbnailWorkers.length > 1) {
                task = lowPriorityThumbnailQueue.shift();
            } else {
                break;
            }
        } else {
            break; // 没有任务可处理
        }

        // 额外防御：若拿到非媒体任务（历史脏数据或外部注入），直接丢弃并继续
        if (!task || !/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(task.filePath || task.relativePath || '')) {
            continue;
        }

        // 限制最大同时派发量
        if ((global.__thumbActiveCount || 0) >= maxConcurrent) {
            // 达到并发上限，放回队首便于下轮继续尝试
            if (task) {
                if (task.type === 'video') highPriorityThumbnailQueue.unshift(task); else lowPriorityThumbnailQueue.unshift(task);
            }
            break;
        }
        const worker = idleThumbnailWorkers.shift();
        
        // 检查任务是否已在处理中，避免重复处理
        if (activeTasks.has(task.relativePath)) {
            idleThumbnailWorkers.push(worker); // 将工作线程放回空闲队列
            continue;
        }

        // 标记任务为活动状态，发送给工作线程处理
        activeTasks.add(task.relativePath);
        updateTaskTimestamp(task.relativePath);
        global.__thumbActiveCount = (global.__thumbActiveCount || 0) + 1;
        worker.postMessage({ ...task, thumbsDir: THUMBS_DIR });
    }
}

/**
 * 检查任务是否已在队列或正在处理中
 * @param {string} relativePath - 相对路径
 * @returns {boolean} 如果任务已排队或正在处理返回true
 */
function isTaskQueuedOrActive(relativePath) {
    if (activeTasks.has(relativePath)) return true;
    if (highPriorityThumbnailQueue.some(t => t.relativePath === relativePath)) return true;
    if (lowPriorityThumbnailQueue.some(t => t.relativePath === relativePath)) return true;
    return false;
}

/**
 * 确保缩略图存在
 * 检查缩略图是否存在，不存在则创建生成任务
 * @param {string} sourceAbsPath - 源文件绝对路径
 * @param {string} sourceRelPath - 源文件相对路径
 * @returns {Promise<Object>} 缩略图状态信息
 */
async function ensureThumbnailExists(sourceAbsPath, sourceRelPath) {
    // 检查是否包含 @eaDir，如果是则直接返回失败状态
    if (sourceRelPath.includes('@eaDir')) {
        logger.debug(`跳过 @eaDir 文件的缩略图生成: ${sourceRelPath}`);
        return { status: 'failed' };
    }

    // 根据文件类型确定缩略图格式
    const isVideo = /\.(mp4|webm|mov)$/i.test(sourceAbsPath);
    const extension = isVideo ? '.jpg' : '.webp';
    const thumbRelPath = sourceRelPath.replace(/\.[^.]+$/, extension);
    const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);
    // 修复：使用API调用方式生成缩略图URL，与文件服务保持一致
    const thumbUrl = `/api/thumbnail?path=${encodeURIComponent(sourceRelPath)}`;

    try {
        // 检查缩略图文件是否存在
        await fs.access(thumbAbsPath);
        return { status: 'exists', path: thumbUrl };
    } catch (e) {
        // 检查是否已标记为永久失败
        const isPermanentlyFailed = await redis.get(`thumb_failed_permanently:${sourceRelPath}`);
        if (isPermanentlyFailed) {
            return { status: 'failed' };
        }

        // 入队：队列模式 or 本地模式
        if (QUEUE_MODE) {
            try {
                const queue = new Queue(THUMBNAIL_QUEUE_NAME, { connection: bullConnection });
                await queue.add('thumb', { filePath: sourceAbsPath, relativePath: sourceRelPath, type: isVideo ? 'video' : 'photo' }, {
                    priority: 1,
                    attempts: 3,
                    removeOnComplete: 1000,
                    removeOnFail: 200,
                });
                logger.info(`[队列] 已入队缩略图任务: ${sourceRelPath}`);
            } catch (e) {
                logger.warn(`[队列] 入队缩略图任务失败，回退本地队列: ${e && e.message}`);
                highPriorityThumbnailQueue.unshift({ filePath: sourceAbsPath, relativePath: sourceRelPath, type: isVideo ? 'video' : 'photo' });
                dispatchThumbnailTask();
            }
        } else {
            // 本地队列
            if (!isTaskQueuedOrActive(sourceRelPath)) {
                logger.info(`[高优先级] 浏览器请求缩略图 ${sourceRelPath}，任务插入VIP队列。`);
                highPriorityThumbnailQueue.unshift({
                    filePath: sourceAbsPath,
                    relativePath: sourceRelPath,
                    type: isVideo ? 'video' : 'photo'
                });
                dispatchThumbnailTask();
            } else {
                logger.debug(`缩略图 ${sourceRelPath} 已在队列或正在处理中，等待完成。`);
            }
        }

        return { status: 'processing' };
    }
}

/**
 * 启动空闲缩略图生成任务
 * 向索引工作线程请求所有媒体文件，用于后台批量生成缩略图
 */
async function startIdleThumbnailGeneration() {
    if (QUEUE_MODE) {
        logger.info('[队列] 略过本地批量后台生成，由维护任务批量入队。');
        return;
    }
    logger.info('[Main-Thread] 准备启动智能缩略图后台生成任务...');
    indexingWorker.postMessage({ type: 'get_all_media_items' });
}

// 导出缩略图服务函数
module.exports = {
    setupThumbnailWorkerListeners,    // 设置工作线程监听器
    dispatchThumbnailTask,            // 调度缩略图任务
    isTaskQueuedOrActive,             // 检查任务状态
    ensureThumbnailExists,            // 确保缩略图存在
    startIdleThumbnailGeneration,     // 启动后台生成任务
    lowPriorityThumbnailQueue,        // 低优先级队列（供外部访问）
    queueThumbStatusUpdate,           // 队列缩略图状态更新（供队列工作进程使用）
};