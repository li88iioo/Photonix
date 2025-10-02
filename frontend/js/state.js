// frontend/js/state.js

import { map } from 'nanostores';
import { createModuleLogger } from './logger.js';
import { safeGetElementById } from './dom-utils.js';

const stateLogger = createModuleLogger('State');

/**
 * ----------------------------------------------------------------
 * 统一应用状态管理
 * ----------------------------------------------------------------
 * 使用单一的 nanostores map store 来管理所有应用状态。
 * 统一的状态管理策略，避免状态分散和不一致问题。
 */
const appStateStore = map({
    // 应用基础状态
    userId: null,
    API_BASE: '',

    // 内容和导航状态
    currentPhotos: [],
    currentPhotoIndex: 0,
    isModalNavigating: false,

    // UI状态
    isBlurredMode: false,
    hasShownNavigationHint: false,
    lastWheelTime: 0,
    uiVisibilityTimer: null,
    activeBackdrop: 'one',
    isInitialLoad: true,

    // 功能开关状态
    aiEnabled: false,
    passwordEnabled: false,

    // 异步操作状态
    captionDebounceTimer: null,
    currentAbortController: null,
    searchDebounceTimer: null,

    // 媒体和URL状态
    currentObjectURL: null,
    scrollPositionBeforeModal: null,
    activeThumbnail: null,
    preSearchHash: '#/',

    // 滚动位置缓存
    scrollPositions: new Map(),

    // 缩略图请求管理
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

    // 同步任务状态（合并到主状态管理器）
    isSilent: false,
    isMonitoring: false,
    monitoringType: null,
    monitoringIntervalId: null,
    monitoringTimeoutId: null,
});

/**
 * ----------------------------------------------------------------
 * 简化的状态管理接口
 * ----------------------------------------------------------------
 * 直接使用 nanostores 的现代API，移除复杂的兼容层。
 */

// 同步状态管理器（兼容接口）
export const syncState = {
    get isSilent() { return appStateStore.get().isSilent; },
    get isMonitoring() { return appStateStore.get().isMonitoring; },
    get monitoringType() { return appStateStore.get().monitoringType; },
    get monitoringIntervalId() { return appStateStore.get().monitoringIntervalId; },
    get monitoringTimeoutId() { return appStateStore.get().monitoringTimeoutId; },

    setSilentMode(silent) {
        appStateStore.setKey('isSilent', Boolean(silent));
    },
    startMonitoring(type) {
        appStateStore.setKey('isMonitoring', true);
        appStateStore.setKey('monitoringType', type);
    },
    stopMonitoring() {
        const state = appStateStore.get();
        if (state.monitoringIntervalId) clearInterval(state.monitoringIntervalId);
        if (state.monitoringTimeoutId) clearTimeout(state.monitoringTimeoutId);
        appStateStore.set({
            ...state,
            isMonitoring: false,
            monitoringType: null,
            monitoringIntervalId: null,
            monitoringTimeoutId: null,
        });
    },
    setMonitoringTimers(intervalId, timeoutId) {
        appStateStore.setKey('monitoringIntervalId', intervalId);
        appStateStore.setKey('monitoringTimeoutId', timeoutId);
    },
    reset() {
        this.stopMonitoring();
        this.setSilentMode(false);
    }
};

// 主状态管理器（简化的接口）
export const stateManager = {
    get state() {
        return appStateStore.get();
    },

    subscribe(keys, callback) {
        const keyArray = Array.isArray(keys) ? keys : [keys];

        let lastKnownValues = {};
        keyArray.forEach(k => lastKnownValues[k] = this.state[k]);

        const unsubscribe = appStateStore.listen(currentState => {
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
            appStateStore.setKey(key, value);
        }
    },

    batchUpdate(updates) {
        appStateStore.set({ ...this.state, ...updates });
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

// 定义允许的状态属性集合（类型安全）
const ALLOWED_STATE_KEYS = new Set([
    // 应用基础状态
    'userId', 'API_BASE',

    // 内容和导航状态
    'currentPhotos', 'currentPhotoIndex', 'isModalNavigating',

    // UI状态
    'isBlurredMode', 'hasShownNavigationHint', 'lastWheelTime',
    'uiVisibilityTimer', 'activeBackdrop', 'isInitialLoad',

    // 功能开关状态
    'aiEnabled', 'passwordEnabled',

    // 异步操作状态
    'captionDebounceTimer', 'currentAbortController', 'searchDebounceTimer',

    // 媒体和URL状态
    'currentObjectURL', 'scrollPositionBeforeModal', 'activeThumbnail', 'preSearchHash',

    // 滚动位置缓存
    'scrollPositions',

    // 缩略图请求管理
    'thumbnailRequestQueue', 'activeThumbnailRequests', 'MAX_CONCURRENT_THUMBNAIL_REQUESTS',

    // 搜索和浏览状态
    'isSearchLoading', 'currentSearchPage', 'totalSearchPages', 'currentSearchQuery',
    'isBrowseLoading', 'currentBrowsePage', 'totalBrowsePages', 'currentBrowsePath',
    'currentSort', 'entrySort', 'currentColumnCount', 'currentLayoutWidth', 'pageCache',

    // 预览布局模式
    'layoutMode',

    // 虚拟滚动器状态
    'virtualScroller',

    // 同步任务状态
    'isSilent', 'isMonitoring', 'monitoringType', 'monitoringIntervalId', 'monitoringTimeoutId'
]);

// 导出代理对象（主要的状态访问接口）
export const state = new Proxy(stateManager, {
    get(target, prop) {
        // 方法访问
        if (typeof target[prop] === 'function') {
            return target[prop].bind(target);
        }

        // 状态属性访问 - 严格验证
        if (ALLOWED_STATE_KEYS.has(prop)) {
            return target.state[prop];
        }

        // 管理器自身属性访问
        if (prop in target) {
            return target[prop];
        }

        // 警告：访问未定义的状态属性
        stateLogger.warn(`访问未定义的状态属性: ${prop}`, {
            allowedKeys: Array.from(ALLOWED_STATE_KEYS),
            suggestion: '请检查属性名称是否正确，或在ALLOWED_STATE_KEYS中添加新属性'
        });

        return undefined;
    },

    set(target, prop, value) {
        // 状态属性设置 - 严格验证
        if (ALLOWED_STATE_KEYS.has(prop)) {
            target.update(prop, value);
            return true;
        }

        // 管理器自身属性设置
        target[prop] = value;
        return true;
    },

    has(target, prop) {
        return ALLOWED_STATE_KEYS.has(prop) || prop in target;
    },

    ownKeys(target) {
        // 返回所有允许的键
        return Array.from(ALLOWED_STATE_KEYS);
    },

    getOwnPropertyDescriptor(target, prop) {
        if (ALLOWED_STATE_KEYS.has(prop)) {
            return {
                configurable: true,
                enumerable: true,
                value: target.state[prop],
                writable: true
            };
        }
        return undefined;
    }
});


/**
 * 模态框背景元素
 */
export const backdrops = {
    one: safeGetElementById('modal-backdrop-one'),
    two: safeGetElementById('modal-backdrop-two')
};

// DOM元素现在在 dom-elements.js 中定义

export function validateSyncState() {
    stateLogger.debug('当前同步状态', {
        isSilent: syncState.isSilent,
        isMonitoring: syncState.isMonitoring,
        monitoringType: syncState.monitoringType,
        hasInterval: !!syncState.monitoringIntervalId,
        hasTimeout: !!syncState.monitoringTimeoutId
    });
}

export function cleanupSyncState() {
    syncState.reset();
}

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', cleanupSyncState);
}

// 导出主状态store，供需要直接使用nanostores API的代码
export { appStateStore as store };