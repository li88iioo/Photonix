/**
 * @file frontend/js/main.js
 * @description 应用主入口，负责初始化前端各核心模块
 */

import { state, clearExpiredAlbumTombstones } from './core/state.js';
import { initializeAuth, showLoginScreen, getAuthToken, removeAuthToken, checkAuthStatus } from './app/auth.js';
import { fetchSettings, clearAuthHeadersCache } from './app/api.js';
import { showMinimalLoader } from './features/gallery/loading-states.js';
import { showNotification } from './shared/utils.js';
import { initializeSSE } from './app/sse.js';
import { setupEventListeners } from './features/gallery/listeners.js';
import { initializeRouter } from './app/router.js';
import { blobUrlManager, savePageLazyState, restorePageLazyState, clearRestoreProtection } from './features/gallery/lazyload.js';
import { initializeUI } from './features/gallery/ui.js';
import { UI } from './core/constants.js';
import { createModuleLogger } from './core/logger.js';
import { safeSetInnerHTML, safeGetElementById, safeQuerySelector, safeClassList } from './shared/dom-utils.js';
import { eventManager } from './core/event-manager.js';

const mainLogger = createModuleLogger('Main');

let appStarted = false;

/**
 * 显示首页快捷键提示（仅首次访问）
 */
function showGalleryShortcutsHint() {
    // 移动端不显示
    if (window.innerWidth <= 768) return;

    // 检查是否已经显示过
    const hasShown = localStorage.getItem('hasShownGalleryShortcuts');
    if (hasShown) return;

    // 等待页面完全加载后显示
    setTimeout(() => {
        const hintEl = document.getElementById('gallery-shortcuts-hint');
        if (!hintEl) return;

        safeClassList(hintEl, 'add', 'show');

        // 标记已显示，下次不再显示
        try {
            localStorage.setItem('hasShownGalleryShortcuts', 'true');
        } catch (e) {
            mainLogger.warn('无法保存快捷键提示状态', e);
        }

        // 6秒后自动隐藏（动画会处理）
        setTimeout(() => {
            safeClassList(hintEl, 'remove', 'show');
        }, 6000);
    }, 1500); // 延迟1.5秒，让用户先看到页面内容
}

/**
 * 生成与 frontend/assets/icon.svg 相同的 SVG，并设置为 favicon（运行时注入，避免静态依赖）
 */
function applyAppIcon() {
    const svg = `<svg width="32" height="32" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <defs>
                                    <linearGradient id="logo-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                                        <stop offset="0%" style="stop-color:#a78bfa;stop-opacity:1"></stop>
                                        <stop offset="70%" style="stop-color:#f472b6;stop-opacity:1"></stop>
                                        <stop offset="100%" style="stop-color:#f87171;stop-opacity:1"></stop>
                                    </linearGradient>
                                </defs>
                                <path fill="url(#logo-gradient)" d="M50,0 C77.61,0 100,22.39 100,50 C100,77.61 77.61,100 50,100 C22.39,100 0,77.61 0,50 C0,22.39 22.39,0 50,0 Z M50,15 C30.67,15 15,30.67 15,50 C15,69.33 30.67,85 50,85 C69.33,85 85,69.33 85,50 C85,30.67 69.33,15 50,15 Z M62.5,25 L37.5,25 L37.5,50 L62.5,50 C69.4,50 75,44.4 75,37.5 C75,30.6 69.4,25 62.5,25 Z"></path>
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
 * 统一的 UI 状态机，管理应用、登录、错误等不同视图状态的切换
 * @param {'app'|'login'|'error'} nextState - 目标状态
 * @param {object} [options] - 附加选项
 */
function setUIState(nextState, options = {}) {
    const app = safeGetElementById('app-container');
    const overlay = safeGetElementById('auth-overlay');

    /**
     * 隐藏认证遮罩层
     */
    const hideOverlay = () => {
        if (!overlay) return;
        safeClassList(overlay, 'remove', 'opacity-100');
        safeClassList(overlay, 'add', 'opacity-0');
        safeClassList(overlay, 'add', 'pointer-events-none');
    };
    /**
     * 显示认证遮罩层
     */
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
    try { clearExpiredAlbumTombstones(); } catch { }
    // 注入与静态文件一致的 SVG 图标，避免启动时找不到 /assets 时的 404
    try { applyAppIcon(); } catch { }
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
        if (authContainer) {
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

    showMinimalLoader({ text: '初始化中...' });
    initializeSSE();
    initializeUI();

    try {
        initializeRouter();
    } catch (e) {
        mainLogger.error('路由器加载失败', e);
    }
    loadAppSettings();

    // 显示首页快捷键提示（仅首次访问，仅PC端）
    showGalleryShortcutsHint();

    // 🔧 修复问题2：网络状态通知去抖，避免移动设备/内网穿透环境频繁提示
    let offlineNotificationTimer = null;
    let wasOfflineNotified = false;

    window.addEventListener('offline', () => {
        // 延迟3秒后才显示通知，避免短暂断连误报
        if (offlineNotificationTimer) clearTimeout(offlineNotificationTimer);
        offlineNotificationTimer = setTimeout(() => {
            if (!navigator.onLine) { // 再次确认确实断开
                showNotification('网络连接不稳定', 'warning', UI.NOTIFICATION_DURATION_WARNING);
                wasOfflineNotified = true;
            }
        }, 3000);
    });

    window.addEventListener('online', () => {
        // 清除待显示的offline通知
        if (offlineNotificationTimer) {
            clearTimeout(offlineNotificationTimer);
            offlineNotificationTimer = null;
        }
        // 只有之前显示过断开通知，才显示恢复通知
        if (wasOfflineNotified) {
            showNotification('网络已恢复', 'success', UI.NOTIFICATION_DURATION_SUCCESS);
            wasOfflineNotified = false;
        }
    });

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
            // 清除 API 缓存中的认证头，避免使用过时的认证信息
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

        state.batchUpdate({
            aiEnabled: (localAI.AI_ENABLED !== undefined) ? (localAI.AI_ENABLED === 'true') : (clientSettings.AI_ENABLED === 'true'),
            passwordEnabled: clientSettings.PASSWORD_ENABLED === 'true',
            albumDeletionEnabled: Boolean(clientSettings.albumDeletionEnabled),
            adminSecretConfigured: Boolean(clientSettings.isAdminSecretConfigured)
        });
    } catch (e) {
        mainLogger.warn("无法获取应用设置，使用默认配置", e);

        state.batchUpdate({
            aiEnabled: false,
            passwordEnabled: false,
            albumDeletionEnabled: false,
            adminSecretConfigured: false
        });
    }
}

/**
 * Service Worker 注册
 */
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

function initializeLifecycleGuards() {
    const pageSessionId = Date.now().toString();
    sessionStorage.setItem('pageSessionId', pageSessionId);
    mainLogger.debug('初始化异步操作管理器', { sessionId: pageSessionId });

    let pageHiddenTime = 0;
    let hideCleanupTimeout = null;
    let isPageReallyHidden = false;

    window.addEventListener('beforeunload', () => {
        try {
            blobUrlManager.cleanupAll();
            savePageLazyState(window.location.hash);
            eventManager.destroy();
            mainLogger.debug('页面卸载，完成缓存和事件清理');
        } catch (error) {
            mainLogger.warn('页面卸载清理失败', error);
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            pageHiddenTime = Date.now();
            isPageReallyHidden = false;

            if (hideCleanupTimeout) {
                clearTimeout(hideCleanupTimeout);
            }

            hideCleanupTimeout = setTimeout(() => {
                if (document.visibilityState === 'hidden' && !isPageReallyHidden) {
                    isPageReallyHidden = true;
                    mainLogger.debug('页面长时间隐藏，开始清理部分缓存');
                    try {
                        blobUrlManager.cleanupExpired();
                        savePageLazyState(window.location.hash);
                    } catch (error) {
                        mainLogger.warn('页面隐藏清理失败', error);
                    }
                }
            }, 10000);
        } else {
            isPageReallyHidden = false;
            if (hideCleanupTimeout) {
                clearTimeout(hideCleanupTimeout);
                hideCleanupTimeout = null;
            }

            if (pageHiddenTime > 0) {
                const hiddenDuration = Date.now() - pageHiddenTime;
                if (hiddenDuration < 30000) {
                    mainLogger.debug('页面短暂隐藏，保持缓存');
                } else {
                    mainLogger.debug('页面长时间隐藏后重新可见', { hiddenDuration });
                }
            }

            pageHiddenTime = 0;
        }
    });
}

initializeLifecycleGuards();

/**
 * 应用启动入口
 */
document.addEventListener('DOMContentLoaded', initializeApp);
