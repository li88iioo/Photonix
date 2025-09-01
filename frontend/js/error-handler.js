// frontend/js/error-handler.js

/**
 * 统一错误处理系统
 * 提供全局错误捕获、分类处理和用户友好的错误提示
 */

import { showNotification } from './utils.js';

// 错误类型枚举
export const ErrorTypes = {
    NETWORK: 'network',
    API: 'api',
    VALIDATION: 'validation',
    PERMISSION: 'permission',
    UNKNOWN: 'unknown'
};

// 错误严重级别
export const ErrorSeverity = {
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    CRITICAL: 'critical'
};

class ErrorHandler {
    constructor() {
        this.errorLog = [];
        this.maxLogSize = 100;
        this.setupGlobalHandlers();
    }

    /**
     * 设置全局错误处理器
     */
    setupGlobalHandlers() {
        // 捕获未处理的 Promise 拒绝
        window.addEventListener('unhandledrejection', (event) => {
            this.handleError(event.reason, {
                type: ErrorTypes.UNKNOWN,
                severity: ErrorSeverity.MEDIUM,
                context: 'unhandledrejection'
            });
        });

        // 捕获全局 JavaScript 错误
        window.addEventListener('error', (event) => {
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
                
                console.warn(`Resource failed to load: ${src}`);
                // 不再触发错误处理器，避免不必要的网络请求
            }
        }, true);
    }

    /**
     * 处理错误的主要方法
     * @param {Error|string} error - 错误对象或错误消息
     * @param {Object} options - 错误处理选项
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
     * 标准化错误信息
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
     * 记录错误到本地日志
     */
    logError(errorInfo) {
        // 添加到内存日志
        this.errorLog.unshift(errorInfo);
        if (this.errorLog.length > this.maxLogSize) {
            this.errorLog.pop();
        }

        // 控制台输出（开发模式）
        if (process.env.NODE_ENV === 'development' || window.location.hostname === 'localhost') {
            console.error('Error handled:', errorInfo);
        }

        // 可选：发送到远程日志服务
        this.sendToRemoteLog(errorInfo);
    }

    /**
     * 处理错误
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
                // 低级别错误仅记录，不打扰用户
                console.warn('低级别错误:', message);
                break;
        }

        // 特殊处理某些错误类型
        this.handleSpecificErrorTypes(errorInfo);
    }

    /**
     * 获取用户友好的错误消息
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
     * 显示关键错误
     */
    showCriticalError(message, errorInfo) {
        // 创建模态框显示关键错误
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 z-[9999] bg-black bg-opacity-75 flex items-center justify-center';
        modal.innerHTML = `
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
                    <p class="text-sm text-gray-700 dark:text-gray-300">${message}</p>
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
        `;

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
     * 处理特定类型的错误
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
     * 处理网络错误
     */
    handleNetworkError(errorInfo) {
        // 检查网络状态
        if (!navigator.onLine) {
            showNotification('网络连接已断开，部分功能可能不可用', 'warning', 10000);
        }
    }

    /**
     * 处理 API 错误
     */
    handleApiError(errorInfo) {
        const { message } = errorInfo;

        // 401 错误 - 触发重新认证
        if (message.includes('401')) {
            window.dispatchEvent(new CustomEvent('auth:required'));
        }
    }

    /**
     * 发送错误到远程日志服务（可选）
     * 暂时禁用以避免不必要的网络请求
     */
    async sendToRemoteLog(errorInfo) {
        // 暂时禁用远程日志功能
        return;
        
        // 只在生产环境发送
        if (process.env.NODE_ENV !== 'production') return;

        try {
            // 这里可以集成第三方错误监控服务
            // 如 Sentry, LogRocket, Bugsnag 等
            
            // 示例：发送到自定义端点
            /*
            await fetch('/api/errors', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(errorInfo)
            });
            */
        } catch (error) {
            // 静默处理日志发送失败
            console.warn('发送错误日志失败:', error);
        }
    }

    /**
     * 获取错误日志
     */
    getErrorLog() {
        return [...this.errorLog];
    }

    /**
     * 清空错误日志
     */
    clearErrorLog() {
        this.errorLog = [];
    }
}

// 创建全局错误处理器实例
const errorHandler = new ErrorHandler();

// 导出便捷方法
export const handleError = (error, options) => errorHandler.handleError(error, options);
export const getErrorLog = () => errorHandler.getErrorLog();
export const clearErrorLog = () => errorHandler.clearErrorLog();

// 导出错误处理器实例
export default errorHandler;