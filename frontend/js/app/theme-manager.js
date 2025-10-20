/**
 * @file frontend/js/app/theme-manager.js
 * @description 运行时主题管理：支持 Light/Dark/Auto，维护 <meta name="theme-color"> 与 PWA manifest 的颜色
 */

import { createModuleLogger } from '../core/logger.js';

const themeLogger = createModuleLogger('Theme');

// 存储键与常量
const STORAGE_KEY_MODE = 'photonix:theme:mode';
const DEFAULT_MODE = 'light'; // 首次运行默认 Light（即使系统为暗色）

// 主题颜色（与 index.html 与 manifest.json 的默认值保持一致）
const THEME_COLORS = {
  light: {
    themeColor: '#f9fafb',
    backgroundColor: '#f9fafb'
  },
  dark: {
    themeColor: '#111827',
    backgroundColor: '#111827'
  }
};

let currentMode = DEFAULT_MODE; // 'light' | 'dark' | 'auto'
let currentResolved = 'light'; // 实际应用的主题：'light'|'dark'
let mediaQueryList = null; // matchMedia 对象
let currentManifestObjectUrl = null; // Blob URL 用于释放

// 页面上下文（用于让全局主题在必要时排除某些视图，如下载页）
function getPageContext() {
  try {
    return document.documentElement.dataset.page || 'gallery';
  } catch {
    return 'gallery';
  }
}

export function setPageContext(page) {
  try {
    const value = String(page || 'gallery');
    if (document?.documentElement) {
      document.documentElement.dataset.page = value;
    }
    const event = new CustomEvent('page:change', { detail: { page: value } });
    window.dispatchEvent(event);
  } catch (e) {
    themeLogger.warn('设置页面上下文失败', e);
  }
}

function safeGetStoredMode() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MODE);
    if (!raw) return null;
    const val = String(raw).toLowerCase();
    if (val === 'light' || val === 'dark' || val === 'auto') return val;
    return null;
  } catch (e) {
    themeLogger.warn('读取本地主题设置失败', e);
    return null;
  }
}

function safeSetStoredMode(mode) {
  try {
    localStorage.setItem(STORAGE_KEY_MODE, String(mode));
  } catch (e) {
    themeLogger.warn('保存本地主题设置失败', e);
  }
}

function prefersDark() {
  try {
    if (!window.matchMedia) return false;
    if (!mediaQueryList) {
      mediaQueryList = window.matchMedia('(prefers-color-scheme: dark)');
    }
    return !!mediaQueryList.matches;
  } catch (e) {
    themeLogger.warn('访问 matchMedia 失败，降级为浅色', e);
    return false;
  }
}

function resolveTheme(mode) {
  if (mode === 'dark') return 'dark';
  if (mode === 'auto') return prefersDark() ? 'dark' : 'light';
  return 'light';
}

function ensureMetaThemeColor(color) {
  try {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', color);
  } catch (e) {
    themeLogger.warn('更新 meta theme-color 失败', e);
  }
}

async function rebuildManifestForTheme(resolvedTheme) {
  // 仅当浏览器支持 Blob URL 与 <link rel="manifest"> 时尝试运行时替换
  try {
    let link = document.querySelector('link[rel="manifest"]');
    if (!link) {
      link = document.createElement('link');
      link.setAttribute('rel', 'manifest');
      document.head.appendChild(link);
    }

    // 尝试获取现有 manifest 内容，以最大程度保留字段
    let manifest = null;
    try {
      const resp = await fetch('/manifest.json', { cache: 'no-store' });
      if (resp.ok) {
        manifest = await resp.json();
      }
    } catch (e) {
      themeLogger.debug('获取 manifest.json 失败，使用内置模板', e);
    }

    if (!manifest || typeof manifest !== 'object') {
      manifest = {
        name: 'Photonix',
        short_name: 'Photonix',
        start_url: '.',
        display: 'standalone',
        background_color: THEME_COLORS[resolvedTheme].backgroundColor,
        theme_color: THEME_COLORS[resolvedTheme].themeColor,
        icons: [
          { src: '/assets/icon.svg', sizes: '192x192 512x512', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      };
    } else {
      manifest = { ...manifest };
      manifest.background_color = THEME_COLORS[resolvedTheme].backgroundColor;
      manifest.theme_color = THEME_COLORS[resolvedTheme].themeColor;
    }

    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
    if (currentManifestObjectUrl) {
      try { URL.revokeObjectURL(currentManifestObjectUrl); } catch {}
      currentManifestObjectUrl = null;
    }
    currentManifestObjectUrl = URL.createObjectURL(blob);
    link.setAttribute('href', currentManifestObjectUrl);
  } catch (e) {
    themeLogger.warn('运行时重建 manifest 失败', e);
  }
}

function applyResolvedTheme(resolvedTheme) {
  currentResolved = resolvedTheme === 'dark' ? 'dark' : 'light';
  try {
    if (document?.documentElement) {
      document.documentElement.dataset.theme = currentResolved;
    }
  } catch {}

  // 更新浏览器 UI 颜色
  const colors = THEME_COLORS[currentResolved] || THEME_COLORS.dark;
  ensureMetaThemeColor(colors.themeColor);
  // 尝试更新 PWA manifest，使安装后的外观一致
  rebuildManifestForTheme(currentResolved);

  // 派发主题变更事件（UI 控件可订阅）
  try {
    const event = new CustomEvent('theme:change', {
      detail: {
        mode: currentMode,
        resolved: currentResolved
      }
    });
    window.dispatchEvent(event);
  } catch {}
}

function setupAutoModeListener() {
  try {
    if (!window.matchMedia) return;
    if (!mediaQueryList) mediaQueryList = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (currentMode === 'auto') {
        applyResolvedTheme(resolveTheme('auto'));
      }
    };
    // 兼容 addEventListener 与 addListener
    if (mediaQueryList.addEventListener) {
      mediaQueryList.addEventListener('change', handler);
    } else if (mediaQueryList.addListener) {
      mediaQueryList.addListener(handler);
    }
  } catch (e) {
    themeLogger.warn('注册系统主题监听失败', e);
  }
}

export function setThemeMode(mode) {
  const next = (mode || '').toLowerCase();
  const valid = next === 'light' || next === 'dark' || next === 'auto' ? next : DEFAULT_MODE;
  currentMode = valid;
  safeSetStoredMode(valid);
  try {
    const event = new CustomEvent('theme:mode', { detail: { mode: valid } });
    window.dispatchEvent(event);
  } catch {}
  applyResolvedTheme(resolveTheme(valid));
}

export function getThemeMode() {
  return currentMode;
}

export function getResolvedTheme() {
  return currentResolved;
}

export function initializeThemeManager() {
  // 初始化页面上下文，默认 gallery
  setPageContext(getPageContext());

  // 初始化主题模式
  const stored = safeGetStoredMode();
  currentMode = stored || DEFAULT_MODE;

  // 初始应用主题
  applyResolvedTheme(resolveTheme(currentMode));

  // 设置 Auto 监听
  setupAutoModeListener();

  themeLogger.info('主题管理器已初始化', { mode: currentMode, resolved: currentResolved });
}
