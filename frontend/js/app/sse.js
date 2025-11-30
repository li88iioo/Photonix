/**
 * @file sse.js
 * @module SSE
 * @description
 * 负责处理服务器推送事件（Server-Sent Events），如缩略图生成通知等，包含自动重连与认证逻辑。
 */

import { registerThumbnailBuffer } from '../core/event-buffer.js';
import { getAuthToken } from './auth.js';
import { triggerMasonryUpdate } from '../features/gallery/masonry.js';
import { createModuleLogger } from '../core/logger.js';
import { safeClassList, safeQuerySelectorAll } from '../shared/dom-utils.js';
import { SSE } from '../core/constants.js';
import { setManagedTimeout } from '../core/timer-manager.js';
import { requestLazyImage, blobUrlManager } from '../features/gallery/lazyload.js';

// 日志实例
const sseLogger = createModuleLogger('SSE');

// 活动连接与重连相关变量
let eventSource = null;
let streamAbortController = null;
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
        const imagesToUpdate = Array.from(safeQuerySelectorAll('img.lazy-image')).filter(img => {
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
                safeClassList(img, 'remove', 'opacity-0');
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

    safeClassList(img, 'remove', 'error');
    safeClassList(img, 'remove', 'loaded');
    safeClassList(img, 'remove', 'processing');
    safeClassList(img, 'add', 'opacity-0');
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
    if (streamAbortController) {
        try { streamAbortController.abort(); } catch { }
    }
    streamAbortController = null;
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
function parseAndDispatch(rawEvent) {
    const lines = rawEvent.split(/\r?\n/);
    let eventType = 'message';
    let dataLines = [];
    for (const line of lines) {
        if (!line) continue;
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
            eventType = line.slice(6).trim() || 'message';
            continue;
        }
        if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
        }
    }

    if (dataLines.length === 0) {
        // 即使没有数据，如果是特定事件类型，也可能需要分发（视具体业务而定，目前保持原逻辑）
        // 但为了安全起见，避免分发 undefined
        if (eventType !== 'message') {
            dispatchSseEvent(eventType, null);
        }
        return;
    }

    const rawData = dataLines.join('\n');

    // 针对 Firefox 可能出现的空对象字符串 "{}" 或 "[]" 做预处理不是必须的，
    // 但 try-catch 是必须的。
    try {
        // 尝试解析 JSON
        const parsed = JSON.parse(rawData);
        dispatchSseEvent(eventType, parsed);
    } catch (error) {
        // 仅在非空数据解析失败时记录警告，避免干扰正常日志
        if (rawData.trim().length > 0) {
            sseWarn('解析 SSE 数据失败:', error, 'Raw Data:', rawData.substring(0, 100));
        }
    }
}

/**
 * 建立带认证的流式 SSE 连接
 * @param {string} token - 认证令牌
 * @returns {Promise<void>}
 */
async function streamWithAuth(token) {
    streamAbortController = new AbortController();
    const controller = streamAbortController;
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
        const response = await fetch('/api/events', {
            headers: { 'Authorization': `Bearer ${token}` },
            cache: 'no-store',
            signal: controller.signal,
        });

        // 检测到 401（认证失败）时，清除本地无效 token 并触发登录流程，不再尝试重连
        if (response.status === 401) {
            sseLog('SSE 认证失败（401），清除无效 token');
            localStorage.removeItem('photonix_auth_token');
            // 触发 auth:required 事件，通知应用显示登录页
            window.dispatchEvent(new CustomEvent('auth:required'));
            return; // 停止重试
        }

        if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`);
        }

        retryCount = 0;
        sseLog('SSE 认证流已建立');

        const reader = response.body.getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (controller.signal.aborted) return;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
                const chunk = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                if (chunk.trim().length > 0) {
                    parseAndDispatch(chunk);
                }
                boundary = buffer.indexOf('\n\n');
            }
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
            parseAndDispatch(buffer);
        }
        scheduleReconnect();
    } catch (error) {
        if (!controller.signal.aborted) {
            sseError('SSE 认证流错误:', error);
            scheduleReconnect();
        }
    } finally {
        if (!controller.signal.aborted) {
            controller.abort();
        }
    }
}

/**
 * 建立带认证的 SSE 连接
 * @param {string} token - 认证令牌
 */
function connectWithAuth(token) {
    streamWithAuth(token);
}

/**
 * 建立到后端的 SSE 连接，包含自动重连和认证逻辑
 */
function connect() {
    clearActiveConnection();

    const token = getAuthToken();
    if (token) {
        connectWithAuth(token);
        return;
    }

    const url = '/api/events';
    eventSource = new EventSource(url);

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
 * 初始化 SSE 服务
 * 初始化事件缓冲器并建立 SSE 连接
 */
export function initializeSSE() {
    initializeEventBuffers();
    connect();
}
