/**
 * @file sse.js
 * @module SSE
 * @description
 * 负责处理服务器推送事件（Server-Sent Events），如缩略图生成通知等，包含自动重连与认证逻辑。
 */

import { registerThumbnailBuffer } from '../core/event-buffer.js';
import { getAuthToken, clearAuthToken } from './auth.js';
import { triggerMasonryUpdate } from '../features/gallery/masonry.js';
import { createModuleLogger } from '../core/logger.js';
import { SSE } from '../core/constants.js';
import { setManagedTimeout } from '../core/timer-manager.js';
import { requestLazyImage, blobUrlManager } from '../features/gallery/lazyload.js';

// 日志实例
const sseLogger = createModuleLogger('SSE');

// 活动连接与重连相关变量
let eventSource = null;
let retryCount = 0;

// 日志函数
const sseLog = (message, ...args) => {
    sseLogger.debug(message, args);
};
const sseWarn = (message, ...args) => {
    sseLogger.warn(message, args);
};
const sseError = (message, ...args) => {
    sseLogger.error(message, args);
};

// 缓冲器实例
let thumbnailBuffer = null;

/**
 * 初始化事件缓冲器
 * 注册缩略图生成事件缓冲器，可扩展注册其他事件缓冲器
 */
function initializeEventBuffers() {
    thumbnailBuffer = registerThumbnailBuffer(async (batch) => {
        await processThumbnailBatch(batch);
    });

    // 可在此注册其他事件缓冲器
    // registerIndexBuffer(indexFlushCallback);
    // registerMediaBuffer(mediaFlushCallback);
}

/**
 * 批量处理缩略图刷新事件
 * @param {Array<Object>} batch - 缩略图事件批次
 * @returns {Promise<void>}
 */
async function processThumbnailBatch(batch) {
    if (!batch || batch.length === 0) return;

    sseLog(`批量处理 ${batch.length} 个缩略图更新事件`);

    const tasks = batch.map(async (eventData) => {
        const imagePath = eventData.path;

        // 查找所有匹配 path 的图片元素
        const imagesToUpdate = Array.from(document.querySelectorAll('img.lazy-image')).filter(img => {
            const dataSrc = img.dataset.src;
            if (!dataSrc) return false;
            try {
                const url = new URL(dataSrc, window.location.origin);
                const pathParam = url.searchParams.get('path');
                if (!pathParam) return false;
                const decodedPathParam = decodeURIComponent(pathParam);
                return decodedPathParam === imagePath;
            } catch {
                return false;
            }
        });

        if (imagesToUpdate.length > 0) {
            sseLog('批量刷新匹配图片数量:', imagesToUpdate.length, 'path:', imagePath);
        }

        for (const img of imagesToUpdate) {
            try {
                await updateThumbnailImage(img, imagePath);
            } catch (error) {
                sseWarn('缩略图更新失败:', error);
                img?.classList.remove('opacity-0');
                img.dispatchEvent(new Event('error'));
            }
        }
    });

    try {
        await Promise.all(tasks);
    } finally {
        try { triggerMasonryUpdate(); } catch { }
    }
}

/**
 * 更新单个缩略图图片
 * @param {HTMLImageElement} img - 图片元素
 * @param {string} imagePath - 图片路径
 * @returns {Promise<void>}
 */
async function updateThumbnailImage(img, imagePath) {
    // 检查图片是否还在DOM中
    if (!img.isConnected) {
        sseLog('图片已从DOM移除，取消更新', imagePath);
        return;
    }

    // 清理旧的 blob 与状态，确保懒加载重新获取
    try {
        (blobUrlManager || window?.blobUrlManager)?.cleanup?.(img);
    } catch (cleanupError) {
        sseWarn('清理 blob URL 失败', cleanupError);
        try {
            if (img.src && img.src.startsWith('blob:')) {
                URL.revokeObjectURL(img.src);
            }
        } catch { }
    }

    img?.classList.remove('error');
    img?.classList.remove('loaded');
    img?.classList.remove('processing');
    img?.classList.add('opacity-0');
    delete img.dataset.thumbStatus;
    delete img.dataset.retryAttempt;
    delete img.dataset.lastRetryTime;
    delete img.dataset.finalRetryAttempt;

    let normalizedPath = imagePath;
    try {
        normalizedPath = decodeURIComponent(imagePath);
    } catch { }
    const cacheKey = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const freshThumbnailUrl = `/api/thumbnail?path=${encodeURIComponent(normalizedPath)}&v=${cacheKey}&_sse=${cacheKey}`;
    img.dataset.src = freshThumbnailUrl;

    // 委托懒加载模块执行网络请求与重试
    if (typeof requestLazyImage === 'function') {
        requestLazyImage(img, { force: true });
        sseLog('SSE 触发懒加载刷新缩略图', imagePath);
        return;
    }

    // 兜底：直接刷新 src，避免事件丢失
    img.src = freshThumbnailUrl;
    sseWarn('requestLazyImage 不可用，回退为直接刷新 URL', { imagePath });
}

/**
 * 清理当前活动的 SSE 连接和流控制器
 */
function clearActiveConnection() {
    if (eventSource) {
        try { eventSource.close(); } catch { }
    }
    eventSource = null;
}

/**
 * 安排自动重连
 */
function scheduleReconnect() {
    const delay = Math.min(SSE.MAX_RETRY_DELAY, 1000 * Math.pow(2, retryCount));
    retryCount++;
    setManagedTimeout(connect, delay, 'sse-reconnect');
}

/**
 * 处理 connected 事件
 * @param {Object} data - 事件数据
 */
function handleConnectedEvent(data) {
    try {
        if (!data) return;
    } catch { }
}

/**
 * 处理 thumbnail-generated 事件
 * @param {Object} data - 事件数据
 */
function handleThumbnailGeneratedEvent(data) {
    if (!data || !data.path) return;
    try {
        thumbnailBuffer.enqueue(data);
    } catch (error) {
        sseError('Error buffering thumbnail-generated event:', error);
    }
}

/**
 * 分发 SSE 事件
 * @param {string} evtType - 事件类型
 * @param {Object} payload - 事件载荷
 */
function dispatchSseEvent(evtType, payload) {
    if (evtType === 'connected') {
        handleConnectedEvent(payload);
        return;
    }
    if (evtType === 'thumbnail-generated') {
        handleThumbnailGeneratedEvent(payload);
    }
}

/**
 * 解析原始 SSE 事件字符串并分发
 * @param {string} rawEvent - 原始事件字符串
 */
function buildEventsUrl() {
    // Cookie-based authentication: browser automatically sends httpOnly cookie
    // No need to pass token in URL (security improvement)
    return '/api/events';
}

async function verifySseAuthorization(token) {
    try {
        const headers = {};
        // 如果 localStorage 有 token，也在 header 中发送（向后兼容）
        // 但主要依赖 cookie 认证
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch('/api/events/status', {
            headers,
            credentials: 'include', // 确保发送 cookie
            cache: 'no-store'
        });

        if (response.status === 401) {
            sseLog('SSE 授权校验失败，触发重新登录');
            clearAuthToken();
            window.dispatchEvent(new CustomEvent('auth:required'));
            return false;
        }
        if (!response.ok) {
            sseWarn('SSE 授权状态检查失败', { status: response.status });
        }
        return true;
    } catch (error) {
        sseWarn('SSE 授权校验异常', error);
        return true;
    }
}

function startEventSource() {
    const url = buildEventsUrl();
    try {
        // withCredentials: true 确保发送 httpOnly cookies (cookie-based auth)
        eventSource = new EventSource(url, { withCredentials: true });
    } catch (error) {
        sseError('创建 EventSource 失败', error);
        scheduleReconnect();
        return;
    }

    eventSource.onopen = () => {
        retryCount = 0;
        sseLog('连接已建立');
    };

    eventSource.onerror = (err) => {
        sseError('连接错误:', err);
        clearActiveConnection();
        scheduleReconnect();
    };

    eventSource.addEventListener('connected', (e) => {
        try {
            const data = JSON.parse(e.data);
            handleConnectedEvent(data);
        } catch (error) {
            sseError('解析 connected 事件失败:', error);
        }
    });

    eventSource.addEventListener('thumbnail-generated', (e) => {
        try {
            const data = JSON.parse(e.data);
            handleThumbnailGeneratedEvent(data);
        } catch (error) {
            sseError('解析 thumbnail-generated 事件失败:', error);
        }
    });
}

/**
 * 建立到后端的 SSE 连接，包含自动重连和认证逻辑
 */
function connect() {
    clearActiveConnection();

    const token = getAuthToken();
    if (token) {
        verifySseAuthorization(token)
            .then((authorized) => {
                if (!authorized) return;
                startEventSource();
            })
            .catch((error) => {
                sseWarn('SSE 授权校验出错，继续尝试连接', error);
                startEventSource();
            });
        return;
    }

    startEventSource();
}

/**
 * 初始化 SSE 服务
 * 初始化事件缓冲器并建立 SSE 连接
 */
export function initializeSSE() {
    initializeEventBuffers();
    connect();
}
