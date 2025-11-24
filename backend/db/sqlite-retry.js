/**
 * SQLite 写入退避统一封装模块
 * 提供统一的重试策略和错误处理
 */

const logger = require('../config/logger');
const { trackBusyRetry } = require('./multi-db');

/**
 * 默认重试配置
 */
const DEFAULT_RETRY_CONFIG = {
    maxRetries: 8,           // 最大重试次数
    baseDelay: 50,           // 基础延迟（毫秒）
    maxDelay: 5000,          // 最大延迟（毫秒）
    jitterRange: 40,         // 随机抖动范围（毫秒）
    indexingCheckDelay: 150, // 索引进行中的额外延迟
    indexingJitter: 150,     // 索引延迟的随机抖动
};

/**
 * 检查是否为 SQLite 忙碌错误
 * @param {Error} error - 错误对象
 * @returns {boolean} 是否为可重试的忙碌错误
 */
function isSQLiteBusyError(error) {
    if (!error) return false;
    // better-sqlite3 throws errors with a code property
    if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') return true;

    // Fallback for message matching (just in case)
    const msg = String(error.message || '');
    return /SQLITE_BUSY|database is locked|database is busy/i.test(msg);
}

/**
 * 检查索引是否正在进行中
 * @param {Object} redis - Redis 客户端
 * @returns {Promise<boolean>} 索引是否正在进行
 */
async function isIndexingInProgress(redis) {
    const { safeRedisGet } = require('../utils/helpers');
    const indexing = await safeRedisGet(redis, 'indexing_in_progress', '检查索引进行中');
    return !!indexing;
}

/**
 * 计算退避延迟
 * @param {number} attempt - 当前尝试次数（从0开始）
 * @param {Object} config - 重试配置
 * @returns {number} 延迟毫秒数
 */
function calculateBackoffDelay(attempt, config = DEFAULT_RETRY_CONFIG) {
    const exponentialDelay = config.baseDelay * Math.pow(2, attempt);
    const jitter = Math.floor(Math.random() * config.jitterRange);
    const totalDelay = exponentialDelay + jitter;
    return Math.min(totalDelay, config.maxDelay);
}

/**
 * 等待指定时间
 * @param {number} ms - 等待毫秒数
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 统一的 SQLite 写入重试封装
 * @param {Function} operation - 要执行的数据库操作函数
 * @param {Object} options - 选项
 * @param {Object} options.redis - Redis 客户端（用于检查索引状态）
 * @param {Object} options.config - 重试配置
 * @param {string} options.operationName - 操作名称（用于日志）
 * @param {Object} options.context - 上下文信息（用于日志）
 * @returns {Promise<any>} 操作结果
 */
async function withSQLiteRetry(operation, options = {}) {
    const {
        redis,
        config = DEFAULT_RETRY_CONFIG,
        operationName = 'SQLite操作',
        context = {}
    } = options;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        try {
            // 第一次尝试时检查索引状态，适度让路
            if (attempt === 0 && redis) {
                const indexing = await isIndexingInProgress(redis);
                if (indexing) {
                    const indexingDelay = config.indexingCheckDelay +
                        Math.floor(Math.random() * config.indexingJitter);
                    await sleep(indexingDelay);
                }
            }

            // 执行数据库操作
            const result = await operation();

            // 成功时记录重试信息（如果有重试）
            if (attempt > 0) {
                logger.info(`${operationName} 重试成功`, {
                    attempts: attempt + 1,
                    context
                });
            }

            return result;

        } catch (error) {
            // 检查是否为可重试的错误
            if (!isSQLiteBusyError(error) || attempt === config.maxRetries) {
                // 不可重试的错误或已达最大重试次数
                logger.error(`${operationName} 失败`, {
                    error: error.message,
                    attempts: attempt + 1,
                    context
                });
                throw error;
            }

            // 计算退避延迟
            const backoffDelay = calculateBackoffDelay(attempt, config);

            // 记录重试日志
            logger.debug(`${operationName} 遇到忙碌错误，将在 ${backoffDelay}ms 后重试`, {
                attempt: attempt + 1,
                maxRetries: config.maxRetries,
                error: error.message,
                context
            });
            try { trackBusyRetry(operationName); } catch (trackErr) { logger.silly('trackBusyRetry failed', trackErr && trackErr.message ? { error: trackErr.message } : undefined); }

            // 等待后重试
            await sleep(backoffDelay);
        }
    }
}

/**
 * 专用于缩略图状态写入的重试封装
 * @param {Function} dbRun - 数据库运行函数
 * @param {Object} params - 参数
 * @param {string} params.path - 文件相对路径
 * @param {number} params.mtime - 修改时间
 * @param {string} params.status - 状态
 * @param {Object} redis - Redis 客户端
 * @returns {Promise<void>}
 */
async function writeThumbStatusWithRetry(dbRun, { path: relPath, mtime, status }, redis) {
    // 参数验证和清理
    if (!relPath || typeof relPath !== 'string') {
        const { ValidationError } = require('../utils/errors');
        throw new ValidationError(`无效的文件路径: ${relPath}`, { path: relPath, type: typeof relPath });
    }

    // 清理路径中的特殊字符，统一使用正斜杠
    const cleanPath = relPath.replace(/\\/g, '/').trim();
    const safeMtime = Number(mtime) || Date.now();
    const safeStatus = String(status || 'pending');

    return withSQLiteRetry(
        async () => {
            await dbRun('main',
                `INSERT INTO thumb_status(path, mtime, status, last_checked)
                 VALUES(?, ?, ?, strftime('%s','now')*1000)
                 ON CONFLICT(path) DO UPDATE SET 
                   mtime=excluded.mtime, 
                   status=excluded.status, 
                   last_checked=excluded.last_checked`,
                [cleanPath, safeMtime, safeStatus]
            );
        },
        {
            redis,
            operationName: '缩略图状态写入',
            context: {
                path: cleanPath.length > 50 ? cleanPath.substring(0, 50) + '...' : cleanPath,
                status: safeStatus,
                mtime: safeMtime
            }
        }
    );
}

/**
 * 专用于批量操作的重试封装
 * @param {Function} runPreparedBatch - 批量操作函数
 * @param {string} dbType - 数据库类型
 * @param {string} sql - SQL 语句
 * @param {Array} rows - 数据行
 * @param {Object} options - 选项
 * @param {Object} redis - Redis 客户端
 * @returns {Promise<void>}
 */
async function runPreparedBatchWithRetry(runPreparedBatch, dbType, sql, rows, options = {}, redis) {
    return withSQLiteRetry(
        async () => {
            await runPreparedBatch(dbType, sql, rows, options);
        },
        {
            redis,
            operationName: '批量数据库操作',
            context: { dbType, rowCount: rows.length }
        }
    );
}

/**
 * 专用于单条数据库运行的重试封装
 * @param {Function} dbRun - 数据库运行函数
 * @param {string} dbType - 数据库类型
 * @param {string} sql - SQL 语句
 * @param {Array} params - 参数
 * @param {Object} redis - Redis 客户端
 * @returns {Promise<any>}
 */
async function dbRunWithRetry(dbRun, dbType, sql, params = [], redis) {
    return withSQLiteRetry(
        async () => {
            return await dbRun(dbType, sql, params);
        },
        {
            redis,
            operationName: '数据库运行',
            context: { dbType, sql: sql.substring(0, 50) + '...' }
        }
    );
}

module.exports = {
    DEFAULT_RETRY_CONFIG,
    isSQLiteBusyError,
    isIndexingInProgress,
    calculateBackoffDelay,
    withSQLiteRetry,
    writeThumbStatusWithRetry,
    runPreparedBatchWithRetry,
    dbRunWithRetry,
};