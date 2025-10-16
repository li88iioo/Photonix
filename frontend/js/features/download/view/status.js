import { safeClassList } from '../../../shared/dom-utils.js';
import { getRootElement } from './root.js';

export function setLoading(isLoading) {
  const rootEl = getRootElement();
  if (!rootEl) return;
  const loadingEl = rootEl.querySelector('[data-role="download-loading"]');
  if (!loadingEl) return;
  safeClassList(loadingEl, isLoading ? 'remove' : 'add', 'hidden');
  safeClassList(rootEl, isLoading ? 'add' : 'remove', 'is-loading');
}

export function setError(hasError) {
  const rootEl = getRootElement();
  if (!rootEl) return;
  const errorEl = rootEl.querySelector('[data-role="download-error"]');
  if (!errorEl) return;
  safeClassList(errorEl, hasError ? 'remove' : 'add', 'hidden');
}

// 页面顶部已去除状态徽标，保留函数以兼容旧调用
export function setServiceStatus() {}
