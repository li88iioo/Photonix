/**
 * @file preheat.js
 * @description 受控的缩略图预热器：在不依赖滚动的情况下，为当前视图中的相册/图片触发按需缩略图请求。
 */

import { requestLazyImage } from './lazyload.js';
import { createModuleLogger } from '../../core/logger.js';

const preheatLogger = createModuleLogger('ThumbPreheat');

/**
 * 预热模式配置：
 * - album：用于首页/目录页，相册封面相对较少，重视低并发以减轻压力。
 * - media：用于相册页或搜索结果，优先保证尽快触发图片缩略图生成。
 */
const PREHEAT_MODES = {
    album: {
        selector: '.album-card img.lazy-image',
        concurrency: 2,
        cooldownMs: 140,
        maxTargets: 90
    },
    media: {
        selector: '.photo-item img.lazy-image',
        concurrency: 4,
        cooldownMs: 110,
        maxTargets: 200
    }
};

const preheatState = {
    album: { queue: [], active: 0, timer: null },
    media: { queue: [], active: 0, timer: null }
};

/**
 * 判断图片是否需要加入预热队列
 * @param {HTMLImageElement} img
 * @returns {boolean}
 */
function shouldQueueImage(img) {
    if (!img || !(img instanceof HTMLImageElement)) return false;
    if (!img.isConnected) return false;
    if (img.dataset.preheatQueued === 'true') return false;
    if (!img.dataset.src || img.dataset.src.includes('undefined') || img.dataset.src.includes('null')) return false;
    if (img.classList.contains('loaded')) return false;
    if (img.dataset.thumbStatus === 'failed') return false;
    return true;
}

/**
 * 排空队列，按照并发限制逐个触发请求
 * @param {'album'|'media'} mode
 */
function drainPreheatQueue(mode) {
    const config = PREHEAT_MODES[mode];
    const bucket = preheatState[mode];
    bucket.timer = null;

    while (bucket.active < config.concurrency && bucket.queue.length > 0) {
        const img = bucket.queue.shift();
        if (!img) {
            continue;
        }
        bucket.active += 1;

        try {
            requestLazyImage(img);
        } catch (error) {
            preheatLogger.warn('预热请求触发失败', { mode, error });
        }

        setTimeout(() => {
            bucket.active = Math.max(0, bucket.active - 1);
            if (img.isConnected) {
                delete img.dataset.preheatQueued;
            }
            drainPreheatQueue(mode);
        }, config.cooldownMs);
    }
}

/**
 * 为当前视图安排缩略图预热
 * @param {Object} options
 * @param {'album'|'media'} options.mode - 预热模式
 * @param {HTMLElement|Document} [options.container=document] - 查找目标图片的容器
 * @param {number} [options.limit] - 自定义最多预热的数量
 * @param {number} [options.delay=150] - 在触发预热前的延迟，毫秒
 * @param {string} [options.reason] - 调试日志原因
 */
export function scheduleThumbnailPreheat(options = {}) {
    if (typeof document === 'undefined') return;

    const {
        mode = 'media',
        container = document,
        limit,
        delay = 150,
        reason = ''
    } = options;

    const resolvedMode = PREHEAT_MODES[mode] ? mode : 'media';
    const config = PREHEAT_MODES[resolvedMode];
    const scope = container || document;

    if (!scope || typeof scope.querySelectorAll !== 'function') {
        return;
    }

    const maxTargets = Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : config.maxTargets;
    const candidates = Array.from(scope.querySelectorAll(config.selector)).filter(shouldQueueImage);

    if (candidates.length === 0) {
        return;
    }

    const selected = candidates.slice(0, maxTargets);
    const bucket = preheatState[resolvedMode];

    selected.forEach((img) => {
        img.dataset.preheatQueued = 'true';
        bucket.queue.push(img);
    });

    if (reason && preheatLogger) {
        preheatLogger.debug(`预热队列新增 ${selected.length} 项`, { mode: resolvedMode, reason });
    }

    if (bucket.timer) {
        clearTimeout(bucket.timer);
    }
    bucket.timer = setTimeout(() => {
        drainPreheatQueue(resolvedMode);
    }, Math.max(0, delay));
}
