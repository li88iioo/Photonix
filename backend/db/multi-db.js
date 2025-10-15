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
 * SQLite 配置管理器
 * 统一管理 SQLite 优化参数，防止硬编码
 */
class SQLiteConfigManager {
    constructor() {
        this.initializeConfig();
    }

    /**
     * 初始化 SQLite 配置参数
     */
    initializeConfig() {
        // 基础 PRAGMA 配置
        this.journalMode = process.env.SQLITE_JOURNAL_MODE || 'WAL';
        this.synchronous = process.env.SQLITE_SYNCHRONOUS || 'NORMAL';
        this.tempStore = process.env.SQLITE_TEMP_STORE || 'MEMORY';

        // 内存相关配置（支持环境变量覆盖）
        this.calculateMemoryConfig();

        // 超时相关配置
        this.busyTimeoutDefault = Number.isFinite(parseInt(process.env.SQLITE_BUSY_TIMEOUT, 10))
            ? parseInt(process.env.SQLITE_BUSY_TIMEOUT, 10)
            : 20000; // 毫秒
        this.queryTimeoutDefault = process.env.SQLITE_QUERY_TIMEOUT
            ? parseInt(process.env.SQLITE_QUERY_TIMEOUT, 10)
            : 30000; // 毫秒
    }

    /**
     * 根据系统总内存配置 SQLite 内存参数
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
     * 获取 SQLite 配置对象
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
     * 重新计算配置（如内存变化时调用）
     */
    recalculateConfig() {
        this.calculateMemoryConfig();
    }
}

// 单例配置管理器
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

/**
 * 获取当前查询超时时长（毫秒）
 */
function getQueryTimeoutMs() {
  return __dynamicQueryTimeoutMs;
}

/**
 * 给 Promise 添加超时处理
 * @param {Promise} promise 执行的 Promise
 * @param {number} ms 超时时长（毫秒）
 * @param {object} queryInfo 查询信息（日志用）
 * @returns {Promise} 添加超时处理的 Promise
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

// 数据库连接池对象
const dbConnections = {};

// 数据库连接健康状态 Map
const dbHealthStatus = new Map();

/**
 * 统计 busy 重试次数
 * @param {string} sql 查询 SQL
 */
function trackBusyRetry(sql) {
  __busyRetryCount += 1;
  if (__busyRetryCount % BUSY_LOG_THRESHOLD === 0) {
    logger.debug(`[SQLite] BUSY retry x${__busyRetryCount} (sample)`);
  }
  maybeLogTelemetry();
}

/**
 * 统计超时次数
 * @param {string} sql 查询 SQL
 */
function trackTimeout(sql) {
  __timeoutCount += 1;
  if (__timeoutCount % TIMEOUT_LOG_THRESHOLD === 0) {
    logger.debug(`[SQLite] Timeout occurrences x${__timeoutCount} (sample)`);
  }
  maybeLogTelemetry();
}

/**
 * 按时间片记录 telemetry（busy/timeout 统计）
 * @param {boolean} force 是否强制记录
 */
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

// ---- 日志去抖相关 ----

/**
 * 记录各库恢复日志打印时间，60秒去抖
 */
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

/**
 * 批量恢复日志去抖（30秒内只记一次）
 */
let __batchRestoreLogTs = 0;
const BATCH_RESTORE_LOG_DEBOUNCE_MS = 30000;
function __shouldLogBatchRestore() {
  const now = Date.now();
  if (now - __batchRestoreLogTs >= BATCH_RESTORE_LOG_DEBOUNCE_MS) {
    __batchRestoreLogTs = now;
    return true;
  }
  return false;
}

/**
 * 初始化日志去抖（5秒内只记一次，防止多 Worker 重复输出）
 */
let __initLogTs = 0;
const INIT_LOG_DEBOUNCE_MS = 5000;
function __shouldLogInit() {
  const now = Date.now();
  if (now - __initLogTs >= INIT_LOG_DEBOUNCE_MS) {
    __initLogTs = now;
    return true;
  }
  return false;
}

/**
 * 重连日志去抖，按库和类型进行（每类 60 秒内只记一次）
 */
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

// ---- 连接监控配置 ----
const DB_HEALTH_CHECK_INTERVAL = Number(process.env.DB_HEALTH_CHECK_INTERVAL || 60000); // 单位：毫秒
const DB_RECONNECT_ATTEMPTS = Number(process.env.DB_RECONNECT_ATTEMPTS || 3);

/**
 * 创建数据库连接（通用）
 * @param {string} dbPath 数据库文件路径
 * @param {string} dbName 数据库名（用于日志）
 * @returns {Promise<sqlite3.Database>}
 */
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
            
            // 配置基础 PRAGMA 参数
            try {
                db.run(`PRAGMA synchronous = ${SQLITE_SYNCHRONOUS};`);
                db.run(`PRAGMA temp_store = ${SQLITE_TEMP_STORE};`);
                db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE};`);
                db.run(`PRAGMA journal_mode = ${SQLITE_JOURNAL_MODE};`);
                db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE};`);
                db.run('PRAGMA foreign_keys = ON;');

                logger.debug(`${dbName} 数据库基础参数设置成功`);
            } catch (e) {
                logger.debug(`${dbName} 基础PRAGMA参数设置失败:`, e.message);
            }

            // 设置数据库连接健康状态为 connected
            dbHealthStatus.set(dbName, 'connected');

            // 监听连接出错
            db.on('error', (err) => {
                logger.error(`${dbName} 数据库连接错误:`, err.message);
                dbHealthStatus.set(dbName, 'error');
            });

            // 监听连接关闭
            db.on('close', () => {
                logger.warn(`${dbName} 数据库连接已关闭`);
                dbHealthStatus.set(dbName, 'closed');
            });

            // 可选优化参数（兼容 sqlite3 5.1.7）
            try {
                db.run('PRAGMA optimize;');
                logger.debug(`${dbName} 数据库优化参数设置成功`);
            } catch (e) {
                logger.debug(`${dbName} 数据库优化参数设置失败（兼容性问题）:`, e.message);
            }
            
            resolve(db);
        });
    });
};

/**
 * 初始化所有数据库连接
 * @returns {Promise<object>} dbConnections
 */
const initializeConnections = async () => {
    try {
        dbConnections.main = await createDBConnection(DB_FILE, '主数据库');
        dbConnections.settings = await createDBConnection(SETTINGS_DB_FILE, '设置数据库');
        dbConnections.history = await createDBConnection(HISTORY_DB_FILE, '历史记录数据库');
        dbConnections.index = await createDBConnection(INDEX_DB_FILE, '索引数据库');

        // 仅做连接级别配置，不创建表，防止并发竞态
        try {
            // 如果业务需要请用迁移或 ensureCoreTables()
        } catch (e) {
            logger.debug('初始化关键表/索引失败（忽略）:', e && e.message);
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

/**
 * 获取指定数据库连接
 * @param {string} dbType 数据库类型
 * @returns {sqlite3.Database}
 */
const getDB = (dbType = 'main') => {
    if (!dbConnections[dbType]) {
        const { DatabaseError } = require('../utils/errors');
        throw new DatabaseError(`数据库连接 ${dbType} 不存在`, { dbType, availableTypes: Object.keys(dbConnections) });
    }
    return dbConnections[dbType];
};

/**
 * 关闭所有数据库连接
 * @returns {Promise<void[]>}
 */
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

/**
 * 通用数据库 DML 操作
 * @param {string} dbType 数据库类型
 * @param {string} sql SQL语句
 * @param {Array} params 参数
 * @param {string} successMessage 成功输出日志
 * @returns {Promise<any>}
 */
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

/**
 * 通用数据库 run 操作（无日志，无 successMessage）
 * @param {string} dbType
 * @param {string} sql
 * @param {Array} params
 * @returns {Promise<any>}
 */
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

/**
 * 通用数据库 all 操作，返回多行
 * @param {string} dbType
 * @param {string} sql
 * @param {Array} params
 * @returns {Promise<Array>}
 */
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

/**
 * 通用数据库 get 操作，返回单行
 * @param {string} dbType
 * @param {string} sql
 * @param {Array} params
 * @returns {Promise<Object|null>}
 */
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

/**
 * 检查指定表是否包含指定列
 * @param {string} dbType 数据库类型
 * @param {string} table 表名
 * @param {string} column 列名
 * @returns {Promise<boolean>}
 */
const hasColumn = (dbType, table, column) => {
    const sql = `PRAGMA table_info(${table})`;
    const promise = new Promise((resolve, reject) => {
        getDB(dbType).all(sql, (err, rows) => {
            if (err) return reject(err);
            resolve(rows.some(row => row.name === column));
        });
    });
    return withTimeout(promise, getQueryTimeoutMs(), { sql });
};

/**
 * 检查所有数据库连接健康状态，自动重连
 * @returns {Promise<void>}
 */
async function checkDatabaseHealth() {
    const dbTypes = ['main', 'settings', 'history', 'index'];
    const restoredDbs = [];

    for (const dbType of dbTypes) {
        const db = dbConnections[dbType];
        if (!db) continue;

        try {
            // 简单查询测试连通性
            await new Promise((resolve, reject) => {
                db.get('SELECT 1 as test', (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row);
                    }
                });
            });

            // 仅在健康状态变化时输出日志且去抖
            if (dbHealthStatus.get(dbType) !== 'connected') {
                restoredDbs.push(dbType);
                dbHealthStatus.set(dbType, 'connected');
            }
        } catch (error) {
            logger.warn(`${dbType} 数据库连接检查失败:`, error.message);
            dbHealthStatus.set(dbType, 'unhealthy');

            // 尝试自动重连
            await attemptReconnect(dbType);
        }
    }

    // 批量恢复日志输出（30秒去抖）
    if (restoredDbs.length > 0 && __shouldLogBatchRestore()) {
        logger.info(`数据库连接已恢复: ${restoredDbs.join(', ')}`);
    }
}

/**
 * 尝试重连指定数据库
 * @param {string} dbType 数据库类型
 * @returns {Promise<boolean>} 是否重连成功
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
            
            // 重新建立连接
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
 * 获取数据库文件路径
 * @param {string} dbType 数据库类型
 * @returns {string} 数据库路径
 */
function getDbPath(dbType) {
    switch (dbType) {
        case 'main': return DB_FILE;
        case 'settings': return SETTINGS_DB_FILE;
        case 'history': return HISTORY_DB_FILE;
        case 'index': return INDEX_DB_FILE;
        default: {
            const { ValidationError } = require('../utils/errors');
            throw new ValidationError(`未知的数据库类型: ${dbType}`, { dbType, validTypes: ['main', 'settings', 'history', 'index'] });
        }
    }
}

/**
 * 获取数据库名称（用于日志）
 * @param {string} dbType
 * @returns {string}
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

// ---- 数据库健康检查定时任务 ----
const dbHealthCheckInterval = setInterval(checkDatabaseHealth, DB_HEALTH_CHECK_INTERVAL);

/**
 * 清理健康检查定时器
 */
function cleanupDbHealthCheck() {
    if (dbHealthCheckInterval) {
        clearInterval(dbHealthCheckInterval);
    }
}

// 进程退出时自动清理连接与定时器
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

/**
 * 检查数据库是否存在指定表
 * @param {string} dbType 数据库类型
 * @param {string} table 表名
 * @returns {Promise<boolean>}
 */
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
 * 安全构建 SQL IN 子句
 * @param {Array} values 值数组
 * @returns {Object} 包含 placeholders 和 values 的对象
 */
function buildSafeInClause(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return { placeholders: '(NULL)', values: [] };
    }

    // 仅允许基本类型避免注入
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
 * 直接在指定路径只读查询数据库（不依赖全局连接，适合启动期用）
 * @param {string} dbPath
 * @param {string} sql
 * @param {Array} params
 * @returns {Promise<Array>}
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
 * 带缓存的 dbAll 查询
 * @param {string} dbType 数据库类型
 * @param {string} sql
 * @param {Array} params
 * @param {Object} cacheOptions 缓存选项
 * @param {boolean} cacheOptions.useCache 是否使用缓存
 * @param {number} cacheOptions.ttl 缓存有效时间(秒)
 * @param {string[]} cacheOptions.tags 缓存标签
 * @returns {Promise<Array>}
 */
async function dbAllWithCache(dbType, sql, params = [], cacheOptions = {}) {
    const { useCache = false, ttl = 300, tags = [] } = cacheOptions;

    if (useCache) {
        const queryKey = generateQueryKey(sql, params);
        const cachedResult = await getCachedQueryResult(queryKey);
        if (cachedResult !== null) {
            return cachedResult;
        }

        // 未命中缓存，执行查询
        const result = await dbAll(dbType, sql, params);

        // 缓存异步写
        cacheQueryResult(queryKey, result, tags, ttl).catch(error => {
            logger.debug('缓存查询结果失败:', error);
        });

        return result;
    } else {
        return dbAll(dbType, sql, params);
    }
}

/**
 * 带缓存的 dbGet 查询（单行）
 * @param {string} dbType
 * @param {string} sql
 * @param {Array} params
 * @param {Object} cacheOptions
 * @param {boolean} cacheOptions.useCache
 * @param {number} cacheOptions.ttl
 * @param {string[]} cacheOptions.tags
 * @returns {Promise<Object|null>}
 */
async function dbGetWithCache(dbType, sql, params = [], cacheOptions = {}) {
    const { useCache = false, ttl = 300, tags = [] } = cacheOptions;

    if (useCache) {
        const queryKey = generateQueryKey(sql, params);
        const cachedResult = await getCachedQueryResult(queryKey);
        if (cachedResult !== null) {
            return cachedResult;
        }

        // 未命中缓存，执行查询
        const result = await dbGet(dbType, sql, params);

        // 缓存异步写
        cacheQueryResult(queryKey, result, tags, ttl).catch(error => {
            logger.debug('缓存查询结果失败:', error);
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
     * @param {Object} param0
     * @param {number} [param0.busyTimeoutDeltaMs]
     * @param {number} [param0.queryTimeoutDeltaMs]
     * @returns {Object} 调整后超时参数
     */
    adaptDbTimeouts: ({ busyTimeoutDeltaMs = 0, queryTimeoutDeltaMs = 0 } = {}) => {
        __dynamicBusyTimeoutMs = Math.max(BUSY_TIMEOUT_MIN, Math.min(BUSY_TIMEOUT_MAX, __dynamicBusyTimeoutMs + (busyTimeoutDeltaMs | 0)));
        __dynamicQueryTimeoutMs = Math.max(QUERY_TIMEOUT_MIN, Math.min(QUERY_TIMEOUT_MAX, __dynamicQueryTimeoutMs + (queryTimeoutDeltaMs | 0)));
        try {
            // 同步到所有打开连接（新连接天然获得新参数）
            Object.values(dbConnections).forEach(db => {
                try {
                    db.configure && db.configure('busyTimeout', __dynamicBusyTimeoutMs);
                } catch (error) {
                    logger.silly(`[DB] 更新数据库 busyTimeout 配置失败: ${error && error.message}`);
                }
            });
        } catch (error) {
            logger.silly(`[DB] 批量更新 busyTimeout 配置失败: ${error && error.message}`);
        }
        logger.debug(`DB 超时自适应: busy=${__dynamicBusyTimeoutMs}ms, query=${__dynamicQueryTimeoutMs}ms`);
        return { busyTimeoutMs: __dynamicBusyTimeoutMs, queryTimeoutMs: __dynamicQueryTimeoutMs };
    },
    /**
     * 批量执行预编译语句（Prepared Statement）
     * 默认自动管理事务并支持分块提交
     * @param {('main'|'settings'|'history'|'index')} dbType
     * @param {string} sql 预编译 SQL
     * @param {Array<Array<any>>} rows 参数数组
     * @param {Object} options
     * @param {number} [options.chunkSize=500]
     * @param {boolean} [options.manageTransaction=true]
     * @param {string} [options.begin='BEGIN IMMEDIATE']
     * @param {string} [options.commit='COMMIT']
     * @param {string} [options.rollback='ROLLBACK']
     * @returns {Promise<number>} processed 成功行数
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

        // 智能事务：自动判断内外层事务
        let shouldManageTx = manageTxOpt !== false;
        let began = false;
        if (shouldManageTx) {
            try {
                await dbRun(dbType, begin);
                began = true;
            } catch (e) {
                const msg = String(e && e.message || '');
                if (/(within a transaction|cannot start.*transaction|transaction.*active)/i.test(msg)) {
                    shouldManageTx = false; // 已在外层事务
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

/**
 * 通用事务包装器
 * 自动管理事务（BEGIN/COMMIT/ROLLBACK），在闭包内执行核心数据库操作
 *
 * @param {string} dbType 数据库类型
 * @param {Function} fn 执行体（异步函数）
 * @param {Object} options
 * @param {string} [options.mode='IMMEDIATE'] 事务模式
 * @returns {Promise<any>}
 *
 * @example
 * await withTransaction('main', async () => {
 *   await dbRun('main', 'DELETE FROM items WHERE path=?', [path]);
 *   await dbRun('main', 'DELETE FROM thumb_status WHERE path=?', [path]);
 * });
 */
async function withTransaction(dbType, fn, options = {}) {
    const mode = options.mode || 'IMMEDIATE';
    const beginSql = `BEGIN ${mode}`;
    const commitSql = 'COMMIT';
    const rollbackSql = 'ROLLBACK';

    // 检查是否已置于事务中
    let shouldManage = true;
    try {
        await dbRun(dbType, beginSql);
    } catch (e) {
        const msg = String(e && e.message || '');
        if (/(within a transaction|cannot start.*transaction|transaction.*active)/i.test(msg)) {
            // 嵌套事务，跳过 BEGIN
            shouldManage = false;
            logger.debug(`[withTransaction] 检测到嵌套事务，跳过BEGIN (${dbType})`);
        } else {
            throw e;
        }
    }

    try {
        // 执行用户闭包
        const result = await fn();
        
        // 自动提交事务（如果我们开启的）
        if (shouldManage) {
            await dbRun(dbType, commitSql);
        }
        
        return result;
    } catch (error) {
        // 如异常自动回滚
        if (shouldManage) {
            try {
                await dbRun(dbType, rollbackSql);
                logger.debug(`[withTransaction] 已回滚事务 (${dbType}): ${error.message}`);
            } catch (rollbackError) {
                logger.debug(`[withTransaction] 回滚失败 (${dbType}):`, rollbackError.message);
            }
        }
        throw error;
    }
}

// 导出部分底层监控方法和事务封装
module.exports.trackBusyRetry = trackBusyRetry;
module.exports.maybeLogTelemetry = maybeLogTelemetry;
module.exports.withTransaction = withTransaction;

// 导出 withTimeout，便于统一超时处理
module.exports.withTimeout = withTimeout;