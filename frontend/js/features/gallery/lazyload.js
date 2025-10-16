/**
 * @file lazyload.js
 * @description 懒加载模块，负责图片和媒体资源的懒加载功能。
 */

import { state } from '../../core/state.js';
import { AbortBus } from '../../core/abort-bus.js';
import { triggerMasonryUpdate } from './masonry.js';
import { getAuthToken } from '../../app/auth.js';
import { createModuleLogger } from '../../core/logger.js';
import { safeSetInnerHTML, safeSetStyle, safeClassList } from '../../shared/dom-utils.js';

const lazyloadLogger = createModuleLogger('Lazyload');

/**
 * Blob URL 管理器
 * 管理图片元素与其 blob URL 的映射及资源释放
 */
const blobUrlManager = {
    /** @type {Map<HTMLImageElement, string>} 存储图片元素与其当前 blob URL 的映射 */
    activeBlobUrls: new Map(),
    /** @type {Map<HTMLImageElement, number>} 存储 blob URL 的创建时间，用于清理过期资源 */
    blobCreationTimes: new Map(),
    /** @type {number} 最大 blob URL 缓存时间（3 分钟） */
    maxBlobAge: 3 * 60 * 1000,

    /**
     * 安全地撤销图片的 blob URL
     * @param {HTMLImageElement} img
     */
    revokeBlobUrl: function(img) {
        const storedUrl = this.activeBlobUrls.get(img);
        if (!storedUrl) return;
        try {
            // 只有当映射仍一致时才尝试释放，避免重复 revoke
            const currentSrc = img && typeof img.src === 'string' ? img.src : undefined;
            if (!currentSrc || currentSrc === storedUrl) {
                URL.revokeObjectURL(storedUrl);
            }
        } catch (e) {
            // 忽略 revoke 错误，避免控制台噪音
        }
        this.activeBlobUrls.delete(img);
        this.blobCreationTimes.delete(img);
    },

    /**
     * 为图片设置新的 blob URL
     * @param {HTMLImageElement} img
     * @param {Blob} blob
     * @returns {string|null}
     */
    setBlobUrl: function(img, blob) {
        try {
            // 先清理旧的 blob URL
            this.revokeBlobUrl(img);

            let newBlobUrl;
            try {
                newBlobUrl = URL.createObjectURL(blob);
            } catch (error) {
                lazyloadLogger.warn('创建 blob URL 失败', error);
                return null;
            }

            // 验证 blob URL 是否有效
            if (!newBlobUrl || !newBlobUrl.startsWith('blob:')) {
                if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                    lazyloadLogger.warn('创建的 URL 非 blob 协议，已忽略');
                }
                try {
                    URL.revokeObjectURL(newBlobUrl);
                } catch {}
                return null;
            }

            this.activeBlobUrls.set(img, newBlobUrl);
            this.blobCreationTimes.set(img, Date.now());

            // 设置图片 src 前监听错误事件
            const errorHandler = (e) => {
                lazyloadLogger.warn('blob URL 加载失败，尝试清理', { newBlobUrl });
                this.revokeBlobUrl(img);
                img.removeEventListener('error', errorHandler);
            };

            img.addEventListener('error', errorHandler, { once: true });
            img.src = newBlobUrl;

            return newBlobUrl;
        } catch (error) {
            lazyloadLogger.warn('设置 blob URL 时出错', error);
            return null;
        }
    },

    /**
     * 清理指定图片的 blob URL
     * @param {HTMLImageElement} img
     */
    cleanup: function(img) {
        this.revokeBlobUrl(img);
    },

    /**
     * 清理所有 blob URL（页面卸载时使用）
     */
    cleanupAll: function() {
        for (const [img, blobUrl] of this.activeBlobUrls) {
            try {
                URL.revokeObjectURL(blobUrl);
            } catch (e) {
                // 忽略
            }
        }
        this.activeBlobUrls.clear();
        this.blobCreationTimes.clear();
    },

    /**
     * 清理过期的 blob URL（内存优化）
     */
    cleanupExpired: function() {
        const now = Date.now();
        const toCleanup = [];
        for (const [img, creationTime] of this.blobCreationTimes) {
            if (!img) continue;
            const isConnected = !!(img.isConnected && (typeof document === 'undefined' || document.contains(img)));
            if (isConnected) {
                // 图片仍在文档中，刷新时间戳以防止被提前清理
                this.blobCreationTimes.set(img, now);
                continue;
            }
            if (!isConnected || now - creationTime > this.maxBlobAge) {
                toCleanup.push(img);
            }
        }
        for (const img of toCleanup) {
            this.revokeBlobUrl(img);
        }
        if (toCleanup.length > 0 && Math.random() < 0.1) {
            lazyloadLogger.debug('清理了过期 blob URLs', { count: toCleanup.length });
        }
    }
};

let globalImageObserver = null;
let globalScrollHandler = null;

/** @type {number} 定期清理过期 blob URLs 的定时器（每 30 秒） */
const blobCleanupInterval = setInterval(() => {
    blobUrlManager.cleanupExpired();
}, 30000);

/**
 * 统一资源清理管理器
 * 管理所有懒加载相关的资源清理
 */
const resourceCleanupManager = {
    /** @type {Set<Object>} 存储所有需要清理的资源 */
    resources: new Set(),
    /** @type {Set<number>} 定时器引用 */
    timers: new Set(),

    /**
     * 注册需要清理的资源
     * @param {Object} resource 资源对象，包含 cleanup 方法
     */
    register(resource) {
        this.resources.add(resource);
    },

    /**
     * 注册定时器
     * @param {number} timerId setTimeout/setInterval 的返回值
     */
    registerTimer(timerId) {
        this.timers.add(timerId);
    },

    /**
     * 清理所有资源
     */
    cleanup() {
        for (const resource of this.resources) {
            try {
                if (resource && typeof resource.cleanup === 'function') {
                    resource.cleanup();
                }
            } catch (error) {
                lazyloadLogger.warn('清理资源时出错', error);
            }
        }
        for (const timerId of this.timers) {
            try {
                clearTimeout(timerId);
                clearInterval(timerId);
            } catch (error) {
                // 忽略清理错误
            }
        }
        this.timers.clear();
    },

    /**
     * 销毁管理器
     */
    destroy() {
        this.cleanup();
        this.resources.clear();
    }
};

/**
 * 滚动监听器资源对象，用于清理全局滚动事件
 */
const scrollListenerResource = {
    cleanup() {
        if (globalScrollHandler) {
            window.removeEventListener('scroll', globalScrollHandler);
            globalScrollHandler = null;
        }
    }
};

/**
 * 图片观察器资源对象，用于清理全局 IntersectionObserver
 */
const imageObserverResource = {
    cleanup() {
        if (globalImageObserver) {
            try {
                globalImageObserver.disconnect();
            } catch {}
            globalImageObserver = null;
        }
    }
};

// 注册现有的清理资源
resourceCleanupManager.register(blobUrlManager);
resourceCleanupManager.register(thumbnailRetryManager);
resourceCleanupManager.register(thumbnailRequestThrottler);
resourceCleanupManager.register(scrollListenerResource);
resourceCleanupManager.register(imageObserverResource);

// 注册定时器到资源清理管理器
resourceCleanupManager.registerTimer(blobCleanupInterval);

/** 导出资源清理相关对象 */
export { blobUrlManager, thumbnailRetryManager, resourceCleanupManager };

// 将 blob URL 管理器暴露到全局 window 对象，供 SSE 等其他模块使用
if (typeof window !== 'undefined') {
    window.blobUrlManager = blobUrlManager;
    // 页面卸载时清理所有资源
    window.addEventListener('beforeunload', () => {
        resourceCleanupManager.cleanup();
        // 清理虚拟滚动懒加载器
        if (window.virtualScrollLazyLoader) {
            window.virtualScrollLazyLoader.cleanup();
        }
    });
}

/**
 * 图片加载成功处理函数
 * @param {Event} event 图片加载事件
 */
function handleImageLoad(event) {
    const img = event.target;
    const status = img.dataset.thumbStatus;
    // 处理中的缩略图不标记为 loaded
    if (status === 'processing') {
        safeClassList(img, 'add', 'processing');
        // 添加 loading 指示器
        const container = img.parentElement;
        if (container && !container.querySelector('.processing-indicator')) {
            const indicator = document.createElement('div');
            indicator.className = 'processing-indicator';
            safeSetInnerHTML(indicator, `
                <div class="processing-spinner">
                    <div class="processing-dots">
                        <div class="processing-dot"></div>
                        <div class="processing-dot"></div>
                        <div class="processing-dot"></div>
                    </div>
                </div>
                <div class="processing-text">生成中...</div>
            `);
            container.appendChild(indicator);
            // 3 秒后自动移除指示器
            const indicatorTimeoutId = setTimeout(() => {
                if (indicator.parentNode) {
                    indicator.remove();
                }
            }, 3000);
            resourceCleanupManager.registerTimer(indicatorTimeoutId);
        }
        return;
    }
    if (status === 'failed') {
        safeClassList(img, 'add', 'error');
        return;
    }
    safeClassList(img, 'add', 'loaded');
    // 清理残留的处理中/错误态样式
    safeClassList(img, 'remove', 'processing');
    safeClassList(img, 'remove', 'error');
    img.dataset.thumbStatus = '';

    // 清理父元素的生成状态类
    const parent = img.closest('.photo-item, .album-card');
    if (parent) {
        safeClassList(parent, 'remove', 'thumbnail-generating');
    }

    // 隐藏占位符和加载覆盖层
    const container = img.parentElement;
    if (container) {
        const placeholder = container.querySelector('.image-placeholder');
        const loadingOverlay = container.querySelector('.loading-overlay');
        const processingIndicator = container.querySelector('.processing-indicator');
        if (placeholder) {
            safeSetStyle(placeholder, {
                opacity: '0',
                animation: 'none',
                pointerEvents: 'none'
            });
        }
        if (loadingOverlay) {
            safeSetStyle(loadingOverlay, {
                display: 'none',
                opacity: '0'
            });
        }
        if (processingIndicator) {
            processingIndicator.remove();
        }
    }
    triggerMasonryUpdate();
}

/**
 * 图片加载失败处理函数
 * @param {Event} event 图片错误事件
 */
function handleImageError(event) {
    const img = event.target;
    img.onerror = null; // 防止错误循环

    // 清理失败图片的 blob URL
    blobUrlManager.cleanup(img);

    // 使用内联 SVG 作为兜底占位
    const brokenSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
            <rect width="100" height="100" fill="#374151"/>
            <g fill="none" stroke="#C084FC" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 70 L38 50 L55 65 L70 55 L82 70"/>
                <circle cx="65" cy="35" r="7" fill="#C084FC" stroke="none"/>
            </g>
            <text x="50" y="90" text-anchor="middle" fill="#9CA3AF" font-size="10" font-family="Arial, sans-serif">BROKEN</text>
        </svg>`;
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(brokenSvg);
    safeClassList(img, 'add', 'error');
    safeClassList(img, 'remove', 'blurred');

    // 隐藏占位符和加载覆盖层
    const container = img.parentElement;
    if (container) {
        const placeholder = container.querySelector('.image-placeholder');
        const loadingOverlay = container.querySelector('.loading-overlay');
        if (placeholder) {
            safeSetStyle(placeholder, {
                opacity: '0',
                animation: 'none',
                pointerEvents: 'none'
            });
        }
        if (loadingOverlay) {
            safeSetStyle(loadingOverlay, {
                display: 'none',
                opacity: '0'
            });
        }
    }
}

/**
 * 智能请求节流器
 * 基于滚动速度动态调整并发和延迟
 */
const thumbnailRequestThrottler = {
    /** @type {Map<string, number>} 活跃请求映射 */
    activeRequests: new Map(),
    /** @type {number} 基础最大并发请求数 */
    baseMaxConcurrentRequests: 3,
    /** @type {number} 基础请求间最小延迟（毫秒） */
    baseRequestDelay: 50,

    // 智能调度相关状态
    /** @type {number} 当前滚动速度 */
    scrollVelocity: 0,
    lastScrollTime: 0,
    lastScrollTop: 0,
    /** @type {number[]} 速度采样 */
    velocitySamples: [],
    /** @type {number} 最大速度采样数 */
    maxVelocitySamples: 10,

    /**
     * 动态最大并发请求数
     * @returns {number}
     */
    get maxConcurrentRequests() {
        const velocity = Math.abs(this.scrollVelocity);
        if (velocity > 100) return this.baseMaxConcurrentRequests + 4;
        if (velocity > 50) return this.baseMaxConcurrentRequests + 2;
        return this.baseMaxConcurrentRequests;
    },

    /**
     * 动态请求延迟
     * @returns {number}
     */
    get requestDelay() {
        const velocity = Math.abs(this.scrollVelocity);
        if (velocity > 100) return Math.max(10, this.baseRequestDelay - 20);
        if (velocity > 50) return Math.max(25, this.baseRequestDelay - 10);
        return this.baseRequestDelay;
    },

    /**
     * 更新滚动速度
     * @param {number} scrollTop 当前滚动位置
     */
    updateScrollVelocity(scrollTop) {
        const now = Date.now();
        const timeDelta = now - this.lastScrollTime;
        if (timeDelta > 0 && timeDelta < 1000) {
            const distance = scrollTop - this.lastScrollTop;
            const velocity = distance / timeDelta * 1000;
            this.velocitySamples.push(velocity);
            if (this.velocitySamples.length > this.maxVelocitySamples) {
                this.velocitySamples.shift();
            }
            // 计算平均速度（过滤异常值）
            const validSamples = this.velocitySamples.filter(v => Math.abs(v) < 5000);
            this.scrollVelocity = validSamples.length > 0
                ? validSamples.reduce((a, b) => a + b, 0) / validSamples.length
                : 0;
        }
        this.lastScrollTime = now;
        this.lastScrollTop = scrollTop;
    },

    /**
     * 检查是否可以发送请求
     * @param {string} url 请求 URL
     * @returns {boolean}
     */
    canSendRequest(url) {
        if (this.activeRequests.size >= this.maxConcurrentRequests) return false;
        if (this.activeRequests.has(url)) return false;
        return true;
    },

    /**
     * 标记请求开始
     * @param {string} url 请求 URL
     */
    markRequestStart(url) {
        this.activeRequests.set(url, Date.now());
    },

    /**
     * 标记请求结束
     * @param {string} url 请求 URL
     */
    markRequestEnd(url) {
        this.activeRequests.delete(url);
    },

    /**
     * 清理超时的请求记录
     */
    cleanup() {
        const now = Date.now();
        const timeout = 30000;
        for (const [url, startTime] of this.activeRequests) {
            if (now - startTime > timeout) {
                this.activeRequests.delete(url);
            }
        }
    }
};

/** @type {number} 定期清理超时请求的定时器（每 15 秒） */
const requestCleanupInterval = setInterval(() => {
    thumbnailRequestThrottler.cleanup();
}, 15000);

resourceCleanupManager.registerTimer(requestCleanupInterval);

/**
 * 缩略图重试管理器
 * 为正在处理的缩略图添加定期重试机制
 */
const thumbnailRetryManager = {
    /** @type {Map<string, Object>} 正在重试的图片映射 */
    retryingImages: new Map(),
    /** @type {Map<string, number>} 活跃的超时器映射 */
    activeTimeouts: new Map(),

    /**
     * 为图片添加重试机制
     * @param {HTMLImageElement} img
     * @param {string} thumbnailUrl
     */
    addRetry(img, thumbnailUrl) {
        this.removeRetry(img);
        const retryKey = thumbnailUrl;
        const retryState = {
            img: img,
            url: thumbnailUrl,
            retryCount: 0,
            maxRetries: 8,
            nextRetryTime: Date.now() + 8000
        };
        this.retryingImages.set(retryKey, retryState);
        this.scheduleNextRetry(retryKey);
    },

    /**
     * 调度下一次重试
     * @param {string} retryKey
     */
    scheduleNextRetry(retryKey) {
        const retryState = this.retryingImages.get(retryKey);
        if (!retryState) return;
        const { img, url, retryCount, maxRetries, nextRetryTime } = retryState;
        const now = Date.now();
        const delay = Math.max(0, nextRetryTime - now);
        this.clearTimeout(retryKey);
        const timeoutId = setTimeout(async () => {
            if (!img.isConnected || safeClassList(img, 'contains', 'loaded') || img.dataset.thumbStatus !== 'processing') {
                this.removeRetry(img);
                return;
            }
            if (retryCount >= maxRetries) {
                lazyloadLogger.warn('缩略图重试次数过多，停止重试', { url });
                this.removeRetry(img);
                return;
            }
            try {
                const token = getAuthToken();
                const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
                const signal = AbortBus.get('thumb');
                const response = await fetch(url, { headers, signal });
                if (response.status === 200) {
                    const imageBlob = await response.blob();
                    img.dataset.thumbStatus = '';
                    blobUrlManager.setBlobUrl(img, imageBlob);
                    if (img.dataset.processingBySSE) {
                        delete img.dataset.processingBySSE;
                    }
                    this.removeRetry(img);
                } else if (response.status === 202) {
                    retryState.retryCount++;
                    retryState.nextRetryTime = Date.now() + (retryCount + 1) * 15000;
                    this.scheduleNextRetry(retryKey);
                } else if (response.status === 500 && (response.headers.get('X-Thumb-Status') === 'failed')) {
                    const imageBlob = await response.blob();
                    img.dataset.thumbStatus = 'failed';
                    blobUrlManager.setBlobUrl(img, imageBlob);
                    if (img.dataset.processingBySSE) {
                        delete img.dataset.processingBySSE;
                    }
                    this.removeRetry(img);
                } else {
                    this.removeRetry(img);
                }
            } catch (error) {
                if (error.name !== 'AbortError') {
                    lazyloadLogger.warn('缩略图重试失败', { url, error });
                    this.removeRetry(img);
                }
            }
        }, delay);
        this.activeTimeouts.set(retryKey, timeoutId);
    },

    /**
     * 清理指定键的超时器
     * @param {string} retryKey
     */
    clearTimeout(retryKey) {
        const timeoutId = this.activeTimeouts.get(retryKey);
        if (timeoutId) {
            clearTimeout(timeoutId);
            this.activeTimeouts.delete(retryKey);
        }
    },

    /**
     * 移除图片的重试机制
     * @param {HTMLImageElement} img
     */
    removeRetry(img) {
        const thumbnailUrl = img.dataset.src;
        if (!thumbnailUrl) return;
        const retryKey = thumbnailUrl;
        this.clearTimeout(retryKey);
        this.retryingImages.delete(retryKey);
    },

    /**
     * 清理所有重试机制（页面卸载时使用）
     */
    cleanup() {
        for (const retryKey of this.activeTimeouts.keys()) {
            this.clearTimeout(retryKey);
        }
        this.retryingImages.clear();
        this.activeTimeouts.clear();
    }
};

/** @type {Array<Object>} 懒加载请求队列 */
const lazyRequestQueue = [];
/** @type {Map<HTMLImageElement, Object>} 已排队图片映射 */
const queuedImages = new Map();
let queueProcessingScheduled = false;

/**
 * 计算图片优先级
 * @param {HTMLImageElement} img
 * @param {DOMRect} rect
 * @returns {number}
 */
function computeImagePriority(img, rect) {
    try {
        const targetRect = rect || (typeof img.getBoundingClientRect === 'function' ? img.getBoundingClientRect() : null);
        if (targetRect && Number.isFinite(targetRect.top)) {
            const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
            if (targetRect.top >= 0) {
                return targetRect.top;
            }
            const baseline = viewportHeight > 0 ? viewportHeight : 1000;
            return Math.abs(targetRect.top) + baseline;
        }
    } catch (error) {
        // 忽略优先级计算异常
    }
    return Number.MAX_SAFE_INTEGER;
}

/**
 * 调度懒加载队列处理
 */
function scheduleLazyQueueProcessing() {
    if (queueProcessingScheduled) return;
    queueProcessingScheduled = true;
    const scheduler = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);
    scheduler(() => {
        queueProcessingScheduled = false;
        processLazyRequestQueue();
    });
}

/**
 * 处理懒加载请求队列
 */
function processLazyRequestQueue() {
    if (lazyRequestQueue.length === 0) return;
    lazyRequestQueue.sort((a, b) => {
        if (a.priority !== b.priority) {
            return a.priority - b.priority;
        }
        return a.timestamp - b.timestamp;
    });
    let index = 0;
    while (index < lazyRequestQueue.length) {
        const entry = lazyRequestQueue[index];
        const { img } = entry;
        if (!img || !img.isConnected || safeClassList(img, 'contains', 'loaded') || img.dataset.thumbStatus === 'failed') {
            queuedImages.delete(img);
            lazyRequestQueue.splice(index, 1);
            continue;
        }
        const thumbnailUrl = img.dataset?.src;
        if (!thumbnailUrl) {
            queuedImages.delete(img);
            lazyRequestQueue.splice(index, 1);
            continue;
        }
        if (!thumbnailRequestThrottler.canSendRequest(thumbnailUrl)) {
            break;
        }
        queuedImages.delete(img);
        lazyRequestQueue.splice(index, 1);
        requestLazyImage(img, true);
    }
}

/**
 * 将图片加入懒加载队列
 * @param {HTMLImageElement} img
 * @param {Object} options
 * @param {DOMRect} options.rect
 * @param {number} options.priority
 */
export function enqueueLazyImage(img, options = {}) {
    if (!img) return;
    if (safeClassList(img, 'contains', 'loaded') || img.dataset.thumbStatus === 'failed') return;
    const { rect, priority } = options;
    const computedPriority = Number.isFinite(priority) ? priority : computeImagePriority(img, rect);
    const existing = queuedImages.get(img);
    if (existing) {
        existing.priority = Math.min(existing.priority, computedPriority);
        existing.timestamp = Date.now();
    } else {
        const entry = {
            img,
            priority: computedPriority,
            timestamp: Date.now()
        };
        queuedImages.set(img, entry);
        lazyRequestQueue.push(entry);
    }
    scheduleLazyQueueProcessing();
}

/**
 * 执行缩略图请求的内部函数
 * @param {HTMLImageElement} img
 * @param {string} thumbnailUrl
 */
async function executeThumbnailRequest(img, thumbnailUrl) {
    try {
        const token = getAuthToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const signal = AbortBus.get('thumb');
        const response = await fetch(thumbnailUrl, { headers, signal });
        if (response.status === 200) {
            const imageBlob = await response.blob();
            img.dataset.thumbStatus = '';
            blobUrlManager.setBlobUrl(img, imageBlob);
            thumbnailRetryManager.removeRetry(img);
        } else if (response.status === 202) {
            const imageBlob = await response.blob();
            img.dataset.thumbStatus = 'processing';
            blobUrlManager.setBlobUrl(img, imageBlob);
            thumbnailRetryManager.addRetry(img, thumbnailUrl);
        } else if (response.status === 429) {
            lazyloadLogger.debug('缩略图请求被频率限制，延迟重试', { thumbnailUrl });
            thumbnailRequestThrottler.markRequestEnd(thumbnailUrl);
            const retryTimeoutId = setTimeout(() => {
                const rect = typeof img.getBoundingClientRect === 'function' ? img.getBoundingClientRect() : null;
                enqueueLazyImage(img, { rect });
            }, 2000);
            resourceCleanupManager.registerTimer(retryTimeoutId);
            return;
        } else if (response.status === 500 && (response.headers.get('X-Thumb-Status') === 'failed')) {
            const imageBlob = await response.blob();
            img.dataset.thumbStatus = 'failed';
            blobUrlManager.setBlobUrl(img, imageBlob);
            thumbnailRetryManager.removeRetry(img);
        } else {
            throw new Error(`Server responded with status: ${response.status}`);
        }
    } catch (error) {
        if (error.name !== 'AbortError') {
            lazyloadLogger.error('获取懒加载图片失败', { thumbnailUrl, error });
            img.dispatchEvent(new Event('error'));
        }
    }
}

/**
 * 为懒加载图片发起加载请求
 * 支持自动重试和请求节流
 * @param {HTMLImageElement} img
 * @param {boolean} fromQueue 是否来自队列
 */
export function requestLazyImage(img, fromQueue = false) {
    const thumbnailUrl = img.dataset.src;
    if (!thumbnailUrl || thumbnailUrl.includes('undefined') || thumbnailUrl.includes('null')) {
        lazyloadLogger.error('懒加载失败: 无效的图片URL', { thumbnailUrl });
        img.dispatchEvent(new Event('error'));
        return;
    }
    // 已加载或已有真实 src 不重复请求
    if (safeClassList(img, 'contains', 'loaded')) return;
    if (img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:')) return;
    // 处理快速加载标记
    if (img.dataset.wasLoaded === 'true') {
        delete img.dataset.wasLoaded;
        delete img.dataset.loadTime;
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            lazyloadLogger.debug('快速加载之前加载过的图片', { thumbnailUrl });
        }
    }
    // 检查是否可以发送请求
    if (!thumbnailRequestThrottler.canSendRequest(thumbnailUrl)) {
        const rect = typeof img.getBoundingClientRect === 'function' ? img.getBoundingClientRect() : null;
        enqueueLazyImage(img, { rect });
        return;
    }
    thumbnailRequestThrottler.markRequestStart(thumbnailUrl);
    executeThumbnailRequest(img, thumbnailUrl)
        .finally(() => {
            thumbnailRequestThrottler.markRequestEnd(thumbnailUrl);
            scheduleLazyQueueProcessing();
        })
        .catch(() => {
            // 429 错误已在内部处理
        });
}

/**
 * 保存当前页面的懒加载状态
 * @param {string} pageKey 页面标识符
 */
export function savePageLazyState(pageKey) {
    if (!pageKey) return;
    const lazyImages = document.querySelectorAll('.lazy-image');
    const pageState = {
        timestamp: Date.now(),
        sessionId: Date.now().toString(),
        images: Array.from(lazyImages).map(img => ({
            src: img.dataset.src,
            loaded: safeClassList(img, 'contains', 'loaded'),
            status: img.dataset.thumbStatus,
            loadTime: safeClassList(img, 'contains', 'loaded') ? Date.now() : null
        }))
    };
    pageStateCache.set(pageKey, pageState);
    // 限制缓存大小
    if (pageStateCache.size > 10) {
        const oldestKey = pageStateCache.keys().next().value;
        pageStateCache.delete(oldestKey);
    }
    lazyloadLogger.debug('懒加载缓存: 保存图片状态', {
        count: pageState.images.filter(img => img.loaded).length
    });
}

/**
 * 恢复页面的懒加载状态
 * @param {string} pageKey 页面标识符
 * @returns {boolean}
 */
export function restorePageLazyState(pageKey) {
    if (!pageKey) return false;
    // 重复恢复防护
    if (restoreProtection.has(pageKey)) {
        lazyloadLogger.debug('懒加载缓存: 跳过重复恢复', { pageKey });
        return false;
    }
    const cachedState = pageStateCache.get(pageKey);
    if (!cachedState) return false;
    // 检查缓存是否过期（3 分钟）
    if (Date.now() - cachedState.timestamp > 3 * 60 * 1000) {
        pageStateCache.delete(pageKey);
        lazyloadLogger.debug('懒加载缓存: 缓存已过期', { pageKey });
        return false;
    }
    // 检查是否是同一会话
    const currentSessionId = sessionStorage.getItem('pageSessionId') || Date.now().toString();
    if (cachedState.sessionId !== currentSessionId) {
        lazyloadLogger.debug('懒加载缓存: 会话不匹配，跳过恢复', { pageKey });
        pageStateCache.delete(pageKey);
        return false;
    }
    const lazyImages = document.querySelectorAll('.lazy-image');
    let restoredCount = 0;
    const imagesToMark = [];
    lazyImages.forEach(img => {
        const cachedImage = cachedState.images.find(ci => ci.src === img.dataset.src);
        if (cachedImage && cachedImage.loaded) {
            imagesToMark.push({
                img,
                cachedImage
            });
            restoredCount++;
        }
    });
    if (restoredCount > 0) {
        restoreProtection.add(pageKey);
        requestAnimationFrame(() => {
            imagesToMark.forEach(({ img, cachedImage }) => {
                safeClassList(img, 'add', 'loaded');
                img.dataset.thumbStatus = '';
                img.dataset.wasLoaded = 'true';
                img.dataset.loadTime = cachedImage.loadTime;
            });
            lazyloadLogger.debug('懒加载缓存: 恢复图片状态', {
                restoredCount,
                note: '无blob URL'
            });
            const layoutTimeoutId = setTimeout(() => {
                triggerMasonryUpdate();
            }, 50);
            resourceCleanupManager.registerTimer(layoutTimeoutId);
        });
        return true;
    }
    return false;
}

/**
 * 清理恢复防护（在路由切换时调用，为新页面恢复做准备）
 */
export function clearRestoreProtection() {
    restoreProtection.clear();
}

/**
 * 获取或创建图片 IntersectionObserver
 * @returns {IntersectionObserver}
 */
function getOrCreateImageObserver() {
    if (globalImageObserver) return globalImageObserver;
    const observer = new IntersectionObserver((entries) => {
        const visibleImages = entries.filter(entry => entry.isIntersecting);
        visibleImages.forEach(entry => {
            const img = entry.target;
            if (img._processingLazyLoad) return;
            img._processingLazyLoad = true;
            img.onload = handleImageLoad;
            img.onerror = handleImageError;
            enqueueLazyImage(img, { rect: entry.boundingClientRect });
            if (!img._noContextMenuBound) {
                img.addEventListener('contextmenu', e => e.preventDefault());
                img._noContextMenuBound = true;
            }
            if (state.isBlurredMode) safeClassList(img, 'add', 'blurred');
            if (safeClassList(img, 'contains', 'loaded') || img.dataset.thumbStatus === 'failed') {
                observer.unobserve(img);
                img._processingLazyLoad = false;
            } else {
                const cleanupTimeoutId = setTimeout(() => {
                    img._processingLazyLoad = false;
                }, 100);
                resourceCleanupManager.registerTimer(cleanupTimeoutId);
            }
        });
    }, {
        rootMargin: '500px 100px',
        threshold: 0.1
    });
    globalImageObserver = observer;
    return observer;
}

/**
 * 确保滚动速度监听器已注册
 */
function ensureScrollVelocityListener() {
    if (globalScrollHandler) return;
    globalScrollHandler = () => {
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        thumbnailRequestThrottler.updateScrollVelocity(scrollTop);
    };
    window.addEventListener('scroll', globalScrollHandler, { passive: true });
}

/**
 * 初始化懒加载功能
 * @returns {IntersectionObserver}
 */
export function setupLazyLoading() {
    const observer = getOrCreateImageObserver();
    ensureScrollVelocityListener();
    document.querySelectorAll('.lazy-image').forEach(img => {
        if (!img._observed) {
            observer.observe(img);
            img._observed = true;
        }
    });
    return observer;
}

/** @type {Map<string, Object>} 页面状态缓存，避免路由切换时重新请求 */
const pageStateCache = new Map();
/** @type {Set<string>} 恢复状态防护，防止重复恢复 */
const restoreProtection = new Set();

/**
 * 重新观察处理中的图片
 * 当 SSE 事件或重试机制更新图片状态时调用
 * @param {HTMLImageElement} img
 */
export function reobserveImage(img) {
    if (img.dataset.thumbStatus !== 'processing') return;
    if (!globalImageObserver) {
        globalImageObserver = setupLazyLoading();
    }
    if (img._observed && !safeClassList(img, 'contains', 'loaded') && img.dataset.thumbStatus !== 'failed') {
        globalImageObserver.observe(img);
    }
}

