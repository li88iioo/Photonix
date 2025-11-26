/**
 * @file auth.js
 * @module 认证管理
 * @description 负责用户认证、登录界面、初始设置和令牌管理
 */

import { elements } from '../shared/dom-elements.js';
import { initializeRouter } from './router.js';
import { clearAuthHeadersCache } from './api.js';
import { createModuleLogger } from '../core/logger.js';
import { safeSetInnerHTML, safeGetElementById, safeSetStyle, safeClassList, safeQuerySelector } from '../shared/dom-utils.js';
import { AUTH, SW_MESSAGE } from '../core/constants.js';

const authLogger = createModuleLogger('Auth');

/**
 * 通知 Service Worker 执行相关操作
 * @param {Object} message - 要发送给 Service Worker 的消息对象
 */
function notifyServiceWorker(message) {
    try {
        if (!('serviceWorker' in navigator)) return;
        const controller = navigator.serviceWorker && navigator.serviceWorker.controller;
        if (controller) {
            controller.postMessage(message);
        }
    } catch (error) {
        authLogger.debug('通知 Service Worker 失败', { error: error && error.message });
    }
}

/**
 * 清除存储的认证token
 * 用于token失效、注销等场景
 */
export function clearAuthToken() {
    try {
        localStorage.removeItem('photonix_auth_token');
        authLogger.debug('认证token已清除');

        // 通知 Service Worker 清除token
        notifyServiceWorker({
            type: SW_MESSAGE.CLEAR_TOKEN
        });
    } catch (error) {
        authLogger.warn('清除token失败', { error: error && error.message });
    }
}

/**
 * 初始化用户认证
 * 检查本地存储中的用户ID，如果不存在则生成新的UUID
 * @returns {string} 用户的唯一ID
 */
export function initializeAuth() {
    let userId = localStorage.getItem('userId');
    if (!userId) {
        const generateUUID = () => (window.crypto && window.crypto.randomUUID)
            ? window.crypto.randomUUID()
            : Date.now().toString(36) + Math.random().toString(36).substring(2);
        userId = generateUUID();
        localStorage.setItem('userId', userId);
    }
    return userId;
}

/**
 * 检查后端的认证状态
 * @returns {Promise<{passwordEnabled: boolean}>} 认证状态对象
 */
export async function checkAuthStatus() {
    // 添加超时控制，避免长时间等待
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 超时时间15秒

    try {
        const token = getAuthToken();
        const headers = {};
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch('/api/auth/status', {
            signal: controller.signal,
            headers
        });

        clearTimeout(timeoutId);

        if (response.status === 401 && token) {
            authLogger.warn('Token无效或已过期，自动清除并重试');
            clearAuthToken();  // 清除无效token
            clearAuthHeadersCache();  // 清除API缓存

            // 重新请求，不带token
            try {
                const retryResponse = await fetch('/api/auth/status');
                if (!retryResponse.ok) {
                    if (retryResponse.status === 404) {
                        return { passwordEnabled: false };
                    }
                    throw new Error(`Auth status check failed: ${retryResponse.status}`);
                }
                return await retryResponse.json();
            } catch (retryError) {
                authLogger.error('重试认证状态检查失败', retryError);
                throw retryError;
            }
        }

        if (!response.ok) {
            // 对于404或500错误，默认返回密码未启用（首次部署时数据库可能未初始化）
            if (response.status === 404 || response.status === 500) {
                authLogger.warn(`认证状态检查返回 ${response.status}，默认密码未启用`);
                return { passwordEnabled: false };
            }
            throw new Error(`Could not fetch auth status: ${response.status}`);
        }
        const result = await response.json();
        // 确保返回的对象有 passwordEnabled 属性
        return {
            passwordEnabled: result && typeof result.passwordEnabled === 'boolean' 
                ? result.passwordEnabled 
                : false
        };
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            authLogger.warn('认证状态检查超时，使用默认设置');
            return { passwordEnabled: false };
        }
        throw error;
    }
}

/**
 * 显示登录界面
 * 渲染登录表单并设置背景图片
 */
export function showLoginScreen() {
    const authOverlay = safeGetElementById('auth-overlay');
    const authContainer = safeGetElementById('auth-container');
    const authBackground = safeGetElementById('auth-background');

    // 重置背景样式
    safeSetStyle(authBackground, 'backgroundImage', '');
    safeClassList(authBackground, 'remove', 'opacity-50');

    // XSS安全修复：对静态HTML模板进行安全检查
    const loginTemplate = `
    <div class="relative w-full max-w-[340px] p-6 transition-all duration-500 transform animate-fade-in-up">
        <!-- Header -->
        <div class="relative flex flex-col items-center justify-center mb-10 text-center z-10">
             <h1 class="text-4xl text-white mb-2" style="font-family: 'ZCOOL KuaiLe', sans-serif; text-shadow: 0 4px 12px rgba(0,0,0,0.3);">
                登录到 Photonix
             </h1>
             <p class="text-xs text-white/50 font-light tracking-wider uppercase">Private Gallery Access</p>
        </div>

        <!-- Form -->
        <form id="login-form" class="relative space-y-6 z-10">
            <input type="text" name="username" autocomplete="username" hidden aria-hidden="true">
            
            <!-- Password Input -->
            <div class="group relative">
                <div class="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none transition-colors duration-300">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-white/40 group-focus-within:text-white/90" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                </div>
                <input type="password" id="password" 
                    class="w-full py-3 pl-11 pr-11 bg-white/10 border-0 rounded-xl text-white placeholder-white/30 focus:ring-1 focus:ring-white/30 focus:bg-white/20 transition-all duration-300 backdrop-blur-md shadow-inner text-base" 
                    placeholder="请输入访问密码" required autocomplete="current-password">
                
                <span class="password-toggle-icon absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white cursor-pointer transition-colors duration-200 p-2 rounded-full hover:bg-white/10">
                    <svg class="eye-open w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                    <svg class="eye-closed w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" style="display: none;"><path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                </span>
            </div>

            <!-- Button -->
            <button type="submit" class="w-full py-3 bg-transparent text-white/80 font-medium rounded-xl hover:text-white transition-all duration-300 text-lg tracking-wide flex items-center justify-center gap-2 group">
                <span>立即进入</span>
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 transform group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
            </button>
            
            <p id="login-error" class="text-red-300 text-center text-xs min-h-[1.25rem] font-medium drop-shadow-md animate-pulse"></p>
        </form>
    </div>
    `;

    // 安全检查：确保模板不包含危险内容
    if (!/<script|javascript:|vbscript:|on\w+\s*=|javascript\s*:|data\s*:|vbscript\s*:/i.test(loginTemplate)) {
        safeSetInnerHTML(authContainer, loginTemplate);
    } else {
        authLogger.error('检测到登录模板中的潜在安全风险');
        return;
    }

    // 立即显示登录遮罩层
    safeClassList(authOverlay, 'remove', 'opacity-0');
    safeClassList(authOverlay, 'remove', 'pointer-events-none');
    safeClassList(authOverlay, 'add', 'opacity-100');

    // 改进的背景图片加载机制
    loadBackgroundWithRetry(authBackground);

    safeGetElementById('login-form').addEventListener('submit', handleLogin);
    setupPasswordToggle();
}

/**
 * 处理登录表单提交
 * @param {Event} e - 表单提交事件
 * @returns {Promise<void>}
 */
async function handleLogin(e) {
    e.preventDefault();
    const password = safeGetElementById('password').value;
    const errorEl = safeGetElementById('login-error');
    const loginButton = e.target.querySelector('button');
    const originalButtonText = loginButton.textContent;
    let reenableTimer = null;

    // 重置错误信息并设置加载状态
    errorEl.textContent = '';
    loginButton.disabled = true;
    loginButton.textContent = '登录中...';

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const data = await response.json();

        if (!response.ok || !data.success) {
            // 登录失败时的抖动动画效果
            const loginCard = safeQuerySelector('.login-card');
            if (loginCard) {
                safeClassList(loginCard, 'remove', 'shake');
                void loginCard.offsetWidth;
                safeClassList(loginCard, 'add', 'shake');
                loginCard.addEventListener('animationend', () => {
                    safeClassList(loginCard, 'remove', 'shake');
                }, { once: true });
            }
            // 根据后端返回的 code/状态映射中文提示
            let msg = '登录失败';
            if (response.status === 401 && (data.code === 'INVALID_CREDENTIALS')) {
                if (typeof data.remainingAttempts === 'number' && typeof data.nextLockSeconds === 'number') {
                    if (data.remainingAttempts > 0) {
                        msg = `密码错误，还可再尝试 ${data.remainingAttempts} 次（再错将锁定 ${Math.max(1, Math.round(data.nextLockSeconds / 60))} 分钟）`;
                    } else {
                        msg = '密码错误';
                    }
                } else {
                    msg = '密码错误';
                }
            } else if (response.status === 429 && (data.code === 'LOGIN_LOCKED' || data.code === 'TOO_MANY_REQUESTS')) {
                const seconds = data.retryAfterSeconds || Number(response.headers.get('Retry-After')) || null;
                if (seconds && Number.isFinite(seconds) && seconds > 0 && seconds < 24 * 3600) {
                    let remain = seconds;
                    const tick = () => {
                        const mins = Math.ceil(remain / 60);
                        errorEl.textContent = `尝试过于频繁，请在 ${mins} 分钟后重试（${remain} s）`;
                        if (remain <= 0) {
                            loginButton.disabled = false;
                            loginButton.textContent = originalButtonText;
                            if (reenableTimer) clearInterval(reenableTimer);
                        }
                        remain -= 1;
                    };
                    tick();
                    reenableTimer = setInterval(tick, 1000);
                    msg = '';
                } else {
                    msg = data.message || '尝试过于频繁，请稍后重试';
                }
            } else if (response.status === 400 && data.code === 'PASSWORD_DISABLED') {
                msg = '密码访问未开启';
            } else if (response.status === 400 && data.code === 'VALIDATION_ERROR') {
                msg = '密码格式不正确';
            } else if (data && (data.message || data.error)) {
                msg = data.message || data.error;
            }
            errorEl.textContent = msg;
            if (!reenableTimer) {
                loginButton.disabled = false;
                loginButton.textContent = originalButtonText;
            }
            return;
        }

        // 登录成功，保存令牌并隐藏登录界面
        setAuthToken(data.token);

        const authOverlay = safeGetElementById('auth-overlay');
        safeClassList(authOverlay, 'remove', 'opacity-100');
        safeClassList(authOverlay, 'add', 'opacity-0');
        safeClassList(authOverlay, 'add', 'pointer-events-none');

        const appContainer = safeGetElementById('app-container');
        safeClassList(appContainer, 'add', 'opacity-100');

        // 清除任何加载状态
        if (elements.contentGrid) {
            safeSetInnerHTML(elements.contentGrid, '');
        }

        initializeRouter();

    } catch (error) {
        errorEl.textContent = error && error.message ? error.message : '登录失败';
        loginButton.disabled = false;
        loginButton.textContent = originalButtonText;
    }
}

// ================= 辅助函数 =================

/**
 * 设置密码输入框的显示/隐藏切换
 */
function setupPasswordToggle() {
    const icon = safeQuerySelector('.password-toggle-icon');
    const input = safeGetElementById('password');

    if (!icon || !input) {
        authLogger.warn('密码切换元素未找到');
        return;
    }

    const openEye = icon.querySelector('.eye-open');
    const closedEye = icon.querySelector('.eye-closed');

    // 初始化眼睛图标状态
    safeSetStyle(openEye, 'display', 'block');
    safeSetStyle(closedEye, 'display', 'none');

    icon.addEventListener('click', (e) => {
        e.stopPropagation();

        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';

        safeSetStyle(openEye, 'display', isPassword ? 'none' : 'block');
        safeSetStyle(closedEye, 'display', isPassword ? 'block' : 'none');

        // 点击时的视觉反馈
        const originalColor = icon.style.color;
        safeSetStyle(icon, 'color', 'white');

        setTimeout(() => {
            safeSetStyle(icon, 'color', originalColor || '');
        }, 200);
    });
}

/**
 * 设置设置页面的开关事件监听
 */
export function setupSettingsToggles() {
    const aiEnabledToggle = safeGetElementById('ai-enabled');
    const passwordEnabledToggle = safeGetElementById('password-enabled');

    if (aiEnabledToggle) {
        aiEnabledToggle.addEventListener('change', (e) => toggleAIFields(e.target.checked));
    }
    if (passwordEnabledToggle) {
        passwordEnabledToggle.addEventListener('change', (e) => togglePasswordFields(e.target.checked));
    }
}

/**
 * 切换AI相关字段的显示状态
 * @param {boolean} isEnabled - 是否启用AI功能
 */
export function toggleAIFields(isEnabled) {
    const fields = safeGetElementById('ai-fields');
    if (fields) safeSetStyle(fields, 'display', isEnabled ? 'block' : 'none');
}

/**
 * 切换密码相关字段的显示状态
 * @param {boolean} isEnabled - 是否启用密码功能
 */
export function togglePasswordFields(isEnabled) {
    const fields = safeGetElementById('password-fields');
    if (fields) safeSetStyle(fields, 'display', isEnabled ? 'block' : 'none');
}

/**
 * 保存认证令牌到本地存储
 * @param {string} token - 认证令牌
 * @returns {void}
 */
export function setAuthToken(token) {
    localStorage.setItem(AUTH.TOKEN_KEY, token);
    clearAuthHeadersCache(); // 清除认证头缓存
    notifyServiceWorker({ type: SW_MESSAGE.CLEAR_API_CACHE, scope: 'all' });
}

/**
 * 从本地存储获取认证令牌
 * @returns {string|null} 认证令牌
 */
export function getAuthToken() {
    return localStorage.getItem(AUTH.TOKEN_KEY);
}

/**
 * 从本地存储移除认证令牌
 * @returns {void}
 */
export function removeAuthToken() {
    localStorage.removeItem(AUTH.TOKEN_KEY);
    clearAuthHeadersCache(); // 清除认证头缓存
    notifyServiceWorker({ type: SW_MESSAGE.CLEAR_API_CACHE, scope: 'all' });
}

/**
 * 获取随机封面图片URL（用于登录界面的背景图片）
 * @returns {Promise<string|null>} 随机封面URL
 */
export async function getRandomCoverUrl() {
    try {
        return '/api/login-bg';
    } catch {
        return null;
    }
}

/**
 * 从本地存储获取缓存的封面列表
 * @returns {Array<string>|null} 缓存的封面URL数组
 */
function getCachedCovers() {
    try {
        const cached = localStorage.getItem('cached_covers');
        if (!cached) return null;

        const data = JSON.parse(cached);
        const now = Date.now();

        // 检查缓存是否过期（24小时）
        if (data.timestamp && (now - data.timestamp) < 24 * 60 * 60 * 1000) {
            return data.covers;
        }

        // 缓存过期，清除
        localStorage.removeItem('cached_covers');
        return null;
    } catch (error) {
        return null;
    }
}

/**
 * 缓存封面列表到本地存储
 * @param {Array<string>} covers - 封面URL数组
 * @returns {void}
 */
function cacheCovers(covers) {
    try {
        const data = {
            covers: covers,
            timestamp: Date.now()
        };
        localStorage.setItem('cached_covers', JSON.stringify(data));
    } catch (error) {
        // 静默处理缓存错误
    }
}

/**
 * 带重试机制的背景图片加载
 * @param {HTMLElement} authBackground - 背景元素
 * @returns {Promise<void>}
 */
async function loadBackgroundWithRetry(authBackground) {
    const maxRetries = 2; // 最大重试次数
    const retryDelay = 500; // 重试延迟(ms)

    // 立即显示备用背景，不等待图片加载
    useFallbackBackground(authBackground);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const backgroundUrl = await getRandomCoverUrl();
            if (backgroundUrl) {
                // 异步预加载图片，不阻塞UI
                preloadImage(backgroundUrl).then(() => {
                    safeSetStyle(authBackground, 'backgroundImage', `url(${backgroundUrl})`);
                    safeClassList(authBackground, 'remove', 'fallback');
                    safeClassList(authBackground, 'add', 'opacity-50');
                }).catch((error) => {
                    // 预加载失败，保持备用背景
                    authLogger.debug('背景图片预加载失败，使用备用背景', { error: error.message });
                    // 可在此添加用户友好提示
                });
                return;
            }
        } catch (error) {
            // 静默处理加载错误，但记录日志
            authLogger.debug('背景图片加载失败', { error: error.message });
        }

        // 如果不是最后一次尝试，等待后重试
        if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        }
    }

    // 所有尝试都失败，保持备用背景
    authLogger.debug('背景图片加载失败，使用备用背景');
}

/**
 * 预加载图片
 * @param {string} url - 图片URL
 * @returns {Promise<void>} 图片加载Promise
 */
function preloadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`图片加载失败: ${url} `));
        img.src = url;
    });
}

/**
 * 使用备用背景方案
 * @param {HTMLElement} authBackground - 背景元素
 * @returns {void}
 */
function useFallbackBackground(authBackground) {
    // 清除之前的背景图片
    safeSetStyle(authBackground, 'backgroundImage', '');
    // 添加备用背景类
    safeClassList(authBackground, 'add', 'fallback');
    safeClassList(authBackground, 'add', 'opacity-50');
}