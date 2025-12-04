/**
 * @file AI 相关 API：生成图片描述、缓存查询与清理
 */

import { state } from '../core/state.js';
import { SETTINGS, AI_CHAT } from '../core/constants.js';
import { elements } from '../shared/dom-elements.js';
import aiCache from '../features/ai/ai-cache.js';
import { showNotification } from '../shared/utils.js';
import { getAuthToken } from '../app/auth.js';
import { safeSetInnerHTML } from '../shared/dom-utils.js';
import { escapeHtml } from '../shared/security.js';
import { getAuthHeaders, refreshAuthToken, triggerAuthRequired } from './shared.js';
import {
    getConversationHistory,
    appendConversationEntry,
    clearConversationHistory,
    buildConversationPrompt,
    updateConversationEntry,
    MESSAGE_STATUS
} from '../features/ai/ai-conversation-store.js';


let currentGenerateController = null;
let currentImagePath = null;
let isProcessing = false;
let activeChatImagePath = null;
let chatUIInitialized = false;
let chatStatusTimer = null;
const AI_CLOSE_HINT_KEY = 'ai_close_hint_seen';
let pendingMessageContext = null;

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
        aiChatClear.addEventListener('click', () => {
            handleChatClear().catch(() => { });
        });
    }
    if (elements.aiChatHistory) {
        elements.aiChatHistory.addEventListener('click', (event) => {
            handleChatHistoryClick(event).catch(() => { });
        });
    }
    if (elements.aiCloseHintDismiss) {
        elements.aiCloseHintDismiss.addEventListener('click', () => {
            markCloseHintAsSeen();
            toggleCloseHint(false);
        });
    }

    // 添加键盘快捷键支持 - 简化版
    const aiChatInput = elements.aiChatInput;
    const KB_HINT_KEY = 'ai_chat_kb_hint_seen';
    const HINT_PLACEHOLDER = '想和她说点什么？Enter发送 Shift+Enter换行';
    const NORMAL_PLACEHOLDER = '想和她说点什么？';

    if (aiChatInput) {
        // Enter 发送，Shift+Enter 换行
        aiChatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                aiChatForm.requestSubmit();
                // 首次发送后恢复简短 placeholder
                if (aiChatInput.placeholder === HINT_PLACEHOLDER) {
                    aiChatInput.placeholder = NORMAL_PLACEHOLDER;
                    try {
                        localStorage.setItem(KB_HINT_KEY, 'true');
                    } catch { }
                }
            }
        });

        // 首次显示详细提示
        try {
            const hintSeen = localStorage.getItem(KB_HINT_KEY) === 'true';
            if (!hintSeen) {
                aiChatInput.placeholder = HINT_PLACEHOLDER;
            }
        } catch { }
    }
}

async function renderChatHistory() {
    const { aiChatHistory } = elements;
    if (!aiChatHistory) return;
    try {
        const history = activeChatImagePath ? await getConversationHistory(activeChatImagePath) : [];
        if (!history.length) {
            safeSetInnerHTML(aiChatHistory, '<p class="ai-chat-history-empty">和她聊点什么吧～</p>');
            return;
        }
        const html = history.map(entry => {
            const roleClass = entry.role === 'user' ? 'user' : 'ai';
            const failedClass = entry.role === 'user' && entry.status === MESSAGE_STATUS.FAILED ? ' failed' : '';
            const meta = renderMessageMeta(entry);
            return `
                <div class="ai-chat-message ai-chat-message-${roleClass}${failedClass}">
                    <div class="ai-chat-bubble">${escapeHtml(entry.message)}</div>
                    ${meta}
                </div>
            `;
        }).join('');
        safeSetInnerHTML(aiChatHistory, html);
        aiChatHistory.scrollTop = aiChatHistory.scrollHeight;
    } catch {
        // 忽略渲染错误，保持当前显示
    }
}

function renderMessageMeta(entry) {
    if (entry.role !== 'user') return '';
    if (entry.status === MESSAGE_STATUS.SENDING) {
        return '<div class="message-status sending">发送中...</div>';
    }
    if (entry.status === MESSAGE_STATUS.FAILED) {
        return `<div class="message-action">${buildRetryButton(entry.id)}</div>`;
    }
    return '';
}

function buildRetryButton(entryId) {
    if (!entryId) return '';
    const safeId = escapeHtml(String(entryId));
    return `
        <button type="button" class="retry-btn" data-retry-id="${safeId}">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="23 4 23 10 17 10"></polyline>
                <polyline points="1 20 1 14 7 14"></polyline>
                <path d="M3.51 9a9 9 0 0114.76-3.36L23 10"></path>
                <path d="M20.49 15a9 9 0 01-14.76 3.36L1 14"></path>
            </svg>
            <span>重试</span>
        </button>
    `;
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

async function handleChatClear() {
    if (!activeChatImagePath) return;
    await clearConversationHistory(activeChatImagePath);
    await renderChatHistory();
    setChatStatus('对话已清空', 'success');
}

async function handleChatHistoryClick(event) {
    const retryBtn = event.target.closest('[data-retry-id]');
    if (!retryBtn) return;
    event.preventDefault();
    event.stopPropagation();
    const entryId = retryBtn.getAttribute('data-retry-id');
    if (!entryId) return;
    await retryConversationMessage(entryId);
}

async function retryConversationMessage(entryId) {
    if (!entryId || !activeChatImagePath) return;
    if (isProcessing) {
        setChatStatus('AI 正在处理，请稍候...', 'muted');
        return;
    }
    const history = await getConversationHistory(activeChatImagePath);
    // 使用松散比较自动处理 IndexedDB 数字ID 和 sessionStorage 字符串ID 的兼容
    const target = history.find(entry => entry.id == entryId);
    if (!target) return;
    sendConversationMessage(target.message, { entryId });
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
    const renderPromise = enabled ? renderChatHistory() : Promise.resolve();
    renderPromise.catch(() => { });
    setChatStatus('', 'muted');
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

function setPendingMessageContext(imagePath, entryId) {
    if (!imagePath || !entryId) {
        pendingMessageContext = null;
        return;
    }
    pendingMessageContext = { imagePath, entryId };
}

function clearPendingMessageContext() {
    pendingMessageContext = null;
}

async function markPendingMessageDelivered() {
    if (!pendingMessageContext) return;
    const { imagePath, entryId } = pendingMessageContext;
    await updateConversationEntry(imagePath, entryId, {
        status: MESSAGE_STATUS.DELIVERED,
        error: ''
    });
    if (activeChatImagePath === imagePath) {
        await renderChatHistory();
    }
    setChatStatus('', 'muted');
    clearPendingMessageContext();
}

async function markPendingMessageFailed(message = '') {
    if (!pendingMessageContext) return;
    const { imagePath, entryId } = pendingMessageContext;
    await updateConversationEntry(imagePath, entryId, {
        status: MESSAGE_STATUS.FAILED,
        error: message
    });
    if (activeChatImagePath === imagePath) {
        await renderChatHistory();
    }
    if (message) {
        setChatStatus(message, 'error');
    }
    clearPendingMessageContext();
}

async function recordInitialAIMessage(imagePath, message) {
    if (!imagePath || !message) return;
    const history = await getConversationHistory(imagePath, { limit: 1 });
    if (history.length === 0) {
        await appendConversationEntry(imagePath, 'ai', message);
    }
    if (activeChatImagePath === imagePath) {
        await renderChatHistory();
    }
}

async function recordAIReply(imagePath, message) {
    if (!imagePath || !message) return;
    await appendConversationEntry(imagePath, 'ai', message);
    if (activeChatImagePath === imagePath) {
        await renderChatHistory();
        setChatStatus('她回应了你', 'success');
    }
}

async function sendConversationMessage(userMessage, options = {}) {
    if (!activeChatImagePath) return;
    if (isProcessing) {
        setChatStatus('AI 正在处理，请稍候...', 'muted');
        return;
    }

    const aiConfig = validateAIConfig();
    if (!aiConfig) return;

    const contextLimit = AI_CHAT?.CONTEXT_MESSAGE_LIMIT || 20;
    const existingHistory = await getConversationHistory(activeChatImagePath, { limit: contextLimit });
    const prompt = buildConversationPrompt(aiConfig.AI_PROMPT, existingHistory, userMessage, {
        contextLimit
    });
    let entryId = options.entryId || null;
    if (!entryId) {
        const entry = await appendConversationEntry(activeChatImagePath, 'user', userMessage, {
            status: MESSAGE_STATUS.SENDING
        });
        entryId = entry?.id || null;
    } else {
        await updateConversationEntry(activeChatImagePath, entryId, {
            status: MESSAGE_STATUS.SENDING,
            error: ''
        });
    }
    await renderChatHistory();

    cleanupPreviousRequest(activeChatImagePath);
    setChatSendingState(true);
    setChatStatus('她正在思考...', 'muted');
    setPendingMessageContext(activeChatImagePath, entryId);

    try {
        const response = await performGenerateRequest(activeChatImagePath, aiConfig, {
            promptOverride: prompt
        });
        if (response.ok) {
            const data = await response.json();
            const result = await handleGenerationResult(data, activeChatImagePath, aiConfig, { mode: 'chat' });
            if (!result?.ok) {
                await markPendingMessageFailed(result?.reason || '发送失败，请稍后再试');
                return;
            }
            await markPendingMessageDelivered();
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
            await markPendingMessageFailed();
        } else if (!error.silent) {
            const fallbackMessage = error.message || '发送失败，请稍后再试';
            const statusMessage = error.detail && error.detail !== fallbackMessage
                ? `${fallbackMessage}（${error.detail}）`
                : fallbackMessage;
            setChatStatus(statusMessage, 'error');
            await markPendingMessageFailed(statusMessage);
        } else {
            await markPendingMessageFailed('发送失败，请稍后再试');
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

    // 修复：移除认证检查，允许所有用户使用 AI 功能（无论是否启用访问密码）
    // 原检查逻辑：if (!validateAuthentication()) { return; }
    // 改为只检查 AI 配置是否完整

    const aiConfig = validateAIConfig();
    if (!aiConfig) {
        isProcessing = false;
        return;
    }

    setChatStatus('她正在酝酿情绪，请稍候...', 'muted');

    try {
        const cached = await checkAICache(imagePath, aiConfig);
        if (cached) {
            await recordInitialAIMessage(imagePath, cached.caption);
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
                await recordInitialAIMessage(imagePath, description);
                setChatStatus('她准备好了，开始聊天吧', 'success');
            } else {
                await recordAIReply(imagePath, description);
            }
            isProcessing = false;
            setChatSendingState(false);
            return { ok: true };
        }

        if (data.code && data.message) {
            if (data.message.includes('AI未能生成有效内容') ||
                data.message.includes('AI处理失败') ||
                data.code === 'AI_PROCESSING_ERROR') {
                const detail = data.detail || data.message;
                setChatStatus(detail, 'error');
                setChatSendingState(false);
                isProcessing = false;
                return { ok: false, reason: detail };
            }

            const quotaError = new Error(data.message);
            quotaError.code = data.code;
            if (data.detail) quotaError.detail = data.detail;
            throw quotaError;
        }

        if (data.message && data.cooldownSeconds) {
            const cooldownMsg = `请等待 ${data.cooldownSeconds} 秒后再试`;
            const statusMessage = `${data.message}，${cooldownMsg}`;
            setChatStatus(statusMessage, 'error');
            setChatSendingState(false);
            if (!isChatMode) {
                showNotification(data.message, 'warning');
            }
            isProcessing = false;
            return { ok: false, reason: statusMessage };
        }

        if (typeof data.result === 'string') {
            await recordInitialAIMessage(imagePath, data.result);
            if (!isChatMode) {
                setChatStatus('她准备好了，开始聊天吧', 'success');
            } else {
                setChatSendingState(false);
            }
            isProcessing = false;
            return { ok: true };
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
