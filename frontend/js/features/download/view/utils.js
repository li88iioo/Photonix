import { escapeHtml } from '../../../shared/security.js';

/**
 * 对字符串进行 HTML 转义，防止 XSS
 * @param {string|null|undefined} value
 * @returns {string}
 */
export function sanitize(value) {
  if (value === null || value === undefined) return '';
  return escapeHtml(String(value));
}

/**
 * 数字简化显示（大于一万用“万”单位）
 * @param {number|string} value
 * @returns {string}
 */
export function formatNumber(value) {
  const num = Number(value);
  if (value === undefined || value === null || Number.isNaN(num)) return '-';
  if (num >= 10000) {
    return `${Math.round(num / 1000) / 10} 万`;
  }
  return String(num);
}

/**
 * 字节数友好格式化（B/KB/MB/GB）
 * @param {number|string} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!value || Number.isNaN(value) || value <= 0) return '0 MB';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round((value / 1024) * 10) / 10} KB`;
  if (value < 1024 * 1024 * 1024) return `${Math.round((value / (1024 * 1024)) * 10) / 10} MB`;
  return `${Math.round((value / (1024 * 1024 * 1024)) * 10) / 10} GB`;
}

/**
 * 友好化的相对时间字符串
 * @param {Date|string|number} value
 * @returns {string}
 */
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

/**
 * 计划调度信息格式化
 * @param {object} task
 * @returns {string}
 */
export function formatSchedule(task) {
  if (!task) return '-';
  if (task.schedule?.cron) return `Cron: ${sanitize(task.schedule.cron)}`;
  if (task.schedule?.interval) return `间隔: ${sanitize(task.schedule.interval)}`;
  if (task.interval) return `间隔: ${sanitize(task.interval)}`;
  if (task.cron) return `Cron: ${sanitize(task.cron)}`;
  return '-';
}

/**
 * 提取任务唯一标识
 * @param {object} task
 * @param {number} fallbackIndex
 * @returns {string}
 */
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

/**
 * 任务状态格式化输出（包含 span 标记）
 * @param {object} task
 * @returns {string}
 */
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

/**
 * 日志时间戳格式化（YYYY-MM-DD HH:mm:ss）
 * @param {string|Date} value
 * @returns {string}
 */
export function formatLogTimestamp(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 构建日志作用域字符串
 * @param {object} entry
 * @returns {string}
 */
export function buildLogScope(entry) {
  const { feed, article } = extractLogContext(entry);
  const parts = [feed, article].filter(Boolean);
  if (!parts.length) return '';
  return `[${parts.join('][')}]`;
}

/**
 * 解析日志作用域字符串，返回中括号内的所有 token
 * @param {string} scope
 * @returns {Array<string>}
 */
export function parseBracketScope(scope) {
  const value = String(scope || '');
  const parts = [];
  const re = /\[([^\]]+)\]/g;
  let match;
  while ((match = re.exec(value))) {
    const token = String(match[1] || '').trim();
    if (token) parts.push(token);
  }
  return parts;
}

/**
 * 提取日志上下文信息（feed/article）
 * @param {object} entry
 * @returns {{feed: string|null, article: string|null}}
 */
export function extractLogContext(entry) {
  const meta = entry?.meta || {};

  const normalize = (value) => {
    const text = String(value || '').trim();
    return text ? text : null;
  };

  const byMetaFeed = normalize(meta.feedTitle || meta.feed || meta.source);
  const byMetaArticle = normalize(meta.article || meta.entryTitle || meta.title);

  let feed = byMetaFeed;
  let article = byMetaArticle;

  if (!feed || !article) {
    const scopeCandidates = [entry?.scope, meta.scope].filter(Boolean);
    const tokens = scopeCandidates
      .flatMap((scope) => parseBracketScope(scope))
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => !/^任务[:\s]/.test(token))
      .filter((token) => token !== '下载器' && token !== '日志管理');

    if (!feed && tokens.length) feed = tokens[0] || null;
    if (!article && tokens.length >= 2) article = tokens[1] || null;
  }

  return { feed, article };
}

/**
 * 生成平滑 SVG 路径（Cubic Bezier 曲线）
 * @param {Array<[number, number]>} points
 * @returns {string}
 */
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
