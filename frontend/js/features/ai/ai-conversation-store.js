/**
 * @file ai-conversation-store.js
 * @description 管理前端侧 AI 对话历史（仅存储在浏览器，保障隐私）
 */

const STORAGE_KEY = 'ai_conversations_v1';
const MAX_ENTRIES = 12; // 约 6 轮对话
export const MESSAGE_STATUS = {
    SENDING: 'sending',
    FAILED: 'failed',
    DELIVERED: 'delivered'
};

let inMemoryStore = loadFromSession();

function loadFromSession() {
    if (typeof sessionStorage === 'undefined') return {};
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return normalizeStore(typeof parsed === 'object' && parsed !== null ? parsed : {});
    } catch {
        return {};
    }
}

function normalizeStore(source) {
    if (!source || typeof source !== 'object') return {};
    const normalized = {};
    for (const [key, history] of Object.entries(source)) {
        if (!key || !Array.isArray(history)) continue;
        const trimmedKey = key.trim();
        if (!trimmedKey) continue;
        const normalizedEntries = history
            .map(entry => normalizeEntry(entry))
            .filter(Boolean);
        if (normalizedEntries.length) {
            normalized[trimmedKey] = normalizedEntries.slice(-MAX_ENTRIES);
        }
    }
    return normalized;
}

function persistStore() {
    if (typeof sessionStorage === 'undefined') return;
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(inMemoryStore));
    } catch {
        // 忽略持久化异常，维持内存状态
    }
}

function sanitizeMessage(message) {
    if (typeof message !== 'string') return '';
    return message.trim();
}

function sanitizeStatus(status) {
    if (status === MESSAGE_STATUS.SENDING || status === MESSAGE_STATUS.FAILED || status === MESSAGE_STATUS.DELIVERED) {
        return status;
    }
    return MESSAGE_STATUS.DELIVERED;
}

function generateMessageId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const role = entry.role === 'user' ? 'user' : 'ai';
    const message = sanitizeMessage(entry.message);
    if (!message) return null;
    return {
        id: typeof entry.id === 'string' && entry.id ? entry.id : generateMessageId(),
        role,
        message,
        timestamp: Number(entry.timestamp) || Date.now(),
        status: sanitizeStatus(entry.status),
        error: sanitizeMessage(entry.error)
    };
}

function createEntry(role, message, options = {}) {
    const text = sanitizeMessage(message);
    if (!text) return null;
    return {
        id: options.id || generateMessageId(),
        role: role === 'user' ? 'user' : 'ai',
        message: text,
        timestamp: options.timestamp ? Number(options.timestamp) || Date.now() : Date.now(),
        status: sanitizeStatus(options.status || MESSAGE_STATUS.DELIVERED),
        error: sanitizeMessage(options.error)
    };
}

export function getConversationHistory(imagePath) {
    if (!imagePath) return [];
    const history = inMemoryStore[imagePath];
    if (!Array.isArray(history)) return [];
    return history.map(entry => ({ ...entry }));
}

export function appendConversationEntry(imagePath, role, message, options = {}) {
    if (!imagePath) return getConversationHistory(imagePath);
    const entry = createEntry(role, message, options);
    if (!entry) return getConversationHistory(imagePath);
    const history = Array.isArray(inMemoryStore[imagePath]) ? inMemoryStore[imagePath].slice() : [];
    history.push(entry);
    inMemoryStore[imagePath] = history.slice(-MAX_ENTRIES);
    persistStore();
    return entry;
}

export function clearConversationHistory(imagePath) {
    if (!imagePath) return;
    delete inMemoryStore[imagePath];
    persistStore();
}

export function updateConversationEntry(imagePath, entryId, patch = {}) {
    if (!imagePath || !entryId) return null;
    const history = Array.isArray(inMemoryStore[imagePath]) ? inMemoryStore[imagePath].slice() : [];
    const index = history.findIndex(entry => entry.id === entryId);
    if (index === -1) return null;
    const existing = history[index];
    const nextEntry = { ...existing };
    if (Object.prototype.hasOwnProperty.call(patch, 'message')) {
        const nextMessage = sanitizeMessage(patch.message);
        if (nextMessage) {
            nextEntry.message = nextMessage;
        }
    }
    if (patch.status) {
        nextEntry.status = sanitizeStatus(patch.status);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'error')) {
        nextEntry.error = sanitizeMessage(patch.error);
    }
    if (patch.timestamp) {
        nextEntry.timestamp = Number(patch.timestamp) || nextEntry.timestamp;
    }
    history[index] = nextEntry;
    inMemoryStore[imagePath] = history;
    persistStore();
    return { ...nextEntry };
}

export function buildConversationPrompt(basePrompt, history, userMessage) {
    const prefix = (basePrompt || '').trim();
    const safeHistory = Array.isArray(history)
        ? history.filter(entry => entry.status !== MESSAGE_STATUS.FAILED)
        : [];
    const transcript = safeHistory
        .map(entry => {
            const speaker = entry.role === 'user' ? '访客' : '我';
            return `${speaker}：${entry.message}`;
        })
        .join('\n');
    const userLine = `访客：${sanitizeMessage(userMessage)}`;
    const header = `${prefix}\n\n请继续扮演照片中的人物，保持第一人称，语气自然亲密，每次回复不超过80字。`;
    return `${header}\n${transcript ? `${transcript}\n` : ''}${userLine}\n我：`;
}

export function exportConversationHistory() {
    return JSON.parse(JSON.stringify(inMemoryStore || {}));
}

export function importConversationHistory(payload) {
    if (!payload || typeof payload !== 'object') {
        return { ok: false, reason: '文件格式不正确' };
    }
    const source = payload.conversations && typeof payload.conversations === 'object'
        ? payload.conversations
        : payload;
    if (!source || typeof source !== 'object') {
        return { ok: false, reason: '缺少 conversations 字段' };
    }
    const nextStore = {};
    let conversations = 0;
    let entries = 0;
    for (const [key, history] of Object.entries(source)) {
        if (typeof key !== 'string' || !key.trim() || !Array.isArray(history)) continue;
        const normalizedKey = key.trim();
        const sanitizedEntries = [];
        for (const entry of history) {
            if (!entry || typeof entry !== 'object') continue;
            const normalizedEntry = createEntry(entry.role === 'user' ? 'user' : 'ai', entry.message, {
                id: typeof entry.id === 'string' && entry.id ? entry.id : undefined,
                timestamp: entry.timestamp,
                status: entry.status,
                error: entry.error
            });
            if (!normalizedEntry) continue;
            sanitizedEntries.push(normalizedEntry);
            if (sanitizedEntries.length >= MAX_ENTRIES) break;
        }
        if (sanitizedEntries.length === 0) continue;
        nextStore[normalizedKey] = sanitizedEntries;
        conversations += 1;
        entries += sanitizedEntries.length;
    }
    inMemoryStore = nextStore;
    persistStore();
    return { ok: true, stats: { conversations, entries } };
}
