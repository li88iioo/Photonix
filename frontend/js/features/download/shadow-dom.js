/**
 * @file shadow-dom.js
 * @description Shadow DOM封装管理器 - 实现下载服务的完全隔离
 * 
 * 功能:
 * - 创建和管理Shadow DOM容器
 * - 封装样式和DOM结构
 * - 处理跨边界事件传播
 * - 提供兼容性降级方案
 */

let shadowHost = null;
let shadowRoot = null;
let shadowSupported = null;

/**
 * 检测浏览器是否支持Shadow DOM
 * @returns {boolean} 是否支持
 */
function isShadowDOMSupported() {
  if (shadowSupported !== null) return shadowSupported;
  
  shadowSupported = Boolean(
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    'attachShadow' in Element.prototype &&
    'getRootNode' in Element.prototype
  );
  
  return shadowSupported;
}

/**
 * 创建或获取Shadow DOM主机元素
 * @returns {HTMLElement} Shadow主机元素
 */
function ensureShadowHost() {
  if (shadowHost && document.body.contains(shadowHost)) {
    return shadowHost;
  }

  // 查找现有的主机元素
  const existing = document.getElementById('download-shadow-host');
  if (existing) {
    shadowHost = existing;
    if (existing.shadowRoot) {
      shadowRoot = existing.shadowRoot;
    }
    return shadowHost;
  }

  // 创建新的主机元素
  const host = document.createElement('div');
  host.id = 'download-shadow-host';
  host.className = 'download-shadow-host';
  
  // 主机元素的最小样式（必须在light DOM中）
  host.style.cssText = `
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 80;
    display: none;
    pointer-events: none;
  `;

  document.body.appendChild(host);
  shadowHost = host;

  console.log('[Shadow DOM] 主机元素已创建');
  return host;
}

/**
 * 创建或获取Shadow Root
 * @param {boolean} force - 强制重新创建
 * @returns {ShadowRoot|HTMLElement} Shadow root或降级容器
 */
function ensureShadowRoot(force = false) {
  const host = ensureShadowHost();

  // 如果已存在且不强制重建，直接返回
  if (!force && shadowRoot) {
    return shadowRoot;
  }

  // 检查浏览器支持
  if (!isShadowDOMSupported()) {
    console.warn('[Shadow DOM] 浏览器不支持Shadow DOM，使用降级方案');
    // 降级：直接返回host元素作为容器
    shadowRoot = host;
    return shadowRoot;
  }

  // 如果shadowRoot已存在，先清空
  if (host.shadowRoot) {
    shadowRoot = host.shadowRoot;
    shadowRoot.innerHTML = '';
    console.log('[Shadow DOM] 已清空现有Shadow Root');
    return shadowRoot;
  }

  // 创建新的Shadow Root
  try {
    shadowRoot = host.attachShadow({ mode: 'open' });
    console.log('[Shadow DOM] Shadow Root已创建（mode: open）');
  } catch (error) {
    console.error('[Shadow DOM] 创建Shadow Root失败:', error);
    // 降级：使用host元素
    shadowRoot = host;
  }

  return shadowRoot;
}

/**
 * 将内容注入Shadow DOM
 * @param {string} htmlContent - HTML内容
 * @param {string} cssContent - CSS内容
 */
function injectContent(htmlContent, cssContent) {
  const root = ensureShadowRoot();
  
  if (!root) {
    console.error('[Shadow DOM] 无法获取Shadow Root');
    return;
  }

  // 构建完整的Shadow DOM内容
  const content = `
    <style>
      /* Shadow DOM 内部样式重置 */
      :host {
        all: initial;
        display: block;
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        left: 0;
        z-index: 80;
        contain: layout style paint;
      }
      
      /* 注入的CSS */
      ${cssContent}
    </style>
    
    <!-- 注入的HTML -->
    ${htmlContent}
  `;

  root.innerHTML = content;
  console.log('[Shadow DOM] 内容已注入');
}

/**
 * 显示Shadow DOM容器
 */
function showShadow() {
  if (shadowHost) {
    shadowHost.style.display = 'block';
    shadowHost.style.pointerEvents = 'auto';
  }
}

/**
 * 隐藏Shadow DOM容器
 */
function hideShadow() {
  if (shadowHost) {
    shadowHost.style.display = 'none';
    shadowHost.style.pointerEvents = 'none';
  }
}

/**
 * 在Shadow DOM内部查询元素
 * @param {string} selector - CSS选择器
 * @returns {Element|null} 找到的元素
 */
function queryShadow(selector) {
  if (!shadowRoot) return null;
  
  try {
    return shadowRoot.querySelector(selector);
  } catch (error) {
    console.warn('[Shadow DOM] 查询失败:', selector, error);
    return null;
  }
}

/**
 * 在Shadow DOM内部查询所有元素
 * @param {string} selector - CSS选择器
 * @returns {NodeList} 元素列表
 */
function queryShadowAll(selector) {
  if (!shadowRoot) return [];
  
  try {
    return shadowRoot.querySelectorAll(selector);
  } catch (error) {
    console.warn('[Shadow DOM] 批量查询失败:', selector, error);
    return [];
  }
}

/**
 * 获取Shadow Root
 * @returns {ShadowRoot|HTMLElement|null} Shadow root或降级容器
 */
function getShadowRoot() {
  return shadowRoot;
}

/**
 * 销毁Shadow DOM
 */
function destroyShadow() {
  if (shadowRoot && shadowRoot.innerHTML) {
    shadowRoot.innerHTML = '';
  }
  
  if (shadowHost && shadowHost.parentNode) {
    shadowHost.parentNode.removeChild(shadowHost);
  }

  shadowRoot = null;
  shadowHost = null;
  
  console.log('[Shadow DOM] 已销毁');
}

/**
 * 检查是否处于Shadow DOM模式
 * @returns {boolean} 是否使用Shadow DOM
 */
function isInShadowMode() {
  return shadowRoot !== null && isShadowDOMSupported();
}

/**
 * 添加全局事件监听器（跨Shadow DOM边界）
 * @param {string} eventType - 事件类型
 * @param {Function} handler - 事件处理器
 * @param {Object} options - 选项（包括signal）
 */
function addGlobalEventListener(eventType, handler, options = {}) {
  // 在document上监听（会穿透Shadow DOM）
  document.addEventListener(eventType, (event) => {
    // 检查事件是否来自Shadow DOM内部
    const composedPath = event.composedPath ? event.composedPath() : [event.target];
    const isFromShadow = composedPath.some(node => 
      shadowRoot && (node === shadowRoot || shadowRoot.contains(node))
    );
    
    if (isFromShadow || !shadowRoot) {
      handler(event);
    }
  }, options);
}

export {
  isShadowDOMSupported,
  ensureShadowHost,
  ensureShadowRoot,
  injectContent,
  showShadow,
  hideShadow,
  queryShadow,
  queryShadowAll,
  getShadowRoot,
  destroyShadow,
  isInShadowMode,
  addGlobalEventListener
};
