/**
 * @file frontend/js/settings/context.js
 * @description 维护设置模块共享上下文，提供元素引用与初始状态
 */


const settingsContext = {
  modal: null,
  card: null,
  template: null,
  initialSettings: {},
  modelFetchTimer: null,
  modelFetchAbortController: null,
  lastModelFetchSignature: null,
  modelList: [],
  modelListPage: 0,
  modelListListenerTarget: null,
  modelListPaginationHandler: null,
  modelDropdownInitialized: false,
  modelDropdownOpen: false,
  modelDropdownOutsideHandler: null
};

/**
 * 捕获设置模态相关的关键 DOM 元素引用。
 * @returns {typeof settingsContext} 更新后的上下文对象
 */
export function initializeContext() {
  settingsContext.modal = document.getElementById('settings-modal');
  settingsContext.card = document.getElementById('settings-card');
  settingsContext.template = document.getElementById('settings-form-template');
  return settingsContext;
}

/**
 * 覆盖设置模块的初始配置快照。
 * @param {Record<string, any>} value - 服务端返回或本地合并的设置对象
 * @returns {void}
 */
export function setInitialSettings(value) {
  settingsContext.initialSettings = value || {};
}

export default settingsContext;
