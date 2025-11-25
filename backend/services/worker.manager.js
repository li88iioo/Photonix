/**
 * 工作线程管理器模块（简化版）
 *
 * 该模块负责集中管理各类后台任务的 Node.js worker_threads 工作线程，包括线程池、重启机制、
 * 资源监控、任务队列与优先级控制、健康检查、扩缩容等。移除传统队列模式的复杂性，仅保留
 * 并发和状态跟踪。支持惰性单例线程和缩略图多线程池等不同调度方式。
 *
 * 依赖：
 *   - Node.js worker_threads
 *   - 项目配置 config
 *   - 日志 logger
 *   - 状态管理 state.manager
 *   - 跟踪/链路 TraceManager
 *   - 工具函数 normalizeWorkerMessage
 *   - 以及自定义错误类型
 */

// --- 核心依赖 ---
const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('../config/logger');
const { NUM_WORKERS } = require('../config');
const state = require('./state.manager');
const { TraceManager } = require('../utils/trace');
const { normalizeWorkerMessage } = require('../utils/workerMessage');

// --- 全局初始化参数与元数据 ---
// 初始缩略图工作线程数量，受环境变量和最大并发限制
const INITIAL_THUMB_WORKERS = (() => {
    const requested = Number(process.env.THUMB_INITIAL_WORKERS);
    if (Number.isFinite(requested) && requested > 0) {
        return Math.min(Math.floor(requested), NUM_WORKERS || 1);
    }
    return 1;
})();

// 调度器任务统计指标
const schedulerMetrics = {
    queued: 0,             // 等待中的任务数
    processing: 0,         // 正在处理的任务数
    pending: 0,            // 排队+处理中
    completed: 0,          // 成功完成数
    failed: 0,             // 失败总数
    retries: 0,            // 重试次数
    lastError: null,       // 最后错误信息
    lastFailureAt: null,   // 最后失败时间戳
    lastUpdatedAt: 0       // 最后更新时间戳
};
state.worker.setTaskMetrics(schedulerMetrics);

// 视频处理任务指标
const videoMetrics = {
    pending: 0,             // 等待中
    completed: 0,           // 成功
    failed: 0,              // 失败
    lastError: null,        // 最后错误信息
    lastFailureAt: null,    // 最后失败时间
    lastQueuedAt: null,     // 最后入队时间
    lastCompletedPath: null,// 最后处理成功的文件
    lastQueuedPath: null,   // 最后入队的文件
    workerState: 'inactive',// 当前worker运行状态
    lastUpdatedAt: 0
};
state.worker.setVideoMetrics(videoMetrics);

// worker重启相关配置与追踪
const MAX_WORKER_RESTART_ATTEMPTS = Math.max(1, Number(process.env.WORKER_RESTART_MAX_ATTEMPTS || 5));
const WORKER_RESTART_BASE_DELAY_MS = Math.max(250, Number(process.env.WORKER_RESTART_BASE_DELAY_MS || 1000));
const WORKER_RESTART_MAX_DELAY_MS = Math.max(WORKER_RESTART_BASE_DELAY_MS, Number(process.env.WORKER_RESTART_MAX_DELAY_MS || 30000));

// --- 核心worker全局状态 ---
const coreWorkerStates = {
    indexing: { state: 'inactive', lastUpdatedAt: 0 },
    settings: { state: 'inactive', lastUpdatedAt: 0 },
    history: { state: 'inactive', lastUpdatedAt: 0 },
    video: { state: 'inactive', lastUpdatedAt: 0 }
};

// worker重启任务追踪
const workerRestartTrack = new Map();

/**
 * 忽略worker异常日志输出（仅debug/silly用）
 * @param {string} scope
 * @param {Error} error
 */
function logWorkerIgnore(scope, error) {
    if (!error) return;
    logger.silly(`[WorkerManager] ${scope} 忽略异常: ${error.message}`);
}

/**
 * 统一规范worker日志通道输出
 * @param {string} scope
 * @param {object} payload
 */
function logWorkerChannel(scope, payload = {}) {
    if (!payload) return;
    const level = typeof payload.level === 'string' && typeof logger[payload.level] === 'function'
        ? payload.level
        : 'debug';
    const message = payload.message || payload.text || 'worker log';
    const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
    logger[level](`[${scope}] ${message}`, meta);
}

/**
 * worker名称到核心key映射
 */
const workerNameKeyMap = {
    indexingWorker: 'indexing',
    settingsWorker: 'settings',
    historyWorker: 'history',
    videoWorker: 'video'
};

// --- 初始化核心worker状态 ---
Object.keys(coreWorkerStates).forEach((key) => {
    try {
        state.worker.setWorkerStatus(key, coreWorkerStates[key]);
    } catch (error) {
        logger.debug('[WorkerState] 初始化核心worker状态失败（忽略）:', error && error.message);
    }
});

/**
 * 更新指定核心worker状态，写入全局快照（带自动时间戳）
 * @param {string} name
 * @param {object} patch
 */
function updateCoreWorkerState(name, patch = {}) {
    if (!name) return;
    const current = coreWorkerStates[name] || { state: 'unknown', lastUpdatedAt: 0 };
    const next = Object.assign({}, current, patch, { lastUpdatedAt: Date.now() });
    coreWorkerStates[name] = next;
    try {
        state.worker.setWorkerStatus(name, next);
    } catch (error) {
        logger.debug('[WorkerState] 写入核心worker状态失败（忽略）:', error && error.message);
    }
}

/**
 * worker重启计数器归零
 * @param {string} name
 */
function resetWorkerRestartTracker(name) {
    const info = workerRestartTrack.get(name);
    if (info && info.timer) {
        clearTimeout(info.timer);
    }
    workerRestartTrack.delete(name);
}

/**
 * 单例引用清理，用于重启/销毁时反注册
 * @param {string} name
 */
function clearWorkerReference(name) {
    switch (name) {
        case 'indexing':
            __indexingWorker = null;
            break;
        case 'settings':
            __settingsWorker = null;
            break;
        case 'history':
            __historyWorker = null;
            break;
        case 'video':
            __videoWorker = null;
            break;
        default:
            break;
    }
}

/**
 * 按名称调度worker重启（带指数回退和失败保护）
 * @param {string} name
 */
function scheduleWorkerRestart(name) {
    if (!name) return;

    const info = workerRestartTrack.get(name) || { attempts: 0, timer: null };
    if (info.timer) {
        return; // 已安排重启
    }

    if (info.attempts >= MAX_WORKER_RESTART_ATTEMPTS) {
        updateCoreWorkerState(name, { state: 'failed', lastError: 'restart_attempts_exceeded' });
        return;
    }

    const attempts = info.attempts + 1;
    const delay = Math.min(WORKER_RESTART_MAX_DELAY_MS, WORKER_RESTART_BASE_DELAY_MS * Math.pow(2, attempts - 1));

    updateCoreWorkerState(name, { state: 'restarting', restartAttempts: attempts, restartInMs: delay });

    info.attempts = attempts;
    info.timer = setTimeout(() => {
        info.timer = null;
        try {
            spawnCoreWorker(name);
            resetWorkerRestartTracker(name);
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            updateCoreWorkerState(name, { state: 'errored', lastError: message, restartAttempts: attempts });
            if (attempts < MAX_WORKER_RESTART_ATTEMPTS) {
                scheduleWorkerRestart(name);
            } else {
                logger.error(`[WorkerRestart] ${name} 重启失败，已达到最大尝试次数: ${message}`);
            }
        }
    }, delay);

    workerRestartTrack.set(name, info);
}

/**
 * worker创建后记录并绑定核心生命周期事件
 * @param {string} name
 * @param {Worker} worker
 */
function noteWorkerCreated(name, worker) {
    if (!name || !worker) return;
    resetWorkerRestartTracker(name);
    updateCoreWorkerState(name, {
        state: 'starting',
        threadId: worker.threadId,
        startedAt: Date.now()
    });
    if (!worker.__coreStatusHooked) {
        worker.once('online', () => {
            updateCoreWorkerState(name, {
                state: 'active',
                threadId: worker.threadId,
                onlineAt: Date.now()
            });
        });
        worker.__coreStatusHooked = true;
    }
}

/**
 * 触发式重建指定核心worker实例
 * @param {string} name
 * @returns {Worker}
 */
function spawnCoreWorker(name) {
    switch (name) {
        case 'indexing':
            clearWorkerReference(name);
            return getIndexingWorker();
        case 'settings':
            clearWorkerReference(name);
            return getSettingsWorker();
        case 'video':
            clearWorkerReference(name);
            return startVideoWorker();
        default:
            throw new Error(`Unknown core worker: ${name}`);
    }
}

/* ---- 单例worker实例存储（惰性/内存级） ---- */
let __indexingWorker = null;
let __settingsWorker = null;
let __historyWorker = null;
let __videoWorker = null;

/**
 * Worker任务调度器
 * 以优先级队列模式调度异步任务，自动重试和最大并发保护，通用worker适配
 */
class WorkerTaskScheduler {
    constructor() {
        this.taskQueue = [];
        this.processingTasks = new Map();
        this.taskTimeouts = new Map();
        this.maxRetries = 3;
        this.taskTimeoutMs = 300000; // 5分钟超时
        this.maxConcurrent = Math.max(1, Number(process.env.TASK_SCHEDULER_CONCURRENCY || 2));
        this.updateSnapshot();
    }

    /**
     * 更新全局快照的任务统计值
     */
    updateSnapshot() {
        schedulerMetrics.queued = this.taskQueue.length;
        schedulerMetrics.processing = this.processingTasks.size;
        schedulerMetrics.pending = schedulerMetrics.queued + schedulerMetrics.processing;
        schedulerMetrics.lastUpdatedAt = Date.now();
    }

    /**
     * 添加一个任务对象到队列，自动排序和触发派发
     * @param {object} task
     */
    addTask(task) {
        const now = Date.now();
        task.priority = task.priority || 1;
        task.createdAt = task.createdAt || now;
        if (typeof task.retries !== 'number') {
            task.retries = 0;
        }
        if (!task.id) {
            task.id = `task_${task.type || 'unknown'}_${now}_${Math.random().toString(36).slice(2, 8)}`;
        }

        // 按优先级插入，越大越优先
        const insertIndex = this.taskQueue.findIndex(t => t.priority < task.priority);
        if (insertIndex === -1) {
            this.taskQueue.push(task);
        } else {
            this.taskQueue.splice(insertIndex, 0, task);
        }

        logger.debug(`[TaskScheduler] 添加任务: ${task.type} (优先级: ${task.priority})`);
        this.updateSnapshot();
        this.processNextTask();
    }

    /**
     * 按最大并发自动派发队头任务
     */
    processNextTask() {
        while (this.taskQueue.length > 0 && this.processingTasks.size < this.maxConcurrent) {
            const nextTask = this.taskQueue.shift();
            this.startTask(nextTask);
        }
    }

    /**
     * 实际启动任务调用处理器，超时保护和错误捕获
     * @param {object} task
     */
    startTask(task) {
        if (!task) {
            return;
        }

        const taskId = task.id;
        if (this.processingTasks.has(taskId)) {
            logger.debug(`[TaskScheduler] 任务 ${taskId} 已在处理中，跳过`);
            return;
        }

        this.processingTasks.set(taskId, task);
        this.updateSnapshot();

        const timeoutId = setTimeout(() => {
            this.handleTaskTimeout(taskId);
        }, this.taskTimeoutMs);
        this.taskTimeouts.set(taskId, timeoutId);

        logger.debug(`[TaskScheduler] 开始处理任务: ${task.type} (${taskId})`);

        Promise.resolve()
            .then(() => task.handler(task.payload))
            .then(() => {
                this.handleTaskCompletion(taskId, true);
                logger.debug(`[TaskScheduler] 任务完成: ${task.type} (${taskId})`);
            })
            .catch((error) => {
                this.handleTaskFailure(taskId, task, error);
            });
    }

    /**
     * 任务超时处理逻辑
     * @param {string} taskId
     */
    handleTaskTimeout(taskId) {
        const task = this.processingTasks.get(taskId);
        if (task) {
            logger.warn(`[TaskScheduler] 任务超时: ${task.type} (${taskId})`);
            this.handleTaskFailure(taskId, task, new Error('Task timeout'));
        }
    }

    /**
     * 清除任务关联的超时计时器
     * @param {string} taskId
     */
    clearTimeoutForTask(taskId) {
        const timeoutId = this.taskTimeouts.get(taskId);
        if (timeoutId) {
            clearTimeout(timeoutId);
            this.taskTimeouts.delete(taskId);
        }
    }

    /**
     * 任务完成后流程（会自动尝试调度下一个）
     * @param {string} taskId
     * @param {boolean} success
     */
    handleTaskCompletion(taskId, success) {
        this.clearTimeoutForTask(taskId);
        this.processingTasks.delete(taskId);

        if (success) {
            schedulerMetrics.completed += 1;
        }

        this.updateSnapshot();
        setImmediate(() => this.processNextTask());
    }

    /**
     * 任务失败后重试/丢弃流程、计数和调度后续
     * @param {string} taskId
     * @param {object} task
     * @param {Error} error
     */
    handleTaskFailure(taskId, task, error) {
        logger.warn(`[TaskScheduler] 任务失败: ${task.type} (${taskId}):`, error);
        this.clearTimeoutForTask(taskId);
        this.processingTasks.delete(taskId);

        schedulerMetrics.failed += 1;
        schedulerMetrics.lastError = error && error.message ? error.message : 'UNKNOWN_ERROR';
        schedulerMetrics.lastFailureAt = Date.now();

        task.retries = (task.retries || 0) + 1;

        if (task.retries < this.maxRetries) {
            logger.info(`[TaskScheduler] 重试任务: ${task.type} (${taskId}), 第${task.retries}次`);
            schedulerMetrics.retries += 1;
            task.priority += 1; // 重试优先级动态增加
            this.addTask(task);
        } else {
            logger.error(`[TaskScheduler] 放弃任务: ${task.type} (${taskId}), 已重试${this.maxRetries}次`);
        }

        this.updateSnapshot();
        setImmediate(() => this.processNextTask());
    }

    /**
     * 获取当前队列状态快照
     * @returns {object}
     */
    getQueueStatus() {
        return {
            queued: this.taskQueue.length,
            processing: this.processingTasks.size,
            total: this.taskQueue.length + this.processingTasks.size
        };
    }
}

// 全局唯一任务调度器实例
const taskScheduler = new WorkerTaskScheduler();

/**
 * 视频任务入队打点
 * @param {object} payload
 */
function recordVideoEnqueue(payload) {
    videoMetrics.pending += 1;
    videoMetrics.lastQueuedAt = Date.now();
    videoMetrics.lastQueuedPath = payload && payload.relativePath ? String(payload.relativePath) : videoMetrics.lastQueuedPath;
    videoMetrics.lastUpdatedAt = Date.now();
}

/**
 * 推断任务结果的文件路径
 * @param {object} result
 * @returns {string|null}
 */
function inferResultPath(result) {
    if (!result) return null;
    if (result.path) return String(result.path);
    if (result.task && result.task.relativePath) return String(result.task.relativePath);
    return null;
}

/**
 * 视频任务成功/失败出队处理与统计
 * @param {object} result
 */
function recordVideoOutcome(result) {
    videoMetrics.pending = Math.max(0, videoMetrics.pending - 1);
    videoMetrics.lastUpdatedAt = Date.now();
    const resolvedPath = inferResultPath(result);
    if (result && result.success) {
        videoMetrics.completed += 1;
        videoMetrics.lastCompletedPath = resolvedPath || videoMetrics.lastCompletedPath;
    } else {
        videoMetrics.failed += 1;
        videoMetrics.lastError = result && (result.error || result.message) ? String(result.error || result.message) : videoMetrics.lastError;
        videoMetrics.lastFailureAt = Date.now();
    }
}

/**
 * 绑定视频处理worker并收集运行指标
 * @param {Worker} worker
 */
function attachVideoMetrics(worker) {
    if (!worker || worker.__videoMetricsBound) {
        return;
    }

    videoMetrics.workerState = 'active';
    videoMetrics.lastUpdatedAt = Date.now();

    // 入队打点
    const originalPostMessage = worker.postMessage.bind(worker);
    worker.postMessage = (payload, transferList) => {
        try { recordVideoEnqueue(payload); } catch (e) { logger.debug('[VideoMetrics] 记录入队失败：', e && e.message); }
        return originalPostMessage(payload, transferList);
    };

    // 消息事件采集
    worker.on('message', (msg) => {
        const message = normalizeWorkerMessage(msg);

        if (message.kind === 'log') return;

        if (message.kind === 'error' && message.payload && message.payload.type === 'worker_shutdown') {
            videoMetrics.workerState = 'idle';
            videoMetrics.lastUpdatedAt = Date.now();
            return;
        }

        if (message.kind === 'result') {
            recordVideoOutcome(Object.assign({ success: true }, message.payload));
            return;
        }

        if (message.kind === 'error') {
            recordVideoOutcome(Object.assign({ success: false }, message.payload));
        }
    });

    // 错误事件采集
    worker.on('error', (err) => {
        videoMetrics.lastError = err && err.message ? err.message : 'VIDEO_WORKER_ERROR';
        videoMetrics.lastFailureAt = Date.now();
        videoMetrics.workerState = 'errored';
        videoMetrics.lastUpdatedAt = Date.now();
    });

    // 退出事件采集
    worker.on('exit', () => {
        videoMetrics.workerState = 'stopped';
        videoMetrics.pending = 0;
        videoMetrics.lastUpdatedAt = Date.now();
    });

    worker.__videoMetricsBound = true;
}

/**
 * 获取索引worker（惰性创建单例）
 * @returns {Worker}
 */
function getIndexingWorker() {
    if (!__indexingWorker) {
        __indexingWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'indexing-worker.js'), {
            resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 256) }
        });
        noteWorkerCreated('indexing', __indexingWorker);
        attachDefaultHandlers(__indexingWorker, 'indexingWorker');
    }
    return __indexingWorker;
}

/**
 * 获取设置worker（惰性创建单例）
 * @returns {Worker}
 */
function getSettingsWorker() {
    if (!__settingsWorker) {
        __settingsWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'settings-worker.js'), {
            resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 256) }
        });
        noteWorkerCreated('settings', __settingsWorker);
        // 单次消息hook，实现worker->主进程状态同步（幂等）
        if (!__settingsWorker.__peMessageHooked) {
            try {
                __settingsWorker.on('message', (msg) => {
                    try {
                        const message = normalizeWorkerMessage(msg);
                        const payload = message.payload || {};
                        const settingsController = require('../controllers/settings.controller');
                        if (message.kind === 'result' && payload.type === 'settings_update_complete') {
                            settingsController.updateSettingsStatus('success', null, payload.updateId || null);
                        } else if (message.kind === 'error' && payload.type === 'settings_update_failed') {
                            const errorMessage = (payload.error && payload.error.message) || payload.message || null;
                            settingsController.updateSettingsStatus('failed', errorMessage, payload.updateId || null);
                        }
                    } catch (e) {
                        logger.debug('[WorkerManager] 处理设置 worker 消息失败（忽略）:', e && e.message);
                    }
                });
                __settingsWorker.__peMessageHooked = true;
            } catch (e) { logger.debug(`操作失败: ${e.message}`); }
        }
        attachDefaultHandlers(__settingsWorker, 'settingsWorker');
    }
    return __settingsWorker;
}

/**
 * 获取历史worker（惰性创建单例）
 * @returns {Worker}
 */
function getHistoryWorker() {
    return null;
}

/**
 * 获取视频worker（惰性创建单例）
 * @returns {Worker}
 */
function bindVideoWorkerIdleHandler(worker) {
    if (!worker || worker.__idleMessageBound) {
        return;
    }

    const detach = () => {
        if (worker.__idleMessageBound) {
            const remover = typeof worker.off === 'function' ? worker.off.bind(worker) : worker.removeListener.bind(worker);
            remover('message', onMessage);
            worker.__idleMessageBound = false;
        }
    };

    const onMessage = (raw) => {
        try {
            const message = normalizeWorkerMessage(raw);
            const payload = message.payload || {};
            const eventType = payload.type || raw?.type;
            if (eventType !== 'WORKER_IDLE') {
                return;
            }

            if (worker.__idleTerminationRequested) {
                return;
            }
            worker.__idleTerminationRequested = true;
            videoMetrics.workerState = 'idle';
            videoMetrics.lastUpdatedAt = Date.now();
            logger.info('[WorkerManager] 视频工作线程空闲，准备终止以释放资源。');
            detach();

            // 标记为预期终止，避免自动重启
            worker.__expectedTermination = true;

            // 清除全局引用，避免 getVideoWorker 返回已终止的 worker
            __videoWorker = null;

            const termination = worker.terminate();
            if (termination && typeof termination.catch === 'function') {
                termination.catch((err) => logWorkerIgnore('终止视频线程', err));
            }
        } catch (error) {
            logger.debug('[WorkerManager] 处理视频线程空闲消息失败（忽略）:', error && error.message);
        }
    };

    const handler = typeof worker.on === 'function' ? worker.on.bind(worker) : worker.addListener.bind(worker);
    handler('message', onMessage);
    worker.once('exit', () => {
        worker.__idleMessageBound = false;
        worker.__idleTerminationRequested = false;
    });
    worker.__idleMessageBound = true;
}

function startVideoWorker() {
    if (__videoWorker) {
        return __videoWorker;
    }

    __videoWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'video-processor.js'), {
        resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 256) }
    });
    noteWorkerCreated('video', __videoWorker);
    attachDefaultHandlers(__videoWorker, 'videoWorker');
    attachVideoMetrics(__videoWorker);
    bindVideoWorkerIdleHandler(__videoWorker);
    try {
        const { attachVideoWorkerListeners } = require('./indexer.service');
        if (typeof attachVideoWorkerListeners === 'function') {
            attachVideoWorkerListeners(__videoWorker);
        }
    } catch (error) {
        logger.debug('[WorkerManager] 安装视频worker监听器失败（忽略）:', error && error.message);
    }
    return __videoWorker;
}

function getVideoWorker() {
    return __videoWorker;
}

// --- 缩略图线程池 ---
/**
 * 缩略图worker线程池数组（全部）
 * @type {Worker[]}
 */
const thumbnailWorkers = [];
/**
 * 空闲缩略图worker队列（部分/全部）
 * @type {Worker[]}
 */
const idleThumbnailWorkers = [];

/**
 * 工作线程池管理器（缩略图专用）
 * 提供缩略图worker的池化、扩缩容、空闲销毁管理
 */
class WorkerPoolManager {
    constructor() {
        this.idleShutdownMs = Number(process.env.THUMB_IDLE_SHUTDOWN_MS || 600000); // 默认10分钟
        this.checkIntervalMs = Number(process.env.THUMB_CHECK_INTERVAL_MS || 60000); // 默认60秒
        this.lastUseTs = 0;
        this.checkTimer = null;
        this.startIdleCheck();
    }

    /**
     * 记录上一轮激活/使用时间（用于空闲销毁判定）
     */
    noteUsage() {
        this.lastUseTs = Date.now();
    }

    /**
     * 判定是否满足全部空闲可销毁池
     * @returns {boolean}
     */
    shouldRecycle() {
        if (thumbnailWorkers.length === 0) return false;
        const allIdle = idleThumbnailWorkers.length === thumbnailWorkers.length;
        const active = state.thumbnail.getActiveCount();
        const idleFor = Date.now() - (this.lastUseTs || 0);
        return allIdle && active === 0 && this.lastUseTs && idleFor > this.idleShutdownMs;
    }

    /**
     * 启动定时回收检测
     */
    startIdleCheck() {
        if (this.checkTimer) return;

        this.checkTimer = setInterval(() => {
            if (this.shouldRecycle()) {
                this.destroyPool();
            }
        }, this.checkIntervalMs);
    }

    /**
     * 停止回收检测定时器
     */
    stopIdleCheck() {
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = null;
        }
    }

    /**
     * 回收/销毁所有缩略图线程
     */
    destroyPool() {
        try {
            thumbnailWorkers.forEach((w) => {
                try {
                    // 标记为预期终止，避免 exit 事件误报为异常退出
                    w.__expectedTermination = true;
                    w.terminate();
                } catch (error) {
                    logWorkerIgnore('终止缩略图线程', error);
                }
            });
        } catch (error) {
            logWorkerIgnore('批量终止缩略图线程', error);
        }
        thumbnailWorkers.length = 0;
        idleThumbnailWorkers.length = 0;
        this.lastUseTs = 0;
        logger.debug(`已销毁缩略图工作线程池（空闲回收，超时: ${this.idleShutdownMs}ms）`);
    }

    /**
     * 如果池为空则创建
     */
    ensurePool() {
        if (thumbnailWorkers.length === 0) {
            this.createPool();
        }
    }

    /**
     * 创建若干个缩略图worker池（首轮/再初始化）
     */
    createPool() {
        if (thumbnailWorkers.length > 0) return;
        const initialSize = Math.max(1, Math.min(INITIAL_THUMB_WORKERS, NUM_WORKERS || 1));
        logger.info(`创建 ${initialSize} 个缩略图处理工人...`);
        this.lastUseTs = Date.now();

        // 为缩略图任务专项分配更大内存
        const thumbWorkerMemoryMb = Number(process.env.THUMB_WORKER_MEMORY_MB || 512);

        for (let i = 0; i < initialSize; i++) {
            const worker = new Worker(path.resolve(__dirname, '..', 'workers', 'thumbnail-worker.js'), {
                workerData: { workerId: i + 1 },  // 分配唯一ID
                resourceLimits: { maxOldGenerationSizeMb: thumbWorkerMemoryMb }
            });
            thumbnailWorkers.push(worker);
            idleThumbnailWorkers.push(worker);
        }
    }
}

// 缩略图线程池全局单例管理器
const workerPoolManager = new WorkerPoolManager();

/**
 * 外部调用：确保池存在
 */
function ensureThumbnailWorkerPool() {
    workerPoolManager.ensurePool();
}

/**
 * 外部调用：触发回收缩略图worker线程池
 */
function destroyThumbnailWorkerPool() {
    workerPoolManager.destroyPool();
}

/**
 * 外部调用：使用池时打点一次（影响空闲收缩判断）
 */
function noteThumbnailUse() {
    workerPoolManager.noteUsage();
}

/**
 * 获取任务调度器全局统计快照
 * @returns {object}
 */
function getTaskSchedulerMetrics() {
    return {
        queued: schedulerMetrics.queued,
        processing: schedulerMetrics.processing,
        pending: schedulerMetrics.pending,
        completed: schedulerMetrics.completed,
        failed: schedulerMetrics.failed,
        retries: schedulerMetrics.retries,
        lastError: schedulerMetrics.lastError,
        lastFailureAt: schedulerMetrics.lastFailureAt,
        lastUpdatedAt: schedulerMetrics.lastUpdatedAt
    };
}

/**
 * 获取视频任务相关指标快照
 * @returns {object}
 */
function getVideoTaskMetrics() {
    return {
        pending: Math.max(0, videoMetrics.pending),
        completed: videoMetrics.completed,
        failed: videoMetrics.failed,
        lastError: videoMetrics.lastError,
        lastFailureAt: videoMetrics.lastFailureAt,
        lastQueuedAt: videoMetrics.lastQueuedAt,
        lastQueuedPath: videoMetrics.lastQueuedPath,
        lastCompletedPath: videoMetrics.lastCompletedPath,
        workerState: videoMetrics.workerState,
        lastUpdatedAt: videoMetrics.lastUpdatedAt
    };
}

/**
 * 兼容旧用法：单步创建缩略图线程池
 */
const createThumbnailWorkerPool = () => {
    workerPoolManager.createPool();
};

/**
 * 缩略图线程池扩缩容接口
 * targetSize: 目标池大小（非忙线程可缩容，忙的待下次再回收）
 * @param {number} targetSize
 */
function scaleThumbnailWorkerPool(targetSize) {
    try {
        targetSize = Math.max(0, Math.floor(Number(targetSize)));
        const current = thumbnailWorkers.length;
        if (targetSize === current) return current;

        if (targetSize > current) {
            // 扩容
            const need = targetSize - current;
            const thumbWorkerMemoryMb = Number(process.env.THUMB_WORKER_MEMORY_MB || 512);

            for (let i = 0; i < need; i++) {
                const workerId = thumbnailWorkers.length + 1;
                const worker = new Worker(path.resolve(__dirname, '..', 'workers', 'thumbnail-worker.js'), {
                    workerData: { workerId },
                    resourceLimits: { maxOldGenerationSizeMb: thumbWorkerMemoryMb }
                });
                thumbnailWorkers.push(worker);
                idleThumbnailWorkers.push(worker);
            }
            try {
                workerPoolManager.noteUsage();
            } catch (error) {
                logWorkerIgnore('记录缩略图线程池使用', error);
            }
            // 新线程需注册监听（延迟require避免循环依赖时机）
            try {
                require('./thumbnail.service').setupThumbnailWorkerListeners();
            } catch (error) {
                logWorkerIgnore('安装缩略图线程监听器', error);
            }
            logger.debug(`[ThumbPool] 扩容: ${current} -> ${thumbnailWorkers.length}`);
            return thumbnailWorkers.length;
        } else {
            // 优先回收空闲线程；忙的下次再回收
            let canRemove = Math.max(0, current - targetSize);
            let removed = 0;
            while (canRemove > 0 && idleThumbnailWorkers.length > 0) {
                const idle = idleThumbnailWorkers.pop();
                const idx = thumbnailWorkers.indexOf(idle);
                if (idx > -1) thumbnailWorkers.splice(idx, 1);
                try {
                    idle.removeAllListeners();
                    idle.terminate();
                } catch (error) {
                    logWorkerIgnore('缩容时终止空闲缩略图线程', error);
                }
                removed++;
                canRemove--;
            }
            if (removed > 0) {
                logger.debug(`[ThumbPool] 缩容: ${current} -> ${thumbnailWorkers.length}（实际移除 ${removed}，其余线程正忙，稍后再试）`);
            }
            return thumbnailWorkers.length;
        }
    } catch (e) {
        logger.warn(`[ThumbPool] 扩缩容失败（忽略）：${e && e.message}`);
        return thumbnailWorkers.length;
    }
}

/**
 * 绑定worker通用错误退出等事件处理器（避免多次绑定）
 * @param {Worker} worker
 * @param {string} name
 */
function attachDefaultHandlers(worker, name) {
    if (!worker.__handlersAttached) {
        const coreName = workerNameKeyMap[name];

        worker.on('error', (err) => {
            logger.error(`${name} 遇到错误:`, err);
            if (coreName) {
                const message = err && err.message ? err.message : String(err || 'UNKNOWN_ERROR');
                updateCoreWorkerState(coreName, {
                    state: 'errored',
                    lastError: message,
                    lastErrorAt: Date.now()
                });
            }
        });
        worker.on('exit', (code) => {
            // 检查是否为预期终止（例如空闲自动停止）
            const isExpectedTermination = worker.__expectedTermination === true;

            if (code !== 0 && !isExpectedTermination) {
                logger.warn(`${name} 意外退出，退出码: ${code}`);
            } else if (code === 0 || isExpectedTermination) {
                logger.info(`${name} 正常退出，退出码: ${code}`);
            }

            if (coreName) {
                const exitInfo = { exitCode: code, exitedAt: Date.now() };
                clearWorkerReference(coreName);

                // 只有非预期终止才标记为错误并尝试重启
                if (code === 0 || isExpectedTermination) {
                    updateCoreWorkerState(coreName, Object.assign({}, exitInfo, { state: 'stopped' }));
                } else {
                    updateCoreWorkerState(coreName, Object.assign({}, exitInfo, { state: 'errored' }));
                    scheduleWorkerRestart(coreName);
                }
            }
        });
        worker.__handlersAttached = true;
    }
}

/**
 * 启动所有核心worker（全量惰性单例）
 * @returns {object}
 */
function ensureCoreWorkers() {
    const w1 = getIndexingWorker(); attachDefaultHandlers(w1, 'indexingWorker');
    const w2 = getSettingsWorker(); attachDefaultHandlers(w2, 'settingsWorker');
    return { w1, w2 };
}

/**
 * 创建一次性worker工厂（不缓存全新线程，由调用方负责释放）
 * @param {'indexing'|'settings'|'history'|'video'|'thumbnail'} kind
 * @param {object} workerData
 * @returns {Worker}
 * @throws {ValidationError}
 */
function createDisposableWorker(kind, workerData = {}) {
    const map = {
        indexing: 'indexing-worker.js',
        settings: 'settings-worker.js',
        history: null,
        video: 'video-processor.js',
        thumbnail: 'thumbnail-worker.js',
    };
    const file = map[kind];
    if (!file) {
        const { ValidationError } = require('../utils/errors');
        throw new ValidationError(`Unknown worker kind: ${kind}`, { kind, validKinds: Object.keys(map) });
    }
    return new Worker(path.resolve(__dirname, '..', 'workers', file), {
        workerData,
        resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 256) }
    });
}

/* -------------------------------------------------------------------
 * 导出接口 - 兼容属性、方法，兼容历史API
 * ------------------------------------------------------------------ */
module.exports = {
    // 核心单例worker（惰性getter）
    getIndexingWorker,
    getSettingsWorker,
    getVideoWorker,
    startVideoWorker,
    ensureCoreWorkers,
    createDisposableWorker,

    // 缩略图线程池逻辑
    thumbnailWorkers,            // 缩略图worker池
    idleThumbnailWorkers,        // 当前空闲缩略图worker队列
    createThumbnailWorkerPool,   // 新建池方法
    ensureThumbnailWorkerPool,   // 懒加载确保
    destroyThumbnailWorkerPool,  // 主动销毁
    noteThumbnailUse,            // 使用池埋点
    scaleThumbnailWorkerPool,    // 池扩缩容
    getTaskSchedulerMetrics,     // 获取任务调度统计
    getVideoTaskMetrics,         // 获取视频任务指标
};

/* ===============================
 * 下面为智能任务调度与worker适配逻辑
 * ============================== */

/**
 * 宏任务调度器统一入口
 * 自动分流、调度对应worker
 * @param {string} taskType 任务类型：thumbnail、index、video等
 * @param {object} payload 任务参数
 * @param {object} options 调度参数
 * @returns {string} 任务ID
 */
function scheduleWorkerTask(taskType, payload, options = {}) {
    const { priority = 1, timeout = 300000, retries = 3 } = options;

    const task = {
        id: `${taskType}_${Date.now()}_${Math.random()}`,
        type: taskType,
        priority,
        payload,
        handler: async (data) => {
            // 通过类型选择worker
            switch (taskType) {
                case 'thumbnail':
                    await processThumbnailTask(data);
                    break;
                case 'index':
                    await processIndexTask(data);
                    break;
                case 'video':
                    await processVideoTask(data);
                    break;
                default: {
                    const { ValidationError } = require('../utils/errors');
                    throw new ValidationError(`Unknown task type: ${taskType}`, { taskType, validTypes: ['index', 'video'] });
                }
            }
        }
    };

    taskScheduler.addTask(task);
    return task.id;
}

/**
 * 选择最优worker实例（负载均衡）
 * 可用于高频任务如缩略图/大并发场景扩展
 * @param {string} taskType
 * @returns {Worker|null}
 */
function selectOptimalWorker(taskType) {
    // 简单负载均衡实现，后续可扩展（如轮询/权重等）
    switch (taskType) {
        case 'thumbnail':
            if (idleThumbnailWorkers.length > 0) {
                return idleThumbnailWorkers[0];
            }
            // 没有空闲则考虑自动扩容
            if (thumbnailWorkers.length < NUM_WORKERS) {
                scaleThumbnailWorkerPool(thumbnailWorkers.length + 1);
                return thumbnailWorkers[thumbnailWorkers.length - 1];
            }
            break;

        case 'index':
            return getIndexingWorker();

        case 'settings':
            return getSettingsWorker();

        case 'video':
            return startVideoWorker();
    }
    return null;
}

/**
 * worker健康检查（快照形式，无副作用）
 * 供运维面板等调用
 * @returns {object}
 */
function performWorkerHealthCheck() {
    const buildCoreState = (name, ref) => {
        const base = coreWorkerStates[name] ? { ...coreWorkerStates[name] } : { state: ref ? 'active' : 'inactive' };
        if (ref && typeof ref.threadId === 'number') {
            base.threadId = ref.threadId;
        }
        return base;
    };

    const status = {
        indexing: buildCoreState('indexing', __indexingWorker),
        settings: buildCoreState('settings', __settingsWorker),
        history: buildCoreState('history', __historyWorker),
        video: Object.assign({}, buildCoreState('video', __videoWorker), { metrics: getVideoTaskMetrics() }),
        thumbnail: {
            total: thumbnailWorkers.length,
            idle: idleThumbnailWorkers.length,
            active: thumbnailWorkers.length - idleThumbnailWorkers.length
        },
        taskQueue: taskScheduler.getQueueStatus()
    };

    logger.silly('[WorkerHealth] 状态检查:', status);
    return status;
}

/**
 * 处理单个缩略图任务（智能派发归还池，无需强缓存）
 * @param {object} data
 * @returns {Promise<any>}
 */
async function processThumbnailTask(data) {
    const worker = selectOptimalWorker('thumbnail');
    if (!worker) {
        const { ServiceUnavailableError } = require('../utils/errors');
        throw new ServiceUnavailableError('缩略图Worker', { reason: '无可用Worker' });
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId;
        const removeListener = typeof worker.off === 'function'
            ? (event, handler) => worker.off(event, handler)
            : (event, handler) => worker.removeListener(event, handler);

        function cleanup() {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            removeListener('message', onMessage);
            removeListener('error', onError);
        }

        function finalizeResolve(result) {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        }

        function finalizeReject(error) {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        }

        function onMessage(result) {
            const message = normalizeWorkerMessage(result);
            if (message.kind === 'log') {
                logWorkerChannel('thumbnail-worker', message.payload);
                return;
            }
            if (message.kind === 'result') {
                const payload = Object.assign({ success: true }, message.payload || {});
                if (payload.success === false) {
                    finalizeReject(new Error(payload.error || payload.message || 'Thumbnail processing failed'));
                    return;
                }
                finalizeResolve(payload);
                return;
            }
            if (message.kind === 'error') {
                const payload = message.payload || {};
                const errMessage = (payload.error && payload.error.message) || payload.message || 'Thumbnail processing failed';
                finalizeReject(new Error(errMessage));
            }
        }

        function onError(error) {
            finalizeReject(error);
        }

        worker.on('message', onMessage);
        worker.on('error', onError);

        timeoutId = setTimeout(() => {
            finalizeReject(new Error('Thumbnail task timeout'));
        }, 300000); // 5min

        const message = TraceManager.injectToWorkerMessage({
            type: 'process_thumbnail',
            payload: data
        });
        worker.postMessage(message);
    });
}

/**
 * 处理索引构建/重建任务
 * @param {object} data
 * @returns {Promise<any>}
 */
async function processIndexTask(data) {
    const worker = getIndexingWorker();
    return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId;
        const removeListener = typeof worker.off === 'function'
            ? (event, handler) => worker.off(event, handler)
            : (event, handler) => worker.removeListener(event, handler);

        function cleanup() {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            removeListener('message', onMessage);
            removeListener('error', onError);
        }

        function finalizeResolve(result) {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        }

        function finalizeReject(error) {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        }

        function onMessage(result) {
            const message = normalizeWorkerMessage(result);
            if (message.kind === 'log') {
                logWorkerChannel('indexing-worker', message.payload);
                return;
            }
            if (message.kind === 'error') {
                const payload = message.payload || {};
                const errMessage = (payload.error && payload.error.message) || payload.message || payload.error || 'Index processing failed';
                finalizeReject(new Error(errMessage));
                return;
            }
            if (message.kind === 'result') {
                const payload = message.payload || {};
                const type = payload.type || result.type;
                if (type === 'rebuild_complete' || type === 'index_complete') {
                    finalizeResolve(payload);
                } else {
                    finalizeResolve(payload);
                }
            }
        }

        function onError(error) {
            finalizeReject(error);
        }

        worker.on('message', onMessage);
        worker.on('error', onError);

        timeoutId = setTimeout(() => {
            finalizeReject(new Error('Index task timeout'));
        }, 600000); // 10min

        const message = TraceManager.injectToWorkerMessage({
            type: 'rebuild_index',
            payload: data
        });
        worker.postMessage(message);
    });
}

/**
 * 处理视频转码等任务
 * @param {object} data
 * @returns {Promise<any>}
 */
async function processVideoTask(data) {
    const worker = startVideoWorker();
    return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId;
        const removeListener = typeof worker.off === 'function'
            ? (event, handler) => worker.off(event, handler)
            : (event, handler) => worker.removeListener(event, handler);

        function cleanup() {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            removeListener('message', onMessage);
            removeListener('error', onError);
        }

        function finalizeResolve(result) {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        }

        function finalizeReject(error) {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        }

        function onMessage(result) {
            const message = normalizeWorkerMessage(result);
            if (message.kind === 'log') {
                logWorkerChannel('video-worker', message.payload);
                return;
            }
            if (message.kind === 'error') {
                const payload = message.payload || {};
                if (payload.type === 'worker_shutdown') {
                    finalizeReject(new Error(payload.message || '视频工作线程在任务完成前停止'));
                    return;
                }
                const errMessage = (payload.error && payload.error.message) || payload.message || payload.error || '视频处理失败';
                finalizeReject(new Error(errMessage));
                return;
            }
            if (message.kind === 'result') {
                const payload = Object.assign({ success: true }, message.payload || {});
                if (payload.success === false) {
                    const errMessage = (payload.error && payload.error.message) || payload.error || payload.message || '视频处理失败';
                    finalizeReject(new Error(errMessage));
                    return;
                }
                finalizeResolve(payload);
            }
        }

        function onError(error) {
            finalizeReject(error);
        }

        worker.on('message', onMessage);
        worker.on('error', onError);

        timeoutId = setTimeout(() => {
            finalizeReject(new Error('视频任务超时'));
        }, 1800000); // 30min

        const message = TraceManager.injectToWorkerMessage({
            type: 'process_video',
            payload: data
        });
        worker.postMessage(message);
    });
}

/**
 * 兼容属性导出（访问即懒加载单例worker），含部分快捷工厂/指令
 */
Object.defineProperties(module.exports, {
    indexingWorker: {
        enumerable: true,
        get() { return getIndexingWorker(); }
    },
    settingsWorker: {
        enumerable: true,
        get() { return getSettingsWorker(); }
    },
    videoWorker: {
        enumerable: true,
        get() { return getVideoWorker(); }
    },
    // 新增功能快捷口
    taskScheduler: {
        enumerable: true,
        value: taskScheduler
    },
    scheduleWorkerTask: {
        enumerable: true,
        value: scheduleWorkerTask
    },
    selectOptimalWorker: {
        enumerable: true,
        value: selectOptimalWorker
    },
    performWorkerHealthCheck: {
        enumerable: true,
        value: performWorkerHealthCheck
    },
    getTaskSchedulerMetrics: {
        enumerable: true,
        value: getTaskSchedulerMetrics
    },
    getVideoTaskMetrics: {
        enumerable: true,
        value: getVideoTaskMetrics
    },
    thumbnailWorkers: {
        enumerable: true,
        get() { return thumbnailWorkers; }
    },
    idleThumbnailWorkers: {
        enumerable: true,
        get() { return idleThumbnailWorkers; }
    }
});