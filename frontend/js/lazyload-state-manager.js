/**
 * 懒加载状态管理器
 * 替代全局window对象污染，提供模块化的状态管理
 */

import { savePageLazyState, restorePageLazyState, clearRestoreProtection } from './lazyload.js';

/**
 * 懒加载状态管理器类
 * 封装懒加载相关的状态保存和恢复功能
 */
class LazyLoadStateManager {
    constructor() {
        // 状态管理器无需显式初始化
    }

    /**
     * 保存页面懒加载状态
     * @param {string} pageKey - 页面标识符
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
     * @param {string} pageKey - 页面标识符
     * @returns {boolean} 恢复是否成功
     */
    restoreState(pageKey) {
        if (typeof restorePageLazyState === 'function' && pageKey) {
            return restorePageLazyState(pageKey);
        }
        return false;
    }

    /**
     * 清理恢复防护
     */
    clearProtection() {
        if (typeof clearRestoreProtection === 'function') {
            clearRestoreProtection();
        }
    }

    /**
     * 检查状态管理器是否可用
     * @returns {boolean} 是否可用
     */
    isAvailable() {
        return typeof savePageLazyState === 'function' &&
               typeof restorePageLazyState === 'function' &&
               typeof clearRestoreProtection === 'function';
    }
}

// 创建单例实例
const lazyLoadStateManager = new LazyLoadStateManager();

// 导出单例实例和类
export { lazyLoadStateManager as default, LazyLoadStateManager };

// 导出便捷方法
export const saveLazyLoadState = (pageKey) => lazyLoadStateManager.saveState(pageKey);
export const restoreLazyLoadState = (pageKey) => lazyLoadStateManager.restoreState(pageKey);
export const clearLazyLoadProtection = () => lazyLoadStateManager.clearProtection();
