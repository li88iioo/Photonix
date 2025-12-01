/**
 * @file event-buffer.js
 * @module EventBuffer
 * @description
 * 统一事件缓冲与节流门面，负责高频事件的批处理、验证与管理。
 */

import errorHandler, { ErrorTypes, ErrorSeverity } from './error-handler.js';
import { createModuleLogger } from './logger.js';
import { EVENT_BUFFER } from './constants.js';

const eventBufferLogger = createModuleLogger('EventBuffer');

/**
 * @class BatchQueue
 * @classdesc 批处理队列管理器，用于事件缓冲与批量处理。
 */
class BatchQueue {
    /**
     * @constructor
     * @param {string} eventType - 事件类型
     * @param {object} [config={}] - 配置项
     */
    constructor(eventType, config = {}) {
        /**
         * @type {string}
         * @description 事件类型
         */
        this.eventType = eventType;
        /**
         * @type {number}
         * @description 批处理时间窗口（毫秒）
         */
        this.batchWindow = config.batchWindow || EVENT_BUFFER.CONFIG.defaultBatchWindow;
        /**
         * @type {number}
         * @description 最大批处理大小
         */
        this.maxBatchSize = config.maxBatchSize || EVENT_BUFFER.CONFIG.maxBatchSize;
        /**
         * @type {Function}
         * @description 刷新回调函数
         */
        this.flushCallback = config.flushCallback;
        /**
         * @type {Function}
         * @description 事件去重键选择器
         */
        this.keySelector = config.keySelector || ((item) => item.id || item.path || JSON.stringify(item));

        /**
         * @type {Map<string, object>}
         * @description 事件队列
         */
        this.queue = new Map();
        /**
         * @type {number|null}
         * @description 刷新定时器ID
         */
        this.flushTimer = null;
    }

    /**
     * 添加事件到队列
     * @param {object} event - 事件数据
     * @returns {void}
     */
    enqueue(event) {
        const key = this.keySelector(event);
        this.queue.set(key, event);

        // 队列满立即刷新
        if (this.queue.size >= this.maxBatchSize) {
            this.flush();
            return;
        }

        // 启动延迟刷新定时器
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => {
                this.flush();
            }, this.batchWindow);
        }
    }

    /**
     * 立即刷新队列并执行回调
     * @returns {void}
     */
    flush() {
        if (this.queue.size === 0) return;

        // 清除刷新定时器
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        // 批量提取数据
        const batch = Array.from(this.queue.values());
        this.queue.clear();

        // 执行回调
        if (this.flushCallback) {
            try {
                this.flushCallback(batch);
            } catch (error) {
                errorHandler.handleError(error, {
                    type: ErrorTypes.UNKNOWN,
                    severity: ErrorSeverity.MEDIUM,
                    context: `event-buffer-${this.eventType}`
                });
            }
        }
    }

    /**
     * 清理队列与定时器
     * @returns {void}
     */
    destroy() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.queue.clear();
    }
}

/**
 * @class EventBufferManager
 * @classdesc 统一事件缓冲管理器，负责注册、调度与批处理。
 */
class EventBufferManager {
    /**
     * @constructor
     */
    constructor() {
        /**
         * @type {Map<string, BatchQueue>}
         * @description 事件类型到缓冲队列的映射
         */
        this.buffers = new Map();
        /**
         * @type {number|null}
         * @description 定期清理定时器ID
         */
        this.cleanupTimer = null;

        this.startCleanupTimer();
    }

    /**
     * 注册事件缓冲器
     * @param {string} eventType - 事件类型
     * @param {object} [config={}] - 配置项
     * @param {Function} flushCallback - 刷新回调
     * @returns {BatchQueue} 缓冲器实例
     */
    registerBuffer(eventType, config = {}, flushCallback) {
        if (this.buffers.has(eventType)) {
            eventBufferLogger.warn('事件类型已被注册，将覆盖', { eventType });
        }

        const buffer = new BatchQueue(eventType, {
            ...config,
            flushCallback
        });

        this.buffers.set(eventType, buffer);
        return buffer;
    }

    /**
     * 处理单个事件
     * @param {string} eventType - 事件类型
     * @param {object} payload - 事件载荷
     * @returns {boolean} 是否成功处理
     */
    handleEvent(eventType, payload) {
        // 验证事件
        const validation = this.validateEvent(eventType, payload);
        if (!validation.ok) {
            eventBufferLogger.warn('事件验证失败', { eventType, reason: validation.reason, payload });
            return false;
        }

        // 获取缓冲器
        const buffer = this.buffers.get(eventType);
        if (!buffer) {
            eventBufferLogger.warn('未注册的事件类型', { eventType });
            return false;
        }

        // 入队
        buffer.enqueue(payload);
        return true;
    }

    /**
     * 验证事件数据
     * @param {string} eventType - 事件类型
     * @param {object} payload - 事件载荷
     * @returns {{ok: boolean, reason?: string}} 验证结果
     */
    validateEvent(eventType, payload) {
        const validator = EVENT_BUFFER.VALIDATORS[eventType];
        if (!validator) {
            // 默认通过
            return { ok: true };
        }
        return validator(payload);
    }

    /**
     * 立即刷新指定类型缓冲器
     * @param {string} eventType - 事件类型
     * @returns {void}
     */
    flushBuffer(eventType) {
        const buffer = this.buffers.get(eventType);
        if (buffer) {
            buffer.flush();
        }
    }

    /**
     * 刷新所有缓冲器
     * @returns {void}
     */
    flushAll() {
        for (const buffer of this.buffers.values()) {
            buffer.flush();
        }
    }

    /**
     * 启动定期清理定时器
     * @private
     * @returns {void}
     */
    startCleanupTimer() {
        this.cleanupTimer = setInterval(() => {
            this.flushAll();
        }, EVENT_BUFFER.CONFIG.cleanupInterval);
    }

    /**
     * 销毁管理器，清理所有资源
     * @returns {void}
     */
    destroy() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        for (const buffer of this.buffers.values()) {
            buffer.destroy();
        }
        this.buffers.clear();
    }
}

/**
 * 全局事件缓冲管理器实例
 * @type {EventBufferManager}
 */
export const eventBufferManager = new EventBufferManager();

/**
 * 获取可调参数，支持全局配置覆盖
 * @param {string} key - 参数键名
 * @param {*} fallback - 默认值
 * @returns {*} 参数值
 */
export function getTunable(key, fallback) {
    try {
        const cfg = (typeof window !== 'undefined' && window.__APP_SETTINGS) ? window.__APP_SETTINGS : null;
        if (cfg && Object.prototype.hasOwnProperty.call(cfg, key)) return cfg[key];
    } catch {}
    return fallback;
}

/**
 * 注册缩略图生成事件缓冲器
 * @param {Function} flushCallback - 刷新回调函数
 * @returns {BatchQueue} 缓冲器实例
 */
export function registerThumbnailBuffer(flushCallback) {
    return eventBufferManager.registerBuffer('thumbnail-generated', {
        batchWindow: getTunable('sseBatchWindowMs', 20),
        keySelector: (event) => event.path
    }, flushCallback);
}

/**
 * 注册索引更新事件缓冲器
 * @param {Function} flushCallback - 刷新回调函数
 * @returns {BatchQueue} 缓冲器实例
 */
export function registerIndexBuffer(flushCallback) {
    return eventBufferManager.registerBuffer('index-updated', {
        batchWindow: getTunable('indexBatchWindowMs', 100),
        keySelector: (event) => 'index-progress'
    }, flushCallback);
}

/**
 * 注册媒体处理事件缓冲器
 * @param {Function} flushCallback - 刷新回调函数
 * @returns {BatchQueue} 缓冲器实例
 */
export function registerMediaBuffer(flushCallback) {
    return eventBufferManager.registerBuffer('media-processed', {
        batchWindow: getTunable('mediaBatchWindowMs', 50),
        keySelector: (event) => event.path
    }, flushCallback);
}

/**
 * 默认导出全局事件缓冲管理器实例
 */
export default eventBufferManager;
