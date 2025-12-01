/**
 * @file lazyload.js
 * @description 懒加载模块，负责图片和媒体资源的懒加载功能。
 */

import { state } from '../../core/state.js';
import { AbortBus } from '../../core/abort-bus.js';
import { triggerMasonryUpdate } from './masonry.js';
import { getAuthToken } from '../../app/auth.js';
import { createModuleLogger } from '../../core/logger.js';
import { safeSetInnerHTML} from '../../shared/dom-utils.js';

const lazyloadLogger = createModuleLogger('Lazyload');

/**
 * 高级请求队列管理器
 * 特性：
 * 1. 动态并发数调整（根据网络速度自适应）
 * 2. 优先级队列（视口中心的图片优先加载）
 * 3. 请求去重（避免重复请求）
 * 4. 滚动方向预测（提前加载滚动方向的图片）
 */
const requestQueueManager = {
    // ========== 1. 动态并发控制 ==========
    /** @type {number} 当前最大并发数 */
    maxConcurrent: 10,
    /** @type {number} 最小并发数 */
    minConcurrent: 4,
    /** @type {number} 最大并发数上限 */
    maxLimit: 20,
    /** @type {number} 当前活跃的请求数 */
    activeRequests: 0,

    // 网络性能监控
    /** @type {Array<number>} 最近的请求耗时（毫秒） */
    recentRequestTimes: [],
    /** @type {number} 平均响应时间 */
    avgResponseTime: 0,

    // ========== 2. 优先级队列 ==========
    /** @type {Array<{img: HTMLImageElement, url: string, executor: Function, priority: number, timestamp: number}>} */
    priorityQueue: [],

    // ========== 3. 请求去重 ==========
    /** @type {Map<string, Promise>} URL -> Promise 映射，避免重复请求 */
    pendingRequests: new Map(),
    /** @type {Set<string>} 已成功加载的 URL */
    loadedUrls: new Set(),

    // ========== 4. 滚动方向预测 ==========
    /** @type {number} 上次滚动位置 */
    lastScrollY: 0,
    /** @type {'up'|'down'} 滚动方向 */
    scrollDirection: 'down',
    /** @type {number} 滚动速度 */
    scrollVelocity: 0,
    /** @type {number} 滚动监听器 ID */
    scrollListenerId: null,

    /**
     * 初始化滚动监听
     */
    initScrollTracking() {
        if (this.scrollListenerId) return;

        let scrollTimer = null;
        const updateScroll = () => {
            const currentY = window.scrollY || window.pageYOffset || 0;
            const delta = currentY - this.lastScrollY;

            if (Math.abs(delta) > 5) {
                this.scrollDirection = delta > 0 ? 'down' : 'up';
                this.scrollVelocity = Math.abs(delta);

                // 滚动时重新排序队列
                if (this.priorityQueue.length > 0) {
                    this.recalculateQueuePriorities();
                }
            }

            this.lastScrollY = currentY;
        };

        const throttledScroll = () => {
            if (scrollTimer) return;
            scrollTimer = setTimeout(() => {
                updateScroll();
                scrollTimer = null;
            }, 100);
        };

        window.addEventListener('scroll', throttledScroll, { passive: true });
        this.scrollListenerId = true;
    },

    /**
     * 计算图片的优先级
     * @param {HTMLImageElement} img
     * @returns {number} 优先级分数（越高越优先）
     */
    calculatePriority(img) {
        try {
            if (!img || !img.getBoundingClientRect) return 0;

            const rect = img.getBoundingClientRect();
            const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
            const viewportCenter = viewportHeight / 2;

            // 1. 距离视口中心的距离（越近优先级越高）
            const imgCenter = rect.top + rect.height / 2;
            const distanceFromCenter = Math.abs(imgCenter - viewportCenter);
            const distanceScore = Math.max(0, 1000 - distanceFromCenter);

            // 2. 滚动方向加成
            let scrollBonus = 0;
            if (this.scrollDirection === 'down' && rect.top > -200 && rect.top < viewportHeight + 400) {
                // 向下滚动时，下方即将进入视口的图片优先
                scrollBonus = 200;
            } else if (this.scrollDirection === 'up' && rect.bottom > -400 && rect.bottom < viewportHeight + 200) {
                // 向上滚动时，上方即将进入视口的图片优先
                scrollBonus = 200;
            }

            // 3. 是否在视口内（视口内的图片最高优先级）
            const inViewport = rect.top < viewportHeight && rect.bottom > 0;
            const viewportBonus = inViewport ? 500 : 0;

            // 4. 滚动速度加成（快速滚动时增加预加载范围）
            const velocityBonus = this.scrollVelocity > 100 ? 100 : 0;

            return distanceScore + scrollBonus + viewportBonus + velocityBonus;
        } catch (error) {
            lazyloadLogger.warn('计算优先级失败，使用默认优先级', { error: error.message });
            return 500; // 降级到中等优先级
        }
    },

    /**
     * 重新计算队列中所有图片的优先级并排序
     */
    recalculateQueuePriorities() {
        try {
            for (const item of this.priorityQueue) {
                if (item.img && item.img.isConnected) {
                    item.priority = this.calculatePriority(item.img);
                }
            }
            this.sortQueue();
        } catch (error) {
            lazyloadLogger.error('重新计算优先级失败，保持原有顺序', { error: error.message });
            // 失败时不排序，保持原有队列顺序继续工作
        }
    },

    /**
     * 队列排序（优先级高的在前）
     */
    sortQueue() {
        this.priorityQueue.sort((a, b) => {
            // 优先级高的排前面
            if (a.priority !== b.priority) {
                return b.priority - a.priority;
            }
            // 优先级相同，早加入队列的排前面
            return a.timestamp - b.timestamp;
        });
    },

    /**
     * 动态调整并发数（根据网络性能）
     */
    adjustConcurrency() {
        if (this.recentRequestTimes.length < 5) return;

        const avgTime = this.avgResponseTime;

        if (avgTime < 200) {
            // 快速网络（< 200ms），增加并发
            const newMax = Math.min(this.maxLimit, this.maxConcurrent + 2);
            if (newMax !== this.maxConcurrent) {
                this.maxConcurrent = newMax;
                lazyloadLogger.debug(`网络快速，增加并发数至 ${this.maxConcurrent}`);
            }
        } else if (avgTime > 1000) {
            // 慢速网络（> 1s），减少并发
            const newMax = Math.max(this.minConcurrent, this.maxConcurrent - 1);
            if (newMax !== this.maxConcurrent) {
                this.maxConcurrent = newMax;
                lazyloadLogger.debug(`网络慢速，降低并发数至 ${this.maxConcurrent}`);
            }
        }
        // 200ms - 1000ms：保持当前并发数
    },

    /**
     * 将请求加入队列（带优先级和去重）
     * @param {HTMLImageElement} img
     * @param {string} url
     * @param {Function} executor
     */
    enqueue(img, url, executor) {
        // 去重 1：检查图片实际加载状态（而非仅依赖 URL 记录）
        // 修复：页面切换后 Blob URL 失效导致的空白问题
        if (this.loadedUrls.has(url)) {
            // 进一步检查图片是否真的已加载
            const isActuallyLoaded = img?.classList.contains('loaded') &&
                                     img.src &&
                                     !img.src.startsWith('data:') &&
                                     img.src.startsWith('blob:');
            if (isActuallyLoaded) {
                return; // 确认已加载，跳过
            } else {
                // URL 记录存在但图片未实际加载，清除记录并继续
                this.loadedUrls.delete(url);
            }
        }

        // 去重 2：检查是否正在请求中
        if (this.pendingRequests.has(url)) {
            return this.pendingRequests.get(url);
        }

        // 去重 3：检查是否已在队列中
        const existingIndex = this.priorityQueue.findIndex(item => item.url === url);
        if (existingIndex !== -1) {
            // 已在队列，更新优先级
            const newPriority = this.calculatePriority(img);
            this.priorityQueue[existingIndex].priority = newPriority;
            this.sortQueue();
            return;
        }

        // 初始化滚动跟踪
        this.initScrollTracking();

        // 计算优先级并加入队列
        const priority = this.calculatePriority(img);
        this.priorityQueue.push({
            img,
            url,
            executor,
            priority,
            timestamp: Date.now()
        });

        this.sortQueue();
        this.processQueue();
    },

    /**
     * 执行单个请求（带性能监控）
     * @param {HTMLImageElement} img
     * @param {string} url
     * @param {Function} executor
     */
    async executeRequest(img, url, executor) {
        const startTime = Date.now();
        this.activeRequests++;

        // 创建 Promise 用于去重
        const requestPromise = (async () => {
            try {
                await executor(img, url);

                // 记录请求耗时
                const duration = Date.now() - startTime;
                this.recentRequestTimes.push(duration);

                // 只保留最近 20 次请求的数据
                if (this.recentRequestTimes.length > 20) {
                    this.recentRequestTimes.shift();
                }

                // 计算平均响应时间
                this.avgResponseTime = this.recentRequestTimes.reduce((sum, time) => sum + time, 0) / this.recentRequestTimes.length;

                // 标记为已加载
                this.loadedUrls.add(url);

                // 内存保护：限制 loadedUrls 大小，防止无限增长
                if (this.loadedUrls.size > 1000) {
                    // 转换为数组并清理最旧的 500 条记录（FIFO 策略）
                    const urlsArray = Array.from(this.loadedUrls);
                    const toRemove = urlsArray.slice(0, 500);
                    toRemove.forEach(oldUrl => this.loadedUrls.delete(oldUrl));
                    lazyloadLogger.debug(`内存保护：清理了 ${toRemove.length} 条旧的加载记录`, {
                        before: urlsArray.length,
                        after: this.loadedUrls.size
                    });
                }

                // 动态调整并发数
                this.adjustConcurrency();
            } catch (error) {
                // 请求失败，不标记为已加载，允许重试
                lazyloadLogger.debug('请求执行失败', { url, error: error.message });
            } finally {
                this.activeRequests--;
                this.pendingRequests.delete(url);
                this.processQueue();
            }
        })();

        this.pendingRequests.set(url, requestPromise);
        return requestPromise;
    },

    /**
     * 处理等待队列
     */
    processQueue() {
        while (this.activeRequests < this.maxConcurrent && this.priorityQueue.length > 0) {
            const item = this.priorityQueue.shift();

            // 检查图片是否仍在 DOM 中
            if (!item || !item.img || !item.img.isConnected) {
                continue;
            }

            // 检查是否已加载
            if (this.loadedUrls.has(item.url)) {
                continue;
            }

            // 检查是否正在请求中
            if (this.pendingRequests.has(item.url)) {
                continue;
            }

            this.executeRequest(item.img, item.url, item.executor);
        }
    },

    /**
     * 清空队列
     * @param {boolean} clearCache - 是否清空已加载记录（页面切换时应该为 true）
     */
    clear(clearCache = false) {
        this.priorityQueue = [];
        this.activeRequests = 0;
        this.pendingRequests.clear();

        if (clearCache) {
            // 页面切换时清空加载记录，避免 Blob URL 失效后的空白问题
            this.loadedUrls.clear();
            lazyloadLogger.debug('已清空懒加载缓存');
        }
    },

    /**
     * 获取当前状态（用于调试）
     */
    getStatus() {
        return {
            maxConcurrent: this.maxConcurrent,
            activeRequests: this.activeRequests,
            queueLength: this.priorityQueue.length,
            avgResponseTime: Math.round(this.avgResponseTime),
            scrollDirection: this.scrollDirection,
            scrollVelocity: Math.round(this.scrollVelocity),
            loadedCount: this.loadedUrls.size
        };
    }
};

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
    revokeBlobUrl: function (img) {
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
    setBlobUrl: function (img, blob) {
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
                } catch { }
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
    cleanup: function (img) {
        this.revokeBlobUrl(img);
    },

    /**
     * 清理所有 blob URL（页面卸载时使用）
     */
    cleanupAll: function () {
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
    cleanupExpired: function () {
        const now = Date.now();
        const toCleanup = [];
        for (const img of this.blobCreationTimes.keys()) {
            if (!img) continue;
            const isConnected = !!(img.isConnected && (typeof document === 'undefined' || document.contains(img)));
            if (isConnected) {
                // 图片仍在文档中，刷新时间戳以防止被提前清理
                this.blobCreationTimes.set(img, now);
                continue;
            }
            // 图片已从 DOM 中移除，直接清理
            toCleanup.push(img);
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

/** @type {number} 定期清理过期 blob URLs 的定时器（每 30 秒） */
const blobCleanupInterval = setInterval(() => {
    blobUrlManager.cleanupExpired();
}, 30000);

/**
 * 统一资源清理管理器
 * 管理所有懒加载相关的资源清理
 */
const managedTimers = new Set();

function trackManagedTimer(timerId) {
    if (timerId == null) return timerId;
    managedTimers.add(timerId);
    return timerId;
}

function clearManagedTimers() {
    for (const timerId of managedTimers) {
        clearTimeout(timerId);
        clearInterval(timerId);
    }
    managedTimers.clear();
}

/**
 * 图片观察器资源对象，用于清理全局 IntersectionObserver
 */
const imageObserverResource = {
    cleanup() {
        if (globalImageObserver) {
            try {
                globalImageObserver.disconnect();
            } catch { }
            globalImageObserver = null;
        }
    }
};

function cleanupLazyloadResources() {
    clearManagedTimers();
    blobUrlManager.cleanupAll();
    imageObserverResource.cleanup();
}

// 注册定时器到资源清理管理器
trackManagedTimer(blobCleanupInterval);

/** 导出资源清理相关对象 */
export { blobUrlManager };

// 将 blob URL 管理器暴露到全局 window 对象，供 SSE 等其他模块使用
if (typeof window !== 'undefined') {
    window.blobUrlManager = blobUrlManager;
    // 页面卸载时清理所有资源
    window.addEventListener('beforeunload', () => {
        cleanupLazyloadResources();
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
        img?.classList.add('processing');
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
            trackManagedTimer(indicatorTimeoutId);
        }
        return;
    }
    if (status === 'failed') {
        img?.classList.add('error');
        return;
    }
    img?.classList.add('loaded');
    // 清理残留的处理中/错误态样式
    img?.classList.remove('processing');
    img?.classList.remove('error');
    img.dataset.thumbStatus = '';
    // 重置重试计数器
    delete img.dataset.retryAttempt;

    // 清理父元素的生成状态类
    const parent = img.closest('.photo-item, .album-card');
    if (parent) {
        parent?.classList.remove('thumbnail-generating');
    }

    const gridItem = img.closest('.grid-item');

    // ✅ 优化：检查图片实际尺寸是否与预期一致
    // 只有尺寸不匹配时才触发布局重排，避免不必要的reflow
    let needsReflow = false;
    if (gridItem) {
        const expectedWidth = parseFloat(gridItem.getAttribute('data-width'));
        const expectedHeight = parseFloat(gridItem.getAttribute('data-height'));
        const actualWidth = img.naturalWidth;
        const actualHeight = img.naturalHeight;

        // 允许2%的误差范围（考虑压缩等因素）
        const tolerance = 0.02;
        if (expectedWidth > 0 && expectedHeight > 0 && actualWidth > 0 && actualHeight > 0) {
            const expectedRatio = expectedHeight / expectedWidth;
            const actualRatio = actualHeight / actualWidth;
            const ratioDiff = Math.abs(expectedRatio - actualRatio) / expectedRatio;

            // 尺寸比例差异超过阈值，需要重排
            if (ratioDiff > tolerance) {
                needsReflow = true;
                lazyloadLogger.debug('图片实际尺寸与预期不符，触发重排', {
                    expected: `${expectedWidth}x${expectedHeight}`,
                    actual: `${actualWidth}x${actualHeight}`,
                    ratioDiff: (ratioDiff * 100).toFixed(2) + '%'
                });
            }
        } else if (!expectedWidth || !expectedHeight) {
            // 缺失尺寸数据，安全起见触发重排
            needsReflow = true;
        }

        if (gridItem.style) {
            gridItem.style.removeProperty('height');
        }
    }

    // 隐藏占位符和加载覆盖层
    const container = img.parentElement;
    if (container) {
        const placeholder = container.querySelector('.image-placeholder');
        const loadingOverlay = container.querySelector('.loading-overlay');
        const processingIndicator = container.querySelector('.processing-indicator');
        if (placeholder) {
            Object.assign(placeholder.style, {
                opacity: '0',
                animation: 'none',
                pointerEvents: 'none'
            });
        }
        if (loadingOverlay) {
            Object.assign(loadingOverlay.style, {
                display: 'none',
                opacity: '0'
            });
        }
        if (processingIndicator) {
            processingIndicator.remove();
        }
    }

    // ✅ 仅在必要时触发布局重排
    if (needsReflow) {
        triggerMasonryUpdate();
        if (gridItem) {
            requestAnimationFrame(() => {
                triggerMasonryUpdate();
            });
        }
    }
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
            <rect width="100" height="100" fill="#F3F4F6"/>
            <rect x="0.5" y="0.5" width="99" height="99" fill="none" stroke="#E5E7EB" stroke-width="1"/>
            <g fill="none" stroke="#9CA3AF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 70 L38 50 L55 65 L70 55 L82 70"/>
                <circle cx="65" cy="35" r="7" fill="#9CA3AF" stroke="none"/>
            </g>
            <text x="50" y="90" text-anchor="middle" fill="#9CA3AF" font-size="10" font-family="Arial, sans-serif">BROKEN</text>
        </svg>`;
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(brokenSvg);
    img?.classList.add('error');
    img?.classList.remove('blurred');

    // 隐藏占位符和加载覆盖层
    const container = img.parentElement;
    if (container) {
        const placeholder = container.querySelector('.image-placeholder');
        const loadingOverlay = container.querySelector('.loading-overlay');
        if (placeholder) {
            Object.assign(placeholder.style, {
                opacity: '0',
                animation: 'none',
                pointerEvents: 'none'
            });
        }
        if (loadingOverlay) {
            Object.assign(loadingOverlay.style, {
                display: 'none',
                opacity: '0'
            });
        }
    }
}

/**
 * 慢速轮询状态（用于 202 长时间未完成时）
 * @param {HTMLImageElement} img
 */
function clearSlowRetrySchedule(img) {
    if (!img) return;
    const slowTimerId = img.dataset.slowRetryTimerId;
    if (slowTimerId) {
        clearTimeout(Number(slowTimerId));
        delete img.dataset.slowRetryTimerId;
    }
    delete img.dataset.slowRetryAttempt;
}

function scheduleSlowProcessingRetry(img) {
    if (!img || !img.isConnected) return;
    const attempt = parseInt(img.dataset.slowRetryAttempt || '0', 10);
    const MAX_SLOW_RETRIES = 30; // 最多 30 分钟轮询
    if (attempt >= MAX_SLOW_RETRIES) {
        lazyloadLogger.warn('缩略图长时间未就绪，转为失败', { src: img.dataset.src });
        img.dataset.thumbStatus = 'failed';
        clearSlowRetrySchedule(img);
        return;
    }
    const delay = 60000; // 60 秒再次检查
    img.dataset.slowRetryAttempt = String(attempt + 1);
    const timerId = setTimeout(() => {
        if (!img.isConnected) return;
        lazyloadLogger.debug('慢速轮询缩略图状态', {
            attempt: attempt + 1,
            src: img.dataset.src
        });
        requestLazyImage(img);
    }, delay);
    img.dataset.slowRetryTimerId = String(timerId);
    trackManagedTimer(timerId);
}

/**
 * 将图片加入懒加载流程（兼容旧接口）
 * @param {HTMLImageElement} img
 */
export function enqueueLazyImage(img) {
    requestLazyImage(img);
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
        
        // 确保URL包含时间戳参数，避免缓存问题
        const urlWithTimestamp = thumbnailUrl.includes('?') 
            ? `${thumbnailUrl}&_t=${Date.now()}` 
            : `${thumbnailUrl}?_t=${Date.now()}`;
        
        const response = await fetch(urlWithTimestamp, { 
            headers, 
            signal,
            cache: 'no-store',  // 强制不缓存
            credentials: 'same-origin'
        });
        
        if (response.status === 200) {
            const imageBlob = await response.blob();
            img.dataset.thumbStatus = '';
            delete img.dataset.retryAttempt; // 重置重试计数器
            delete img.dataset.lastRetryTime; // 清除重试时间记录
            clearSlowRetrySchedule(img);
            blobUrlManager.setBlobUrl(img, imageBlob);
            return;
        }
        
        if (response.status === 202) {
            const imageBlob = await response.blob();
            img.dataset.thumbStatus = 'processing';
            clearSlowRetrySchedule(img);
            blobUrlManager.setBlobUrl(img, imageBlob);

            // 持久化重试机制：使用指数退避，直到成功或达到最大尝试次数
            const retryAttempt = parseInt(img.dataset.retryAttempt || '0', 10);
            const maxRetries = 15; // 增加到15次，给予更多时间生成

            if (retryAttempt < maxRetries) {
                // 指数退避：2秒, 3秒, 5秒, 7秒, 10秒, ... 最大15秒
                const baseDelay = 2000;
                const delay = Math.min(15000, baseDelay + retryAttempt * 1000);

                img.dataset.retryAttempt = String(retryAttempt + 1);
                img.dataset.lastRetryTime = String(Date.now());

                const retryTimeoutId = setTimeout(() => {
                    if (img.isConnected && img.dataset.thumbStatus === 'processing') {
                        lazyloadLogger.debug(`重试加载处理中的缩略图 (${retryAttempt + 1}/${maxRetries})`, {
                            thumbnailUrl,
                            delay
                        });
                        requestLazyImage(img);
                    }
                }, delay);
                trackManagedTimer(retryTimeoutId);
            } else {
                // 达到最大重试次数，但不立即标记为失败，可能还在生成
                lazyloadLogger.warn('缩略图生成超时，已达最大重试次数，将降低重试频率', { thumbnailUrl });
                // 改为每30秒检查一次，最多再检查5次（额外2.5分钟）
                const finalRetryAttempt = parseInt(img.dataset.finalRetryAttempt || '0', 10);
                if (finalRetryAttempt < 5) {
                    img.dataset.finalRetryAttempt = String(finalRetryAttempt + 1);
                    const finalRetryTimeoutId = setTimeout(() => {
                        if (img.isConnected) {
                            lazyloadLogger.debug(`最终重试检查缩略图 (${finalRetryAttempt + 1}/5)`, { thumbnailUrl });
                            requestLazyImage(img);
                        }
                    }, 30000); // 30秒间隔
                    trackManagedTimer(finalRetryTimeoutId);
                } else {
                    delete img.dataset.retryAttempt;
                    delete img.dataset.finalRetryAttempt;
                    scheduleSlowProcessingRetry(img);
                }
            }
            return;
        }
        
        if (response.status === 429) {
            lazyloadLogger.debug('缩略图请求被频率限制，延迟重试', { thumbnailUrl });
            const delay = 1500 + Math.random() * 1500;
            const retryTimeoutId = setTimeout(() => {
                if (!img.isConnected) return;
                requestLazyImage(img);
            }, delay);
            trackManagedTimer(retryTimeoutId);
            return;
        }
        
        // 处理404错误：可能文件还在生成中，进行有限重试
        if (response.status === 404) {
            const retryAttempt = parseInt(img.dataset.retryAttempt || '0', 10);
            const max404Retries = 5; // 404最多重试5次
            
            if (retryAttempt < max404Retries) {
                const delay = 3000 * (retryAttempt + 1); // 3s, 6s, 9s, 12s, 15s
                lazyloadLogger.debug(`缩略图未找到(404)，将在 ${delay}ms 后重试 (${retryAttempt + 1}/${max404Retries})`, { thumbnailUrl });
                img.dataset.retryAttempt = String(retryAttempt + 1);
                img.dataset.thumbStatus = 'processing'; // 标记为处理中，避免重复请求
                
                const retryTimeoutId = setTimeout(() => {
                    if (img.isConnected) {
                        requestLazyImage(img);
                    }
                }, delay);
                trackManagedTimer(retryTimeoutId);
                return;
            } else {
                lazyloadLogger.warn('缩略图未找到，已达最大重试次数', { thumbnailUrl });
                img.dataset.thumbStatus = 'failed';
                clearSlowRetrySchedule(img);
                delete img.dataset.retryAttempt;
                return;
            }
        }
        
        // 处理500错误
        if (response.status === 500) {
            const thumbStatus = response.headers.get('X-Thumbnail-Status') || response.headers.get('X-Thumb-Status');
            if (thumbStatus === 'failed') {
                // 明确标记为失败
                const imageBlob = await response.blob().catch(() => null);
                img.dataset.thumbStatus = 'failed';
                if (imageBlob) {
                    blobUrlManager.setBlobUrl(img, imageBlob);
                }
                return;
            }
            
            // 其他500错误，可能是临时故障，进行重试
            const retryAttempt = parseInt(img.dataset.retryAttempt || '0', 10);
            const max500Retries = 3;
            
            if (retryAttempt < max500Retries) {
                const delay = 2000 * (retryAttempt + 1); // 2s, 4s, 6s
                lazyloadLogger.debug(`服务器错误(500)，将在 ${delay}ms 后重试 (${retryAttempt + 1}/${max500Retries})`, { thumbnailUrl });
                img.dataset.retryAttempt = String(retryAttempt + 1);
                
                const retryTimeoutId = setTimeout(() => {
                    if (img.isConnected) {
                        requestLazyImage(img);
                    }
                }, delay);
                trackManagedTimer(retryTimeoutId);
                return;
            }
            
            lazyloadLogger.error('服务器错误，已达最大重试次数', { thumbnailUrl });
            img.dataset.thumbStatus = 'failed';
            clearSlowRetrySchedule(img);
            delete img.dataset.retryAttempt;
            return;
        }
        
        // 其他错误状态
        lazyloadLogger.warn(`缩略图请求返回异常状态: HTTP ${response.status}`, { thumbnailUrl });
        
        // 对于其他错误，也进行有限重试
        const retryAttempt = parseInt(img.dataset.retryAttempt || '0', 10);
        if (retryAttempt < 2) {
            const delay = 2000 * (retryAttempt + 1);
            img.dataset.retryAttempt = String(retryAttempt + 1);
            const retryTimeoutId = setTimeout(() => {
                if (img.isConnected) {
                    requestLazyImage(img);
                }
            }, delay);
            trackManagedTimer(retryTimeoutId);
            return;
        }
        
        throw new Error(`Server responded with status: ${response.status}`);
    } catch (error) {
        if (error.name !== 'AbortError') {
            lazyloadLogger.error('获取懒加载图片失败', { thumbnailUrl, error });
            
            // 网络错误也进行重试
            const retryAttempt = parseInt(img.dataset.retryAttempt || '0', 10);
            if (retryAttempt < 2) {
                const delay = 2000 * (retryAttempt + 1);
                img.dataset.retryAttempt = String(retryAttempt + 1);
                lazyloadLogger.debug(`网络错误，将在 ${delay}ms 后重试`, { thumbnailUrl });
                
                const retryTimeoutId = setTimeout(() => {
                    if (img.isConnected) {
                        requestLazyImage(img);
                    }
                }, delay);
                trackManagedTimer(retryTimeoutId);
                return;
            }
            
            img.dispatchEvent(new Event('error'));
        } else {
            clearSlowRetrySchedule(img);
        }
    }
}

/**
 * 为懒加载图片发起加载请求
 * 支持自动重试和请求节流
 * @param {HTMLImageElement} img
 * @param {boolean} fromQueue 是否来自队列
 */
export function requestLazyImage(img, options = {}) {
    const thumbnailUrl = img.dataset.src;
    if (!thumbnailUrl || thumbnailUrl.includes('undefined') || thumbnailUrl.includes('null')) {
        lazyloadLogger.error('懒加载失败: 无效的图片URL', { thumbnailUrl });
        img.dispatchEvent(new Event('error'));
        return;
    }
    const forceReload = Boolean(options && options.force);
    if (forceReload) {
        img?.classList.remove('loaded');
        img?.classList.remove('error');
        if (img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:')) {
            try {
                img.removeAttribute('src');
            } catch {
                img.src = '';
            }
        }
    } else {
        // 已加载或已有真实 src 不重复请求
        if (img?.classList.contains('loaded')) return;
        if (img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:')) return;
    }
    // 处理快速加载标记
    if (img.dataset.wasLoaded === 'true') {
        delete img.dataset.wasLoaded;
        delete img.dataset.loadTime;
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            lazyloadLogger.debug('快速加载之前加载过的图片', { thumbnailUrl });
        }
    }

    // 使用队列管理器控制并发
    requestQueueManager.enqueue(img, thumbnailUrl, executeThumbnailRequest);
}

/**
 * 保存当前页面的懒加载状态
 * @param {string} pageKey 页面标识符
 */
export function savePageLazyState(pageKey) {
    if (!pageKey) return;
    const lazyImages = document.querySelectorAll('.lazy-image');

    // 确保会话ID已初始化
    let sessionId = sessionStorage.getItem('pageSessionId');
    if (!sessionId) {
        sessionId = Date.now().toString();
        try {
            sessionStorage.setItem('pageSessionId', sessionId);
        } catch (e) {
            // SessionStorage可能不可用
        }
    }

    const pageState = {
        timestamp: Date.now(),
        sessionId,
        images: Array.from(lazyImages).map(img => ({
            src: img.dataset.src,
            loaded: img?.classList.contains('loaded'),
            status: img.dataset.thumbStatus,
            loadTime: img?.classList.contains('loaded') ? Date.now() : null
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
    // 修复：确保会话ID持久化，避免每次都生成新ID导致恢复失败
    let currentSessionId = sessionStorage.getItem('pageSessionId');
    if (!currentSessionId) {
        currentSessionId = Date.now().toString();
        try {
            sessionStorage.setItem('pageSessionId', currentSessionId);
        } catch (e) {
            // SessionStorage可能不可用，使用临时ID
        }
    }
    if (cachedState.sessionId !== currentSessionId) {
        lazyloadLogger.debug('懒加载缓存: 会话不匹配，跳过恢复', { pageKey, cached: cachedState.sessionId, current: currentSessionId });
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
                // 🔧 修复问题1：不添加loaded类，让懒加载系统从浏览器缓存重新加载
                // img?.classList.add('loaded'); // ❌ 会导致executeLazyLoad直接return
                img.dataset.thumbStatus = '';
                img.dataset.wasLoaded = 'true'; // ✅ 标记为之前加载过，加速处理
                img.dataset.loadTime = cachedImage.loadTime;
            });
            lazyloadLogger.debug('懒加载缓存: 标记图片为wasLoaded，将从浏览器缓存重新加载', {
                restoredCount
            });
            const layoutTimeoutId = setTimeout(() => {
                triggerMasonryUpdate();
            }, 50);
            trackManagedTimer(layoutTimeoutId);
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
            if (state.isBlurredMode) img?.classList.add('blurred');
            if (img?.classList.contains('loaded') || img.dataset.thumbStatus === 'failed') {
                observer.unobserve(img);
                img._processingLazyLoad = false;
            } else {
                const cleanupTimeoutId = setTimeout(() => {
                    img._processingLazyLoad = false;
                }, 100);
                trackManagedTimer(cleanupTimeoutId);
            }
        });
    }, {
        // ✅ 适度预加载：上下各 600px，配合并发队列管理避免请求过载
        // 降低后可减少同时触发的请求数量，避免 429 错误
        rootMargin: '600px 100px',
        threshold: 0.01 // 降低阈值，只要1%可见就触发
    });
    globalImageObserver = observer;
    return observer;
}

/**
 * 初始化懒加载功能
 * @param {boolean} forceReobserve - 强制重新观察所有图片（用于页面切换时）
 * @returns {IntersectionObserver}
 */
export function setupLazyLoading(forceReobserve = false) {
    const observer = getOrCreateImageObserver();
    document.querySelectorAll('.lazy-image').forEach(img => {
        // 页面切换时强制重新观察，或者首次观察
        if (forceReobserve || !img._observed) {
            // 如果已经被观察，先取消观察再重新观察
            if (img._observed) {
                observer.unobserve(img);
            }
            observer.observe(img);
            img._observed = true;
        }
    });
    return observer;
}

/**
 * 获取全局图片观察器（供外部使用）
 * @returns {IntersectionObserver|null}
 */
export function getGlobalImageObserver() {
    return globalImageObserver;
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
    if (img._observed && !img?.classList.contains('loaded') && img.dataset.thumbStatus !== 'failed') {
        globalImageObserver.observe(img);
    }
}

/**
 * 清空请求队列（页面切换时调用）
 * @param {boolean} clearCache - 是否清空已加载缓存（默认 true，页面切换时推荐清空）
 */
export function clearLazyloadQueue(clearCache = true) {
    requestQueueManager.clear(clearCache);
    lazyloadLogger.debug('已清空懒加载请求队列', { clearCache });
}

/**
 * 获取懒加载队列状态（调试用）
 * 使用方法：在浏览器控制台运行 window.lazyloadStatus()
 * @returns {Object} 当前懒加载状态
 */
export function getLazyloadStatus() {
    const status = requestQueueManager.getStatus();
    console.log('📊 懒加载队列状态:');
    console.log(`  ⚡ 当前并发数: ${status.activeRequests}/${status.maxConcurrent}`);
    console.log(`  📋 队列长度: ${status.queueLength}`);
    console.log(`  ⏱️  平均响应时间: ${status.avgResponseTime}ms`);
    console.log(`  🔄 滚动方向: ${status.scrollDirection} (速度: ${status.scrollVelocity}px/s)`);
    console.log(`  ✅ 已加载数量: ${status.loadedCount}`);
    return status;
}

// 暴露到全局（仅开发环境）
if (typeof window !== 'undefined') {
    window.lazyloadStatus = getLazyloadStatus;
}

/**
 * 性能监控：自动检测异常并告警
 * 每 60 秒检查一次懒加载系统的健康状态
 */
let performanceMonitorTimer = null;

function startPerformanceMonitor() {
    // 避免重复启动
    if (performanceMonitorTimer) return;

    performanceMonitorTimer = setInterval(() => {
        try {
            const status = requestQueueManager.getStatus();

            // 告警 1：队列堆积过多
            if (status.queueLength > 50) {
                lazyloadLogger.warn('⚠️ 懒加载队列堆积过多', {
                    queueLength: status.queueLength,
                    maxConcurrent: status.maxConcurrent,
                    建议: '可能网络慢或并发数过低'
                });
            }

            // 告警 2：已加载数量过多（内存风险）
            if (status.loadedCount > 800) {
                lazyloadLogger.warn('⚠️ 已加载URL数量较多', {
                    loadedCount: status.loadedCount,
                    建议: '即将触发内存保护清理（1000条时）'
                });
            }

            // 告警 3：平均响应时间过长
            if (status.avgResponseTime > 2000) {
                lazyloadLogger.warn('⚠️ 缩略图加载速度慢', {
                    avgResponseTime: status.avgResponseTime,
                    maxConcurrent: status.maxConcurrent,
                    建议: '网络可能很慢，系统会自动降低并发数'
                });
            }

            // 正常状态日志（仅调试模式）
            if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                lazyloadLogger.debug('懒加载系统健康检查', status);
            }
        } catch (error) {
            lazyloadLogger.error('性能监控失败', { error: error.message });
        }
    }, 60000); // 每 60 秒检查一次
}

/**
 * 停止性能监控
 */
export function stopPerformanceMonitor() {
    if (performanceMonitorTimer) {
        clearInterval(performanceMonitorTimer);
        performanceMonitorTimer = null;
        lazyloadLogger.debug('性能监控已停止');
    }
}

// 自动启动性能监控（仅在浏览器环境）
if (typeof window !== 'undefined') {
    // 延迟 10 秒启动，避免影响页面初始化
    setTimeout(() => {
        startPerformanceMonitor();
        lazyloadLogger.debug('懒加载性能监控已启动（每60秒检查一次）');
    }, 10000);
}
