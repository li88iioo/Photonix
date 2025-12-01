/**
 * @file AI 相关 API：生成图片描述、缓存查询与清理
 */

import { state } from '../core/state.js';
import { SETTINGS } from '../core/constants.js';
import { elements } from '../shared/dom-elements.js';
import aiCache from '../features/ai/ai-cache.js';
import { showNotification } from '../shared/utils.js';
import { getAuthToken } from '../app/auth.js';
import { safeSetInnerHTML} from '../shared/dom-utils.js';
import { escapeHtml } from '../shared/security.js';
import { getAuthHeaders, refreshAuthToken, triggerAuthRequired } from './shared.js';
import {
    getConversationHistory,
    appendConversationEntry,
    clearConversationHistory,
    buildConversationPrompt
} from '../features/ai/ai-conversation-store.js';

let currentGenerateController = null;
let currentImagePath = null;
let isProcessing = false;
let activeChatImagePath = null;
let chatUIInitialized = false;
let chatStatusTimer = null;
const AI_CLOSE_HINT_KEY = 'ai_close_hint_seen';

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

function normalizeChatImageKey(rawPath) {
    if (!rawPath) return null;
    if (rawPath.startsWith('blob:')) return rawPath;
    try {
        return parseImagePath(rawPath);
    } catch {
        return rawPath;
    }
}

function ensureChatUIReady() {
    if (chatUIInitialized) return;
    const { aiChatForm, aiChatClear } = elements;
    if (!aiChatForm) return;
    chatUIInitialized = true;

    aiChatForm.addEventListener('submit', handleChatSubmit);
    if (aiChatClear) {
        aiChatClear.addEventListener('click', handleChatClear);
    }
    if (elements.aiCloseHintDismiss) {
        elements.aiCloseHintDismiss.addEventListener('click', () => {
            markCloseHintAsSeen();
            toggleCloseHint(false);
        });
    }
}

function renderChatHistory() {
    const { aiChatHistory } = elements;
    if (!aiChatHistory) return;
    const history = activeChatImagePath ? getConversationHistory(activeChatImagePath) : [];
    if (!history.length) {
        safeSetInnerHTML(aiChatHistory, '<p class="ai-chat-history-empty">和她聊点什么吧～</p>');
        return;
    }
    const html = history.map(entry => `
        <div class="ai-chat-message ai-chat-message-${entry.role === 'user' ? 'user' : 'ai'}">
            <div class="ai-chat-bubble">${escapeHtml(entry.message)}</div>
        </div>
    `).join('');
    safeSetInnerHTML(aiChatHistory, html);
    aiChatHistory.scrollTop = aiChatHistory.scrollHeight;
}

function setChatStatus(message, tone = 'muted') {
    const { aiChatStatus } = elements;
    if (!aiChatStatus) return;
    aiChatStatus.textContent = message || '';
    aiChatStatus.classList.remove('error', 'success');
    if (tone === 'error') aiChatStatus.classList.add('error');
    if (tone === 'success') aiChatStatus.classList.add('success');
    clearTimeout(chatStatusTimer);
    if (message) {
        chatStatusTimer = setTimeout(() => {
            aiChatStatus.textContent = '';
            aiChatStatus.classList.remove('error', 'success');
        }, 4000);
    }
}

function setChatSendingState(isSending) {
    const { aiChatForm, aiChatInput } = elements;
    if (!aiChatForm) return;
    const submitBtn = aiChatForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = isSending;
    if (aiChatInput) aiChatInput.disabled = isSending;
}

function handleChatSubmit(event) {
    event.preventDefault();
    if (!activeChatImagePath) {
        showNotification('请先打开一张图片再开始对话', 'info');
        return;
    }
    if (isProcessing) {
        setChatStatus('AI 正在处理，请稍候...', 'muted');
        return;
    }
    const input = elements.aiChatInput;
    if (!input) return;
    const value = input.value.trim();
    if (!value) {
        setChatStatus('请输入想说的话', 'error');
        return;
    }
    input.value = '';
    sendConversationMessage(value);
}

function handleChatClear() {
    if (!activeChatImagePath) return;
    clearConversationHistory(activeChatImagePath);
    renderChatHistory();
    setChatStatus('对话已清空', 'success');
}

function updateChatAvailability(enabled) {
    ensureChatUIReady();
    const wrapper = elements.aiChatWrapper;
    if (!wrapper) return;
    const layout = elements.modalLayout;
    if (layout) {
        enabled ? layout?.classList.add('modal-layout--with-chat') : layout?.classList.remove('modal-layout--with-chat');
    }
    try {
        document.body?.classList[enabled ? 'add' : 'remove']('ai-chat-visible');
    } catch { }
    wrapper?.classList.toggle('hidden', !enabled);
    wrapper.setAttribute('aria-hidden', enabled ? 'false' : 'true');
    toggleCloseHint(enabled);
    if (enabled) {
        renderChatHistory();
        setChatStatus('', 'muted');
    } else {
        setChatStatus('', 'muted');
    }
}

function shouldShowCloseHint() {
    try {
        return localStorage.getItem(AI_CLOSE_HINT_KEY) !== 'true';
    } catch {
        return true;
    }
}

function markCloseHintAsSeen() {
    try {
        localStorage.setItem(AI_CLOSE_HINT_KEY, 'true');
    } catch { }
}

function toggleCloseHint(enabled) {
    const { aiCloseHint } = elements;
    if (!aiCloseHint) return;
    const showHint = enabled && shouldShowCloseHint();
    aiCloseHint?.classList.toggle('hidden', !showHint);
}

function recordInitialAIMessage(imagePath, message) {
    if (!imagePath || !message) return;
    const history = getConversationHistory(imagePath);
    if (history.length === 0) {
        appendConversationEntry(imagePath, 'ai', message);
    }
    if (activeChatImagePath === imagePath) {
        renderChatHistory();
    }
}

function recordAIReply(imagePath, message) {
    if (!imagePath || !message) return;
    appendConversationEntry(imagePath, 'ai', message);
    if (activeChatImagePath === imagePath) {
        renderChatHistory();
        setChatStatus('她回应了你', 'success');
    }
}

async function sendConversationMessage(userMessage) {
    if (!activeChatImagePath) return;
    if (isProcessing) {
        setChatStatus('AI 正在处理，请稍候...', 'muted');
        return;
    }

    if (!validateAuthentication()) {
        setChatStatus('请先登录后再继续对话', 'error');
        return;
    }

    const aiConfig = validateAIConfig();
    if (!aiConfig) return;

    const existingHistory = getConversationHistory(activeChatImagePath);
    const prompt = buildConversationPrompt(aiConfig.AI_PROMPT, existingHistory, userMessage);
    appendConversationEntry(activeChatImagePath, 'user', userMessage);
    renderChatHistory();

    cleanupPreviousRequest(activeChatImagePath);
    setChatSendingState(true);
    setChatStatus('她正在思考...', 'muted');

    try {
        const response = await performGenerateRequest(activeChatImagePath, aiConfig, {
            promptOverride: prompt
        });
        if (response.ok) {
            const data = await response.json();
            await handleGenerationResult(data, activeChatImagePath, aiConfig, { mode: 'chat' });
        } else {
            let errorMessage = `服务器错误: ${response.status}`;
            let errorCode = null;
            let errorDetail = null;
            try {
                const errorData = await response.json();
                if (errorData?.message) errorMessage = errorData.message;
                if (errorData?.code) errorCode = errorData.code;
                if (errorData?.detail) errorDetail = errorData.detail;
            } catch {
                errorMessage = `服务器错误 (${response.status})`;
            }
            const error = new Error(errorMessage);
            if (errorCode) error.code = errorCode;
            if (errorDetail) error.detail = errorDetail;
            throw error;
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            setChatStatus('会话已取消', 'error');
        } else if (!error.silent) {
            const fallbackMessage = error.message || '发送失败，请稍后再试';
            const statusMessage = error.detail && error.detail !== fallbackMessage
                ? `${fallbackMessage}（${error.detail}）`
                : fallbackMessage;
            setChatStatus(statusMessage, 'error');
        }
        setChatSendingState(false);
        isProcessing = false;
    }
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
    } catch { }
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
        setChatStatus('AI 配置信息不完整', 'error');
        return null;
    }
    return aiConfig;
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
 * 发起生成图片描述的请求（POST /api/ai/generate）
 * @param {string} imagePath 图片路径
 * @param {Object} aiConfig AI 配置
 * @returns {Promise<Response>} fetch 响应对象
 */
async function makeAICaptionRequest(imagePath, aiConfig, options = {}) {
    const promptToUse = options.promptOverride || aiConfig.AI_PROMPT;
    const controller = options.controller || currentGenerateController;
    return fetch('/api/ai/generate', {
        method: 'POST',
        headers: getAuthHeaders(),
        signal: controller ? controller.signal : undefined,
        body: JSON.stringify({
            image_path: imagePath,
            aiConfig: {
                url: aiConfig.AI_URL,
                key: aiConfig.AI_KEY,
                model: aiConfig.AI_MODEL,
                prompt: promptToUse
            }
        })
    });
}

async function performGenerateRequest(imagePath, aiConfig, options = {}) {
    let response = await makeAICaptionRequest(imagePath, aiConfig, options);
    if (response.status === 401) {
        const refreshed = await refreshAuthToken();
        if (refreshed) {
            response = await makeAICaptionRequest(imagePath, aiConfig, options);
        } else {
            triggerAuthRequired();
            const error = new Error('UNAUTHORIZED');
            error.code = 'UNAUTHORIZED';
            error.silent = true;
            throw error;
        }
    }
    return response;
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

    setChatStatus('她正在酝酿情绪，请稍候...', 'muted');

    try {
        const cached = await checkAICache(imagePath, aiConfig);
        if (cached) {
            recordInitialAIMessage(imagePath, cached.caption);
            setChatStatus('她准备好了，开始聊天吧', 'success');
            isProcessing = false;
            return;
        }

        const response = await performGenerateRequest(imagePath, aiConfig);
        if (response.ok) {
            const data = await response.json();
            await handleGenerationResult(data, imagePath, aiConfig, { mode: 'caption' });
        } else {
            let errorMessage = `服务器错误: ${response.status}`;
            let errorCode = null;
            let errorDetail = null;
            try {
                const errorData = await response.json();
                if (errorData?.message) {
                    errorMessage = errorData.message;
                } else if (errorData?.error) {
                    errorMessage = errorData.error;
                }
                if (errorData?.code) {
                    errorCode = errorData.code;
                }
                if (errorData?.detail) {
                    errorDetail = errorData.detail;
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
            const error = new Error(errorMessage);
            if (errorCode) error.code = errorCode;
            if (errorDetail) error.detail = errorDetail;
            throw error;
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            isProcessing = false;
            setChatStatus('对话已取消', 'error');
            return;
        }

        const fallbackMessage = error.message || '生成失败，请重试';
        const statusMessage = error.detail && error.detail !== fallbackMessage
            ? `${fallbackMessage}（${error.detail}）`
            : fallbackMessage;
        setChatStatus(statusMessage, 'error');
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
async function handleGenerationResult(data, imagePath, aiConfig, options = {}) {
    const mode = options.mode || 'caption';
    const isChatMode = mode === 'chat';

    if (data && typeof data === 'object') {
        if (typeof data.description === 'string' && data.description.trim()) {
            const description = data.description;
            if (!isChatMode) {
                try {
                    await aiCache.save(imagePath, {
                        url: aiConfig.AI_URL,
                        key: aiConfig.AI_KEY,
                        model: aiConfig.AI_MODEL,
                        prompt: aiConfig.AI_PROMPT
                    }, description);
                } catch { }
                recordInitialAIMessage(imagePath, description);
                setChatStatus('她准备好了，开始聊天吧', 'success');
            } else {
                recordAIReply(imagePath, description);
            }
            isProcessing = false;
            setChatSendingState(false);
            return;
        }

        if (data.code && data.message) {
            if (data.message.includes('AI未能生成有效内容') ||
                data.message.includes('AI处理失败') ||
                data.code === 'AI_PROCESSING_ERROR') {
                const detail = data.detail || data.message;
                setChatStatus(detail, 'error');
                setChatSendingState(false);
                isProcessing = false;
                return;
            }

            const quotaError = new Error(data.message);
            quotaError.code = data.code;
            if (data.detail) quotaError.detail = data.detail;
            throw quotaError;
        }

        if (data.message && data.cooldownSeconds) {
            const cooldownMsg = `请等待 ${data.cooldownSeconds} 秒后再试`;
            setChatStatus(`${data.message}，${cooldownMsg}`, 'error');
            setChatSendingState(false);
            if (!isChatMode) {
                showNotification(data.message, 'warning');
            }
            isProcessing = false;
            return;
        }

        if (typeof data.result === 'string') {
            recordInitialAIMessage(imagePath, data.result);
            if (!isChatMode) {
                setChatStatus('她准备好了，开始聊天吧', 'success');
            } else {
                setChatSendingState(false);
            }
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
    } catch { }

    if (!response.ok) {
        const message = data && data.message ? data.message : `获取模型列表失败（HTTP ${response.status}）`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
    }

    return Array.isArray(data?.models) ? data.models : [];
}

export function updateAIChatContext(imagePath, options = {}) {
    ensureChatUIReady();
    const normalized = imagePath ? normalizeChatImageKey(imagePath) : null;
    activeChatImagePath = normalized;
    const enabled = Boolean(normalized && options.enabled);
    updateChatAvailability(enabled);
    if (enabled) {
        renderChatHistory();
        setChatStatus('', 'muted');
    }
}
