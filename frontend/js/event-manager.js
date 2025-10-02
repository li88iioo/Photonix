// frontend/js/event-manager.js
// 统一事件管理器 - 避免内存泄漏和重复绑定

import { createModuleLogger } from './logger.js';

const eventLogger = createModuleLogger('EventManager');

/**
 * 事件绑定记录
 */
class EventRecord {
    constructor(target, eventType, handler, options = {}) {
        this.target = target;
        this.eventType = eventType;
        this.handler = handler;
        this.options = options;
        this.id = `${eventType}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
        this.isBound = false;
    }

    /**
     * 绑定事件
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
 * 事件组 - 用于批量管理相关事件
 */
class EventGroup {
    constructor(name) {
        this.name = name;
        this.events = new Map();
        this.isActive = false;
    }

    /**
     * 添加事件到组
     */
    add(target, eventType, handler, options = {}) {
        const record = new EventRecord(target, eventType, handler, options);
        const key = `${eventType}:${this.events.size}`;
        this.events.set(key, record);
        return record;
    }

    /**
     * 激活组中的所有事件
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
     * 停用组中的所有事件
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
     * 销毁事件组
     */
    destroy() {
        this.deactivate();
        this.events.clear();
    }
}

/**
 * 全局事件管理器
 */
class EventManager {
    constructor() {
        this.groups = new Map();
        this.globalEvents = new Map();
        this.cleanupInterval = null;

        // 启动定期清理
        this.startPeriodicCleanup();
    }

    /**
     * 创建或获取事件组
     */
    getGroup(name) {
        if (!this.groups.has(name)) {
            this.groups.set(name, new EventGroup(name));
        }
        return this.groups.get(name);
    }

    /**
     * 删除事件组
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
     */
    startPeriodicCleanup() {
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, 5 * 60 * 1000); // 每5分钟清理一次
    }

    /**
     * 获取统计信息
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
     * 销毁事件管理器
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

// 创建全局实例
export const eventManager = new EventManager();

/**
 * 便捷函数：创建页面特定的事件组
 * @param {string} pageName - 页面名称
 * @returns {EventGroup} 事件组
 */
export function createPageGroup(pageName) {
    return eventManager.getGroup(`page:${pageName}`);
}

/**
 * 便捷函数：创建组件特定的事件组
 * @param {string} componentName - 组件名称
 * @returns {EventGroup} 事件组
 */
export function createComponentGroup(componentName) {
    return eventManager.getGroup(`component:${componentName}`);
}

/**
 * 便捷函数：创建模态框特定的事件组
 * @param {string} modalName - 模态框名称
 * @returns {EventGroup} 事件组
 */
export function createModalGroup(modalName) {
    return eventManager.getGroup(`modal:${modalName}`);
}

/**
 * 便捷函数：切换到指定的页面事件组
 * @param {string} pageName - 页面名称
 */
export function switchToPage(pageName) {
    eventManager.switchToGroup(`page:${pageName}`);
}

/**
 * 便捷函数：清理指定页面的事件组
 * @param {string} pageName - 页面名称
 */
export function cleanupPage(pageName) {
    eventManager.removeGroup(`page:${pageName}`);
}

export default eventManager;
