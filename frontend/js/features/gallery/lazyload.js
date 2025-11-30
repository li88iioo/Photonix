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

// 注册现有的清理资源
resourceCleanupManager.register(blobUrlManager);
resourceCleanupManager.register(imageObserverResource);

// 注册定时器到资源清理管理器
resourceCleanupManager.registerTimer(blobCleanupInterval);

/** 导出资源清理相关对象 */
export { blobUrlManager, resourceCleanupManager };

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
    // 重置重试计数器
    delete img.dataset.retryAttempt;

    // 清理父元素的生成状态类
    const parent = img.closest('.photo-item, .album-card');
    if (parent) {
        safeClassList(parent, 'remove', 'thumbnail-generating');
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
    resourceCleanupManager.registerTimer(timerId);
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
                resourceCleanupManager.registerTimer(retryTimeoutId);
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
                    resourceCleanupManager.registerTimer(finalRetryTimeoutId);
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
            resourceCleanupManager.registerTimer(retryTimeoutId);
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
                resourceCleanupManager.registerTimer(retryTimeoutId);
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
                resourceCleanupManager.registerTimer(retryTimeoutId);
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
            resourceCleanupManager.registerTimer(retryTimeoutId);
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
                resourceCleanupManager.registerTimer(retryTimeoutId);
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
        safeClassList(img, 'remove', 'loaded');
        safeClassList(img, 'remove', 'error');
        if (img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:')) {
            try {
                img.removeAttribute('src');
            } catch {
                img.src = '';
            }
        }
    } else {
        // 已加载或已有真实 src 不重复请求
        if (safeClassList(img, 'contains', 'loaded')) return;
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
    executeThumbnailRequest(img, thumbnailUrl).catch(() => {
        // 捕获已在内部处理的错误，避免未处理的Promise异常
    });
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
                // safeClassList(img, 'add', 'loaded'); // ❌ 会导致executeLazyLoad直接return
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
        // ✅ 增加rootMargin，提前触发懒加载，避免快速滚动时图片加载不及时
        // 上下各2000px（针对平滑滚动优化），左右100px
        rootMargin: '2000px 100px',
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
    if (img._observed && !safeClassList(img, 'contains', 'loaded') && img.dataset.thumbStatus !== 'failed') {
        globalImageObserver.observe(img);
    }
}
