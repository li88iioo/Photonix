import { safeSetInnerHTML } from '../../../shared/dom-utils.js';
import { getRootElement } from './root.js';
import {
  sanitize,
  formatBytes,
  formatLogTimestamp,
  buildLogScope
} from './utils.js';

export function renderLogs(entries) {
  const rootEl = getRootElement();
  if (!rootEl) return;
  const container = rootEl.querySelector('[data-role="log-container"]');
  if (!container) return;

  if (!entries || !entries.length) {
    safeSetInnerHTML(container, '<div class="empty-state">暂无日志。</div>');
    return;
  }

  const items = entries.slice(0, 200).map((entry) => {
    const rawLevel = String(entry?.level || entry?.severity || 'info').toLowerCase();
    const levelClass = ['info', 'success', 'warning', 'error'].includes(rawLevel) ? rawLevel : 'info';
    const levelLabel = sanitize(levelClass.toUpperCase());
    const timestampValue = entry?.timestamp || entry?.time || entry?.date || new Date().toISOString();
    const timestamp = sanitize(formatLogTimestamp(timestampValue));
    const scope = sanitize(buildLogScope(entry));
    let messageRaw = entry?.message || entry?.msg || '';
    if (!messageRaw && entry?.line) {
      const segments = String(entry.line).split(' - ');
      messageRaw = segments.length >= 4 ? segments.slice(3).join(' - ') : entry.line;
    }
    if (!messageRaw && entry?.meta && Object.keys(entry.meta).length) {
      try {
        messageRaw = JSON.stringify(entry.meta);
      } catch {
        messageRaw = '';
      }
    }
    const message = messageRaw ? sanitize(messageRaw) : '<span class="log-empty">—</span>';
    const meta = entry?.meta || {};
    const detailParts = [];
    if (meta.size) {
      detailParts.push(`大小 ${formatBytes(meta.size)}`);
    }
    if (meta.durationMs) {
      const duration = Math.round(Number(meta.durationMs));
      if (!Number.isNaN(duration) && duration > 0) {
        detailParts.push(`耗时 ${duration}ms`);
      }
    }
    if (meta.imageUrl) {
      detailParts.push(meta.imageUrl);
    }
    const detailsHtml = detailParts.length
      ? `<div class="log-details">${detailParts.map((part) => `<span>${sanitize(part)}</span>`).join('<span class="log-divider">·</span>')}</div>`
      : '';

    return `
      <div class="log-entry level-${levelClass}">
        <div class="log-header"><span>${timestamp}</span><span class="log-level">${levelLabel}</span></div>
        <div class="log-message"><span class="log-scope">${scope}</span><span class="log-text">${message}</span></div>
        ${detailsHtml}
      </div>
    `;
  });

  safeSetInnerHTML(container, items.join(''));
}
