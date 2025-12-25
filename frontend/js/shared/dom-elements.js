/**
 * @file frontend/js/shared/dom-elements.js
 * @description 统一管理全局 DOM 元素引用，降低循环依赖风险
 */


// 创建DOM元素引用
export const elements = {
    // 主要容器
    galleryView: document.getElementById('gallery-view'),
    contentGrid: document.getElementById('content-grid'),
    loadingIndicator: document.getElementById('loading'),
    breadcrumbNav: document.getElementById('breadcrumb-nav'),

    // 模态框相关
    modal: document.getElementById('modal'),
    modalContent: document.getElementById('modal-content'),
    modalLayout: document.getElementById('modal-layout'),
    modalImg: document.getElementById('modal-img'),
    modalVideo: document.getElementById('modal-video'),
    modalClose: document.getElementById('modal-close'),
    modalToolbar: document.getElementById('modal-toolbar'),
    settingsModal: document.getElementById('settings-modal'),
    imageModal: document.getElementById('image-modal'),
    videoModal: document.getElementById('video-modal'),

    // AI 对话
    aiChatWrapper: document.getElementById('ai-chat-wrapper'),
    aiChatHistory: document.getElementById('ai-chat-history'),
    aiChatForm: document.getElementById('ai-chat-form'),
    aiChatInput: document.getElementById('ai-chat-input'),
    aiChatClear: document.getElementById('ai-chat-clear'),
    aiChatStatus: document.getElementById('ai-chat-status'),
    aiCloseHint: document.getElementById('ai-close-hint'),
    aiCloseHintDismiss: document.getElementById('ai-close-hint-dismiss'),

    // 导航和搜索
    navigationHint: document.getElementById('navigation-hint'),
    searchInput: document.getElementById('search-input'),
    searchForm: document.getElementById('search-form'),

    // 媒体面板
    mediaPanel: document.getElementById('media-panel'),

    // 无限滚动
    infiniteScrollLoader: document.getElementById('infinite-scroll-loader'),
    infiniteScrollLoaderContainer: document.getElementById('infinite-scroll-loader-container'),

    // 其他UI元素
    sortContainer: document.getElementById('sort-container'),
    layoutToggle: document.getElementById('layout-toggle'),
    layoutToggleBtn: document.getElementById('layout-toggle-btn'),
    backToTopBtn: document.getElementById('back-to-top-btn')
};

/**
 * 重新捕获动态节点的 DOM 引用。
 * @returns {void}
 */
export function reinitializeElements() {
    elements.contentGrid = document.getElementById('content-grid');
    elements.breadcrumbNav = document.getElementById('breadcrumb-nav');
    elements.infiniteScrollLoader = document.getElementById('infinite-scroll-loader');
    elements.infiniteScrollLoaderContainer = document.getElementById('infinite-scroll-loader-container');
    elements.modalLayout = document.getElementById('modal-layout');
    elements.modalToolbar = document.getElementById('modal-toolbar');
    elements.aiCloseHint = document.getElementById('ai-close-hint');
    elements.aiCloseHintDismiss = document.getElementById('ai-close-hint-dismiss');
    const topbarRightContainer = document.querySelector('#topbar .topbar-actions');
    elements.sortContainer = topbarRightContainer;
    elements.layoutToggle = document.getElementById('layout-toggle');
    elements.layoutToggleBtn = document.getElementById('layout-toggle-btn');
}
