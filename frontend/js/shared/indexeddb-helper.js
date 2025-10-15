/**
 * @file frontend/js/shared/indexeddb-helper.js
 * @description 提供 IndexedDB 缓存管理、加解密与清理相关工具
 */

import { getTunableConfig } from '../core/constants.js';
import { createModuleLogger } from '../core/logger.js';
import { INDEXEDDB } from '../core/constants.js';
import { setManagedInterval } from '../core/timer-manager.js';

/**
 * 轻量级数据加密/解密辅助函数
 * 使用简单的XOR加密 + Base64编码，适合本地存储数据保护
 */
class DataEncryption {
    constructor() {
        // 使用固定的密钥进行轻量级加密
        // 注意：这不是军用级加密，主要是防止明文存储数据泄露
        this.key = 'PhotonixHistoryKey2024';
    }

    /**
     * 加密数据 (只加密数据字段，不加密键)
     * @param {any} data - 要加密的数据
     * @returns {any} 部分加密后的对象
     */
    encrypt(data) {
        try {
            // 只加密数据值部分，保持 path 字段为明文（用作IndexedDB键）
            const { path, ...dataToEncrypt } = data;
            const jsonStr = JSON.stringify(dataToEncrypt);
            const keyBytes = new TextEncoder().encode(this.key);
            const dataBytes = new TextEncoder().encode(jsonStr);

            // 简单的XOR加密
            const encrypted = new Uint8Array(dataBytes.length);
            for (let i = 0; i < dataBytes.length; i++) {
                encrypted[i] = dataBytes[i] ^ keyBytes[i % keyBytes.length];
            }

            // 转换为Base64字符串
            const binaryStr = Array.from(encrypted, byte => String.fromCharCode(byte)).join('');
            const encryptedDataStr = btoa(binaryStr);

            // 返回包含明文path和加密数据值的对象
            return { path, encryptedData: encryptedDataStr };
        } catch (error) {
            indexeddbLogger.warn('数据加密失败，使用原文存储', error);
            return data;
        }
    }

    /**
     * 解密数据
     * @param {any} data - 要解密的数据对象或字符串
     * @returns {any} 解密后的数据
     */
    decrypt(data) {
        try {
            // 检查是否是新格式（包含encryptedData字段）
            if (data && typeof data === 'object' && data.encryptedData) {
                // 新格式：解密encryptedData字段
                const binaryStr = atob(data.encryptedData);
                const encryptedBytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                    encryptedBytes[i] = binaryStr.charCodeAt(i);
                }

                const keyBytes = new TextEncoder().encode(this.key);

                // XOR解密
                const decrypted = new Uint8Array(encryptedBytes.length);
                for (let i = 0; i < encryptedBytes.length; i++) {
                    decrypted[i] = encryptedBytes[i] ^ keyBytes[i % keyBytes.length];
                }

                const jsonStr = new TextDecoder().decode(decrypted);
                const decryptedData = JSON.parse(jsonStr);

                // 重新组合完整对象
                return { path: data.path, ...decryptedData };
            } else {
                // 旧格式或明文数据：尝试作为JSON解析
                indexeddbLogger.warn('检测到旧格式数据，尝试直接解析', data);
                if (typeof data === 'string') {
                    return JSON.parse(data);
                } else {
                    return data;
                }
            }
        } catch (error) {
            indexeddbLogger.warn('数据解密失败，尝试作为JSON解析', error);
            try {
                if (typeof data === 'string') {
                    return JSON.parse(data);
                } else {
                    return data;
                }
            } catch {
                indexeddbLogger.error('数据格式错误');
                return null;
            }
        }
    }
}

// 创建全局加密实例
const dataEncryption = new DataEncryption();

const indexeddbLogger = createModuleLogger('IndexedDB');

/**
 * IndexedDB 数据库助手模块
 * 负责管理用户访问历史的本地存储，支持离线记录和网络恢复后的同步
 */

// 使用统一的INDEXEDDB配置常量

function getAdaptiveLimits() {
    try {
        const mem = Number(navigator.deviceMemory || 4);
        if (mem <= 2) return { MAX_RECORDS: 2000, MAX_AGE_MS: 90 * 24 * 60 * 60 * 1000 };
        if (mem <= 4) return { MAX_RECORDS: 5000, MAX_AGE_MS: INDEXEDDB.DEFAULT_MAX_AGE_MS };
        return { MAX_RECORDS: INDEXEDDB.DEFAULT_MAX_RECORDS, MAX_AGE_MS: INDEXEDDB.DEFAULT_MAX_AGE_MS };
    } catch {
        return { MAX_RECORDS: INDEXEDDB.DEFAULT_MAX_RECORDS, MAX_AGE_MS: INDEXEDDB.DEFAULT_MAX_AGE_MS };
    }
}

const { MAX_RECORDS, MAX_AGE_MS } = getAdaptiveLimits();

/**
 * 打开或创建 IndexedDB 数据库
 * @returns {Promise<IDBDatabase>} 数据库实例
 */
export function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(INDEXEDDB.HISTORY_DB_NAME, 2);
        
        // 数据库升级处理
        req.onupgradeneeded = e => {
            const db = e.target.result;
            let store;
            if (!db.objectStoreNames.contains(INDEXEDDB.HISTORY_STORE_NAME)) {
                // 创建对象存储，使用 path 作为主键
                store = db.createObjectStore(INDEXEDDB.HISTORY_STORE_NAME, { keyPath: 'path' });
            } else {
                store = req.transaction.objectStore(INDEXEDDB.HISTORY_STORE_NAME);
            }
            // 添加时间戳索引
            if (store && !store.indexNames.contains(INDEXEDDB.HISTORY_INDEX_NAME)) {
                store.createIndex(INDEXEDDB.HISTORY_INDEX_NAME, 'timestamp', { unique: false });
            }
        };
        
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = e => reject(e.target.error);
    });
}

// --- IndexedDB 写入微队列（合并多次写入为单事务） ---
let __idbWriteQueue = [];
let __idbFlushScheduled = false;

// 可观测性统计
let idbStats = {
    totalWrites: 0,
    batchesProcessed: 0,
    avgBatchSize: 0,
    lastFlushTime: 0,
    totalFlushDuration: 0,
    lastReported: 0
};

/**
 * 获取批处理延迟，支持全局配置覆盖
 * @returns {number} 批处理延迟（毫秒）
 */
function getBatchDelay() {
    return getTunableConfig('indexeddb', 'batchDelay', 25);
}

/**
 * 记录批处理统计信息
 * @param {number} batchSize - 批大小
 * @param {number} duration - 处理耗时
 */
function recordBatchStats(batchSize, duration) {
    idbStats.totalWrites += batchSize;
    idbStats.batchesProcessed++;
    idbStats.avgBatchSize = (idbStats.avgBatchSize * (idbStats.batchesProcessed - 1) + batchSize) / idbStats.batchesProcessed;
    idbStats.totalFlushDuration += duration;
    idbStats.lastFlushTime = Date.now();

    // 开发模式下定期输出统计信息
    if (idbStats.batchesProcessed % 20 === 0) {
        const avgDuration = idbStats.totalFlushDuration / idbStats.batchesProcessed;
        indexeddbLogger.debug('IndexedDB统计', {
            totalWrites: idbStats.totalWrites,
            batchesProcessed: idbStats.batchesProcessed,
            avgBatchSize: idbStats.avgBatchSize.toFixed(1),
            avgDuration: avgDuration.toFixed(1) + 'ms'
        });
    }
}

async function __flushViewedWrites(db) {
    if (!__idbWriteQueue.length) return;
    const batch = __idbWriteQueue;
    __idbWriteQueue = [];
    __idbFlushScheduled = false;

    const startTime = performance.now();

    return new Promise(resolve => {
        try {
            const tx = db.transaction(INDEXEDDB.HISTORY_STORE_NAME, 'readwrite');
            const store = tx.objectStore(INDEXEDDB.HISTORY_STORE_NAME);
            for (const rec of batch) {
                // 加密数据后存储
                const encryptedData = dataEncryption.encrypt(rec);
                store.put(encryptedData);
            }
            tx.oncomplete = () => {
                const duration = performance.now() - startTime;
                recordBatchStats(batch.length, duration);
                resolve();
            };
            tx.onerror = () => {
                const duration = performance.now() - startTime;
                recordBatchStats(batch.length, duration);
                resolve();
            };
            tx.onabort = () => {
                const duration = performance.now() - startTime;
                recordBatchStats(batch.length, duration);
                resolve();
            };
        } catch {
            const duration = performance.now() - startTime;
            recordBatchStats(batch.length, duration);
            resolve();
        }
    });
}

/**
 * 保存访问记录到本地数据库
 * @param {string} path - 访问的路径
 * @param {number} timestamp - 访问时间戳（默认当前时间）
 * @param {boolean} synced - 是否已同步到服务器（默认false）
 * @returns {Promise} 事务完成Promise
 */
export async function saveViewed(path, timestamp = Date.now(), synced = false) {
    const db = await openDb();

    // 入队，延迟批量写入到单事务，降低主线程阻塞
    __idbWriteQueue.push({ path, timestamp, synced });
    if (!__idbFlushScheduled) {
        __idbFlushScheduled = true;
        const batchDelay = getBatchDelay();
        setTimeout(() => { __flushViewedWrites(db); }, batchDelay);
    }

    // 保持原有清理触发策略
    scheduleRetention();
    return true;
}

/**
 * 立即写入访问记录（逃逸API，用于关键路径）
 * @param {string} path - 访问的路径
 * @param {number} timestamp - 访问时间戳（默认当前时间）
 * @param {boolean} synced - 是否已同步到服务器（默认false）
 * @returns {Promise} 事务完成Promise
 */
export async function saveViewedImmediate(path, timestamp = Date.now(), synced = false) {
    const db = await openDb();

    return new Promise(resolve => {
        try {
            const tx = db.transaction(INDEXEDDB.HISTORY_STORE_NAME, 'readwrite');
            const store = tx.objectStore(INDEXEDDB.HISTORY_STORE_NAME);
            // 加密数据后存储
            const encryptedData = dataEncryption.encrypt({ path, timestamp, synced });
            store.put(encryptedData);

            tx.oncomplete = () => {
                // 记录即时写入统计
                recordBatchStats(1, 0);
                resolve();
            };
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        } catch {
            resolve();
        }
    });
}

/**
 * 获取IndexedDB统计信息
 * @returns {object} 统计信息
 */
export function getIndexedDBStats() {
    return {
        ...idbStats,
        queueSize: __idbWriteQueue.length,
        isFlushScheduled: __idbFlushScheduled,
        avgFlushDuration: idbStats.batchesProcessed > 0
            ? idbStats.totalFlushDuration / idbStats.batchesProcessed
            : 0
    };
}

/**
 * 获取所有访问记录
 * @returns {Promise<Array>} 访问记录数组
 */
export async function getAllViewed() {
    const db = await openDb();
    const tx = db.transaction(INDEXEDDB.HISTORY_STORE_NAME, 'readonly');
    const store = tx.objectStore(INDEXEDDB.HISTORY_STORE_NAME);

    return new Promise(resolve => {
        const req = store.getAll();
        req.onsuccess = () => {
            const encryptedData = req.result || [];
            // 解密数据
            const decryptedData = encryptedData
                .map(data => dataEncryption.decrypt(data))
                .filter(data => data !== null); // 过滤解密失败的数据
            resolve(decryptedData);
        };
        req.onerror = () => resolve([]);  // 出错时返回空数组
    });
}

/**
 * 获取未同步的访问记录
 * 用于网络恢复后批量同步到服务器
 * @returns {Promise<Array>} 未同步的记录数组
 */
export async function getUnsyncedViewed() {
    const db = await openDb();
    const tx = db.transaction(INDEXEDDB.HISTORY_STORE_NAME, 'readonly');
    const store = tx.objectStore(INDEXEDDB.HISTORY_STORE_NAME);
    
    return new Promise(resolve => {
        const req = store.openCursor();
        const unsynced = [];
        
        req.onsuccess = e => {
            const cursor = e.target.result;
            if (cursor) {
                // 解密数据
                const decryptedData = dataEncryption.decrypt(cursor.value);
                if (decryptedData && !decryptedData.synced) {
                    unsynced.push(decryptedData);
                }
                cursor.continue();
            } else {
                resolve(unsynced);
            }
        };
    });
}

/**
 * 标记访问记录为已同步
 * 在成功同步到服务器后调用
 * @param {string} path - 要标记的路径
 * @returns {Promise} 事务完成Promise
 */
export async function markAsSynced(path) {
    const db = await openDb();
    const tx = db.transaction(INDEXEDDB.HISTORY_STORE_NAME, 'readwrite');
    const store = tx.objectStore(INDEXEDDB.HISTORY_STORE_NAME);

    // 获取记录并更新同步状态
    const storedRecord = await store.get(path);
    if (storedRecord) {
        // 解密数据
        const record = dataEncryption.decrypt(storedRecord);
        if (record) {
            record.synced = true;
            // 重新加密后存储
            const encryptedData = dataEncryption.encrypt(record);
            store.put(encryptedData);
        }
    }

    await tx.complete;
    return true;
} 

/**
 * 执行 LRU/时间窗清理
 * - 删除超过 MAX_AGE_MS 的记录
 * - 超过 MAX_RECORDS 时，仅保留最近访问的前 MAX_RECORDS 条
 */
export async function enforceRetention(dbInstance = null) {
    const db = dbInstance || await openDb();

    // 分批删除工具：按游标遍历，最多删除 batchLimit 条
    async function deleteByCursor(source, predicate, batchLimit = INDEXEDDB.BATCH_DELETE_SIZE) {
        return new Promise(resolve => {
            let deleted = 0;
            const req = source.openCursor();
            req.onsuccess = e => {
                const cursor = e.target.result;
                if (!cursor || deleted >= batchLimit) return resolve(deleted);
                // 解密数据进行判断
                const val = dataEncryption.decrypt(cursor.value);
                if (val && predicate(val)) {
                    cursor.delete();
                    deleted++;
                }
                cursor.continue();
            };
            req.onerror = () => resolve(deleted);
        });
    }

    const now = Date.now();
    const cutoff = now - MAX_AGE_MS;

    // 1) 时间窗清理：删除 timestamp < cutoff
    const tx1 = db.transaction(INDEXEDDB.HISTORY_STORE_NAME, 'readwrite');
    const index1 = tx1.objectStore(INDEXEDDB.HISTORY_STORE_NAME).index(INDEXEDDB.HISTORY_INDEX_NAME);
    await deleteByCursor(index1, (val) => (val.timestamp || 0) < cutoff, INDEXEDDB.BATCH_DELETE_SIZE);
    await tx1.complete;

    // 2) 条数裁剪：超出 MAX_RECORDS，从最老开始裁剪
    const total = await new Promise(resolve => {
        const tx = db.transaction(INDEXEDDB.HISTORY_STORE_NAME, 'readonly');
        const store = tx.objectStore(INDEXEDDB.HISTORY_STORE_NAME);
        const c = store.count();
        c.onsuccess = () => resolve(c.result || 0);
        c.onerror = () => resolve(0);
    });
    if (total > MAX_RECORDS) {
        const toDelete = Math.min(INDEXEDDB.BATCH_DELETE_SIZE, total - MAX_RECORDS);
        const tx2 = db.transaction(INDEXEDDB.HISTORY_STORE_NAME, 'readwrite');
        const index2 = tx2.objectStore(INDEXEDDB.HISTORY_STORE_NAME).index(INDEXEDDB.HISTORY_INDEX_NAME);
        await deleteByCursor(index2, () => true, toDelete);
        await tx2.complete;
    }

    return true;
}

// 按需与空闲调度清理
let retentionScheduled = false;
function scheduleRetention() {
    if (retentionScheduled) return;
    retentionScheduled = true;
    const runner = async () => {
        try { await enforceRetention(); } finally { retentionScheduled = false; }
    };
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => runner(), { timeout: INDEXEDDB.IDLE_CALLBACK_TIMEOUT });
    } else {
        setTimeout(runner, INDEXEDDB.RETENTION_RUNNER_DELAY);
    }
}

// 触发时机：页面转后台、网络恢复、定时器、模块加载
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') scheduleRetention();
    });
}
if (typeof window !== 'undefined') {
    window.addEventListener('online', () => scheduleRetention());
    setManagedInterval(() => scheduleRetention(), 5 * 60 * 1000, 'retention-cleanup');
}
scheduleRetention();