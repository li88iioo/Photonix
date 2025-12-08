/**
 * @file error-handler.js
 * @description 统一错误处理系统，提供全局错误捕获、分类处理和用户友好的错误提示
 */

import { showNotification } from '../shared/utils.js';
import { createModuleLogger } from './logger.js';
import { safeSetInnerHTML } from '../shared/dom-utils.js';
import { escapeHtml } from '../shared/security.js';

const errorLogger = createModuleLogger('ErrorHandler');

/**
 * @typedef {Object} ErrorTypes
 * @description 错误类型枚举，扩展分类以提升可观测性
 */
export const ErrorTypes = {
    // 网络相关
    NETWORK: 'network',
    NETWORK_TIMEOUT: 'network_timeout',
    NETWORK_OFFLINE: 'network_offline',

    // API 相关
    API: 'api',
    API_AUTHENTICATION: 'api_authentication',
    API_PERMISSION: 'api_permission',
    API_NOT_FOUND: 'api_not_found',
    API_RATE_LIMIT: 'api_rate_limit',
    API_SERVER_ERROR: 'api_server_error',
    API_VALIDATION: 'api_validation',

    // 应用相关
    VALIDATION: 'validation',
    PERMISSION: 'permission',
    STORAGE: 'storage',
    CONFIGURATION: 'configuration',

    // 第三方服务
    SERVICE_UNAVAILABLE: 'service_unavailable',
    EXTERNAL_API: 'external_api',

    // 用户操作
    USER_CANCEL: 'user_cancel',
    INVALID_INPUT: 'invalid_input',

    // 系统相关
    RUNTIME: 'runtime',
    RESOURCE_LOAD: 'resource_load',
    COMPATIBILITY: 'compatibility',

    UNKNOWN: 'unknown'
};

/**
 * @typedef {Object} ErrorSeverity
 * @description 错误严重级别枚举
 */
export const ErrorSeverity = {
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    CRITICAL: 'critical'
};

/**
 * @class ErrorHandler
 * @classdesc 全局错误处理器，负责捕获、记录、处理和展示错误
 */
class ErrorHandler {
    constructor() {
        /**
         * @type {Array<Object>}
         * @description 错误日志数组
         */
        this.errorLog = [];
        /**
         * @type {number}
         * @description 错误日志最大长度
         */
        this.maxLogSize = 100;
        this.setupGlobalHandlers();
    }

    /**
     * @description 设置全局错误处理器，捕获未处理的 Promise 拒绝、全局 JS 错误和资源加载错误
     */
    setupGlobalHandlers() {
        // 🔧 辅助函数：检查是否来自浏览器扩展
        const isExtensionError = (error, filename) => {
            if (!error) return false;

            // 检查错误消息
            const message = error.message || String(error);
            if (message.includes('chrome-extension://') ||
                message.includes('moz-extension://') ||
                message.includes('safari-extension://')) {
                return true;
            }

            // 检查文件名
            if (filename && (
                filename.includes('chrome-extension://') ||
                filename.includes('moz-extension://') ||
                filename.includes('safari-extension://')
            )) {
                return true;
            }

            return false;
        };

        // 捕获未处理的 Promise 拒绝
        window.addEventListener('unhandledrejection', (event) => {
            // 过滤浏览器扩展错误
            if (isExtensionError(event.reason)) {
                // 开发模式下记录日志，方便调试
                if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                    errorLogger.debug('忽略浏览器扩展错误 (unhandledrejection)', {
                        reason: event.reason?.message || String(event.reason)
                    });
                }
                event.preventDefault(); // 阻止在控制台显示红色错误
                return;
            }

            // 过滤 AbortError，避免在控制台显示过多的中止错误
            if (event.reason && event.reason.name === 'AbortError') {
                errorLogger.debug('忽略 AbortError (unhandledrejection)', {
                    reason: event.reason?.message || String(event.reason)
                });
                event.preventDefault();
                return;
            }

            this.handleError(event.reason, {
                type: ErrorTypes.UNKNOWN,
                severity: ErrorSeverity.MEDIUM,
                context: 'unhandledrejection'
            });
        });

        // 捕获全局 JavaScript 错误
        window.addEventListener('error', (event) => {
            // 过滤浏览器扩展错误
            if (isExtensionError(event.error || event.message, event.filename)) {
                // 开发模式下记录日志，方便调试
                if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                    errorLogger.debug('忽略浏览器扩展错误 (error)', {
                        error: event.error?.message || String(event.error),
                        filename: event.filename
                    });
                }
                event.preventDefault(); // 阻止在控制台显示红色错误
                return;
            }

            // 过滤浏览器切换桌面/移动模式等导致的匿名 Script error
            if (event.message === 'Script error.' && !event.filename) {
                if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                    errorLogger.debug('忽略跨域 Script error.', { message: event.message });
                }
                event.preventDefault();
                return;
            }

            this.handleError(event.error || event.message, {
                type: ErrorTypes.UNKNOWN,
                severity: ErrorSeverity.HIGH,
                context: 'global',
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno
            });
        });

        // 捕获资源加载错误 - 过滤掉不重要的资源
        window.addEventListener('error', (event) => {
            if (event.target !== window) {
                const src = event.target.src || event.target.href;
                // 过滤掉某些不重要的资源加载失败
                if (src && (
                    src.includes('favicon') ||
                    src.includes('manifest') ||
                    src.endsWith('/') ||  // 避免根路径请求
                    src === window.location.origin + '/'  // 过滤掉对根路径的请求
                )) {
                    return; // 忽略这些资源加载错误
                }

                errorLogger.warn('Resource failed to load', { src });
                // 不再触发错误处理器，避免不必要的网络请求
            }
        }, true);
    }

    /**
     * @description 处理错误的主要方法
     * @param {Error|string} error 错误对象或错误消息
     * @param {Object} [options] 错误处理选项
     * @returns {Object} 错误信息对象
     */
    handleError(error, options = {}) {
        const errorInfo = this.normalizeError(error, options);

        // 记录错误
        this.logError(errorInfo);

        // 根据错误类型和严重程度决定处理方式
        this.processError(errorInfo);

        return errorInfo;
    }

    /**
     * @description 标准化错误信息
     * @param {Error|string} error 错误对象或错误消息
     * @param {Object} options 错误处理选项
     * @returns {Object} 标准化后的错误信息
     */
    normalizeError(error, options) {
        const errorInfo = {
            message: '',
            type: options.type || ErrorTypes.UNKNOWN,
            severity: options.severity || ErrorSeverity.MEDIUM,
            context: options.context || 'unknown',
            timestamp: new Date().toISOString(),
            stack: null,
            userAgent: navigator.userAgent,
            url: window.location.href,
            ...options
        };

        if (error instanceof Error) {
            errorInfo.message = error.message;
            errorInfo.stack = error.stack;
            errorInfo.name = error.name;
        } else if (typeof error === 'string') {
            errorInfo.message = error;
        } else {
            errorInfo.message = 'Unknown error occurred';
            errorInfo.originalError = error;
        }

        return errorInfo;
    }

    /**
     * @description 记录错误到本地日志
     * @param {Object} errorInfo 错误信息
     */
    logError(errorInfo) {
        // 添加到内存日志
        this.errorLog.unshift(errorInfo);
        if (this.errorLog.length > this.maxLogSize) {
            this.errorLog.pop();
        }

        // 生产环境安全修复：条件化 console 输出
        errorLogger.error('Error handled', errorInfo);
    }

    /**
     * @description 处理错误，根据类型和严重程度决定通知方式
     * @param {Object} errorInfo 错误信息
     */
    processError(errorInfo) {
        const { type, severity, message, context } = errorInfo;

        // 根据错误类型提供用户友好的消息
        const userMessage = this.getUserFriendlyMessage(errorInfo);

        // 根据严重程度决定通知方式
        switch (severity) {
            case ErrorSeverity.CRITICAL:
                this.showCriticalError(userMessage, errorInfo);
                break;
            case ErrorSeverity.HIGH:
                showNotification(userMessage, 'error', 8000);
                break;
            case ErrorSeverity.MEDIUM:
                showNotification(userMessage, 'warning', 5000);
                break;
            case ErrorSeverity.LOW:
                errorLogger.warn('低级别错误', { message });
                break;
        }

        // 特殊处理某些错误类型
        this.handleSpecificErrorTypes(errorInfo);
    }

    /**
     * @description 获取用户友好的错误消息
     * @param {Object} errorInfo 错误信息
     * @returns {string} 用户友好的错误消息
     */
    getUserFriendlyMessage(errorInfo) {
        const { type, message, context } = errorInfo;

        // 网络错误
        if (type === ErrorTypes.NETWORK) {
            if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
                return '网络连接失败，请检查网络设置';
            }
            if (message.includes('timeout')) {
                return '请求超时，请稍后重试';
            }
            return '网络请求失败，请稍后重试';
        }

        // API 错误
        if (type === ErrorTypes.API) {
            if (message.includes('401') || message.includes('Unauthorized')) {
                return '身份验证失败，请重新登录';
            }
            if (message.includes('403') || message.includes('Forbidden')) {
                return '权限不足，无法执行此操作';
            }
            if (message.includes('404') || message.includes('Not Found')) {
                return '请求的资源不存在';
            }
            if (message.includes('500') || message.includes('Internal Server Error')) {
                return '服务器内部错误，请稍后重试';
            }
            return 'API 请求失败，请稍后重试';
        }

        // 验证错误
        if (type === ErrorTypes.VALIDATION) {
            return message || '输入数据格式不正确';
        }

        // 权限错误
        if (type === ErrorTypes.PERMISSION) {
            return '权限不足，无法执行此操作';
        }

        // 默认消息
        return message || '发生未知错误，请稍后重试';
    }

    /**
     * @description 显示关键错误（弹窗）
     * @param {string} message 错误消息
     * @param {Object} errorInfo 错误信息
     */
    showCriticalError(message, errorInfo) {
        // 创建模态框显示关键错误
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 z-[9999] bg-black bg-opacity-75 flex items-center justify-center';
        safeSetInnerHTML(modal, `
            <div class="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md mx-4">
                <div class="flex items-center mb-4">
                    <div class="flex-shrink-0">
                        <svg class="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"></path>
                        </svg>
                    </div>
                    <div class="ml-3">
                        <h3 class="text-lg font-medium text-gray-900 dark:text-white">系统错误</h3>
                    </div>
                </div>
                <div class="mb-4">
                    <p class="text-sm text-gray-700 dark:text-gray-300">${message ? escapeHtml(message) : '发生未知错误'}</p>
                </div>
                <div class="flex justify-end space-x-3">
                    <button id="error-reload" class="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700">
                        刷新页面
                    </button>
                    <button id="error-dismiss" class="px-4 py-2 bg-gray-300 text-gray-700 rounded hover:bg-gray-400">
                        忽略
                    </button>
                </div>
            </div>
        `);

        document.body.appendChild(modal);

        // 绑定事件
        modal.querySelector('#error-reload').addEventListener('click', () => {
            window.location.reload();
        });

        modal.querySelector('#error-dismiss').addEventListener('click', () => {
            modal.remove();
        });
    }

    /**
     * @description 处理特定类型的错误
     * @param {Object} errorInfo 错误信息
     */
    handleSpecificErrorTypes(errorInfo) {
        const { type, context } = errorInfo;

        // 网络错误的特殊处理
        if (type === ErrorTypes.NETWORK && context === 'api') {
            // 可以触发重试机制或切换到离线模式
            this.handleNetworkError(errorInfo);
        }

        // API 错误的特殊处理
        if (type === ErrorTypes.API) {
            this.handleApiError(errorInfo);
        }
    }

    /**
     * @description 处理网络错误
     * @param {Object} errorInfo 错误信息
     */
    handleNetworkError(errorInfo) {
        // 🔧 修复问题2：减少网络错误通知的噪音
        // 只在真正影响用户操作时才通知（由main.js的offline事件统一处理）
        // 这里不再重复显示通知，避免内网穿透环境的频繁误报
        if (!navigator.onLine) {
            // 静默记录，不显示通知
            errorLogger.debug('网络连接已断开', errorInfo);
        }
    }

    /**
     * @description 处理 API 错误
     * @param {Object} errorInfo 错误信息
     */
    handleApiError(errorInfo) {
        const { message } = errorInfo;

        // 401 错误 - 触发重新认证
        if (message.includes('401')) {
            window.dispatchEvent(new CustomEvent('auth:required'));
        }
    }

    /**
     * @description 获取错误日志
     * @returns {Array<Object>} 错误日志数组
     */
    getErrorLog() {
        return [...this.errorLog];
    }

    /**
     * @description 清空错误日志
     */
    clearErrorLog() {
        this.errorLog = [];
    }

    /**
     * @description 通用错误创建方法
     * @param {string} type 错误类型
     * @param {string} message 错误消息
     * @param {string} [severity=ErrorSeverity.MEDIUM] 错误严重程度
     * @param {Object} [context] 上下文信息
     * @returns {Error} 标准化的错误对象
     */
    createError(type, message, severity = ErrorSeverity.MEDIUM, context = {}) {
        const error = new Error(message);
        error.type = type;
        error.severity = severity;
        error.context = {
            ...context,
            timestamp: Date.now(),
            url: window.location.href,
            userAgent: navigator.userAgent
        };

        // 添加堆栈跟踪（如果支持）
        if (Error.captureStackTrace) {
            Error.captureStackTrace(error, this.createError);
        }

        return error;
    }
}

// 创建全局错误处理器实例
const errorHandler = new ErrorHandler();

/**
 * @function handleError
 * @description 统一错误处理入口
 * @param {Error|string} error 错误对象或消息
 * @param {Object} [options] 错误处理选项
 * @returns {Object} 错误信息对象
 */
export const handleError = (error, options) => errorHandler.handleError(error, options);

/**
 * @function getErrorLog
 * @description 获取错误日志
 * @returns {Array<Object>} 错误日志数组
 */
export const getErrorLog = () => errorHandler.getErrorLog();

/**
 * @function clearErrorLog
 * @description 清空错误日志
 */
export const clearErrorLog = () => errorHandler.clearErrorLog();

/**
 * @function createError
 * @description 通用错误创建方法
 * @param {string} type 错误类型
 * @param {string} message 错误消息
 * @param {string} severity 错误严重程度
 * @param {Object} [context] 上下文信息
 * @returns {Error}
 */
export const createError = (type, message, severity, context) => errorHandler.createError(type, message, severity, context);

/**
 * @type {ErrorHandler}
 * @description 错误处理器实例
 */
export default errorHandler;

/**
 * @class AsyncErrorBoundary
 * @classdesc 异步操作错误边界包装器，为异步操作提供统一的错误处理和重试机制
 */
export class AsyncErrorBoundary {
    /**
     * @constructor
     * @param {Object} [options] 配置选项
     * @param {number} [options.maxRetries=3] 最大重试次数
     * @param {number} [options.retryDelay=1000] 初始重试延迟（毫秒）
     * @param {number} [options.backoffMultiplier=2] 重试延迟递增倍数
     * @param {Function} [options.onError] 错误回调
     * @param {Function} [options.onRetry] 重试回调
     */
    constructor(options = {}) {
        const normalizedRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : 3;
        const normalizedDelay = Number.isFinite(options.retryDelay) ? options.retryDelay : 1000;
        const normalizedBackoff = Number.isFinite(options.backoffMultiplier) ? options.backoffMultiplier : 2;

        this.maxRetries = Math.max(0, normalizedRetries);
        this.retryDelay = Math.max(0, normalizedDelay);
        this.backoffMultiplier = normalizedBackoff > 0 ? normalizedBackoff : 2;
        this.onError = options.onError || null;
        this.onRetry = options.onRetry || null;
    }

    /**
     * @description 执行异步操作，自动处理错误和重试
     * @param {Function} operation 要执行的异步操作函数
     * @param {Object} [context] 错误上下文信息
     * @returns {Promise<any>} 操作结果
     */
    async execute(operation, context = {}) {
        let lastError;

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;

                if (error.name === 'AbortError') {
                    throw error;
                }

                // 调用错误回调
                if (this.onError) {
                    this.onError(error, { ...context, attempt: attempt + 1 });
                }

                // 如果不是最后一次尝试，进行重试
                if (attempt < this.maxRetries) {
                    const delay = this.retryDelay * Math.pow(this.backoffMultiplier, attempt);

                    // 调用重试回调
                    if (this.onRetry) {
                        this.onRetry(error, { ...context, attempt: attempt + 1, delay });
                    }

                    await this.delay(delay);
                }
            }
        }

        // 所有重试都失败，抛出最后一次错误
        throw lastError;
    }

    /**
     * @description 延迟执行
     * @param {number} ms 延迟毫秒数
     * @returns {Promise<void>} 延迟 Promise
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

/**
 * @function createAsyncBoundary
 * @description 创建异步操作包装器
 * @param {Object} [options] 配置选项
 * @returns {AsyncErrorBoundary} 错误边界实例
 */
export function createAsyncBoundary(options = {}) {
    return new AsyncErrorBoundary(options);
}

/**
 * @function executeAsync
 * @description 统一的异步操作执行器
 * @param {Function} operation 异步操作函数
 * @param {Object} [options] 执行选项
 * @param {number} [options.maxRetries=3] 最大重试次数
 * @param {number} [options.retryDelay=1000] 初始重试延迟（毫秒）
 * @param {Object} [options.context={}] 错误上下文信息
 * @param {string} [options.errorType=ErrorTypes.UNKNOWN] 错误类型
 * @param {string} [options.errorSeverity=ErrorSeverity.MEDIUM] 错误严重程度
 * @param {Function} [options.onError] 错误回调
 * @param {Function} [options.onRetry] 重试回调
 * @returns {Promise<any>} 操作结果
 * @throws {Error} 统一处理后的错误
 */
export async function executeAsync(operation, options = {}) {
    const {
        maxRetries = 3,
        retryDelay = 1000,
        context = {},
        errorType = ErrorTypes.UNKNOWN,
        errorSeverity = ErrorSeverity.MEDIUM,
        onError,
        onRetry
    } = options;

    const boundary = createAsyncBoundary({
        maxRetries,
        retryDelay,
        onError: onError || ((error, ctx) => {
            errorLogger.warn(`异步操作失败 (尝试 ${ctx.attempt})`, {
                error: error.message,
                context: ctx
            });
        }),
        onRetry: onRetry || ((error, ctx) => {
            errorLogger.info(`重试异步操作 (${ctx.attempt}/${maxRetries + 1})`, {
                delay: ctx.delay,
                context: ctx
            });
        })
    });

    try {
        return await boundary.execute(operation, context);
    } catch (error) {
        // 静默退出，不触发错误处理器
        // 这是最后一道防线，确保即使前两层失效也不会误报
        if (error.name === 'AbortError') {
            errorLogger.debug('操作被中止', {
                operation: operation.name || 'anonymous',
                reason: error.message,
                context
            });
            throw error;
        }

        // 使用统一错误处理器处理最终失败
        const handledError = errorHandler.handleError(error, {
            type: errorType,
            severity: errorSeverity,
            context: {
                ...context,
                operation: operation.name || 'anonymous',
                maxRetries,
                finalAttempt: true
            }
        });

        throw handledError;
    }
}
