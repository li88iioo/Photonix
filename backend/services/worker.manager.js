const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('../config/logger');
const { NUM_WORKERS } = require('../config');

const WORKER_MEMORY_MB = Number(process.env.WORKER_MEMORY_MB || 256);
const THUMB_WORKER_MEMORY_MB = Number(process.env.THUMB_WORKER_MEMORY_MB || 512);
const INITIAL_THUMB_WORKERS = (() => {
    const envValue = Number(process.env.THUMB_INITIAL_WORKERS);
    if (Number.isFinite(envValue) && envValue > 0) {
        return Math.max(1, Math.floor(envValue));
    }
    return Math.max(1, NUM_WORKERS || 1);
})();

let indexingWorker = null;
let settingsWorker = null;
let videoWorker = null;

const thumbnailWorkers = [];
const idleThumbnailWorkers = [];
let desiredThumbnailSize = INITIAL_THUMB_WORKERS;
let lastThumbnailUseAt = 0;

const workerScripts = {
    indexing: path.resolve(__dirname, '..', 'workers', 'indexing-worker.js'),
    settings: path.resolve(__dirname, '..', 'workers', 'settings-worker.js'),
    video: path.resolve(__dirname, '..', 'workers', 'video-processor.js'),
    thumbnail: path.resolve(__dirname, '..', 'workers', 'thumbnail-worker.js'),
};

function attachCoreWorkerLogging(worker, name) {
    worker.on('error', (error) => {
        logger.error(`[WorkerManager] ${name} worker error:`, error);
    });
    worker.once('exit', (code) => {
        if (code !== 0 && !worker.__expectedTermination) {
            logger.warn(`[WorkerManager] ${name} worker exited with code ${code}`);
        }
        switch (name) {
            case 'indexing':
                indexingWorker = null;
                break;
            case 'settings':
                settingsWorker = null;
                break;
            case 'video':
                videoWorker = null;
                break;
            default:
                break;
        }
    });
}

function spawnCoreWorker(name, workerData = {}) {
    const script = workerScripts[name];
    if (!script) {
        throw new Error(`Unknown worker: ${name}`);
    }
    const worker = new Worker(script, {
        workerData,
        resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB }
    });
    attachCoreWorkerLogging(worker, name);
    return worker;
}

function getIndexingWorker() {
    if (!indexingWorker) {
        indexingWorker = spawnCoreWorker('indexing');
    }
    return indexingWorker;
}

function getSettingsWorker() {
    if (!settingsWorker) {
        settingsWorker = spawnCoreWorker('settings');
    }
    return settingsWorker;
}

function startVideoWorker() {
    if (!videoWorker) {
        videoWorker = spawnCoreWorker('video');
    }
    return videoWorker;
}

function getVideoWorker() {
    return videoWorker;
}

function ensureCoreWorkers() {
    return {
        indexing: getIndexingWorker(),
        settings: getSettingsWorker()
    };
}

function createDisposableWorker(kind, workerData = {}) {
    const map = {
        indexing: workerScripts.indexing,
        settings: workerScripts.settings,
        video: workerScripts.video,
        thumbnail: workerScripts.thumbnail,
    };
    const script = map[kind];
    if (!script) {
        const { ValidationError } = require('../utils/errors');
        throw new ValidationError(`Unknown worker kind: ${kind}`, { kind, validKinds: Object.keys(map) });
    }
    return new Worker(script, {
        workerData,
        resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB }
    });
}

function removeThumbnailWorkerFromQueues(worker) {
    const idx = thumbnailWorkers.indexOf(worker);
    if (idx > -1) {
        thumbnailWorkers.splice(idx, 1);
    }
    const idleIdx = idleThumbnailWorkers.indexOf(worker);
    if (idleIdx > -1) {
        idleThumbnailWorkers.splice(idleIdx, 1);
    }
}

function spawnThumbnailWorker(id) {
    const worker = new Worker(workerScripts.thumbnail, {
        workerData: { workerId: id },
        resourceLimits: { maxOldGenerationSizeMb: THUMB_WORKER_MEMORY_MB }
    });

    worker.on('error', (error) => {
        logger.error('[WorkerManager] 缩略图 worker 错误:', error);
    });

    worker.once('exit', (code) => {
        removeThumbnailWorkerFromQueues(worker);
        if (!worker.__expectedTermination) {
            logger.warn(`[WorkerManager] 缩略图 worker 意外退出 (code ${code})，将尝试补充`);
            if (thumbnailWorkers.length < desiredThumbnailSize) {
                spawnThumbnailWorker(thumbnailWorkers.length + 1);
            }
        }
    });

    thumbnailWorkers.push(worker);
    idleThumbnailWorkers.push(worker);
    notifyThumbnailService();
    return worker;
}

function notifyThumbnailService() {
    try {
        const service = require('./thumbnail.service');
        if (service && typeof service.setupThumbnailWorkerListeners === 'function') {
            service.setupThumbnailWorkerListeners();
        }
    } catch (error) {
        logger.debug('[WorkerManager] 安装缩略图监听器失败（忽略）:', error.message);
    }
}

function ensureThumbnailWorkerPool() {
    if (thumbnailWorkers.length > 0) {
        return;
    }
    desiredThumbnailSize = Math.max(1, desiredThumbnailSize);
    for (let i = 0; i < desiredThumbnailSize; i += 1) {
        spawnThumbnailWorker(i + 1);
    }
    logger.info(`[WorkerManager] 已启动 ${thumbnailWorkers.length} 个缩略图 worker`);
}

function createThumbnailWorkerPool(size = INITIAL_THUMB_WORKERS) {
    desiredThumbnailSize = Math.max(1, Math.floor(size));
    ensureThumbnailWorkerPool();
}

function destroyThumbnailWorkerPool() {
    desiredThumbnailSize = 0;
    thumbnailWorkers.forEach((worker) => {
        try {
            worker.__expectedTermination = true;
            worker.terminate();
        } catch (error) {
            logger.warn('[WorkerManager] 终止缩略图 worker 失败:', error.message);
        }
    });
    thumbnailWorkers.length = 0;
    idleThumbnailWorkers.length = 0;
    logger.info('[WorkerManager] 缩略图 worker 池已销毁');
}

function noteThumbnailUse() {
    lastThumbnailUseAt = Date.now();
}

function scaleThumbnailWorkerPool(targetSize) {
    const target = Math.max(0, Math.floor(targetSize));
    desiredThumbnailSize = target;
    if (target === 0) {
        destroyThumbnailWorkerPool();
        return 0;
    }
    ensureThumbnailWorkerPool();
    while (thumbnailWorkers.length < target) {
        spawnThumbnailWorker(thumbnailWorkers.length + 1);
    }
    while (thumbnailWorkers.length > target && idleThumbnailWorkers.length > 0) {
        const worker = idleThumbnailWorkers.pop();
        if (!worker) break;
        removeThumbnailWorkerFromQueues(worker);
        try {
            worker.__expectedTermination = true;
            worker.terminate();
        } catch (error) {
            logger.warn('[WorkerManager] 缩容 worker 失败:', error.message);
        }
    }
    return thumbnailWorkers.length;
}

function performWorkerHealthCheck() {
    return {
        indexing: { active: !!indexingWorker },
        settings: { active: !!settingsWorker },
        video: { active: !!videoWorker },
        thumbnail: {
            total: thumbnailWorkers.length,
            idle: idleThumbnailWorkers.length,
            active: Math.max(0, thumbnailWorkers.length - idleThumbnailWorkers.length),
            lastUseAt: lastThumbnailUseAt
        }
    };
}

const schedulerMetrics = {
    queued: 0,
    processing: 0,
    pending: 0,
    completed: 0,
    failed: 0,
    retries: 0,
    lastError: null,
    lastFailureAt: null,
    lastUpdatedAt: Date.now()
};

const videoMetrics = {
    pending: 0,
    completed: 0,
    failed: 0,
    lastError: null,
    lastFailureAt: null,
    lastQueuedAt: null,
    lastQueuedPath: null,
    lastCompletedPath: null,
    workerState: 'inactive',
    lastUpdatedAt: Date.now()
};

function getTaskSchedulerMetrics() {
    return { ...schedulerMetrics };
}

function getVideoTaskMetrics() {
    return { ...videoMetrics };
}

module.exports = {
    getIndexingWorker,
    getSettingsWorker,
    getVideoWorker,
    startVideoWorker,
    ensureCoreWorkers,
    createDisposableWorker,
    thumbnailWorkers,
    idleThumbnailWorkers,
    createThumbnailWorkerPool,
    ensureThumbnailWorkerPool,
    destroyThumbnailWorkerPool,
    noteThumbnailUse,
    scaleThumbnailWorkerPool,
    performWorkerHealthCheck,
    getTaskSchedulerMetrics,
    getVideoTaskMetrics,
};
