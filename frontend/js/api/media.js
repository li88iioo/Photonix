/**
 * @file media.js
 * @description
 *   媒体相关 API，包括搜索、浏览、埋点与随机缩略图等功能。
 */

import { apiLogger, getAuthHeaders, requestJSONWithDedup, refreshAuthToken, triggerAuthRequired } from './shared.js';
import { getAuthToken } from '../app/auth.js';

/**
 * 从 URL hash 中解析排序参数（默认 smart）
 * @returns {string} 排序参数
 */
function getSortParamFromHash() {
    const hash = window.location.hash;
    const questionMarkIndex = hash.indexOf('?');
    const params = new URLSearchParams(questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '');
    return params.get('sort') || 'smart';
}

/**
 * 搜索接口
 * - 支持 503/504 重试
 * - 支持 401 自动刷新认证
 * @param {string} query 搜索查询
 * @param {number} page 页码
 * @param {AbortSignal} signal 中止信号
 * @returns {Promise<object>} 搜索结果对象
 *   - query {string} 查询字符串
 *   - results {Array} 结果列表
 *   - totalPages {number} 总页数
 *   - totalResults {number} 总结果数
 * @throws {Error} 网络或认证等错误
 */
export async function fetchSearchResults(query, page, signal) {
    try {
        if (typeof query !== 'string' || query.trim() === '') {
            return { query: '', results: [], totalPages: 0, totalResults: 0 };
        }

        const url = `/api/search?q=${encodeURIComponent(query)}&page=${page}&limit=50`;
        const performRequest = () => requestJSONWithDedup(url, {
            method: 'GET',
            headers: getAuthHeaders(),
            signal
        });

        try {
            return await performRequest();
        } catch (error) {
            if (error.status === 503 || error.status === 504) {
                // 503/504 重试机制
                const delays = [5000, 10000, 20000];
                for (const delay of delays) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    if (signal?.aborted) break;
                    try {
                        return await performRequest();
                    } catch (retryError) {
                        if (!(retryError.status === 503 || retryError.status === 504)) throw retryError;
                    }
                }
            } else if (error.status === 401) {
                // 401 自动刷新认证
                const refreshed = await refreshAuthToken();
                if (refreshed) {
                    return await performRequest();
                }
                triggerAuthRequired();
                const authError = new Error('UNAUTHORIZED');
                authError.code = 'UNAUTHORIZED';
                authError.silent = true;
                throw authError;
            } else {
                throw error;
            }
        }
    } catch (error) {
        if (error.name !== 'AbortError' && error.code !== 'UNAUTHORIZED') {
            apiLogger.warn('获取搜索结果失败', { query, page, error: error.message });
        }
        throw error;
    }
}

/**
 * 浏览接口
 * - 根目录允许无 token 访问
 * - 支持 503/504 重试
 * - 支持 401 自动刷新认证
 * @param {string} path 浏览路径
 * @param {number} page 页码
 * @param {AbortSignal} signal 中止信号
 * @returns {Promise<object|null>} 浏览结果对象，失败时返回 null
 * @throws {Error} 网络或认证等错误
 */
export async function fetchBrowseResults(path, page, signal) {
    try {
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        const headers = getAuthHeaders();
        if (path === '' && !getAuthToken()) {
            delete headers.Authorization;
        }

        const sort = getSortParamFromHash();
        const url = `/api/browse/${encodedPath}?page=${page}&limit=50&sort=${sort}`;
        const performRequest = () => requestJSONWithDedup(url, {
            method: 'GET',
            headers,
            signal
        });

        try {
            return await performRequest();
        } catch (error) {
            if (signal?.aborted) return null;
            if (error.status === 503 || error.status === 504) {
                // 503/504 重试机制
                const delays = [5000, 10000, 20000];
                for (const delay of delays) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    if (signal?.aborted) return null;
                    try {
                        return await performRequest();
                    } catch (retryError) {
                        if (!(retryError.status === 503 || retryError.status === 504)) throw retryError;
                    }
                }
            } else if (error.status === 401 && path !== '') {
                // 401 自动刷新认证
                const refreshed = await refreshAuthToken();
                if (refreshed) {
                    return await performRequest();
                }
                triggerAuthRequired();
                const authError = new Error('UNAUTHORIZED');
                authError.code = 'UNAUTHORIZED';
                authError.silent = true;
                throw authError;
            } else {
                throw error;
            }
        }
    } catch (error) {
        if (error.name !== 'AbortError' && error.code !== 'UNAUTHORIZED') {
            apiLogger.warn('获取浏览结果失败', { path, page, error: error.message });
        }
        throw error;
    }
}

/**
 * 浏览埋点
 * - 发送浏览记录，短超时
 * - 失败时静默重试
 * @param {string} path 浏览路径
 * @returns {void}
 */
export function postViewed(path) {
    if (!path) return;

    const token = getAuthToken();
    if (!token) return;

    /**
     * 内部重试请求
     * @param {number} retries 重试次数
     * @returns {Promise<void>}
     */
    const makeRobustRequest = async (retries = 1) => {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000);

                const response = await fetch('/api/browse/viewed', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ path }),
                    keepalive: true,
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (response.ok || response.status === 204) {
                    return;
                }

                if (response.status !== 503 && response.status !== 0) {
                    return;
                }
            } catch (error) {
                if (attempt < retries) {
                    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
                } else {
                    apiLogger.debug('更新浏览时间失败', { error: error.message });
                }
            }
        }
    };

    makeRobustRequest().catch(error => {
        apiLogger.warn('更新浏览时间失败', error);
    });
}

/**
 * 获取随机缩略图
 * - 复用浏览结果中的首个媒体项
 * @returns {Promise<string|null>} 缩略图 URL，失败时为 null
 */
export async function fetchRandomThumbnail() {
    try {
        const data = await fetchBrowseResults('', 1, new AbortController().signal);
        const media = data?.items?.find(item => item.type === 'photo' || item.type === 'video');
        return media ? media.data.thumbnailUrl : null;
    } catch (error) {
        apiLogger.error('无法获取随机缩略图', error);
        return null;
    }
}

/**
 * 删除相册
 * @param {string} path 相册路径
 * @returns {Promise<object>} 删除结果对象
 * @throws {Error} 删除失败时抛出错误
 */
export async function deleteAlbum(path) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`/api/albums/${encodedPath}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result?.message || result?.error || '删除相册失败');
    }
    return result;
}
