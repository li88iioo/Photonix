/**
 * @file loading-states.js
 * @description 统一加载状态管理系统
 * 提供极简加载器、错误状态、空状态等多种加载反馈
 */

import { state } from '../../core/state.js';
import { elements } from '../../shared/dom-elements.js';
import { createModuleLogger } from '../../core/logger.js';
import { safeSetInnerHTML } from '../../shared/dom-utils.js';

const loadingLogger = createModuleLogger('LoadingStates');

/**
 * 显示极简中心加载指示器（替代骨架屏）
 * @param {Object} options - 配置选项
 * @param {string} options.text - 加载文本，默认为 "加载中..."
 * @returns {void}
 */
export function showMinimalLoader(options = {}) {
    const { text = '加载中...' } = options;

    const grid = elements.contentGrid;
    if (!grid) return;

    // 清理虚拟滚动器
    const scroller = state.virtualScroller;
    if (scroller) {
        scroller.destroy();
        state.update('virtualScroller', null);
    }

    // 移除所有布局类，避免干扰
    grid?.classList.remove('grid-mode');
    grid?.classList.remove('masonry-mode');
    grid?.classList.remove('virtual-scroll-mode');

    // 创建居中的加载容器
    const loaderHTML = `
        <div id="minimal-loader" class="minimal-loader">
            <div class="minimal-loader-spinner">
                <span></span>
                <span></span>
                <span></span>
            </div>
            <div class="minimal-loader-text">${text.replace(/[<>]/g, '')}</div>
        </div>
    `;

    safeSetInnerHTML(grid, loaderHTML);

    // 确保容器有足够高度支撑居中布局
    const minHeight = Math.max(400, window.innerHeight - 200);
    grid.style.minHeight = `${minHeight}px`;
}

/**
 * 隐藏极简加载指示器
 * @returns {void}
 */
export function hideMinimalLoader() {
    const grid = elements.contentGrid;
    if (!grid) return;

    const loader = grid.querySelector('#minimal-loader');
    if (loader) {
        // 淡出动画
        loader.style.opacity = '0';
        setTimeout(() => {
            if (loader.parentNode === grid) {
                grid.removeChild(loader);
            }
        }, 200);
    }
}

/**
 * 检查极简加载指示器是否正在显示
 * @returns {boolean}
 */
export function isMinimalLoaderVisible() {
    const grid = elements.contentGrid;
    if (!grid) return false;

    return !!grid.querySelector('#minimal-loader');
}

/**
 * 加载状态管理器
 * @class
 */
class LoadingStateManager {
    constructor() {
        // 构造函数已简化，无需初始化属性
    }

    /**
     * 显示错误状态
     * @param {string} title - 错误标题
     * @param {string} message - 错误消息
     * @param {Array} actions - 操作按钮数组
     * @returns {void}
     */
    showErrorState(title, message, actions = []) {
        // 清理虚拟滚动器
        const scroller = state.virtualScroller;
        if (scroller) {
            scroller.destroy();
            state.update('virtualScroller', null);
        }

        // 隐藏无限滚动加载器，避免重排抖动
        const loaderContainer = document.getElementById('infinite-scroll-loader-container');
        if (loaderContainer) loaderContainer?.classList.remove('visible');

        // 移除虚拟滚动与瀑布流模式，避免空状态被重排
        if (elements.contentGrid) {
            elements.contentGrid?.classList.remove('virtual-scroll-mode');
            elements.contentGrid?.classList.remove('masonry-mode');
            elements.contentGrid?.classList.remove('grid-mode');
            elements.contentGrid.style.height = 'auto';
        }

        const errorHTML = `
            <div class="error-container">
                <div class="error-illustration">
                    <div class="error-icon-container">
                        <svg class="error-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                        </svg>
                    </div>
                </div>
                <div class="error-content">
                    <h2 class="error-title">${title ? title.replace(/[<>]/g, '') : ''}</h2>
                    ${message ? `<p class="error-message">${message.replace(/[<>]/g, '')}</p>` : ''}
                    ${actions.length > 0 ? `
                        <div class="error-actions">
                            ${actions.map((action, index) => `
                                <button class="error-btn ${action.primary ? 'error-btn-primary' : 'error-btn-secondary'}"
                                        data-action="${action.onClick ? action.onClick.toString().replace(/[<>]/g, '') : ''}" data-index="${index}">
                                    ${action.text ? action.text.replace(/[<>]/g, '') : ''}
                                </button>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;

        if (elements.contentGrid) {
            safeSetInnerHTML(elements.contentGrid, errorHTML);

            // 绑定错误按钮事件
            const buttons = elements.contentGrid.querySelectorAll('.error-btn');
            buttons.forEach(button => {
                button.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // 获取按钮的 data-action 属性
                    const action = e.currentTarget.dataset.action;
                    loadingLogger.debug('Error button clicked', { action });
                    if (action === 'reload') {
                        window.location.reload();
                    } else if (action === 'home') {
                        window.location.hash = '#/';
                    }
                });
            });
        }
    }

    /**
     * 显示空状态
     * @param {string} title - 空状态标题
     * @param {string} message - 空状态消息
     * @param {Array} actions - 操作按钮数组
     * @returns {void}
     */
    showEmptyState(title, message, actions = []) {
        // 清理虚拟滚动器
        const scroller = state.virtualScroller;
        if (scroller) {
            scroller.destroy();
            state.update('virtualScroller', null);
        }

        // 隐藏无限滚动加载器，避免重排抖动
        const loaderContainer = document.getElementById('infinite-scroll-loader-container');
        if (loaderContainer) loaderContainer?.classList.remove('visible');

        // 移除虚拟滚动与瀑布流模式，避免空状态被重排
        if (elements.contentGrid) {
            elements.contentGrid?.classList.remove('virtual-scroll-mode');
            elements.contentGrid?.classList.remove('masonry-mode');
            elements.contentGrid?.classList.remove('grid-mode');
            elements.contentGrid.style.height = 'auto';
        }

        const emptyHTML = `
            <div class="empty-state">
                <div class="empty-illustration">
                    <div class="empty-icon-container">
                        <svg class="empty-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                        </svg>
                    </div>
                </div>
                <div class="empty-content">
                    <h2 class="empty-title">${title ? title.replace(/[<>]/g, '') : ''}</h2>
                    ${message ? `<p class="empty-message">${message.replace(/[<>]/g, '')}</p>` : ''}
                    ${actions.length > 0 ? `
                        <div class="empty-actions">
                            ${actions.map((action, index) => `
                                <button class="empty-btn ${action.primary ? 'empty-btn-primary' : 'empty-btn-secondary'}"
                                        data-action="${action.onClick ? action.onClick.toString().replace(/[<>]/g, '') : ''}" data-index="${index}">
                                    ${action.text ? action.text.replace(/[<>]/g, '') : ''}
                                </button>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;

        if (elements.contentGrid) {
            safeSetInnerHTML(elements.contentGrid, emptyHTML);

            // 绑定空状态按钮事件
            const buttons = elements.contentGrid.querySelectorAll('.empty-btn');
            buttons.forEach(button => {
                button.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // 获取按钮的 data-action 属性
                    const action = e.currentTarget.dataset.action;
                    loadingLogger.debug('Empty button clicked', { action });
                    if (action === 'reload') {
                        window.location.reload();
                    } else if (action === 'home') {
                        window.location.hash = '#/';
                    } else if (action === 'browse') {
                        window.location.hash = '#/browse';
                    } else if (action === 'back') {
                        history.back();
                    }
                });
            });
        }
    }
}

/**
 * 全局加载状态管理器实例
 * @type {LoadingStateManager}
 */
export const loadingStateManager = new LoadingStateManager();

/**
 * 显示网络错误状态
 * @function
 * @returns {void}
 */
export function showNetworkError() {
    loadingStateManager.showErrorState(
        '无法连接到服务器，请检查网络连接后重试',
        '',
        [
            {
                text: '重试',
                primary: true,
                onClick: 'reload'
            },
            {
                text: '返回首页',
                primary: false,
                onClick: 'home'
            }
        ]
    );
}


/**
 * 显示空搜索结果状态
 * @function
 * @param {string} query - 搜索查询
 * @returns {void}
 */
export function showEmptySearchResults(query) {
    // 隐藏无限滚动加载器，避免重排抖动
    if (elements.infiniteScrollLoader) elements.infiniteScrollLoader?.classList.remove('visible');

    loadingStateManager.showEmptyState(
        `没有找到与"${query}"相关的相册或图片。请尝试其他关键词。`,
        '',
        [
            {
                text: '返回首页',
                primary: true,
                onClick: 'home'
            }
        ]
    );
}

export function showEmptyViewedHistory() {
    loadingStateManager.showEmptyState(
        '暂无浏览记录',
        '浏览过的相册会显示在这里。',
        []
    );
}

/**
 * 显示空相册状态
 * @function
 * @returns {void}
 */
export function showEmptyAlbum() {
    // 隐藏无限滚动加载器，避免重排抖动
    if (elements.infiniteScrollLoader) elements.infiniteScrollLoader?.classList.remove('visible');

    loadingStateManager.showEmptyState(
        '这个相册还没有任何图片或视频',
        '',
        [
            {
                text: '返回上级',
                primary: true,
                onClick: 'back'
            }
        ]
    );
}

/**
 * 显示缺失相册状态
 * @returns {void}
 */
export function showMissingAlbumState() {
    if (elements.infiniteScrollLoader) elements.infiniteScrollLoader?.classList.remove('visible');

    loadingStateManager.showEmptyState(
        '未找到该相册，可能已被移动或删除',
        '请选择其他相册，或返回上一页继续浏览。',
        [
            {
                text: '返回上级',
                primary: true,
                onClick: 'back'
            },
            {
                text: '返回首页',
                primary: false,
                onClick: 'home'
            }
        ]
    );
}

/**
 * 显示现代化后端连接状态
 * @remarks
 * 连接态展示已在应用层用骨架/占位统一处理，无需单独导出 API
 */

/**
 * 显示搜索索引构建中错误状态
 * @function
 * @returns {void}
 */
export function showIndexBuildingError() {
    // 隐藏无限滚动加载器，避免重排抖动
    if (elements.infiniteScrollLoader) elements.infiniteScrollLoader?.classList.remove('visible');

    loadingStateManager.showErrorState(
        '搜索功能暂时不可用，索引正在后台构建中，请稍后再试',
        '',
        [
            {
                text: '重试',
                primary: true,
                onClick: 'reload'
            },
            {
                text: '返回首页',
                primary: false,
                onClick: 'home'
            }
        ]
    );
}
