const Database = require('better-sqlite3');
const os = require('os');
const {
    DB_FILE,
    SETTINGS_DB_FILE,
    INDEX_DB_FILE
} = require('../config');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const { getCachedQueryResult, cacheQueryResult, generateQueryKey } = require('../services/cache.service');

const DEFAULT_BUSY_TIMEOUT_MS = Number(process.env.SQLITE_BUSY_TIMEOUT || 10000);
const DEFAULT_QUERY_TIMEOUT_MS = Number(process.env.SQLITE_QUERY_TIMEOUT || 30000);
const JOURNAL_MODE = process.env.SQLITE_JOURNAL_MODE || 'WAL';
const SYNCHRONOUS = process.env.SQLITE_SYNCHRONOUS || 'NORMAL';
const TEMP_STORE = process.env.SQLITE_TEMP_STORE || 'MEMORY';
const SLOW_QUERY_MS = Number(process.env.SQLITE_SLOW_QUERY_MS || 2000);
const SQLITE_INTERRUPT_MS = Number(process.env.SQLITE_INTERRUPT_MS || 0);

function deriveCacheSize() {
    if (process.env.SQLITE_CACHE_SIZE) {
        return parseInt(process.env.SQLITE_CACHE_SIZE, 10);
    }
    const totalMem = os.totalmem();
    if (totalMem >= 16 * 1024 * 1024 * 1024) return -65536;
    if (totalMem >= 8 * 1024 * 1024 * 1024) return -32768;
    if (totalMem >= 4 * 1024 * 1024 * 1024) return -16384;
    return -8192;
}

function deriveMmapSize() {
    if (process.env.SQLITE_MMAP_SIZE) {
        return parseInt(process.env.SQLITE_MMAP_SIZE, 10);
    }
    const totalMem = os.totalmem();
    if (totalMem >= 16 * 1024 * 1024 * 1024) return 1024 * 1024 * 1024;
    if (totalMem >= 8 * 1024 * 1024 * 1024) return 512 * 1024 * 1024;
    if (totalMem >= 4 * 1024 * 1024 * 1024) return 384 * 1024 * 1024;
    return 256 * 1024 * 1024;
}

const CACHE_SIZE = deriveCacheSize();
const MMAP_SIZE = deriveMmapSize();
const connections = {};

function logIfSlow(sql, startedAt, label) {
    if (!sql || !Number.isFinite(SLOW_QUERY_MS) || SLOW_QUERY_MS <= 0) return;
    const elapsed = Date.now() - startedAt;
    if (elapsed > SLOW_QUERY_MS) {
        const sqlUpper = String(sql).toUpperCase().trim();
        // 维护命令（ANALYZE, PRAGMA optimize 等）预期耗时较长，使用 info 级别
        const isMaintenance = sqlUpper.startsWith('ANALYZE') || sqlUpper.includes('PRAGMA OPTIMIZE');
        const logFn = isMaintenance ? logger.debug.bind(logger) : logger.warn.bind(logger);
        logFn(`${LOG_PREFIXES.SQLITE} ${label} 慢查询 ${elapsed}ms | SQL: ${String(sql).slice(0, 200)}`);
    }
}


function scheduleInterrupt(db, sql, label) {
    if (!db || !Number.isFinite(SQLITE_INTERRUPT_MS) || SQLITE_INTERRUPT_MS <= 0) return null;
    const timer = setTimeout(() => {
        try {
            db.interrupt();
            logger.error(`${LOG_PREFIXES.SQLITE} ${label} 强制中断超时查询 (${SQLITE_INTERRUPT_MS}ms): ${String(sql).slice(0, 200)}`);
        } catch (err) {
            logger.debug(`${LOG_PREFIXES.SQLITE} 尝试中断查询失败（忽略）`, { error: err && err.message });
        }
    }, SQLITE_INTERRUPT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
}

function applyPragmas(db, label) {
    try {
        db.pragma(`synchronous = ${SYNCHRONOUS}`);
        db.pragma(`temp_store = ${TEMP_STORE}`);
        db.pragma(`cache_size = ${CACHE_SIZE}`);
        db.pragma(`journal_mode = ${JOURNAL_MODE}`);
        db.pragma(`mmap_size = ${MMAP_SIZE}`);
        db.pragma('foreign_keys = ON');
        db.pragma(`busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
        db.pragma('optimize');
    } catch (error) {
        logger.debug(`${LOG_PREFIXES.SQLITE} ${label} PRAGMA 设置失败（忽略）: ${error.message}`);
    }
}

function createConnection(path, label) {
    const db = new Database(path, {
        timeout: DEFAULT_BUSY_TIMEOUT_MS,
        verbose: null
    });
    applyPragmas(db, label);
    return db;
}

async function initializeConnections() {
    connections.main = createConnection(DB_FILE, 'main');
    connections.settings = createConnection(SETTINGS_DB_FILE, 'settings');
    connections.index = createConnection(INDEX_DB_FILE, 'index');
    logger.info(`${LOG_PREFIXES.SQLITE} 所有数据库连接已建立`);
    return connections;
}

function getDbPath(dbType) {
    switch (dbType) {
        case 'main': return DB_FILE;
        case 'settings': return SETTINGS_DB_FILE;
        case 'index': return INDEX_DB_FILE;
        default: {
            const { ValidationError } = require('../utils/errors');
            throw new ValidationError(`未知数据库类型: ${dbType}`, { dbType });
        }
    }
}

function getDB(dbType = 'main') {
    const db = connections[dbType];
    if (!db) {
        const { DatabaseError } = require('../utils/errors');
        throw new DatabaseError(`数据库连接 ${dbType} 不存在`, { dbType, availableTypes: Object.keys(connections) });
    }
    return db;
}

async function closeAllConnections() {
    Object.entries(connections).forEach(([name, db]) => {
        if (!db) return;
        try {
            db.close();
            logger.info(`${LOG_PREFIXES.SQLITE} 关闭 ${name} 连接`);
        } catch (error) {
            logger.warn(`${LOG_PREFIXES.SQLITE} 关闭 ${name} 连接失败: ${error.message}`);
        }
    });
}

function withTimeout(promise, ms = DEFAULT_QUERY_TIMEOUT_MS, info = {}) {
    // 注意：better-sqlite3 是同步驱动，withTimeout 只会拒绝 Promise。
    // 若设置 SQLITE_INTERRUPT_MS，会额外调用 db.interrupt() 试图打断阻塞查询；
    // 重型/长时间任务仍应迁移到 Worker 或拆分分页，避免主线程饥饿。
    let timerId;
    return new Promise((resolve, reject) => {
        timerId = setTimeout(() => {
            const error = new Error(`Query timed out after ${ms}ms${info.sql ? ` | SQL: ${info.sql}` : ''}`);
            error.code = 'SQLITE_TIMEOUT';
            reject(error);
        }, ms);

        promise.then((val) => {
            clearTimeout(timerId);
            resolve(val);
        }).catch((err) => {
            clearTimeout(timerId);
            reject(err);
        });
    });
}

function runAsync(dbType, sql, params = [], successMessage = '') {
    const startedAt = Date.now();
    const db = getDB(dbType);
    const interruptTimer = scheduleInterrupt(db, sql, dbType);
    const promise = new Promise((resolve, reject) => {
        try {
            const stmt = db.prepare(sql);
            const info = stmt.run(...params);
            if (successMessage) logger.info(`[${dbType}] ${successMessage}`);
            resolve({
                lastID: info.lastInsertRowid,
                changes: info.changes
            });
        } catch (error) {
            logger.error(`[${dbType}] SQL 执行失败: ${sql}`, error.message);
            reject(error);
        }
    });
    return withTimeout(promise, DEFAULT_QUERY_TIMEOUT_MS, { sql }).finally(() => {
        if (interruptTimer) clearTimeout(interruptTimer);
        logIfSlow(sql, startedAt, dbType);
    });
}

function dbRun(dbType, sql, params = []) {
    const startedAt = Date.now();
    const db = getDB(dbType);
    const interruptTimer = scheduleInterrupt(db, sql, dbType);
    const promise = new Promise((resolve, reject) => {
        try {
            const stmt = db.prepare(sql);
            const info = stmt.run(...params);
            resolve({
                lastID: info.lastInsertRowid,
                changes: info.changes
            });
        } catch (error) {
            reject(error);
        }
    });
    return withTimeout(promise, DEFAULT_QUERY_TIMEOUT_MS, { sql }).finally(() => {
        if (interruptTimer) clearTimeout(interruptTimer);
        logIfSlow(sql, startedAt, dbType);
    });
}

function dbAll(dbType, sql, params = []) {
    const startedAt = Date.now();
    const db = getDB(dbType);
    const interruptTimer = scheduleInterrupt(db, sql, dbType);
    const promise = new Promise((resolve, reject) => {
        try {
            const stmt = db.prepare(sql);
            resolve(stmt.all(...params));
        } catch (error) {
            reject(error);
        }
    });
    return withTimeout(promise, DEFAULT_QUERY_TIMEOUT_MS, { sql }).finally(() => {
        if (interruptTimer) clearTimeout(interruptTimer);
        logIfSlow(sql, startedAt, dbType);
    });
}

function dbGet(dbType, sql, params = []) {
    const startedAt = Date.now();
    const db = getDB(dbType);
    const interruptTimer = scheduleInterrupt(db, sql, dbType);
    const promise = new Promise((resolve, reject) => {
        try {
            const stmt = db.prepare(sql);
            resolve(stmt.get(...params));
        } catch (error) {
            reject(error);
        }
    });
    return withTimeout(promise, DEFAULT_QUERY_TIMEOUT_MS, { sql }).finally(() => {
        if (interruptTimer) clearTimeout(interruptTimer);
        logIfSlow(sql, startedAt, dbType);
    });
}

function hasColumn(dbType, table, column) {
    const sql = `PRAGMA table_info(${table})`;
    const promise = new Promise((resolve, reject) => {
        try {
            const db = getDB(dbType);
            const rows = db.prepare(sql).all();
            resolve(rows.some(row => row.name === column));
        } catch (error) {
            reject(error);
        }
    });
    return withTimeout(promise, DEFAULT_QUERY_TIMEOUT_MS, { sql });
}

function hasTable(dbType, table) {
    const sql = `SELECT name FROM sqlite_master WHERE type='table' AND name=?`;
    const promise = new Promise((resolve, reject) => {
        try {
            const db = getDB(dbType);
            const rows = db.prepare(sql).all(table);
            resolve(rows.length > 0);
        } catch (error) {
            reject(error);
        }
    });
    return withTimeout(promise, DEFAULT_QUERY_TIMEOUT_MS, { sql });
}

function buildSafeInClause(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return { placeholders: '(NULL)', values: [] };
    }
    const validValues = values.filter((value) => {
        const type = typeof value;
        return type === 'string' || type === 'number' || value === null || value === undefined;
    });
    if (validValues.length === 0) {
        return { placeholders: '(NULL)', values: [] };
    }
    const placeholders = validValues.map(() => '?').join(',');
    return {
        placeholders: `(${placeholders})`,
        values: validValues
    };
}

async function dbAllOnPath(dbPath, sql, params = []) {
    return new Promise((resolve, reject) => {
        try {
            const db = new Database(dbPath, { readonly: true });
            const rows = db.prepare(sql).all(...params);
            db.close();
            resolve(rows);
        } catch (error) {
            reject(error);
        }
    });
}

async function dbAllWithCache(dbType, sql, params = [], cacheOptions = {}) {
    const { useCache = false, ttl = 300, tags = [] } = cacheOptions;
    if (!useCache) {
        return dbAll(dbType, sql, params);
    }
    const queryKey = generateQueryKey(sql, params);
    const cached = await getCachedQueryResult(queryKey);
    if (cached !== null) {
        return cached;
    }
    const result = await dbAll(dbType, sql, params);
    cacheQueryResult(queryKey, result, tags, ttl).catch((error) => {
        logger.debug(`${LOG_PREFIXES.SQLITE} 缓存查询结果失败`, { error: error && error.message });
    });
    return result;
}

async function dbGetWithCache(dbType, sql, params = [], cacheOptions = {}) {
    const { useCache = false, ttl = 300, tags = [] } = cacheOptions;
    if (!useCache) {
        return dbGet(dbType, sql, params);
    }
    const queryKey = generateQueryKey(sql, params);
    const cached = await getCachedQueryResult(queryKey);
    if (cached !== null) {
        return cached;
    }
    const result = await dbGet(dbType, sql, params);
    cacheQueryResult(queryKey, result, tags, ttl).catch((error) => {
        logger.debug(`${LOG_PREFIXES.SQLITE} 缓存查询结果失败`, { error: error && error.message });
    });
    return result;
}

async function runPreparedBatch(dbType, sql, rows, options = {}) {
    const { chunkSize = 500 } = options;
    if (!Array.isArray(rows) || rows.length === 0) return;
    const db = getDB(dbType);
    const exec = db.transaction((batchRows) => {
        const stmt = db.prepare(sql);
        for (const row of batchRows) {
            stmt.run(...row);
        }
    });
    for (let i = 0; i < rows.length; i += chunkSize) {
        exec(rows.slice(i, i + chunkSize));
    }
}

// 注意: 信号处理（SIGINT, SIGTERM）已在 server.js 中集中管理
// 避免重复注册导致竞态条件，server.js 会在退出时调用 closeAllConnections()
process.on('beforeExit', async () => {
    await closeAllConnections();
});

const dbHealthStatus = new Map();

async function checkDatabaseHealth() {
    const checks = Object.entries(connections).map(async ([name, db]) => {
        try {
            if (!db || !db.open) {
                dbHealthStatus.set(name, 'disconnected');
                return;
            }
            // 简单查询测试连接
            db.prepare('SELECT 1').get();
            dbHealthStatus.set(name, 'connected');
        } catch (error) {
            dbHealthStatus.set(name, 'error');
            logger.error(`${LOG_PREFIXES.SQLITE} ${name} 健康检查失败: ${error.message}`);
        }
    });
    await Promise.all(checks);
    return dbHealthStatus;
}

module.exports = {
    initializeConnections,
    getDB,
    closeAllConnections,
    runAsync,
    dbRun,
    dbAll,
    dbGet,
    hasColumn,
    hasTable,
    buildSafeInClause,
    dbAllOnPath,
    dbAllWithCache,
    dbGetWithCache,
    runPreparedBatch,
    withTimeout,
    checkDatabaseHealth,
    dbHealthStatus
};
