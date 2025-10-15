/**
 * @file frontend/js/shared/utils.js
 * @description 聚合前端通用工具函数，包括通知、网络与调试辅助
 */

import { NETWORK, UI, isDevelopment } from '../core/constants.js';
import { createModuleLogger } from '../core/logger.js';
import { safeSetInnerHTML, safeGetElementById, safeClassList } from './dom-utils.js';

const utilsLogger = createModuleLogger('Utils');

const FIELD_LABEL_MAP = {
    adminSecret: '管理员密钥',
    newPassword: '新密码',
    enabled: '启用状态',
    schedule: '自动维护计划',
    AI_URL: 'AI 地址',
    AI_KEY: 'AI 密钥',
    AI_MODEL: 'AI 模型',
    AI_PROMPT: 'AI 提示词'
};

function transformValidationMessage(rawMessage) {
    if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
        return '';
    }

    let message = rawMessage;

    Object.entries(FIELD_LABEL_MAP).forEach(([field, label]) => {
        const pattern = new RegExp(`"${field}"`, 'g');
        message = message.replace(pattern, label);
    });

    message = message
        .replace(/length must be at least (\d+) characters long/g, '长度至少为 $1 个字符')
        .replace(/length must be less than or equal to (\d+) characters long/g, '长度最多为 $1 个字符')
        .replace(/is required/g, '为必填项')
        .replace(/must be a string/g, '必须为字符串')
        .replace(/must be a boolean/g, '必须为布尔值')
        .replace(/may only contain alpha-numeric characters/g, '只能包含字母或数字')
        .replace(/must be an? array/g, '必须为数组')
        .replace(/must be a number/g, '必须为数字');

    return message.trim();
}

/**
 * 带重试机制的动态导入，解决 PWA 环境下的路径解析问题
 * @param {string} modulePath - 模块路径
 * @param {number} maxRetries - 最大重试次数
 * @returns {Promise} 导入的模块
 */
export async function importWithRetry(modulePath, maxRetries = 3) {
	for (let i = 0; i < maxRetries; i++) {
		try {
			return await import(modulePath);
		} catch (error) {
			utilsLogger.warn('动态导入失败', { attempt: i + 1, maxRetries, modulePath, error });
			
			// 如果是 PWA 环境且出现扩展相关错误，尝试使用绝对路径
			if (error.message && error.message.includes('chrome-extension')) {
				try {
					const absolutePath = new URL(modulePath, window.location.origin + '/js/').href;
					return await import(absolutePath);
				} catch (absoluteError) {
					utilsLogger.warn('绝对路径导入也失败', absoluteError);
				}
			}
			
			if (i === maxRetries - 1) throw error;
			
			// 指数退避重试
			await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * NETWORK.RETRY_BASE_DELAY));
		}
	}
}

/**
 * 显示通知消息
 * @param {string} message - 要显示的消息内容
 * @param {string} type - 通知类型 ('info', 'success', 'warning', 'error')
 * @param {number} duration - 自动消失时间（毫秒）
 */
// 去重提示：同一 message+type 的通知在可见期内仅保留一条，并累加计数
export function resolveMessage(value, fallback = '操作失败') {
    if (value === null || value === undefined) {
        return fallback;
    }

    if (value instanceof Error) {
        const derived = resolveMessage(value.message, '').trim();
        return derived || fallback;
    }

    const valueType = typeof value;
    if (valueType === 'string') {
        const trimmed = value.trim();
        if (trimmed && trimmed !== '[object Object]') {
            return trimmed;
        }
        return fallback;
    }

    if (valueType === 'number' || valueType === 'bigint' || valueType === 'boolean') {
        return String(value);
    }

    if (Array.isArray(value)) {
        const parts = value
            .map((item) => resolveMessage(item, ''))
            .filter(Boolean);
        if (parts.length > 0) {
            return parts.join('、');
        }
        return fallback;
    }

    if (valueType === 'object') {
        if (Array.isArray(value.details) && value.details.length > 0) {
            const detailMessages = value.details
                .map((detail) => transformValidationMessage(detail?.message))
                .filter(Boolean);
            if (detailMessages.length > 0) {
                return detailMessages.join('、');
            }
        }

        const candidates = [
            value.message,
            value.error,
            value.errorMessage,
            value.reason,
            value.description,
            value.detail,
            value.details?.originalError,
            value.details?.message,
            value.details?.error
        ];

        for (const candidate of candidates) {
            const resolved = resolveMessage(candidate, '');
            if (resolved) {
                return resolved;
            }
        }

        try {
            const serialized = JSON.stringify(value);
            if (serialized && serialized !== '{}' && serialized !== '[]') {
                return serialized;
            }
        } catch (error) {
            utilsLogger.debug('resolveMessage JSON 序列化失败', { error });
        }

        return fallback;
    }

    return fallback;
}

export function showNotification(message, type = 'info', duration = UI.NOTIFICATION_DURATION_DEFAULT, options = {}) {
    const { theme = 'default', containerId, context } = options || {};

    const targetContainerId = containerId
        || (theme === 'download' ? 'download-notification-container' : 'notification-container');
    const containerParent = context || (theme === 'download' ? safeGetElementById('download-root') || document.body : document.body);

    let container = safeGetElementById(targetContainerId);
    if (!container) {
        container = document.createElement('div');
        container.id = targetContainerId;
        container.className = theme === 'download' ? 'download-notification-container' : '';
        containerParent.appendChild(container);
    }
    const fallbackMap = {
        success: '操作成功',
        error: '操作失败',
        warning: '请注意',
        info: '通知'
    };
    const normalizedMessage = resolveMessage(message, fallbackMap[type] || '通知');
    const key = `${type}:${normalizedMessage}`;
    // 查找是否已有相同通知
    const existing = Array.from(container.querySelectorAll('.notification'))
        .find(el => el.dataset && el.dataset.key === key);
    if (existing) {
        const count = (Number(existing.dataset.count || '1') + 1);
        existing.dataset.count = String(count);
        const spanEl = existing.querySelector('span');
        if (spanEl) spanEl.textContent = count > 1 ? `${normalizedMessage}（x${count}）` : normalizedMessage;
        // 重新计时：延长展示时间
        if (existing._hideTimeout) clearTimeout(existing._hideTimeout);
        existing._hideTimeout = setTimeout(() => remove(existing), duration);
        // 轻微动效反馈（可选，不影响样式不存在时的兼容）
        safeClassList(existing, 'remove', 'show');
        // 下一帧再添加以触发过渡
        requestAnimationFrame(() => safeClassList(existing, 'add', 'show'));
        return;
    }
    
    // 创建通知元素
    const notif = document.createElement('div');
    const themeClass = theme === 'download' ? 'download-notification' : '';
    notif.className = ['notification', type, themeClass].filter(Boolean).join(' ');
    notif.dataset.key = key;
    notif.dataset.count = '1';
    safeSetInnerHTML(notif, `
        <span>${normalizedMessage}</span>
        <button class="close-btn" aria-label="关闭">&times;</button>
    `);
    container.appendChild(notif);

    // 动画显示
    setTimeout(() => safeClassList(notif, 'add', 'show'), 10);

    // 自动消失逻辑
    notif._hideTimeout = setTimeout(() => remove(notif), duration);
    notif.addEventListener('mouseenter', () => {
        if (notif._hideTimeout) clearTimeout(notif._hideTimeout);
    });
    notif.addEventListener('mouseleave', () => {
        notif._hideTimeout = setTimeout(() => remove(notif), duration);
    });

    // 手动关闭按钮
    notif.querySelector('.close-btn').onclick = () => remove(notif);

    // 移除通知的函数
    function remove(el) {
        try { if (el && el._hideTimeout) clearTimeout(el._hideTimeout); } catch {}
        const node = el || notif;
        safeClassList(node, 'remove', 'show');
        setTimeout(() => {
            node.remove();
            if (container && container.childElementCount === 0 && container.parentNode) {
                if (theme === 'download') {
                    container.parentNode.removeChild(container);
                }
            }
        }, 300);
    }
}

/**
 * 预加载下一批图片
 * @param {Array} currentPhotos - 当前照片数组
 * @param {number} startIndex - 当前显示的起始索引
 */
export function preloadNextImages(currentPhotos, startIndex) {
    // 获取需要预加载的图片（当前索引后的2张图片）
    const toPreload = currentPhotos.slice(startIndex + 1, startIndex + 3);
    
    // 遍历预加载列表，排除视频文件
    toPreload.forEach(url => {
        if (url && !/\.(mp4|webm|mov)$/i.test(url)) {
            const img = new Image();
            img.src = url;
        }
    });
}

/**
 * 内网穿透环境检测和优化
 * 检测是否在内网穿透环境下，并应用相应的优化策略
 */
export function detectTunnelEnvironment() {
    const hostname = window.location.hostname;
    const port = window.location.port;
    
    // 检测常见的内网穿透服务
    const tunnelIndicators = [
        'ngrok.io',
        'ngrok-free.app',
        'tunnelto.dev',
        'localtunnel.me',
        'serveo.net',
        'localhost.run',
        'ngrok.app',
        'frp.com',
        'natapp.cn',
        'sunny-ngrok.com'
    ];
    
    const isTunnel = tunnelIndicators.some(indicator => hostname.includes(indicator)) || 
                     (hostname !== 'localhost' && hostname !== '127.0.0.1' && port !== '12080');
    
    if (isTunnel) {
        utilsLogger.debug('检测到内网穿透环境，应用优化策略');
        
        // 调整请求超时时间
        window.TUNNEL_TIMEOUT = NETWORK.TUNNEL_TIMEOUT; // 10秒

        // 调整重试策略
        window.TUNNEL_RETRY_DELAY = NETWORK.TUNNEL_RETRY_DELAY; // 2秒
        
        // 标记为隧道环境
        window.IS_TUNNEL_ENVIRONMENT = true;
    }
    
    return isTunnel;
}

/**
 * 获取适合当前环境的请求配置
 * @returns {Object} 请求配置对象
 */
export function getTunnelOptimizedConfig() {
    const isTunnel = window.IS_TUNNEL_ENVIRONMENT || detectTunnelEnvironment();
    
    return {
        timeout: isTunnel ? NETWORK.TUNNEL_TIMEOUT : NETWORK.DEFAULT_TIMEOUT,
        retries: isTunnel ? NETWORK.MAX_RETRY_ATTEMPTS : NETWORK.MAX_RETRY_ATTEMPTS - 1,
        retryDelay: isTunnel ? NETWORK.TUNNEL_RETRY_DELAY : NETWORK.DEFAULT_RETRY_DELAY,
        keepalive: true
    };
}

// 废弃的函数已移除，请直接使用 security.js 中的对应函数

/**
 * 统一的日志管理器
 * 提供条件化输出和统一的日志格式
 */
export const Logger = {
    /**
     * 开发环境日志输出
     * @param {string} level - 日志级别 ('log', 'warn', 'error', 'debug')
     * @param {string} message - 日志消息
     * @param {any} data - 附加数据
     */
    dev(level, message, data = null) {
        if (!isDevelopment()) return;

        const timestamp = new Date().toISOString().substr(11, 8); // HH:MM:SS
        const formattedMessage = `[${timestamp}] ${message}`;

        if (data !== null) {
            console[level](formattedMessage, data);
        } else {
            console[level](formattedMessage);
        }
    },

    /**
     * 错误日志输出（生产环境也输出）
     * @param {string} message - 错误消息
     * @param {Error} error - 错误对象
     */
    error(message, error = null) {
        if (error) {
            utilsLogger.error(message, error);
        } else {
            utilsLogger.error(message);
        }
    },

    /**
     * 警告日志输出（仅开发环境）
     * @param {string} message - 警告消息
     * @param {any} data - 附加数据
     */
    warn(message, data = null) {
        this.dev('warn', message, data);
    },

    /**
     * 调试日志输出（仅开发环境）
     * @param {string} message - 调试消息
     * @param {any} data - 附加数据
     */
    debug(message, data = null) {
        this.dev('debug', message, data);
    },

    /**
     * 普通日志输出（仅开发环境）
     * @param {string} message - 日志消息
     * @param {any} data - 附加数据
     */
    log(message, data = null) {
        this.dev('log', message, data);
    }
};

/**
 * 调试内网穿透环境下的请求状态
 * @param {string} message - 调试消息
 * @param {any} data - 调试数据
 */
export function debugTunnelRequest(message, data = null) {
    if (window.IS_TUNNEL_ENVIRONMENT) {
        Logger.debug(`[Tunnel] ${message}`, data);
    }
}

/**
 * 生产环境console控制函数
 * 在生产环境中禁用console输出，在开发环境中保留
 */
function setupConsoleControl() {
    // 检查是否为生产环境
    const isProduction = !isDevelopment();

    if (isProduction) {
        // 生产环境：禁用console输出但保留error
        const noop = () => {};
        const methods = ['log', 'debug', 'info', 'warn'];
        methods.forEach(method => {
            console[method] = noop;
        });

        // 保留error和trace用于错误报告
        console.error = console.error || noop;
        console.trace = console.trace || noop;
    }
}

// 在页面加载时检测环境
document.addEventListener('DOMContentLoaded', () => {
    detectTunnelEnvironment();
    setupConsoleControl();
    
    // 添加全局错误监听，减少内网穿透环境下的错误噪音
    if (window.IS_TUNNEL_ENVIRONMENT) {
        window.addEventListener('error', (event) => {
            // 过滤掉一些常见的网络错误，减少控制台噪音
            if (event.error && event.error.message) {
                const message = event.error.message;
                if (message.includes('Failed to execute \'put\' on \'Cache\'') ||
                    message.includes('net::ERR_ABORTED') ||
                    message.includes('503')) {
                    utilsLogger.debug('Suppressed tunnel error', { message });
                    event.preventDefault();
                }
            }
        });
    }
});