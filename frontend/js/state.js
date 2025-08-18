// frontend/js/state.js

/**
 * 改进的状态管理系统
 * 支持精细化的发布/订阅机制，减少不必要的重渲染
 */

class StateManager {
    constructor() {
        this.state = {
            // 应用状态和API配置
            userId: null,                                    // 用户ID
            API_BASE: '',                                   // API基础URL
            currentPhotos: [],                              // 当前照片数组
            currentPhotoIndex: 0,                           // 当前照片索引
            isModalNavigating: false,                       // 模态框导航状态
            isBlurredMode: false,                           // 模糊模式状态
            captionDebounceTimer: null,                     // 标题防抖定时器
            currentAbortController: null,                   // 当前中止控制器
            currentObjectURL: null,                         // 当前对象URL
            scrollPositions: new Map(),                     // 滚动位置缓存
            scrollPositionBeforeModal: null,                // 模态框打开前的滚动位置
            activeThumbnail: null,                          // 活动缩略图
            preSearchHash: '#/',                            // 搜索前的哈希值
            searchDebounceTimer: null,                      // 搜索防抖定时器
            hasShownNavigationHint: false,                  // 是否已显示导航提示
            lastWheelTime: 0,                               // 最后滚轮事件时间
            uiVisibilityTimer: null,                        // UI可见性定时器
            activeBackdrop: 'one',                          // 活动背景
            isInitialLoad: true,                            // 是否初始加载
            aiEnabled: false,                               // 全局AI开关状态
            passwordEnabled: false,                         // 全局密码开关状态

            // 缩略图请求队列
            thumbnailRequestQueue: [],                      // 缩略图请求队列
            activeThumbnailRequests: 0,                     // 活跃的缩略图请求数量
            // 智能并发：移动端/低端机 6-8，桌面 10-12
            MAX_CONCURRENT_THUMBNAIL_REQUESTS: Math.min(12, (navigator.hardwareConcurrency || 4) < 6 ? 8 : 12),

            // 搜索和浏览状态
            isSearchLoading: false,                         // 搜索加载状态
            currentSearchPage: 1,                           // 当前搜索页码
            totalSearchPages: 1,                            // 搜索总页数
            currentSearchQuery: '',                         // 当前搜索查询
            isBrowseLoading: false,                         // 浏览加载状态
            currentBrowsePage: 1,                           // 当前浏览页码
            totalBrowsePages: 1,                            // 浏览总页数
            currentBrowsePath: null,                        // 当前浏览路径
            currentSort: 'smart',                           // 当前排序方式
            entrySort: 'smart',                             // 进入页面时的排序方式
            currentColumnCount: 0,                          // 当前列数
            currentLayoutWidth: 0,                          // 当前内容容器宽度（用于监听尺寸变化触发布局重排）
            pageCache: new Map(),                           // 页面缓存
        };
        
        // 按状态键分组的订阅者
        this.subscribers = new Map();
        
        // 批量更新队列
        this.batchUpdates = new Set();
        this.batchTimeout = null;
    }
    
    /**
     * 订阅特定状态的变化
     * @param {string|Array} keys - 要订阅的状态键
     * @param {Function} callback - 回调函数
     * @returns {Function} 取消订阅的函数
     */
    subscribe(keys, callback) {
        const keyArray = Array.isArray(keys) ? keys : [keys];
        
        keyArray.forEach(key => {
            if (!this.subscribers.has(key)) {
                this.subscribers.set(key, new Set());
            }
            this.subscribers.get(key).add(callback);
        });
        
        // 返回取消订阅的函数
        return () => {
            keyArray.forEach(key => {
                const subscribers = this.subscribers.get(key);
                if (subscribers) {
                    subscribers.delete(callback);
                    if (subscribers.size === 0) {
                        this.subscribers.delete(key);
                    }
                }
            });
        };
    }
    
    /**
     * 更新状态
     * @param {string} key - 状态键
     * @param {any} value - 新值
     */
    update(key, value) {
        const oldValue = this.state[key];
        this.state[key] = value;
        
        // 如果值没有变化，不触发回调
        if (oldValue === value) return;
        
        // 添加到批量更新队列
        this.batchUpdates.add(key);
        
        // 延迟执行批量更新
        if (!this.batchTimeout) {
            this.batchTimeout = setTimeout(() => {
                this.executeBatchUpdates();
            }, 0);
        }
    }
    
    /**
     * 批量更新状态
     * @param {Object} updates - 要更新的状态对象
     */
    batchUpdate(updates) {
        Object.entries(updates).forEach(([key, value]) => {
            this.update(key, value);
        });
    }
    
    /**
     * 执行批量更新
     */
    executeBatchUpdates() {
        this.batchTimeout = null;
        
        // 按订阅者分组执行回调
        const callbackGroups = new Map();
        
        for (const key of this.batchUpdates) {
            const subscribers = this.subscribers.get(key);
            if (subscribers) {
                subscribers.forEach(callback => {
                    if (!callbackGroups.has(callback)) {
                        callbackGroups.set(callback, new Set());
                    }
                    callbackGroups.get(callback).add(key);
                });
            }
        }
        
        // 执行回调
        callbackGroups.forEach((keys, callback) => {
            try {
                callback(Array.from(keys), this.state);
            } catch (error) {
                console.error('状态更新回调执行失败:', error);
            }
        });
        
        this.batchUpdates.clear();
    }
    
    /**
     * 获取状态值
     * @param {string} key - 状态键
     * @returns {any} 状态值
     */
    get(key) {
        return this.state[key];
    }
    
    /**
     * 获取多个状态值
     * @param {Array} keys - 状态键数组
     * @returns {Object} 状态值对象
     */
    getMultiple(keys) {
        const result = {};
        keys.forEach(key => {
            result[key] = this.state[key];
        });
        return result;
    }
    
    /**
     * 获取所有状态
     * @returns {Object} 完整状态对象
     */
    getAll() {
        return { ...this.state };
    }
}

// 创建全局状态管理器实例
const stateManagerInstance = new StateManager();

// 导出状态管理器（使用Proxy实现动态状态访问）
export const state = new Proxy(stateManagerInstance, {
    get(target, prop) {
        // 如果是状态管理器的方法，直接返回
        if (typeof target[prop] === 'function') {
            return target[prop].bind(target);
        }
        // 如果是状态属性，从state对象中获取
        if (prop in target.state) {
            return target.state[prop];
        }
        // 其他属性直接从target获取
        return target[prop];
    },
    set(target, prop, value) {
        // 如果是状态属性，使用update方法更新
        if (prop in target.state) {
            target.update(prop, value);
            return true;
        }
        // 其他属性直接设置
        target[prop] = value;
        return true;
    }
});
export const stateManager = stateManagerInstance;

/**
 * 模态框背景元素
 * 用于模态框的背景切换效果
 */
export const backdrops = {
    one: document.getElementById('modal-backdrop-one'),    // 背景一
    two: document.getElementById('modal-backdrop-two')     // 背景二
};

/**
 * DOM元素选择器
 * 集中管理所有需要操作的DOM元素引用
 */
export const elements = {
    // 主要视图元素
    galleryView: document.getElementById('gallery-view'),           // 画廊视图
    contentGrid: document.getElementById('content-grid'),           // 内容网格
    loadingIndicator: document.getElementById('loading'),           // 加载指示器
    breadcrumbNav: document.getElementById('breadcrumb-nav'),       // 面包屑导航
    
    // 模态框相关元素
    modal: document.getElementById('modal'),                        // 模态框容器
    modalContent: document.getElementById('modal-content'),         // 模态框内容
    modalImg: document.getElementById('modal-img'),                 // 模态框图片
    modalVideo: document.getElementById('modal-video'),             // 模态框视频
    modalClose: document.getElementById('modal-close'),             // 模态框关闭按钮
    
    // AI控制容器
    aiControlsContainer: document.getElementById('ai-controls-container'),  // AI控制容器
    
    // 标题相关元素
    captionContainer: document.getElementById('caption-container'),         // 标题容器
    captionContainerMobile: document.getElementById('caption-container-mobile'), // 移动端标题容器
    captionBubble: document.getElementById('caption-bubble'),               // 标题气泡
    captionBubbleWrapper: document.getElementById('caption-bubble-wrapper'), // 标题气泡包装器
    toggleCaptionBtn: document.getElementById('toggle-caption-btn'),        // 切换标题按钮
    
    // 其他UI元素
    navigationHint: document.getElementById('navigation-hint'),             // 导航提示
    mediaPanel: document.getElementById('media-panel'),                     // 媒体面板
    searchInput: document.getElementById('search-input'),                   // 搜索输入框
    infiniteScrollLoader: document.getElementById('infinite-scroll-loader'), // 无限滚动加载器
};