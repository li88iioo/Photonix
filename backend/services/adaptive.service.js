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
const { getThumbProcessingStats } = require('../repositories/stats.repo');

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

/**
 * 自适应配置管理器
 * 集中管理性能阈值和自适应参数
 */
class AdaptiveConfigManager {
    constructor() {
        this.initializeConfig();
    }

    /**
     * 初始化配置参数
     */
    initializeConfig() {
        // 性能阈值配置
        this.boostThreshold = Number(process.env.ADAPTIVE_BOOST_THRESHOLD || 10000);
        this.decayThreshold = Number(process.env.ADAPTIVE_DECAY_THRESHOLD || 5000);
        this.cooldownMs = Number(process.env.ADAPTIVE_COOLDOWN_MS || 30000);

        // 内存预算配置
        this.memoryBudgetRatio = Number(process.env.ADAPTIVE_MEMORY_BUDGET_RATIO || 0.7);

        // 其他自适应参数
        this.scaleCheckIntervalMs = Number(process.env.ADAPTIVE_SCALE_CHECK_INTERVAL_MS || 30000);
        this.publishIntervalMs = Number(process.env.ADAPTIVE_PUBLISH_INTERVAL_MS || 10000);

        // 负载阈值
        this.highLoadThreshold = Number(process.env.ADAPTIVE_HIGH_LOAD_THRESHOLD || 0.8);
        this.mediumLoadThreshold = Number(process.env.ADAPTIVE_MEDIUM_LOAD_THRESHOLD || 0.6);
    }

    /**
     * 获取所有配置
     */
    getConfig() {
        return {
            boostThreshold: this.boostThreshold,
            decayThreshold: this.decayThreshold,
            cooldownMs: this.cooldownMs,
            memoryBudgetRatio: this.memoryBudgetRatio,
            scaleCheckIntervalMs: this.scaleCheckIntervalMs,
            publishIntervalMs: this.publishIntervalMs,
            highLoadThreshold: this.highLoadThreshold,
            mediumLoadThreshold: this.mediumLoadThreshold
        };
    }

    /**
     * 检查配置有效性
     */
    validateConfig() {
        if (this.boostThreshold <= this.decayThreshold) {
            logger.warn('[AdaptiveConfig] BOOST_THRESHOLD应该大于DECAY_THRESHOLD');
        }
        if (this.memoryBudgetRatio <= 0 || this.memoryBudgetRatio > 1) {
            logger.warn('[AdaptiveConfig] MEMORY_BUDGET_RATIO应该在0-1之间');
        }
    }
}

// 创建单例配置管理器
const adaptiveConfigManager = new AdaptiveConfigManager();
adaptiveConfigManager.validateConfig();

// 导出配置常量（向后兼容）
const config = adaptiveConfigManager.getConfig();
const BOOST_THRESHOLD = config.boostThreshold;
const DECAY_THRESHOLD = config.decayThreshold;
const COOLDOWN_MS = config.cooldownMs;
const MEMORY_BUDGET_RATIO = config.memoryBudgetRatio;

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
                thumbMaxConcurrency: Math.max(1, Math.floor(cpuBased / 3)), // 降低并发度：从/2改为/3
                disableHlsBackfill: false,
                ffmpegThreads: Math.max(1, Math.min(1, cpuBased)), // 降低ffmpeg线程：从2改为1
                ffmpegPreset: process.env.FFMPEG_PRESET || 'veryfast',
            };
        case 'high':
        default:
            return {
                thumbMaxConcurrency: Math.max(1, Math.min(cpuBased, 2)), // 降低最大并发：从4改为2
                disableHlsBackfill: false,
                ffmpegThreads: Math.max(1, Math.min(2, cpuBased)), // 降低ffmpeg线程：从4改为2
                ffmpegPreset: process.env.FFMPEG_PRESET || 'veryfast',
            };
    }
}

async function publishProfile(mode, profile) {
    try {
        const ttl = 60; // 秒
        const redisOps = [
            redis.set(MODE_KEY, mode, 'EX', ttl),
            redis.set(FF_THREADS_KEY, String(profile.ffmpegThreads || 1), 'EX', ttl),
            redis.set(FF_PRESET_KEY, String(profile.ffmpegPreset || 'veryfast'), 'EX', ttl),
            redis.set(DISABLE_HLS_BACKFILL_KEY, profile.disableHlsBackfill ? '1' : '0', 'EX', ttl),
            redis.set(THUMB_MAX_CONCURRENT_KEY, String(profile.thumbMaxConcurrency || 1), 'EX', ttl)
        ];

        // 并行执行所有Redis操作，如果某个失败则记录但不中断其他操作
        const results = await Promise.allSettled(redisOps);
        const failures = results.filter(r => r.status === 'rejected').length;

        if (failures > 0) {
            logger.warn(`[Adaptive] ${failures}/${redisOps.length} 个Redis配置同步失败`);
        }

        lastPublishTs = Date.now();
    } catch (e) {
        logger.warn('[Adaptive] 发布 profile 到 Redis 失败:' + e.message);
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
let lastScaleTs = 0;

// 读取缩略图 backlog（缺失/待处理/失败/处理中）
async function getThumbBacklogCount() {
    try {
        return await getThumbProcessingStats();
    } catch {
        return 0;
    }
}

function hasResourceBudget() {
    try {
        // 优先使用用户显式提供的容器配额，避免在容器内误读宿主机资源
        const envCpus = Number(process.env.DETECTED_CPU_COUNT || process.env.CPU_COUNT || 0);
        const cpus = Math.max(1, Math.floor(envCpus > 0 ? envCpus : (os.cpus().length || 1)));

        const la = (os.loadavg && os.loadavg()[0]) || 0;
        const loadOk = la <= cpus * 0.8;

        const rss = process.memoryUsage().rss;
        const envMemGb = Number(process.env.DETECTED_MEMORY_GB || process.env.MEMORY_GB || 0);
        const total = envMemGb > 0 ? Math.max(1, envMemGb) * 1024 * 1024 * 1024 : os.totalmem();

        const memOk = rss / total <= MEMORY_BUDGET_RATIO;
        return { loadOk, memOk, cpus };
    } catch {
        return { loadOk: true, memOk: true, cpus: 1 };
    }
}

function resourceSnapshot() {
    try {
        const envCpus = Number(process.env.DETECTED_CPU_COUNT || process.env.CPU_COUNT || 0);
        const cpus = Math.max(1, Math.floor(envCpus > 0 ? envCpus : (os.cpus().length || 1)));
        const cpuSource = envCpus > 0 ? 'env' : 'os';
        const envMemGb = Number(process.env.DETECTED_MEMORY_GB || process.env.MEMORY_GB || 0);
        const total = envMemGb > 0 ? Math.max(1, envMemGb) * 1024 * 1024 * 1024 : os.totalmem();
        const memSource = envMemGb > 0 ? 'env' : 'os';
        const budgetGb = total * MEMORY_BUDGET_RATIO / (1024 * 1024 * 1024);
        const totalGb = total / (1024 * 1024 * 1024);
        const rssGb = process.memoryUsage().rss / (1024 * 1024 * 1024);
        const la = (os.loadavg && os.loadavg()[0]) || 0;
        return { cpus, cpuSource, totalGb, memSource, budgetGb, rssGb, load: la };
    } catch {
        return { cpus: 1, cpuSource: 'unknown', totalGb: 1, memSource: 'unknown', budgetGb: Number(process.env.ADAPTIVE_MEMORY_BUDGET_RATIO || 0.7), rssGb: 0, load: 0 };
    }
}

/**
 * 检查是否满足扩容条件
 */
function shouldScaleUp(heavy, demandActive, backlog, loadOk, memOk) {
    return !heavy && demandActive && backlog > BOOST_THRESHOLD && loadOk && memOk;
}

/**
 * 检查是否满足缩容条件
 */
function shouldScaleDown(backlog) {
    if (backlog === 0) {
        return { scale: true, target: 0 }; // 完全空闲，缩至0
    } else if (backlog < DECAY_THRESHOLD) {
        return { scale: true, target: null }; // 半衰减缩容
    }
    return { scale: false, target: null };
}

/**
 * 计算目标线程池大小
 */
function calculateTargetSize(current, hardMax, scaleUp, scaleDown) {
    if (scaleUp) {
        // 指数扩容：翻倍，但不超过硬上限；至少升到2
        return Math.max(2, Math.min(hardMax, Math.max(current * 2, current + 1)));
    } else if (scaleDown.scale) {
        if (scaleDown.target === 0) {
            return 0; // 完全空闲
        } else {
            // 半衰减缩容：保留至少1个
            return Math.max(1, Math.ceil(current / 2));
        }
    }
    return current; // 不需要调整
}

/**
 * 执行线程池扩缩容
 */
async function performPoolScaling(current, target, backlog, demandActive, loadOk, memOk, cpus) {
    const { scaleThumbnailWorkerPool } = require('./worker.manager');

    const finalSize = scaleThumbnailWorkerPool(target);
    lastScaleTs = Date.now();

    logger.silly(`[Adaptive] Auto-Boost 调整缩略图池: ${current} -> ${finalSize} | backlog=${backlog} demand=${demandActive} loadOk=${loadOk} memOk=${memOk} cpus=${cpus}`);

    return finalSize;
}

/**
 * 获取当前系统状态
 */
async function getCurrentSystemState() {
    const backlog = await getThumbBacklogCount();
    const { loadOk, memOk, cpus } = hasResourceBudget();
    const { isHeavy } = require('./orchestrator');
    const heavy = await isHeavy();

    // 需求门槛：仅在存在真实需求时才允许扩容
    const demandActive = (global.__thumbOndemandQueueLen || 0) > 0
        || global.__thumbBatchActive === true
        || (global.__thumbActiveCount || 0) > 0;

    return { backlog, loadOk, memOk, cpus, heavy, demandActive };
}

async function maybeAutoScaleThumbPool() {
    try {
        const { thumbnailWorkers } = require('./worker.manager');
        const current = thumbnailWorkers.length;
        const now = Date.now();

        // 冷却窗口：30秒内不重复扩缩容
        if (now - lastScaleTs < COOLDOWN_MS) {
            return;
        }

        // 获取当前系统状态
        const { backlog, loadOk, memOk, cpus, heavy, demandActive } = await getCurrentSystemState();

        // 目标上限：不超过 CPU 核心与 4 之间的较小值
        const hardMax = Math.max(1, Math.min(cpus, 4));

        // 检查扩缩容条件
        const scaleUp = shouldScaleUp(heavy, demandActive, backlog, loadOk, memOk);
        const scaleDown = shouldScaleDown(backlog);

        if (!scaleUp && !scaleDown.scale) {
            return; // 不需要调整
        }

        // 计算目标大小
        const target = calculateTargetSize(current, hardMax, scaleUp, scaleDown);

        if (target !== current) {
            await performPoolScaling(current, target, backlog, demandActive, loadOk, memOk, cpus);
        }

    } catch (e) {
        logger.debug('[Adaptive] Auto-Boost 缩略图池调整失败（忽略）：' + (e && e.message));
    }
}

function startAdaptiveScheduler() {
    // 立即计算一次
    const mode = resolveMode();
    currentMode = mode;
    const profile = deriveProfile(mode);
    logger.silly(`[Adaptive] 启动: mode=${mode} thumbMax=${profile.thumbMaxConcurrency} ffmpegThreads=${profile.ffmpegThreads} disableBackfill=${profile.disableHlsBackfill}`);
    publishProfile(mode, profile);
    try {
        const snap = resourceSnapshot();
        logger.debug(`[Adaptive] 资源配额: cpu=${snap.cpus}(${snap.cpuSource}), mem=${snap.totalGb.toFixed(1)}GB(${snap.memSource}), 预算=${Math.round(MEMORY_BUDGET_RATIO*100)}%≈${snap.budgetGb.toFixed(1)}GB; 阈值: boost>${BOOST_THRESHOLD}, decay<${DECAY_THRESHOLD}, 冷却=${Math.round(COOLDOWN_MS/1000)}s, 池上限=min(CPU,4)`);
    } catch {}

    if (ticker) return;
    ticker = setInterval(async () => {
        try {
            const next = resolveMode();
            if (next !== currentMode || Date.now() - lastPublishTs > 30000) {
                currentMode = next;
                const prof = deriveProfile(next);
                logger.silly(`[Adaptive] 更新: mode=${next} thumbMax=${prof.thumbMaxConcurrency} ffmpegThreads=${prof.ffmpegThreads} disableBackfill=${prof.disableHlsBackfill}`);
                publishProfile(next, prof);
            }
        } catch (e) {
            logger.debug('[Adaptive] 调度器异常（忽略）：' + e.message);
        }

        // 自适应增压：每个周期尝试扩/缩容一次
        await maybeAutoScaleThumbPool();
    }, 15000);
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



