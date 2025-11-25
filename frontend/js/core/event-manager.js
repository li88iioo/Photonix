/**
 * @file event-manager.js
 * @module EventManager
 * @description
 * 简化的事件管理工具，基于原生 AbortController 实现自动清理。
 */

import { createModuleLogger } from './logger.js';

const eventLogger = createModuleLogger('EventManager');

/**
 * 创建一个新的 AbortController 用于管理事件生命周期
 * @returns {AbortController} 新的 AbortController 实例
 */
export function createController() {
    return new AbortController();
}

/**
 * 添加事件监听器，支持通过 AbortController 自动管理解绑
 * @param {EventTarget|NodeList|Array} target - 事件目标
 * @param {string} eventType - 事件类型
 * @param {Function} handler - 事件处理函数
 * @param {object} [options={}] - 事件选项，可包含 signal 用于自动清理
 * @returns {void}
 */
export function on(target, eventType, handler, options = {}) {
    if (!target || !eventType || !handler) {
        eventLogger.warn('Invalid event binding parameters', { target, eventType, handler });
        return;
    }

    try {
        if (target instanceof EventTarget) {
            target.addEventListener(eventType, handler, options);
        } else if (target instanceof NodeList || Array.isArray(target)) {
            // 批量绑定到多个元素
            target.forEach(element => {
                if (element instanceof EventTarget) {
                    element.addEventListener(eventType, handler, options);
                }
            });
        }
    } catch (error) {
        eventLogger.warn('Failed to bind event', { eventType, error });
    }
}

/**
 * 移除事件监听器
 * @param {EventTarget|NodeList|Array} target - 事件目标
 * @param {string} eventType - 事件类型
 * @param {Function} handler - 事件处理函数
 * @param {object} [options={}] - 事件选项
 * @returns {void}
 */
export function off(target, eventType, handler, options = {}) {
    if (!target || !eventType || !handler) {
        return;
    }

    try {
        if (target instanceof EventTarget) {
            target.removeEventListener(eventType, handler, options);
        } else if (target instanceof NodeList || Array.isArray(target)) {
            // 批量解绑多个元素
            target.forEach(element => {
                if (element instanceof EventTarget) {
                    element.removeEventListener(eventType, handler, options);
                }
            });
        }
    } catch (error) {
        eventLogger.warn('Failed to unbind event', { eventType, error });
    }
}

/**
 * 全局事件管理器（保持向后兼容）
 * 新代码应该使用 createController() + on() 的方式
 */
class EventManager {
    constructor() {
        this.controllers = new Map();
    }

    /**
     * 创建或获取命名的 AbortController
     * @param {string} name - 控制器名称
     * @returns {AbortController}
     */
    getController(name) {
        if (!this.controllers.has(name)) {
            this.controllers.set(name, new AbortController());
        }
        return this.controllers.get(name);
    }

    /**
     * 中止并移除命名的控制器
     * @param {string} name - 控制器名称
     */
    abortController(name) {
        const controller = this.controllers.get(name);
        if (controller) {
            controller.abort();
            this.controllers.delete(name);
        }
    }

    /**
     * 绑定事件到命名的控制器
     * @param {string} groupName - 组名称
     * @param {EventTarget} target - 事件目标
     * @param {string} eventType - 事件类型
     * @param {Function} handler - 事件处理函数
     * @param {object} [options={}] - 事件选项
     */
    bindToGroup(groupName, target, eventType, handler, options = {}) {
        const controller = this.getController(groupName);
        on(target, eventType, handler, { ...options, signal: controller.signal });
    }

    /**
     * 移除事件组（中止所有相关事件）
     * @param {string} groupName - 组名称
     */
    removeGroup(groupName) {
        this.abortController(groupName);
    }

    /**
     * 销毁所有事件
     */
    destroy() {
        for (const controller of this.controllers.values()) {
            controller.abort();
        }
        this.controllers.clear();
    }
}

/**
 * 全局事件管理器实例（保持向后兼容）
 */
export const eventManager = new EventManager();

/**
 * 创建页面特定的事件控制器
 * @param {string} pageName - 页面名称
 * @returns {AbortController} AbortController 实例
 */
export function createPageGroup(pageName) {
    return eventManager.getController(`page:${pageName}`);
}

/**
 * 创建组件特定的事件控制器
 * @param {string} componentName - 组件名称
 * @returns {AbortController} AbortController 实例
 */
export function createComponentGroup(componentName) {
    return eventManager.getController(`component:${componentName}`);
}

/**
 * 清理指定页面的事件
 * @param {string} pageName - 页面名称
 */
export function cleanupPage(pageName) {
    eventManager.removeGroup(`page:${pageName}`);
}

export default eventManager;
