/**
 * @file shared.js
 * @description
 *   API 共享工具模块，提供日志、认证头构建、去重请求、错误处理、刷新令牌等能力。
 */

import { CACHE, isDevelopment } from '../core/constants.js';
import { showNotification } from '../shared/utils.js';
import { getAuthToken, removeAuthToken, setAuthToken } from '../app/auth.js';
import { createModuleLogger } from '../core/logger.js';
import { executeAsync, ErrorTypes, ErrorSeverity } from '../core/error-handler.js';
import { applyAdminSecretHeader } from '../shared/admin-secret.js';

/**
 * API 模块级日志记录器
 * @type {object}
 */
export const apiLogger = createModuleLogger('API');

/**
 * 并发去重中的 in-flight 请求缓存
 * @type {Map}
 */
const inFlightRequests = new Map();

/**
 * 最近窗口命中缓存（短时返回相同结果，降低抖动）
 * @type {Map}
 */
const recentWindow = new Map();

/**
 * 去重命中统计，仅开发环境输出
 * @type {object}
 * @property {number} totalRequests 总请求数
 * @property {number} cacheHits 缓存命中数
 */
const dedupStats = {
    totalRequests: 0,
    cacheHits: 0
};

/**
 * 限流触发登录事件，避免短时间内多次弹出
 * @type {number}
 */
let lastAuthRequiredAt = 0;

/**
 * 构建请求去重键（方法+URL+Body）
 * @param {string} url 请求 URL
 * @param {object} [options={}] 请求选项
 * @returns {string} 请求键
 */
function buildRequestKey(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    let bodyKey = '';
    if (options.body) {
        try {
            bodyKey = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        } catch {
            bodyKey = '[unstringifiable]';
        }
    }
    return `${method} ${url} ${bodyKey}`;
}

/**
 * 获取去重时间窗口（支持运行时覆盖）
 * @returns {number} 去重时间窗口（毫秒）
 */
function getDedupWindowMs() {
    if (window.__APP_SETTINGS?.apiDedupWindowMs !== undefined) {
        return window.__APP_SETTINGS.apiDedupWindowMs;
    }
    return CACHE.DEDUP_WINDOW_MS;
}

/**
 * 记录并周期性输出去重统计
 * @param {boolean} hit 是否命中缓存
 */
function recordDedupStats(hit) {
    if (!isDevelopment()) return;
    dedupStats.totalRequests++;
    if (hit) dedupStats.cacheHits++;
    if (dedupStats.totalRequests % 100 === 0) {
        const hitRate = dedupStats.totalRequests === 0
            ? 0
            : ((dedupStats.cacheHits / dedupStats.totalRequests) * 100).toFixed(1);
        apiLogger.debug('API 去重统计', {
            totalRequests: dedupStats.totalRequests,
            cacheHits: dedupStats.cacheHits,
            hitRate: `${hitRate}%`
        });
    }
}

/**
 * 包装 fetch，带重试与统一日志
 * @param {string} url 请求 URL
 * @param {object} options 请求选项
 * @param {number} [retries=3] 重试次数
 * @param {number} [delay=1000] 重试延迟（毫秒）
 * @returns {Promise<Response>} fetch 响应
 */
async function fetchWithRetry(url, options, retries = 3, delay = 1000) {
    return executeAsync(
        async () => {
            const response = await fetch(url, options);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return response;
        },
        {
            maxRetries: retries,
            retryDelay: delay,
            context: { url, method: options.method || 'GET' },
            errorType: ErrorTypes.NETWORK,
            errorSeverity: ErrorSeverity.MEDIUM,
            onError: (error, ctx) => {
                apiLogger.warn(`网络请求失败 (尝试 ${ctx.attempt})`, {
                    url,
                    error: error.message,
                    attempt: ctx.attempt
                });
            },
            onRetry: (error, ctx) => {
                apiLogger.info(`重试网络请求 (${ctx.attempt}/${retries + 1})`, {
                    url,
                    delay: ctx.delay
                });
            }
        }
    );
}

/**
 * GET/HEAD 请求的 JSON 去重封装；其他方法直接请求
 * @param {string} url 请求 URL
 * @param {object} [options={}] 请求选项
 * @param {number} [retries=3] 重试次数
 * @param {number} [delay=1000] 重试延迟（毫秒）
 * @returns {Promise<object>} 解析后的 JSON 数据
 */
export async function requestJSONWithDedup(url, options = {}, retries = 3, delay = 1000) {
    const method = (options.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
        const response = await fetchWithRetry(url, options, retries, delay);
        if (!response.ok) {
            let message = `HTTP ${response.status}`;
            try {
                const errData = await response.clone().json();
                message = errData?.error || errData?.message || message;
            } catch {
                try {
                    const text = await response.clone().text();
                    if (text) message = `${message}: ${text.substring(0, 100)}`;
                } catch {}
            }
            const error = new Error(message);
            error.status = response.status;
            throw error;
        }
        return response.json();
    }

    const key = buildRequestKey(url, options);
    const now = Date.now();
    const dedupWindow = getDedupWindowMs();
    const recent = recentWindow.get(key);

    if (recent && now - recent.time < dedupWindow && recent.promise) {
        recordDedupStats(true);
        return recent.promise;
    }

    if (inFlightRequests.has(key)) {
        recordDedupStats(true);
        return inFlightRequests.get(key);
    }

    recordDedupStats(false);

    const requestPromise = (async () => {
        try {
            const response = await fetchWithRetry(url, options, retries, delay);
            if (!response.ok) {
                let message = `HTTP ${response.status}`;
                try {
                    const errData = await response.clone().json();
                    message = errData?.error || errData?.message || message;
                } catch {
                    try {
                        const text = await response.clone().text();
                        if (text) message = `${message}: ${text.substring(0, 100)}`;
                    } catch {}
                }
                const error = new Error(message);
                error.status = response.status;
                throw error;
            }
            return await response.json();
        } catch (error) {
            // 特殊处理 AbortError，避免在控制台显示过多的中止错误
            if (error.name === 'AbortError') {
                apiLogger.debug('请求被中止', { url, method: options.method || 'GET' });
                throw error;
            }
            throw error;
        } finally {
            inFlightRequests.delete(key);
            recentWindow.set(key, { time: Date.now(), promise: null });
            setTimeout(() => recentWindow.delete(key), dedupWindow);
        }
    })();

    inFlightRequests.set(key, requestPromise);
    recentWindow.set(key, { time: now, promise: requestPromise });
    return requestPromise;
}

/**
 * 通用去重+重试请求（不解析 JSON）
 * @param {string} url 请求 URL
 * @param {object} [options={}] 请求选项
 * @param {number} [retries=3] 重试次数
 * @param {number} [delay=1000] 重试延迟（毫秒）
 * @returns {Promise<Response>} fetch 响应
 */
export async function requestWithDedup(url, options = {}, retries = 3, delay = 1000) {
    return fetchWithRetry(url, options, retries, delay);
}

/**
 * 构建带认证的通用请求头
 * @returns {object} 请求头对象
 */
export function getAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

/**
 * 构建带管理员密钥的请求头（优先使用 Header 传递密钥）
 * @param {string|null} adminSecret 管理员密钥
 * @returns {object|Headers} 请求头对象
 */
export function buildAdminHeaders(adminSecret = null) {
    const headers = getAuthHeaders();
    applyAdminSecretHeader(headers, adminSecret);
    return headers;
}

/**
 * 兼容旧实现：当前认证缓存由 api-client 统一维护
 */
export function clearAuthHeadersCache() {
    // 兼容旧实现，当前由 api-client 处理认证缓存
}

/**
 * 刷新认证令牌（若存在），返回是否成功
 * @returns {Promise<boolean>} 是否刷新成功
 */
export async function refreshAuthToken() {
    try {
        const token = getAuthToken();
        if (!token) return false;

        const response = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        });

        if (!response.ok) return false;

        const data = await response.json().catch(() => null);
        if (data && data.success && data.token) {
            setAuthToken(data.token);
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * 触发需要认证事件，供全局监听跳转登录
 */
export function triggerAuthRequired() {
    try {
        const now = Date.now();
        if (now - lastAuthRequiredAt < 2000) return;
        lastAuthRequiredAt = now;
        removeAuthToken();
        clearAuthHeadersCache();
        window.dispatchEvent(new CustomEvent('auth:required'));
    } catch {}
}

/**
 * 统一 API 错误处理并提示
 * @param {Error|Response} error 错误对象或响应
 * @param {string} context 上下文信息
 */
export function handleAPIError(error, context) {
    if (error instanceof Response) {
        switch (error.status) {
            case 401:
                triggerAuthRequired();
                showNotification('认证已过期，请重新登录', 'warning');
                break;
            case 403:
                showNotification('您没有执行此操作的权限', 'warning');
                break;
            case 404:
                showNotification('请求的资源不存在', 'warning');
                break;
            case 429:
                showNotification('请求过于频繁，请稍后重试', 'warning');
                break;
            case 500:
                showNotification('服务器异常，请稍后重试', 'error');
                break;
            default:
                showNotification(`请求失败：${error.status}`, 'error');
        }
    } else {
        apiLogger.error(`API错误 (${context})`, { error: error.message });
        showNotification(`操作失败：${error.message}`, 'error');
    }
}

/**
 * 获取认证令牌
 * @returns {string|null} 认证令牌或null
 */
export { getAuthToken };
