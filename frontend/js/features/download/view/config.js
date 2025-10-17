import { getRootElement } from './root.js';
import { formatRelativeTime } from './utils.js';

function parseJsonField(source, fallback = {}) {
  if (!source) return fallback;
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

export function updateConfigForm(config = {}) {
  const rootEl = getRootElement();
  if (!rootEl) return;
  const get = (selector) => rootEl.querySelector(`[data-field="${selector}"]`);

  const mappings = {
    'base-folder': config.baseFolder || '',
    'max-concurrent-feeds': config.maxConcurrentFeeds || '',
    'max-concurrent-downloads': config.maxConcurrentDownloads || '',
    'request-timeout': config.requestTimeout || '',
    'connect-timeout': config.connectTimeout || '',
    'read-timeout': config.readTimeout || '',
    'retry-delay': config.retryDelay || '',
    'max-retries': config.maxRetries || '',
    'pagination-min': config.paginationDelay?.[0] || '',
    'pagination-max': config.paginationDelay?.[1] || '',
    'dedup-scope': config.dedupScope || 'by_link',
    'min-bytes': config.minImageBytes || '',
    'min-width': config.minImageWidth || '',
    'min-height': config.minImageHeight || '',
    'request-headers': config.requestHeaders ? JSON.stringify(config.requestHeaders, null, 2) : '',
    'image-headers': config.imageHeaders ? JSON.stringify(config.imageHeaders, null, 2) : '',
    'skip-feeds': Array.isArray(config.skipFeeds) ? config.skipFeeds.join('\n') : ''
  };

  Object.entries(mappings).forEach(([field, value]) => {
    const el = get(field);
    if (el) el.value = value === undefined || value === null ? '' : value;
  });
  const dedupSelect = get('dedup-scope');
  if (dedupSelect) {
    dedupSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const allowFallback = get('allow-fallback');
  const validationEnabled = get('validation-enabled');
  const validationStrict = get('validation-strict');
  if (allowFallback) allowFallback.checked = Boolean(config.allowFallbackToSourceSite);
  if (validationEnabled) validationEnabled.checked = Boolean(config.imageValidation?.enabled ?? true);
  if (validationStrict) validationStrict.checked = Boolean(config.imageValidation?.strictMode ?? false);

  const resolvedBase = rootEl.querySelector('[data-role="resolved-base"]');
  const resolvedDb = rootEl.querySelector('[data-role="resolved-db"]');
  const resolvedError = rootEl.querySelector('[data-role="resolved-error"]');
  if (resolvedBase) resolvedBase.textContent = config.resolved?.baseFolder ? `已解析：${config.resolved.baseFolder}` : '';
  if (resolvedDb) resolvedDb.textContent = config.resolved?.databasePath ? `数据库：${config.resolved.databasePath}` : '';
  if (resolvedError) resolvedError.textContent = config.resolved?.errorLogPath ? `错误日志：${config.resolved.errorLogPath}` : '';

  const hintEl = rootEl.querySelector('[data-role="config-hint"]');
  if (hintEl) hintEl.textContent = config.lastUpdated ? `最近保存于 ${formatRelativeTime(config.lastUpdated)}` : '';
}

export function getConfigValues() {
  const rootEl = getRootElement();
  if (!rootEl) return {};
  const get = (selector) => rootEl.querySelector(`[data-field="${selector}"]`);

  const allowFallback = get('allow-fallback')?.checked || false;
  const validationEnabled = get('validation-enabled')?.checked || false;
  const validationStrict = get('validation-strict')?.checked || false;

  const requestHeaders = parseJsonField(get('request-headers')?.value);
  const imageHeaders = parseJsonField(get('image-headers')?.value);

  const skipFeedsRaw = get('skip-feeds')?.value || '';
  const skipFeeds = skipFeedsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const payload = {
    baseFolder: get('base-folder')?.value || '',
    allowFallbackToSourceSite: allowFallback,
    imageValidation: {
      enabled: validationEnabled,
      strictMode: validationStrict
    },
    maxConcurrentFeeds: Number(get('max-concurrent-feeds')?.value) || undefined,
    maxConcurrentDownloads: Number(get('max-concurrent-downloads')?.value) || undefined,
    requestTimeout: Number(get('request-timeout')?.value) || undefined,
    connectTimeout: Number(get('connect-timeout')?.value) || undefined,
    readTimeout: Number(get('read-timeout')?.value) || undefined,
    retryDelay: Number(get('retry-delay')?.value) || undefined,
    maxRetries: Number(get('max-retries')?.value) || undefined,
    paginationDelay: [
      Number(get('pagination-min')?.value) || 0,
      Number(get('pagination-max')?.value) || 0
    ],
    dedupScope: get('dedup-scope')?.value || 'by_link',
    minImageBytes: Number(get('min-bytes')?.value) || 0,
    minImageWidth: Number(get('min-width')?.value) || 0,
    minImageHeight: Number(get('min-height')?.value) || 0,
    requestHeaders,
    imageHeaders,
    skipFeeds
  };

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined) {
      delete payload[key];
    }
  });

  return payload;
}
