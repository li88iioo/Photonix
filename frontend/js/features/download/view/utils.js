import { escapeHtml } from '../../../shared/security.js';

export function sanitize(value) {
  if (value === null || value === undefined) return '';
  return escapeHtml(String(value));
}

export function formatNumber(value) {
  const num = Number(value);
  if (value === undefined || value === null || Number.isNaN(num)) return '-';
  if (num >= 10000) {
    return `${Math.round(num / 1000) / 10} 万`;
  }
  return String(num);
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!value || Number.isNaN(value) || value <= 0) return '0 MB';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round((value / 1024) * 10) / 10} KB`;
  if (value < 1024 * 1024 * 1024) return `${Math.round((value / (1024 * 1024)) * 10) / 10} MB`;
  return `${Math.round((value / (1024 * 1024 * 1024)) * 10) / 10} GB`;
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

export function formatSchedule(task) {
  if (!task) return '-';
  if (task.schedule?.cron) return `Cron: ${sanitize(task.schedule.cron)}`;
  if (task.schedule?.interval) return `间隔: ${sanitize(task.schedule.interval)}`;
  if (task.interval) return `间隔: ${sanitize(task.interval)}`;
  if (task.cron) return `Cron: ${sanitize(task.cron)}`;
  return '-';
}

export function deriveTaskId(task, fallbackIndex = 0) {
  const candidates = [
    task && task.id,
    task && task.taskId,
    task && task._id,
    task && task.uuid,
    task && task.slug,
    task && task.feedUrl,
    task && task.url,
    fallbackIndex ? `task-${fallbackIndex}` : null
  ];
  const found = candidates.find((value) => value !== null && value !== undefined && String(value).trim() !== '');
  return found ? String(found) : `task-${fallbackIndex}`;
}

export function formatTaskStatus(task) {
  const status = String(task?.status || task?.state || '未知').toLowerCase();
  const map = {
    running: { text: '运行中', tone: 'running' },
    paused: { text: '已暂停', tone: 'paused' },
    error: { text: '异常', tone: 'error' },
    failed: { text: '失败', tone: 'error' },
    completed: { text: '已完成', tone: 'success' }
  };
  const info = map[status] || { text: status || '未知', tone: 'default' };
  return `<span class="task-status task-${info.tone}">${sanitize(info.text)}</span>`;
}

export function formatLogTimestamp(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function buildLogScope(entry) {
  if (entry?.scope) return entry.scope;
  const meta = entry?.meta || {};
  const parts = [];
  if (meta.feedTitle || meta.feed) parts.push(meta.feedTitle || meta.feed);
  if (meta.article || meta.title) parts.push(meta.article || meta.title);
  if (!parts.length && meta.taskId) parts.push(`任务 ${meta.taskId}`);
  if (!parts.length) return '[下载器]';
  return `[${parts.join('][')}]`;
}

export function buildSmoothPath(points) {
  if (!Array.isArray(points) || points.length === 0) return '';
  if (points.length === 1) {
    const [x0, y0] = points[0];
    return `M${x0.toFixed(1)},${y0.toFixed(1)}`;
  }
  let path = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let index = 1; index < points.length; index += 1) {
    const [x, y] = points[index];
    const [prevX, prevY] = points[index - 1];
    const cp1x = prevX + (x - prevX) / 2;
    const cp1y = prevY;
    const cp2x = x - (x - prevX) / 2;
    const cp2y = y;
    path += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return path;
}
