/**
 * 自适应性能模式管理
 * - 暴露四种模式：high | medium | low | auto
 * - 根据系统负载(1m loadavg)与 CPU 数自动判定（auto）
 * - 向内部读取方提供：缩略图并发上限、是否禁用HLS回填、ffmpeg 线程数/预设等
 * - 同步关键参数到 Redis，便于工作线程（如 video-processor）跨线程读取
 */
const os = require('os');
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { NUM_WORKERS } = require('../config');

const MODE_KEY = 'adaptive:mode';
const FF_THREADS_KEY = 'adaptive:ffmpeg_threads';
const FF_PRESET_KEY = 'adaptive:ffmpeg_preset';
const DISABLE_HLS_BACKFILL_KEY = 'adaptive:disable_hls_backfill';
const THUMB_MAX_CONCURRENT_KEY = 'adaptive:thumb_max_concurrent';

// 外部可通过环境变量强制固定模式（high/medium/low/auto）
const FORCED_MODE = (process.env.PERFORMANCE_MODE || 'auto').trim().toLowerCase();

// 内部状态
let currentMode = FORCED_MODE;
let lastPublishTs = 0;

function selectModeAuto() {
    try {
        const cpus = Math.max(1, os.cpus().length);
        // 在容器/部分平台，os.loadavg() 可能不可用，做保护
        const la = os.loadavg && os.loadavg()[0] || 0;
        // 负载阈值（经验值）：>0.8*CPU -> low，>0.5*CPU -> medium，否则 high
        if (la > cpus * 0.8) return 'low';
        if (la > cpus * 0.5) return 'medium';
        return 'high';
    } catch {
        return 'medium';
    }
}

function resolveMode() {
    if (FORCED_MODE === 'high' || FORCED_MODE === 'medium' || FORCED_MODE === 'low') {
        return FORCED_MODE;
    }
    return selectModeAuto();
}

function deriveProfile(mode) {
    // 统一并发画像：缩略图并发、HLS回填开关、ffmpeg 线程/预设
    const cpuBased = Math.max(1, Math.floor(NUM_WORKERS));
    switch (mode) {
        case 'low':
            return {
                thumbMaxConcurrency: 1,
                disableHlsBackfill: true,
                ffmpegThreads: 1,
                ffmpegPreset: process.env.FFMPEG_PRESET || 'veryfast',
            };
        case 'medium':
            return {
                thumbMaxConcurrency: Math.max(1, Math.floor(cpuBased / 2)),
                disableHlsBackfill: false,
                ffmpegThreads: Math.max(1, Math.min(2, cpuBased)),
                ffmpegPreset: process.env.FFMPEG_PRESET || 'veryfast',
            };
        case 'high':
        default:
            return {
                thumbMaxConcurrency: Math.max(1, Math.min(cpuBased, 4)),
                disableHlsBackfill: false,
                ffmpegThreads: Math.max(1, Math.min(4, cpuBased)),
                ffmpegPreset: process.env.FFMPEG_PRESET || 'veryfast',
            };
    }
}

async function publishProfile(mode, profile) {
    try {
        const ttl = 60; // 秒
        await redis.set(MODE_KEY, mode, 'EX', ttl).catch(() => {});
        await redis.set(FF_THREADS_KEY, String(profile.ffmpegThreads || 1), 'EX', ttl).catch(() => {});
        await redis.set(FF_PRESET_KEY, String(profile.ffmpegPreset || 'veryfast'), 'EX', ttl).catch(() => {});
        await redis.set(DISABLE_HLS_BACKFILL_KEY, profile.disableHlsBackfill ? '1' : '0', 'EX', ttl).catch(() => {});
        await redis.set(THUMB_MAX_CONCURRENT_KEY, String(profile.thumbMaxConcurrency || 1), 'EX', ttl).catch(() => {});
        lastPublishTs = Date.now();
    } catch (e) {
        logger.debug('[Adaptive] 发布 profile 到 Redis 失败（忽略）：' + e.message);
    }
}

function getCurrentMode() {
    return currentMode || 'medium';
}

function getThumbMaxConcurrency() {
    return deriveProfile(getCurrentMode()).thumbMaxConcurrency;
}

function shouldDisableHlsBackfill() {
    return !!deriveProfile(getCurrentMode()).disableHlsBackfill;
}

function getFfmpegConfig() {
    const p = deriveProfile(getCurrentMode());
    return { threads: p.ffmpegThreads, preset: p.ffmpegPreset };
}

let ticker = null;
function startAdaptiveScheduler() {
    // 立即计算一次
    const mode = resolveMode();
    currentMode = mode;
    const profile = deriveProfile(mode);
    logger.info(`[Adaptive] 启动: mode=${mode} thumbMax=${profile.thumbMaxConcurrency} ffmpegThreads=${profile.ffmpegThreads} disableBackfill=${profile.disableHlsBackfill}`);
    publishProfile(mode, profile);

    if (ticker) return;
    ticker = setInterval(() => {
        try {
            const next = resolveMode();
            if (next !== currentMode || Date.now() - lastPublishTs > 30000) {
                currentMode = next;
                const prof = deriveProfile(next);
                logger.info(`[Adaptive] 更新: mode=${next} thumbMax=${prof.thumbMaxConcurrency} ffmpegThreads=${prof.ffmpegThreads} disableBackfill=${prof.disableHlsBackfill}`);
                publishProfile(next, prof);
            }
        } catch (e) {
            logger.debug('[Adaptive] 调度器异常（忽略）：' + e.message);
        }
    }, 15000);
}

module.exports = {
    startAdaptiveScheduler,
    getCurrentMode,
    getThumbMaxConcurrency,
    shouldDisableHlsBackfill,
    getFfmpegConfig,
};


