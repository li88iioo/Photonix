// frontend/js/api.js

import { state, elements } from './state.js';
import { AbortBus } from './abort-bus.js';
import { showNotification } from './utils.js';
import { getAuthToken, removeAuthToken, setAuthToken } from './auth.js';

/**
 * API 请求与数据交互模块
 * 负责与后端进行所有数据交互，包括设置、搜索、浏览、AI等
 */

/**
 * 通用fetch重试工具
 * 支持服务器错误/限流时自动重试
 * @param {string} url - 请求URL
 * @param {object} options - fetch选项
 * @param {number} retries - 最大重试次数
 * @param {number} delay - 重试延迟（毫秒）
 * @returns {Promise<Response>} fetch响应
 */
async function fetchWithRetry(url, options, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if ((response.status >= 500 || response.status === 429) && i < retries - 1) {
                let retryDelay = delay * (i + 1);
                if (response.status === 429) {
                    const retryAfter = response.headers.get('Retry-After');
                    if (retryAfter) {
                        const after = Number(retryAfter);
                        if (!isNaN(after)) {
                            retryDelay = after * 1000;
                        } else {
                            const date = new Date(retryAfter);
                            if (!isNaN(date.getTime())) {
                                retryDelay = date.getTime() - Date.now();
                            }
                        }
                    }
                    console.warn(`429 Too Many Requests. Retrying in ${retryDelay}ms...`);
                } else {
                    console.warn(`Server error (${response.status}). Retrying in ${retryDelay}ms...`);
                }
                await new Promise(res => setTimeout(res, Math.max(retryDelay, 0)));
                continue;
            }
            return response;
        } catch (error) {
            if (i < retries - 1) {
                console.warn(`Fetch failed (network error). Retrying in ${delay * (i + 1)}ms...`);
                await new Promise(res => setTimeout(res, delay * (i + 1)));
                continue;
            }
            throw error;
        }
    }
}

// --- 全局 401 处理：触发登录界面 ---
let lastAuthRequiredAt = 0;
function triggerAuthRequired() {
    try {
        const now = Date.now();
        // 去抖：2 秒内最多触发一次
        if (now - lastAuthRequiredAt < 2000) return;
        lastAuthRequiredAt = now;
        removeAuthToken();
        clearAuthHeadersCache();
        window.dispatchEvent(new CustomEvent('auth:required'));
    } catch {}
}

// 缓存认证头以提高性能
let cachedAuthHeaders = null;
let lastTokenCheck = 0;
const TOKEN_CACHE_DURATION = 5000; // 5秒缓存

/**
 * 获取认证请求头（带缓存优化）
 * 自动附加token和用户ID
 * @returns {object} 请求头对象
 */
function getAuthHeaders() {
    const now = Date.now();
    
    // 如果缓存有效且未过期，直接返回缓存
    if (cachedAuthHeaders && (now - lastTokenCheck) < TOKEN_CACHE_DURATION) {
        return { ...cachedAuthHeaders };
    }
    
    // 重新构建认证头
    const token = getAuthToken();
    const headers = {
        'Content-Type': 'application/json',
        'X-User-ID': state.userId
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    
    // 更新缓存
    cachedAuthHeaders = headers;
    lastTokenCheck = now;
    
    return { ...headers };
}

// 简易滑动续期：在接口 401 或即将过期时刷新 Token
async function tryRefreshToken() {
    try {
        const token = getAuthToken();
        if (!token) return false;
        const res = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) return false;
        const data = await res.json().catch(()=>null);
        if (data && data.success && data.token) {
            setAuthToken(data.token);
            clearAuthHeadersCache();
            return true;
        }
        return false;
    } catch { return false; }
}

/**
 * 清除认证头缓存（在token变更时调用）
 */
export function clearAuthHeadersCache() {
    cachedAuthHeaders = null;
    lastTokenCheck = 0;
}

// --- 设置相关API ---
/**
 * 获取全局设置
 * @returns {Promise<object>} 设置对象
 */
export async function fetchSettings() {
    const headers = getAuthHeaders();
    // For initial setup, we might not have a token
    if (!getAuthToken()) {
        delete headers.Authorization;
    }
    
    // 添加超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 增加超时时间到15秒
    
    try {
        const response = await fetch(`/api/settings?_=${Date.now()}`, { 
            headers,
            cache: 'no-store',
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            if (response.status === 401) {
                // 避免未登录场景下陷入刷新循环：清理本地 token，返回客户端默认设置
                removeAuthToken();
                return {
                    AI_ENABLED: 'false',
                    PASSWORD_ENABLED: 'false',
                    ALLOW_PUBLIC_ACCESS: 'true'
                };
            }
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || '无法获取设置');
        }
        return await response.json();
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            console.warn('获取设置超时，使用默认设置');
            return {
                AI_ENABLED: 'false',
                PASSWORD_ENABLED: 'false',
                ALLOW_PUBLIC_ACCESS: 'true'
            };
        }
        throw error;
    }
}

/**
 * 保存全局设置
 * @param {object} settingsData - 设置数据
 * @returns {Promise<object>} 保存结果
 */
export async function saveSettings(settingsData) {
    const headers = getAuthHeaders();
    // For initial setup, we might not have a token
    if (!getAuthToken()) {
        delete headers.Authorization;
    }
    const response = await fetch('/api/settings', {
        method: 'POST',
        headers,
        cache: 'no-store',
        body: JSON.stringify(settingsData)
    });

    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || '保存设置失败');
    }
    return result;
}
// --- END 设置API ---

/**
 * 查询设置更新任务状态
 * @param {string} updateId
 * @returns {Promise<{status:string, updatedKeys?:string[], message?:string}>}
 */
export async function fetchSettingsUpdateStatus(updateId) {
    const headers = getAuthHeaders();
    const res = await fetch(`/api/settings/status?id=${encodeURIComponent(updateId)}`, {
        method: 'GET', headers, cache: 'no-store'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '无法获取设置更新状态');
    return data;
}

/**
 * 轮询等待设置更新完成
 * @param {string} updateId
 * @param {{intervalMs?:number, timeoutMs?:number}} options
 * @returns {Promise<{final:string, info?:object}>} final: success|failed|timeout
 */
export async function waitForSettingsUpdate(updateId, { intervalMs = 1000, timeoutMs = 30000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const st = await fetchSettingsUpdateStatus(updateId);
            if (st && (st.status === 'success' || st.status === 'failed')) {
                return { final: st.status, info: st };
            }
        } catch (e) {
            return { final: 'error', info: { message: e && e.message ? e.message : '未知错误' } };
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return { final: 'timeout' };
}

// --- 搜索API ---
/**
 * 获取搜索结果
 * @param {string} query - 搜索关键词
 * @param {number} page - 页码
 * @param {AbortSignal} signal - 中止信号
 * @returns {Promise<object>} 搜索结果
 */
export async function fetchSearchResults(query, page, signal) {
    try {
        // 空查询直接短路，避免无效请求
        if (typeof query !== 'string' || query.trim() === '') {
            return { query: '', results: [], totalPages: 0, totalResults: 0 };
        }
        let response = await fetch(`/api/search?q=${encodeURIComponent(query)}&page=${page}&limit=50`, {
            method: 'GET',
            headers: getAuthHeaders(),
            signal
        });
        // 对 503/504 做指数退避重试
        if ((response.status === 503 || response.status === 504) && !signal.aborted) {
            const delays = [5000, 10000, 20000];
            for (const d of delays) {
                await new Promise(r => setTimeout(r, d));
                if (signal.aborted) break;
                response = await fetch(`/api/search?q=${encodeURIComponent(query)}&page=${page}&limit=50`, {
                    method: 'GET', headers: getAuthHeaders(), signal
                });
                if (response.ok || (response.status !== 503 && response.status !== 504)) break;
            }
        }
        if (response.status === 401) {
            const refreshed = await tryRefreshToken();
            if (refreshed) {
                response = await fetch(`/api/search?q=${encodeURIComponent(query)}&page=${page}&limit=50`, {
                    method: 'GET', headers: getAuthHeaders(), signal
                });
            } else {
                triggerAuthRequired();
                const e = new Error('UNAUTHORIZED');
                e.code = 'UNAUTHORIZED';
                e.silent = true;
                throw e;
            }
        }
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const msg = errorData.error || (response.status === 0 ? '网络请求失败' : `搜索失败: ${response.status}`);
            throw new Error(msg);
        }
        
        const data = await response.json();
        
        // 确保返回的数据结构完整
        if (!data || typeof data !== 'object') {
            throw new Error('搜索返回数据格式错误');
        }
        
        // 确保results是数组
        if (!Array.isArray(data.results)) {
            data.results = [];
        }
        
        return data;
    } catch (error) {
        if(error.name !== 'AbortError' && error.code !== 'UNAUTHORIZED') {
            // UI层级更高，由调用者决定如何展示错误
            // const msg = error.message === 'Failed to fetch' ? '网络请求失败，请检查连接' : error.message;
            // showNotification(`搜索失败: ${msg}`);
        }
        throw error;
    }
}

// --- 浏览API ---
/**
 * 获取浏览结果
 * @param {string} path - 路径
 * @param {number} page - 页码
 * @param {AbortSignal} signal - 中止信号
 * @returns {Promise<object>} 浏览结果
 */
export async function fetchBrowseResults(path, page, signal) {
    try {
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        const headers = getAuthHeaders();
        if(path === '' && !getAuthToken()) {
            delete headers.Authorization;
        }
        
        const hash = window.location.hash;
        const questionMarkIndex = hash.indexOf('?');
        const urlParams = new URLSearchParams(questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '');
        const sort = urlParams.get('sort') || 'smart';
        let response = await fetch(`/api/browse/${encodedPath}?page=${page}&limit=50&sort=${sort}`, {
            method: 'GET',
            headers,
            signal
        });
        // 对 503/504 做指数退避重试
        if ((response.status === 503 || response.status === 504) && !signal.aborted) {
            const delays = [5000, 10000, 20000];
            for (const d of delays) {
                await new Promise(r => setTimeout(r, d));
                if (signal.aborted) break;
                response = await fetch(`/api/browse/${encodedPath}?page=${page}&limit=50&sort=${sort}`, {
                    method: 'GET', headers, signal
                });
                if (response.ok || (response.status !== 503 && response.status !== 504)) break;
            }
        }

        if (signal.aborted) return null;
        if (response.status === 401 && path !== '') {
            const refreshed = await tryRefreshToken();
            if (refreshed) {
                response = await fetch(`/api/browse/${encodedPath}?page=${page}&limit=50&sort=${sort}`, {
                    method: 'GET', headers: getAuthHeaders(), signal
                });
            } else {
                triggerAuthRequired();
                const e = new Error('UNAUTHORIZED');
                e.code = 'UNAUTHORIZED';
                e.silent = true;
                throw e;
            }
        }
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const msg = errorData.error || (response.status === 0 ? '网络请求失败' : `服务器错误: ${response.status}`);
            throw new Error(msg);
        }
        
        const data = await response.json();
        
        // 确保返回的数据结构完整
        if (!data || typeof data !== 'object') {
            throw new Error('浏览返回数据格式错误');
        }
        
        // 确保items是数组
        if (!Array.isArray(data.items)) {
            data.items = [];
        }
        
        return data;
    } catch (error) {
        if (error.name !== 'AbortError' && error.code !== 'UNAUTHORIZED') {
            // UI层级更高，由调用者决定如何展示错误
            // const msg = error.message === 'Failed to fetch' ? '网络请求失败，请检查连接' : error.message;
            // showNotification(`加载内容失败: ${msg}`);
        }
        throw error;
    }
}

/**
 * 上报已浏览相册/图片
 * @param {string} path - 路径
 */
export function postViewed(path) {
    if (!path) return;
    
    // 内网穿透环境下的健壮请求函数
    const makeRobustRequest = async (retries = 1) => { // 减少重试次数
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000); // 减少超时时间
                
                const response = await fetch('/api/browse/viewed', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ path }),
                    keepalive: true,
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (response.ok || response.status === 204) {
                    return; // 成功，退出重试
                }
                
                // 如果不是网络错误，不重试
                if (response.status !== 503 && response.status !== 0) {
                    return; // 静默处理，减少日志
                }
                
            } catch (error) {
                // 网络错误或超时，只在最后一次重试时记录
                if (attempt < retries) {
                    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))); // 减少延迟
                } else {
                    // 只在最终失败时记录，减少日志噪音
                    console.debug('更新浏览时间失败:', error.message);
                }
            }
        }
    };
    
    // 异步执行，不阻塞UI
    makeRobustRequest().catch(error => {
        console.warn('更新浏览时间失败:', error);
    });
}

// --- 获取随机缩略图 ---
/**
 * 获取随机缩略图URL
 * @returns {Promise<string|null>} 缩略图URL
 */
export async function fetchRandomThumbnail() {
    try {
        const data = await fetchBrowseResults('', 1, new AbortController().signal);
        const media = data.items.find(item => item.type === 'photo' || item.type === 'video');
        return media ? media.data.thumbnailUrl : null;
    } catch (error) {
        console.error("无法获取随机缩略图:", error);
        return null;
    }
}

// --- AI 标题生成 ---
/**
 * 读取本地AI设置
 * @returns {object} AI设置对象
 */
function getLocalAISettings() {
    try {
        return JSON.parse(localStorage.getItem('ai_settings')) || {};
    } catch { return {}; }
}

/**
 * 生成图片AI标题
 * @param {string} imageUrl - 图片URL
 */
export async function generateImageCaption(imageUrl) {
    // 实时检查AI是否启用，而不是依赖可能过期的state
    const localAI = JSON.parse(localStorage.getItem('ai_settings') || '{}');
    const isAIEnabled = localAI.AI_ENABLED === 'true' || state.aiEnabled;
    
    if (!isAIEnabled) return; // 未启用AI时不执行任何AI相关逻辑
    
    const { captionContainer, captionContainerMobile } = elements;
        // 只有启用密码时才校验登录：仅依赖服务端同步到的全局状态，避免混杂来源
    const isPasswordEnabled = !!state.passwordEnabled;
    if (isPasswordEnabled && !getAuthToken()) {
        showNotification('需要登录才能使用 AI 功能', 'error');
        return;
    }
    const loadingHtml = '<div class="flex items-center justify-center h-full"><div class="spinner"></div><p class="ml-4">她正在酝酿情绪，请稍候...</p></div>';
    captionContainer.innerHTML = loadingHtml;
    captionContainerMobile.innerHTML = '酝酿中...';
    try {
        const url = new URL(imageUrl, window.location.origin);
        const imagePath = url.pathname.startsWith('/static/') ? decodeURIComponent(url.pathname.substring(7)) : decodeURIComponent(url.pathname);
        // 读取本地AI配置
        const aiConfig = getLocalAISettings();
        // 校验
        if (!aiConfig.AI_URL || !aiConfig.AI_KEY || !aiConfig.AI_MODEL || !aiConfig.AI_PROMPT) {
            showNotification('请先在设置中填写完整的 AI 配置信息', 'error');
            captionContainer.textContent = 'AI 配置信息不完整';
            captionContainerMobile.textContent = 'AI 配置信息不完整';
            return;
        }
        let response = await fetch('/api/ai/generate', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                image_path: imagePath,
                aiConfig: {
                    url: aiConfig.AI_URL,
                    key: aiConfig.AI_KEY,
                    model: aiConfig.AI_MODEL,
                    prompt: aiConfig.AI_PROMPT
                }
            })
        });
        if (response.status === 401) {
            const refreshed = await tryRefreshToken();
            if (refreshed) {
                response = await fetch('/api/ai/generate', {
                    method: 'POST', headers: getAuthHeaders(),
                    body: JSON.stringify({
                        image_path: imagePath,
                        aiConfig: {
                            url: aiConfig.AI_URL,
                            key: aiConfig.AI_KEY,
                            model: aiConfig.AI_MODEL,
                            prompt: aiConfig.AI_PROMPT
                        }
                    })
                });
            } else {
                triggerAuthRequired();
                const e = new Error('UNAUTHORIZED');
                e.code = 'UNAUTHORIZED';
                e.silent = true;
                throw e;
            }
        }
        const data = await response.json();
        if (response.ok && data.source === 'cache') {
            captionContainer.textContent = data.description;
            captionContainerMobile.textContent = data.description;
            return;
        }
        if (response.status === 202) {
            pollJobStatus(data.jobId);
        } else {
            throw new Error(data.error || `服务器返回了非预期的状态: ${response.status}`);
        }
    } catch (error) {
        const errorMsg = `请求失败: ${error.message}`;
        captionContainer.textContent = errorMsg;
        captionContainerMobile.textContent = '生成失败';
        showNotification(`生成失败: ${error.message}`, 'error');
    }
}

/**
 * 轮询AI生成任务状态
 * @param {string} jobId - 任务ID
 */
function pollJobStatus(jobId) {
    if (state.currentAbortController) state.currentAbortController.abort();
    state.currentAbortController = new AbortController();
    const signal = state.currentAbortController.signal;
    const { captionContainer, captionContainerMobile } = elements;
    
    const intervalId = setInterval(async () => {
        try {
            const res = await fetch(`/api/ai/job/${jobId}`, { signal, headers: getAuthHeaders() });
            if (signal.aborted) {
                clearInterval(intervalId);
                return;
            }
            if (!res.ok) {
                clearInterval(intervalId);
                const errorMsg = '无法获取任务状态，请重试。';
                captionContainer.textContent = errorMsg;
                captionContainerMobile.textContent = '生成失败';
                return;
            }
            const data = await res.json();
            if (data.state === 'completed') {
                clearInterval(intervalId);
                if (data.result?.success) {
                    captionContainer.textContent = data.result.caption;
                    captionContainerMobile.textContent = data.result.caption;
                } else {
                    const reason = data.failedReason || 'AI Worker返回了失败的结果';
                    captionContainer.textContent = `生成失败: ${reason}`;
                    captionContainerMobile.textContent = '生成失败';
                }
            } else if (data.state === 'failed') {
                clearInterval(intervalId);
                const reason = data.failedReason || '未知错误';
                captionContainer.textContent = `生成失败: ${reason}`;
                captionContainerMobile.textContent = '生成失败';
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('轮询任务状态时发生错误:', error);
                captionContainer.textContent = '检查状态时发生网络错误。';
                captionContainerMobile.textContent = 'Failed';
            }
            clearInterval(intervalId);
        }
    }, 3000);

    setTimeout(() => {
        if (captionContainer.innerHTML.includes('spinner')) {
            captionContainer.textContent = '任务超时，请稍后重试。';
            captionContainerMobile.textContent = '任务超时';
        }
        clearInterval(intervalId)
    }, 120000);
}
