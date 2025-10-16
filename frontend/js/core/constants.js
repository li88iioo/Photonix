/**
 * @file 应用常量配置
 * @description 统一管理魔法数字和硬编码值，便于维护和全局配置
 */

/**
 * 虚拟滚动相关常量
 * @namespace VIRTUAL_SCROLL
 */
export const VIRTUAL_SCROLL = {
    BUFFER_SIZE: 10,                    // 缓冲区大小
    MAX_POOL_SIZE: 60,                  // 复用池最大容量
    BATCH_SIZE: 30,                     // 单帧渲染的最大项目数
    ESTIMATED_ITEM_HEIGHT: 300,         // 预估项目高度
    PERFORMANCE_WINDOW: 30,             // 性能监测窗口
    FRAME_RATE_THRESHOLD_HIGH: 58,      // 高帧率阈值
    FRAME_RATE_THRESHOLD_LOW: 45,       // 低帧率阈值
    BUFFER_ADJUST_COOLDOWN: 1000,       // 缓冲区调整冷却时间（毫秒）
    BUFFER_STEP: 2,                     // 缓冲区调整步长
    MIN_BUFFER_SIZE: 6,                 // 最小缓冲区大小
    MAX_BUFFER_SIZE: 30,                // 最大缓冲区大小
    RESIZE_DEBOUNCE_DELAY: 16,          // 调整大小防抖延迟（毫秒）
    THRESHOLD: 200,                     // ✅ 虚拟滚动启用阈值（项目数量） - 提升至200优化内存
};

/**
 * 网络请求相关常量
 * @namespace NETWORK
 */
export const NETWORK = {
    RETRY_BASE_DELAY: 1000,             // 重试基础延迟（毫秒）
    TUNNEL_TIMEOUT: 10000,              // 内网穿透超时时间（毫秒）
    TUNNEL_RETRY_DELAY: 2000,           // 内网穿透重试延迟（毫秒）
    DEFAULT_TIMEOUT: 5000,              // 默认超时时间（毫秒）
    DEFAULT_RETRY_DELAY: 1000,          // 默认重试延迟（毫秒）
    MAX_RETRY_ATTEMPTS: 3,              // 最大重试次数
    AUTH_DEBOUNCE_DELAY: 2000,          // 认证错误防抖延迟（毫秒）
    TOKEN_CACHE_DURATION: 5000,         // 令牌缓存持续时间（毫秒）
    SETTINGS_REQUEST_TIMEOUT: 15000,    // 设置请求超时时间（毫秒）
    ROBUST_REQUEST_TIMEOUT: 3000,       // 健壮请求超时时间（毫秒）
};

/**
 * 缓存相关常量
 * @namespace CACHE
 */
export const CACHE = {
    DEDUP_WINDOW_MS: 150,               // 去重窗口时间（毫秒）
    CLEANUP_INTERVAL: 10000,            // 清理间隔时间（毫秒）
    VISIBILITY_TIMEOUT: 10000,          // 页面隐藏超时时间（毫秒）
    SCROLL_POSITION_STORAGE_LIMIT: 200, // 滚动位置存储限制
    SESSION_STORAGE_PREFIX: 'sg_',      // 会话存储前缀
};

/**
 * Service Worker 消息常量
 * @namespace SW_MESSAGE
 */
export const SW_MESSAGE = Object.freeze({
    CLEAR_API_CACHE: 'CLEAR_API_CACHE',
    MANUAL_REFRESH: 'MANUAL_REFRESH'
});

/**
 * UI 交互相关常量
 * @namespace UI
 */
export const UI = {
    NOTIFICATION_DURATION_DEFAULT: 3000, // 默认通知持续时间（毫秒）
    NOTIFICATION_DURATION_WARNING: 5000, // 警告通知持续时间（毫秒）
    NOTIFICATION_DURATION_SUCCESS: 3000, // 成功通知持续时间（毫秒）
    SCROLL_THRESHOLD: 8,                 // 滚动阈值
    SCROLL_THRESHOLD_DOWN: 100,          // 向下滚动触发阈值
    LAYOUT_UPDATE_DELAY: 50,             // 布局更新延迟（毫秒）
    INITIAL_LAYOUT_DELAY: 120,           // 初始布局延迟（毫秒）
    EXTENDED_LAYOUT_DELAY: 360,          // 扩展布局延迟（毫秒）
    DEBOUNCE_DELAY_MEDIUM: 500,          // 中等防抖延迟（毫秒）

    /**
     * 时间格式化常量
     * @type {Object}
     */
    TIME_FORMAT: {
        SECOND: 1000,                        // 1秒 = 1000毫秒
        MINUTE: 60 * 1000,                   // 1分钟
        HOUR: 60 * 60 * 1000,                // 1小时
        DAY: 24 * 60 * 60 * 1000,            // 1天
        MONTH: 30 * 24 * 60 * 60 * 1000,     // 1个月（近似值）
        YEAR: 12 * 30 * 24 * 60 * 60 * 1000  // 1年（近似值）
    },

    /**
     * 媒体宽高比常量
     * @type {Object}
     */
    ASPECT_RATIO: {
        VIDEO_DEFAULT: 16 / 9,               // 视频默认宽高比
        IMAGE_DEFAULT: 1,                    // 图片默认宽高比
    },

    /**
     * 布局相关常量
     * @type {Object}
     */
    LAYOUT: {
        UNKNOWN_ASPECT_RATIO_MIN_HEIGHT: '200px', // 未知宽高比时的最小高度
        DEFAULT_ITEM_HEIGHT: 300,                 // 默认项目高度
        COLUMN_GAP: 16,                           // 列间距
    },
};

/**
 * 业务逻辑相关常量
 * @namespace BUSINESS
 */
export const BUSINESS = {
    MAX_CONCURRENT_THUMBNAIL_REQUESTS: 12, // 最大并发缩略图请求数
    THUMBNAIL_LOAD_TIMEOUT: 200,           // 缩略图加载超时（毫秒）
    PROGRESS_UPDATE_DELAY: 2000,           // 进度更新延迟（毫秒）
    SEARCH_DEBOUNCE_DELAY: 300,            // 搜索防抖延迟（毫秒）
    BACK_TO_TOP_OFFSET: 112,               // 返回顶部偏移量（px）
};

/**
 * 路由相关常量
 * @namespace ROUTER
 */
export const ROUTER = {
    SCROLL_POSITION_LOAD_LIMIT: 200,    // 滚动位置加载限制
    ROUTE_RETRY_DELAY: 6000,            // 路由重试延迟（毫秒）
};

/**
 * 数学计算相关常量
 * @namespace MATH
 */
export const MATH = {
    ASPECT_RATIO_PRECISION: 3,          // 宽高比精度
    CACHE_HIT_RATIO_PRECISION: 1,       // 缓存命中率精度
    SCROLL_PROGRESS_MAX: 100,           // 滚动进度最大值
    SCROLL_PROGRESS_MIN: 0,             // 滚动进度最小值
};

/**
 * DOM 样式相关常量
 * @namespace STYLE
 */
export const STYLE = {
    MIN_HEIGHT_UNKNOWN_ASPECT_RATIO: '200px', // 未知宽高比的最小高度
    GRID_TEMPLATE_COLUMNS_AUTO: 'repeat(auto-fit, minmax(150px, 1fr))',
    SPINNER_SIZE_DEFAULT: '3rem',
    SPINNER_SIZE_SMALL: '1.5rem',
};

/**
 * 媒体处理相关常量
 * @namespace MEDIA
 */
export const MEDIA = {
    HLS_MANIFEST_PATTERN: /\.m3u8$/i,         // HLS 清单文件正则
    HLS_SEGMENT_PATTERN: /\.ts$/i,            // HLS 分片文件正则
    VIDEO_CONTENT_TYPE_PATTERN: /^video\//i,  // 视频内容类型正则
    MAX_NON_VIDEO_FILE_SIZE: 10 * 1024 * 1024 // 非视频文件最大大小（10MB）
};

/**
 * 滚动和布局相关常量（支持全局覆盖）
 * @namespace SCROLL_LAYOUT
 */
export const SCROLL_LAYOUT = {
    /**
     * 虚拟滚动配置
     */
    VIRTUAL_SCROLL: {
        DEFAULT_BUFFER_SIZE: 10,           // 默认缓冲区大小
        DEFAULT_MAX_POOL_SIZE: 60,         // 默认复用池最大容量
        DEFAULT_ESTIMATED_HEIGHT: 300,     // 默认预估项目高度
        PERFORMANCE_WINDOW: 30,            // 性能监测窗口
        FRAME_RATE_THRESHOLD_HIGH: 58,     // 高帧率阈值
        FRAME_RATE_THRESHOLD_LOW: 45,      // 低帧率阈值
        BUFFER_ADJUST_COOLDOWN: 1000,      // 缓冲区调整冷却时间（毫秒）
        BUFFER_STEP: 2,                    // 缓冲区调整步长
        MIN_BUFFER_SIZE: 6,                // 最小缓冲区大小
        MAX_BUFFER_SIZE: 30,               // 最大缓冲区大小
        RESIZE_DEBOUNCE_DELAY: 16,         // 调整大小防抖延迟（毫秒）
        CACHE_THRESHOLD_RATIO: 0.5,        // 缓存命中率阈值（用于决定是否使用二分查找）
        VISUAL_OPTIONS: {
            showLoadingAnimation: true,
            smoothScrolling: true,
            enableAnimations: true
        },
        // 向后兼容的别名
        BUFFER_SIZE: 10,
        MAX_POOL_SIZE: 60,
        BATCH_SIZE: 30,
        ESTIMATED_ITEM_HEIGHT: 300
    },

    /**
     * 瀑布流布局配置
     */
    MASONRY: {
        /**
         * 响应式断点配置
         */
        BREAKPOINTS: {
            '4k': 3840,     // 4K及以上：12列
            '2_5k': 2560,   // 2.5K/2K宽：10列
            '1080p': 1920,  // 1080p及以上：8列
            '2xl': 1536,    // 2xl：6列
            'xl': 1280,     // xl：5列
            'lg': 1024,     // lg：4列
            'md': 768,      // md：3列
            'sm': 640       // sm：2列
        },
        /**
         * 列数配置
         */
        COLUMNS: {
            '4k': 12,
            '2_5k': 10,
            '1080p': 8,
            '2xl': 6,
            'xl': 5,
            'lg': 4,
            'md': 3,
            'sm': 2,
            'default': 2    // 默认列数
        },
        COLUMN_GAP: 16,               // 列间距（px）
        DEFAULT_ITEM_HEIGHT: 300,     // 默认项目高度（px）
        LAZY_LOAD_DELAY: 200,         // 懒加载触发延迟（ms）
        LAYOUT_DELAY: 300,            // 布局操作延迟（ms）
        BASE_BUFFER_SIZE: 200,        // 基础缓冲区大小（px）
        TRANSITION_DURATION: 300,     // 过渡动画持续时间（ms）
        BATCH_SIZE: 20,               // 批处理大小
        LAYOUT_DEBOUNCE_MS: 16,       // 布局防抖延迟
        COLUMN_HEIGHT_UPDATE_MS: 100, // 列高更新间隔
        MAX_LAYOUT_RETRIES: 3,        // 最大布局重试次数
        LAYOUT_RETRY_DELAY: 50,       // 布局重试延迟
        STAGGER_DELAY: 10,            // 错开延迟
        OBSERVER_THRESHOLD: 0.1,      // 观察器阈值
        OBSERVER_ROOT_MARGIN: '50px'  // 观察器根边距
    },

    /**
     * 通用滚动布局配置
     */
    COMMON: {
        PRELOAD_SCREENS: 1,           // 预加载屏数
        SMOOTH_SCROLL_DURATION: 300,  // 平滑滚动持续时间
        RESIZE_THROTTLE_MS: 100,      // 调整大小节流
        SCROLL_THROTTLE_MS: 16        // 滚动节流
    }
};

/**
 * 获取可调参数，支持全局配置覆盖
 * @param {string} category 配置类别
 * @param {string} key 参数键
 * @param {*} fallback 默认值
 * @returns {*} 参数值
 */
export function getTunableConfig(category, key, fallback) {
    try {
        const globalConfig = window.__APP_SETTINGS?.[category];
        if (globalConfig && Object.prototype.hasOwnProperty.call(globalConfig, key)) {
            return globalConfig[key];
        }
    } catch {}
    return fallback;
}

/**
 * 获取虚拟滚动配置
 * @param {string} key 配置键
 * @returns {*} 配置值
 */
export function getVirtualScrollConfig(key) {
    return getTunableConfig('virtualScroll', key, SCROLL_LAYOUT.VIRTUAL_SCROLL[key]);
}

/**
 * 获取瀑布流配置
 * @param {string} key 配置键
 * @returns {*} 配置值
 */
export function getMasonryConfig(key) {
    return getTunableConfig('masonry', key, SCROLL_LAYOUT.MASONRY[key]);
}

/**
 * 获取瀑布流响应式断点配置
 * @returns {object} 断点配置对象
 */
export function getMasonryBreakpoints() {
    return getTunableConfig('masonry', 'BREAKPOINTS', SCROLL_LAYOUT.MASONRY.BREAKPOINTS);
}

/**
 * 获取瀑布流列数配置
 * @returns {object} 列数配置对象
 */
export function getMasonryColumnsConfig() {
    return getTunableConfig('masonry', 'COLUMNS', SCROLL_LAYOUT.MASONRY.COLUMNS);
}

/**
 * 获取通用滚动布局配置
 * @param {string} key 配置键
 * @returns {*} 配置值
 */
export function getCommonScrollConfig(key) {
    return getTunableConfig('scrollLayout', key, SCROLL_LAYOUT.COMMON[key]);
}

/**
 * 环境检测相关常量
 * @namespace ENVIRONMENT
 */
export const ENVIRONMENT = {
    DEVELOPMENT_HOSTS: ['localhost', '127.0.0.1'], // 开发环境主机列表
    PRODUCTION_HOST_PATTERN: /\.(local)$/          // 生产环境主机正则
};

/**
 * 判断是否为开发环境
 * @returns {boolean} 是否为开发环境
 */
export function isDevelopment() {
    if (typeof window === 'undefined') return false;

    const hostname = window.location.hostname;
    const isDevHost = ENVIRONMENT.DEVELOPMENT_HOSTS.includes(hostname);
    const isLocalHost = hostname.includes('.local');

    return isDevHost || isLocalHost;
}

/**
 * 判断是否为生产环境
 * @returns {boolean} 是否为生产环境
 */
export function isProduction() {
    if (typeof window === 'undefined') return true;
    return !isDevelopment();
}

/**
 * SSE 相关常量
 * @namespace SSE
 */
export const SSE = {
    MAX_RETRY_DELAY: 60000 // 最大重连延迟（60秒）
};

/**
 * 设置面板相关常量
 * @namespace SETTINGS
 */
export const SETTINGS = {
    BUTTON_STATE_UPDATE_THROTTLE: 100, // 按钮状态更新去重时间（ms）
    AI_LOCAL_KEY: 'ai_settings',       // AI 设置的本地存储键名
    DEFAULT_AI_PROMPT: `请你扮演这张照片中的人物，以第一人称的视角，对正在看照片的我说话。
你的任务是：
1.  仔细观察你的着装、姿态、表情和周围的环境。
2.  基于这些观察，构思一个符合你当前人设和心境的对话。
3.  你的话语可以是对我的邀请、提问，也可以是分享你此刻的感受或一个只属于我们之间的小秘密。
4.  语言风格要自然、有代入感，就像我们正在面对面交流。
5.  请直接开始对话，不要有任何前缀，比如"你好"或"嗨"。
6.  总字数控制在80字以内。
7.  中文回复。`,
};

/**
 * 安全相关常量
 * @namespace SECURITY
 */
export const SECURITY = {
    HTML_WHITELIST: {
        /**
         * 严格模式：只允许文本
         */
        STRICT: new Set([]),

        /**
         * 基本模式：允许常用内联标签
         */
        BASIC: new Set([
            'b', 'strong', 'i', 'em', 'u', 'small', 'sub', 'sup',
            'br', 'span', 'mark', 'code', 'kbd', 'samp', 'var',
            'time', 'abbr', 'cite', 'dfn', 'q'
        ]),

        /**
         * 丰富模式：允许更多标签
         */
        RICH: new Set([
            'p', 'div', 'section', 'article', 'header', 'footer',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'ul', 'ol', 'li', 'dl', 'dt', 'dd',
            'table', 'thead', 'tbody', 'tr', 'th', 'td',
            'blockquote', 'pre', 'hr',
            'img', 'figure', 'figcaption',
            'a', 'button', 'input', 'label', 'form'
        ]),

        /**
         * 自定义模式的基础标签（可扩展）
         */
        CUSTOM: new Set([
            'span', 'div', 'p', 'br'
        ])
    },

    ATTRIBUTE_WHITELIST: new Set([
        'class', 'id', 'title', 'alt', 'href', 'src',
        'width', 'height', 'style', 'data-*',
        'aria-*', 'role', 'tabindex'
    ]),

    DANGEROUS_PATTERNS: [
        /<script[^>]*>[\s\S]*?<\/script>/gi,
        /javascript:/gi,
        /vbscript:/gi,
        /data:text\/html/gi,
        /on\w+\s*=/gi,
        /<iframe[^>]*>/gi,
        /<object[^>]*>/gi,
        /<embed[^>]*>/gi,
        /<form[^>]*>/gi,
        /<input[^>]*>/gi,
        /<meta[^>]*>/gi
    ]
};

/**
 * 搜索历史相关常量
 * @namespace SEARCH_HISTORY
 */
export const SEARCH_HISTORY = {
    KEY: 'gallery_search_history', // 搜索历史的本地存储键名
    MAX_ITEMS: 10                  // 最大历史记录数
};

/**
 * IndexedDB 相关常量
 * @namespace INDEXEDDB
 */
export const INDEXEDDB = {
    HISTORY_DB_NAME: 'gallery-history-db',      // 历史数据库名称
    HISTORY_STORE_NAME: 'viewed',               // 历史对象存储名称
    HISTORY_INDEX_NAME: 'by_timestamp',         // 时间戳索引名称
    DEFAULT_MAX_RECORDS: 10000,                 // 默认最大记录数
    DEFAULT_MAX_AGE_MS: 180 * 24 * 60 * 60 * 1000, // 默认最大年龄（180天）
    BATCH_DELETE_SIZE: 200,                     // 批删除大小
    IDLE_CALLBACK_TIMEOUT: 2000,                // requestIdleCallback 超时（毫秒）
    RETENTION_RUNNER_DELAY: 150                 // 保留清理运行延迟（毫秒）
};

/**
 * 事件缓冲相关常量
 * @namespace EVENT_BUFFER
 */
export const EVENT_BUFFER = {
    CONFIG: {
        defaultBatchWindow: 20, // 默认批处理窗口（毫秒）
        maxBatchSize: 100,      // 最大批处理大小
        cleanupInterval: 60000  // 清理间隔（毫秒）
    },

    /**
     * 事件验证规则映射
     */
    VALIDATORS: {
        'thumbnail-generated': (payload) => {
            if (!payload || typeof payload !== 'object') {
                return { ok: false, reason: 'payload_not_object' };
            }
            if (!payload.path || typeof payload.path !== 'string') {
                return { ok: false, reason: 'path_missing' };
            }
            if (!payload.thumbnailUrl || typeof payload.thumbnailUrl !== 'string') {
                return { ok: false, reason: 'thumb_missing' };
            }
            if (payload.width != null && Number.isNaN(Number(payload.width))) {
                return { ok: false, reason: 'width_nan' };
            }
            if (payload.height != null && Number.isNaN(Number(payload.height))) {
                return { ok: false, reason: 'height_nan' };
            }
            return { ok: true };
        },

        'index-updated': (payload) => {
            if (!payload || typeof payload !== 'object') {
                return { ok: false, reason: 'payload_not_object' };
            }
            if (typeof payload.progress !== 'number' || payload.progress < 0 || payload.progress > 100) {
                return { ok: false, reason: 'invalid_progress' };
            }
            return { ok: true };
        },

        'media-processed': (payload) => {
            if (!payload || typeof payload !== 'object') {
                return { ok: false, reason: 'payload_not_object' };
            }
            if (!payload.path || typeof payload.path !== 'string') {
                return { ok: false, reason: 'path_missing' };
            }
            if (!['success', 'error', 'processing'].includes(payload.status)) {
                return { ok: false, reason: 'invalid_status' };
            }
            return { ok: true };
        }
    }
};

/**
 * 认证相关常量
 * @namespace AUTH
 */
export const AUTH = {
    TOKEN_KEY: 'authToken' // 认证令牌的本地存储键名
};

/**
 * AI 缓存相关常量
 * @namespace AI_CACHE
 */
export const AI_CACHE = {
    DB_NAME: 'ai-cache-db',              // AI 缓存数据库名称
    CAPTIONS_STORE_NAME: 'ai-captions',  // 字幕存储名称
    CONFIGS_STORE_NAME: 'ai-configs',    // 配置存储名称
    VERSION: 1,                          // 数据库版本
    CONFIG: {
        MAX_ENTRIES: 1000,               // 最大缓存条目数
        MAX_AGE_DAYS: 365,               // 缓存有效期（天）
        CLEANUP_INTERVAL: 30 * 60 * 1000,// 清理间隔（30分钟）
        COMPRESSION_THRESHOLD: 1024      // 压缩阈值（1KB）
    }
};

/**
 * UI 组件相关常量
 * @namespace UI_COMPONENTS
 */
export const UI_COMPONENTS = {
    STATUS_CARD: {
        classes: {
            card: 'status-card-new',
            loading: 'status-pod-loading',
            header: 'card-header-new',
            title: 'card-title-new',
            badge: 'status-badge-new',
            progress: 'linear-progress',
            progressBar: 'linear-progress-bar',
            details: 'details-grid-new',
            detailItem: 'detail-item-new',
            detailLabel: 'detail-label-new',
            detailValue: 'detail-value-new',
            footer: 'card-footer-new',
            timestamp: 'timestamp-new',
            actions: 'actions-new',
            spinner: 'spinner'
        }
    }
};