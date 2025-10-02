// AI 相关 API：生成图片描述、缓存查询与清理
import { state } from '../state.js';
import { SETTINGS } from '../constants.js';
import { elements } from '../dom-elements.js';
import aiCache from '../ai-cache.js';
import { showNotification } from '../utils.js';
import { getAuthToken } from '../auth.js';
import { safeSetInnerHTML } from '../dom-utils.js';
import { escapeHtml } from '../security.js';
import { getAuthHeaders, refreshAuthToken, triggerAuthRequired } from './shared.js';

let currentGenerateController = null;
let currentImagePath = null;
let isProcessing = false;

// 从 LocalStorage 获取 AI 配置
function getLocalAISettings() {
    try {
        return JSON.parse(localStorage.getItem(SETTINGS.AI_LOCAL_KEY)) || {};
    } catch {
        return {};
    }
}

// 从图片 URL 解析相对路径（兼容 /static/ 前缀）
function parseImagePath(imageUrl) {
    const url = new URL(imageUrl, window.location.origin);
    return url.pathname.startsWith('/static/')
        ? decodeURIComponent(url.pathname.substring(7))
        : decodeURIComponent(url.pathname);
}

// 防抖：避免对同一图片重复触发生成
function isDuplicateRequest(imagePath) {
    return isProcessing && currentImagePath === imagePath;
}

// 中止前一个请求并记录当前上下文
function cleanupPreviousRequest(imagePath) {
    try {
        if (currentGenerateController) currentGenerateController.abort();
    } catch {}
    currentGenerateController = new AbortController();
    currentImagePath = imagePath;
    isProcessing = true;
}

// 校验是否启用 AI（本地设置或全局状态）
function validateAIEnabled() {
    const localAI = getLocalAISettings();
    return localAI.AI_ENABLED === 'true' || state.aiEnabled;
}

// 如启用密码，需已登录
function validateAuthentication() {
    const isPasswordEnabled = !!state.passwordEnabled;
    if (isPasswordEnabled && !getAuthToken()) {
        showNotification('需要登录才能使用 AI 功能', 'error');
        return false;
    }
    return true;
}

// 校验本地 AI 配置是否完整
function validateAIConfig() {
    const aiConfig = getLocalAISettings();
    if (!aiConfig.AI_URL || !aiConfig.AI_KEY || !aiConfig.AI_MODEL || !aiConfig.AI_PROMPT) {
        showNotification('请先在设置中填写完整的 AI 配置信息', 'error');
        const { captionContainer, captionContainerMobile } = elements;
        captionContainer.textContent = 'AI 配置信息不完整';
        captionContainerMobile.textContent = '配置不完整';
        return null;
    }
    return aiConfig;
}

// 设置加载中的 UI
function setLoadingState(container, mobileContainer) {
    const loadingHtml = '<div class="flex items-center justify-center h-full"><div class="spinner"></div><p class="ml-2">她正在酝酿情绪，请稍候...</p></div>';
    safeSetInnerHTML(container, loadingHtml);
    safeSetInnerHTML(mobileContainer, '酝酿中...');
}

// 查询 AI 结果缓存
async function checkAICache(imagePath, aiConfig) {
    try {
        return await aiCache.check(imagePath, {
            url: aiConfig.AI_URL,
            key: aiConfig.AI_KEY,
            model: aiConfig.AI_MODEL,
            prompt: aiConfig.AI_PROMPT
        });
    } catch {
        return null;
    }
}

// 渲染生成结果到页面
function displayCaptionResult(caption) {
    const { captionContainer, captionContainerMobile } = elements;
    captionContainer.textContent = caption;
    captionContainerMobile.textContent = caption;
}

// 发起生成请求（POST /api/ai/generate）
async function makeAICaptionRequest(imagePath, aiConfig) {
    return fetch('/api/ai/generate', {
        method: 'POST',
        headers: getAuthHeaders(),
        signal: currentGenerateController.signal,
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
}

// 对指定图片生成AI描述，含缓存命中、401刷新与错误提示
export async function generateImageCaption(imageUrl) {
    const imagePath = parseImagePath(imageUrl);

    if (isDuplicateRequest(imagePath)) {
        return;
    }

    cleanupPreviousRequest(imagePath);

    if (!validateAIEnabled()) {
        isProcessing = false;
        return;
    }

    if (!validateAuthentication()) {
        isProcessing = false;
        return;
    }

    const aiConfig = validateAIConfig();
    if (!aiConfig) {
        isProcessing = false;
        return;
    }

    const { captionContainer, captionContainerMobile } = elements;
    setLoadingState(captionContainer, captionContainerMobile);

    try {
        const cached = await checkAICache(imagePath, aiConfig);
        if (cached) {
            displayCaptionResult(cached.caption);
            isProcessing = false;
            return;
        }

        const response = await makeAICaptionRequest(imagePath, aiConfig);

        if (response.status === 401) {
            const refreshed = await refreshAuthToken();
            if (refreshed) {
                const retryResponse = await fetch('/api/ai/generate', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    signal: currentGenerateController.signal,
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

                if (retryResponse.ok) {
                    const data = await retryResponse.json();
                    await handleGenerationResult(data, imagePath, aiConfig);
                } else {
                    throw new Error(`重试请求失败: ${retryResponse.status}`);
                }
            } else {
                triggerAuthRequired();
                const error = new Error('UNAUTHORIZED');
                error.code = 'UNAUTHORIZED';
                error.silent = true;
                throw error;
            }
        } else if (response.ok) {
            const data = await response.json();
            await handleGenerationResult(data, imagePath, aiConfig);
        } else {
            let errorMessage = `服务器错误: ${response.status}`;
            try {
                const errorData = await response.json();
                if (errorData?.message) {
                    errorMessage = errorData.message;
                } else if (errorData?.error) {
                    errorMessage = errorData.error;
                }
            } catch {
                try {
                    const text = await response.text();
                    if (text) {
                        errorMessage = `服务器错误 (${response.status}): ${text.substring(0, 100)}`;
                    }
                } catch {
                    errorMessage = `服务器错误 (${response.status}): 响应格式异常`;
                }
            }
            throw new Error(errorMessage);
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            isProcessing = false;
            if (elements.captionContainer.innerHTML.includes('spinner') ||
                elements.captionContainer.innerHTML.includes('酝酿中...')) {
                safeSetInnerHTML(elements.captionContainer, '<div class="text-center text-gray-400 py-4">点击生成AI密语</div>');
                elements.captionContainerMobile.textContent = '';
            }
            return;
        }

        const message = error.message || '生成失败，请重试';
        elements.captionContainer.textContent = message;
        elements.captionContainerMobile.textContent = '生成失败';
        showNotification(`AI生成失败: ${message}`, 'error');
        isProcessing = false;
    }
}

// 处理生成结果与错误提示，并写入缓存
async function handleGenerationResult(data, imagePath, aiConfig) {
    const { captionContainer, captionContainerMobile } = elements;

    if (data && typeof data === 'object') {
        if (typeof data.description === 'string' && data.description.trim()) {
            captionContainer.textContent = data.description;
            captionContainerMobile.textContent = data.description;

            try {
                await aiCache.save(imagePath, {
                    url: aiConfig.AI_URL,
                    key: aiConfig.AI_KEY,
                    model: aiConfig.AI_MODEL,
                    prompt: aiConfig.AI_PROMPT
                }, data.description);
            } catch {}

            isProcessing = false;
            return;
        }

        if (data.code && data.message) {
            if (data.message.includes('AI未能生成有效内容') ||
                data.message.includes('AI处理失败') ||
                data.code === 'AI_PROCESSING_ERROR') {
                safeSetInnerHTML(captionContainer, `
                    <div class="text-red-600 mb-2">${escapeHtml(data.message)}</div>
                    <div class="text-sm text-gray-500">请稍后重试或选择其他图片</div>
                `);
                captionContainerMobile.textContent = '生成失败';
                isProcessing = false;
                showNotification('AI生成失败', 'error');
                return;
            }

            throw new Error(data.message);
        }

        if (data.message && data.cooldownSeconds) {
            const cooldownMsg = `请等待 ${data.cooldownSeconds} 秒后再试`;
            safeSetInnerHTML(captionContainer, `
                <div class="text-blue-600 mb-2">${escapeHtml(data.message)}</div>
                <div class="text-sm text-gray-500">${escapeHtml(cooldownMsg)}</div>
            `);
            captionContainerMobile.textContent = '冷却中';
            showNotification(data.message, 'warning');
            isProcessing = false;
            return;
        }

        if (typeof data.result === 'string') {
            captionContainer.textContent = data.result;
            captionContainerMobile.textContent = data.result;
            isProcessing = false;
            return;
        }

        throw new Error(`服务器返回数据格式不符合预期: ${JSON.stringify(data).substring(0, 100)}`);
    }

    throw new Error('服务器返回数据格式错误');
}

// 获取 AI 缓存统计
export async function getAICacheStats() {
    try {
        return await aiCache.getStats();
    } catch {
        return null;
    }
}

// 清空 AI 缓存并提示

export async function fetchAvailableModels(apiUrl, apiKey, signal) {
    if (!apiUrl || !apiKey) {
        throw new Error('请先填写 API 地址和 API Key');
    }

    const headers = {
        'Content-Type': 'application/json'
    };

    const token = getAuthToken();
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch('/api/ai/models', {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: apiUrl, key: apiKey }),
        signal
    });

    let data = null;
    try {
        data = await response.clone().json();
    } catch {}

    if (!response.ok) {
        const message = data && data.message ? data.message : `获取模型列表失败（HTTP ${response.status}）`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
    }

    return Array.isArray(data?.models) ? data.models : [];
}
export async function clearAICache() {
    try {
        await aiCache.clear();
        showNotification('AI缓存已清空', 'success');
    } catch {
        showNotification('清空缓存失败', 'error');
    }
}
