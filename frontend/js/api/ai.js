/**
 * @file AI 相关 API：生成图片描述、缓存查询与清理
 */

import { state } from '../core/state.js';
import { SETTINGS } from '../core/constants.js';
import { elements } from '../shared/dom-elements.js';
import aiCache from '../features/ai/ai-cache.js';
import { showNotification } from '../shared/utils.js';
import { getAuthToken } from '../app/auth.js';
import { safeSetInnerHTML, safeClassList } from '../shared/dom-utils.js';
import { escapeHtml } from '../shared/security.js';
import { getAuthHeaders, refreshAuthToken, triggerAuthRequired } from './shared.js';

let currentGenerateController = null;
let currentImagePath = null;
let isProcessing = false;

/**
 * 获取本地存储中的 AI 配置
 * @returns {Object} AI 配置对象
 */
function getLocalAISettings() {
    try {
        return JSON.parse(localStorage.getItem(SETTINGS.AI_LOCAL_KEY)) || {};
    } catch {
        return {};
    }
}

/**
 * 从图片 URL 解析出相对路径（兼容 /static/ 前缀）
 * @param {string} imageUrl 图片 URL
 * @returns {string} 解析后的图片路径
 */
function parseImagePath(imageUrl) {
    const url = new URL(imageUrl, window.location.origin);
    return url.pathname.startsWith('/static/')
        ? decodeURIComponent(url.pathname.substring(7))
        : decodeURIComponent(url.pathname);
}

/**
 * 判断是否为对同一图片的重复生成请求（防抖）
 * @param {string} imagePath 图片路径
 * @returns {boolean} 是否为重复请求
 */
function isDuplicateRequest(imagePath) {
    return isProcessing && currentImagePath === imagePath;
}

/**
 * 中止前一个生成请求，并记录当前请求上下文
 * @param {string} imagePath 图片路径
 */
function cleanupPreviousRequest(imagePath) {
    try {
        if (currentGenerateController) currentGenerateController.abort();
    } catch {}
    currentGenerateController = new AbortController();
    currentImagePath = imagePath;
    isProcessing = true;
}

/**
 * 校验是否启用 AI（本地设置或全局状态）
 * @returns {boolean} 是否启用 AI
 */
function validateAIEnabled() {
    const localAI = getLocalAISettings();
    return localAI.AI_ENABLED === 'true' || state.aiEnabled;
}

/**
 * 校验认证（如启用密码则需已登录）
 * @returns {boolean} 是否通过认证校验
 */
function validateAuthentication() {
    const isPasswordEnabled = !!state.passwordEnabled;
    if (isPasswordEnabled && !getAuthToken()) {
        showNotification('需要登录才能使用 AI 功能', 'error');
        return false;
    }
    return true;
}

/**
 * 校验本地 AI 配置是否完整
 * @returns {Object|null} AI 配置对象，若不完整则返回 null
 */
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

/**
 * 设置加载中状态的 UI（漫画风格）
 * @param {HTMLElement} container 桌面端容器元素
 * @param {HTMLElement} mobileContainer 移动端容器元素
 */
function setLoadingState(container, mobileContainer) {
    const loadingHtml = '<div class="flex items-center justify-center h-full loading-state"><div class="spinner"></div><p class="ml-2">她正在酝酿情绪，请稍候...</p></div>';
    safeSetInnerHTML(container, loadingHtml);
    mobileContainer.textContent = '酝酿中...';
    
    // 显示气泡框（PC端）
    if (elements.captionBubble) {
        safeClassList(elements.captionBubble, 'add', 'show');
    }
}

/**
 * 查询 AI 结果缓存
 * @param {string} imagePath 图片路径
 * @param {Object} aiConfig AI 配置
 * @returns {Promise<Object|null>} 缓存结果对象或 null
 */
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

/**
 * 渲染生成的描述结果到页面（漫画打字机效果）
 * @param {string} caption 生成的描述文本
 */
function displayCaptionResult(caption) {
    const { captionContainer, captionContainerMobile, captionBubble } = elements;
    
    // 桌面端：漫画打字机效果
    safeSetInnerHTML(captionContainer, '');
    const typingDiv = document.createElement('div');
    typingDiv.className = 'caption-typing-text';
    typingDiv.textContent = caption;
    captionContainer.appendChild(typingDiv);
    
    // 动态计算打字机动画参数
    const textLength = caption.length;
    const duration = Math.max(2, Math.min(8, textLength * 0.05)); // 2-8秒，根据长度
    const steps = Math.min(textLength, 100); // 最多100步
    
    // 应用动画样式
    typingDiv.style.animation = `
        typing ${duration}s steps(${steps}, end) 0.5s 1 forwards,
        blink-caret 0.75s step-end infinite
    `;
    typingDiv.classList.add('typing');
    
    // 监听打字动画结束
    typingDiv.addEventListener('animationend', (event) => {
        if (event.animationName === 'typing') {
            typingDiv.classList.remove('typing');
            typingDiv.classList.add('typing-done');
            typingDiv.style.animation = 'none';
        }
    });
    
    // 显示气泡框（PC端自动显示）
    if (captionBubble) {
        safeClassList(captionBubble, 'add', 'show');
    }
    
    // 移动端：简单显示（移动端空间有限）
    captionContainerMobile.textContent = caption;
}

/**
 * 发起生成图片描述的请求（POST /api/ai/generate）
 * @param {string} imagePath 图片路径
 * @param {Object} aiConfig AI 配置
 * @returns {Promise<Response>} fetch 响应对象
 */
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

/**
 * 对指定图片生成 AI 描述，包含缓存命中、401 刷新与错误提示
 * @param {string} imageUrl 图片 URL
 * @returns {Promise<void>}
 */
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

/**
 * 处理生成结果与错误提示，并写入缓存
 * @param {Object} data 服务器响应数据
 * @param {string} imagePath 图片路径
 * @param {Object} aiConfig AI 配置
 * @returns {Promise<void>}
 */
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

/**
 * 获取 AI 缓存统计信息
 * @returns {Promise<Object|null>} 缓存统计信息对象或 null
 */
export async function getAICacheStats() {
    try {
        return await aiCache.getStats();
    } catch {
        return null;
    }
}

/**
 * 清空 AI 缓存并提示
 * @returns {Promise<void>}
 */
export async function clearAICache() {
    try {
        await aiCache.clear();
        showNotification('AI缓存已清空', 'success');
    } catch {
        showNotification('清空缓存失败', 'error');
    }
}

/**
 * 获取可用的 AI 模型列表
 * @param {string} apiUrl API 地址
 * @param {string} apiKey API 密钥
 * @param {AbortSignal} signal 中止信号
 * @returns {Promise<Array<string>>} 模型列表
 * @throws {Error} 当 API 地址或密钥为空时抛出错误
 */
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
