/**
 * @file ai-conversation-store.js
 * @description 管理前端侧 AI 对话历史（仅存储在浏览器，保障隐私）
 */

const STORAGE_KEY = 'ai_conversations_v1';
const MAX_ENTRIES = 12; // 约 6 轮对话
let inMemoryStore = loadFromSession();

function loadFromSession() {
    if (typeof sessionStorage === 'undefined') return {};
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
        return {};
    }
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

export function getConversationHistory(imagePath) {
    if (!imagePath) return [];
    const history = inMemoryStore[imagePath];
    if (!Array.isArray(history)) return [];
    return history.map(entry => ({ ...entry }));
}

export function appendConversationEntry(imagePath, role, message) {
    if (!imagePath) return getConversationHistory(imagePath);
    const text = sanitizeMessage(message);
    if (!text) return getConversationHistory(imagePath);
    const history = Array.isArray(inMemoryStore[imagePath]) ? inMemoryStore[imagePath].slice() : [];
    history.push({
        role: role === 'user' ? 'user' : 'ai',
        message: text,
        timestamp: Date.now()
    });
    inMemoryStore[imagePath] = history.slice(-MAX_ENTRIES);
    persistStore();
    return getConversationHistory(imagePath);
}

export function clearConversationHistory(imagePath) {
    if (!imagePath) return;
    delete inMemoryStore[imagePath];
    persistStore();
}

export function buildConversationPrompt(basePrompt, history, userMessage) {
    const prefix = (basePrompt || '').trim();
    const safeHistory = Array.isArray(history) ? history : [];
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
            const text = sanitizeMessage(entry.message);
            if (!text) continue;
            sanitizedEntries.push({
                role: entry.role === 'user' ? 'user' : 'ai',
                message: text,
                timestamp: Number(entry.timestamp) || Date.now()
            });
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
