// frontend/js/event-buffer.js
// 统一事件缓冲/节流门面 - 处理高频事件批处理和验证

import errorHandler, { ErrorTypes, ErrorSeverity } from './error-handler.js';
import { createModuleLogger } from './logger.js';
import { EVENT_BUFFER } from './constants.js';

const eventBufferLogger = createModuleLogger('EventBuffer');

// 使用统一的EVENT_BUFFER配置常量

// 使用统一的EVENT_BUFFER.VALIDATORS配置

/**
 * 批处理队列管理器
 */
class BatchQueue {
    constructor(eventType, config = {}) {
        this.eventType = eventType;
        this.batchWindow = config.batchWindow || EVENT_BUFFER.CONFIG.defaultBatchWindow;
        this.maxBatchSize = config.maxBatchSize || EVENT_BUFFER.CONFIG.maxBatchSize;
        this.flushCallback = config.flushCallback;
        this.keySelector = config.keySelector || ((item) => item.id || item.path || JSON.stringify(item));

        this.queue = new Map();
        this.flushTimer = null;
        this.stats = {
            totalEvents: 0,
            batchesProcessed: 0,
            avgBatchSize: 0,
            lastFlush: Date.now()
        };
    }

    /**
     * 添加事件到队列
     * @param {object} event - 事件数据
     */
    enqueue(event) {
        const key = this.keySelector(event);
        this.queue.set(key, event);
        this.stats.totalEvents++;

        // 如果队列达到最大大小，立即刷新
        if (this.queue.size >= this.maxBatchSize) {
            this.flush();
            return;
        }

        // 设置延迟刷新定时器
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => {
                this.flush();
            }, this.batchWindow);
        }
    }

    /**
     * 立即刷新队列
     */
    flush() {
        if (this.queue.size === 0) return;

        // 清除定时器
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        // 提取批次数据
        const batch = Array.from(this.queue.values());
        this.queue.clear();

        // 更新统计信息
        this.stats.batchesProcessed++;
        this.stats.avgBatchSize = (this.stats.avgBatchSize * (this.stats.batchesProcessed - 1) + batch.length) / this.stats.batchesProcessed;
        this.stats.lastFlush = Date.now();

        // 执行刷新回调
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

        // 开发模式下输出统计信息
        if (this.stats.batchesProcessed % 10 === 0) {
            eventBufferLogger.debug('批次统计', {
                eventType: this.eventType,
                总事件: this.stats.totalEvents,
                处理批次: this.stats.batchesProcessed,
                平均批大小: this.stats.avgBatchSize.toFixed(1),
                队列大小: this.queue.size
            });
        }
    }

    /**
     * 清理资源
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
 * 统一事件缓冲管理器
 */
class EventBufferManager {
    constructor() {
        this.buffers = new Map();
        this.cleanupTimer = null;

        // 启动定期清理
        this.startCleanupTimer();
    }

    /**
     * 注册事件缓冲器
     * @param {string} eventType - 事件类型
     * @param {object} config - 配置选项
     * @param {Function} flushCallback - 刷新回调函数
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
     * 处理传入事件
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

        // 添加到缓冲队列
        buffer.enqueue(payload);
        return true;
    }

    /**
     * 验证事件数据
     * @param {string} eventType - 事件类型
     * @param {object} payload - 事件载荷
     * @returns {object} 验证结果
     */
    validateEvent(eventType, payload) {
        const validator = EVENT_BUFFER.VALIDATORS[eventType];
        if (!validator) {
            // 没有特定验证器的默认验证
            return { ok: true };
        }

        return validator(payload);
    }

    /**
     * 立即刷新指定类型的缓冲器
     * @param {string} eventType - 事件类型
     */
    flushBuffer(eventType) {
        const buffer = this.buffers.get(eventType);
        if (buffer) {
            buffer.flush();
        }
    }

    /**
     * 刷新所有缓冲器
     */
    flushAll() {
        for (const buffer of this.buffers.values()) {
            buffer.flush();
        }
    }

    /**
     * 获取缓冲器统计信息
     * @param {string} eventType - 事件类型（可选，获取所有）
     * @returns {object} 统计信息
     */
    getStats(eventType) {
        if (eventType) {
            const buffer = this.buffers.get(eventType);
            return buffer ? buffer.stats : null;
        }

        const stats = {};
        for (const [type, buffer] of this.buffers) {
            stats[type] = { ...buffer.stats };
        }
        return stats;
    }

    /**
     * 启动定期清理定时器
     */
    startCleanupTimer() {
        this.cleanupTimer = setInterval(() => {
            this.flushAll();
        }, EVENT_BUFFER.CONFIG.cleanupInterval);
    }

    /**
     * 销毁管理器
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

// 创建全局实例
export const eventBufferManager = new EventBufferManager();

/**
 * 获取可调参数，支持全局配置覆盖
 * @param {string} key - 参数键
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
 * 便捷函数：注册缩略图生成事件缓冲器
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
 * 便捷函数：注册索引更新事件缓冲器
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
 * 便捷函数：注册媒体处理事件缓冲器
 * @param {Function} flushCallback - 刷新回调函数
 * @returns {BatchQueue} 缓冲器实例
 */
export function registerMediaBuffer(flushCallback) {
    return eventBufferManager.registerBuffer('media-processed', {
        batchWindow: getTunable('mediaBatchWindowMs', 50),
        keySelector: (event) => event.path
    }, flushCallback);
}

// 导出默认实例
export default eventBufferManager;
