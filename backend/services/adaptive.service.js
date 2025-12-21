const os = require('os');
const logger = require('../config/logger');
const { NUM_WORKERS } = require('../config');
const { redis } = require('../config/redis');
const { safeRedisSet, safeRedisDel } = require('../utils/helpers');

const MEMORY_BUDGET_RATIO = Math.min(0.95, Math.max(0.1, Number(process.env.ADAPTIVE_MEMORY_BUDGET_RATIO || 0.7)));
const FORCED_MODE = (process.env.PERFORMANCE_MODE || 'auto').trim().toLowerCase();
const LOG_THROTTLE_MS = Math.max(0, Number(process.env.ADAPTIVE_LOG_THROTTLE_MS || 10 * 60 * 1000)); // 默认10分钟
let noRedisLogged = false;

function detectCpuBudget() {
    const envCpus = Number(process.env.DETECTED_CPU_COUNT || process.env.CPU_COUNT || 0);
    const fromEnv = Number.isFinite(envCpus) && envCpus > 0;
    const count = Math.max(1, Math.floor(fromEnv ? envCpus : ((os.cpus && os.cpus().length) || 1)));
    return { cpus: count, source: fromEnv ? 'env' : 'system' };
}

function detectMemoryBudget() {
    const envMem = Number(process.env.DETECTED_MEMORY_GB || process.env.MEMORY_GB || 0);
    const fromEnv = Number.isFinite(envMem) && envMem > 0;
    const totalBytes = fromEnv ? envMem * 1024 * 1024 * 1024 : os.totalmem();
    return { totalBytes, totalGb: totalBytes / (1024 * 1024 * 1024), source: fromEnv ? 'env' : 'system' };
}

function resolveModeFromMetrics({ forcedMode, load, memUsage, cpus }) {
    if (forcedMode === 'high' || forcedMode === 'medium' || forcedMode === 'low') {
        return forcedMode;
    }

    if (load > cpus * 0.8 || memUsage > 0.85) {
        return 'low';
    }
    if (load > cpus * 0.5 || memUsage > 0.6) {
        return 'medium';
    }
    return 'high';
}

function deriveProfile(mode, cpuCount) {
    const cpuBudget = Math.max(1, Math.min(NUM_WORKERS, cpuCount));
    switch (mode) {
        case 'low':
            return {
                indexConcurrency: 2,          // 索引并发：高负载时降低
                disableHlsBackfill: true,
                ffmpegThreads: 1,
                ffmpegPreset: process.env.FFMPEG_PRESET || 'veryfast'
            };
        case 'medium':
            return {
                indexConcurrency: Math.max(2, Math.floor(cpuBudget / 2)),  // 索引并发：中等负载
                disableHlsBackfill: false,
                ffmpegThreads: Math.max(1, Math.min(2, cpuBudget)),  // 中负载允许最多2线程
                ffmpegPreset: process.env.FFMPEG_PRESET || 'veryfast'
            };
        case 'high':
        default:
            return {
                indexConcurrency: Math.max(2, cpuBudget),  // 索引并发：低负载时全力处理
                disableHlsBackfill: false,
                ffmpegThreads: Math.max(1, Math.min(2, cpuBudget)),
                ffmpegPreset: process.env.FFMPEG_PRESET || 'veryfast'
            };
    }
}

const cpuInfo = detectCpuBudget();
let currentMode = resolveModeFromMetrics({
    forcedMode: FORCED_MODE,
    load: os.loadavg()[0],
    memUsage: process.memoryUsage().rss / os.totalmem(),
    cpus: cpuInfo.cpus
});
let currentProfile = deriveProfile(currentMode, cpuInfo.cpus);
let lastLogSnapshot = '';
let lastLogTime = 0;

function resourceSnapshot() {
    const mem = detectMemoryBudget();
    return {
        cpus: cpuInfo.cpus,
        cpuSource: cpuInfo.source,
        totalGb: mem.totalGb,
        memSource: mem.source,
        budgetGb: mem.totalGb * MEMORY_BUDGET_RATIO,
        rssGb: process.memoryUsage().rss / (1024 * 1024 * 1024)
    };
}

function computeAdaptivePlan(detectors = {}) {
    const getLoad = detectors.getLoad || (() => os.loadavg()[0]);
    const getMemUsage = detectors.getMemUsage || (() => process.memoryUsage().rss / os.totalmem());
    const getCpus = detectors.getCpus || (() => cpuInfo.cpus);
    const mode = resolveModeFromMetrics({
        forcedMode: detectors.forcedMode || FORCED_MODE,
        load: getLoad(),
        memUsage: getMemUsage(),
        cpus: getCpus()
    });
    const profile = deriveProfile(mode, getCpus());
    const snap = resourceSnapshot();
    const snapshotStr =
        `mode=${mode} workers=${NUM_WORKERS} ffmpegThreads=${profile.ffmpegThreads} ` +
        `disableHLS=${profile.disableHlsBackfill} cpu=${snap.cpus}(${snap.cpuSource}) mem=${snap.totalGb.toFixed(1)}GB(${snap.memSource})`;

    return { mode, profile, snap, snapshotStr };
}

async function startAdaptiveScheduler() {
    // 初始运行
    const run = async () => {
        const plan = computeAdaptivePlan();
        currentMode = plan.mode;
        currentProfile = plan.profile;
        const snapshotStr = plan.snapshotStr;
        const snap = plan.snap;
        const shouldLog = snapshotStr !== lastLogSnapshot || (Date.now() - lastLogTime) >= LOG_THROTTLE_MS;

        if (shouldLog) {
            logger.debug(`[自适应] ${snapshotStr}`);
            lastLogSnapshot = snapshotStr;
            lastLogTime = Date.now();
        }

        // 发布配置到 Redis 供 Worker 读取（无 Redis 时降级为仅本进程生效）
        if (redis && redis.status === 'ready') {
            noRedisLogged = false;
            try {
                await safeRedisSet(redis, 'adaptive:ffmpeg_threads', String(currentProfile.ffmpegThreads), 'EX', 300, '发布FFmpeg线程数');
                await safeRedisSet(redis, 'adaptive:ffmpeg_preset', currentProfile.ffmpegPreset, 'EX', 300, '发布FFmpeg预设');
                if (currentProfile.disableHlsBackfill) {
                    await safeRedisSet(redis, 'adaptive:disable_hls_backfill', '1', 'EX', 300, '发布HLS禁用标记');
                } else {
                    await safeRedisDel(redis, 'adaptive:disable_hls_backfill', '清除HLS禁用标记');
                }
            } catch (e) {
                logger.debug(`[Adaptive] 发布配置失败: ${e.message}`);
            }
        } else if (!noRedisLogged) {
            logger.debug('[Adaptive] Redis 不可用，使用本地模式（worker 侧无法读取自适应配置）');
            noRedisLogged = true;
        }
    };

    await run();
    // 每分钟重新评估一次
    const timer = setInterval(run, 60000);
    // 允许进程退出（定时器不阻止进程退出）
    if (typeof timer.unref === 'function') timer.unref();
}

function getCurrentMode() {
    return currentMode;
}


function shouldDisableHlsBackfill() {
    return !!currentProfile.disableHlsBackfill;
}

function getFfmpegConfig() {
    return { threads: currentProfile.ffmpegThreads, preset: currentProfile.ffmpegPreset };
}

function hasResourceBudget() {
    const cpuBudget = detectCpuBudget();
    const load = (os.loadavg && os.loadavg()[0]) || 0;
    const loadOk = load <= cpuBudget.cpus * 0.85;
    const memInfo = detectMemoryBudget();
    const rss = process.memoryUsage().rss;
    const memOk = rss <= memInfo.totalBytes * MEMORY_BUDGET_RATIO;
    return { loadOk, memOk, cpus: cpuBudget.cpus };
}

/**
 * 检测是否有前台任务正在执行（缩略图、HLS等）
 * @returns {boolean} true 表示有前台任务，false 表示空闲
 */
function hasForegroundTasks() {
    try {
        const state = require('./state.manager');

        // 检查缩略图任务
        const thumbActive = state.thumbnail.getActiveCount() || 0;
        const thumbQueued = state.thumbnail.getQueueLen() || 0;
        const thumbPending = thumbActive + thumbQueued;

        // 检查视频处理任务（HLS 转码等）
        const videoActive = state.video.getActiveCount() || 0;

        // 阈值：超过 5 个待处理缩略图任务或有活动视频任务即视为有前台负载
        if (thumbPending > 5 || videoActive > 0) {
            return true;
        }

        return false;
    } catch (error) {
        // 降级：无法检测时假设有前台任务（保守策略）
        return true;
    }
}

/**
 * 获取索引并发数（实时负载感知）
 * @param {string} scenario - 场景类型
 *   - 'initial': 首次索引
 *   - 'rebuild': 重建索引
 *   - 'incremental': 增量更新
 * @param {object} [options]
 * @param {() => boolean} [options.foregroundDetector] 自定义前台负载检测器（默认 hasForegroundTasks）
 * @returns {number} 并发数（2 ~ NUM_WORKERS * 2）
 *
 * **智能策略**：
 * 1. 无前台任务（用户未打开网页）→ 激进模式：全力加速索引
 * 2. 有前台任务（用户正在浏览）→ 保守模式：为前台让路
 */
function getIndexConcurrency(scenario = 'initial', options = {}) {
    const base = currentProfile.indexConcurrency || 8;

    // 检测前台负载
    const foregroundDetector = typeof options.foregroundDetector === 'function' ? options.foregroundDetector : hasForegroundTasks;
    let hasForeground = true;
    try {
        hasForeground = foregroundDetector();
    } catch (e) {
        // 保守默认：探测失败时认为有前台任务，避免过载
        hasForeground = true;
    }

    // 策略 1：无前台任务时全力加速
    if (!hasForeground) {
        // 空闲模式：根据场景激进调整
        const idleMultiplier = {
            'initial': 1.5,    // 首次索引：提升 50%（充分利用空闲资源）
            'rebuild': 2.0,    // 重建索引：提升 100%（用户主动触发，加速完成）
            'incremental': 1.0 // 增量更新：使用基准值（通常文件少）
        };

        const multiplier = idleMultiplier[scenario] || 1.5;
        const calculated = Math.floor(base * multiplier);

        // 空闲时允许超过 NUM_WORKERS（利用 IO 等待）
        return Math.max(2, Math.min(calculated, NUM_WORKERS * 2));
    }

    // 策略 2：有前台任务时降低并发，为前台让路
    const busyMultiplier = {
        'initial': 0.5,    // 首次索引：降低 50%
        'rebuild': 0.75,   // 重建索引：降低 25%（用户期待快速完成）
        'incremental': 0.3 // 增量更新：降低 70%（最低优先级）
    };

    const multiplier = busyMultiplier[scenario] || 0.5;
    const calculated = Math.floor(base * multiplier);

    // 繁忙时限制在 NUM_WORKERS 以内
    return Math.max(2, Math.min(calculated, NUM_WORKERS));
}

module.exports = {
    startAdaptiveScheduler,
    getCurrentMode,
    getIndexConcurrency,       // 动态索引并发
    shouldDisableHlsBackfill,
    getFfmpegConfig,
    hasResourceBudget,
    resourceSnapshot,
};
