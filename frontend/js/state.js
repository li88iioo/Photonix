// frontend/js/state.js

import { map } from 'nanostores';

/**
 * ----------------------------------------------------------------
 * 主应用状态
 * ----------------------------------------------------------------
 * 使用 nanostores 的 map store 来管理整个应用的响应式状态。
 * 替代了原有的手动实现的 StateManager。
 */
const appStateStore = map({
    // 应用状态和API配置
    userId: null,
    API_BASE: '',
    currentPhotos: [],
    currentPhotoIndex: 0,
    isModalNavigating: false,
    isBlurredMode: false,
    captionDebounceTimer: null,
    currentAbortController: null,
    currentObjectURL: null,
    scrollPositions: new Map(),
    scrollPositionBeforeModal: null,
    activeThumbnail: null,
    preSearchHash: '#/',
    searchDebounceTimer: null,
    hasShownNavigationHint: false,
    lastWheelTime: 0,
    uiVisibilityTimer: null,
    activeBackdrop: 'one',
    isInitialLoad: true,
    aiEnabled: false,
    passwordEnabled: false,

    // 缩略图请求队列
    thumbnailRequestQueue: [],
    activeThumbnailRequests: 0,
    MAX_CONCURRENT_THUMBNAIL_REQUESTS: Math.min(12, (navigator.hardwareConcurrency || 4) < 6 ? 8 : 12),

    // 搜索和浏览状态
    isSearchLoading: false,
    currentSearchPage: 1,
    totalSearchPages: 1,
    currentSearchQuery: '',
    isBrowseLoading: false,
    currentBrowsePage: 1,
    totalBrowsePages: 1,
    currentBrowsePath: null,
    currentSort: 'smart',
    entrySort: 'smart',
    currentColumnCount: 0,
    currentLayoutWidth: 0,
    pageCache: new Map(),

    // 预览布局模式
    layoutMode: (typeof localStorage !== 'undefined' && localStorage.getItem('sg_layout_mode')) || 'grid',
});

/**
 * ----------------------------------------------------------------
 * 同步任务状态
 * ----------------------------------------------------------------
 * 用于管理缩略图、索引等后台任务的状态。
 */
const syncStateStore = map({
    isSilent: false,
    isMonitoring: false,
    monitoringType: null,
    monitoringIntervalId: null,
    monitoringTimeoutId: null,
});

// syncStateStore 的辅助函数，模拟旧的类方法
const syncStateProxy = {
    get isSilent() { return syncStateStore.get().isSilent; },
    get isMonitoring() { return syncStateStore.get().isMonitoring; },
    get monitoringType() { return syncStateStore.get().monitoringType; },
    get monitoringIntervalId() { return syncStateStore.get().monitoringIntervalId; },
    get monitoringTimeoutId() { return syncStateStore.get().monitoringTimeoutId; },
    
    setSilentMode(silent) {
        syncStateStore.setKey('isSilent', Boolean(silent));
    },
    startMonitoring(type) {
        syncStateStore.setKey('isMonitoring', true);
        syncStateStore.setKey('monitoringType', type);
    },
    stopMonitoring() {
        const { monitoringIntervalId, monitoringTimeoutId } = syncStateStore.get();
        if (monitoringIntervalId) clearInterval(monitoringIntervalId);
        if (monitoringTimeoutId) clearTimeout(monitoringTimeoutId);
        syncStateStore.set({
            ...syncStateStore.get(),
            isMonitoring: false,
            monitoringType: null,
            monitoringIntervalId: null,
            monitoringTimeoutId: null,
        });
    },
    setMonitoringTimers(intervalId, timeoutId) {
        syncStateStore.setKey('monitoringIntervalId', intervalId);
        syncStateStore.setKey('monitoringTimeoutId', timeoutId);
    },
    reset() {
        this.stopMonitoring();
        this.setSilentMode(false);
    }
};
// 旧文件导出了一个实例，所以我们导出代理对象。
export const syncState = syncStateProxy;

/**
 * ----------------------------------------------------------------
 * 兼容层 (StateManager 兼容层)
 * ----------------------------------------------------------------
 */
const stateManagerInstance = {
    _store: appStateStore,
    
    get state() {
        return this._store.get();
    },

    subscribe(keys, callback) {
        const keyArray = Array.isArray(keys) ? keys : [keys];
        
        let lastKnownValues = {};
        keyArray.forEach(k => lastKnownValues[k] = this.state[k]);

        const unsubscribe = this._store.listen(currentState => {
            const changedKeys = [];
            for (const key of keyArray) {
                if (lastKnownValues[key] !== currentState[key]) {
                    changedKeys.push(key);
                    lastKnownValues[key] = currentState[key];
                }
            }
            if (changedKeys.length > 0) {
                callback(changedKeys, currentState);
            }
        });
        return unsubscribe;
    },

    update(key, value) {
        if (this.state[key] !== value) {
            this._store.setKey(key, value);
        }
    },

    batchUpdate(updates) {
        this._store.set({ ...this.state, ...updates });
    },

    get(key) {
        return this.state[key];
    },

    getMultiple(keys) {
        const result = {};
        const currentState = this.state;
        keys.forEach(key => {
            result[key] = currentState[key];
        });
        return result;
    },

    getAll() {
        return { ...this.state };
    }
};

// 导出管理器实例，供直接使用它的代码使用
export const stateManager = stateManagerInstance;

// 导出代理对象，这是访问状态的主要方式
export const state = new Proxy(stateManagerInstance, {
    get(target, prop) {
        if (typeof target[prop] === 'function') {
            return target[prop].bind(target);
        }
        if (prop in target.state) {
            return target.state[prop];
        }
        return target[prop];
    },
    set(target, prop, value) {
        if (prop in target.state) {
            target.update(prop, value);
            return true;
        }
        target[prop] = value;
        return true;
    }
});


/**
 * 模态框背景元素
 */
export const backdrops = {
    one: document.getElementById('modal-backdrop-one'),
    two: document.getElementById('modal-backdrop-two')
};

/**
 * DOM元素选择器
 */
export const elements = {
    galleryView: document.getElementById('gallery-view'),
    contentGrid: document.getElementById('content-grid'),
    loadingIndicator: document.getElementById('loading'),
    breadcrumbNav: document.getElementById('breadcrumb-nav'),
    modal: document.getElementById('modal'),
    modalContent: document.getElementById('modal-content'),
    modalImg: document.getElementById('modal-img'),
    modalVideo: document.getElementById('modal-video'),
    modalClose: document.getElementById('modal-close'),
    aiControlsContainer: document.getElementById('ai-controls-container'),
    captionContainer: document.getElementById('caption-container'),
    captionContainerMobile: document.getElementById('caption-container-mobile'),
    captionBubble: document.getElementById('caption-bubble'),
    captionBubbleWrapper: document.getElementById('caption-bubble-wrapper'),
    toggleCaptionBtn: document.getElementById('toggle-caption-btn'),
    navigationHint: document.getElementById('navigation-hint'),
    mediaPanel: document.getElementById('media-panel'),
    searchInput: document.getElementById('search-input'),
    infiniteScrollLoader: document.getElementById('infinite-scroll-loader-container'),
};

export function validateSyncState() {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        console.debug('[状态验证] 当前同步状态:', {
            isSilent: syncState.isSilent,
            isMonitoring: syncState.isMonitoring,
            monitoringType: syncState.monitoringType,
            hasInterval: !!syncState.monitoringIntervalId,
            hasTimeout: !!syncState.monitoringTimeoutId
        });
    }
}

export function cleanupSyncState() {
    syncState.reset();
}

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', cleanupSyncState);
}