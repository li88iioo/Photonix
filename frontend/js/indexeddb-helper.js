// frontend/js/indexeddb-helper.js

/**
 * IndexedDB 数据库助手模块
 * 负责管理用户访问历史的本地存储，支持离线记录和网络恢复后的同步
 */

const DB_NAME = 'gallery-history-db';  // 数据库名称
const STORE_NAME = 'viewed';           // 对象存储名称
const INDEX_NAME = 'by_timestamp';     // 时间戳索引

// 自适应阈值（默认：最多 10000 条，保留最近 180 天）
const DEFAULT_MAX_RECORDS = 10000;
const DEFAULT_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000; // 180 天

function getAdaptiveLimits() {
    try {
        const mem = Number(navigator.deviceMemory || 4);
        if (mem <= 2) return { MAX_RECORDS: 2000, MAX_AGE_MS: 90 * 24 * 60 * 60 * 1000 };
        if (mem <= 4) return { MAX_RECORDS: 5000, MAX_AGE_MS: DEFAULT_MAX_AGE_MS };
        return { MAX_RECORDS: DEFAULT_MAX_RECORDS, MAX_AGE_MS: DEFAULT_MAX_AGE_MS };
    } catch {
        return { MAX_RECORDS: DEFAULT_MAX_RECORDS, MAX_AGE_MS: DEFAULT_MAX_AGE_MS };
    }
}

const { MAX_RECORDS, MAX_AGE_MS } = getAdaptiveLimits();

/**
 * 打开或创建 IndexedDB 数据库
 * @returns {Promise<IDBDatabase>} 数据库实例
 */
export function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 2);
        
        // 数据库升级处理
        req.onupgradeneeded = e => {
            const db = e.target.result;
            let store;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                // 创建对象存储，使用 path 作为主键
                store = db.createObjectStore(STORE_NAME, { keyPath: 'path' });
            } else {
                store = req.transaction.objectStore(STORE_NAME);
            }
            // 添加时间戳索引
            if (store && !store.indexNames.contains(INDEX_NAME)) {
                store.createIndex(INDEX_NAME, 'timestamp', { unique: false });
            }
        };
        
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = e => reject(e.target.error);
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
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ path, timestamp, synced });
    await tx.complete;
    // 改为按需触发的后台清理
    scheduleRetention();
    return true;
}

/**
 * 获取所有访问记录
 * @returns {Promise<Array>} 访问记录数组
 */
export async function getAllViewed() {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    
    return new Promise(resolve => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
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
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    
    return new Promise(resolve => {
        const req = store.openCursor();
        const unsynced = [];
        
        req.onsuccess = e => {
            const cursor = e.target.result;
            if (cursor) {
                // 检查记录是否已同步
                if (!cursor.value.synced) {
                    unsynced.push(cursor.value);
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
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    // 获取记录并更新同步状态
    const record = await store.get(path);
    if (record) {
        record.synced = true;
        store.put(record);
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
    async function deleteByCursor(source, predicate, batchLimit = 200) {
        return new Promise(resolve => {
            let deleted = 0;
            const req = source.openCursor();
            req.onsuccess = e => {
                const cursor = e.target.result;
                if (!cursor || deleted >= batchLimit) return resolve(deleted);
                const val = cursor.value;
                if (predicate(val)) {
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
    const tx1 = db.transaction(STORE_NAME, 'readwrite');
    const index1 = tx1.objectStore(STORE_NAME).index(INDEX_NAME);
    await deleteByCursor(index1, (val) => (val.timestamp || 0) < cutoff, 200);
    await tx1.complete;

    // 2) 条数裁剪：超出 MAX_RECORDS，从最老开始裁剪
    const total = await new Promise(resolve => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const c = store.count();
        c.onsuccess = () => resolve(c.result || 0);
        c.onerror = () => resolve(0);
    });
    if (total > MAX_RECORDS) {
        const toDelete = Math.min(200, total - MAX_RECORDS);
        const tx2 = db.transaction(STORE_NAME, 'readwrite');
        const index2 = tx2.objectStore(STORE_NAME).index(INDEX_NAME);
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
        requestIdleCallback(() => runner(), { timeout: 2000 });
    } else {
        setTimeout(runner, 150);
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
    setInterval(() => scheduleRetention(), 5 * 60 * 1000);
}
scheduleRetention();