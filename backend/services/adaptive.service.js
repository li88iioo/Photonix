const os = require('os');
const logger = require('../config/logger');
const { NUM_WORKERS } = require('../config');
const { redis } = require('../config/redis');
const { safeRedisSet, safeRedisDel } = require('../utils/helpers');

const MEMORY_BUDGET_RATIO = Math.min(0.95, Math.max(0.1, Number(process.env.ADAPTIVE_MEMORY_BUDGET_RATIO || 0.7)));
const FORCED_MODE = (process.env.PERFORMANCE_MODE || 'auto').trim().toLowerCase();
const LOG_THROTTLE_MS = Math.max(0, Number(process.env.ADAPTIVE_LOG_THROTTLE_MS || 5 * 60 * 1000));

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

function resolveMode() {
    if (FORCED_MODE === 'high' || FORCED_MODE === 'medium' || FORCED_MODE === 'low') {
        return FORCED_MODE;
    }
    // 自动模式逻辑
    const load = os.loadavg()[0]; // 1分钟平均负载
    const cpus = cpuInfo.cpus;
    const memUsage = process.memoryUsage().rss / os.totalmem();

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
                thumbMaxConcurrency: 1,
                disableHlsBackfill: true,
                ffmpegThreads: 1,
                ffmpegPreset: process.env.FFMPEG_PRESET || 'veryfast'
            };
        case 'medium':
            return {
                thumbMaxConcurrency: Math.max(1, Math.floor(cpuBudget / 2)),
                disableHlsBackfill: false,
                ffmpegThreads: Math.max(1, Math.min(1, cpuBudget)),
                ffmpegPreset: process.env.FFMPEG_PRESET || 'veryfast'
            };
        case 'high':
        default:
            return {
                thumbMaxConcurrency: Math.max(1, cpuBudget),
                disableHlsBackfill: false,
                ffmpegThreads: Math.max(1, Math.min(2, cpuBudget)),
                ffmpegPreset: process.env.FFMPEG_PRESET || 'veryfast'
            };
    }
}

const cpuInfo = detectCpuBudget();
let currentMode = resolveMode();
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

async function startAdaptiveScheduler() {
    // 初始运行
    const run = async () => {
        currentMode = resolveMode();
        currentProfile = deriveProfile(currentMode, cpuInfo.cpus);
        const snap = resourceSnapshot();
        const snapshotStr =
            `mode=${currentMode} thumbMax=${currentProfile.thumbMaxConcurrency} ffmpegThreads=${currentProfile.ffmpegThreads} ` +
            `disableHLS=${currentProfile.disableHlsBackfill} cpu=${snap.cpus}(${snap.cpuSource}) mem=${snap.totalGb.toFixed(1)}GB(${snap.memSource})`;
        const shouldLog = snapshotStr !== lastLogSnapshot || (Date.now() - lastLogTime) >= LOG_THROTTLE_MS;

        if (shouldLog) {
            logger.debug(`[Adaptive] ${snapshotStr}`);
            lastLogSnapshot = snapshotStr;
            lastLogTime = Date.now();
        }

        // 发布配置到 Redis 供 Worker 读取
        if (redis && redis.status === 'ready') {
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
        }
    };

    await run();
    // 每分钟重新评估一次
    setInterval(run, 60000);
}

function getCurrentMode() {
    return currentMode;
}

function getThumbMaxConcurrency() {
    return currentProfile.thumbMaxConcurrency;
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

module.exports = {
    startAdaptiveScheduler,
    getCurrentMode,
    getThumbMaxConcurrency,
    shouldDisableHlsBackfill,
    getFfmpegConfig,
    hasResourceBudget,
    resourceSnapshot,
};
