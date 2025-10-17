/**
 * @file frontend/js/shared/dom-elements.js
 * @description 统一管理全局 DOM 元素引用，降低循环依赖风险
 */

import { safeGetElementById } from './dom-utils.js';

// 创建DOM元素引用
export const elements = {
    // 主要容器
    galleryView: safeGetElementById('gallery-view'),
    contentGrid: safeGetElementById('content-grid'),
    loadingIndicator: safeGetElementById('loading'),
    breadcrumbNav: safeGetElementById('breadcrumb-nav'),

    // 模态框相关
    modal: safeGetElementById('modal'),
    modalContent: safeGetElementById('modal-content'),
    modalImg: safeGetElementById('modal-img'),
    modalVideo: safeGetElementById('modal-video'),
    modalClose: safeGetElementById('modal-close'),
    settingsModal: safeGetElementById('settings-modal'),
    imageModal: safeGetElementById('image-modal'),
    videoModal: safeGetElementById('video-modal'),

    // AI和字幕相关
    aiControlsContainer: safeGetElementById('ai-controls-container'),
    captionContainer: safeGetElementById('caption-container'),
    captionContainerMobile: safeGetElementById('caption-container-mobile'),
    captionBubble: safeGetElementById('caption-bubble'),

    // 导航和搜索
    navigationHint: safeGetElementById('navigation-hint'),
    searchInput: safeGetElementById('search-input'),
    searchForm: safeGetElementById('search-form'),

    // 媒体面板
    mediaPanel: safeGetElementById('media-panel'),

    // 无限滚动
    infiniteScrollLoader: safeGetElementById('infinite-scroll-loader'),
    infiniteScrollLoaderContainer: safeGetElementById('infinite-scroll-loader-container'),

    // 其他UI元素
    sortContainer: safeGetElementById('sort-container'),
    layoutToggle: safeGetElementById('layout-toggle'),
    layoutToggleBtn: safeGetElementById('layout-toggle-btn'),
    backToTopBtn: safeGetElementById('back-to-top-btn')
};

/**
 * 重新捕获动态节点的 DOM 引用。
 * @returns {void}
 */
export function reinitializeElements() {
    elements.contentGrid = safeGetElementById('content-grid');
    elements.breadcrumbNav = safeGetElementById('breadcrumb-nav');
    elements.infiniteScrollLoader = safeGetElementById('infinite-scroll-loader');
    elements.infiniteScrollLoaderContainer = safeGetElementById('infinite-scroll-loader-container');
    elements.sortContainer = safeGetElementById('sort-container');
    elements.layoutToggle = safeGetElementById('layout-toggle');
    elements.layoutToggleBtn = safeGetElementById('layout-toggle-btn');
}
