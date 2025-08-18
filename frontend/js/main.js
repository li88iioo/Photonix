// frontend/js/main.js

import { state, elements } from './state.js';
import { initializeAuth, showLoginScreen, getAuthToken, removeAuthToken, checkAuthStatus } from './auth.js';
import { fetchSettings } from './api.js';
import { showSkeletonGrid } from './loading-states.js';
import { showNotification } from './utils.js';
import { initializeSSE } from './sse.js';

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
    let linkEl = document.querySelector('link[rel="icon"]');
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
    const app = document.getElementById('app-container');
    const overlay = document.getElementById('auth-overlay');

    const hideOverlay = () => {
        if (!overlay) return;
        overlay.classList.remove('opacity-100');
        overlay.classList.add('opacity-0', 'pointer-events-none');
    };
    const showOverlay = () => {
        if (!overlay) return;
        overlay.classList.remove('opacity-0', 'pointer-events-none');
        overlay.classList.add('opacity-100');
    };

    switch (nextState) {
        case 'app':
            app?.classList.remove('opacity-0');
            app?.classList.add('opacity-100');
            hideOverlay();
            break;
        case 'login':
            app?.classList.remove('opacity-100');
            app?.classList.add('opacity-0');
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
        const { setupEventListeners } = await import('./listeners.js');
        setupEventListeners();
    } catch (e) {
        console.error('事件监听器加载失败:', e);
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
        console.error('应用初始化失败:', error);
        setUIState('error');
        const authContainer = document.getElementById('auth-container');
        if(authContainer) {
            authContainer.innerHTML = `
                <div class="auth-card text-center">
                    <h2 class="auth-title text-red-500">应用加载失败</h2>
                    <p class="text-gray-300">无法连接到服务器，请刷新页面重试。</p>
                    <button id="refresh-btn" class="btn btn-primary mt-4">刷新页面</button>
                    <p class="text-gray-400 text-sm mt-2">${error.message}</p>
                </div>
            `;
            document.getElementById('refresh-btn')?.addEventListener('click', () => window.location.reload());
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

    import('./router.js').then(m => m.initializeRouter()).catch(e => {
        console.error('路由器加载失败:', e);
    });
    loadAppSettings();

    // 设置全局事件监听
    window.addEventListener('offline', () => showNotification('网络已断开', 'warning', 5000));
    window.addEventListener('online', () => showNotification('网络已恢复', 'success', 3000));
    window.addEventListener('auth:required', () => {
        removeAuthToken();
        setUIState('login');
        showLoginScreen();
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
        console.warn("无法获取应用设置:", e.message);
        state.batchUpdate({ aiEnabled: false, passwordEnabled: false });
    }
}

// Service Worker 注册
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(registration => console.log('ServiceWorker 注册成功，作用域: ', registration.scope))
            .catch(err => console.log('ServiceWorker 注册失败: ', err));
    });
}

// 应用启动入口
document.addEventListener('DOMContentLoaded', initializeApp);
