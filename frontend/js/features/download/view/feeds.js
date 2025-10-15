import { safeSetInnerHTML } from '../../../shared/dom-utils.js';
import { iconEye, iconEdit, iconPlay, iconStop, iconClose } from '../../../shared/svg-utils.js';
import { applyInteractiveEffects } from './effects.js';
import { getRootElement } from './root.js';
import { sanitize, formatRelativeTime, deriveTaskId } from './utils.js';
import { getSelectedFeeds } from '../state.js';

export function renderFeeds(feeds, searchTerm = '') {
  const rootEl = getRootElement();
  if (!rootEl) return;
  const grid = rootEl.querySelector('[data-role="feed-grid"]');
  if (!grid) return;
  const selectAllCheckbox = rootEl.querySelector('[data-role="feed-select-all"]');
  const actionButtons = Array.from(rootEl.querySelectorAll('[data-action^="bulk-feed"]')); 

  const list = Array.isArray(feeds) ? feeds : [];
  if (!list.length) {
    const keyword = (searchTerm || '').trim();
    const message = keyword
      ? `未找到与 “${sanitize(keyword)}” 匹配的订阅源。`
      : '暂无订阅源，请添加新的 RSS。';
    safeSetInnerHTML(grid, `<div class="empty-state">${message}</div>`);
    if (selectAllCheckbox) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    }
    actionButtons.forEach((btn) => {
      btn.disabled = true;
      btn.classList.add('bulk-disabled');
    });
    return;
  }

  const selected = new Set(getSelectedFeeds());

  const cards = list.map((feed, index) => {
    const id = deriveTaskId(feed, index);
    const encodedId = encodeURIComponent(id);
    const title = sanitize(feed.title || feed.name || `订阅源 ${index + 1}`);
    const url = sanitize(feed.feedUrl || feed.url || '未知地址');
    const enabled = feed.enabled !== false;
    const status = sanitize((feed.status || '').toUpperCase() || (enabled ? 'ACTIVE' : 'PAUSED'));
    const tags = [];
    if (feed.category) tags.push(`<span class="feed-badge">分类：${sanitize(feed.category)}</span>`);
    if (feed.excludeKeywords?.length) tags.push(`<span class="feed-badge">排除：${sanitize(feed.excludeKeywords.join('、'))}</span>`);
    const period = feed.schedule?.interval || feed.interval || feed.schedule || '未设置';
    const lastRun = formatRelativeTime(feed.lastRunAt || feed.updatedAt);
    const downloaded = Number(feed.imagesDownloaded || 0);
    const isSelected = selected.has(id);
    return `
      <article class="feed-card${isSelected ? ' has-selection' : ''}" data-feed-id="${encodedId}">
        <label class="feed-select">
          <input type="checkbox" data-role="feed-select" data-feed-id="${encodedId}" ${isSelected ? 'checked' : ''}>
        </label>
        <div class="card-header">
          <div>
            <div class="feed-title">${title}</div>
            <div class="feed-url">${url}</div>
          </div>
          <div class="feed-badge">状态：${status}</div>
        </div>
        <div class="feed-meta">
          <span>刷新周期：${sanitize(period)}</span>
          <span>已处理：${downloaded} 张图片</span>
          <span>最近更新：${lastRun}</span>
        </div>
        ${tags.length ? `<div class="feed-meta">${tags.join('')}</div>` : ''}
        <div class="feed-actions">
          <button class="btn-secondary btn-icon" data-action="preview-feed" data-feed-id="${encodedId}" title="预览" aria-label="预览">${iconEye()}</button>
          <button class="btn-secondary btn-icon" data-action="edit-feed" data-feed-id="${encodedId}" title="编辑" aria-label="编辑">${iconEdit()}</button>
          <button class="btn-secondary btn-icon" data-action="toggle-feed" data-feed-id="${encodedId}" title="${enabled ? '禁用' : '启用'}" aria-label="${enabled ? '禁用' : '启用'}">${enabled ? iconStop() : iconPlay()}</button>
          <button class="btn-secondary btn-icon" data-action="delete-feed" data-feed-id="${encodedId}" title="删除" aria-label="删除">${iconClose()}</button>
        </div>
      </article>
    `;
  });

  safeSetInnerHTML(grid, cards.join(''));
  applyInteractiveEffects(grid);

  // 更新全选状态
  if (selectAllCheckbox) {
    const selectedIds = getSelectedFeeds();
    if (list.length === 0) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    } else if (selectedIds.length === list.length) {
      selectAllCheckbox.checked = true;
      selectAllCheckbox.indeterminate = false;
    } else if (selectedIds.length === 0) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    } else {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = true;
    }
  }

  // 批量按钮启用状态
  const hasSelection = getSelectedFeeds().length > 0;
  actionButtons.forEach((btn) => {
    btn.disabled = !hasSelection;
    btn.classList.toggle('bulk-disabled', !hasSelection);
  });
}
