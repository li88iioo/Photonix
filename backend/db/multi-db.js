const sqlite3 = require('sqlite3').verbose();
const os = require('os');
const { 
    DB_FILE, 
    SETTINGS_DB_FILE, 
    HISTORY_DB_FILE, 
    INDEX_DB_FILE 
} = require('../config');
const logger = require('../config/logger');

// SQLite PRAGMA：改为智能化自适应，无需 .env
const SQLITE_JOURNAL_MODE = 'WAL';
const SQLITE_SYNCHRONOUS = 'NORMAL';
const SQLITE_TEMP_STORE = 'MEMORY';
// 根据可用内存决定 cache_size（负值=KB），以及 mmap_size（字节）
const totalMem = os.totalmem();
let SQLITE_CACHE_SIZE;
let SQLITE_MMAP_SIZE;
if (totalMem >= 16 * 1024 * 1024 * 1024) { // >=16GB
    SQLITE_CACHE_SIZE = -65536; // 64MB
    SQLITE_MMAP_SIZE = 1024 * 1024 * 1024; // 1GB
} else if (totalMem >= 8 * 1024 * 1024 * 1024) { // >=8GB
    SQLITE_CACHE_SIZE = -32768; // 32MB
    SQLITE_MMAP_SIZE = 512 * 1024 * 1024; // 512MB
} else if (totalMem >= 4 * 1024 * 1024 * 1024) { // >=4GB
    SQLITE_CACHE_SIZE = -16384; // 16MB
    SQLITE_MMAP_SIZE = 384 * 1024 * 1024; // 384MB
} else {
    SQLITE_CACHE_SIZE = -8192;  // 8MB（低内存环境）
    SQLITE_MMAP_SIZE = 256 * 1024 * 1024; // 256MB
}
// 超时初值（可被自适应调度动态调整）
const SQLITE_BUSY_TIMEOUT_DEFAULT = Number.isFinite(parseInt(process.env.SQLITE_BUSY_TIMEOUT, 10))
  ? parseInt(process.env.SQLITE_BUSY_TIMEOUT, 10)
  : 20000; // ms
const QUERY_TIMEOUT_DEFAULT = process.env.SQLITE_QUERY_TIMEOUT
  ? parseInt(process.env.SQLITE_QUERY_TIMEOUT, 10)
  : 30000; // ms

let __dynamicBusyTimeoutMs = SQLITE_BUSY_TIMEOUT_DEFAULT;
let __dynamicQueryTimeoutMs = QUERY_TIMEOUT_DEFAULT;

const BUSY_TIMEOUT_MIN = 10000;
const BUSY_TIMEOUT_MAX = 60000;
const QUERY_TIMEOUT_MIN = 15000;
const QUERY_TIMEOUT_MAX = 60000;

function getQueryTimeoutMs() {
  return __dynamicQueryTimeoutMs;
}

/**
 * 为 Promise 添加超时功能
 * @param {Promise} promise - 要执行的 Promise
 * @param {number} ms - 超时毫秒数
 * @param {object} queryInfo - 查询信息，用于日志记录
 * @returns {Promise} - 带超时的 Promise
 */
const withTimeout = (promise, ms, queryInfo) => {
    let timerId;
    return new Promise((resolve, reject) => {
        timerId = setTimeout(() => {
            const error = new Error(`Query timed out after ${ms}ms. Query: ${queryInfo.sql}`);
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
};

// 数据库连接池
const dbConnections = {};

// 数据库连接健康状态
const dbHealthStatus = new Map();

// 连接监控配置
const DB_HEALTH_CHECK_INTERVAL = Number(process.env.DB_HEALTH_CHECK_INTERVAL || 60000); // 1分钟
const DB_RECONNECT_ATTEMPTS = Number(process.env.DB_RECONNECT_ATTEMPTS || 3);

// 创建数据库连接的通用函数
const createDBConnection = (dbPath, dbName) => {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                logger.error(`无法连接或创建 ${dbName} 数据库: ${err.message}`);
                reject(err);
                return;
            }
            logger.info(`成功连接到 ${dbName} 数据库:`, dbPath);
            
            db.configure('busyTimeout', __dynamicBusyTimeoutMs);
            
            try {
                db.run(`PRAGMA synchronous = ${SQLITE_SYNCHRONOUS};`);
                db.run(`PRAGMA temp_store = ${SQLITE_TEMP_STORE};`);
                db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE};`);
                db.run(`PRAGMA journal_mode = ${SQLITE_JOURNAL_MODE};`);
                db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE};`);
                db.run('PRAGMA foreign_keys = ON;');
            
            // 设置连接健康状态
            dbHealthStatus.set(dbName, 'connected');
            
            // 监听连接错误
            db.on('error', (err) => {
                logger.error(`${dbName} 数据库连接错误:`, err.message);
                dbHealthStatus.set(dbName, 'error');
            });
            
            // 监听连接关闭
            db.on('close', () => {
                logger.warn(`${dbName} 数据库连接已关闭`);
                dbHealthStatus.set(dbName, 'closed');
            });
                db.run('PRAGMA optimize;');
            } catch (e) {
                logger.warn(`${dbName} PRAGMA 优化参数设置失败:`, e.message);
            }
            
            resolve(db);
        });
    });
};

// 初始化所有数据库连接
const initializeConnections = async () => {
    try {
        dbConnections.main = await createDBConnection(DB_FILE, '主数据库');
        dbConnections.settings = await createDBConnection(SETTINGS_DB_FILE, '设置数据库');
        dbConnections.history = await createDBConnection(HISTORY_DB_FILE, '历史记录数据库');
        dbConnections.index = await createDBConnection(INDEX_DB_FILE, '索引数据库');

        // 仅做连接级别配置，避免在此处创建/索引业务表，防止多 Worker 并发下的竞态
        try {
            // 保留位置：如需极早期建表，请使用迁移或服务启动后的 ensureCoreTables()，不要在此处建表
        } catch (e) {
            logger.warn('初始化关键表/索引失败（忽略）:', e && e.message);
        }

        logger.info('所有数据库连接已初始化完成');
        return dbConnections;
    } catch (error) {
        logger.error('初始化数据库连接失败:', error.message);
        throw error;
    }
};

// 获取指定数据库连接
const getDB = (dbType = 'main') => {
    if (!dbConnections[dbType]) {
        throw new Error(`数据库连接 ${dbType} 不存在`);
    }
    return dbConnections[dbType];
};

// 关闭所有数据库连接
const closeAllConnections = () => {
    return Promise.all(
        Object.entries(dbConnections).map(([name, db]) => {
            return new Promise((resolve) => {
                db.close((err) => {
                    if (err) {
                        logger.error(`关闭 ${name} 数据库连接失败:`, err.message);
                    } else {
                        logger.info(`成功关闭 ${name} 数据库连接`);
                    }
                    resolve();
                });
            });
        })
    );
};

// 通用数据库操作函数
const runAsync = (dbType, sql, params = [], successMessage = '') => {
    const db = getDB(dbType);
    const promise = new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) {
                logger.error(`[${dbType}] 数据库操作失败: ${sql}`, err.message);
                return reject(err);
            }
            if (successMessage) logger.info(`[${dbType}] ${successMessage}`);
            resolve(this);
        });
    });
    return withTimeout(promise, getQueryTimeoutMs(), { sql });
};

const dbRun = (dbType, sql, params = []) => {
    const db = getDB(dbType);
    const promise = new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
    return withTimeout(promise, getQueryTimeoutMs(), { sql });
};

const dbAll = (dbType, sql, params = []) => {
    const db = getDB(dbType);
    const promise = new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
    return withTimeout(promise, getQueryTimeoutMs(), { sql });
};

const dbGet = (dbType, sql, params = []) => {
    const db = getDB(dbType);
    const promise = new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
    return withTimeout(promise, getQueryTimeoutMs(), { sql });
};

// 检查表和列是否存在
const hasColumn = (dbType, table, column) => {
    const sql = `PRAGMA table_info(${table})`;
    const promise = new Promise((resolve, reject) => {
        getDB(dbType).all(sql, (err, rows) => {
            if (err) return reject(err);
            resolve(rows.some(row => row.name === column));
        });
    });
    return withTimeout(promise, getQueryTimeoutMs(), { sql     });
};

/**
 * 检查数据库连接健康状态
 */
async function checkDatabaseHealth() {
    const dbTypes = ['main', 'settings', 'history', 'index'];
    
    for (const dbType of dbTypes) {
        const db = dbConnections[dbType];
        if (!db) continue;
        
        try {
            // 执行简单查询测试连接
            await new Promise((resolve, reject) => {
                db.get('SELECT 1 as test', (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row);
                    }
                });
            });
            
            // 连接正常
            if (dbHealthStatus.get(dbType) !== 'connected') {
                logger.info(`${dbType} 数据库连接已恢复`);
                dbHealthStatus.set(dbType, 'connected');
            }
        } catch (error) {
            logger.warn(`${dbType} 数据库连接检查失败:`, error.message);
            dbHealthStatus.set(dbType, 'unhealthy');
            
            // 尝试重新连接
            await attemptReconnect(dbType);
        }
    }
}

/**
 * 尝试重新连接数据库
 */
async function attemptReconnect(dbType) {
    const maxAttempts = DB_RECONNECT_ATTEMPTS;
    let attempts = 0;
    
    while (attempts < maxAttempts) {
        attempts++;
        try {
            logger.info(`尝试重新连接 ${dbType} 数据库 (第${attempts}次)...`);
            
            // 关闭旧连接
            if (dbConnections[dbType]) {
                try {
                    await new Promise((resolve, reject) => {
                        dbConnections[dbType].close((err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                } catch (error) {
                    logger.warn(`关闭 ${dbType} 旧连接失败:`, error.message);
                }
            }
            
            // 重新创建连接
            const dbPath = getDbPath(dbType);
            const dbName = getDbName(dbType);
            dbConnections[dbType] = await createDBConnection(dbPath, dbName);
            
            logger.info(`${dbType} 数据库重新连接成功`);
            return true;
        } catch (error) {
            logger.error(`${dbType} 数据库重新连接失败 (第${attempts}次):`, error.message);
            
            if (attempts < maxAttempts) {
                // 指数退避重试
                const delay = Math.min(1000 * Math.pow(2, attempts - 1), 10000);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    logger.error(`${dbType} 数据库重新连接最终失败，已达到最大重试次数`);
    return false;
}

/**
 * 获取数据库路径
 */
function getDbPath(dbType) {
    switch (dbType) {
        case 'main': return DB_FILE;
        case 'settings': return SETTINGS_DB_FILE;
        case 'history': return HISTORY_DB_FILE;
        case 'index': return INDEX_DB_FILE;
        default: throw new Error(`未知的数据库类型: ${dbType}`);
    }
}

/**
 * 获取数据库名称
 */
function getDbName(dbType) {
    switch (dbType) {
        case 'main': return 'main';
        case 'settings': return 'settings';
        case 'history': return 'history';
        case 'index': return 'index';
        default: return dbType;
    }
}

// 启动数据库健康检查
const dbHealthCheckInterval = setInterval(checkDatabaseHealth, DB_HEALTH_CHECK_INTERVAL);

// 清理数据库健康检查定时器
function cleanupDbHealthCheck() {
    if (dbHealthCheckInterval) {
        clearInterval(dbHealthCheckInterval);
    }
}

// 进程退出时清理数据库连接
process.on('beforeExit', async () => {
    cleanupDbHealthCheck();
    await closeAllConnections();
});
process.on('SIGINT', async () => {
    logger.info('收到 SIGINT 信号，清理数据库连接...');
    cleanupDbHealthCheck();
    await closeAllConnections();
});
process.on('SIGTERM', async () => {
    logger.info('收到 SIGTERM 信号，清理数据库连接...');
    cleanupDbHealthCheck();
    await closeAllConnections();
});

const hasTable = (dbType, table) => {
    const sql = `SELECT name FROM sqlite_master WHERE type='table' AND name=?`;
    const promise = new Promise((resolve, reject) => {
        getDB(dbType).all(sql, [table], (err, rows) => {
            if (err) return reject(err);
            resolve(rows.length > 0);
        });
    });
    return withTimeout(promise, getQueryTimeoutMs(), { sql });
};

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
    dbConnections,
    checkDatabaseHealth,
    attemptReconnect,
    dbHealthStatus,
    /**
     * 动态调节 SQLite 超时参数（全局）
     * busyTimeoutDeltaMs/queryTimeoutDeltaMs 可正可负，内部自动裁剪到[min,max]
     */
    adaptDbTimeouts: ({ busyTimeoutDeltaMs = 0, queryTimeoutDeltaMs = 0 } = {}) => {
        __dynamicBusyTimeoutMs = Math.max(BUSY_TIMEOUT_MIN, Math.min(BUSY_TIMEOUT_MAX, __dynamicBusyTimeoutMs + (busyTimeoutDeltaMs | 0)));
        __dynamicQueryTimeoutMs = Math.max(QUERY_TIMEOUT_MIN, Math.min(QUERY_TIMEOUT_MAX, __dynamicQueryTimeoutMs + (queryTimeoutDeltaMs | 0)));
        try {
            // 同步到已打开连接（新连接会用最新值）
            Object.values(dbConnections).forEach(db => {
                try { db.configure && db.configure('busyTimeout', __dynamicBusyTimeoutMs); } catch {}
            });
        } catch {}
        logger.debug(`DB 超时自适应: busy=${__dynamicBusyTimeoutMs}ms, query=${__dynamicQueryTimeoutMs}ms`);
        return { busyTimeoutMs: __dynamicBusyTimeoutMs, queryTimeoutMs: __dynamicQueryTimeoutMs };
    },
    /**
     * 批量执行预编译语句（Prepared Statement）
     * - 默认内部管理事务（BEGIN IMMEDIATE/COMMIT/ROLLBACK）
     * - 支持分块提交，降低长事务风险
     * - 若在外部事务中调用，可将 manageTransaction 设为 false
     * @param {('main'|'settings'|'history'|'index')} dbType
     * @param {string} sql - 预编译 SQL，例如 INSERT ... VALUES (?, ?, ?)
     * @param {Array<Array<any>>} rows - 参数数组列表
     * @param {Object} options
     * @param {number} [options.chunkSize=500]
     * @param {boolean} [options.manageTransaction=true]
     * @param {string} [options.begin='BEGIN IMMEDIATE']
     * @param {string} [options.commit='COMMIT']
     * @param {string} [options.rollback='ROLLBACK']
     * @returns {Promise<number>} processed - 成功执行的行数
     */
    runPreparedBatch: async function runPreparedBatch(dbType, sql, rows, options = {}) {
        const db = getDB(dbType);
        const chunkSize = Number.isFinite(options.chunkSize) ? options.chunkSize : 500;
        const manageTx = options.manageTransaction !== false; // 默认管理事务
        const begin = options.begin || 'BEGIN IMMEDIATE';
        const commit = options.commit || 'COMMIT';
        const rollback = options.rollback || 'ROLLBACK';
        if (!Array.isArray(rows) || rows.length === 0) return 0;

        const stmt = db.prepare(sql);
        if (manageTx) await dbRun(dbType, begin);
        let processed = 0;
        try {
            for (let i = 0; i < rows.length; i += chunkSize) {
                const slice = rows.slice(i, i + chunkSize);
                for (const params of slice) {
                    await new Promise((resolve, reject) => {
                        try {
                            stmt.run(...params, (err) => err ? reject(err) : resolve());
                        } catch (e) {
                            reject(e);
                        }
                    });
                    processed += 1;
                }
            }
            if (manageTx) await dbRun(dbType, commit);
        } catch (e) {
            if (manageTx) await dbRun(dbType, rollback).catch(() => {});
            throw e;
        } finally {
            await new Promise((resolve, reject) => stmt.finalize(err => err ? reject(err) : resolve()));
        }
        return processed;
    }
}; 