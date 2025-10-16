/**
 * @file helpers.js
 * @description 下载模块通用工具方法
 */

export const PREVIEW_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '未处理' },
  { value: 'completed', label: '已处理' }
];

export function debounce(fn, wait = 200) {
  let timer;
  return function debounced(...args) {
    const context = this;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      fn.apply(context, args);
    }, wait);
  };
}

export function runDeferred(callback) {
  if (typeof callback !== 'function') return;
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(callback, { timeout: 300 });
  } else {
    window.setTimeout(callback, 16);
  }
}

export function splitCommaValues(value = '') {
  return String(value || '')
    .split(/[\r\n,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function splitLines(value = '') {
  return splitCommaValues(value);
}

export function splitTags(value = '') {
  return splitCommaValues(value);
}

export function formatRelativeTime(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const diff = Date.now() - date.getTime();
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  return date.toLocaleString();
}
