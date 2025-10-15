/**
 * @file event-manager.js
 * @module EventManager
 * @description
 * 统一事件管理器，避免内存泄漏和重复绑定，支持事件分组、批量管理与自动清理。
 */

import { createModuleLogger } from './logger.js';

const eventLogger = createModuleLogger('EventManager');

/**
 * @class EventRecord
 * @classdesc 单个事件绑定记录，负责事件的绑定与解绑。
 */
class EventRecord {
    /**
     * @constructor
     * @param {EventTarget|NodeList|Array} target 事件目标
     * @param {string} eventType 事件类型
     * @param {Function} handler 事件处理函数
     * @param {object} [options={}] 事件选项
     */
    constructor(target, eventType, handler, options = {}) {
        this.target = target;
        this.eventType = eventType;
        this.handler = handler;
        this.options = options;
        this.id = `${eventType}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
        this.isBound = false;
    }

    /**
     * 绑定事件到目标
     * @returns {boolean} 是否成功绑定
     */
    bind() {
        if (this.isBound || !this.target) return false;

        try {
            if (this.target instanceof EventTarget) {
                this.target.addEventListener(this.eventType, this.handler, this.options);
            } else if (this.target instanceof NodeList || Array.isArray(this.target)) {
                // 批量绑定到多个元素
                this.target.forEach(element => {
                    if (element instanceof EventTarget) {
                        element.addEventListener(this.eventType, this.handler, this.options);
                    }
                });
            }
            this.isBound = true;
            return true;
        } catch (error) {
            eventLogger.warn('Failed to bind event', { eventType: this.eventType, error });
            return false;
        }
    }

    /**
     * 解绑事件
     * @returns {boolean} 是否成功解绑
     */
    unbind() {
        if (!this.isBound || !this.target) return false;

        try {
            if (this.target instanceof EventTarget) {
                this.target.removeEventListener(this.eventType, this.handler, this.options);
            } else if (this.target instanceof NodeList || Array.isArray(this.target)) {
                // 批量解绑多个元素
                this.target.forEach(element => {
                    if (element instanceof EventTarget) {
                        element.removeEventListener(this.eventType, this.handler, this.options);
                    }
                });
            }
            this.isBound = false;
            return true;
        } catch (error) {
            eventLogger.warn('Failed to unbind event', { eventType: this.eventType, error });
            return false;
        }
    }

    /**
     * 检查目标元素是否仍然有效
     * @returns {boolean} 目标元素是否有效
     */
    isTargetValid() {
        if (!this.target) return false;

        if (this.target instanceof EventTarget) {
            // 检查DOM元素是否仍然在文档中
            return !(this.target instanceof Node) || document.contains(this.target);
        }

        if (Array.isArray(this.target) || this.target instanceof NodeList) {
            // 检查数组中的元素是否仍然有效
            return Array.from(this.target).some(element =>
                element instanceof EventTarget && (!(element instanceof Node) || document.contains(element))
            );
        }

        return false;
    }
}

/**
 * @class EventGroup
 * @classdesc 事件组，用于批量管理相关事件的绑定与解绑。
 */
class EventGroup {
    /**
     * @constructor
     * @param {string} name 事件组名称
     */
    constructor(name) {
        this.name = name;
        this.events = new Map();
        this.isActive = false;
    }

    /**
     * 添加事件到组
     * @param {EventTarget|NodeList|Array} target 事件目标
     * @param {string} eventType 事件类型
     * @param {Function} handler 事件处理函数
     * @param {object} [options={}] 事件选项
     * @returns {EventRecord} 事件记录
     */
    add(target, eventType, handler, options = {}) {
        const record = new EventRecord(target, eventType, handler, options);
        const key = `${eventType}:${this.events.size}`;
        this.events.set(key, record);
        return record;
    }

    /**
     * 激活组内所有事件（批量绑定）
     * @returns {void}
     */
    activate() {
        if (this.isActive) return;

        let boundCount = 0;
        for (const record of this.events.values()) {
            if (record.bind()) {
                boundCount++;
            }
        }

        this.isActive = true;

        eventLogger.debug('Activated group', {
            name: this.name,
            boundCount,
            totalEvents: this.events.size
        });
    }

    /**
     * 停用组内所有事件（批量解绑）
     * @returns {void}
     */
    deactivate() {
        if (!this.isActive) return;

        let unboundCount = 0;
        for (const record of this.events.values()) {
            if (record.unbind()) {
                unboundCount++;
            }
        }

        this.isActive = false;

        eventLogger.debug('Deactivated group', {
            name: this.name,
            unboundCount,
            totalEvents: this.events.size
        });
    }

    /**
     * 清理无效的事件记录
     * @returns {void}
     */
    cleanup() {
        const toRemove = [];

        for (const [key, record] of this.events) {
            if (!record.isTargetValid()) {
                toRemove.push(key);
            }
        }

        toRemove.forEach(key => this.events.delete(key));

        if (toRemove.length > 0) {
            eventLogger.debug('Cleaned up invalid events from group', {
                name: this.name,
                cleanedCount: toRemove.length
            });
        }
    }

    /**
     * 获取组的状态信息
     * @returns {object} 组的状态信息
     */
    getStats() {
        return {
            name: this.name,
            eventCount: this.events.size,
            activeEvents: Array.from(this.events.values()).filter(record => record.isBound).length,
            isActive: this.isActive
        };
    }

    /**
     * 销毁事件组，解绑所有事件并清空
     * @returns {void}
     */
    destroy() {
        this.deactivate();
        this.events.clear();
    }
}

/**
 * @class EventManager
 * @classdesc 全局事件管理器，支持事件分组、全局事件、自动清理等功能。
 */
class EventManager {
    /**
     * @constructor
     */
    constructor() {
        /** @type {Map<string, EventGroup>} */
        this.groups = new Map();
        /** @type {Map<string, EventRecord>} */
        this.globalEvents = new Map();
        /** @type {number|null} */
        this.cleanupInterval = null;

        // 启动定期清理
        this.startPeriodicCleanup();
    }

    /**
     * 创建或获取事件组
     * @param {string} name 事件组名称
     * @returns {EventGroup} 事件组
     */
    getGroup(name) {
        if (!this.groups.has(name)) {
            this.groups.set(name, new EventGroup(name));
        }
        return this.groups.get(name);
    }

    /**
     * 删除事件组
     * @param {string} name 事件组名称
     * @returns {void}
     */
    removeGroup(name) {
        const group = this.groups.get(name);
        if (group) {
            group.destroy();
            this.groups.delete(name);
        }
    }

    /**
     * 切换事件组状态
     * @param {string} activeGroupName 要激活的事件组名称
     * @param {boolean} [deactivateOthers=true] 是否停用其他组
     * @returns {void}
     */
    switchToGroup(activeGroupName, deactivateOthers = true) {
        // 停用其他组
        if (deactivateOthers) {
            for (const [name, group] of this.groups) {
                if (name !== activeGroupName && group.isActive) {
                    group.deactivate();
                }
            }
        }

        // 激活指定组
        const targetGroup = this.groups.get(activeGroupName);
        if (targetGroup) {
            targetGroup.activate();
        }
    }

    /**
     * 绑定全局事件（不属于任何组）
     * @param {EventTarget|NodeList|Array} target 事件目标
     * @param {string} eventType 事件类型
     * @param {Function} handler 事件处理函数
     * @param {object} [options={}] 事件选项
     * @returns {string|null} 事件键或null
     */
    bindGlobal(target, eventType, handler, options = {}) {
        const record = new EventRecord(target, eventType, handler, options);
        const key = `global:${record.id}`;

        if (record.bind()) {
            this.globalEvents.set(key, record);
            return key;
        }

        return null;
    }

    /**
     * 解绑全局事件
     * @param {string} key 事件键
     * @returns {boolean} 是否成功解绑
     */
    unbindGlobal(key) {
        const record = this.globalEvents.get(key);
        if (record) {
            record.unbind();
            this.globalEvents.delete(key);
            return true;
        }
        return false;
    }

    /**
     * 批量绑定事件到组
     * @param {string} groupName 事件组名称
     * @param {Array<{target: EventTarget|NodeList|Array, event: string, handler: Function, options?: object}>} bindings 事件绑定数组
     * @returns {EventGroup} 事件组
     */
    bindToGroup(groupName, bindings) {
        const group = this.getGroup(groupName);

        bindings.forEach(({ target, event, handler, options = {} }) => {
            group.add(target, event, handler, options);
        });

        return group;
    }

    /**
     * 清理所有无效的事件绑定
     * @returns {void}
     */
    cleanup() {
        // 清理事件组
        for (const group of this.groups.values()) {
            group.cleanup();
        }

        // 清理全局事件
        const invalidGlobals = [];
        for (const [key, record] of this.globalEvents) {
            if (!record.isTargetValid()) {
                invalidGlobals.push(key);
            }
        }

        invalidGlobals.forEach(key => {
            const record = this.globalEvents.get(key);
            if (record) {
                record.unbind();
                this.globalEvents.delete(key);
            }
        });

        if (invalidGlobals.length > 0) {
            eventLogger.debug('Cleanup completed', {
                removedGlobalEvents: invalidGlobals.length,
                remainingGroups: this.groups.size
            });
        }
    }

    /**
     * 启动定期清理
     * @private
     * @returns {void}
     */
    startPeriodicCleanup() {
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, 5 * 60 * 1000); // 每5分钟清理一次
    }

    /**
     * 获取统计信息
     * @returns {object} 统计信息
     */
    getStats() {
        const groupStats = {};
        for (const [name, group] of this.groups) {
            groupStats[name] = group.getStats();
        }

        return {
            groups: groupStats,
            globalEvents: this.globalEvents.size,
            totalGroups: this.groups.size,
            timestamp: Date.now()
        };
    }

    /**
     * 销毁事件管理器，解绑所有事件并清理资源
     * @returns {void}
     */
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        // 销毁所有事件组
        for (const group of this.groups.values()) {
            group.destroy();
        }
        this.groups.clear();

        // 销毁全局事件
        for (const record of this.globalEvents.values()) {
            record.unbind();
        }
        this.globalEvents.clear();
    }
}

/**
 * @type {EventManager}
 * @description 全局事件管理器实例
 */
export const eventManager = new EventManager();

/**
 * 创建页面特定的事件组
 * @param {string} pageName 页面名称
 * @returns {EventGroup} 事件组
 */
export function createPageGroup(pageName) {
    return eventManager.getGroup(`page:${pageName}`);
}

/**
 * 创建组件特定的事件组
 * @param {string} componentName 组件名称
 * @returns {EventGroup} 事件组
 */
export function createComponentGroup(componentName) {
    return eventManager.getGroup(`component:${componentName}`);
}

/**
 * 创建模态框特定的事件组
 * @param {string} modalName 模态框名称
 * @returns {EventGroup} 事件组
 */
export function createModalGroup(modalName) {
    return eventManager.getGroup(`modal:${modalName}`);
}

/**
 * 切换到指定页面的事件组（激活该组，停用其他组）
 * @param {string} pageName 页面名称
 * @returns {void}
 */
export function switchToPage(pageName) {
    eventManager.switchToGroup(`page:${pageName}`);
}

/**
 * 清理指定页面的事件组
 * @param {string} pageName 页面名称
 * @returns {void}
 */
export function cleanupPage(pageName) {
    eventManager.removeGroup(`page:${pageName}`);
}

export default eventManager;
