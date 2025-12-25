/**
 * @file frontend/js/shared/svg-templates.js
 * @description SVG图标模板集合 - 简化版
 *
 * 从 svg-utils.js (609行) 简化而来，移除工厂函数模式，使用模板常量
 *
 * 使用方式：
 * import { SVG_ICONS } from './svg-templates.js';
 * element.innerHTML = SVG_ICONS.play;
 *
 * 或直接使用函数（兼容旧代码）：
 * import { iconPlay } from './svg-templates.js';
 * element.innerHTML = iconPlay();
 */

// ========== 通用 SVG 属性常量 ==========

const INLINE_ICON_ATTRS = 'xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

/**
 * 包裹 SVG 内容生成完整标签
 * @param {string} content - SVG 内部内容
 * @param {string} className - 额外类名
 * @returns {string} 完整 SVG 字符串
 */
const wrapIcon = (content, className = '') =>
  `<svg ${INLINE_ICON_ATTRS} class="icon ${className}">${content}</svg>`;

// ========== 内联图标函数（返回 HTML 字符串） ==========

/** 播放图标 */
export const iconPlay = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M7 4v16l13 -8z"></path>',
    'icon-play'
  );

/** 停止图标 */
export const iconStop = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><rect x="5" y="5" width="14" height="14" rx="2"></rect>',
    'icon-stop'
  );

/** 可见/眼睛图标 */
export const iconEye = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><circle cx="12" cy="12" r="2"></circle><path d="M22 12c-2.667 4.667 -6 7 -10 7s-7.333 -2.333 -10 -7c2.667 -4.667 6 -7 10 -7s7.333 2.333 10 7"></path>',
    'icon-eye'
  );

/** 编辑图标 */
export const iconEdit = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M7 7h-1a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-1"></path><path d="M20.385 6.585a2.1 2.1 0 0 0 -2.97 -2.97l-8.415 8.385v3h3l8.385 -8.415z"></path><path d="M16 5l3 3"></path>',
    'icon-edit'
  );

/** 关闭/叉号图标 */
export const iconClose = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
    'icon-close'
  );

/** 下载图标 */
export const iconDownload = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"></path><polyline points="7 11 12 16 17 11"></polyline><line x1="12" y1="4" x2="12" y2="16"></line>',
    'icon-download'
  );

/** 圆形对勾图标 */
export const iconCircleCheck = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><circle cx="12" cy="12" r="9"></circle><path d="M9 12l2 2l4 -4"></path>',
    'icon-circle-check'
  );

/** 圆形叉图标 */
export const iconCircleX = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><circle cx="12" cy="12" r="9"></circle><path d="M10 10l4 4m0 -4l-4 4"></path>',
    'icon-circle-x'
  );

/** 通知图标 - 成功 */
export const iconNotificationSuccess = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;

/** 通知图标 - 错误 */
export const iconNotificationError = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;

/** 通知图标 - 警告 */
export const iconNotificationWarning = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;

/** 通知图标 - 信息 */
export const iconNotificationInfo = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;

/** GitHub 图标 */
export const iconGitHub = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>`;

/** 加号图标 */
export const iconPlus = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
    'icon-plus'
  );

/** 刷新图标 */
export const iconRefresh = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>',
    'icon-refresh'
  );

/** 柱状图图标 */
export const iconChartBar = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><line x1="3" y1="21" x2="21" y2="21"></line><line x1="5" y1="21" x2="5" y2="10"></line><line x1="9" y1="21" x2="9" y2="14"></line><line x1="13" y1="21" x2="13" y2="7"></line><line x1="17" y1="21" x2="17" y2="12"></line>',
    'icon-chart-bar'
  );

/** 设置图标 */
export const iconSettings = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><circle cx="12" cy="12" r="3"></circle>',
    'icon-settings'
  );

/** RSS图标 */
export const iconRss = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><circle cx="5" cy="19" r="1"></circle><path d="M4 4a16 16 0 0 1 16 16"></path><path d="M4 11a9 9 0 0 1 9 9"></path>',
    'icon-rss'
  );

/** 文件文本图标 */
export const iconFileText = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M14 3v4a1 1 0 0 0 1 1h4"></path><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"></path><line x1="9" y1="9" x2="10" y2="9"></line><line x1="9" y1="13" x2="15" y2="13"></line><line x1="9" y1="17" x2="15" y2="17"></line>',
    'icon-file-text'
  );

/** 导入图标 */
export const iconImport = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M12 3v12"></path><path d="M16 11l-4 4l-4 -4"></path><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"></path>',
    'icon-import'
  );

/** 导出图标 */
export const iconExport = () =>
  wrapIcon(
    '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M12 3v12"></path><path d="M16 13l-4 -4l-4 4"></path><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"></path>',
    'icon-export'
  );

// ========== 布局图标模板（返回 HTML 字符串） ==========

/** 网格布局图标 */
const GRID_ICON_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" class="block transition-transform duration-300 group-hover:scale-110 group-active:scale-90"><path d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"></path></svg>`;

/** 瀑布流布局图标 */
const MASONRY_ICON_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" class="hidden transition-transform duration-300 group-hover:scale-110 group-active:scale-90"><path d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v10a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h4a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6z"></path></svg>`;

/** 返回箭头图标 */
const BACK_ARROW_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>`;

/** 首页图标 */
const HOME_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>`;

/** 删除图标 */
const DELETE_ICON_SVG = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><line x1="9" y1="9" x2="15" y2="15"></line><line x1="15" y1="9" x2="9" y2="15"></line></svg>`;

/** 圆形进度条 */
const PROGRESS_CIRCLE_SVG = `<svg class="progress-circle" viewBox="0 0 36 36" aria-hidden="true"><circle class="progress-circle-track" cx="18" cy="18" r="16" stroke-width="4"></circle><circle class="progress-circle-bar" cx="18" cy="18" r="16" stroke-width="4"></circle></svg>`;

/** 播放按钮 */
const PLAY_BUTTON_SVG = `<svg viewBox="0 0 64 64" fill="currentColor" aria-hidden="true"><path d="M24 18v28l24-14-24-14z"></path></svg>`;

/** 排序箭头 - 升序 */
const SORT_ARROW_ASC_SVG = `<svg class="w-full h-full" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"></path></svg>`;

/** 排序箭头 - 降序 */
const SORT_ARROW_DESC_SVG = `<svg class="w-full h-full" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>`;

// ========== 兼容旧代码的函数 ==========

/**
 * 创建网格布局图标（兼容旧代码）
 * @deprecated 直接使用模板常量 GRID_ICON_SVG
 * @returns {HTMLElement} SVG DOM 元素
 */
export function createGridIconNew() {
  const div = document.createElement('div');
  div.innerHTML = GRID_ICON_SVG;
  return div.firstElementChild;
}

/**
 * 创建瀑布流布局图标（兼容旧代码）
 * @deprecated 直接使用模板常量 MASONRY_ICON_SVG
 * @returns {HTMLElement} SVG DOM 元素
 */
export function createMasonryIconNew() {
  const div = document.createElement('div');
  div.innerHTML = MASONRY_ICON_SVG;
  return div.firstElementChild;
}

/**
 * 创建返回箭头（兼容旧代码）
 * @deprecated 直接使用模板常量 BACK_ARROW_SVG
 * @returns {HTMLElement} SVG DOM 元素
 */
export function createBackArrow() {
  const div = document.createElement('div');
  div.innerHTML = BACK_ARROW_SVG;
  return div.firstElementChild;
}

/**
 * 创建首页图标（兼容旧代码）
 * @deprecated 直接使用模板常量 HOME_ICON_SVG
 * @returns {HTMLElement} SVG DOM 元素
 */
export function createHomeIcon() {
  const div = document.createElement('div');
  div.innerHTML = HOME_ICON_SVG;
  return div.firstElementChild;
}

/**
 * 创建删除图标（兼容旧代码）
 * @deprecated 直接使用模板常量 DELETE_ICON_SVG
 * @returns {HTMLElement} SVG DOM 元素
 */
export function createDeleteIcon() {
  const div = document.createElement('div');
  div.innerHTML = DELETE_ICON_SVG;
  return div.firstElementChild;
}

/**
 * 创建圆形进度条（兼容旧代码）
 * @deprecated 直接使用模板常量 PROGRESS_CIRCLE_SVG
 * @returns {HTMLElement} SVG DOM 元素
 */
export function createProgressCircle() {
  const div = document.createElement('div');
  div.innerHTML = PROGRESS_CIRCLE_SVG;
  return div.firstElementChild;
}

/**
 * 创建播放按钮（兼容旧代码）
 * @deprecated 直接使用模板常量 PLAY_BUTTON_SVG
 * @returns {HTMLElement} SVG DOM 元素
 */
export function createPlayButton() {
  const div = document.createElement('div');
  div.innerHTML = PLAY_BUTTON_SVG;
  return div.firstElementChild;
}

/**
 * 创建排序箭头（兼容旧代码）
 * @deprecated 直接使用模板常量
 * @param {boolean} isAscending - 是否升序
 * @returns {HTMLElement} SVG DOM 元素
 */
export function createSortArrow(isAscending = true) {
  const div = document.createElement('div');
  div.innerHTML = isAscending ? SORT_ARROW_ASC_SVG : SORT_ARROW_DESC_SVG;
  return div.firstElementChild;
}

/**
 * 创建网格布局图标（旧版本兼容）
 * @deprecated 使用 createGridIconNew() 或直接使用模板
 * @returns {HTMLElement} SVG DOM 元素
 */
export function createGridIcon() {
  return createGridIconNew();
}

/**
 * 创建瀑布流布局图标（旧版本兼容）
 * @deprecated 使用 createMasonryIconNew() 或直接使用模板
 * @returns {HTMLElement} SVG DOM 元素
 */
export function createMasonryIcon() {
  return createMasonryIconNew();
}

// ========== 导出模板常量供直接使用 ==========

export const SVG_TEMPLATES = {
  grid: GRID_ICON_SVG,
  masonry: MASONRY_ICON_SVG,
  backArrow: BACK_ARROW_SVG,
  home: HOME_ICON_SVG,
  delete: DELETE_ICON_SVG,
  progressCircle: PROGRESS_CIRCLE_SVG,
  playButton: PLAY_BUTTON_SVG,
  sortArrowAsc: SORT_ARROW_ASC_SVG,
  sortArrowDesc: SORT_ARROW_DESC_SVG,
};

/**
 * 便捷访问：直接使用 SVG_ICONS 对象
 * @example
 * import { SVG_ICONS } from './svg-templates.js';
 * element.innerHTML = SVG_ICONS.play();
 */
export const SVG_ICONS = {
  play: iconPlay,
  stop: iconStop,
  eye: iconEye,
  edit: iconEdit,
  close: iconClose,
  download: iconDownload,
  circleCheck: iconCircleCheck,
  circleX: iconCircleX,
  notifySuccess: iconNotificationSuccess,
  notifyError: iconNotificationError,
  notifyWarning: iconNotificationWarning,
  notifyInfo: iconNotificationInfo,
  github: iconGitHub,
};
