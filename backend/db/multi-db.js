const sqlite3 = require('sqlite3').verbose();
const os = require('os');
const {
    DB_FILE,
    SETTINGS_DB_FILE,
    HISTORY_DB_FILE,
    INDEX_DB_FILE
} = require('../config');
const logger = require('../config/logger');
const { getCachedQueryResult, cacheQueryResult, generateQueryKey } = require('../services/cache.service');

/**
 * SQLite配置管理器
 * 集中管理SQLite优化参数，避免硬编码
 */
class SQLiteConfigManager {
    constructor() {
        this.initializeConfig();
    }

    /**
     * 初始化SQLite配置
     */
    initializeConfig() {
        // 基础PRAGMA配置
        this.journalMode = process.env.SQLITE_JOURNAL_MODE || 'WAL';
        this.synchronous = process.env.SQLITE_SYNCHRONOUS || 'NORMAL';
        this.tempStore = process.env.SQLITE_TEMP_STORE || 'MEMORY';

        // 内存相关配置（支持环境变量覆盖）
        this.calculateMemoryConfig();

        // 超时配置
        this.busyTimeoutDefault = Number.isFinite(parseInt(process.env.SQLITE_BUSY_TIMEOUT, 10))
            ? parseInt(process.env.SQLITE_BUSY_TIMEOUT, 10)
            : 20000; // ms
        this.queryTimeoutDefault = process.env.SQLITE_QUERY_TIMEOUT
            ? parseInt(process.env.SQLITE_QUERY_TIMEOUT, 10)
            : 30000; // ms
    }

    /**
     * 根据系统内存计算SQLite内存配置
     */
    calculateMemoryConfig() {
        const totalMem = os.totalmem();

        // 支持环境变量自定义
        if (process.env.SQLITE_CACHE_SIZE) {
            this.cacheSize = parseInt(process.env.SQLITE_CACHE_SIZE, 10);
        } else if (totalMem >= 16 * 1024 * 1024 * 1024) { // >=16GB
            this.cacheSize = -65536; // 64MB
        } else if (totalMem >= 8 * 1024 * 1024 * 1024) { // >=8GB
            this.cacheSize = -32768; // 32MB
        } else if (totalMem >= 4 * 1024 * 1024 * 1024) { // >=4GB
            this.cacheSize = -16384; // 16MB
        } else {
            this.cacheSize = -8192;  // 8MB（低内存环境）
        }

        if (process.env.SQLITE_MMAP_SIZE) {
            this.mmapSize = parseInt(process.env.SQLITE_MMAP_SIZE, 10);
        } else if (totalMem >= 16 * 1024 * 1024 * 1024) { // >=16GB
            this.mmapSize = 1024 * 1024 * 1024; // 1GB
        } else if (totalMem >= 8 * 1024 * 1024 * 1024) { // >=8GB
            this.mmapSize = 512 * 1024 * 1024; // 512MB
        } else if (totalMem >= 4 * 1024 * 1024 * 1024) { // >=4GB
            this.mmapSize = 384 * 1024 * 1024; // 384MB
        } else {
            this.mmapSize = 256 * 1024 * 1024; // 256MB
        }
    }

    /**
     * 获取配置对象
     */
    getConfig() {
        return {
            journalMode: this.journalMode,
            synchronous: this.synchronous,
            tempStore: this.tempStore,
            cacheSize: this.cacheSize,
            mmapSize: this.mmapSize,
            busyTimeoutDefault: this.busyTimeoutDefault,
            queryTimeoutDefault: this.queryTimeoutDefault
        };
    }

    /**
     * 重新计算配置（内存变化时调用）
     */
    recalculateConfig() {
        this.calculateMemoryConfig();
    }
}

// 创建单例配置管理器
const sqliteConfigManager = new SQLiteConfigManager();

// 导出配置常量（向后兼容）
const config = sqliteConfigManager.getConfig();
const SQLITE_JOURNAL_MODE = config.journalMode;
const SQLITE_SYNCHRONOUS = config.synchronous;
const SQLITE_TEMP_STORE = config.tempStore;
const SQLITE_CACHE_SIZE = config.cacheSize;
const SQLITE_MMAP_SIZE = config.mmapSize;
const SQLITE_BUSY_TIMEOUT_DEFAULT = config.busyTimeoutDefault;
const QUERY_TIMEOUT_DEFAULT = config.queryTimeoutDefault;

let __dynamicBusyTimeoutMs = SQLITE_BUSY_TIMEOUT_DEFAULT;
let __dynamicQueryTimeoutMs = QUERY_TIMEOUT_DEFAULT;
const BUSY_LOG_THRESHOLD = Math.max(1, Number(process.env.SQLITE_BUSY_LOG_THRESHOLD || 10));
const TIMEOUT_LOG_THRESHOLD = Math.max(1, Number(process.env.SQLITE_TIMEOUT_LOG_THRESHOLD || 5));
const TELEMETRY_INTERVAL_MS = Math.max(5000, Number(process.env.SQLITE_TELEMETRY_INTERVAL_MS || 30000));
let __busyRetryCount = 0;
let __timeoutCount = 0;
let __lastTelemetryAt = 0;

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
            trackTimeout(queryInfo.sql);
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
function trackBusyRetry(sql) {
  __busyRetryCount += 1;
  if (__busyRetryCount % BUSY_LOG_THRESHOLD === 0) {
    logger.warn(`[SQLite] BUSY retry x${__busyRetryCount} (sample)`);
  }
  maybeLogTelemetry();
}

function trackTimeout(sql) {
  __timeoutCount += 1;
  if (__timeoutCount % TIMEOUT_LOG_THRESHOLD === 0) {
    logger.warn(`[SQLite] Timeout occurrences x${__timeoutCount} (sample)`);
  }
  maybeLogTelemetry();
}

function maybeLogTelemetry(force = false) {
  const now = Date.now();
  if (!force && now - __lastTelemetryAt < TELEMETRY_INTERVAL_MS) {
    return;
  }
  __lastTelemetryAt = now;
  if (__busyRetryCount === 0 && __timeoutCount === 0) {
    return;
  }
  logger.info('[SQLite] telemetry snapshot', {
    busyRetries: __busyRetryCount,
    timeouts: __timeoutCount,
    busyTimeoutMs: __dynamicBusyTimeoutMs,
    queryTimeoutMs: __dynamicQueryTimeoutMs
  });
  __busyRetryCount = 0;
  __timeoutCount = 0;
}
// 去抖: 记录各库"恢复日志"最近一次打印时间，避免短时间重复刷屏
const __restoreLogTs = new Map();
const RESTORE_LOG_DEBOUNCE_MS = 60000;
function __shouldLogRestore(dbType) {
  const now = Date.now();
  const last = __restoreLogTs.get(dbType) || 0;
  if (now - last >= RESTORE_LOG_DEBOUNCE_MS) {
    __restoreLogTs.set(dbType, now);
    return true;
  }
  return false;
}

// 批量恢复日志去抖，避免短时间内多个数据库恢复产生过多日志
let __batchRestoreLogTs = 0;
const BATCH_RESTORE_LOG_DEBOUNCE_MS = 30000; // 30秒内只记录一次批量恢复
function __shouldLogBatchRestore() {
  const now = Date.now();
  if (now - __batchRestoreLogTs >= BATCH_RESTORE_LOG_DEBOUNCE_MS) {
    __batchRestoreLogTs = now;
    return true;
  }
  return false;
}
// 初始化日志去抖机制，避免多个进程重复记录
let __initLogTs = 0;
const INIT_LOG_DEBOUNCE_MS = 5000; // 5秒内只记录一次
function __shouldLogInit() {
  const now = Date.now();
  if (now - __initLogTs >= INIT_LOG_DEBOUNCE_MS) {
    __initLogTs = now;
    return true;
  }
  return false;
}
// 重连日志去抖机制（按库&类型：attempt/success/failure）
const __reconnectLogTs = new Map(); // dbType -> Map(kind -> ts)
const RECONNECT_LOG_DEBOUNCE_MS = 60000;
function __shouldLogReconnect(dbType, kind) {
  const now = Date.now();
  let m = __reconnectLogTs.get(dbType);
  if (!m) {
    m = new Map();
    __reconnectLogTs.set(dbType, m);
  }
  const last = m.get(kind) || 0;
  if (now - last >= RECONNECT_LOG_DEBOUNCE_MS) {
    m.set(kind, now);
    return true;
  }
  return false;
}

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
            
            // 1. 基础PRAGMA设置（必需的数据库配置）
            try {
                db.run(`PRAGMA synchronous = ${SQLITE_SYNCHRONOUS};`);
                db.run(`PRAGMA temp_store = ${SQLITE_TEMP_STORE};`);
                db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE};`);
                db.run(`PRAGMA journal_mode = ${SQLITE_JOURNAL_MODE};`);
                db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE};`);
                db.run('PRAGMA foreign_keys = ON;');

                logger.debug(`${dbName} 数据库基础参数设置成功`);
            } catch (e) {
                logger.warn(`${dbName} 基础PRAGMA参数设置失败:`, e.message);
            }

            // 2. 设置连接健康状态
            dbHealthStatus.set(dbName, 'connected');

            // 3. 监听连接错误
            db.on('error', (err) => {
                logger.error(`${dbName} 数据库连接错误:`, err.message);
                dbHealthStatus.set(dbName, 'error');
            });

            // 4. 监听连接关闭
            db.on('close', () => {
                logger.warn(`${dbName} 数据库连接已关闭`);
                dbHealthStatus.set(dbName, 'closed');
            });

            // 5. 可选的优化操作（sqlite3 5.1.7兼容性处理）
            try {
                db.run('PRAGMA optimize;');
                logger.debug(`${dbName} 数据库优化参数设置成功`);
            } catch (e) {
                // PRAGMA optimize在sqlite3 5.1.7中可能不兼容，静默处理
                logger.debug(`${dbName} 数据库优化参数设置失败（兼容性问题）:`, e.message);
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

        if (__shouldLogInit()) {
            logger.info('所有数据库连接已初始化完成');
        }
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
    const restoredDbs = [];

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

            // 连接正常（仅在状态从非connected→connected时记录，且60秒内去抖）
            if (dbHealthStatus.get(dbType) !== 'connected') {
                restoredDbs.push(dbType);
                dbHealthStatus.set(dbType, 'connected');
            }
        } catch (error) {
            logger.warn(`${dbType} 数据库连接检查失败:`, error.message);
            dbHealthStatus.set(dbType, 'unhealthy');

            // 尝试重新连接
            await attemptReconnect(dbType);
        }
    }

    // 批量记录恢复日志（30秒去抖）
    if (restoredDbs.length > 0 && __shouldLogBatchRestore()) {
        logger.info(`数据库连接已恢复: ${restoredDbs.join(', ')}`);
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
            if (__shouldLogReconnect(dbType, 'attempt')) {
                logger.info(`尝试重新连接 ${dbType} 数据库 (第${attempts}次)...`);
            } else {
                logger.debug(`尝试重新连接 ${dbType} 数据库 (第${attempts}次)...`);
            }
            
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
            
            if (__shouldLogReconnect(dbType, 'success')) {
                logger.info(`${dbType} 数据库重新连接成功`);
            } else {
                logger.debug(`${dbType} 数据库重新连接成功`);
            }
            return true;
        } catch (error) {
            if (attempts < maxAttempts) {
                if (__shouldLogReconnect(dbType, 'failure')) {
                    logger.debug(`${dbType} 数据库重新连接失败 (第${attempts}次): ${error.message}`);
                }
            } else {
                logger.error(`${dbType} 数据库重新连接失败 (第${attempts}次):`, error.message);
            }
            
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

/**
 * 安全的SQL IN子句构建器
 * @param {Array} values - 值数组
 * @returns {Object} 包含 placeholders 和 values 的对象
 */
function buildSafeInClause(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return { placeholders: '(NULL)', values: [] };
    }

    // 验证所有值都是基本类型，防止SQL注入
    const validValues = values.filter(value => {
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

/**
 * 直接在给定路径上执行只读查询（不依赖全局连接），适用于启动期探测。
 */
async function dbAllOnPath(dbPath, sql, params = []) {
    return await new Promise((resolve, reject) => {
        try {
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) return reject(err);
                db.all(sql, params, (e, rows) => {
                    const close = () => db.close(() => {});
                    if (e) { close(); return reject(e); }
                    close();
                    return resolve(rows);
                });
            });
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * 带缓存的数据库查询函数
 * @param {string} dbType - 数据库类型
 * @param {string} sql - SQL查询
 * @param {Array} params - 查询参数
 * @param {Object} cacheOptions - 缓存选项
 * @param {boolean} cacheOptions.useCache - 是否使用缓存
 * @param {number} cacheOptions.ttl - 缓存时间（秒）
 * @param {string[]} cacheOptions.tags - 缓存标签
 * @returns {Promise<Array>} 查询结果
 */
async function dbAllWithCache(dbType, sql, params = [], cacheOptions = {}) {
    const { useCache = false, ttl = 300, tags = [] } = cacheOptions;

    if (useCache) {
        const queryKey = generateQueryKey(sql, params);
        const cachedResult = await getCachedQueryResult(queryKey);
        if (cachedResult !== null) {
            return cachedResult;
        }

        // 缓存未命中，执行查询
        const result = await dbAll(dbType, sql, params);

        // 异步缓存结果（不阻塞查询）
        cacheQueryResult(queryKey, result, tags, ttl).catch(error => {
            logger.warn('缓存查询结果失败:', error);
        });

        return result;
    } else {
        return dbAll(dbType, sql, params);
    }
}

/**
 * 带缓存的数据库单行查询函数
 * @param {string} dbType - 数据库类型
 * @param {string} sql - SQL查询
 * @param {Array} params - 查询参数
 * @param {Object} cacheOptions - 缓存选项
 * @param {boolean} cacheOptions.useCache - 是否使用缓存
 * @param {number} cacheOptions.ttl - 缓存时间（秒）
 * @param {string[]} cacheOptions.tags - 缓存标签
 * @returns {Promise<Object|null>} 查询结果
 */
async function dbGetWithCache(dbType, sql, params = [], cacheOptions = {}) {
    const { useCache = false, ttl = 300, tags = [] } = cacheOptions;

    if (useCache) {
        const queryKey = generateQueryKey(sql, params);
        const cachedResult = await getCachedQueryResult(queryKey);
        if (cachedResult !== null) {
            return cachedResult;
        }

        // 缓存未命中，执行查询
        const result = await dbGet(dbType, sql, params);

        // 异步缓存结果（不阻塞查询）
        cacheQueryResult(queryKey, result, tags, ttl).catch(error => {
            logger.warn('缓存查询结果失败:', error);
        });

        return result;
    } else {
        return dbGet(dbType, sql, params);
    }
}

module.exports = {
    initializeConnections,
    getDB,
    closeAllConnections,
    runAsync,
    dbRun,
    dbAll,
    dbGet,
    dbAllWithCache,
    dbGetWithCache,
    hasColumn,
    hasTable,
    buildSafeInClause,
    dbConnections,
    checkDatabaseHealth,
    attemptReconnect,
    dbHealthStatus,
    dbAllOnPath,
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
        const manageTxOpt = options.manageTransaction;
        const begin = options.begin || 'BEGIN IMMEDIATE';
        const commit = options.commit || 'COMMIT';
        const rollback = options.rollback || 'ROLLBACK';
        if (!Array.isArray(rows) || rows.length === 0) return 0;

        const stmt = db.prepare(sql);

        // 智能事务：默认管理事务；若检测到处于事务内，则不再 BEGIN
        let shouldManageTx = manageTxOpt !== false;
        let began = false;
        if (shouldManageTx) {
            try {
                await dbRun(dbType, begin);
                began = true;
            } catch (e) {
                const msg = String(e && e.message || '');
                if (/(within a transaction|cannot start.*transaction|transaction.*active)/i.test(msg)) {
                    shouldManageTx = false; // 已在外层事务中
                } else {
                    throw e;
                }
            }
        }

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
            if (shouldManageTx && began) await dbRun(dbType, commit);
        } catch (e) {
            if (shouldManageTx && began) await dbRun(dbType, rollback).catch(() => {});
            throw e;
        } finally {
            await new Promise((resolve, reject) => stmt.finalize(err => err ? reject(err) : resolve()));
        }
        return processed;
    }
};

module.exports.trackBusyRetry = trackBusyRetry;
module.exports.maybeLogTelemetry = maybeLogTelemetry;

// 导出 withTimeout 以便启动流程等处统一超时语义
module.exports.withTimeout = withTimeout; 