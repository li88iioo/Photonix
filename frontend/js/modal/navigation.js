/**
 * @file frontend/js/modal/navigation.js
 * @description 管理模态框导航时的进度显示和模糊效果
 */

import { elements } from '../shared/dom-elements.js';
const navigationProgress = { showTimer: null };
const navigationBlur = { overlay: null, hideTimer: null, showTimer: null, resizeHandler: null };

/**
 * 设置导航进度（预留接口，当前由 setNavigationBlurProgress 替代）。
 * @stub 保留此空实现以兼容现有调用点，未来可扩展为独立进度指示器
 * @param {number} [_value] - 进度值 0-1（当前未使用）
 * @returns {void}
 */
export function setNavigationProgress(_value) {
  // 空实现：功能已由 setNavigationBlurProgress 承担
}

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
  } catch { }
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
    Object.assign(blur.overlay.style, {
      top: `${metrics.top}px`,
      left: `${metrics.left}px`,
      width: `${metrics.width}px`,
      height: `${metrics.height}px`
    });
    if (metrics.borderRadius) {
      blur.overlay.style.borderRadius = metrics.borderRadius;
      blur.overlay.style.clipPath = `inset(0 round ${metrics.borderRadius})`;
    } else {
      blur.overlay.style.borderRadius = '';
      blur.overlay.style.clipPath = '';
    }
  } else if (elements.mediaPanel) {
    Object.assign(blur.overlay.style, {
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
          blur.overlay.style.borderRadius = radius;
          blur.overlay.style.clipPath = `inset(0 round ${radius})`;
        } else {
          blur.overlay.style.borderRadius = '';
          blur.overlay.style.clipPath = '';
        }
      } catch { }
    } else {
      blur.overlay.style.borderRadius = '';
      blur.overlay.style.clipPath = '';
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
  Object.assign(overlay.style, { display: 'none' });
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
  blur.overlay?.classList.remove('forward');
  blur.overlay?.classList.remove('backward');
  const orientation = direction === 'backward' ? 'backward' : 'forward';
  blur.overlay.dataset.direction = orientation;
  blur.overlay?.classList.add(orientation);
  if (blur.hideTimer) {
    clearTimeout(blur.hideTimer);
    blur.hideTimer = null;
  }
  if (blur.showTimer) {
    clearTimeout(blur.showTimer);
    blur.showTimer = null;
  }
  Object.assign(blur.overlay.style, {
    display: 'block',
    transform: 'scaleX(0.001)',
    opacity: '0',
    backdropFilter: 'blur(18px) brightness(1.18)',
    WebkitBackdropFilter: 'blur(18px) brightness(1.18)',
    boxShadow: `${orientation === 'backward' ? -16 : 16}px 0 28px rgba(0, 0, 0, 0.28)`
  });
  blur.overlay?.classList.add('visible');
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

  blur.overlay.style.transform = `scaleX(${eased})`;
  blur.overlay.style.opacity = `${opacity}`;
  const filterValue = `blur(${blurAmount}px) brightness(${brightness})`;
  blur.overlay.style.backdropFilter = filterValue;
  blur.overlay.style.WebkitBackdropFilter = filterValue;
  blur.overlay.style.boxShadow = `${shadowOffset}px 0 ${shadowSpread}px rgba(0, 0, 0, ${shadowOpacity})`;
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
    } catch { }
    blur.resizeHandler = null;
  }
  if (immediate) {
    if (blur.hideTimer) {
      clearTimeout(blur.hideTimer);
      blur.hideTimer = null;
    }
    blur.overlay?.classList.remove('visible');
    Object.assign(blur.overlay.style, {
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
  blur.overlay?.classList.remove('visible');
  if (blur.hideTimer) clearTimeout(blur.hideTimer);
  blur.hideTimer = setTimeout(() => {
    Object.assign(blur.overlay.style, {
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
