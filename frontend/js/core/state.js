/**
 * @file 统一应用状态管理
 */

import { map } from 'nanostores';
import { createModuleLogger } from './logger.js';
import { safeGetElementById } from '../shared/dom-utils.js';

const stateLogger = createModuleLogger('State');

/**
 * 相册墓碑（已删除/隐藏相册的标记）在 localStorage 中的存储键名
 * @type {string}
 * @constant
 */
const ALBUM_TOMBSTONE_STORAGE_KEY = 'sg_album_tombstones';

/**
 * 相册墓碑的有效期（毫秒），10分钟
 * @type {number}
 * @constant
 */
const ALBUM_TOMBSTONE_TTL_MS = 10 * 60 * 1000;

/**
 * 从 localStorage 加载相册墓碑信息，只返回未过期的墓碑项
 * @returns {Map<string, number>} 相册路径到过期时间的映射
 */
function loadAlbumTombstonesFromStorage() {
    if (typeof localStorage === 'undefined') return new Map();
    try {
        const raw = localStorage.getItem(ALBUM_TOMBSTONE_STORAGE_KEY);
        if (!raw) return new Map();
        const parsed = JSON.parse(raw);
        const now = Date.now();
        // 只保留未过期的墓碑项
        const entries = Object.entries(parsed).filter(([, expiresAt]) => typeof expiresAt === 'number' && expiresAt > now);
        return new Map(entries);
    } catch (error) {
        stateLogger?.warn?.('恢复相册墓碑失败', error);
        return new Map();
    }
}

/**
 * 将相册墓碑信息持久化到 localStorage
 * @param {Map<string, number>} tombstones 相册路径到过期时间的映射
 */
function persistAlbumTombstones(tombstones) {
    if (typeof localStorage === 'undefined') return;
    try {
        const serialized = JSON.stringify(Object.fromEntries(tombstones));
        localStorage.setItem(ALBUM_TOMBSTONE_STORAGE_KEY, serialized);
    } catch (error) {
        stateLogger.warn('持久化相册墓碑失败', error);
    }
}

/**
 * 使用 nanostores map store 管理所有应用状态，统一状态管理，避免分散和不一致
 */
const appStateStore = map({
    // 应用基础状态
    userId: null,
    API_BASE: '',

    // 内容和导航状态
    currentPhotos: [],
    currentPhotoIndex: 0,
    isModalNavigating: false,

    // UI 状态
    isBlurredMode: false,
    hasShownNavigationHint: false,
    lastWheelTime: 0,
    uiVisibilityTimer: null,
    activeBackdrop: 'one',
    isInitialLoad: true,

    // 功能开关状态
    aiEnabled: false,
    passwordEnabled: false,
    albumDeletionEnabled: false,
    adminSecretConfigured: false,
    manualSyncSchedule: 'off',

    // 相册墓碑管理
    albumTombstones: loadAlbumTombstonesFromStorage(),

    // 异步操作状态
    captionDebounceTimer: null,
    currentAbortController: null,
    searchDebounceTimer: null,

    // 媒体和 URL 状态
    currentObjectURL: null,
    scrollPositionBeforeModal: null,
    activeThumbnail: null,
    preSearchHash: '#/',
    fromSearchHash: null,

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

    // 排序缓存

    // 预览布局模式
    layoutMode: (typeof localStorage !== 'undefined' && localStorage.getItem('sg_layout_mode')) || 'grid',

    // 同步任务状态
    isSilent: false,
    isMonitoring: false,
    monitoringType: null,
    monitoringIntervalId: null,
    monitoringTimeoutId: null,
});

/**
 * 简化的状态管理接口，直接使用 nanostores API
 */

/**
 * 同步状态管理器
 * @namespace syncState
 */
export const syncState = {
    /** 是否静默模式 */
    get isSilent() { return appStateStore.get().isSilent; },
    /** 是否正在监控 */
    get isMonitoring() { return appStateStore.get().isMonitoring; },
    /** 监控类型 */
    get monitoringType() { return appStateStore.get().monitoringType; },
    /** 监控定时器ID */
    get monitoringIntervalId() { return appStateStore.get().monitoringIntervalId; },
    /** 监控超时ID */
    get monitoringTimeoutId() { return appStateStore.get().monitoringTimeoutId; },

    /**
     * 设置静默模式
     * @param {boolean} silent 是否启用静默模式
     */
    setSilentMode(silent) {
        appStateStore.setKey('isSilent', Boolean(silent));
    },

    /**
     * 开始监控
     * @param {string} type 监控类型
     */
    startMonitoring(type) {
        appStateStore.setKey('isMonitoring', true);
        appStateStore.setKey('monitoringType', type);
    },

    /**
     * 停止监控，清理定时器
     */
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

    /**
     * 设置监控定时器
     * @param {number} intervalId 间隔定时器ID
     * @param {number} timeoutId 超时定时器ID
     */
    setMonitoringTimers(intervalId, timeoutId) {
        appStateStore.setKey('monitoringIntervalId', intervalId);
        appStateStore.setKey('monitoringTimeoutId', timeoutId);
    },

    /**
     * 重置同步状态
     */
    reset() {
        this.stopMonitoring();
        this.setSilentMode(false);
    }
};

/**
 * 主状态管理器
 * @namespace stateManager
 */
export const stateManager = {
    /**
     * 获取当前状态对象
     * @returns {object}
     */
    get state() {
        return appStateStore.get();
    },

    /**
     * 订阅指定键的状态变化
     * @param {Array<string>|string} keys 订阅的键或键数组
     * @param {Function} callback 回调函数 (changedKeys, currentState)
     * @returns {Function} 取消订阅函数
     */
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

    /**
     * 更新单个状态键
     * @param {string} key 状态键
     * @param {*} value 状态值
     */
    update(key, value) {
        if (this.state[key] !== value) {
            appStateStore.setKey(key, value);
        }
    },

    /**
     * 批量更新状态
     * @param {object} updates 更新对象
     */
    batchUpdate(updates) {
        appStateStore.set({ ...this.state, ...updates });
    },

    /**
     * 获取单个状态值
     * @param {string} key 状态键
     * @returns {*}
     */
    get(key) {
        return this.state[key];
    },

    /**
     * 获取多个状态值
     * @param {Array<string>} keys 状态键数组
     * @returns {object} 键值对对象
     */
    getMultiple(keys) {
        const result = {};
        const currentState = this.state;
        keys.forEach(key => {
            result[key] = currentState[key];
        });
        return result;
    },

    /**
     * 获取所有状态（浅拷贝）
     * @returns {object}
     */
    getAll() {
        return { ...this.state };
    }
};

/**
 * 允许的状态属性集合（类型安全，严格访问）
 * @type {Set<string>}
 * @constant
 */
const ALLOWED_STATE_KEYS = new Set([
    // 应用基础状态
    'userId', 'API_BASE',

    // 内容和导航状态
    'currentPhotos', 'currentPhotoIndex', 'isModalNavigating',

    // UI 状态
    'isBlurredMode', 'hasShownNavigationHint', 'lastWheelTime',
    'uiVisibilityTimer', 'activeBackdrop', 'isInitialLoad',

    // 功能开关状态
    'aiEnabled', 'passwordEnabled', 'albumDeletionEnabled', 'manualSyncSchedule',
    'adminSecretConfigured',

    // 异步操作状态
    'captionDebounceTimer', 'currentAbortController', 'searchDebounceTimer',

    // 媒体和 URL 状态
    'currentObjectURL', 'scrollPositionBeforeModal', 'activeThumbnail', 'preSearchHash', 'fromSearchHash',

    // 滚动位置缓存
    'scrollPositions',

    // 缩略图请求管理
    'thumbnailRequestQueue', 'activeThumbnailRequests', 'MAX_CONCURRENT_THUMBNAIL_REQUESTS',

    // 搜索和浏览状态
    'isSearchLoading', 'currentSearchPage', 'totalSearchPages', 'currentSearchQuery',
    'isBrowseLoading', 'currentBrowsePage', 'totalBrowsePages', 'currentBrowsePath',
    'currentSort', 'entrySort', 'currentColumnCount', 'currentLayoutWidth', 'pageCache',
    'albumTombstones',

    // 预览布局模式
    'layoutMode',

    // 虚拟滚动器状态
    'virtualScroller',

    // 同步任务状态
    'isSilent', 'isMonitoring', 'monitoringType', 'monitoringIntervalId', 'monitoringTimeoutId'
]);

/**
 * 状态代理对象（主状态访问接口），严格属性访问和方法转发
 * @type {Proxy}
 */
export const state = new Proxy(stateManager, {
    get(target, prop) {
        // 方法访问
        if (typeof target[prop] === 'function') {
            return target[prop].bind(target);
        }

        // 严格的状态属性访问
        if (ALLOWED_STATE_KEYS.has(prop)) {
            return target.state[prop];
        }

        // 管理器自身属性访问
        if (prop in target) {
            return target[prop];
        }

        // 访问未定义的状态属性时警告
        stateLogger.warn(`访问未定义的状态属性: ${prop}`, {
            allowedKeys: Array.from(ALLOWED_STATE_KEYS),
            suggestion: '请检查属性名称是否正确，或在ALLOWED_STATE_KEYS中添加新属性'
        });

        return undefined;
    },

    set(target, prop, value) {
        // 严格的状态属性设置
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
 * @namespace backdrops
 */
export const backdrops = {
    one: safeGetElementById('modal-backdrop-one'),
    two: safeGetElementById('modal-backdrop-two')
};

// DOM 元素现在在 dom-elements.js 中定义

/**
 * 验证同步状态并输出日志
 */
export function validateSyncState() {
    stateLogger.debug('当前同步状态', {
        isSilent: syncState.isSilent,
        isMonitoring: syncState.isMonitoring,
        monitoringType: syncState.monitoringType,
        hasInterval: !!syncState.monitoringIntervalId,
        hasTimeout: !!syncState.monitoringTimeoutId
    });
}

/**
 * 清理同步状态（页面卸载时重置）
 */
export function cleanupSyncState() {
    syncState.reset();
}

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', cleanupSyncState);
}

/**
 * 导出主状态 store，供需要直接使用 nanostores API 的代码使用
 */
export { appStateStore as store };

/**
 * 更新相册墓碑状态并持久化到 localStorage
 * @param {Map<string, number>} nextMap 下一个墓碑映射
 */
function updateAlbumTombstoneState(nextMap) {
    const cloned = new Map(nextMap);
    stateManager.update('albumTombstones', cloned);
    persistAlbumTombstones(cloned);
}

/**
 * 清理已过期的相册墓碑项，会自动更新状态和持久化
 */
export function clearExpiredAlbumTombstones() {
    const current = stateManager.get('albumTombstones');
    if (!(current instanceof Map) || current.size === 0) return;
    const now = Date.now();
    let mutated = false;
    const next = new Map();
    current.forEach((expiresAt, path) => {
        if (typeof expiresAt === 'number' && expiresAt > now) {
            next.set(path, expiresAt);
        } else {
            mutated = true;
        }
    });
    if (mutated) {
        updateAlbumTombstoneState(next);
    }
}

/**
 * 添加一个相册墓碑（标记为已删除/隐藏）
 * @param {string} path 相册路径
 * @param {number} [ttlMs=ALBUM_TOMBSTONE_TTL_MS] 墓碑有效期（毫秒）
 */
export function addAlbumTombstone(path, ttlMs = ALBUM_TOMBSTONE_TTL_MS) {
    if (!path) return;
    const current = stateManager.get('albumTombstones') || new Map();
    const next = new Map(current);
    next.set(path, Date.now() + Math.max(ttlMs, 1000));
    updateAlbumTombstoneState(next);
}

/**
 * 移除指定相册的墓碑标记
 * @param {string} path 相册路径
 */
export function removeAlbumTombstone(path) {
    if (!path) return;
    const current = stateManager.get('albumTombstones');
    if (!(current instanceof Map) || !current.has(path)) return;
    const next = new Map(current);
    next.delete(path);
    updateAlbumTombstoneState(next);
}

/**
 * 判断某个相册是否已被墓碑标记
 * @param {string} path 相册路径
 * @returns {boolean} 是否已被墓碑标记
 */
export function isAlbumTombstoned(path) {
    if (!path) return false;
    const current = stateManager.get('albumTombstones');
    return current instanceof Map && current.has(path);
}

/**
 * 获取当前所有有效的相册墓碑映射
 * @returns {Map<string, number>} 相册路径到过期时间的映射
 */
export function getAlbumTombstonesMap() {
    const current = stateManager.get('albumTombstones');
    return current instanceof Map ? current : new Map();
}

// 初始化时清理一次过期墓碑
clearExpiredAlbumTombstones();