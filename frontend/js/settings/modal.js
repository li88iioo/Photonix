/**
 * @file frontend/js/settings/modal.js
 * @description 提供设置模态框的关闭与清理逻辑
 */

import settingsContext from './context.js';
import { safeSetInnerHTML } from '../shared/dom-utils.js';

/**
 * 关闭设置模态框并清理内容。
 * @returns {void}
 */
export function closeSettingsModal() {
  const { modal, card } = settingsContext;
  if (!modal || !card) return;

  modal?.classList.remove('visible');
  document.body?.classList.remove('settings-open');
  modal.addEventListener('transitionend', () => {
    safeSetInnerHTML(card, '');
  }, { once: true });
}
