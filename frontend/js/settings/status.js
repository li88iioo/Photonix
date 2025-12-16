/**
 * @file frontend/js/settings/status.js
 * @description 管理设置页同步任务状态、实时监控与补全操作。
 * 
 * 模块拆分：
 * - status/shared.js          - 共享工具函数（状态类名、图标、API）
 * - status/index-status.js    - 索引状态卡片渲染
 * - status/thumbnail-status.js - 缩略图状态卡片渲染
 * - status/hls-status.js      - HLS状态卡片渲染
 * - status/sync-actions.js    - 同步操作API和实时监控
 */

import settingsContext from './context.js';
import { settingsLogger } from './logger.js';
import { showNotification, resolveMessage } from '../shared/utils.js';
import { safeSetInnerHTML } from '../shared/dom-utils.js';
import { showPasswordPrompt } from './password-prompt.js';
import { getAuthToken } from '../app/auth.js';

// 导入子模块
import { fetchStatusTables, showPodLoading, showProgressUpdate, getStatusClass, getStatusDisplayName } from './status/shared.js';
import { renderIndexStatus } from './status/index-status.js';
import { renderThumbnailStatus } from './status/thumbnail-status.js';
import { renderHlsStatus } from './status/hls-status.js';
import {
  triggerSync as _triggerSync,
  triggerCleanup as _triggerCleanup,
  triggerThumbnailBatchSync,
  resyncThumbnails as _resyncThumbnails,
  startRealtimeMonitoring
} from './status/sync-actions.js';

// 重新导出供外部使用
export { getStatusClass, getStatusDisplayName, startRealtimeMonitoring };

let autoRefreshIntervalId = null;
const AUTO_REFRESH_INTERVAL_MS = 10000; // 10秒自动刷新间隔

/**
 * 启动自动刷新机制，每10秒刷新状态卡片。
 */
export function startPersistentAutoRefresh() {
  if (autoRefreshIntervalId) {
    clearInterval(autoRefreshIntervalId);
  }
  loadStatusTables({ silent: true }).catch(() => { });

  autoRefreshIntervalId = setInterval(async () => {
    try {
      await loadStatusTables({ silent: true });
    } catch (error) {
      settingsLogger.debug('自动刷新失败（已忽略）', error);
    }
  }, AUTO_REFRESH_INTERVAL_MS);

  settingsLogger.debug(`已启动自动刷新，间隔 ${AUTO_REFRESH_INTERVAL_MS / 1000} 秒`);
}

/**
 * 停止自动刷新机制。
 */
export function stopPersistentAutoRefresh() {
  if (autoRefreshIntervalId) {
    clearInterval(autoRefreshIntervalId);
    autoRefreshIntervalId = null;
    settingsLogger.debug('已停止自动刷新');
  }
}

/**
 * 加载并渲染设置页的状态表。
 * @param {{ silent?: boolean }} [options={}] 是否静默刷新
 * @returns {Promise<void>} 渲染完成
 */
export async function loadStatusTables(options = {}) {
  const { silent = false } = options;
  const containers = ['index-status', 'thumbnail-status', 'hls-status'];

  containers.forEach(id => {
    const container = document.getElementById(id);
    if (container && !container.innerHTML.trim()) {
      safeSetInnerHTML(container, '<div class="status-loading"><div class="spinner"></div></div>');
    }
  });

  try {
    const statusData = await fetchStatusTables();

    renderIndexStatus(statusData.index);
    settingsLogger.debug('Frontend缩略图数据', statusData.thumbnail);
    renderThumbnailStatus(statusData.thumbnail);
    renderHlsStatus(statusData.hls);

    if (!silent) {
      showNotification('状态表数据已更新', 'success');
    }
  } catch (error) {
    containers.forEach(id => {
      const container = document.getElementById(id);
      if (container) {
        safeSetInnerHTML(container, '');
        const errorDiv = document.createElement('div');
        errorDiv.className = 'status-loading';
        errorDiv.style.color = 'var(--red-400)';
        errorDiv.textContent = `加载失败: ${error.message}`;
        container.appendChild(errorDiv);
      }
    });
    if (!silent) {
      showNotification('加载状态表失败', 'error');
    }
  }
}

// 包装sync函数以传入loadStatusTables回调
export async function triggerSync(type, options = {}) {
  return _triggerSync(type, options, loadStatusTables);
}

export async function triggerCleanup(type) {
  return _triggerCleanup(type, loadStatusTables);
}

export async function resyncThumbnails() {
  return _resyncThumbnails(loadStatusTables);
}

export { triggerThumbnailBatchSync, showPodLoading, showProgressUpdate };

/**
 * 绑定设置页同步按钮事件。
 */
export function setupSyncButtonListeners() {
  const { card } = settingsContext;
  if (!card) return;

  card.removeEventListener('click', handleStatusButtonClick);
  card.addEventListener('click', handleStatusButtonClick);
}

/**
 * 处理带认证的索引重建逻辑。
 * @param {string} type 任务类型
 * @param {string} action 动作名
 * @returns {Promise<boolean|void>}
 */
async function handleIndexRebuildWithAuth(type, action) {
  const { initialSettings } = settingsContext;
  const hasPassword = initialSettings?.hasPassword || false;

  if (!hasPassword) {
    showNotification('需要先设置访问密码才能重建索引', 'warning');
    return;
  }

  const isAdminSecretConfigured = initialSettings?.isAdminSecretConfigured || false;

  if (!isAdminSecretConfigured) {
    showNotification('权限不足，无法重建索引', 'error');
    return;
  }

  // 管理员密码验证
  return new Promise((resolve) => {
    showPasswordPrompt({
      useAdminSecret: true,
      onConfirm: async (adminSecret) => {
        try {
          await triggerSyncWithAuth(type, action, adminSecret);
          showNotification('重建索引已启动', 'success');
          startRealtimeMonitoring('index');
          await loadStatusTables();
          resolve(true);
          return true;
        } catch (error) {
          const message = resolveMessage(error, '重建索引失败');
          throw new Error(message);
        }
      },
      onCancel: () => {
        showNotification('操作已取消', 'info');
        resolve(false);
      }
    });
  });
}

/**
 * 通过管理员密码请求补全或重建。
 * @param {string} type 任务类型
 * @param {string} action 动作
 * @param {string} adminSecret 管理员密钥
 * @returns {Promise<Object>} 响应对象
 */
async function triggerSyncWithAuth(type, action, adminSecret) {
  const response = await fetch(`/api/settings/sync/${type}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAuthToken()}`,
      'X-Admin-Secret': adminSecret
    },
    body: JSON.stringify({
      action,
      adminSecret
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = resolveMessage(payload, `操作失败: ${response.status}`);
    throw new Error(message);
  }

  return payload;
}

/**
 * 处理设置页状态卡操作按钮的点击事件。
 * @param {MouseEvent} event 事件对象
 */
async function handleStatusButtonClick(event) {
  const button = event.target.closest('.sync-btn[data-action]');
  if (!button) return;

  event.preventDefault();
  event.stopPropagation();

  const { initialSettings } = settingsContext;
  const hasPassword = initialSettings?.hasPassword || false;

  if (!hasPassword) {
    showNotification('需要先设置访问密码才能使用这些功能', 'warning');
    return;
  }

  const action = button.dataset.action;
  const type = button.dataset.type;

  if (!action || !type) return;

  try {
    switch (action) {
      case 'sync': {
        const isIndexRebuild = type === 'index';

        if (isIndexRebuild) {
          await handleIndexRebuildWithAuth(type, action);
          return;
        }

        const isThumbnailSync = type === 'thumbnail';
        const shouldShowOverlay = type === 'index';

        if (shouldShowOverlay) {
          showPodLoading(type, true);
          showProgressUpdate(type, true);
        }

        const originalDisabled = button.disabled;
        const originalHTML = button.innerHTML;
        const originalLabel = button.querySelector('span')?.textContent?.trim() || '处理中';

        if (!originalDisabled) {
          button.disabled = true;
          button.classList.add('loading');
          const loadingLabel = `${originalLabel}中...`;
          safeSetInnerHTML(button, `<span class="btn-spinner"></span> <span>${loadingLabel}</span>`);
        }

        try {
          if (isThumbnailSync) {
            await triggerThumbnailBatchSync({
              loop: true,
              silent: false
            });
          } else if (type === 'index') {
            await handleIndexRebuildWithAuth(type, action);
          } else {
            await triggerSync(type, {
              loop: false,
              silent: false
            });
          }
        } finally {
          if (shouldShowOverlay) {
            showPodLoading(type, false);
            setTimeout(() => showProgressUpdate(type, false), 2000);
          }

          if (!originalDisabled) {
            button.disabled = false;
            button.classList.remove('loading');
            safeSetInnerHTML(button, originalHTML);
          }
        }
        break;
      }
      case 'cleanup': {
        const cleanupOriginalDisabled = button.disabled;
        const cleanupOriginalHTML = button.innerHTML;
        const cleanupLabel = button.querySelector('span')?.textContent?.trim() || '清理';

        if (!cleanupOriginalDisabled) {
          button.disabled = true;
          button.classList.add('loading');
          safeSetInnerHTML(button, `<span class="btn-spinner"></span> <span>${cleanupLabel}中...</span>`);
        }

        try {
          await triggerCleanup(type);
        } finally {
          button.classList.remove('loading');
          button.disabled = false;
          safeSetInnerHTML(button, cleanupOriginalHTML);
          if (cleanupOriginalDisabled) {
            button.disabled = true;
          }
        }
        break;
      }
      case 'resync': {
        if (type === 'thumbnails') {
          const resyncOriginalDisabled = button.disabled;
          const resyncOriginalHTML = button.innerHTML;
          const resyncLabel = button.querySelector('span')?.textContent?.trim() || '同步';

          if (!resyncOriginalDisabled) {
            button.disabled = true;
            button.classList.add('loading');
            safeSetInnerHTML(button, `<span class="btn-spinner"></span> <span>${resyncLabel}中...</span>`);
          }

          try {
            await resyncThumbnails();
          } finally {
            button.classList.remove('loading');
            button.disabled = false;
            safeSetInnerHTML(button, resyncOriginalHTML);
            if (resyncOriginalDisabled) {
              button.disabled = true;
            }
          }
        }
        break;
      }
      default:
        settingsLogger.warn('未知的操作类型', { action });
    }
  } catch (error) {
    let errorMessage = '操作失败';

    if (error.message.includes('权限不足') || error.message.includes('403')) {
      errorMessage = '权限不足，无法访问此资源';
    } else if (error.message.includes('网络') || error.message.includes('fetch')) {
      errorMessage = '网络连接失败，请检查网络连接';
    } else if (error.message) {
      errorMessage = error.message;
    }

    showNotification(errorMessage, 'error');
  }
}
