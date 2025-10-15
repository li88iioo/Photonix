/**
 * @file lazyload-state-manager.js
 * @module features/gallery/lazyload-state-manager
 * @description
 * 懒加载状态管理器，封装页面懒加载相关的状态保存、恢复与防护清理，避免全局 window 污染，提供模块化接口。
 */

import { savePageLazyState, restorePageLazyState, clearRestoreProtection } from './lazyload.js';

/**
 * @class LazyLoadStateManager
 * @classdesc
 * 懒加载状态管理器类，封装懒加载相关的状态保存和恢复功能。
 */
class LazyLoadStateManager {
    /**
     * @constructor
     * 状态管理器无需显式初始化。
     */
    constructor() {}

    /**
     * 保存页面懒加载状态
     * @param {string} pageKey 页面标识符
     * @returns {boolean} 保存是否成功
     */
    saveState(pageKey) {
        if (typeof savePageLazyState === 'function' && pageKey) {
            return savePageLazyState(pageKey);
        }
        return false;
    }

    /**
     * 恢复页面懒加载状态
     * @param {string} pageKey 页面标识符
     * @returns {boolean} 恢复是否成功
     */
    restoreState(pageKey) {
        if (typeof restorePageLazyState === 'function' && pageKey) {
            return restorePageLazyState(pageKey);
        }
        return false;
    }

    /**
     * 清理懒加载恢复防护
     * @returns {void}
     */
    clearProtection() {
        if (typeof clearRestoreProtection === 'function') {
            clearRestoreProtection();
        }
    }

    /**
     * 检查状态管理器依赖的方法是否可用
     * @returns {boolean} 是否可用
     */
    isAvailable() {
        return typeof savePageLazyState === 'function' &&
               typeof restorePageLazyState === 'function' &&
               typeof clearRestoreProtection === 'function';
    }
}

/** @type {LazyLoadStateManager} 懒加载状态管理器单例 */
const lazyLoadStateManager = new LazyLoadStateManager();

/**
 * 默认导出懒加载状态管理器单例
 * @type {LazyLoadStateManager}
 */
export { lazyLoadStateManager as default, LazyLoadStateManager };

/**
 * 保存懒加载状态的便捷方法
 * @function
 * @param {string} pageKey 页面标识符
 * @returns {boolean}
 */
export const saveLazyLoadState = (pageKey) => lazyLoadStateManager.saveState(pageKey);

/**
 * 恢复懒加载状态的便捷方法
 * @function
 * @param {string} pageKey 页面标识符
 * @returns {boolean}
 */
export const restoreLazyLoadState = (pageKey) => lazyLoadStateManager.restoreState(pageKey);

/**
 * 清理懒加载恢复防护的便捷方法
 * @function
 * @returns {void}
 */
export const clearLazyLoadProtection = () => lazyLoadStateManager.clearProtection();
