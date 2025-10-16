import { safeSetInnerHTML, safeSetStyle } from '../../../shared/dom-utils.js';
import {
  iconEdit,
  iconEye,
  iconStop,
  iconPlay,
  iconClose
} from '../../../shared/svg-utils.js';
import { applyInteractiveEffects } from './effects.js';
import { IncrementalList } from '../../../shared/incremental-update.js';
import { enhancedTaskTable } from './enhanced-table.js';
import {
  sanitize,
  formatNumber,
  formatBytes,
  formatRelativeTime,
  formatSchedule,
  deriveTaskId,
  formatTaskStatus,
  buildSmoothPath
} from './utils.js';
import { getRootElement } from './root.js';

const ICON_MORE = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="4.5" cy="10" r="1.5" fill="currentColor"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/><circle cx="15.5" cy="10" r="1.5" fill="currentColor"/></svg>';

// 全局渲染器实例（queueListView 和 recentListView 保留，taskListView 由 enhancedTaskTable 管理）
let queueListView = null;
let recentListView = null;

function renderMetricTrend(key, samples = [], { formatter = (value) => String(value) } = {}) {
  const rootEl = getRootElement();
  if (!rootEl) return;
  const container = rootEl.querySelector(`[data-trend="${key}"]`);
  if (!container) return;
  if (!Array.isArray(samples) || samples.length === 0) {
    safeSetInnerHTML(container, '<div class="trend-placeholder">暂无数据</div>');
    return;
  }

  const width = 140;
  const height = 48;
  const slice = samples.slice(-40);
  const values = slice.map((item) => Number(item?.value || 0));
  const hasSinglePoint = values.length === 1;
  const safeValues = hasSinglePoint ? [values[0], values[0]] : values;
  const min = Math.min(...safeValues);
  const max = Math.max(...safeValues);
  const range = max - min || 1;
  const points = (hasSinglePoint ? [values[0], values[0]] : values).map((value, index, arr) => {
    const denominator = Math.max(arr.length - 1, 1);
    const x = (index / denominator) * width;
    const y = height - ((value - min) / range) * height;
    return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : height];
  });
  const linePath = buildSmoothPath(points);
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;

  const latestEntry = slice[slice.length - 1] || { value: 0 };
  const firstEntry = slice[0] || latestEntry;
  const diffValue = (latestEntry?.value ?? 0) - (firstEntry?.value ?? 0);
  const diffMagnitude = Math.abs(diffValue);
  const formattedDiff = formatter(diffMagnitude);
  const diffLabel = diffValue === 0 ? '持平' : `${diffValue > 0 ? '+' : '-'}${formattedDiff}`;
  const trendState = diffValue > 0 ? 'up' : diffValue < 0 ? 'down' : 'flat';
  const latestLabel = formatter(latestEntry?.value ?? 0);

  const colorMap = {
    tasks: '#60a5fa',
    articles: '#f97316',
    images: '#22d3ee',
    storage: '#34d399'
  };
  const stroke = colorMap[key] || '#c084fc';

  const svg = `
    <svg class="trend-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="trend-${key}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="${stroke}" stop-opacity="0.35" />
          <stop offset="100%" stop-color="${stroke}" stop-opacity="0" />
        </linearGradient>
      </defs>
      <path class="trend-area" d="${areaPath}" fill="url(#trend-${key})"></path>
      <path class="trend-line" d="${linePath}" stroke="${stroke}" />
    </svg>
  `;

  safeSetInnerHTML(container, `
    <div class="trend-meta">
      <span class="trend-value" data-trend-state="${trendState}">${sanitize(latestLabel)}</span>
      <span class="trend-diff">${sanitize(diffLabel)}</span>
    </div>
    ${svg}
  `);
}

export function renderMetrics({ tasks, status, metrics }, history = {}) {
  const rootEl = getRootElement();
  if (!rootEl) return;
  const totalTasks = Array.isArray(tasks) ? tasks.length : 0;
  const activeTasks = Array.isArray(tasks) ? tasks.filter((task) => (task?.status || '').toLowerCase() === 'running').length : 0;
  const aggregated = metrics || {};
  const imagesDownloaded = Number(
    aggregated.imagesDownloaded ?? status?.tasks?.imagesDownloaded ?? status?.imagesDownloaded ?? 0
  );
  const articlesDownloaded = Number(
    aggregated.articlesDownloaded ?? status?.tasks?.articlesDownloaded ?? status?.articlesDownloaded ?? 0
  );
  const storageBytes = Number(
    aggregated.storageBytes ?? status?.storage?.bytes ?? status?.storageBytes ?? 0
  );
  const storageFormatted = aggregated.storageFormatted
    || status?.storage?.formatted
    || formatBytes(storageBytes);

  const metricValues = {
    tasks: `${formatNumber(totalTasks)} / ${formatNumber(activeTasks)}`,
    articles: formatNumber(articlesDownloaded),
    images: formatNumber(imagesDownloaded),
    storage: sanitize(storageFormatted)
  };

  Object.entries(metricValues).forEach(([key, value]) => {
    const el = rootEl.querySelector(`[data-metric="${key}"]`);
    if (el) {
      safeSetInnerHTML(el, value || '-');
    }
  });

  renderMetricTrend('tasks', history.tasks);
  renderMetricTrend('articles', history.articles);
  renderMetricTrend('images', history.images);
  renderMetricTrend('storage', history.storage, { formatter: formatBytes });
}

export function renderQueue(tasks) {
  const rootEl = getRootElement();
  if (!rootEl) return;
  const queueList = rootEl.querySelector('[data-role="queue-list"]');
  const progressLabel = rootEl.querySelector('[data-role="queue-progress-label"]');
  const progressBar = rootEl.querySelector('[data-role="queue-progress"]');
  const percentLabel = rootEl.querySelector('[data-role="queue-progress-percent"]');
  if (!queueList || !progressLabel || !progressBar || !percentLabel) return;

  const taskList = Array.isArray(tasks) ? tasks : [];
  const running = taskList.filter((task) => (task?.status || '').toLowerCase() === 'running');
  const total = taskList.length;
  const percent = total > 0 ? Math.round((running.length / total) * 100) : 0;
  const runningCount = sanitize(String(running.length));
  const totalCount = sanitize(String(total));
  safeSetInnerHTML(progressLabel, `${runningCount} / ${totalCount} 运行中`);
  safeSetInnerHTML(percentLabel, `${sanitize(String(percent))}%`);
  safeSetStyle(progressBar, 'width', `${percent}%`);

  const displayItems = running.slice(0, 3);

  const createQueueItem = (task, index) => {
    const title = sanitize(task.title || task.name || `任务 ${index + 1}`);
    const feed = sanitize(task.feedUrl || task.url || '未知地址');
    const stats = task.stats || {};
    const images = Number(stats.imagesDownloaded || stats.downloadedImages || task.imagesDownloaded || 0);
    const articles = Number(stats.articlesDownloaded || stats.downloadedArticles || task.articlesDownloaded || 0);
    const totalImages = Number(stats.totalImages || task.totalImages || 0);
    const imageLabel = totalImages > 0 ? `${images}/${totalImages}` : `${images}`;
    const progress = totalImages > 0 ? Math.min(100, Math.round((images / totalImages) * 100)) : (images > 0 ? 100 : 0);

    const li = document.createElement('li');
    li.className = 'queue-item';
    // 使用 safeSetInnerHTML 替代直接的 innerHTML
    safeSetInnerHTML(li, `
      <div class="info">
        <div class="title">${title}</div>
        <div class="meta">${imageLabel} 张图片 · ${articles} 篇文章 · ${feed}</div>
      </div>
      <div class="percent">${progress}%</div>
    `);
    applyInteractiveEffects(li);
    return li;
  };

  if (!queueListView) {
    queueListView = new IncrementalList({
      container: queueList,
      items: displayItems,
      getKey: (item, idx) => encodeURIComponent(deriveTaskId(item, idx)),
      renderItem: createQueueItem
    });
  } else {
    queueListView.update(displayItems);
  }

  applyInteractiveEffects(queueList);
}

export function renderRecentDownloads(entries) {
  const rootEl = getRootElement();
  if (!rootEl) return;
  const listEl = rootEl.querySelector('[data-role="recent-list"]');
  if (!listEl) return;
  const encodePath = (value = '') => value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const buildLocalUrl = (relativePath) => {
    if (!relativePath) return '';
    const normalized = String(relativePath).replace(/\\+/g, '/');
    const trimmed = normalized.replace(/^\.?\/+/, '');
    return `/static/${encodePath(trimmed)}`;
  };
  const recent = (entries || []).slice(0, 3);

  const createRecentItem = (entry, index) => {
    const title = sanitize(entry?.title || entry?.filename || `下载 ${index + 1}`);
    const feed = sanitize(entry?.feed || entry?.source || entry?.origin || '未知来源');
    const size = formatBytes(entry?.size || entry?.bytes || 0);
    const time = formatRelativeTime(entry?.completedAt || entry?.finishedAt || entry?.timestamp);
    const images = Array.isArray(entry?.images) ? entry.images : [];
    const primaryImage = images.find((image) => image && (image.url || image.path)) || null;
    const preview = entry?.cover
      || entry?.thumbnail
      || entry?.preview
      || entry?.image
      || entry?.primaryImage
      || primaryImage?.url
      || buildLocalUrl(primaryImage?.path);
    const thumb = preview
      ? `<img src="${sanitize(preview)}" alt="${title}" referrerpolicy="no-referrer">`
      : '<div class="w-[54px] h-[54px] rounded-xl bg-slate-800 flex items-center justify-center text-slate-400">🖼️</div>';

    const li = document.createElement('li');
    li.className = 'recent-card';
    // 使用 safeSetInnerHTML 替代直接的 innerHTML
    safeSetInnerHTML(li, `
      ${thumb}
      <div class="info">
        <h4>${title}</h4>
        <p>${feed} · ${time}</p>
      </div>
      <span class="size">${size}</span>
    `);
    applyInteractiveEffects(li);
    return li;
  };

  if (!recent.length) {
    if (recentListView) {
      recentListView.update([]);
    } else {
      safeSetInnerHTML(listEl, '<li class="empty-state">暂无下载记录。</li>');
    }
    return;
  }

  if (!recentListView) {
    recentListView = new IncrementalList({
      container: listEl,
      items: recent,
      getKey: (item, idx) => String(item?.id || item?.path || item?.filename || item?.timestamp || idx),
      renderItem: createRecentItem
    });
  } else {
    recentListView.update(recent);
  }
}

export function renderTaskTable(tasks) {
  const rootEl = getRootElement();
  if (!rootEl) return;
  const tbody = rootEl.querySelector('[data-role="task-table"]');
  if (!tbody) return;

  const createRowElement = (task, index) => {
    const id = deriveTaskId(task, index);
    const title = sanitize(task.title || task.name || `任务 ${index + 1}`);
    const feed = sanitize(task.feedUrl || task.url || '未知地址');
    const schedule = sanitize(formatSchedule(task));
    const statusHtml = formatTaskStatus(task);
    const stats = task.stats || {};
    const images = Number(stats.imagesDownloaded || stats.downloadedImages || task.imagesDownloaded || 0);
    const articles = Number(stats.articlesDownloaded || stats.downloadedArticles || task.articlesDownloaded || 0);
    const lastRun = formatRelativeTime(stats.lastRunAt || task.lastRunAt || task.updatedAt);
    const lastSuccess = formatRelativeTime(stats.lastSuccessAt || task.lastSuccessAt || task.lastFinishedAt);

    const encodedId = encodeURIComponent(id);
    const isRunning = (task.status || '').toLowerCase() === 'running';
    const inlineActions = `
      <button class="btn-secondary btn-icon" data-action="edit-task" data-task-id="${encodedId}" title="编辑" aria-label="编辑">${iconEdit()}</button>
      <button class="btn-secondary btn-icon" data-action="preview-task" data-task-id="${encodedId}" title="预览" aria-label="预览">${iconEye()}</button>
      ${isRunning
        ? `<button class="btn-secondary btn-icon" data-action="pause-task" data-task-id="${encodedId}" title="暂停" aria-label="暂停">${iconStop()}</button>`
        : `<button class="btn-secondary btn-icon" data-action="resume-task" data-task-id="${encodedId}" title="启动" aria-label="启动">${iconPlay()}</button>`}
      <button class="btn-secondary btn-icon" data-action="delete-task" data-task-id="${encodedId}" title="删除" aria-label="删除">${iconClose()}</button>
    `;
    const menuActions = `
      <button class="task-menu-item task-menu-icon" data-action="edit-task" data-task-id="${encodedId}" title="编辑任务" aria-label="编辑任务">${iconEdit()}<span>编辑</span></button>
      <button class="task-menu-item task-menu-icon" data-action="preview-task" data-task-id="${encodedId}" title="预览任务" aria-label="预览任务">${iconEye()}<span>预览</span></button>
      ${isRunning
        ? `<button class="task-menu-item task-menu-icon" data-action="pause-task" data-task-id="${encodedId}" title="暂停任务" aria-label="暂停任务">${iconStop()}<span>暂停</span></button>`
        : `<button class="task-menu-item task-menu-icon" data-action="resume-task" data-task-id="${encodedId}" title="启动任务" aria-label="启动任务">${iconPlay()}<span>启动</span></button>`}
      <button class="task-menu-item task-menu-icon" data-action="delete-task" data-task-id="${encodedId}" title="删除任务" aria-label="删除任务">${iconClose()}<span>删除</span></button>
    `;

    const tr = document.createElement('tr');
    tr.setAttribute('data-task-id', encodedId);
    // 使用 safeSetInnerHTML 替代直接的 innerHTML
    safeSetInnerHTML(tr, `
      <td>
        <div class="font-semibold">${title}</div>
        <div class="text-xs text-slate-400 mt-1">${feed}</div>
      </td>
      <td>${statusHtml}</td>
      <td>
        <div>${images} 张图片</div>
        <div class="text-xs text-slate-400">${articles} 篇文章</div>
      </td>
      <td>${schedule}</td>
      <td>
        <div class="text-xs text-slate-300">上次运行：${lastRun}</div>
        <div class="text-xs text-slate-500 mt-1">成功：${lastSuccess}</div>
      </td>
      <td class="text-right">
        <div class="task-actions" data-task-id="${encodedId}">
          <div class="actions-inline">${inlineActions}</div>
          <div class="actions-compact">
            <button class="btn-secondary btn-icon" data-action="toggle-task-actions" data-task-id="${encodedId}" aria-expanded="false" aria-haspopup="true" title="更多操作" aria-label="更多操作">${ICON_MORE}</button>
            <div class="task-actions-menu" data-role="task-actions-menu">
              ${menuActions}
            </div>
          </div>
        </div>
      </td>`);
    applyInteractiveEffects(tr);
    return tr;
  };

  // 使用增强的表格渲染（自动判断是否启用虚拟滚动）
  const taskCount = tasks?.length || 0;
  
  // 如果数据量超过阈值，提示用户
  if (taskCount > 100 && taskCount <= 150) {
    console.log(`[任务表格] 当前有 ${taskCount} 个任务，已启用虚拟滚动优化`);
  } else if (taskCount > 150) {
    console.warn(`[任务表格] 当前有 ${taskCount} 个任务，建议减少任务数量以获得最佳性能`);
  }
  
  // 使用增强的表格渲染
  enhancedTaskTable.render(tbody, tasks, createRowElement, applyInteractiveEffects);
}
