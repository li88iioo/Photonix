/**
 * 下载页面核心模块
 * - 负责状态管理、视图更新与 API 通信
 * - 管理页面生命周期与用户交互
 */

import downloadState, {
  setAdminSecret,
  clearAdminSecret,
  updateFilter,
  setFeedSearch,
  setHistoryFilter,
  setHistorySearch,
  setLogLevel,
  setAutoRefreshTimer,
  clearAutoRefreshTimer,
  pushMetricSnapshot,
  getMetricHistory
} from './state.js';
import {
  ensureDownloadRoot,
  setRootVisible,
  switchPage,
  openSidebar,
  closeSidebar,
  isSidebarOpen,
  setServiceStatus,
  setLoading,
  setError,
  renderMetrics,
  renderQueue,
  renderRecentDownloads,
  renderTaskTable,
  renderFeeds,
  renderHistory,
  renderLogs,
  updateConfigForm,
  getConfigValues,
  getRootElement,
  applyInteractiveEffects
} from './view.js';
import {
  fetchDownloadStatus,
  fetchDownloadTasks,
  fetchDownloadLogs,
  clearDownloadLogs,
  createDownloadTask,
  updateDownloadTask,
  triggerDownloadTaskAction,
  deleteDownloadTask,
  fetchDownloadConfig,
  updateDownloadConfig,
  fetchDownloadHistory,
  previewDownloadFeed,
  downloadSelectedEntries,
  exportDownloadOpml,
  importDownloadOpml,
  verifyAdminSecret
} from '../../app/api.js';
import { resolveMessage, showNotification } from '../../shared/utils.js';
import { showPasswordPrompt } from '../../settings/password-prompt.js';

import { PREVIEW_FILTERS, runDeferred, formatRelativeTime } from './helpers.js';
import { showConfirmDialog, openTaskFormModal, showPreviewModal, cleanupAllModals } from './modals.js';
import { bindInteractions, cleanupInteractions } from './interactions.js';
import { cachedAggregateMetrics, clearAllCaches } from './utils/cache.js';
import { formatBytes } from './view/utils.js';
import { 
  exchangeSecretForToken, 
  getDownloadToken, 
  clearDownloadToken,
  refreshDownloadToken,
  hasValidAuth 
} from './auth-helper.js';

const ADMIN_SECRET_STORAGE_KEY = 'photonix:download:adminSecret';
const VERIFIED_AT_STORAGE_KEY = 'photonix:download:verifiedAt';
const ADMIN_VERIFICATION_MAX_AGE = 12 * 60 * 60 * 1000;
const AUTO_REFRESH_INTERVAL = 30 * 1000;

function showDownloadNotification(message, type = 'info', duration) {
  return showNotification(message, type, duration, { theme: 'download' });
}

let configImportInput = null;

// 使用缓存版本替代原有函数
// aggregateDownloadMetrics 功能已移至 utils/cache.js 中的 cachedAggregateMetrics

/**
 * 获取API调用的认证参数
 * 如果使用Token认证，返回null（让API层使用Bearer Token）
 * 否则返回密钥（向后兼容）
 */
function getAuthParam() {
  if (downloadState.adminSecret === 'TOKEN_AUTH') {
    // 后端已支持JWT，不需要传密钥了
    return null;
  }
  return downloadState.adminSecret;
}

function isVerificationFresh(timestamp) {
  if (!timestamp) return false;
  return Date.now() - Number(timestamp) <= ADMIN_VERIFICATION_MAX_AGE;
}

function persistAdminSecret(secret) {
  try {
    if (secret) {
      localStorage.setItem(ADMIN_SECRET_STORAGE_KEY, secret);
    } else {
      localStorage.removeItem(ADMIN_SECRET_STORAGE_KEY);
    }
  } catch {}
}

function loadPersistedAdminSecret() {
  try {
    const stored = localStorage.getItem(ADMIN_SECRET_STORAGE_KEY);
    return stored ? String(stored) : null;
  } catch {
    return null;
  }
}

function loadPersistedVerifiedAt() {
  try {
    const raw = localStorage.getItem(VERIFIED_AT_STORAGE_KEY);
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function markAdminVerified() {
  const ts = Date.now();
  downloadState.lastVerifiedAt = ts;
  try {
    localStorage.setItem(VERIFIED_AT_STORAGE_KEY, String(ts));
  } catch {}
}

function clearAdminVerificationMark() {
  downloadState.lastVerifiedAt = 0;
  try {
    localStorage.removeItem(VERIFIED_AT_STORAGE_KEY);
  } catch {}
}

function matchesTaskId(task, identifier) {
  if (!task || !identifier) return false;
  const comparable = String(identifier);
  const keys = ['id', 'taskId', '_id', 'uuid', 'slug', 'feedUrl', 'url'];
  return keys.some((key) => {
    if (!Object.prototype.hasOwnProperty.call(task, key)) return false;
    const value = task[key];
    if (value === null || value === undefined) return false;
    return String(value) === comparable;
  });
}

function getTaskByIndex(index) {
  if (!Array.isArray(downloadState.tasks)) return null;
  if (Number.isNaN(index) || index < 0 || index >= downloadState.tasks.length) return null;
  return downloadState.tasks[index];
}

function findTaskById(taskIdAttr) {
  if (!taskIdAttr) return null;
  let decoded = taskIdAttr;
  try {
    decoded = decodeURIComponent(taskIdAttr);
  } catch {}

  if (decoded.startsWith('task-')) {
    const index = Number(decoded.split('-')[1]);
    const fallback = getTaskByIndex(index);
    if (fallback) return fallback;
  }

  return (downloadState.tasks || []).find((task, index) => {
    if (matchesTaskId(task, decoded)) return true;
    return decoded === `task-${index}`;
  }) || null;
}

function getTaskServerIdentifier(task, fallback = null) {
  if (!task) return fallback;
  const keys = ['id', 'taskId', '_id', 'uuid', 'slug', 'feedId', 'subscriptionId', 'feedUrl', 'url'];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(task, key) && task[key]) {
      return task[key];
    }
  }
  return fallback;
}

function normalizeStatus(task) {
  return String(task?.status || task?.state || '').toLowerCase();
}

function getFilteredTasks() {
  const tasks = Array.isArray(downloadState.tasks) ? downloadState.tasks : [];
  const keyword = (downloadState.filter.search || '').trim().toLowerCase();
  const statusFilter = (downloadState.filter.status || 'all').toLowerCase();

  return tasks.filter((task) => {
    const status = normalizeStatus(task);
    if (statusFilter !== 'all') {
      if (statusFilter === 'error') {
        if (!(status === 'error' || status === 'failed')) return false;
      } else if (status !== statusFilter) {
        return false;
      }
    }

    if (!keyword) return true;
    const haystack = [task?.title, task?.name, task?.feedUrl, task?.url, task?.description]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    return haystack.some((text) => text.includes(keyword));
  });
}

function getEntryTimestamp(entry) {
  const candidates = [entry?.completedAt, entry?.finishedAt, entry?.timestamp, entry?.time, entry?.date];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = candidate instanceof Date ? candidate : new Date(candidate);
    if (!Number.isNaN(value.getTime())) {
      return value.getTime();
    }
  }
  return null;
}

function getFilteredHistory() {
  const history = Array.isArray(downloadState.history) ? downloadState.history : [];
  const keyword = (downloadState.historySearch || '').trim().toLowerCase();
  const filter = downloadState.historyFilter || 'recent';
  const now = Date.now();
  let cutoff = null;

  if (filter === '24h') {
    cutoff = now - (24 * 60 * 60 * 1000);
  } else if (filter === '7d') {
    cutoff = now - (7 * 24 * 60 * 60 * 1000);
  }

  return history.filter((entry) => {
    if (cutoff) {
      const timestamp = getEntryTimestamp(entry);
      if (!timestamp || timestamp < cutoff) {
        return false;
      }
    }
    if (!keyword) return true;
    const haystack = [entry?.filename, entry?.title, entry?.feed, entry?.source, entry?.url]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    return haystack.some((text) => text.includes(keyword));
  }).sort((a, b) => {
    const timeA = getEntryTimestamp(a) || 0;
    const timeB = getEntryTimestamp(b) || 0;
    return timeB - timeA;
  });
}

function getFilteredFeeds() {
  const feeds = Array.isArray(downloadState.feeds) ? downloadState.feeds : [];
  const keyword = (downloadState.feedSearch || '').trim().toLowerCase();
  if (!keyword) return feeds;
  return feeds.filter((feed) => {
    const tokens = [];
    if (feed?.title) tokens.push(String(feed.title));
    if (feed?.name) tokens.push(String(feed.name));
    if (feed?.feedUrl) tokens.push(String(feed.feedUrl));
    if (feed?.url) tokens.push(String(feed.url));
    if (feed?.category) tokens.push(String(feed.category));
    if (Array.isArray(feed?.tags)) tokens.push(feed.tags.join(' '));
    if (Array.isArray(feed?.excludeKeywords)) tokens.push(feed.excludeKeywords.join(' '));
    if (feed?.description) tokens.push(String(feed.description));
    return tokens
      .filter(Boolean)
      .map((value) => value.toLowerCase())
      .some((text) => text.includes(keyword));
  });
}

function getFilteredLogs() {
  const logs = Array.isArray(downloadState.logs) ? downloadState.logs : [];
  const levelFilter = (downloadState.logLevel || 'all').toLowerCase();
  if (levelFilter === 'all') return logs;
  return logs.filter((entry) => {
    const level = String(entry?.level || entry?.severity || '').toLowerCase();
    return level === levelFilter;
  });
}

function renderFromState() {
  const root = getRootElement();
  if (!root) return;
  setServiceStatus(downloadState.status || {});
  const metricHistory = getMetricHistory();
  const filteredTasks = getFilteredTasks();
  const filteredHistory = getFilteredHistory();
  const filteredFeeds = getFilteredFeeds();
  const filteredLogs = getFilteredLogs();
  renderMetrics({
    tasks: downloadState.tasks || [],
    status: downloadState.status || {},
    metrics: downloadState.status?.metrics || null
  }, metricHistory);
  renderQueue(downloadState.tasks || []);
  renderRecentDownloads(downloadState.recent || []);
  renderTaskTable(filteredTasks);
  renderFeeds(filteredFeeds, downloadState.feedSearch || '');
  if (downloadState.activePage === 'history') {
    renderHistory(filteredHistory);
  } else {
    runDeferred(() => renderHistory(filteredHistory));
  }
  if (downloadState.activePage === 'logs') {
    renderLogs(filteredLogs);
  } else {
    runDeferred(() => renderLogs(filteredLogs));
  }
  updateConfigForm(downloadState.config || {});
  applyInteractiveEffects(root);
}

function stopAutoRefresh() {
  const timerId = downloadState.autoRefreshTimer;
  if (timerId) {
    console.log('[AutoRefresh] 清理定时器, ID:', timerId);
    clearInterval(timerId);
    clearAutoRefreshTimer();
  }
}

function startAutoRefresh() {
  stopAutoRefresh(); // 确保先清理旧的
  const timerId = setInterval(() => {
    // 检查页面是否仍然可见
    if (!downloadState.adminSecret || !downloadState.initialized) {
      stopAutoRefresh();
      return;
    }
    refreshData({ silent: true }).catch((error) => {
      console.warn('[AutoRefresh] 刷新失败:', error);
    });
  }, AUTO_REFRESH_INTERVAL);
  setAutoRefreshTimer(timerId);
  console.log('[AutoRefresh] 定时器已启动, ID:', timerId);
}

async function ensureAdminSecret(forcePrompt = false) {
  // 检查是否有存储的管理员密钥
  if (!forcePrompt && downloadState.adminSecret && isVerificationFresh(downloadState.lastVerifiedAt)) {
    // 如果是Token认证，尝试刷新
    if (downloadState.adminSecret === 'TOKEN_AUTH') {
      const refreshed = await refreshDownloadToken();
      if (refreshed) {
        return 'TOKEN_AUTH';
      }
    }
    return downloadState.adminSecret;
  }

  if (window.__PHOTONIX_DOWNLOAD_ADMIN_SECRET__) {
    const secret = String(window.__PHOTONIX_DOWNLOAD_ADMIN_SECRET__);
    delete window.__PHOTONIX_DOWNLOAD_ADMIN_SECRET__;
    
    // 暂时保存原始密钥
    downloadState.originalSecret = secret;
    
    // 用密钥交换Token
    const tokenResult = await exchangeSecretForToken(secret);
    if (tokenResult.success) {
      setAdminSecret('TOKEN_AUTH');
      markAdminVerified();
      showDownloadNotification('认证成功，已获取安全令牌', 'success');
      return 'TOKEN_AUTH';
    }
    
    // Token获取失败，降级到密钥模式
    setAdminSecret(secret);
    persistAdminSecret(secret);
    markAdminVerified();
    return secret;
  }

  if (!forcePrompt) {
    const storedSecret = loadPersistedAdminSecret();
    if (storedSecret) {
      const storedTimestamp = loadPersistedVerifiedAt();
      if (isVerificationFresh(storedTimestamp)) {
        setAdminSecret(storedSecret);
        markAdminVerified();
        return storedSecret;
      }
      clearAdminSecret();
      persistAdminSecret(null);
      clearAdminVerificationMark();
    }
  }

  return new Promise((resolve, reject) => {
    showPasswordPrompt({
      useAdminSecret: true,
      onConfirm: async (adminSecret) => {
        try {
          // 先验证密钥是否正确
          await verifyAdminSecret(adminSecret);
          
          // 暂时保存原始密钥，因为后端还需要
          downloadState.originalSecret = adminSecret;
          
          // 尝试用密钥交换Token
          const tokenResult = await exchangeSecretForToken(adminSecret);
          if (tokenResult.success) {
            setAdminSecret('TOKEN_AUTH');
            markAdminVerified();
            showDownloadNotification('认证成功，已获取安全令牌', 'success');
            resolve('TOKEN_AUTH');
            return true;
          }
          
          // Token获取失败，降级到密钥模式
          console.warn('[Download] Token获取失败，使用密钥模式');
          setAdminSecret(adminSecret);
          persistAdminSecret(adminSecret);
          markAdminVerified();
          resolve(adminSecret);
          return true;
        } catch (error) {
          showDownloadNotification(resolveMessage(error, '管理员密钥验证失败'), 'error');
          return false;
        }
      },
      onCancel: () => {
        reject(new Error('CANCELLED'));
      }
    });
  });
}

async function refreshData({ silent = false } = {}) {
  if (!downloadState.adminSecret) return;
  if (!silent) setLoading(true);
  
  // 使用getAuthParam统一处理
  const authParam = getAuthParam();
  
  try {
    const [status, tasks, logs, historyResult] = await Promise.all([
      fetchDownloadStatus(authParam).catch((error) => {
        throw new Error(resolveMessage(error, '无法连接下载服务'));
      }),
      fetchDownloadTasks(authParam).catch(() => []),
      fetchDownloadLogs(authParam).catch(() => []),
      fetchDownloadHistory(authParam, { page: 1, pageSize: 60 }).catch(() => null)
    ]);

    const taskList = Array.isArray(tasks?.tasks) ? tasks.tasks : Array.isArray(tasks) ? tasks : [];
    const recentDownloads = Array.isArray(status?.recentDownloads) ? status.recentDownloads : [];
    const feedList = taskList;
    const historyList = Array.isArray(historyResult?.entries) ? historyResult.entries : [];
    const historyPagination = historyResult?.pagination || {
      page: 1,
      pageSize: historyList.length,
      total: historyList.length
    };
    const logEntries = Array.isArray(logs?.entries) ? logs.entries : Array.isArray(logs) ? logs : [];

    downloadState.status = status || {};
    if (status?.config) {
      downloadState.config = status.config;
    } else if (!downloadState.config) {
      try {
        const config = await fetchDownloadConfig(downloadState.adminSecret);
        downloadState.config = config;
        downloadState.status.config = config;
      } catch {}
    }
    const metrics = cachedAggregateMetrics({
      tasks: taskList,
      status: downloadState.status,
      history: historyList,
      recent: recentDownloads
    });
    downloadState.status.metrics = metrics;
    downloadState.tasks = taskList;
    downloadState.recent = recentDownloads;
    downloadState.feeds = feedList;
    downloadState.history = historyList;
    downloadState.historyPagination = historyPagination;
    downloadState.logs = logEntries;

    // 记录指标快照
    const snapshot = {
      tasks: taskList.length,
      articles: metrics.articlesDownloaded,
      images: metrics.imagesDownloaded,
      storage: metrics.storageBytes
    };
    
    // 调试：检查数据是否有变化
    if (!silent) {
      console.log('[Dashboard] 更新数据:', {
        任务数: snapshot.tasks,
        文章数: snapshot.articles,
        图片数: snapshot.images,
        存储: formatBytes(snapshot.storage)
      });
    }
    
    pushMetricSnapshot(snapshot);
    renderFromState();

    if (!silent) setLoading(false);
    setError(null);
  } catch (error) {
    if (!silent) setLoading(false);
    const message = resolveMessage(error, '下载服务不可用');
    setError(message);
    if (!silent) {
      showDownloadNotification(message, 'error');
    }
  }
}

async function handleSaveConfig() {
  if (!downloadState.adminSecret) {
    await ensureAdminSecret(true).catch(() => {});
    if (!downloadState.adminSecret) return;
  }

  let payload;
  try {
    payload = getConfigValues();
  } catch (error) {
    showDownloadNotification(resolveMessage(error, '配置内容无效'), 'error');
    return;
  }

  try {
    const config = await updateDownloadConfig(downloadState.adminSecret, payload);
    downloadState.config = config;
    if (downloadState.status) {
      downloadState.status.config = config;
    }
    updateConfigForm(config);
    markAdminVerified();
    showDownloadNotification('下载配置已保存', 'success');
  } catch (error) {
    showDownloadNotification(resolveMessage(error, '保存配置失败'), 'error');
  }
}

async function reloadConfigSnapshot({ silent = false } = {}) {
  if (!downloadState.adminSecret) {
    await ensureAdminSecret(true).catch(() => {});
    if (!downloadState.adminSecret) return;
  }

  try {
    const config = await fetchDownloadConfig(downloadState.adminSecret);
    downloadState.config = config;
    if (downloadState.status) {
      downloadState.status.config = config;
    }
    updateConfigForm(config);
    if (!silent) {
      showDownloadNotification('已同步最新配置', 'success');
    }
  } catch (error) {
    if (!silent) {
      showDownloadNotification(resolveMessage(error, '加载配置失败'), 'error');
    }
  }
}

function handleExportConfig() {
  try {
    const payload = getConfigValues();
    const serialized = JSON.stringify(payload, null, 2);
    const blob = new Blob([serialized], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    anchor.download = `download-config-${timestamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('导出配置失败', error);
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert('导出配置失败，请查看控制台错误信息。');
    }
  }
}

function ensureConfigImportInput() {
  if (configImportInput) return configImportInput;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.style.display = 'none';
  input.addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      updateConfigForm(parsed || {});
      downloadState.config = parsed || {};
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert('配置文件已载入，请确认后点击“保存配置”。');
      }
    } catch (error) {
      console.error('导入配置失败', error);
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert('导入配置失败，文件格式可能不正确。');
      }
    } finally {
      event.target.value = '';
    }
  });
  document.body.appendChild(input);
  configImportInput = input;
  return input;
}

function handleImportConfig() {
  const input = ensureConfigImportInput();
  input.click();
}

async function handleRefreshLogs() {
  if (!downloadState.adminSecret) return;
  await refreshData({ silent: false });
}

async function handleClearLogs() {
  const ready = await ensureReadyForMutation();
  if (!ready) return;
  try {
    await clearDownloadLogs(downloadState.adminSecret);
    downloadState.logs = [];
    renderLogs([]);
    showDownloadNotification('日志已清空', 'success');
    await refreshData({ silent: true });
  } catch (error) {
    showDownloadNotification(resolveMessage(error, '清空日志失败'), 'error');
  }
}

async function ensureReadyForMutation() {
  if (!downloadState.adminSecret) {
    await ensureAdminSecret(false).catch(() => {});
  }
  return Boolean(downloadState.adminSecret);
}

async function handlePreviewTask(task) {
  if (!(await ensureReadyForMutation())) return;
  const serverId = getTaskServerIdentifier(task);
  if (!serverId) {
    showDownloadNotification('任务缺少可用的标识符，无法预览', 'error');
    return;
  }
  try {
    const preview = await previewDownloadFeed(getAuthParam(), serverId, { limit: 30 });
    downloadState.preview = {
      taskId: serverId,
      feed: preview.feed,
      items: preview.items,
      filter: 'all',
      selection: []
    };
    await showPreviewModal({
      task,
      preview,
      serverId,
      filters: PREVIEW_FILTERS,
      ensureReadyForMutation,
      submitDownloadEntries: async (id, entries) => downloadSelectedEntries(getAuthParam(), id, { entries }),
      markAdminVerified,
      refreshData,
      showNotification: showDownloadNotification,
      resolveMessage,
      formatRelativeTime
    });
  } catch (error) {
    showDownloadNotification(resolveMessage(error, '加载预览失败'), 'error');
  } finally {
    downloadState.preview = {
      taskId: null,
      feed: null,
      items: [],
      filter: 'all',
      selection: []
    };
  }
}

async function handleCreateTask() {
  if (!(await ensureReadyForMutation())) return;
  let formValues;
  try {
    formValues = await openTaskFormModal({ mode: 'create' });
  } catch (error) {
    if (error.message === 'CANCELLED') {
      showDownloadNotification('已取消创建任务', 'info');
      return;
    }
    showDownloadNotification(resolveMessage(error, '创建任务失败'), 'error');
    return;
  }

  const payload = {
    feedUrl: formValues.feedUrl,
    title: formValues.title,
    interval: formValues.interval,
    category: formValues.category,
    excludeKeywords: formValues.excludeKeywords,
    tags: formValues.tags,
    autoStart: formValues.autoStart
  };

  if (!payload.interval) delete payload.interval;
  if (!payload.category) delete payload.category;
  if (!payload.excludeKeywords || payload.excludeKeywords.length === 0) delete payload.excludeKeywords;
  if (!payload.tags || payload.tags.length === 0) delete payload.tags;
  if (formValues.cookie) {
    payload.cookie = formValues.cookie;
    if (formValues.cookieDomain) {
      payload.cookieDomain = formValues.cookieDomain;
    }
  }

  try {
    await createDownloadTask(downloadState.adminSecret, payload);
    markAdminVerified();
    showDownloadNotification('任务已创建', 'success');
    await refreshData({ silent: false });
  } catch (error) {
    showDownloadNotification(resolveMessage(error, '创建任务失败'), 'error');
  }
}

async function handleTaskCommand(task, action, successMessage) {
  if (!(await ensureReadyForMutation())) return;
  const serverId = getTaskServerIdentifier(task);
  if (!serverId) {
    showDownloadNotification('任务缺少可用的标识符，无法执行操作', 'error');
    return;
  }
  try {
    await triggerDownloadTaskAction(getAuthParam(), serverId, action, {});
    markAdminVerified();
    showDownloadNotification(successMessage, 'success');
    await refreshData({ silent: true });
  } catch (error) {
    showDownloadNotification(resolveMessage(error, '任务控制失败'), 'error');
  }
}

async function handleTaskEdit(task) {
  if (!(await ensureReadyForMutation())) return;
  const serverId = getTaskServerIdentifier(task);
  if (!serverId) {
    showDownloadNotification('任务缺少可用的标识符，无法执行操作', 'error');
    return;
  }

  let formValues;
  try {
    formValues = await openTaskFormModal({ mode: 'edit', initial: task });
  } catch (error) {
    if (error.message === 'CANCELLED') {
      showDownloadNotification('已取消修改', 'info');
      return;
    }
    showDownloadNotification(resolveMessage(error, '更新任务失败'), 'error');
    return;
  }

  const listToKey = (items) => (Array.isArray(items)
    ? items.map((item) => item.trim()).filter(Boolean).join(',')
    : '');

  const payload = {};
  if (formValues.feedUrl && formValues.feedUrl !== task.feedUrl) payload.feedUrl = formValues.feedUrl;
  if (formValues.title && formValues.title !== task.title) payload.title = formValues.title;
  const currentInterval = String(task.interval || task.schedule?.interval || '').trim();
  if (formValues.interval && formValues.interval !== currentInterval) payload.interval = formValues.interval;
  const currentCategory = task.category || '';
  if ((formValues.category || '') !== currentCategory) payload.category = formValues.category;
  const currentExclude = listToKey(task.excludeKeywords);
  if (listToKey(formValues.excludeKeywords) !== currentExclude) payload.excludeKeywords = formValues.excludeKeywords;
  const currentTags = listToKey(task.tags);
  if (listToKey(formValues.tags) !== currentTags) payload.tags = formValues.tags;
  const currentCookie = task.cookie || '';
  if ((formValues.cookie || '') !== currentCookie) payload.cookie = formValues.cookie;
  const currentCookieDomain = task.cookieDomain || '';
  if ((formValues.cookieDomain || '') !== currentCookieDomain) payload.cookieDomain = formValues.cookieDomain;
  if (typeof formValues.enabled === 'boolean') {
    const currentlyEnabled = String(task.status || '').toLowerCase() === 'running';
    if (formValues.enabled !== currentlyEnabled) payload.enabled = formValues.enabled;
  }

  if (Object.keys(payload).length === 0) {
    showDownloadNotification('未检测到任何变更', 'info');
    return;
  }

  try {
    await updateDownloadTask(downloadState.adminSecret, serverId, payload);
    markAdminVerified();
    showDownloadNotification('任务已更新', 'success');
    await refreshData({ silent: false });
  } catch (error) {
    showDownloadNotification(resolveMessage(error, '更新任务失败'), 'error');
  }
}

async function handleTaskDelete(task) {
  const title = task?.title || task?.name || '未命名任务';
  const confirmed = await showConfirmDialog({
    title: '删除订阅任务',
    message: `确定要删除“${title}”吗？此操作不可撤销。`,
    confirmLabel: '确认删除',
    cancelLabel: '取消',
    tone: 'danger'
  });
  if (!confirmed) return;
  if (!(await ensureReadyForMutation())) return;
  const serverId = getTaskServerIdentifier(task);
  if (!serverId) {
    showDownloadNotification('任务缺少可用的标识符，无法执行操作', 'error');
    return;
  }
  try {
    await deleteDownloadTask(downloadState.adminSecret, serverId);
    markAdminVerified();
    showDownloadNotification('任务已删除', 'success');
    await refreshData({ silent: false });
  } catch (error) {
    showDownloadNotification(resolveMessage(error, '删除任务失败'), 'error');
  }
}

async function handleToggleTask(task) {
  const running = String(task.status || '').toLowerCase() === 'running';
  await handleTaskCommand(task, running ? 'pause' : 'resume', running ? '任务已暂停' : '任务已启动');
}

function resolveTaskById(taskId) {
  const task = findTaskById(taskId);
  if (!task) {
    showDownloadNotification('无法找到对应的任务记录', 'error');
    return null;
  }
  return task;
}

async function handleFeedPreview(taskId) {
  const task = resolveTaskById(taskId);
  if (!task) return;
  await handlePreviewTask(task);
}

async function handleFeedEdit(taskId) {
  const task = resolveTaskById(taskId);
  if (!task) return;
  await handleTaskEdit(task);
}

async function handleFeedToggle(taskId) {
  const task = resolveTaskById(taskId);
  if (!task) return;
  await handleToggleTask(task);
}

async function handleFeedDelete(taskId) {
  const task = resolveTaskById(taskId);
  if (!task) return;
  await handleTaskDelete(task);
}

async function handleImportOpml() {
  if (!(await ensureReadyForMutation())) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.opml,.xml';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const content = await file.text();
      await importDownloadOpml(downloadState.adminSecret, { content });
      markAdminVerified();
      showDownloadNotification('OPML 导入成功', 'success');
      await refreshData({ silent: false });
    } catch (error) {
      showDownloadNotification(resolveMessage(error, '导入 OPML 失败'), 'error');
    } finally {
      input.value = '';
    }
  });
  input.click();
}

async function handleExportOpml() {
  if (!(await ensureReadyForMutation())) return;
  try {
    const result = await exportDownloadOpml(downloadState.adminSecret);
    if (!result || !result.content) {
      showDownloadNotification('导出内容为空', 'warning');
      return;
    }
    const blob = new Blob([result.content], { type: 'text/xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `photonix-feeds-${Date.now()}.opml`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    markAdminVerified();
    showDownloadNotification('OPML 已导出', 'success');
  } catch (error) {
    showDownloadNotification(resolveMessage(error, '导出 OPML 失败'), 'error');
  }
}

function initializeInteractions() {
  bindInteractions({
    getRootElement,
    downloadState,
    switchPage,
    openSidebar,
    closeSidebar,
    isSidebarOpen,
    hideDownloadPage,
    updateFilter,
    setFeedSearch,
    setHistorySearch,
    setHistoryFilter,
    setLogLevel,
    renderTaskTable,
    renderFeeds,
    renderHistory,
    renderLogs,
    getFilteredTasks,
    getFilteredFeeds,
    getFilteredHistory,
    getFilteredLogs,
    handleSaveConfig,
    reloadConfigSnapshot,
    handleExportConfig,
    handleImportConfig,
    handleRefreshLogs,
    handleClearLogs,
    handleCreateTask,
    handleImportOpml,
    handleExportOpml,
    handleTaskCommand,
    handlePreviewTask,
    handleTaskEdit,
    handleTaskDelete,
    handleFeedPreview,
    handleFeedEdit,
    handleFeedToggle,
    handleFeedDelete,
    resolveTaskById
  });
}

export function isDownloadRoute(hash) {
  if (!hash) return false;
  return hash.toLowerCase().startsWith('#/download');
}

export async function showDownloadPage() {
  ensureDownloadRoot();
  initializeInteractions();
  setRootVisible(true);
  updateConfigForm(downloadState.config || {});
  switchPage(downloadState.activePage || 'dashboard');

  try {
    await ensureAdminSecret(false);
  } catch (error) {
    if (error.message !== 'CANCELLED') {
      showDownloadNotification(resolveMessage(error, '管理员验证失败'), 'error');
    }
    hideDownloadPage({ redirect: true });
    return;
  }

  if (!downloadState.config) {
    await reloadConfigSnapshot({ silent: true });
  }

  await refreshData({ silent: false });
  startAutoRefresh();
}

export function hideDownloadPage({ redirect = false } = {}) {
  setRootVisible(false);
  stopAutoRefresh();
  cleanupInteractions(); // 清理事件监听器（简单方案）
  cleanupAllModals(); // 清理所有模态框
  clearAllCaches(); // 清理计算缓存
  // 不清理Token，保持会话期间有效
  closeSidebar();
  if (redirect && (!window.location.hash || window.location.hash.toLowerCase().startsWith('#/download'))) {
    window.location.hash = '#/';
  }
}

export function resetDownloadAccess() {
  stopAutoRefresh();
  clearAdminSecret();
  persistAdminSecret(null);
  clearAdminVerificationMark();
  clearDownloadToken(); // 清理Token
}
