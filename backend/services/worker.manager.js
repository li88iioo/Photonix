/**
 * 工作线程管理器模块 - 简化版
 * 管理各种后台任务的工作线程，移除队列模式复杂性
 */
const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('../config/logger');
const { NUM_WORKERS } = require('../config');

const INITIAL_THUMB_WORKERS = (() => {
    const requested = Number(process.env.THUMB_INITIAL_WORKERS);
    if (Number.isFinite(requested) && requested > 0) {
        return Math.min(Math.floor(requested), NUM_WORKERS || 1);
    }
    return 1;
})();

const schedulerMetrics = {
    queued: 0,
    processing: 0,
    pending: 0,
    completed: 0,
    failed: 0,
    retries: 0,
    lastError: null,
    lastFailureAt: null,
    lastUpdatedAt: 0
};
try { global.__workerTaskMetrics = schedulerMetrics; } catch {}

const videoMetrics = {
    pending: 0,
    completed: 0,
    failed: 0,
    lastError: null,
    lastFailureAt: null,
    lastQueuedAt: null,
    lastCompletedPath: null,
    lastQueuedPath: null,
    workerState: 'inactive',
    lastUpdatedAt: 0
};
try { global.__videoTaskMetrics = videoMetrics; } catch {}

// 惰性创建专门的单例工作线程（避免在模块加载阶段即拉起原生依赖）
let __indexingWorker = null;
let __settingsWorker = null;
let __historyWorker = null;
let __videoWorker = null;

// 任务调度优化：任务队列和优先级管理
class WorkerTaskScheduler {
    constructor() {
        this.taskQueue = [];
        this.processingTasks = new Map();
        this.taskTimeouts = new Map();
        this.maxRetries = 3;
        this.taskTimeoutMs = 300000; // 5 分钟超时
        this.maxConcurrent = Math.max(1, Number(process.env.TASK_SCHEDULER_CONCURRENCY || 2));
        this.updateSnapshot();
    }

    updateSnapshot() {
        schedulerMetrics.queued = this.taskQueue.length;
        schedulerMetrics.processing = this.processingTasks.size;
        schedulerMetrics.pending = schedulerMetrics.queued + schedulerMetrics.processing;
        schedulerMetrics.lastUpdatedAt = Date.now();
    }

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

    processNextTask() {
        while (this.taskQueue.length > 0 && this.processingTasks.size < this.maxConcurrent) {
            const nextTask = this.taskQueue.shift();
            this.startTask(nextTask);
        }
    }

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

    handleTaskTimeout(taskId) {
        const task = this.processingTasks.get(taskId);
        if (task) {
            logger.warn(`[TaskScheduler] 任务超时: ${task.type} (${taskId})`);
            this.handleTaskFailure(taskId, task, new Error('Task timeout'));
        }
    }

    clearTimeoutForTask(taskId) {
        const timeoutId = this.taskTimeouts.get(taskId);
        if (timeoutId) {
            clearTimeout(timeoutId);
            this.taskTimeouts.delete(taskId);
        }
    }

    handleTaskCompletion(taskId, success) {
        this.clearTimeoutForTask(taskId);
        this.processingTasks.delete(taskId);

        if (success) {
            schedulerMetrics.completed += 1;
        }

        this.updateSnapshot();
        setImmediate(() => this.processNextTask());
    }

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
            task.priority += 1;
            this.addTask(task);
        } else {
            logger.error(`[TaskScheduler] 放弃任务: ${task.type} (${taskId}), 已重试${this.maxRetries}次`);
        }

        this.updateSnapshot();
        setImmediate(() => this.processNextTask());
    }

    getQueueStatus() {
        return {
            queued: this.taskQueue.length,
            processing: this.processingTasks.size,
            total: this.taskQueue.length + this.processingTasks.size
        };
    }
}

// 创建全局任务调度器实例
const taskScheduler = new WorkerTaskScheduler();

function recordVideoEnqueue(payload) {
    videoMetrics.pending += 1;
    videoMetrics.lastQueuedAt = Date.now();
    videoMetrics.lastQueuedPath = payload && payload.relativePath ? String(payload.relativePath) : videoMetrics.lastQueuedPath;
    videoMetrics.lastUpdatedAt = Date.now();
}

function inferResultPath(result) {
    if (!result) return null;
    if (result.path) return String(result.path);
    if (result.task && result.task.relativePath) return String(result.task.relativePath);
    return null;
}

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

function attachVideoMetrics(worker) {
    if (!worker || worker.__videoMetricsBound) {
        return;
    }

    videoMetrics.workerState = 'active';
    videoMetrics.lastUpdatedAt = Date.now();

    const originalPostMessage = worker.postMessage.bind(worker);
    worker.postMessage = (payload, transferList) => {
        try { recordVideoEnqueue(payload); } catch (e) { logger.debug('[VideoMetrics] 记录入队失败：', e && e.message); }
        return originalPostMessage(payload, transferList);
    };

    worker.on('message', (msg) => {
        if (msg && Object.prototype.hasOwnProperty.call(msg, 'success')) {
            recordVideoOutcome(msg);
        } else if (msg && msg.type === 'worker_shutdown') {
            videoMetrics.workerState = 'idle';
            videoMetrics.lastUpdatedAt = Date.now();
        }
    });

    worker.on('error', (err) => {
        videoMetrics.lastError = err && err.message ? err.message : 'VIDEO_WORKER_ERROR';
        videoMetrics.lastFailureAt = Date.now();
        videoMetrics.workerState = 'errored';
        videoMetrics.lastUpdatedAt = Date.now();
    });

    worker.on('exit', () => {
        videoMetrics.workerState = 'stopped';
        videoMetrics.pending = 0;
        videoMetrics.lastUpdatedAt = Date.now();
    });

    worker.__videoMetricsBound = true;
}

function getIndexingWorker() {
    if (!__indexingWorker) {
        __indexingWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'indexing-worker.js'), {
            resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 256) }
        });
        attachDefaultHandlers(__indexingWorker, 'indexingWorker');
    }
    return __indexingWorker;
}

function getSettingsWorker() {
    if (!__settingsWorker) {
        __settingsWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'settings-worker.js'), {
            resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 256) }
        });
        // 安装一次性消息监听，实现 worker → 主进程状态回填
        if (!__settingsWorker.__peMessageHooked) {
            try {
                __settingsWorker.on('message', (msg) => {
                    try {
                        const settingsController = require('../controllers/settings.controller');
                        if (msg && msg.type === 'settings_update_complete') {
                            settingsController.updateSettingsStatus('success', null, msg.updateId || null);
                        } else if (msg && msg.type === 'settings_update_failed') {
                            settingsController.updateSettingsStatus('failed', msg.error || null, msg.updateId || null);
                        }
                    } catch (e) {
                        // ignore
                    }
                });
                __settingsWorker.__peMessageHooked = true;
            } catch {}
        }
        attachDefaultHandlers(__settingsWorker, 'settingsWorker');
    }
    return __settingsWorker;
}

function getHistoryWorker() {
    if (!__historyWorker) {
        __historyWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'history-worker.js'), {
            resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 256) }
        });
        attachDefaultHandlers(__historyWorker, 'historyWorker');
    }
    return __historyWorker;
}

function getVideoWorker() {
    if (!__videoWorker) {
        __videoWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'video-processor.js'), {
            resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 256) }
        });
        attachDefaultHandlers(__videoWorker, 'videoWorker');
        attachVideoMetrics(__videoWorker);
    }
    return __videoWorker;
}

// 缩略图工作线程池管理
// 使用线程池模式处理缩略图生成任务，提高并发处理能力
const thumbnailWorkers = [];        // 所有缩略图工作线程的数组
const idleThumbnailWorkers = [];    // 空闲的缩略图工作线程队列

/**
 * 工作线程池管理器
 * 管理缩略图工作线程的生命周期、空闲回收和动态扩缩容
 */
class WorkerPoolManager {
    constructor() {
        // 从配置中读取参数，避免硬编码
        this.idleShutdownMs = Number(process.env.THUMB_IDLE_SHUTDOWN_MS || 600000); // 默认10分钟
        this.checkIntervalMs = Number(process.env.THUMB_CHECK_INTERVAL_MS || 60000); // 默认60秒
        this.lastUseTs = 0;
        this.checkTimer = null;
        this.startIdleCheck();
    }

    /**
     * 记录使用时间戳
     */
    noteUsage() {
        this.lastUseTs = Date.now();
    }

    /**
     * 检查是否满足空闲回收条件
     */
    shouldRecycle() {
        if (thumbnailWorkers.length === 0) return false;
        const allIdle = idleThumbnailWorkers.length === thumbnailWorkers.length;
        const active = Number(global.__thumbActiveCount || 0);
        const idleFor = Date.now() - (this.lastUseTs || 0);
        return allIdle && active === 0 && this.lastUseTs && idleFor > this.idleShutdownMs;
    }

    /**
     * 开始空闲检查定时器
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
     * 停止空闲检查
     */
    stopIdleCheck() {
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = null;
        }
    }

    /**
     * 销毁线程池
     */
    destroyPool() {
        try {
            thumbnailWorkers.forEach(w => { try { w.terminate(); } catch {} });
        } catch {}
        thumbnailWorkers.length = 0;
        idleThumbnailWorkers.length = 0;
        this.lastUseTs = 0;
        logger.info(`已销毁缩略图工作线程池（空闲回收，超时: ${this.idleShutdownMs}ms）`);
    }

    /**
     * 确保线程池存在
     */
    ensurePool() {
        if (thumbnailWorkers.length === 0) {
            this.createPool();
        }
    }

    /**
     * 创建线程池
     */
    createPool() {
        if (thumbnailWorkers.length > 0) return;
        const initialSize = Math.max(1, Math.min(INITIAL_THUMB_WORKERS, NUM_WORKERS || 1));
        logger.info(`创建 ${initialSize} 个缩略图处理工人...`);
        this.lastUseTs = Date.now();

        // 创建指定数量的缩略图工作线程
        for (let i = 0; i < initialSize; i++) {
            const worker = new Worker(path.resolve(__dirname, '..', 'workers', 'thumbnail-worker.js'), {
                workerData: { workerId: i + 1 },  // 为每个工作线程分配唯一ID
                resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 256) }
            });
            thumbnailWorkers.push(worker);
            idleThumbnailWorkers.push(worker);
        }
    }
}

// 创建单例管理器
const workerPoolManager = new WorkerPoolManager();

function ensureThumbnailWorkerPool() {
    workerPoolManager.ensurePool();
}

function destroyThumbnailWorkerPool() {
    workerPoolManager.destroyPool();
}

function noteThumbnailUse() {
    workerPoolManager.noteUsage();
}

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

// 兼容旧用法：保留原函数名作为别名
const createThumbnailWorkerPool = () => {
    workerPoolManager.createPool();
};

// 扩缩容：将线程池规模调整为 targetSize（只在空闲线程可用时缩减）
function scaleThumbnailWorkerPool(targetSize) {
    try {
        targetSize = Math.max(0, Math.floor(Number(targetSize)));
        const current = thumbnailWorkers.length;
        if (targetSize === current) return current;

        if (targetSize > current) {
            const need = targetSize - current;
            for (let i = 0; i < need; i++) {
                const workerId = thumbnailWorkers.length + 1;
                const worker = new Worker(path.resolve(__dirname, '..', 'workers', 'thumbnail-worker.js'), {
                    workerData: { workerId },
                    resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 256) }
                });
                thumbnailWorkers.push(worker);
                idleThumbnailWorkers.push(worker);
            }
            try { workerPoolManager.noteUsage(); } catch {}
            // 确保新线程安装监听器（幂等）。延迟 require 避免循环依赖时机问题。
            try { require('./thumbnail.service').setupThumbnailWorkerListeners(); } catch {}
            logger.info(`[ThumbPool] 扩容: ${current} -> ${thumbnailWorkers.length}`);
            return thumbnailWorkers.length;
        } else {
            // 缩容优先回收空闲线程；若空闲不足，则尽可能缩
            let canRemove = Math.max(0, current - targetSize);
            let removed = 0;
            while (canRemove > 0 && idleThumbnailWorkers.length > 0) {
                const idle = idleThumbnailWorkers.pop();
                // 从总列表移除
                const idx = thumbnailWorkers.indexOf(idle);
                if (idx > -1) thumbnailWorkers.splice(idx, 1);
                try {
                    idle.removeAllListeners();
                    idle.terminate();
                } catch {}
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

// 为专用工作线程设置错误处理（在首次创建时绑定）
function attachDefaultHandlers(worker, name) {
    if (!worker.__handlersAttached) {
        worker.on('error', (err) => logger.error(`${name} 遇到错误:`, err));
        worker.on('exit', (code) => { if (code !== 0) logger.warn(`${name} 意外退出，退出码: ${code}`); });
        worker.__handlersAttached = true;
    }
}

function ensureCoreWorkers() {
    const w1 = getIndexingWorker(); attachDefaultHandlers(w1, 'indexingWorker');
    const w2 = getSettingsWorker(); attachDefaultHandlers(w2, 'settingsWorker');
    const w3 = getHistoryWorker(); attachDefaultHandlers(w3, 'historyWorker');
    const w4 = getVideoWorker(); attachDefaultHandlers(w4, 'videoWorker');
    return { w1, w2, w3, w4 };
}

/**
 * 一次性工作线程工厂（任务即生命周期）
 * - kind: indexing | settings | history | video | thumbnail
 * - 不缓存实例；调用方负责监听完成并终止
 */
function createDisposableWorker(kind, workerData = {}) {
    const map = {
        indexing: 'indexing-worker.js',
        settings: 'settings-worker.js',
        history: 'history-worker.js',
        video: 'video-processor.js',
        thumbnail: 'thumbnail-worker.js',
    };
    const file = map[kind];
    if (!file) throw new Error(`Unknown worker kind: ${kind}`);
    return new Worker(path.resolve(__dirname, '..', 'workers', file), {
        workerData,
        resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 256) }
    });
}

// 导出工作线程管理器
module.exports = {
    // 单例工作线程（惰性获取）
    getIndexingWorker,
    getSettingsWorker,
    getHistoryWorker,
    getVideoWorker,
    ensureCoreWorkers,
    createDisposableWorker,

    // 其他工作线程
    thumbnailWorkers,  // 缩略图工作线程池
    idleThumbnailWorkers, // 空闲缩略图工作线程队列
    createThumbnailWorkerPool, // 创建缩略图工作线程池的函数
    ensureThumbnailWorkerPool, // 懒加载创建
    destroyThumbnailWorkerPool, // 空闲回收销毁
    noteThumbnailUse, // 记录使用时间（用于回收判定）
    scaleThumbnailWorkerPool, // 自适应扩缩容
    getTaskSchedulerMetrics,
    getVideoTaskMetrics,
};

// 优化函数：智能任务调度
function scheduleWorkerTask(taskType, payload, options = {}) {
  const { priority = 1, timeout = 300000, retries = 3 } = options;

  const task = {
    id: `${taskType}_${Date.now()}_${Math.random()}`,
    type: taskType,
    priority,
    payload,
    handler: async (data) => {
      // 根据任务类型选择合适的Worker
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
        default:
          throw new Error(`Unknown task type: ${taskType}`);
      }
    }
  };

  taskScheduler.addTask(task);
  return task.id;
}

// 优化函数：负载均衡Worker选择
function selectOptimalWorker(taskType) {
  // 简单的负载均衡逻辑，可以根据实际需要扩展
  switch (taskType) {
    case 'thumbnail':
      // 为缩略图任务选择最优的Worker
      if (idleThumbnailWorkers.length > 0) {
        return idleThumbnailWorkers[0];
      }
      // 如果没有空闲Worker，创建一个新的
      if (thumbnailWorkers.length < NUM_WORKERS) {
        scaleThumbnailWorkerPool(thumbnailWorkers.length + 1);
        return thumbnailWorkers[thumbnailWorkers.length - 1];
      }
      break;

    case 'index':
      return getIndexingWorker();

    case 'settings':
      return getSettingsWorker();

    case 'history':
      return getHistoryWorker();

    case 'video':
      return getVideoWorker();
  }

  return null;
}

// 优化函数：Worker健康检查
function performWorkerHealthCheck() {
  const status = {
    indexing: __indexingWorker ? 'active' : 'inactive',
    settings: __settingsWorker ? 'active' : 'inactive',
    history: __historyWorker ? 'active' : 'inactive',
    video: __videoWorker ? 'active' : 'inactive',
    thumbnail: {
      total: thumbnailWorkers.length,
      idle: idleThumbnailWorkers.length,
      active: thumbnailWorkers.length - idleThumbnailWorkers.length
    },
    taskQueue: taskScheduler.getQueueStatus()
  };

  logger.debug('[WorkerHealth] 状态检查:', status);
  return status;
}

// 任务处理函数
async function processThumbnailTask(data) {
  const worker = selectOptimalWorker('thumbnail');
  if (!worker) {
    throw new Error('No available thumbnail worker');
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Thumbnail task timeout'));
    }, 300000); // 5分钟超时

    worker.once('message', (result) => {
      clearTimeout(timeout);
      if (result.success) {
        resolve(result);
      } else {
        reject(new Error(result.error || 'Thumbnail processing failed'));
      }
    });

    worker.postMessage({
      type: 'process_thumbnail',
      payload: data
    });
  });
}

async function processIndexTask(data) {
  const worker = getIndexingWorker();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Index task timeout'));
    }, 600000); // 10分钟超时

    worker.once('message', (result) => {
      clearTimeout(timeout);
      if (result.type === 'index_complete') {
        resolve(result);
      } else if (result.type === 'error') {
        reject(new Error(result.error || 'Index processing failed'));
      }
    });

    worker.postMessage({
      type: 'rebuild_index',
      payload: data
    });
  });
}

async function processVideoTask(data) {
  const worker = getVideoWorker();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Video task timeout'));
    }, 1800000); // 30分钟超时

    worker.once('message', (result) => {
      clearTimeout(timeout);
      if (result.success) {
        resolve(result);
      } else {
        reject(new Error(result.error || 'Video processing failed'));
      }
    });

    worker.postMessage({
      type: 'process_video',
      payload: data
    });
  });
}

// 兼容旧用法：按属性名导出 worker 实例（首次访问时创建）
Object.defineProperties(module.exports, {
  indexingWorker: {
    enumerable: true,
    get() { return getIndexingWorker(); }
  },
  settingsWorker: {
    enumerable: true,
    get() { return getSettingsWorker(); }
  },
  historyWorker: {
    enumerable: true,
    get() { return getHistoryWorker(); }
  },
  videoWorker: {
    enumerable: true,
    get() { return getVideoWorker(); }
  },

  // 新增的优化功能
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