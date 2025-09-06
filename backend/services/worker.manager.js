/**
 * 工作线程管理器模块 - 简化版
 * 管理各种后台任务的工作线程，移除队列模式复杂性
 */
const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('../config/logger');
const { NUM_WORKERS } = require('../config');

// 惰性创建专门的单例工作线程（避免在模块加载阶段即拉起原生依赖）
let __indexingWorker = null;
let __settingsWorker = null;
let __historyWorker = null;
let __videoWorker = null;

function getIndexingWorker() {
    if (!__indexingWorker) {
        __indexingWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'indexing-worker.js'), {
            resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 512) }
        });
        attachDefaultHandlers(__indexingWorker, 'indexingWorker');
    }
    return __indexingWorker;
}

function getSettingsWorker() {
    if (!__settingsWorker) {
        __settingsWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'settings-worker.js'), {
            resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 512) }
        });
        attachDefaultHandlers(__settingsWorker, 'settingsWorker');
    }
    return __settingsWorker;
}

function getHistoryWorker() {
    if (!__historyWorker) {
        __historyWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'history-worker.js'), {
            resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 512) }
        });
        attachDefaultHandlers(__historyWorker, 'historyWorker');
    }
    return __historyWorker;
}

function getVideoWorker() {
    if (!__videoWorker) {
        __videoWorker = new Worker(path.resolve(__dirname, '..', 'workers', 'video-processor.js'), {
            resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 512) }
        });
        attachDefaultHandlers(__videoWorker, 'videoWorker');
    }
    return __videoWorker;
}

// 缩略图工作线程池管理
// 使用线程池模式处理缩略图生成任务，提高并发处理能力
const thumbnailWorkers = [];        // 所有缩略图工作线程的数组
const idleThumbnailWorkers = [];    // 空闲的缩略图工作线程队列

/**
 * 创建缩略图工作线程池
 * 根据配置的工作线程数量创建缩略图处理线程池
 */
const createThumbnailWorkerPool = () => {
    logger.info(`创建 ${NUM_WORKERS} 个缩略图处理工人...`);
    
    // 创建指定数量的缩略图工作线程
    for (let i = 0; i < NUM_WORKERS; i++) {
        const worker = new Worker(path.resolve(__dirname, '..', 'workers', 'thumbnail-worker.js'), {
            workerData: { workerId: i + 1 },  // 为每个工作线程分配唯一ID
            resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WORKER_MEMORY_MB || 512) }
        });
        
        // 将工作线程添加到管理数组中
        thumbnailWorkers.push(worker);
        idleThumbnailWorkers.push(worker);
    }
};

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

// 导出工作线程管理器
module.exports = {
    // 单例工作线程（惰性获取）
    getIndexingWorker,
    getSettingsWorker,
    getHistoryWorker,
    getVideoWorker,
    ensureCoreWorkers,

    // 其他工作线程
    thumbnailWorkers,  // 缩略图工作线程池
    idleThumbnailWorkers, // 空闲缩略图工作线程队列
    createThumbnailWorkerPool, // 创建缩略图工作线程池的函数
};

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
});