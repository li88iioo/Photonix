/**
 * workerMessage 工具模块
 * 提供 Worker 消息封装、规范化及追踪相关方法
 */

const { TraceManager } = require('./trace');

/** 通用Worker通信信道名 */
const WORKER_CHANNEL = 'photonix_worker_channel';

/**
 * 为消息对象添加 trace 上下文 envelope（仅当 trace 存在且未被注入时）
 * @param {Object} message - 原始消息对象
 * @returns {Object} 包含 trace 的消息
 */
function attachTraceEnvelope(message) {
    if (!message || typeof message !== 'object') {
        return message;
    }
    // 已存在 trace 字段则直接返回
    if (message._trace) {
        return message;
    }
    // 获取当前 trace 上下文
    const context = TraceManager.getCurrentContext();
    if (!context) {
        return message;
    }
    // 注入 _trace 字段
    return Object.assign({}, message, { _trace: context.toObject() });
}

/**
 * 构建 Worker 消息结构，自动封装 trace 内容
 * @param {string} kind - 消息类型
 * @param {Object} [payload={}] - 消息负载
 * @param {Object} [meta={}] - 附加元数据
 * @returns {Object} 标准 Worker 消息
 */
function createWorkerMessage(kind, payload = {}, meta = {}) {
    const base = {
        channel: WORKER_CHANNEL,
        kind,
        payload,
        meta,
    };
    return attachTraceEnvelope(base);
}

/**
 * 封装 Worker 正常结果消息
 * @param {Object} payload - 结果信息
 * @param {Object} meta - 元信息
 * @returns {Object} result 类型消息
 */
function createWorkerResult(payload = {}, meta = {}) {
    return createWorkerMessage('result', payload, meta);
}

/**
 * 标准化错误对象，提取通用字段
 * @param {any} error - 原始错误
 * @returns {Object} 错误消息对象
 */
function normalizeErrorObject(error) {
    if (!error) {
        return {
            message: 'Unknown worker error',
        };
    }

    if (typeof error === 'string') {
        return { message: error };
    }

    if (error instanceof Error) {
        return {
            message: error.message,
            stack: error.stack,
        };
    }

    const normalized = {
        message: error.message || 'Worker error',
    };

    if (error.code) {
        normalized.code = error.code;
    }

    if (error.details) {
        normalized.details = error.details;
    }

    if (error.stack) {
        normalized.stack = error.stack;
    }

    return normalized;
}

/**
 * 封装 Worker 错误消息
 * @param {Object} errorPayload - 错误相关负载
 * @param {Object} meta - 元信息
 * @returns {Object} error 类型消息
 */
function createWorkerError(errorPayload = {}, meta = {}) {
    const { error, ...rest } = errorPayload || {};
    return createWorkerMessage('error', {
        ...rest,
        error: normalizeErrorObject(error || rest),
    }, meta);
}

/**
 * 封装 Worker 日志消息
 * @param {string} level - 日志级别
 * @param {string} message - 日志内容
 * @param {Object} meta - 附加元数据
 * @returns {Object} log 类型消息
 */
function createWorkerLog(level = 'info', message = '', meta = {}) {
    return createWorkerMessage('log', {
        level,
        message,
    }, meta);
}

/**
 * 提取消息中的 trace 上下文
 * @param {Object} raw - 原始消息
 * @returns {Object|null} trace 对象或 null
 */
function extractTrace(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    if (raw._trace && typeof raw._trace === 'object') {
        return raw._trace;
    }
    if (raw.meta && raw.meta._trace && typeof raw.meta._trace === 'object') {
        return raw.meta._trace;
    }
    return null;
}

/**
 * 标准化 Worker 消息为统一对象格式
 * @param {any} raw - 原始消息
 * @returns {Object} 标准化后的消息对象
 */
function normalizeWorkerMessage(raw) {
    if (!raw || (typeof raw !== 'object' && typeof raw !== 'function')) {
        return {
            kind: 'unknown',
            payload: raw,
            meta: {},
            trace: null,
        };
    }

    // 标准 Worker 信道消息
    if (raw.channel === WORKER_CHANNEL && raw.kind) {
        return {
            kind: raw.kind,
            payload: raw.payload || {},
            meta: raw.meta || {},
            trace: extractTrace(raw),
        };
    }

    // 兼容 log 类型消息
    if (raw.type === 'log') {
        return {
            kind: 'log',
            payload: {
                level: raw.level || raw.logLevel || 'debug',
                message: raw.message || raw.text || '',
                ...raw,
            },
            meta: {},
            trace: extractTrace(raw),
        };
    }

    // 兼容 success 字段的消息
    if (Object.prototype.hasOwnProperty.call(raw, 'success')) {
        return {
            kind: raw.success ? 'result' : 'error',
            payload: raw,
            meta: {},
            trace: extractTrace(raw),
        };
    }

    // Worker 主动关闭等特定类型
    if (raw.type === 'worker_shutdown') {
        return {
            kind: 'error',
            payload: {
                type: raw.type,
                reason: raw.reason,
                message: raw.message,
            },
            meta: {},
            trace: extractTrace(raw),
        };
    }

    // 一般 error 类型
    if (raw.type === 'error') {
        return {
            kind: 'error',
            payload: raw,
            meta: {},
            trace: extractTrace(raw),
        };
    }

    // 默认处理为 result
    const type = raw.type || 'result';

    return {
        kind: ['result', 'error', 'log'].includes(type) ? type : 'result',
        payload: raw,
        meta: {},
        trace: extractTrace(raw),
    };
}

// 导出模块API
module.exports = {
    WORKER_CHANNEL,
    createWorkerMessage,
    createWorkerResult,
    createWorkerError,
    createWorkerLog,
    normalizeWorkerMessage,
};
