// frontend/js/api-client.js
// 统一API客户端 - 内置错误处理和重试策略

import { NETWORK } from './constants.js';
import { getAuthToken, setAuthToken } from './auth.js';

/**
 * API错误类型枚举
 */
export const APIErrorTypes = {
    NETWORK: 'NETWORK_ERROR',
    TIMEOUT: 'TIMEOUT_ERROR',
    AUTHENTICATION: 'AUTHENTICATION_ERROR',
    PERMISSION: 'PERMISSION_ERROR',
    SERVER: 'SERVER_ERROR',
    RATE_LIMIT: 'RATE_LIMIT_ERROR',
    VALIDATION: 'VALIDATION_ERROR',
    NOT_FOUND: 'NOT_FOUND_ERROR',
    UNKNOWN: 'UNKNOWN_ERROR'
};

/**
 * 创建标准化API错误对象
 * @param {string} type - 错误类型
 * @param {string} message - 错误消息
 * @param {number} status - HTTP状态码
 * @param {object} context - 额外上下文信息
 * @returns {Error} 标准化错误对象
 */
function createAPIError(type, message, status = 0, context = {}) {
    const error = new Error(message);
    error.type = type;
    error.status = status;
    error.context = context;
    error.timestamp = Date.now();
    return error;
}

/**
 * 获取认证请求头
 * @returns {object} 请求头对象
 */
function getAuthHeaders() {
    const headers = {
        'Content-Type': 'application/json'
    };
    const token = getAuthToken();
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

/**
 * 指数退避重试延迟计算
 * @param {number} attempt - 当前重试次数
 * @param {number} baseDelay - 基础延迟
 * @returns {number} 延迟时间(ms)
 */
function calculateRetryDelay(attempt, baseDelay = NETWORK.RETRY_BASE_DELAY) {
    return Math.min(baseDelay * Math.pow(2, attempt), 30000); // 最大30秒
}

/**
 * 判断是否应该重试错误
 * @param {Error} error - 错误对象
 * @param {number} attempt - 当前重试次数
 * @param {number} maxRetries - 最大重试次数
 * @returns {boolean} 是否应该重试
 */
function shouldRetry(error, attempt, maxRetries) {
    if (attempt >= maxRetries) return false;

    // 网络错误总是重试
    if (error.name === 'TypeError' || error.message.includes('fetch')) {
        return true;
    }

    // HTTP状态码重试策略
    const retryableStatuses = [408, 429, 500, 502, 503, 504]; // 请求超时、限流、服务器错误
    if (error.status && retryableStatuses.includes(error.status)) {
        return true;
    }

    // 认证错误不重试（会通过其他机制处理）
    if (error.status === 401) {
        return false;
    }

    return false;
}

/**
 * 尝试刷新认证令牌
 * @returns {Promise<boolean>} 是否刷新成功
 */
async function tryRefreshToken() {
    try {
        const token = getAuthToken();
        if (!token) return false;

        const response = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
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
 * 解析HTTP响应错误
 * @param {Response} response - HTTP响应对象
 * @returns {Promise<Error>} 解析后的错误对象
 */
async function parseResponseError(response) {
    let message = `HTTP ${response.status}`;
    let type = APIErrorTypes.UNKNOWN;

    try {
        const errorData = await response.clone().json();
        message = errorData?.error || errorData?.message || message;
    } catch {
        try {
            const textResponse = await response.clone().text();
            if (textResponse) {
                message = `HTTP ${response.status}: ${textResponse.substring(0, 100)}`;
            }
        } catch {}
    }

    // 根据状态码确定错误类型
    switch (response.status) {
        case 400:
            type = APIErrorTypes.VALIDATION;
            break;
        case 401:
            type = APIErrorTypes.AUTHENTICATION;
            break;
        case 403:
            type = APIErrorTypes.PERMISSION;
            break;
        case 404:
            type = APIErrorTypes.NOT_FOUND;
            break;
        case 429:
            type = APIErrorTypes.RATE_LIMIT;
            break;
        case 408:
        case 504:
            type = APIErrorTypes.TIMEOUT;
            break;
        case 500:
        case 502:
        case 503:
            type = APIErrorTypes.SERVER;
            break;
        default:
            type = APIErrorTypes.UNKNOWN;
    }

    return createAPIError(type, message, response.status);
}

/**
 * 执行带重试的HTTP请求
 * @param {string} url - 请求URL
 * @param {object} options - 请求选项
 * @param {object} policy - 重试策略
 * @returns {Promise<Response>} HTTP响应
 */
async function executeWithRetry(url, options, policy = {}) {
    const {
        maxRetries = NETWORK.MAX_RETRY_ATTEMPTS,
        timeout = NETWORK.DEFAULT_TIMEOUT,
        retryDelay = NETWORK.DEFAULT_RETRY_DELAY
    } = policy;

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // 设置超时控制器
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            // 处理HTTP错误状态
            if (!response.ok) {
                const error = await parseResponseError(response);

                // 401错误：尝试刷新令牌
                if (response.status === 401 && attempt === 0) {
                    const refreshed = await tryRefreshToken();
                    if (refreshed) {
                        // 刷新成功，重新尝试请求（更新认证头）
                        const newOptions = {
                            ...options,
                            headers: {
                                ...options.headers,
                                ...getAuthHeaders()
                            }
                        };
                        continue;
                    }
                }

                // 检查是否应该重试
                if (shouldRetry(error, attempt, maxRetries)) {
                    lastError = error;
                    const delay = calculateRetryDelay(attempt, retryDelay);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }

                throw error;
            }

            return response;

        } catch (error) {
            lastError = error;

            // AbortError（超时）转换为超时错误
            if (error.name === 'AbortError') {
                const timeoutError = createAPIError(
                    APIErrorTypes.TIMEOUT,
                    `请求超时 (${timeout}ms)`,
                    0,
                    { url, originalError: error }
                );
                if (shouldRetry(timeoutError, attempt, maxRetries)) {
                    const delay = calculateRetryDelay(attempt, retryDelay);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                throw timeoutError;
            }

            // 网络错误
            if (error.name === 'TypeError' || error.message.includes('fetch')) {
                const networkError = createAPIError(
                    APIErrorTypes.NETWORK,
                    '网络连接失败',
                    0,
                    { url, originalError: error }
                );
                if (shouldRetry(networkError, attempt, maxRetries)) {
                    const delay = calculateRetryDelay(attempt, retryDelay);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                throw networkError;
            }

            // 其他错误直接抛出
            throw error;
        }
    }

    throw lastError;
}

/**
 * 统一的GET JSON请求方法
 * @param {string} endpoint - API端点
 * @param {object} options - 请求选项
 * @returns {Promise<object>} 解析后的JSON数据
 */
export async function apiGet(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `/api${endpoint}`;
    const headers = {
        ...getAuthHeaders(),
        ...options.headers
    };

    const response = await executeWithRetry(url, {
        method: 'GET',
        headers,
        ...options
    }, options.policy);

    return response.json();
}

/**
 * 统一的POST JSON请求方法
 * @param {string} endpoint - API端点
 * @param {object} data - 请求数据
 * @param {object} options - 请求选项
 * @returns {Promise<object>} 响应数据
 */
export async function apiPost(endpoint, data, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `/api${endpoint}`;
    const headers = {
        ...getAuthHeaders(),
        ...options.headers
    };

    const response = await executeWithRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
        ...options
    }, options.policy);

    return response.json();
}

/**
 * 统一的PUT JSON请求方法
 * @param {string} endpoint - API端点
 * @param {object} data - 请求数据
 * @param {object} options - 请求选项
 * @returns {Promise<object>} 响应数据
 */
export async function apiPut(endpoint, data, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `/api${endpoint}`;
    const headers = {
        ...getAuthHeaders(),
        ...options.headers
    };

    const response = await executeWithRetry(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify(data),
        ...options
    }, options.policy);

    return response.json();
}

/**
 * 统一的DELETE请求方法
 * @param {string} endpoint - API端点
 * @param {object} options - 请求选项
 * @returns {Promise<object>} 响应数据
 */
export async function apiDelete(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `/api${endpoint}`;
    const headers = {
        ...getAuthHeaders(),
        ...options.headers
    };

    const response = await executeWithRetry(url, {
        method: 'DELETE',
        headers,
        ...options
    }, options.policy);

    return response.json();
}

/**
 * 获取当前认证状态
 * @returns {Promise<object>} 认证状态
 */
export async function getAuthStatus() {
    try {
        return await apiGet('/auth/status');
    } catch (error) {
        if (error.type === APIErrorTypes.AUTHENTICATION) {
            // 认证失败，返回未登录状态
            return { authenticated: false };
        }
        throw error;
    }
}

/**
 * 创建请求策略构建器
 * @param {object} config - 策略配置
 * @returns {object} 请求策略
 */
export function createRequestPolicy(config = {}) {
    return {
        maxRetries: config.maxRetries || NETWORK.MAX_RETRY_ATTEMPTS,
        timeout: config.timeout || NETWORK.DEFAULT_TIMEOUT,
        retryDelay: config.retryDelay || NETWORK.DEFAULT_RETRY_DELAY,
        ...config
    };
}

// 导出便捷的策略预设
export const RequestPolicies = {
    // 快速请求：低重试次数，短超时
    FAST: createRequestPolicy({
        maxRetries: 1,
        timeout: 5000,
        retryDelay: 500
    }),

    // 标准请求：平衡的重试和超时
    STANDARD: createRequestPolicy(),

    // 可靠请求：高重试次数，长超时
    RELIABLE: createRequestPolicy({
        maxRetries: 5,
        timeout: 15000,
        retryDelay: 2000
    }),

    // 实时请求：无重试，短超时
    REALTIME: createRequestPolicy({
        maxRetries: 0,
        timeout: 3000
    })
};
