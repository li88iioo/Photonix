// frontend/js/main.js

import { state } from './state.js';
import { initializeAuth, showLoginScreen, getAuthToken, removeAuthToken, checkAuthStatus } from './auth.js';
import { fetchSettings, clearAuthHeadersCache } from './api.js';
import { showSkeletonGrid } from './loading-states.js';
import { showNotification } from './utils.js';
import { initializeSSE } from './sse.js';
import { setupEventListeners } from './listeners.js';
import { initializeRouter } from './router.js';
import { blobUrlManager } from './lazyload.js';
import { saveLazyLoadState, restoreLazyLoadState, clearLazyLoadProtection } from './lazyload-state-manager.js';
import { initializeUI } from './ui.js';
import { UI } from './constants.js';
import { createModuleLogger } from './logger.js';
import { safeSetInnerHTML, safeGetElementById, safeQuerySelector, safeClassList } from './dom-utils.js';
import { eventManager } from './event-manager.js';

const mainLogger = createModuleLogger('Main');

let appStarted = false;

// 生成与 frontend/assets/icon.svg 相同的 SVG，并设置为 favicon（运行时注入，避免静态依赖）
function applyAppIcon() {
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="192" height="192" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="ring-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#8B5CF6" />
      <stop offset="100%" stop-color="#F472B6" />
    </linearGradient>
    <radialGradient id="core-glow" cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="1" />
      <stop offset="70%" stop-color="#F472B6" stop-opacity="0.8" />
      <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0" />
    </radialGradient>
    <style>
      .ring { fill: none; stroke-width: 2; transform-origin: 50% 50%; }
      .core { transform-origin: 50% 50%; animation: pulse 3s ease-in-out infinite; }
      @keyframes rotate-cw { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      @keyframes rotate-ccw { from { transform: rotate(0deg); } to { transform: rotate(-360deg); } }
      @keyframes pulse { 0% { transform: scale(0.9); opacity: 0.8; } 50% { transform: scale(1.1); opacity: 1; } 100% { transform: scale(0.9); opacity: 0.8; } }
      #outer-ring { animation: rotate-cw 20s linear infinite; }
      #middle-ring { animation: rotate-ccw 15s linear infinite; }
      #inner-ring { animation: rotate-cw 10s linear infinite; }
    </style>
  </defs>
  <circle cx="50" cy="50" r="50" fill="#111827" />
  <circle class="core" cx="50" cy="50" r="15" fill="url(#core-glow)" />
  <circle id="outer-ring" class="ring" cx="50" cy="50" r="45" stroke="url(#ring-gradient)" stroke-opacity="0.5" />
  <circle id="middle-ring" class="ring" cx="50" cy="50" r="35" stroke="url(#ring-gradient)" />
  <circle id="inner-ring" class="ring" cx="50" cy="50" r="25" stroke="white" stroke-opacity="0.8" />
</svg>`;
    const dataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    let linkEl = safeQuerySelector('link[rel="icon"]');
    if (!linkEl) {
        linkEl = document.createElement('link');
        linkEl.setAttribute('rel', 'icon');
        document.head.appendChild(linkEl);
    }
    linkEl.setAttribute('type', 'image/svg+xml');
    linkEl.setAttribute('href', dataUrl);
}

/**
 * 统一的UI状态机，管理应用、登录、错误等不同视图状态的切换
 * @param {'app'|'login'|'error'} nextState - 目标状态
 * @param {object} [options] - 附加选项
 */
function setUIState(nextState, options = {}) {
    const app = safeGetElementById('app-container');
    const overlay = safeGetElementById('auth-overlay');

    const hideOverlay = () => {
        if (!overlay) return;
        safeClassList(overlay, 'remove', 'opacity-100');
        safeClassList(overlay, 'add', 'opacity-0');
        safeClassList(overlay, 'add', 'pointer-events-none');
    };
    const showOverlay = () => {
        if (!overlay) return;
        safeClassList(overlay, 'remove', 'opacity-0');
        safeClassList(overlay, 'remove', 'pointer-events-none');
        safeClassList(overlay, 'add', 'opacity-100');
    };

    switch (nextState) {
        case 'app':
            if (app) {
                safeClassList(app, 'remove', 'opacity-0');
                safeClassList(app, 'add', 'opacity-100');
            }
            hideOverlay();
            break;
        case 'login':
            if (app) {
                safeClassList(app, 'remove', 'opacity-100');
                safeClassList(app, 'add', 'opacity-0');
            }
            showOverlay();
            break;
        case 'error':
            showOverlay();
            break;
    }
}

/**
 * 应用初始化函数
 */
async function initializeApp() {
    // 注入与静态文件一致的 SVG 图标，避免启动时找不到 /assets 时的 404
    try { applyAppIcon(); } catch {}
    // 1. 初始化基础组件和事件监听
    state.update('userId', initializeAuth());
    try {
        setupEventListeners();
    } catch (e) {
        mainLogger.error('事件监听器加载失败', e);
    }

    // 2. 检查认证状态，决定显示登录页还是主应用
    try {
        const authStatus = await checkAuthStatus();
        const token = getAuthToken();

        if (authStatus.passwordEnabled && !token) {
            setUIState('login');
            showLoginScreen();
        } else {
            setUIState('app');
            startMainApp();
        }
    } catch (error) {
        mainLogger.error('应用初始化失败', error);

        setUIState('error');
        const authContainer = safeGetElementById('auth-container');
        if(authContainer) {
            safeSetInnerHTML(authContainer, `
                <div class="auth-card text-center">
                    <h2 class="auth-title text-red-500">应用加载失败</h2>
                    <p class="text-gray-300">无法连接到服务器，请刷新页面重试。</p>
                    <button id="refresh-btn" class="btn btn-primary mt-4">刷新页面</button>
                    <p class="text-gray-400 text-sm mt-2">${error.message ? error.message.replace(/[<>]/g, '') : '未知错误'}</p>
                </div>
            `);
            safeGetElementById('refresh-btn')?.addEventListener('click', () => window.location.reload());
        }
    }
}

/**
 * 启动主应用的核心逻辑
 */
function startMainApp() {
    if (appStarted) return;
    appStarted = true;

    showSkeletonGrid();
    initializeSSE();
    initializeUI();

    try {
        initializeRouter();
    } catch (e) {
        mainLogger.error('路由器加载失败', e);
    }
    loadAppSettings();

    // 设置全局事件监听
    window.addEventListener('offline', () => showNotification('网络已断开', 'warning', UI.NOTIFICATION_DURATION_WARNING));
    window.addEventListener('online', () => showNotification('网络已恢复', 'success', UI.NOTIFICATION_DURATION_SUCCESS));
    window.addEventListener('auth:required', () => {
        removeAuthToken();
        setUIState('login');
        showLoginScreen();
    });

    // 监听认证状态变更事件
    window.addEventListener('auth:statusChanged', async (event) => {
        const { passwordEnabled } = event.detail;
        mainLogger.info('认证状态变更，重新检查', { passwordEnabled });

        try {
            // 清除API缓存中的认证头，避免使用过时的认证信息
            if (typeof clearAuthHeadersCache === 'function') {
                clearAuthHeadersCache();
            }

            const token = getAuthToken();

            if (passwordEnabled) {
                // 密码已启用
                if (!token) {
                    // 没有令牌，需要重新登录
                    setUIState('login');
                    showLoginScreen();
                } else {
                    // 有令牌，重新检查认证状态
                    const authStatus = await checkAuthStatus();
                    if (!authStatus.passwordEnabled) {
                        // 后端密码已关闭但前端仍有令牌，需要重新登录
                        removeAuthToken();
                        setUIState('login');
                        showLoginScreen();
                    } else {
                        // 密码仍然启用，正常显示主应用
                        setUIState('app');
                        startMainApp();
                    }
                }
            } else {
                // 密码已关闭
                if (token) {
                    // 有令牌但密码已关闭，清除令牌并重新初始化
                    removeAuthToken();
                    setUIState('app');
                    // 重新初始化应用以清除所有认证相关的状态
                    if (!appStarted) {
                        startMainApp();
                    } else {
                        // 如果应用已经启动，重新初始化路由
                        try {
                            initializeRouter();
                        } catch (e) {
                            mainLogger.error('路由器重新初始化失败', e);
                        }
                    }
                } else {
                    // 没有令牌，正常显示主应用
                    setUIState('app');
                    if (!appStarted) {
                        startMainApp();
                    }
                }
            }
        } catch (error) {
            mainLogger.error('认证状态重新检查失败', error);
            // 如果检查失败且没有令牌，默认显示登录页面
            if (!getAuthToken()) {
                setUIState('login');
                showLoginScreen();
            } else {
                // 有令牌但检查失败，显示主应用
                setUIState('app');
                if (!appStarted) {
                    startMainApp();
                }
            }
        }
    });
}

/**
 * 异步加载应用设置
 */
async function loadAppSettings() {
    try {
        const clientSettings = await fetchSettings();
        const localAI = JSON.parse(localStorage.getItem('ai_settings') || '{}');
        
        state.update('aiEnabled', (localAI.AI_ENABLED !== undefined) ? (localAI.AI_ENABLED === 'true') : (clientSettings.AI_ENABLED === 'true'));
        state.update('passwordEnabled', clientSettings.PASSWORD_ENABLED === 'true');
    } catch (e) {
        mainLogger.warn("无法获取应用设置，使用默认配置", e);

        state.batchUpdate({ aiEnabled: false, passwordEnabled: false });
    }
}

// Service Worker 注册
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(registration => {
                mainLogger.info('ServiceWorker 注册成功', { scope: registration.scope });
            })
            .catch(err => {
                mainLogger.error('ServiceWorker 注册失败', err);
            });
    });
}

/**
 * 异步操作管理器 - 用于管理页面生命周期中的异步操作
 * 使用AbortController + 资源管理器
 */
class AsyncOperationManager {
    constructor() {
        this.controllers = new Map();
        this.timeouts = new Map();
        this.pageHiddenTime = 0;
        this.isPageReallyHidden = false;
        this.pageSessionId = Date.now().toString();

        // 初始化页面会话
        sessionStorage.setItem('pageSessionId', this.pageSessionId);
        mainLogger.debug('初始化异步操作管理器', { sessionId: this.pageSessionId });

        this.setupLifecycleHandlers();
    }

    /**
     * 创建命名控制器
     * @param {string} name - 控制器名称
     * @returns {AbortController}
     */
    createController(name) {
        // 取消同名现有控制器
        this.abort(name);

        const controller = new AbortController();
        this.controllers.set(name, controller);
        return controller;
    }

    /**
     * 取消指定控制器
     * @param {string} name - 控制器名称
     */
    abort(name) {
        const controller = this.controllers.get(name);
        if (controller && !controller.signal.aborted) {
            controller.abort();
        }
        this.controllers.delete(name);
    }

    /**
     * 设置命名超时
     * @param {string} name - 超时名称
     * @param {Function} callback - 回调函数
     * @param {number} delay - 延迟时间
     */
    setTimeout(name, callback, delay) {
        // 清除同名现有超时
        this.clearTimeout(name);

        const timeoutId = setTimeout(() => {
            this.timeouts.delete(name);
            callback();
        }, delay);

        this.timeouts.set(name, timeoutId);
        return timeoutId;
    }

    /**
     * 清除命名超时
     * @param {string} name - 超时名称
     */
    clearTimeout(name) {
        const timeoutId = this.timeouts.get(name);
        if (timeoutId) {
            clearTimeout(timeoutId);
            this.timeouts.delete(name);
        }
    }

    /**
     * 设置页面生命周期处理
     */
    setupLifecycleHandlers() {
        // 页面卸载处理 - 使用AbortController管理
        const unloadController = this.createController('pageUnload');
        window.addEventListener('beforeunload', () => {
            if (unloadController.signal.aborted) return;

            try {
                // 真正离开页面时才清理所有缓存
                blobUrlManager.cleanupAll();
                // 清理页面状态缓存
                saveLazyLoadState(window.location.hash);
                // 清理所有事件监听器 - 防止内存泄漏
                eventManager.destroy();
                mainLogger.debug('页面卸载，完成缓存和事件清理');
            } catch (error) {
                mainLogger.warn('页面卸载清理失败', error);
            }
        }, { signal: unloadController.signal });

        // 页面可见性处理 - 使用AbortController管理
        const visibilityController = this.createController('visibility');
        document.addEventListener('visibilitychange', () => {
            if (visibilityController.signal.aborted) return;

            this.handleVisibilityChange();
        }, { signal: visibilityController.signal });
    }

    /**
     * 处理页面可见性变化
     */
    handleVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            this.pageHiddenTime = Date.now();
            this.isPageReallyHidden = false;

            // 使用命名超时管理延迟清理，避免竞态条件
            this.setTimeout('pageHideCleanup', () => {
                if (document.visibilityState === 'hidden' && !this.isPageReallyHidden) {
                    this.isPageReallyHidden = true;
                    mainLogger.debug('页面长时间隐藏，开始清理部分缓存');

                    try {
                        // 只清理过期缓存，不清理所有缓存
                        blobUrlManager.cleanupExpired();
                        // 保存当前页面状态以便恢复
                        saveLazyLoadState(window.location.hash);
                    } catch (error) {
                        mainLogger.warn('页面隐藏清理失败', error);
                    }
                }
            }, 10000); // 10秒后开始清理

        } else {
            // 页面重新可见 - 取消延迟清理
            this.isPageReallyHidden = false;
            this.clearTimeout('pageHideCleanup');

            // 只有在页面曾经被隐藏过时才计算隐藏时长
            if (this.pageHiddenTime > 0) {
                const hiddenDuration = Date.now() - this.pageHiddenTime;

                if (hiddenDuration < 30000) {
                    mainLogger.debug('页面短暂隐藏，保持缓存');
                } else {
                    mainLogger.debug('页面长时间隐藏后重新可见', { hiddenDuration });
                    // 可以在这里添加缓存预热逻辑
                }
            }

            // 重置隐藏时间，避免后续错误计算
            this.pageHiddenTime = 0;
        }
    }

    /**
     * 清理所有异步操作
     */
    cleanup() {
        mainLogger.debug('清理异步操作管理器');

        // 取消所有控制器
        for (const [name, controller] of this.controllers) {
            if (!controller.signal.aborted) {
                controller.abort();
            }
        }
        this.controllers.clear();

        // 清除所有超时
        for (const [name, timeoutId] of this.timeouts) {
            clearTimeout(timeoutId);
        }
        this.timeouts.clear();

        // 重置状态
        this.pageHiddenTime = 0;
        this.isPageReallyHidden = false;
    }

    /**
     * 获取会话ID
     */
    getSessionId() {
        return this.pageSessionId;
    }
}

// 创建全局异步操作管理器实例
const asyncOperationManager = new AsyncOperationManager();

// 应用启动入口
document.addEventListener('DOMContentLoaded', initializeApp);
