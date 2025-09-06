import { state } from './state.js';
import { AbortBus } from './abort-bus.js';
import { triggerMasonryUpdate } from './masonry.js';
import { getAuthToken } from './auth.js';

// Blob URL 管理器 - 池化优化版本
const blobUrlManager = {
    // 存储图片元素与其当前blob URL的映射
    activeBlobUrls: new Map(),
    // 存储blob URL的创建时间，用于清理过期资源
    blobCreationTimes: new Map(),
    // Blob URL池，用于复用
    blobUrlPool: [],
    // 池的最大大小
    maxPoolSize: 20,
    // 最大blob URL缓存时间（3分钟，增加以减少重建）
    maxBlobAge: 3 * 60 * 1000,

    // 安全revoke blob URL（池化版本）
    revokeBlobUrl: function(img) {
        try {
            const currentSrc = img.src;
            if (currentSrc && currentSrc.startsWith('blob:')) {
                // 检查是否已经被其他地方revoke
                if (this.activeBlobUrls.has(img) && this.activeBlobUrls.get(img) === currentSrc) {
                    // 不再立即revoke，而是放入池中以供复用
                    if (this.blobUrlPool.length < this.maxPoolSize) {
                        this.blobUrlPool.push(currentSrc);
                    } else {
                        // 池已满，正常revoke
                        URL.revokeObjectURL(currentSrc);
                    }
                    this.activeBlobUrls.delete(img);
                    this.blobCreationTimes.delete(img);
                }
            }
        } catch (e) {
            // 静默忽略revoke错误，避免控制台噪音
        }
    },

    // 设置新的blob URL（池化优化版本）
    setBlobUrl: function(img, blob) {
        try {
            // 先清理旧的blob URL
            this.revokeBlobUrl(img);

            let newBlobUrl;

            // 尝试从池中获取可复用的blob URL
            if (this.blobUrlPool.length > 0) {
                newBlobUrl = this.blobUrlPool.pop();
                // 复用池中的URL，直接更新内容
                try {
                    // 注意：这里我们不能直接复用URL.createObjectURL的结果
                    // 因为每个blob只能对应一个URL，所以还是需要创建新的
                    newBlobUrl = URL.createObjectURL(blob);
                } catch (error) {
                    console.warn('复用blob URL失败，创建新的:', error);
                    newBlobUrl = URL.createObjectURL(blob);
                }
            } else {
                // 池为空，创建新的blob URL
                newBlobUrl = URL.createObjectURL(blob);
            }

            // 验证blob URL是否有效
            if (!newBlobUrl || !newBlobUrl.startsWith('blob:')) {
                console.warn('创建blob URL失败');
                return null;
            }

            this.activeBlobUrls.set(img, newBlobUrl);
            this.blobCreationTimes.set(img, Date.now());

            // 设置图片src前先监听错误事件
            const errorHandler = (e) => {
                console.warn('blob URL加载失败，尝试清理:', newBlobUrl);
                this.revokeBlobUrl(img);
                img.removeEventListener('error', errorHandler);
            };

            img.addEventListener('error', errorHandler, { once: true });
            img.src = newBlobUrl;

            return newBlobUrl;
        } catch (error) {
            console.warn('设置blob URL时出错:', error);
            return null;
        }
    },

    // 清理特定图片的blob URL
    cleanup: function(img) {
        this.revokeBlobUrl(img);
    },

    // 清理所有blob URLs（页面卸载时使用）
    cleanupAll: function() {
        for (const [img, blobUrl] of this.activeBlobUrls) {
            try {
                URL.revokeObjectURL(blobUrl);
            } catch (e) {
                // 静默忽略
            }
        }
        this.activeBlobUrls.clear();
        this.blobCreationTimes.clear();
    },

    // 清理过期blob URLs（内存优化，支持池化）
    cleanupExpired: function() {
        const now = Date.now();
        const toCleanup = [];

        for (const [img, creationTime] of this.blobCreationTimes) {
            if (now - creationTime > this.maxBlobAge) {
                toCleanup.push(img);
            }
        }

        for (const img of toCleanup) {
            this.revokeBlobUrl(img);
        }

        // 清理池中过期的URL（定期清理池，避免内存泄漏）
        if (this.blobUrlPool.length > 0) {
            const expiredUrls = [];
            // 简单的时间戳检查：池中的URL如果超过最大年龄的一半，就清理
            const poolMaxAge = this.maxBlobAge / 2;
            // 注意：这里我们没有池中URL的创建时间，所以使用简单的计数器
            if (this.blobUrlPool.length > this.maxPoolSize * 0.8) {
                // 当池使用率超过80%时，清理一半的URL
                const cleanupCount = Math.floor(this.blobUrlPool.length / 2);
                for (let i = 0; i < cleanupCount; i++) {
                    const url = this.blobUrlPool.pop();
                    try {
                        URL.revokeObjectURL(url);
                    } catch (e) {
                        // 静默忽略
                    }
                    expiredUrls.push(url);
                }
            }
            // 减少清理日志输出频率
            if (expiredUrls.length > 0 && Math.random() < 0.1) { // 10%概率输出
                console.debug(`清理了 ${expiredUrls.length} 个池中过期blob URLs`);
            }
        }

        // 减少清理日志输出频率
        if (toCleanup.length > 0 && Math.random() < 0.1) { // 10%概率输出
            console.debug(`清理了 ${toCleanup.length} 个过期blob URLs`);
        }
    }
};

// 定期清理过期blob URLs（更频繁）
setInterval(() => {
    blobUrlManager.cleanupExpired();
}, 30000); // 每30秒清理一次

// 导出blob URL管理器和重试管理器供其他模块使用
export { blobUrlManager, thumbnailRetryManager };

// 将blob URL管理器暴露到全局window对象，供SSE等其他模块使用
if (typeof window !== 'undefined') {
    window.blobUrlManager = blobUrlManager;

    // 页面卸载时清理所有资源
    window.addEventListener('beforeunload', () => {
        blobUrlManager.cleanupAll();
        thumbnailRetryManager.cleanup();
        thumbnailRequestThrottler.cleanup();
        // 清理虚拟滚动懒加载器
        if (window.virtualScrollLazyLoader) {
            window.virtualScrollLazyLoader.cleanup();
        }
    });
}

/**
 * 图片加载成功处理函数
 * @param {Event} event - 图片加载事件
 */
function handleImageLoad(event) {
    const img = event.target;
    const status = img.dataset.thumbStatus;
    // 当缩略图仍在生成中或失败时，保留占位，不标记为 loaded
    if (status === 'processing') {
        img.classList.add('processing');

        // 添加更明显的loading指示器
        const container = img.parentElement;
        if (container && !container.querySelector('.processing-indicator')) {
            const indicator = document.createElement('div');
            indicator.className = 'processing-indicator';
            indicator.innerHTML = `
                <div class="processing-spinner">
                    <div class="processing-dots">
                        <div class="processing-dot"></div>
                        <div class="processing-dot"></div>
                        <div class="processing-dot"></div>
                    </div>
                </div>
                <div class="processing-text">生成中...</div>
            `;
            container.appendChild(indicator);

            // 3秒后自动移除指示器（防止长时间显示）
            setTimeout(() => {
                if (indicator.parentNode) {
                    indicator.remove();
                }
            }, 3000);
        }

        return;
    }
    if (status === 'failed') {
        img.classList.add('error');
        return;
    }
    img.classList.add('loaded');
    // 清理可能残留的处理中/错误态样式与标记，避免覆盖正常显示
    img.classList.remove('processing', 'error');
    img.dataset.thumbStatus = '';

    // 使用统一的blob URL管理器清理资源
    blobUrlManager.cleanup(img);

    // 清理父元素的生成状态类，停止SVG动画
    const parent = img.closest('.photo-item, .album-card');
    if (parent) {
        parent.classList.remove('thumbnail-generating');
    }

    // 手动隐藏占位符和加载覆盖层，因为CSS选择器无法向前选择
    const container = img.parentElement;
    if (container) {
        const placeholder = container.querySelector('.image-placeholder');
        const loadingOverlay = container.querySelector('.loading-overlay');
        const processingIndicator = container.querySelector('.processing-indicator');

        if (placeholder) {
            placeholder.style.opacity = '0';
            placeholder.style.animation = 'none';
            placeholder.style.pointerEvents = 'none';
        }

        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
            loadingOverlay.style.opacity = '0';
        }

        // 移除processing indicator
        if (processingIndicator) {
            processingIndicator.remove();
        }
    }
    triggerMasonryUpdate();
}

/**
 * 图片加载失败处理函数
 * @param {Event} event - 图片错误事件
 */
function handleImageError(event) {
    const img = event.target;
    img.onerror = null; // 防止错误循环

    // 清理失败图片的blob URL
    blobUrlManager.cleanup(img);

    // 使用内联 SVG 作为兜底占位，避免对静态 /assets 的依赖
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
    img.classList.add('error');
    img.classList.remove('blurred');

    // 手动隐藏占位符和加载覆盖层
    const container = img.parentElement;
    if (container) {
        const placeholder = container.querySelector('.image-placeholder');
        const loadingOverlay = container.querySelector('.loading-overlay');

        if (placeholder) {
            placeholder.style.opacity = '0';
            placeholder.style.animation = 'none';
            placeholder.style.pointerEvents = 'none';
        }

        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
            loadingOverlay.style.opacity = '0';
        }
    }
}

/**
 * 智能请求节流器 - 基于滚动速度动态调整
 * 能够自适应用户浏览行为，优化加载性能
 */
const thumbnailRequestThrottler = {
    activeRequests: new Map(), // 活跃请求映射
    baseMaxConcurrentRequests: 3, // 基础最大并发请求数
    baseRequestDelay: 50, // 基础请求间最小延迟（毫秒）

    // 智能调度相关状态
    scrollVelocity: 0, // 当前滚动速度
    lastScrollTime: 0,
    lastScrollTop: 0,
    velocitySamples: [], // 速度采样
    maxVelocitySamples: 10,

    // 动态参数
    get maxConcurrentRequests() {
        const velocity = Math.abs(this.scrollVelocity);
        if (velocity > 100) return this.baseMaxConcurrentRequests + 4; // 快速滚动时增加并发
        if (velocity > 50) return this.baseMaxConcurrentRequests + 2; // 中等速度时适度增加
        return this.baseMaxConcurrentRequests; // 慢速或静止时保持基础值
    },

    get requestDelay() {
        const velocity = Math.abs(this.scrollVelocity);
        if (velocity > 100) return Math.max(10, this.baseRequestDelay - 20); // 快速滚动时减少延迟
        if (velocity > 50) return Math.max(25, this.baseRequestDelay - 10); // 中等速度时略微减少延迟
        return this.baseRequestDelay; // 慢速或静止时保持基础延迟
    },

    /**
     * 更新滚动速度
     * @param {number} scrollTop - 当前滚动位置
     */
    updateScrollVelocity(scrollTop) {
        const now = Date.now();
        const timeDelta = now - this.lastScrollTime;

        if (timeDelta > 0 && timeDelta < 1000) { // 只在1秒内计算速度
            const distance = scrollTop - this.lastScrollTop;
            const velocity = distance / timeDelta * 1000; // 像素/秒

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
     * @param {string} url - 请求URL
     * @returns {boolean} 是否可以发送
     */
    canSendRequest(url) {
        // 检查并发限制
        if (this.activeRequests.size >= this.maxConcurrentRequests) {
            return false;
        }

        // 检查是否已经在处理中
        if (this.activeRequests.has(url)) {
            return false;
        }

        return true;
    },

    /**
     * 标记请求开始
     * @param {string} url - 请求URL
     */
    markRequestStart(url) {
        this.activeRequests.set(url, Date.now());
    },

    /**
     * 标记请求完成
     * @param {string} url - 请求URL
     */
    markRequestEnd(url) {
        this.activeRequests.delete(url);
    },

    /**
     * 清理超时的请求记录
     */
    cleanup() {
        const now = Date.now();
        const timeout = 30000; // 30秒超时

        for (const [url, startTime] of this.activeRequests) {
            if (now - startTime > timeout) {
                this.activeRequests.delete(url);
            }
        }
    }
};

// 定期清理超时的请求记录
setInterval(() => {
    thumbnailRequestThrottler.cleanup();
}, 15000); // 15秒清理一次

/**
 * 缩略图重试管理器
 * 为正在处理的缩略图添加定期重试机制（优化版本，避免内存泄漏）
 */
const thumbnailRetryManager = {
    retryingImages: new Map(), // 正在重试的图片映射，存储重试状态
    activeTimeouts: new Map(), // 活跃的超时器映射，只保留一个定时器

    /**
     * 为图片添加重试机制（优化版本）
     * @param {HTMLImageElement} img - 图片元素
     * @param {string} thumbnailUrl - 缩略图URL
     */
    addRetry(img, thumbnailUrl) {
        // 清理现有的重试
        this.removeRetry(img);

        const retryKey = thumbnailUrl;
        const retryState = {
            img: img,
            url: thumbnailUrl,
            retryCount: 0,
            maxRetries: 2, // 降低重试次数到2次
            nextRetryTime: Date.now() + 8000 // 8秒后开始第一次重试
        };

        this.retryingImages.set(retryKey, retryState);

        // 启动重试循环
        this.scheduleNextRetry(retryKey);
    },

    /**
     * 调度下一次重试
     * @param {string} retryKey - 重试键
     */
    scheduleNextRetry(retryKey) {
        const retryState = this.retryingImages.get(retryKey);
        if (!retryState) return;

        const { img, url, retryCount, maxRetries, nextRetryTime } = retryState;
        const now = Date.now();
        const delay = Math.max(0, nextRetryTime - now);

        // 清理之前的超时器
        this.clearTimeout(retryKey);

        const timeoutId = setTimeout(async () => {
            // 检查图片状态
            if (!img.isConnected || img.classList.contains('loaded') || img.dataset.thumbStatus !== 'processing') {
                this.removeRetry(img);
                return;
            }

            // 检查重试次数
            if (retryCount >= maxRetries) {
                console.warn('缩略图重试次数过多，停止重试:', url);
                this.removeRetry(img);
                return;
            }

            try {
                const token = getAuthToken();
                const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
                const signal = AbortBus.get('thumb');

                // 减少重试日志输出，只在第一次重试时输出
                // 注释掉详细的重试日志以减少控制台噪音
                // if (retryCount === 0) {
                //     console.debug(`重试获取缩略图 (${retryCount + 1}/${maxRetries}):`, url);
                // }
                const response = await fetch(url, { headers, signal });

                if (response.status === 200) {
                    // 成功获取，加载图片并停止重试
                    const imageBlob = await response.blob();
                    img.dataset.thumbStatus = '';
                    blobUrlManager.setBlobUrl(img, imageBlob);

                    // 清理SSE处理标记
                    if (img.dataset.processingBySSE) {
                        delete img.dataset.processingBySSE;
                    }

                    this.removeRetry(img);
                } else if (response.status === 202) {
                    // 仍在处理，调度下一次重试
                    retryState.retryCount++;
                    retryState.nextRetryTime = Date.now() + (retryCount + 1) * 15000; // 递增延迟，增加到15秒间隔
                    this.scheduleNextRetry(retryKey);
                } else if (response.status === 500 && (response.headers.get('X-Thumb-Status') === 'failed')) {
                    // 生成失败，停止重试
                    const imageBlob = await response.blob();
                    img.dataset.thumbStatus = 'failed';
                    blobUrlManager.setBlobUrl(img, imageBlob);

                    // 清理SSE处理标记
                    if (img.dataset.processingBySSE) {
                        delete img.dataset.processingBySSE;
                    }

                    this.removeRetry(img);
                } else {
                    // 其他错误，停止重试
                    this.removeRetry(img);
                }
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.warn('缩略图重试失败:', url, error);
                    // 网络错误也停止重试，避免无限循环
                    this.removeRetry(img);
                }
            }
        }, delay);

        this.activeTimeouts.set(retryKey, timeoutId);
    },

    /**
     * 清理指定键的超时器
     * @param {string} retryKey - 重试键
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
     * @param {HTMLImageElement} img - 图片元素
     */
    removeRetry(img) {
        const thumbnailUrl = img.dataset.src;
        if (!thumbnailUrl) return;

        const retryKey = thumbnailUrl;

        // 清理超时器
        this.clearTimeout(retryKey);

        // 清理重试状态
        this.retryingImages.delete(retryKey);
    },

    /**
     * 清理所有重试机制（页面卸载时使用）
     */
    cleanup() {
        // 清理所有活跃的超时器
        for (const retryKey of this.activeTimeouts.keys()) {
            this.clearTimeout(retryKey);
        }

        // 清理重试状态
        this.retryingImages.clear();
        this.activeTimeouts.clear();
    }
};

/**
 * 执行缩略图请求的内部函数
 * @param {HTMLImageElement} img - 图片元素
 * @param {string} thumbnailUrl - 缩略图URL
 */
async function executeThumbnailRequest(img, thumbnailUrl) {
    try {
        const token = getAuthToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const signal = AbortBus.get('thumb'); // 使用全局 AbortBus 来取消请求

        const response = await fetch(thumbnailUrl, { headers, signal });

        if (response.status === 200) {
            // 成功获取，直接加载
            const imageBlob = await response.blob();
            img.dataset.thumbStatus = '';
            blobUrlManager.setBlobUrl(img, imageBlob);
            // 清理可能的重试机制
            thumbnailRetryManager.removeRetry(img);
        } else if (response.status === 202) {
            // 正在处理：显示占位缩略图，并启动重试机制
            const imageBlob = await response.blob();
            img.dataset.thumbStatus = 'processing';
            blobUrlManager.setBlobUrl(img, imageBlob);
            // 添加重试机制
            thumbnailRetryManager.addRetry(img, thumbnailUrl);
        } else if (response.status === 429) {
            // 请求频率过高，被服务器拒绝
            // 频率限制日志只在开发模式下输出
            if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                console.debug('缩略图请求被频率限制，延迟重试:', thumbnailUrl);
            }
            // 立即标记请求结束（因为服务器拒绝了）
            thumbnailRequestThrottler.markRequestEnd(thumbnailUrl);
            // 延迟更长时间重试
            setTimeout(() => {
                requestLazyImage(img);
            }, 2000); // 2秒后重试
            return; // 提前返回，避免重复处理
        } else if (response.status === 500 && (response.headers.get('X-Thumb-Status') === 'failed')) {
            // 失败：展示后端返回的失败占位图，保留占位层
            const imageBlob = await response.blob();
            img.dataset.thumbStatus = 'failed';
            blobUrlManager.setBlobUrl(img, imageBlob);
            // 清理重试机制
            thumbnailRetryManager.removeRetry(img);
        } else {
            // 其他错误状态
            throw new Error(`Server responded with status: ${response.status}`);
        }
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error('获取懒加载图片失败:', thumbnailUrl, error);
            img.dispatchEvent(new Event('error'));
        }
    }
}

/**
 * 为懒加载图片发起加载请求
 * 支持正在处理的缩略图的自动重试机制和轻量级请求节流
 * @param {HTMLImageElement} img - 图片元素
 */
function requestLazyImage(img) {
    const thumbnailUrl = img.dataset.src;
    if (!thumbnailUrl || thumbnailUrl.includes('undefined') || thumbnailUrl.includes('null')) {
        console.error('懒加载失败: 无效的图片URL:', thumbnailUrl);
        img.dispatchEvent(new Event('error'));
        return;
    }

    // 如果已完成加载，或已有真实 src（非 data: 与非 blob:），则不重复请求
    if (img.classList.contains('loaded')) return;
    if (img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:')) return;

    // 如果这张图片之前加载过，清除wasLoaded标记并继续正常加载
    if (img.dataset.wasLoaded === 'true') {
        delete img.dataset.wasLoaded;
        delete img.dataset.loadTime;
        // 减少快速加载日志输出，只在开发模式下输出
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            console.debug('快速加载之前加载过的图片:', thumbnailUrl);
        }
    }

    // 检查是否可以发送请求
    if (!thumbnailRequestThrottler.canSendRequest(thumbnailUrl)) {
        // 如果不能发送，使用智能延迟时间
        const retryDelay = thumbnailRequestThrottler.requestDelay * 2;
        setTimeout(() => {
            requestLazyImage(img);
        }, retryDelay);
        return;
    }

    // 标记请求开始
    thumbnailRequestThrottler.markRequestStart(thumbnailUrl);

    // 执行请求
    executeThumbnailRequest(img, thumbnailUrl)
        .finally(() => {
            // 无论成功失败都要标记请求结束
            thumbnailRequestThrottler.markRequestEnd(thumbnailUrl);
        })
        .catch(() => {
            // 如果是429错误，已经在内部处理了重试，这里不需要额外处理
        });
}

/**
 * 保存当前页面的懒加载状态
 * @param {string} pageKey - 页面标识符
 */
export function savePageLazyState(pageKey) {
    if (!pageKey) return;

    const lazyImages = document.querySelectorAll('.lazy-image');
    const pageState = {
        timestamp: Date.now(),
        sessionId: Date.now().toString(), // 用于标识当前会话
        images: Array.from(lazyImages).map(img => ({
            src: img.dataset.src,
            loaded: img.classList.contains('loaded'),
            status: img.dataset.thumbStatus,
            // 不缓存blob URL，因为页面重新加载后会失效
            loadTime: img.classList.contains('loaded') ? Date.now() : null
        }))
    };

    pageStateCache.set(pageKey, pageState);

    // 限制缓存大小，避免内存泄漏
    if (pageStateCache.size > 10) {
        const oldestKey = pageStateCache.keys().next().value;
        pageStateCache.delete(oldestKey);
    }

    // 减少缓存保存日志输出，只在开发模式下输出
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        console.debug(`[懒加载缓存] 保存了 ${pageState.images.filter(img => img.loaded).length} 张图片的状态`);
    }
}

/**
 * 恢复页面的懒加载状态
 * @param {string} pageKey - 页面标识符
 */
export function restorePageLazyState(pageKey) {
    if (!pageKey) return false;

    // 重复恢复防护
    if (restoreProtection.has(pageKey)) {
        // 减少重复恢复日志输出，只在开发模式下输出
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            console.debug(`[懒加载缓存] 跳过重复恢复: ${pageKey}`);
        }
        return false;
    }

    const cachedState = pageStateCache.get(pageKey);
    if (!cachedState) return false;

    // 检查缓存是否过期（3分钟，缩短过期时间）
    if (Date.now() - cachedState.timestamp > 3 * 60 * 1000) {
        pageStateCache.delete(pageKey);
        // 减少过期缓存日志输出，只在开发模式下输出
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            console.debug(`[懒加载缓存] 缓存已过期: ${pageKey}`);
        }
        return false;
    }

    // 检查是否是同一会话（避免页面刷新后的无效恢复）
    const currentSessionId = sessionStorage.getItem('pageSessionId') || Date.now().toString();
    if (cachedState.sessionId !== currentSessionId) {
        // 减少会话不匹配日志输出，只在开发模式下输出
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.0.1') {
            console.debug(`[懒加载缓存] 会话不匹配，跳过恢复: ${pageKey}`);
        }
        pageStateCache.delete(pageKey);
        return false;
    }

    const lazyImages = document.querySelectorAll('.lazy-image');
    let restoredCount = 0;
    const imagesToMark = [];

    lazyImages.forEach(img => {
        const cachedImage = cachedState.images.find(ci => ci.src === img.dataset.src);
        if (cachedImage && cachedImage.loaded) {
            // 不直接设置blob URL（因为已失效），而是标记为快速加载状态
            imagesToMark.push({
                img,
                cachedImage
            });
            restoredCount++;
        }
    });

    if (restoredCount > 0) {
        // 添加重复恢复防护
        restoreProtection.add(pageKey);

        // 使用requestAnimationFrame避免强制重排
        requestAnimationFrame(() => {
            imagesToMark.forEach(({ img, cachedImage }) => {
                // 只标记状态，不设置失效的blob URL
                img.classList.add('loaded');
                img.dataset.thumbStatus = '';

                // 添加快速加载标记，让懒加载系统知道这张图片之前加载过
                img.dataset.wasLoaded = 'true';
                img.dataset.loadTime = cachedImage.loadTime;
            });

            // 减少恢复状态日志输出，只在开发模式下输出
            if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                console.debug(`[懒加载缓存] 恢复了 ${restoredCount} 张图片的状态 (无blob URL)`);
            }

            // 延迟触发布局更新，避免强制重排
            setTimeout(() => {
                triggerMasonryUpdate();
            }, 50);
        });

        return true;
    }

    return false;
}

/**
 * 清理恢复防护
 * 在路由切换时调用，为新页面恢复做准备
 */
export function clearRestoreProtection() {
    restoreProtection.clear();
}

/**
 * 设置懒加载功能
 * 使用 Intersection Observer 监听图片可见性，支持重新观察处理中的图片
 * 集成了智能滚动速度检测和页面状态缓存
 */
export function setupLazyLoading() {
    // 移除节流，直接处理所有intersection事件
    const imageObserver = new IntersectionObserver((entries, observer) => {
        // 直接处理所有可见的图片，不进行节流
        const visibleImages = entries.filter(entry => entry.isIntersecting);

        visibleImages.forEach(entry => {
            const img = entry.target;

            // 检查是否已经被处理过（避免重复处理）
            if (img._processingLazyLoad) return;
            img._processingLazyLoad = true;

            img.onload = handleImageLoad;
            img.onerror = handleImageError;

            requestLazyImage(img);

            if (!img._noContextMenuBound) {
                img.addEventListener('contextmenu', e => e.preventDefault());
                img._noContextMenuBound = true;
            }

            if (state.isBlurredMode) img.classList.add('blurred');

            // 重要修复：只对成功加载的图片停止观察
            // 处理中的图片（processing状态）需要保持观察，以便SSE更新或重试时能够重新触发
            if (img.classList.contains('loaded') || img.dataset.thumbStatus === 'failed') {
                observer.unobserve(img);
                img._processingLazyLoad = false; // 清理标记
            } else {
                // 延迟清理标记，避免重复处理
                setTimeout(() => {
                    img._processingLazyLoad = false;
                }, 100);
            }
        });
    }, {
        // 大幅扩大缓冲区，确保快速滚动时也能捕获图片
        rootMargin: '500px 100px',
        // 使用更简单的阈值配置，减少复杂性
        threshold: 0.1
    });

    // 添加滚动速度检测
    const scrollHandler = () => {
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        thumbnailRequestThrottler.updateScrollVelocity(scrollTop);
    };

    // 使用passive监听器提升性能
    window.addEventListener('scroll', scrollHandler, { passive: true });
    // 存储引用以便后续清理
    imageObserver._scrollHandler = scrollHandler;

    document.querySelectorAll('.lazy-image').forEach(img => {
        if (!img._observed) {
            imageObserver.observe(img);
            img._observed = true;
        }
    });

    // 返回观察器引用，供后续重新观察使用
    return imageObserver;
}

// 全局懒加载观察器引用
let globalImageObserver = null;

// 页面状态缓存 - 避免路由切换时重新请求
const pageStateCache = new Map();

// 恢复状态防护 - 防止重复恢复
const restoreProtection = new Set();

/**
 * 重新观察处理中的图片
 * 当SSE事件或重试机制更新图片状态时调用
 * @param {HTMLImageElement} img - 图片元素
 */
export function reobserveImage(img) {
    // 如果图片不再是处理状态，不需要重新观察
    if (img.dataset.thumbStatus !== 'processing') return;

    // 初始化全局观察器
    if (!globalImageObserver) {
        globalImageObserver = setupLazyLoading();
    }

    // 如果图片已被观察器停止观察，重新开始观察
    if (img._observed && !img.classList.contains('loaded') && img.dataset.thumbStatus !== 'failed') {
        globalImageObserver.observe(img);
    }
}
