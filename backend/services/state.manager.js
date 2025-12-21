/**
 * 状态管理模块
 * 替代全局变量，提供类型安全的状态访问
 * 
 * @module state.manager
 */

/**
 * 缩略图服务状态
 */
class ThumbnailState {
    constructor() {
        this.activeCount = 0;          // 活动任务数
        this.ondemandQueueLen = 0;     // 按需队列长度
        this.batchActive = false;       // 批处理是否活动
        this.batchLoopActive = false;   // 批处理循环是否活动
        this.taskMetrics = null;        // 任务指标对象
    }

    // 活动任务计数
    getActiveCount() {
        return this.activeCount;
    }

    setActiveCount(count) {
        this.activeCount = Math.max(0, Number(count) || 0);
    }

    incrementActiveCount() {
        this.activeCount++;
        return this.activeCount;
    }

    decrementActiveCount() {
        this.activeCount = Math.max(0, this.activeCount - 1);
        return this.activeCount;
    }

    // 队列长度
    getQueueLen() {
        return this.ondemandQueueLen;
    }

    setQueueLen(len) {
        this.ondemandQueueLen = Math.max(0, Number(len) || 0);
    }

    // 批处理状态
    isBatchActive() {
        return this.batchActive;
    }

    setBatchActive(active) {
        this.batchActive = Boolean(active);
    }

    isBatchLoopActive() {
        return this.batchLoopActive;
    }

    setBatchLoopActive(active) {
        this.batchLoopActive = Boolean(active);
    }

    // 任务指标
    getTaskMetrics() {
        return this.taskMetrics;
    }

    setTaskMetrics(metrics) {
        this.taskMetrics = metrics;
    }

    // 获取完整状态快照
    getSnapshot() {
        return {
            activeCount: this.activeCount,
            queueLen: this.ondemandQueueLen,
            batchActive: this.batchActive,
            batchLoopActive: this.batchLoopActive,
            hasMetrics: this.taskMetrics !== null
        };
    }
}

/**
 * 视频处理服务状态（HLS转码等）
 */
class VideoState {
    constructor() {
        this.activeCount = 0;          // 活动中的视频处理任务数
    }

    getActiveCount() {
        return this.activeCount;
    }

    setActiveCount(count) {
        this.activeCount = Math.max(0, Number(count) || 0);
    }

    incrementActiveCount() {
        this.activeCount++;
        return this.activeCount;
    }

    decrementActiveCount() {
        this.activeCount = Math.max(0, this.activeCount - 1);
        return this.activeCount;
    }

    getSnapshot() {
        return {
            activeCount: this.activeCount
        };
    }
}

/**
 * Worker服务状态
 */
class WorkerState {
    constructor() {
        this.taskMetrics = null;    // 任务调度器指标
        this.videoMetrics = null;   // 视频处理指标
        this.coreStatuses = new Map(); // 核心worker状态
    }

    getTaskMetrics() {
        return this.taskMetrics;
    }

    setTaskMetrics(metrics) {
        this.taskMetrics = metrics;
    }

    getVideoMetrics() {
        return this.videoMetrics;
    }

    setVideoMetrics(metrics) {
        this.videoMetrics = metrics;
    }

    setWorkerStatus(name, status) {
        if (!name) return;
        this.coreStatuses.set(String(name), status);
    }

    getWorkerStatus(name) {
        return this.coreStatuses.get(String(name));
    }

    getAllWorkerStatuses() {
        return Object.fromEntries(this.coreStatuses.entries());
    }
}

/**
 * 认证状态
 */
class AuthState {
    constructor() {
        this.firstAuthLogged = false;
    }

    isFirstAuthLogged() {
        return this.firstAuthLogged;
    }

    setFirstAuthLogged(logged) {
        this.firstAuthLogged = Boolean(logged);
    }
}

/**
 * 日志限流状态
 */
class LogThrottleState {
    constructor() {
        this.lastThumbLogTime = 0;
    }

    getLastThumbLogTime() {
        return this.lastThumbLogTime;
    }

    setLastThumbLogTime(time) {
        this.lastThumbLogTime = Number(time) || 0;
    }

    shouldLogThumb(intervalMs = 5000) {
        const now = Date.now();
        if (!this.lastThumbLogTime || now - this.lastThumbLogTime > intervalMs) {
            this.lastThumbLogTime = now;
            return true;
        }
        return false;
    }
}

/**
 * 文件监听器状态
 */
class WatcherState {
    constructor() {
        this.running = false;
        this.lastRestartAttempt = 0;
    }

    isRunning() {
        return this.running;
    }

    setRunning(running) {
        this.running = Boolean(running);
    }

    getLastRestartAttempt() {
        return this.lastRestartAttempt;
    }

    setLastRestartAttempt(time) {
        this.lastRestartAttempt = Number(time) || 0;
    }

    shouldAttemptRestart(throttleMs = 30000) {
        const now = Date.now();
        if (!this.running && now - this.lastRestartAttempt > throttleMs) {
            this.lastRestartAttempt = now;
            return true;
        }
        return false;
    }
}

/**
 * 全局状态管理器（单例）
 */
class StateManager {
    constructor() {
        this.thumbnail = new ThumbnailState();
        this.video = new VideoState();
        this.worker = new WorkerState();
        this.auth = new AuthState();
        this.logThrottle = new LogThrottleState();
        this.watcher = new WatcherState();
    }

    /**
     * 获取所有状态的快照（用于调试和监控）
     */
    getGlobalSnapshot() {
        return {
            thumbnail: this.thumbnail.getSnapshot(),
            video: this.video.getSnapshot(),
            auth: {
                firstAuthLogged: this.auth.isFirstAuthLogged()
            },
            logThrottle: {
                lastThumbLogTime: this.logThrottle.getLastThumbLogTime()
            },
            watcher: {
                running: this.watcher.isRunning(),
                lastRestartAttempt: this.watcher.getLastRestartAttempt()
            }
        };
    }

    /**
     * 重置所有状态（主要用于测试）
     */
    reset() {
        this.thumbnail = new ThumbnailState();
        this.video = new VideoState();
        this.worker = new WorkerState();
        this.auth = new AuthState();
        this.logThrottle = new LogThrottleState();
        this.watcher = new WatcherState();
    }
}

// 导出单例实例
const stateManager = new StateManager();

module.exports = stateManager;
