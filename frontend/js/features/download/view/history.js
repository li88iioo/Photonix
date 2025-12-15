import { safeSetInnerHTML } from '../../../shared/dom-utils.js';
import { getRootElement } from './root.js';
import { sanitize, formatBytes, formatRelativeTime } from './utils.js';

export function renderHistory(entries) {
  const rootEl = getRootElement();
  if (!rootEl) return;
  const list = rootEl.querySelector('[data-role="history-list"]');
  if (!list) return;

  if (!entries || !entries.length) {
    safeSetInnerHTML(list, '<div class="empty-state">暂无符合条件的历史记录。</div>');
    return;
  }

  const cards = entries.slice(0, 60).map((entry, index) => {
    const title = sanitize(entry?.title || entry?.filename || `历史记录 ${index + 1}`);
    const feed = sanitize(entry?.feed || entry?.source || '未知来源');
    const size = formatBytes(entry?.size || entry?.bytes || 0);
    const completed = formatRelativeTime(entry?.completedAt || entry?.finishedAt || entry?.timestamp);
    const status = sanitize(entry?.status || '已完成');
    const imageCount = entry?.imageCount || entry?.images?.length || 0;
    return `
      <div class="history-card">
        <h4>${title}</h4>
        <div class="history-meta">
          <span>来源：${feed}</span>
          <span>文件大小：${size} · 下载图片：${imageCount} 张</span>
          <span>状态：${status}</span>
          <span>完成时间：${completed}</span>
        </div>
      </div>
    `;
  });

  safeSetInnerHTML(list, cards.join(''));
}
