/**
 * @file ai-conversation-store.js
 * @description 管理 AI 密语对话历史（IndexedDB 持久化 + sessionStorage 兼容）
 */

import { AI_CHAT } from '../../core/constants.js';
import { createModuleLogger } from '../../core/logger.js';

const STORAGE_KEY = 'ai_conversations_v1'; // 兼容旧版存储
export const MESSAGE_STATUS = {
    SENDING: 'sending',
    FAILED: 'failed',
    DELIVERED: 'delivered'
};

export const MESSAGE_TYPE = {
    TEXT: 'text',
    IMAGE: 'image',
    LOADING: 'loading'
};

const chatLogger = createModuleLogger('AI-ConversationStore');

const DB_CONFIG = {
    DB_NAME: AI_CHAT?.DB_NAME || 'ai-conversations-db',
    STORE_NAME: AI_CHAT?.STORE_NAME || 'ai-conversations',
    VERSION: AI_CHAT?.VERSION || 1,
    MAX_PER_IMAGE: AI_CHAT?.MAX_HISTORY_PER_IMAGE || 1000,
    CONTEXT_LIMIT: AI_CHAT?.CONTEXT_MESSAGE_LIMIT || 20
};

let canUseIndexedDB = typeof indexedDB !== 'undefined';
let conversationDB = null;
let legacyStore = loadLegacySessionStore();

function disableIndexedDBSupport(reason) {
    if (!canUseIndexedDB) return;
    canUseIndexedDB = false;
    try {
        if (conversationDB?.db && typeof conversationDB.db.close === 'function') {
            conversationDB.db.close();
        }
    } catch { }
    conversationDB = null;
    const message = reason?.message || reason;
    chatLogger.warn('IndexedDB unavailable, fallback to sessionStorage', message);
}

class ConversationDatabase {
    constructor() {
        this.db = null;
        this.isInitialized = false;
        this.initPromise = this.initialize().catch((error) => {
            disableIndexedDBSupport(error);
        });
    }

    async initialize() {
        if (this.isInitialized) return;
        this.db = await this.openDatabase();
        this.isInitialized = true;
        await this.migrateLegacySessionStore();
    }

    openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_CONFIG.DB_NAME, DB_CONFIG.VERSION);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(DB_CONFIG.STORE_NAME)) {
                    const store = db.createObjectStore(DB_CONFIG.STORE_NAME, { keyPath: 'id', autoIncrement: true });
                    store.createIndex('byImagePath', 'imagePath', { unique: false });
                    store.createIndex('byImageTimestamp', ['imagePath', 'timestamp'], { unique: false });
                }
            };
        });
    }

    async migrateLegacySessionStore() {
        if (!legacyStore || Object.keys(legacyStore).length === 0) return;
        const tasks = [];
        for (const [imagePath, history] of Object.entries(legacyStore)) {
            if (!imagePath || !Array.isArray(history)) continue;
            tasks.push(this.bulkInsert(imagePath, history));
        }
        legacyStore = {};
        if (typeof sessionStorage !== 'undefined') {
            try {
                sessionStorage.removeItem(STORAGE_KEY);
            } catch { }
        }
        await Promise.allSettled(tasks);
        chatLogger.info('Migrated legacy AI chat history to IndexedDB');
    }

    bulkInsert(imagePath, history = []) {
        if (!history.length) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([DB_CONFIG.STORE_NAME], 'readwrite');
            const store = tx.objectStore(DB_CONFIG.STORE_NAME);
            history.forEach(entry => {
                const normalized = normalizeEntry(entry);
                if (!normalized) return;
                const payload = { ...normalized, imagePath };
                delete payload.id;
                store.add(payload);
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async addEntry(imagePath, entry) {
        if (!imagePath || !entry) return null;
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([DB_CONFIG.STORE_NAME], 'readwrite');
            const store = tx.objectStore(DB_CONFIG.STORE_NAME);
            const record = { ...entry, imagePath };
            delete record.id;
            const request = store.add(record);
            request.onsuccess = async (event) => {
                const savedEntry = { ...record, id: event.target.result };
                try {
                    await this.trimHistory(imagePath);
                } catch (error) {
                    chatLogger.warn('trim conversation history failed', error);
                }
                resolve(savedEntry);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async getHistory(imagePath, options = {}) {
        if (!imagePath) return [];
        await this.initPromise;
        const limit = Number(options.limit);
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([DB_CONFIG.STORE_NAME], 'readonly');
            const store = tx.objectStore(DB_CONFIG.STORE_NAME);
            const index = store.index('byImageTimestamp');
            const range = IDBKeyRange.bound([imagePath, 0], [imagePath, Number.MAX_SAFE_INTEGER]);
            const items = [];
            const request = index.openCursor(range, 'next');
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    items.push(cursor.value);
                    cursor.continue();
                }
            };
            request.onerror = () => reject(request.error);
            tx.oncomplete = () => {
                if (limit > 0 && items.length > limit) {
                    resolve(items.slice(-limit));
                } else {
                    resolve(items);
                }
            };
            tx.onerror = () => reject(tx.error);
        });
    }

    async updateEntry(imagePath, entryId, patch = {}) {
        if (!imagePath || entryId === undefined || entryId === null) return null;
        await this.initPromise;
        const numericId = Number(entryId);
        const lookupId = Number.isFinite(numericId) ? numericId : String(entryId);
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([DB_CONFIG.STORE_NAME], 'readwrite');
            const store = tx.objectStore(DB_CONFIG.STORE_NAME);
            const request = store.get(lookupId);
            request.onsuccess = () => {
                const current = request.result;
                if (!current || current.imagePath !== imagePath) {
                    resolve(null);
                    return;
                }
                const nextEntry = { ...current };
                if (Object.prototype.hasOwnProperty.call(patch, 'message')) {
                    const nextMessage = sanitizeMessage(patch.message);
                    if (nextMessage || nextMessage === '') nextEntry.message = nextMessage;
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
                if (patch.type) {
                    nextEntry.type = patch.type;
                }
                if (Object.prototype.hasOwnProperty.call(patch, 'imageUrl')) {
                    nextEntry.imageUrl = patch.imageUrl || null;
                }
                const updateRequest = store.put(nextEntry);
                updateRequest.onsuccess = () => resolve({ ...nextEntry });
                updateRequest.onerror = () => reject(updateRequest.error);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async clearConversation(imagePath) {
        if (!imagePath) return;
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([DB_CONFIG.STORE_NAME], 'readwrite');
            const store = tx.objectStore(DB_CONFIG.STORE_NAME);
            const index = store.index('byImagePath');
            const range = IDBKeyRange.only(imagePath);
            const request = index.openCursor(range);
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };
            request.onerror = () => reject(request.error);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async exportAll() {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([DB_CONFIG.STORE_NAME], 'readonly');
            const store = tx.objectStore(DB_CONFIG.STORE_NAME);
            const index = store.index('byImageTimestamp');
            const conversations = {};
            const request = index.openCursor();
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const entry = cursor.value;
                    const { imagePath, ...rest } = entry;
                    if (!conversations[imagePath]) {
                        conversations[imagePath] = [];
                    }
                    conversations[imagePath].push(rest);
                    cursor.continue();
                }
            };
            request.onerror = () => reject(request.error);
            tx.oncomplete = () => resolve(conversations);
            tx.onerror = () => reject(tx.error);
        });
    }

    async replaceAll(conversationsMap) {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([DB_CONFIG.STORE_NAME], 'readwrite');
            const store = tx.objectStore(DB_CONFIG.STORE_NAME);
            store.clear();
            for (const [imagePath, entries] of Object.entries(conversationsMap)) {
                if (!imagePath || !Array.isArray(entries)) continue;
                entries.forEach(entry => {
                    const normalized = createEntry(entry.role, entry.message, {
                        id: entry.id,
                        timestamp: entry.timestamp,
                        status: entry.status,
                        error: entry.error
                    });
                    if (!normalized) return;
                    const payload = { ...normalized, imagePath };
                    delete payload.id;
                    store.add(payload);
                });
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    countEntries(imagePath) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([DB_CONFIG.STORE_NAME], 'readonly');
            const store = tx.objectStore(DB_CONFIG.STORE_NAME);
            const index = store.index('byImagePath');
            const range = IDBKeyRange.only(imagePath);
            const request = index.count(range);
            request.onsuccess = () => resolve(request.result || 0);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 自动清理历史记录，保持每张图片的对话数量在上限内
     * @param {string} imagePath - 图片路径
     * @description
     *   当对话数超过 MAX_PER_IMAGE（默认1000条）时，自动删除最老的消息
     *   删除策略：按时间戳从旧到新遍历（'next'方向），优先删除最早的消息
     */
    async trimHistory(imagePath) {
        if (!DB_CONFIG.MAX_PER_IMAGE || DB_CONFIG.MAX_PER_IMAGE <= 0) return;
        const total = await this.countEntries(imagePath);
        if (total <= DB_CONFIG.MAX_PER_IMAGE) return;
        const excess = total - DB_CONFIG.MAX_PER_IMAGE;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([DB_CONFIG.STORE_NAME], 'readwrite');
            const store = tx.objectStore(DB_CONFIG.STORE_NAME);
            const index = store.index('byImageTimestamp');
            const range = IDBKeyRange.bound([imagePath, 0], [imagePath, Number.MAX_SAFE_INTEGER]);
            let removed = 0;
            // 'next' 方向：按时间戳从旧到新遍历，删除最早的 excess 条消息
            const request = index.openCursor(range, 'next');
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor || removed >= excess) return;
                cursor.delete();  // 删除当前游标指向的记录（最老的）
                removed += 1;
                if (removed < excess) {
                    cursor.continue();  // 继续遍历下一条旧消息
                }
            };
            request.onerror = () => reject(request.error);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
}

if (canUseIndexedDB) {
    conversationDB = new ConversationDatabase();
}
const LEGACY_MAX_ENTRIES = 12;

function loadLegacySessionStore() {
    if (typeof sessionStorage === 'undefined') return {};
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return normalizeLegacyStore(typeof parsed === 'object' && parsed !== null ? parsed : {});
    } catch {
        return {};
    }
}

function normalizeLegacyStore(source) {
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
            normalized[trimmedKey] = normalizedEntries.slice(-LEGACY_MAX_ENTRIES);
        }
    }
    return normalized;
}

function persistLegacyStore() {
    if (typeof sessionStorage === 'undefined') return;
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(legacyStore));
    } catch { }
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
    if (!message && !entry.imageUrl) return null;
    return {
        id: typeof entry.id === 'string' && entry.id ? entry.id : generateMessageId(),
        role,
        message,
        type: entry.type || MESSAGE_TYPE.TEXT,
        imageUrl: entry.imageUrl || null,
        timestamp: Number(entry.timestamp) || Date.now(),
        status: sanitizeStatus(entry.status),
        error: sanitizeMessage(entry.error)
    };
}

function createEntry(role, message, options = {}) {
    const text = sanitizeMessage(message);
    if (!text && !options.imageUrl) return null;
    return {
        id: options.id || generateMessageId(),
        role: role === 'user' ? 'user' : 'ai',
        message: text || '',
        type: options.type || MESSAGE_TYPE.TEXT,
        imageUrl: options.imageUrl || null,
        timestamp: options.timestamp ? Number(options.timestamp) || Date.now() : Date.now(),
        status: sanitizeStatus(options.status || MESSAGE_STATUS.DELIVERED),
        error: sanitizeMessage(options.error)
    };
}

function sliceHistory(history, limit) {
    if (!limit || limit <= 0) return history || [];
    if (!Array.isArray(history) || history.length <= limit) return history || [];
    return history.slice(-limit);
}

export async function getConversationHistory(imagePath, options = {}) {
    if (!imagePath) return [];
    const limit = Number(options.limit);
    if (!canUseIndexedDB || !conversationDB) {
        const history = Array.isArray(legacyStore[imagePath]) ? legacyStore[imagePath].map(entry => ({ ...entry })) : [];
        return limit > 0 ? sliceHistory(history, limit) : history;
    }
    try {
        return await conversationDB.getHistory(imagePath, { limit });
    } catch (error) {
        chatLogger.warn('Failed to read conversation history', error);
        return [];
    }
}

export async function appendConversationEntry(imagePath, role, message, options = {}) {
    if (!imagePath) return null;
    const entry = createEntry(role, message, options);
    if (!entry) return null;
    if (!canUseIndexedDB || !conversationDB) {
        const history = Array.isArray(legacyStore[imagePath]) ? legacyStore[imagePath].slice() : [];
        history.push(entry);
        legacyStore[imagePath] = history.slice(-LEGACY_MAX_ENTRIES);
        persistLegacyStore();
        return { ...entry };
    }
    return conversationDB.addEntry(imagePath, entry);
}

export async function clearConversationHistory(imagePath) {
    if (!imagePath) return;
    if (!canUseIndexedDB || !conversationDB) {
        delete legacyStore[imagePath];
        persistLegacyStore();
        return;
    }
    await conversationDB.clearConversation(imagePath);
}

export async function updateConversationEntry(imagePath, entryId, patch = {}) {
    if (!imagePath || !entryId) return null;
    if (!canUseIndexedDB || !conversationDB) {
        const history = Array.isArray(legacyStore[imagePath]) ? legacyStore[imagePath].slice() : [];
        const index = history.findIndex(entry => entry.id === entryId);
        if (index === -1) return null;
        const existing = history[index];
        const nextEntry = { ...existing };
        if (Object.prototype.hasOwnProperty.call(patch, 'message')) {
            const nextMessage = sanitizeMessage(patch.message);
            if (nextMessage || nextMessage === '') nextEntry.message = nextMessage;
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
        if (patch.type) {
            nextEntry.type = patch.type;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'imageUrl')) {
            nextEntry.imageUrl = patch.imageUrl || null;
        }
        history[index] = nextEntry;
        legacyStore[imagePath] = history;
        persistLegacyStore();
        return { ...nextEntry };
    }
    return conversationDB.updateEntry(imagePath, entryId, patch);
}

export function buildConversationPrompt(basePrompt, history, userMessage, options = {}) {
    const prefix = (basePrompt || '').trim();
    // 过滤失败消息（调用方已在 getConversationHistory 中做了 limit，无需再次 slice）
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

export async function exportConversationHistory() {
    if (!canUseIndexedDB || !conversationDB) {
        return JSON.parse(JSON.stringify(legacyStore || {}));
    }
    try {
        return await conversationDB.exportAll();
    } catch (error) {
        chatLogger.warn('Export history failed', error);
        return {};
    }
}

export async function importConversationHistory(payload) {
    if (!payload || typeof payload !== 'object') {
        return { ok: false, reason: '文件格式不正确' };
    }
    const source = payload.conversations && typeof payload.conversations === 'object'
        ? payload.conversations
        : payload;
    if (!source || typeof source !== 'object') {
        return { ok: false, reason: '缺少 conversations 字段' };
    }

    const normalized = {};
    let conversations = 0;
    let entries = 0;
    for (const [key, history] of Object.entries(source)) {
        if (typeof key !== 'string' || !key.trim() || !Array.isArray(history)) continue;
        const normalizedKey = key.trim();
        const sanitizedEntries = [];
        history.forEach(entry => {
            if (!entry || typeof entry !== 'object') return;
            const normalizedEntry = createEntry(entry.role === 'user' ? 'user' : 'ai', entry.message, {
                id: typeof entry.id === 'string' && entry.id ? entry.id : undefined,
                timestamp: entry.timestamp,
                status: entry.status,
                error: entry.error
            });
            if (normalizedEntry) {
                sanitizedEntries.push(normalizedEntry);
            }
        });
        if (sanitizedEntries.length) {
            normalized[normalizedKey] = sanitizedEntries;
            conversations += 1;
            entries += sanitizedEntries.length;
        }
    }

    if (!canUseIndexedDB || !conversationDB) {
        legacyStore = {};
        Object.entries(normalized).forEach(([path, history]) => {
            legacyStore[path] = history.slice(-LEGACY_MAX_ENTRIES);
        });
        persistLegacyStore();
        return { ok: true, stats: { conversations, entries } };
    }

    await conversationDB.replaceAll(normalized);
    return { ok: true, stats: { conversations, entries } };
}
