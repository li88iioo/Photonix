// 媒体相关 API：搜索、浏览、埋点与随机缩略图
import { apiLogger, getAuthHeaders, requestJSONWithDedup, refreshAuthToken, triggerAuthRequired } from './shared.js';
import { getAuthToken } from '../auth.js';

// 从 URL hash 中解析排序参数（默认 smart）
function getSortParamFromHash() {
    const hash = window.location.hash;
    const questionMarkIndex = hash.indexOf('?');
    const params = new URLSearchParams(questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '');
    return params.get('sort') || 'smart';
}

// 搜索接口：带 503/504 重试与 401 刷新认证
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

// 浏览接口：根目录允许无 token 访问；带重试与 401 刷新
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

// 浏览埋点：短超时+失败静默重试
export function postViewed(path) {
    if (!path) return;

    const token = getAuthToken();
    if (!token) return;

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

// 获取随机缩略图：复用浏览结果中的首个媒体项
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
