/**
 * @file frontend/js/modal/navigation.js
 * @description 管理模态框导航时的进度显示和模糊效果
 */

import { elements } from '../shared/dom-elements.js';
import { safeSetStyle, safeClassList } from '../shared/dom-utils.js';

const navigationProgress = { showTimer: null };
const navigationBlur = { overlay: null, hideTimer: null, showTimer: null, resizeHandler: null };

/**
 * 设置导航进度（占位，预留未来扩展）。
 * @function
 * @returns {void}
 */
export function setNavigationProgress() {}

/**
 * 获取媒体面板的度量信息。
 * @function
 * @private
 * @returns {Object|null} 返回媒体面板的度量信息对象，若无法获取则返回 null
 */
function getMediaPanelMetrics() {
  if (!elements.mediaPanel || !elements.modalImg) return null;
  const panelRect = elements.mediaPanel.getBoundingClientRect ? elements.mediaPanel.getBoundingClientRect() : null;
  const imgRect = elements.modalImg.getBoundingClientRect ? elements.modalImg.getBoundingClientRect() : null;
  if (!panelRect || !imgRect) return null;
  if (!imgRect.width || !imgRect.height) return null;
  let borderRadius = '';
  try {
    const computed = window.getComputedStyle(elements.modalImg);
    borderRadius = computed && computed.borderRadius ? computed.borderRadius : '';
  } catch {}
  return {
    width: imgRect.width,
    height: imgRect.height,
    top: imgRect.top - panelRect.top,
    left: imgRect.left - panelRect.left,
    borderRadius
  };
}

/**
 * 定位导航模糊覆盖层，使其与媒体面板或图片对齐。
 * @function
 * @private
 * @returns {void}
 */
function positionNavigationBlurOverlay() {
  const blur = navigationBlur;
  if (!blur.overlay) return;
  const metrics = getMediaPanelMetrics();
  if (metrics) {
    safeSetStyle(blur.overlay, {
      top: `${metrics.top}px`,
      left: `${metrics.left}px`,
      width: `${metrics.width}px`,
      height: `${metrics.height}px`
    });
    if (metrics.borderRadius) {
      safeSetStyle(blur.overlay, 'borderRadius', metrics.borderRadius);
      safeSetStyle(blur.overlay, 'clipPath', `inset(0 round ${metrics.borderRadius})`);
    } else {
      safeSetStyle(blur.overlay, 'borderRadius', '');
      safeSetStyle(blur.overlay, 'clipPath', '');
    }
  } else if (elements.mediaPanel) {
    safeSetStyle(blur.overlay, {
      top: '0px',
      left: '0px',
      width: '100%',
      height: '100%'
    });
    if (elements.modalImg) {
      try {
        const computed = window.getComputedStyle(elements.modalImg);
        const radius = computed && computed.borderRadius ? computed.borderRadius : '';
        if (radius) {
          safeSetStyle(blur.overlay, 'borderRadius', radius);
          safeSetStyle(blur.overlay, 'clipPath', `inset(0 round ${radius})`);
        } else {
          safeSetStyle(blur.overlay, 'borderRadius', '');
          safeSetStyle(blur.overlay, 'clipPath', '');
        }
      } catch {}
    } else {
      safeSetStyle(blur.overlay, 'borderRadius', '');
      safeSetStyle(blur.overlay, 'clipPath', '');
    }
  }
}

/**
 * 确保导航模糊覆盖层已创建并添加到 DOM。
 * @function
 * @private
 * @returns {Object|null} 返回导航模糊对象，若无 mediaPanel 则返回 null
 */
function ensureNavigationBlurOverlay() {
  if (!elements.mediaPanel) return null;
  if (navigationBlur.overlay && navigationBlur.overlay.isConnected) {
    return navigationBlur;
  }
  const overlay = document.createElement('div');
  overlay.className = 'modal-blur-overlay';
  safeSetStyle(overlay, { display: 'none' });
  elements.mediaPanel.appendChild(overlay);
  navigationBlur.overlay = overlay;
  navigationBlur.hideTimer = null;
  navigationBlur.showTimer = null;
  navigationBlur.resizeHandler = null;
  return navigationBlur;
}

/**
 * 显示导航模糊覆盖层。
 * @function
 * @private
 * @param {string} [direction='forward'] - 导航方向，可选值 'forward' 或 'backward'
 * @returns {void}
 */
function showNavigationBlurOverlay(direction = 'forward') {
  const blur = ensureNavigationBlurOverlay();
  if (!blur || !blur.overlay) return;
  positionNavigationBlurOverlay();
  safeClassList(blur.overlay, 'remove', 'forward');
  safeClassList(blur.overlay, 'remove', 'backward');
  const orientation = direction === 'backward' ? 'backward' : 'forward';
  blur.overlay.dataset.direction = orientation;
  safeClassList(blur.overlay, 'add', orientation);
  if (blur.hideTimer) {
    clearTimeout(blur.hideTimer);
    blur.hideTimer = null;
  }
  if (blur.showTimer) {
    clearTimeout(blur.showTimer);
    blur.showTimer = null;
  }
  safeSetStyle(blur.overlay, {
    display: 'block',
    transform: 'scaleX(0.001)',
    opacity: '0',
    backdropFilter: 'blur(18px) brightness(1.18)',
    WebkitBackdropFilter: 'blur(18px) brightness(1.18)',
    boxShadow: `${orientation === 'backward' ? -16 : 16}px 0 28px rgba(0, 0, 0, 0.28)`
  });
  safeClassList(blur.overlay, 'add', 'visible');
  if (!blur.resizeHandler) {
    blur.resizeHandler = () => positionNavigationBlurOverlay();
    window.addEventListener('resize', blur.resizeHandler);
  }
}

/**
 * 设置导航模糊进度。
 * @function
 * @param {number} value - 进度值，范围 0-1
 * @returns {void}
 */
export function setNavigationBlurProgress(value) {
  const blur = navigationBlur;
  if (!blur.overlay) return;
  if (!blur.overlay.classList.contains('visible')) return;
  positionNavigationBlurOverlay();
  const ratio = Math.max(0, Math.min(1, value));
  const eased = Math.min(1, Math.max(0.001, ratio));
  const directionFactor = blur.overlay.dataset.direction === 'backward' ? -1 : 1;
  const opacity = 0.2 + eased * 0.7;
  const blurAmount = 18 + (1 - eased) * 6;
  const brightness = 1.15 - eased * 0.15;
  const shadowSpread = 28 - eased * 10;
  const shadowOffset = directionFactor * Math.max(0, (1 - eased) * 18);
  const shadowOpacity = Math.min(0.52, 0.32 + (1 - eased) * 0.24);

  safeSetStyle(blur.overlay, 'transform', `scaleX(${eased})`);
  safeSetStyle(blur.overlay, 'opacity', `${opacity}`);
  const filterValue = `blur(${blurAmount}px) brightness(${brightness})`;
  safeSetStyle(blur.overlay, 'backdropFilter', filterValue);
  safeSetStyle(blur.overlay, 'WebkitBackdropFilter', filterValue);
  safeSetStyle(blur.overlay, 'boxShadow', `${shadowOffset}px 0 ${shadowSpread}px rgba(0, 0, 0, ${shadowOpacity})`);
}

/**
 * 隐藏导航模糊覆盖层。
 * @function
 * @private
 * @param {boolean} [immediate=false] - 是否立即隐藏
 * @returns {void}
 */
function hideNavigationBlurOverlay(immediate = false) {
  const blur = navigationBlur;
  if (blur.showTimer) {
    clearTimeout(blur.showTimer);
    blur.showTimer = null;
  }
  if (!blur.overlay) return;
  if (blur.resizeHandler) {
    try {
      window.removeEventListener('resize', blur.resizeHandler);
    } catch {}
    blur.resizeHandler = null;
  }
  if (immediate) {
    if (blur.hideTimer) {
      clearTimeout(blur.hideTimer);
      blur.hideTimer = null;
    }
    safeClassList(blur.overlay, 'remove', 'visible');
    safeSetStyle(blur.overlay, {
      display: 'none',
      transform: 'scaleX(0)',
      opacity: '0',
      backdropFilter: 'blur(0px) brightness(1)',
      WebkitBackdropFilter: 'blur(0px) brightness(1)',
      boxShadow: 'none',
      clipPath: '',
      borderRadius: ''
    });
    return;
  }
  safeClassList(blur.overlay, 'remove', 'visible');
  if (blur.hideTimer) clearTimeout(blur.hideTimer);
  blur.hideTimer = setTimeout(() => {
    safeSetStyle(blur.overlay, {
      display: 'none',
      transform: 'scaleX(0)',
      opacity: '0',
      backdropFilter: 'blur(0px) brightness(1)',
      WebkitBackdropFilter: 'blur(0px) brightness(1)',
      boxShadow: 'none',
      clipPath: '',
      borderRadius: ''
    });
    blur.hideTimer = null;
  }, 220);
}

/**
 * 调度导航进度条的显示。
 * @function
 * @param {string|null} [direction=null] - 导航方向，可选
 * @param {number} [delay=180] - 延迟显示时间（毫秒）
 * @returns {void}
 */
export function scheduleNavigationProgressBar(direction = null, delay = 180) {
  if (navigationProgress.showTimer) {
    clearTimeout(navigationProgress.showTimer);
    navigationProgress.showTimer = null;
  }
  if (navigationBlur.showTimer) {
    clearTimeout(navigationBlur.showTimer);
    navigationBlur.showTimer = null;
  }
  const timer = setTimeout(() => {
    navigationProgress.showTimer = null;
    navigationBlur.showTimer = null;
    if (direction) {
      showNavigationBlurOverlay(direction);
    }
  }, delay);
  navigationProgress.showTimer = timer;
  navigationBlur.showTimer = timer;
}

/**
 * 隐藏导航进度条并清理模糊效果。
 * @function
 * @param {boolean} [immediate=false] - 是否立即隐藏
 * @returns {void}
 */
export function hideNavigationProgressBar(immediate = false) {
  if (navigationProgress.showTimer) {
    clearTimeout(navigationProgress.showTimer);
    navigationProgress.showTimer = null;
  }
  if (navigationBlur.showTimer) {
    clearTimeout(navigationBlur.showTimer);
    navigationBlur.showTimer = null;
  }
  setNavigationProgress(1);
  setNavigationBlurProgress(1);
  hideNavigationBlurOverlay(immediate);
}
