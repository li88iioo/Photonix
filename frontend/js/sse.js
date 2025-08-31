import { showNotification } from './utils.js';
import { getAuthToken } from './auth.js';
import { triggerMasonryUpdate } from './masonry.js';

let eventSource = null;
let retryCount = 0;
const MAX_RETRY_DELAY = 60000; // 最大重连延迟: 60秒

// 环境检测：开发环境显示详细日志
const isDevelopment = window.location.hostname === 'localhost' ||
                     window.location.hostname === '127.0.0.1' ||
                     window.location.hostname.includes('dev') ||
                     window.location.port === '3000' ||
                     window.location.port === '8080';

// 条件日志函数
const sseLog = (message, ...args) => {
    if (isDevelopment) {
        console.log(`[SSE] ${message}`, ...args);
    }
};

const sseWarn = (message, ...args) => {
    console.warn(`[SSE] ${message}`, ...args);
};

const sseError = (message, ...args) => {
    console.error(`[SSE] ${message}`, ...args);
};

/**
 * 建立到后端的 SSE 连接，包含自动重连和认证逻辑
 */
function connect() {
    if (eventSource) {
        eventSource.close();
    }

    const token = getAuthToken();
    // 不再通过查询参数传递 token；SSE 统一使用无认证公共流或由反代注入 Cookie/头部
    const url = '/api/events';

    // 标准 EventSource 不支持自定义头；若需要受保护 SSE，应改用 fetch+ReadableStream 或 polyfill
    eventSource = new EventSource(url);

    eventSource.onopen = () => {
        retryCount = 0;
        sseLog('连接已建立');
    };

    eventSource.onerror = (err) => {
        sseError('连接错误:', err);
        eventSource.close();
        const delay = Math.min(MAX_RETRY_DELAY, 1000 * Math.pow(2, retryCount));
        retryCount++;
        // console.debug(`[SSE] Connection lost. Retrying in ${delay / 1000} seconds...`);
        setTimeout(connect, delay);
    };

    eventSource.addEventListener('connected', (e) => {
        const data = JSON.parse(e.data);
    });

    eventSource.addEventListener('thumbnail-generated', (e) => {
        try {
            const data = JSON.parse(e.data);
            if (!data || !data.path) return;

            const imagePath = data.path;
            sseLog('收到缩略图生成事件:', imagePath);

            // 修复：使用更精确的匹配方式，匹配包含该路径的缩略图URL
            const imagesToUpdate = Array.from(document.querySelectorAll('img.lazy-image')).filter(img => {
                const dataSrc = img.dataset.src;
                if (!dataSrc) return false;

                // 解析缩略图URL中的path参数
                const url = new URL(dataSrc, window.location.origin);
                const pathParam = url.searchParams.get('path');

                // 解码URL编码的路径参数
                const decodedPathParam = decodeURIComponent(pathParam);

                // 如果path参数存在且与事件路径匹配，则更新
                const matches = decodedPathParam === imagePath;
                return matches;
            });

            // 只在找到匹配时才输出日志
            if (imagesToUpdate.length > 0) {
                sseLog('找到匹配的图片数量:', imagesToUpdate.length);
            }

            if (imagesToUpdate.length > 0) {
                imagesToUpdate.forEach(img => {
                    // 无论是否已加载，都强制刷新图片
                    // 清除处理/失败状态，强制重新请求
                    img.dataset.thumbStatus = '';
                    img.classList.remove('processing', 'error', 'loaded');
                    img.classList.add('opacity-0'); // 先隐藏图片

                    // 强制刷新：更新URL的版本参数
                    const thumbnailUrl = img.dataset.src;
                    const url = new URL(thumbnailUrl, window.location.origin);
                    const pathParam = url.searchParams.get('path');

                    // 解码URL编码的路径参数
                    const decodedPathParam = decodeURIComponent(pathParam);

                    // 生成新的缩略图URL，强制绕过缓存
                    const freshThumbnailUrl = `/api/thumbnail?path=${encodeURIComponent(decodedPathParam)}&v=${Date.now()}`;

                    const token = getAuthToken();
                    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

                    fetch(freshThumbnailUrl, {
                        headers,
                        cache: 'no-cache'  // 强制不使用缓存
                    })
                        .then(response => {
                            if (response.ok) return response.blob();
                            throw new Error(`Failed to fetch thumbnail via SSE event: ${response.status}`);
                        })
                        .then(blob => {
                            // 清理旧的blob URL
                            try {
                                if (img.src && img.src.startsWith('blob:')) {
                                    URL.revokeObjectURL(img.src);
                                }
                            } catch {}

                            // 创建新的blob URL并设置
                            const newBlobUrl = URL.createObjectURL(blob);
                            img.src = newBlobUrl;

                            // 同时更新data-src属性，确保下次加载使用最新版本
                            img.dataset.src = freshThumbnailUrl;

                            // 立即显示图片，不要依赖onload事件（会被lazyload.js覆盖）
                            img.classList.remove('opacity-0');
                            img.classList.add('loaded');

                            // 清理可能被lazyload.js覆盖的事件监听器
                            setTimeout(() => {
                                if (img.onload) {
                                    img.onload = null;
                                }

                                // 触发masonry更新，确保布局正确
                                try {
                                    triggerMasonryUpdate();
                                } catch (e) {
                                    // 静默失败
                                }
                            }, 100);
                        })
                        .catch(error => {
                            sseWarn('Failed to refresh thumbnail after generation:', error);
                            img.classList.remove('opacity-0');
                            // 如果失败，触发错误处理
                            img.dispatchEvent(new Event('error'));
                        });
                });
            }
        } catch (error) {
            sseError('Error processing thumbnail-generated event:', error);
        }
    });
}

/**
 * 初始化 SSE 服务
 */
export function initializeSSE() {
    connect();
}
