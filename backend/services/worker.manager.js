const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const Piscina = require('piscina');
const state = require('./state.manager');
const { NUM_WORKERS } = require('../config');

const WORKER_MEMORY_MB = Number(process.env.WORKER_MEMORY_MB || 256);
const INITIAL_THUMB_WORKERS = (() => {
    const envValue = Number(process.env.THUMB_INITIAL_WORKERS);
    if (Number.isFinite(envValue) && envValue > 0) {
        return Math.max(1, Math.floor(envValue));
    }
    return Math.max(1, NUM_WORKERS || 1);
})();

let desiredThumbnailSize = INITIAL_THUMB_WORKERS;
let lastThumbnailUseAt = 0;
let thumbnailPool = null;
let thumbnailPoolDisabled = false;

class CoreWorkerRegistry {
    constructor() {
        this.instances = new Map();
    }

    get(name, workerData = {}) {
        if (!this.instances.has(name)) {
            const worker = spawnCoreWorker(name, workerData);
            this.instances.set(name, worker);
        }
        return this.instances.get(name);
    }

    getExisting(name) {
        return this.instances.get(name) || null;
    }

    clear(name) {
        this.instances.delete(name);
    }
}

const coreWorkerRegistry = new CoreWorkerRegistry();

function getCoreWorkerSnapshot(name) {
    const worker = coreWorkerRegistry.getExisting(name);
    if (!worker) {
        return { active: false };
    }
    return {
        active: true,
        threadId: worker.threadId,
        resourceLimits: worker.resourceLimits || null
    };
}

const workerScripts = {
    indexing: path.resolve(__dirname, '..', 'workers', 'indexing-worker.js'),
    settings: path.resolve(__dirname, '..', 'workers', 'settings-worker.js'),
    video: path.resolve(__dirname, '..', 'workers', 'video-processor.js'),
    thumbnail: path.resolve(__dirname, '..', 'workers', 'thumbnail-worker.js'),
};

function attachCoreWorkerLogging(worker, name) {
    worker.on('error', (error) => {
        logger.error(`${LOG_PREFIXES.WORKER_MANAGER} Worker 发生错误`, {
            workerName: name,
            error: error?.message || String(error),
            stack: error?.stack,
            threadId: worker?.threadId
        });
    });
    worker.once('exit', (code) => {
        if (code !== 0 && !worker.__expectedTermination) {
            logger.warn(`${LOG_PREFIXES.WORKER_MANAGER} Worker 非正常退出`, {
                workerName: name,
                exitCode: code,
                threadId: worker?.threadId
            });
        }
        coreWorkerRegistry.clear(name);
    });
}

function spawnCoreWorker(name, workerData = {}) {
    const script = workerScripts[name];
    if (!script) {
        throw new Error(`Unknown worker: ${name}`);
    }
    const worker = new Worker(script, {
        workerData,
        // 注意：某些 Node.js 环境不允许在 Worker 中使用 --expose-gc
        // Worker 有独立的内存空间，会自动进行垃圾回收
        resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB }
    });
    attachCoreWorkerLogging(worker, name);
    return worker;
}

function getIndexingWorker() {
    return coreWorkerRegistry.get('indexing');
}

function getSettingsWorker() {
    return coreWorkerRegistry.get('settings');
}

function startVideoWorker() {
    return coreWorkerRegistry.get('video');
}

function getVideoWorker() {
    return coreWorkerRegistry.getExisting('video');
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

function createPiscinaPool(size) {
    const threads = Math.max(1, Math.floor(size));
    const pool = new Piscina({
        filename: workerScripts.thumbnail,
        minThreads: threads,
        maxThreads: threads,
        idleTimeout: Number(process.env.THUMB_POOL_IDLE_TIMEOUT_MS || 30000),
        concurrentTasksPerWorker: 1,
    });
    pool.on('error', (error) => logger.warn(`${LOG_PREFIXES.WORKER_MANAGER} 缩略图池错误`, {
        error: error?.message,
        poolThreads: threads
    }));
    logger.debug(`${LOG_PREFIXES.WORKER_MANAGER} 已启动 ${threads} 个缩略图 Piscina worker`);
    return pool;
}

function ensureThumbnailWorkerPool(size = desiredThumbnailSize) {
    if (thumbnailPoolDisabled) {
        return null;
    }
    const target = Math.max(1, Math.floor(size || desiredThumbnailSize));
    desiredThumbnailSize = target;
    if (!thumbnailPool) {
        thumbnailPool = createPiscinaPool(target);
        return thumbnailPool;
    }
    if (thumbnailPool.options.maxThreads !== target) {
        const oldSize = thumbnailPool.options.maxThreads;
        thumbnailPool.destroy().catch((error) => logger.debug(`${LOG_PREFIXES.WORKER_MANAGER} 销毁旧缩略图池失败: ${error && error.message}`));
        thumbnailPool = createPiscinaPool(target);
        logger.info(`${LOG_PREFIXES.WORKER_MANAGER} 缩略图池已扩缩容`, {
            oldSize,
            newSize: target,
            action: target > oldSize ? 'scale-up' : 'scale-down'
        });
    }
    return thumbnailPool;
}

function createThumbnailWorkerPool(size = INITIAL_THUMB_WORKERS) {
    thumbnailPoolDisabled = false;
    desiredThumbnailSize = Math.max(1, Math.floor(size));
    ensureThumbnailWorkerPool(desiredThumbnailSize);
}

function destroyThumbnailWorkerPool(options = {}) {
    const { disable = false } = options;
    if (disable) {
        thumbnailPoolDisabled = true;
    }
    desiredThumbnailSize = 0;
    if (thumbnailPool) {
        const pool = thumbnailPool;
        thumbnailPool = null;
        pool.destroy().catch((error) => logger.debug(`${LOG_PREFIXES.WORKER_MANAGER} 销毁缩略图池失败: ${error && error.message}`));
    }
    logger.debug(`${LOG_PREFIXES.WORKER_MANAGER} 缩略图 worker 池已销毁`);
}

function noteThumbnailUse() {
    lastThumbnailUseAt = Date.now();
}

function runThumbnailTask(payload) {
    if (thumbnailPoolDisabled) {
        throw new Error('Thumbnail worker pool disabled');
    }
    const pool = ensureThumbnailWorkerPool(desiredThumbnailSize);
    return pool.run(payload);
}

function scaleThumbnailWorkerPool(targetSize) {
    const normalized = Math.floor(targetSize);
    if (!Number.isFinite(normalized) || normalized <= 0) {
        destroyThumbnailWorkerPool({ disable: true });
        return 0;
    }
    thumbnailPoolDisabled = false;
    desiredThumbnailSize = Math.max(1, normalized);
    ensureThumbnailWorkerPool(desiredThumbnailSize);
    return desiredThumbnailSize;
}

function getThumbnailPoolStats() {
    if (!thumbnailPool) {
        return { total: 0, active: 0, idle: 0, lastUseAt: lastThumbnailUseAt };
    }
    const total = thumbnailPool.options.maxThreads;
    const active = Math.min(total, state.thumbnail.getActiveCount());
    return {
        total,
        active,
        idle: Math.max(0, total - active),
        lastUseAt: lastThumbnailUseAt
    };
}

function performWorkerHealthCheck() {
    const thumbStats = getThumbnailPoolStats();
    return {
        indexing: getCoreWorkerSnapshot('indexing'),
        settings: getCoreWorkerSnapshot('settings'),
        video: getCoreWorkerSnapshot('video'),
        thumbnail: {
            total: thumbStats.total,
            idle: thumbStats.idle,
            active: thumbStats.active,
            lastUseAt: thumbStats.lastUseAt
        }
    };
}

// 任务调度器指标（预留，供 /api/metrics 端点使用）
// TODO: 在任务执行流程中更新这些指标
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

// 视频任务指标（预留，供 /api/metrics 端点使用）
// TODO: 在视频处理流程中更新这些指标
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
    createThumbnailWorkerPool,
    ensureThumbnailWorkerPool,
    destroyThumbnailWorkerPool,
    noteThumbnailUse,
    runThumbnailTask,
    scaleThumbnailWorkerPool,
    getThumbnailPoolStats,
    performWorkerHealthCheck,
    getTaskSchedulerMetrics,
    getVideoTaskMetrics,
};
