/**
 * @file frontend/js/settings/status.js
 * @description 管理设置页同步任务状态、实时监控与补全操作
 */

import settingsContext from './context.js';
import { settingsLogger } from './logger.js';
import { syncState, validateSyncState } from '../core/state.js';
import { getAuthToken } from '../app/auth.js';
import { showNotification, resolveMessage } from '../shared/utils.js';
import { UI, NETWORK } from '../core/constants.js';
import { generateStatusCardHTML, generateDetailItemHTML } from '../features/gallery/ui-components.js';
import { safeSetInnerHTML, safeSetStyle, safeClassList, safeGetElementById, safeQuerySelector } from '../shared/dom-utils.js';
import { showPasswordPrompt } from './password-prompt.js';

const ongoingRequests = new Map();

/**
 * 从后端获取状态表数据。
 * @private
 * @returns {Promise<Record<string, any>>} 状态表数据对象
 */
async function fetchStatusTables() {
  try {
    const token = getAuthToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    const response = await fetch('/api/settings/status-tables', {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      throw new Error(`获取状态表失败: ${response.status}`);
    }

    const data = await response.json();
    return data.data;
  } catch (error) {
    settingsLogger.error('获取状态表数据失败', error);
    throw error;
  }
}

/**
 * 启动指定类型的同步/补全任务并显示进度。
 * @param {'index'|'thumbnail'|'hls'} type - 同步任务类型
 * @param {{ loop?: boolean, silent?: boolean }} [options={}] - 执行配置
 * @returns {Promise<Record<string, any>>} 后端返回的任务结果
 */
export async function triggerSync(type, options = {}) {
  try {
    if (ongoingRequests.has(type)) {
      settingsLogger.warn('触发补全操作被拒绝：请求正在进行中', { type });
      throw new Error('操作正在进行中，请稍后再试');
    }

    ongoingRequests.set(type, Date.now());

    syncState.setSilentMode(options.silent);
    const isSilentMode = syncState.isSilent;

    validateSyncState();

    if (!isSilentMode) {
      showPodLoading(type, true);
      showProgressUpdate(type, true);
    }

    startRealtimeMonitoring(type);

    const token = getAuthToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    settingsLogger.debug('发送补全请求', { type, loop: options.loop, silent: options.silent });

    const response = await fetch(`/api/settings/sync/${type}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        loop: options.loop || false,
        silent: syncState.isSilent || false
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      settingsLogger.error('补全请求失败', {
        type,
        status: response.status,
        statusText: response.statusText,
        error: errorData
      });
      throw new Error(errorData.message || `补全失败: ${response.status}`);
    }

    const data = await response.json();

    if (!syncState.isSilent) {
      showNotification(`补全${type === 'index' ? '索引' : type === 'thumbnail' ? '缩略图' : 'HLS'}成功`, 'success');
    } else if (type === 'thumbnail') {
      showNotification('缩略图后台补全已启动，将自动补全所有缺失文件', 'info');
    }

    await loadStatusTables();

    return data;
  } catch (error) {
    settingsLogger.error('触发补全操作失败', { type, error: error.message });
    throw error;
  } finally {
    ongoingRequests.delete(type);

    if (!syncState.isSilent) {
      showPodLoading(type, false);
    }
  }
}

/**
 * 触发缓存或资源的清理任务。
 * @param {'index'|'thumbnail'|'hls'} type - 清理任务类型
 * @returns {Promise<void>} 清理流程完成的 Promise
 */
export async function triggerCleanup(type) {
  try {
    const token = getAuthToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(`/api/settings/cleanup/${type}`, {
      method: 'POST',
      headers
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `同步失败: ${response.status}`);
    }

    const data = await response.json();

    if (data.data && data.data.skipped) {
      showNotification(data.data.message, 'info');
    } else {
      showNotification(`同步${type === 'thumbnail' ? '缩略图' : 'HLS'}成功`, 'success');
    }

    await loadStatusTables();

    return data;
  } catch (error) {
    throw error;
  }
}

/**
 * 启动缩略图批量补全任务。
 * @param {{ silent?: boolean }} [options={}] - 执行配置
 * @returns {Promise<Record<string, any>>} 后端返回的执行结果
 */
export async function triggerThumbnailBatchSync(options = {}) {
  try {
    validateSyncState();

    const token = getAuthToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    headers['Content-Type'] = 'application/json';

    const requestBody = {
      limit: (NETWORK.MAX_RETRY_ATTEMPTS || 0) * 1000,
      loop: options.loop || false,
      silent: options.silent || false
    };

    const response = await fetch('/api/thumbnail/batch', {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `批量补全失败: ${response.status}`);
    }

    const data = await response.json();
    const processedCount = data.data?.processed || 0;
    if (processedCount > 0) {
      showNotification(`缩略图补全已启动，正在处理 ${processedCount} 个文件`, 'success');
    } else {
      showNotification('缩略图补全已启动，正在扫描文件...', 'info');
    }

    startRealtimeMonitoring('thumbnail');

    return data;
  } catch (error) {
    throw error;
  }
}

/**
 * 重新同步缩略图状态以纠正异常。
 * @returns {Promise<void>} 同步完成的 Promise
 */
export async function resyncThumbnails() {
  try {
    const token = getAuthToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    const response = await fetch('/api/settings/resync/thumbnails', {
      method: 'POST',
      headers
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `重同步失败: ${response.status}`);
    }

    const data = await response.json();
    showNotification(data.message || '缩略图状态重同步完成', 'success');

    await loadStatusTables({ silent: true });

    return data;
  } catch (error) {
    throw error;
  }
}

/**
 * 控制对应任务类型的加载动画显示。
 * @param {'index'|'thumbnail'|'hls'} type - 同步任务类型
 * @param {boolean} show - 是否展示加载动画
 * @returns {void}
 */
export function showPodLoading(type, show) {
  const loadingElement = safeGetElementById(`${type}-loading`);
  if (loadingElement) {
    safeClassList(loadingElement, 'toggle', 'active', show);
  }
}

/**
 * 控制进度提示条的展示与隐藏。
 * @param {'index'|'thumbnail'|'hls'} type - 任务类型
 * @param {boolean} show - 是否展示进度提示
 * @returns {void}
 */
export function showProgressUpdate(type, show) {
  const updateElement = safeGetElementById(`${type}-progress-update`);
  if (updateElement) {
    safeClassList(updateElement, 'toggle', 'active', show);
  }
}

function updateStatusRealtime(type, data) {
  const prefix = type;

  const percentElement = safeGetElementById(`${prefix}-percent`);
  if (percentElement && data.percent !== undefined) {
    percentElement.textContent = `${data.percent}%`;

    const progressCircle = safeQuerySelector(`[data-type="${type}"] .status-chart-progress-front`);
    if (progressCircle) {
      const progressOffset = 329 - (329 * data.percent / 100);
      safeSetStyle(progressCircle, 'strokeDashoffset', progressOffset);
    }
  }

  const fields = ['processed', 'fts', 'total', 'files', 'unprocessed', 'sourceTotal'];
  fields.forEach(field => {
    if (data[field] !== undefined) {
      const element = safeGetElementById(`${prefix}-${field}`);
      if (element) {
        element.textContent = data[field];

        if (field === 'processed') {
          element.className = 'status-detail-value status-success';
        } else if (field === 'unprocessed') {
          element.className = 'status-detail-value status-warning';
        }
      }
    }
  });

  if (data.stats && Array.isArray(data.stats)) {
    data.stats.forEach(stat => {
      const element = safeGetElementById(`${prefix}-${stat.status}`);
      if (element) {
        const statusClass = getStatusClass(stat.status);
        element.className = `status-detail-value ${statusClass}`;
        element.textContent = stat.count;
      }
    });
  }

  if (data.lastUpdated) {
    const timeElement = safeGetElementById(`${prefix}-last-updated`);
    if (timeElement) {
      timeElement.textContent = new Date(data.lastUpdated).toLocaleString();
    }
  }

  if (data.lastSync) {
    const syncElement = safeGetElementById(`${prefix}-last-sync`);
    if (syncElement) {
      syncElement.textContent = new Date(data.lastSync).toLocaleString();
    }
  }
}

/**
 * 开启指定任务的实时状态监听。
 * @param {'index'|'thumbnail'|'hls'} type - 任务类型
 * @returns {void}
 */
export function startRealtimeMonitoring(type) {
  syncState.startMonitoring(type);
  validateSyncState();

  const intervalId = setInterval(async () => {
    try {
      const token = getAuthToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};

      const response = await fetch('/api/settings/status-tables', { headers });

      if (response.ok) {
        const data = await response.json();
        let statusData = null;

        switch (type) {
          case 'index':
            statusData = data.index;
            break;
          case 'thumbnail':
            statusData = data.thumbnail;
            break;
          case 'hls':
            statusData = data.hls;
            break;
        }

        if (statusData) {
          let percent = 0;
          if (type === 'index') {
            const totalItems = statusData.itemsStats?.reduce((sum, stat) => sum + stat.count, 0) || 0;
            if (totalItems > 0) {
              if (statusData.status === 'complete') {
                percent = 100;
              } else {
                percent = Math.round((statusData.processedFiles / totalItems) * 100);
              }
            } else {
              percent = 0;
            }
          } else if (type === 'thumbnail') {
            const sourceTotal = statusData.sourceTotal || statusData.total || 0;
            const successStates = ['exists', 'complete'];
            const successCount = statusData.stats?.reduce((sum, stat) => {
              return successStates.includes(stat.status) ? sum + stat.count : sum;
            }, 0) || 0;
            const existsCount = statusData.stats?.find(s => s.status === 'exists')?.count || 0;
            const actualSuccessCount = successCount > 0 ? successCount : existsCount;

            percent = sourceTotal > 0 ? Math.round((actualSuccessCount / sourceTotal) * 100) : 0;
          } else if (type === 'hls') {
            const totalVideos = statusData.totalVideos || 0;
            const processedVideos = statusData.processedVideos || 0;
            percent = totalVideos > 0 ? Math.round((processedVideos / totalVideos) * 100) : 0;
          }

          updateStatusRealtime(type, {
            ...statusData,
            percent
          });
        }
      }
    } catch (error) {
      // ignore
    }
  }, type === 'index' ? 2000 : 10000);

  const timeoutId = setTimeout(() => {
    syncState.stopMonitoring();
    validateSyncState();

    if (!syncState.isSilent) {
      showProgressUpdate(type, false);
    }
  }, 30000);

  syncState.setMonitoringTimers(intervalId, timeoutId);
}

function getIconSVG(iconName) {
  const icons = {
    paperclip: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><title>补全</title><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>`,
    sync: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><title>同步</title><polyline points="1 4 1 10 7 10"></polyline><polyline points="23 20 23 14 17 14"></polyline><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path></svg>`,
    rebuild: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><title>重建索引</title><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`,
    trash: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><title>清理</title><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`
  };
  return icons[iconName] || '';
}

function calculateIndexProgress(statusData, totalItems) {
  if (totalItems === 0) {
    return statusData.processedFiles > 0 ? 100 : 0;
  }
  if (statusData.status === 'complete') {
    return 100;
  }
  const processed = Number(statusData.processedFiles) || 0;
  return Math.round((processed / totalItems) * 100);
}

function generateIndexDetailsHTML(statusData, computedData) {
  const { statusClass, totalItems } = computedData;

  return [
    generateDetailItemHTML('状态', getStatusDisplayName(statusData.status), 'index-status', statusClass),
    generateDetailItemHTML('已处理', statusData.status === 'complete' ? totalItems : (statusData.processedFiles || 0), 'index-processed', 'status-success'),
    generateDetailItemHTML('FTS索引', statusData.ftsCount || 0, 'index-fts', 'status-success'),
    generateDetailItemHTML('总文件', totalItems, 'index-total')
  ].join('');
}

function renderIndexStatus(statusData) {
  const container = safeGetElementById('index-status');
  if (!container) return;

  const statsTotal = statusData.itemsStats?.reduce((sum, stat) => sum + stat.count, 0) || 0;
  const backendTotal = Number(statusData.totalFiles) || 0;
  const totalItems = backendTotal > 0 ? backendTotal : (statsTotal || statusData.ftsCount || 0);

  let processedFiles = Number(statusData.processedFiles) || 0;
  if (processedFiles === 0) {
    if (statusData.status === 'complete' && totalItems > 0) {
      processedFiles = totalItems;
    } else if (statusData.ftsCount > 0) {
      processedFiles = totalItems > 0 ? Math.min(statusData.ftsCount, totalItems) : statusData.ftsCount;
    }
  }

  let normalizedStatus = (statusData.status || '').trim();
  if (!normalizedStatus || normalizedStatus === 'unknown') {
    if (totalItems === 0 && processedFiles === 0) {
      normalizedStatus = 'idle';
    } else if (processedFiles >= totalItems && totalItems > 0) {
      normalizedStatus = 'complete';
    } else if (processedFiles > 0) {
      normalizedStatus = 'building';
    } else {
      normalizedStatus = 'pending';
    }
  }

  const normalizedStatusData = {
    ...statusData,
    status: normalizedStatus,
    processedFiles
  };

  const statusClass = getStatusClass(normalizedStatus);
  const processedPercent = calculateIndexProgress(normalizedStatusData, totalItems);

  const computedData = { statusClass, totalItems };
  const detailsHTML = generateIndexDetailsHTML(normalizedStatusData, computedData);

  const actions = [{
    action: 'sync',
    type: 'index',
    label: '重建索引',
    icon: getIconSVG('rebuild')
  }];

  const html = generateStatusCardHTML({
    loadingId: 'index-loading',
    title: '索引详细信息',
    badgeId: 'index-percent',
    percent: processedPercent,
    statusClass,
    progressId: 'index-progress-bar',
    detailsHTML,
    timestampId: 'index-last-updated',
    timestampLabel: '最后更新',
    timestamp: statusData.lastUpdated,
    actions
  });

  safeSetInnerHTML(container, html);
}

function calculateThumbnailSuccessCount(statusData) {
  const stats = statusData.stats || [];
  const successStates = ['exists', 'complete'];

  if (stats.length > 0) {
    return stats.reduce((sum, stat) => {
      return successStates.includes(stat.status) ? sum + stat.count : sum;
    }, 0);
  }

  if (statusData.fileSystemStats?.actualFiles) {
    settingsLogger.debug('使用文件系统统计作为fallback', {
      actualFiles: statusData.fileSystemStats.actualFiles
    });
    return statusData.fileSystemStats.actualFiles;
  }

  return 0;
}

function generateStatusIndicator(statusData) {
  if (statusData.autoFixed) {
    return '<span class="status-indicator status-success">已自动修复</span>';
  }
  if (statusData.usedFallback) {
    return '<span class="status-indicator status-warning">使用文件系统数据</span>';
  }
  if (statusData.error) {
    return '<span class="status-indicator status-error">数据获取失败</span>';
  }
  return '';
}

function generateThumbnailDetailsHTML(statusData, computedData) {
  const { stats, sourceTotal, total, actualSuccessCount } = computedData;

  const detailItems = [];

  if (stats.length > 0) {
    stats.forEach(stat => {
      const statusClass = getStatusClass(stat.status);
      const displayName = getStatusDisplayName(stat.status);
      detailItems.push(generateDetailItemHTML(displayName, stat.count, `thumbnail-${stat.status}`, statusClass));
    });
  } else {
    detailItems.push(generateDetailItemHTML('已生成', actualSuccessCount, 'thumbnail-exists', 'status-success'));
  }

  detailItems.push(generateDetailItemHTML('源文件总数', sourceTotal, 'thumbnail-source-total'));
  detailItems.push(generateDetailItemHTML('数据库记录', total, 'thumbnail-total'));

  if (statusData.fileSystemStats) {
    detailItems.push(generateDetailItemHTML('实际文件', statusData.fileSystemStats.actualFiles));
  }

  return detailItems.join('');
}

function renderThumbnailStatus(statusData) {
  const container = safeGetElementById('thumbnail-status');
  if (!container) return;

  settingsLogger.debug('renderThumbnailStatus接收数据', statusData);

  const sourceTotal = statusData.sourceTotal || 0;
  const total = statusData.total || 0;
  const stats = statusData.stats || [];
  const actualSuccessCount = calculateThumbnailSuccessCount(statusData);
  const completedPercent = sourceTotal > 0 ? Math.round((actualSuccessCount / sourceTotal) * 100) : 0;

  const statusIndicator = generateStatusIndicator(statusData);
  const missingCount = stats.find(stat => stat.status === 'missing')?.count || 0;
  const statusClass = missingCount > 0 ? getStatusClass('pending') : getStatusClass('complete');

  const computedData = { stats, sourceTotal, total, actualSuccessCount };
  const detailsHTML = generateThumbnailDetailsHTML(statusData, computedData);

  const actions = [
    {
      action: 'sync',
      type: 'thumbnail',
      label: '补全',
      icon: getIconSVG('paperclip')
    },
    {
      action: 'resync',
      type: 'thumbnails',
      label: '同步',
      icon: getIconSVG('sync')
    },
    {
      action: 'cleanup',
      type: 'thumbnail',
      label: '清理',
      icon: getIconSVG('trash')
    }
  ];

  const html = generateStatusCardHTML({
    loadingId: 'thumbnail-loading',
    title: `缩略图详细信息 ${statusIndicator}`,
    badgeId: 'thumbnail-percent',
    percent: completedPercent,
    statusClass,
    progressId: 'thumbnail-progress-bar',
    detailsHTML,
    timestampId: 'thumbnail-last-sync',
    timestampLabel: '最后同步',
    timestamp: statusData.lastSync,
    actions
  });

  safeSetInnerHTML(container, html);
}

function renderHlsStatus(statusData) {
  const container = safeGetElementById('hls-status');
  if (!container) return;

  const totalVideos = statusData.totalVideos || 0;
  const totalProcessed = statusData.totalProcessed || 0;
  const processedVideos = statusData.processedVideos || 0;
  const failedVideos = statusData.failedVideos || 0;
  const skippedVideos = statusData.skippedVideos || 0;

  const completedPercent = totalVideos > 0 ? Math.round((totalProcessed / totalVideos) * 100) : 100;
  const statusClass = getStatusClass(statusData.status || 'complete');

  const html = `
        <div class="status-card-new">
            <div class="card-header-new">
                <h3 class="card-title-new">HLS详细信息</h3>
                <span class="status-badge-new ${statusClass}" id="hls-percent">${completedPercent}%</span>
            </div>
            <div class="linear-progress">
                <div class="linear-progress-bar" id="hls-progress-bar" style="width: ${completedPercent}%;"></div>
            </div>
            <div class="details-grid-new">
                <div class="detail-item-new">
                    <span class="detail-label-new">状态</span>
                    <span class="detail-value-new ${statusClass}">${getStatusDisplayName(statusData.status || 'complete')}</span>
                </div>
                <div class="detail-item-new">
                    <span class="detail-label-new">成功</span>
                    <span class="detail-value-new status-success">${processedVideos}</span>
                </div>
                <div class="detail-item-new">
                    <span class="detail-label-new">失败</span>
                    <span class="detail-value-new status-error">${failedVideos}</span>
                </div>
                <div class="detail-item-new">
                    <span class="detail-label-new">跳过</span>
                    <span class="detail-value-new status-warning">${skippedVideos}</span>
                </div>
                <div class="detail-item-new">
                    <span class="detail-label-new">总视频</span>
                    <span class="detail-value-new">${totalVideos}</span>
                </div>
                <div class="detail-item-new">
                    <span class="detail-label-new">已处理</span>
                    <span class="detail-value-new status-info">${totalProcessed}</span>
                </div>
            </div>
            <div class="card-footer-new">
                <span class="timestamp-new" id="hls-last-sync">最后同步: ${statusData.lastSync ? new Date(statusData.lastSync).toLocaleString('zh-CN') : '从未'}</span>
                <div class="actions-new">
                    <button class="sync-btn" data-action="sync" data-type="hls">
                        ${getIconSVG('paperclip')}
                        <span>补全</span>
                    </button>
                    <button class="sync-btn" data-action="cleanup" data-type="hls">
                        ${getIconSVG('trash')}
                        <span>清理</span>
                    </button>
                </div>
            </div>
        </div>
    `;

  safeSetInnerHTML(container, html);
}

/**
 * 将任务状态转换为对应的 CSS 类名。
 * @param {string} status - 状态字符串
 * @returns {string} 匹配的 CSS 类名
 */
export function getStatusClass(status) {
  switch (status) {
    case 'complete':
    case 'exists':
      return 'status-success';
    case 'building':
    case 'processing':
    case 'pending':
      return 'status-warning';
    case 'error':
    case 'failed':
    case 'permanent_failed':
      return 'status-error';
    case 'no-videos':
    case 'unknown':
      return 'status-info';
    default:
      return 'status-info';
  }
}

/**
 * 提供状态的中文可读名称。
 * @param {string} status - 状态字符串
 * @returns {string} 中文描述
 */
export function getStatusDisplayName(status) {
  const names = {
    exists: '已生成',
    pending: '待处理',
    processing: '处理中',
    failed: '失败',
    permanent_failed: '损坏/永久失败',
    complete: '完成',
    building: '构建中',
    error: '错误',
    unknown: '未知',
    'no-videos': '无视频',
    missing: '缺失',
    idle: '空闲',
    running: '运行中',
    stopped: '已停止',
    ready: '就绪'
  };
  return names[status] || status;
}

/**
 * 加载并渲染设置页的状态表。
 * @param {{ silent?: boolean }} [options={}] - 控制是否静默刷新
 * @returns {Promise<void>} 渲染完成的 Promise
 */
export async function loadStatusTables(options = {}) {
  const { silent = false } = options;
  const containers = ['index-status', 'thumbnail-status', 'hls-status'];

  containers.forEach(id => {
    const container = safeGetElementById(id);
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
      const container = safeGetElementById(id);
      if (container) {
        safeSetInnerHTML(container, '');
        const errorDiv = document.createElement('div');
        errorDiv.className = 'status-loading';
        safeSetStyle(errorDiv, 'color', 'var(--red-400)');
        errorDiv.textContent = `加载失败: ${error.message}`;
        container.appendChild(errorDiv);
      }
    });
    if (!silent) {
      showNotification('加载状态表失败', 'error');
    }
  }
}

/**
 * 绑定状态页内的同步按钮事件。
 * @returns {void}
 */
export function setupSyncButtonListeners() {
  const { card } = settingsContext;
  if (!card) return;

  card.removeEventListener('click', handleStatusButtonClick);
  card.addEventListener('click', handleStatusButtonClick);
}

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

  return new Promise((resolve) => {
    showPasswordPrompt({
      useAdminSecret: true,
      onConfirm: async (adminSecret) => {
        try {
          await triggerSyncWithAuth(type, action, adminSecret);
          showNotification('重建索引已启动', 'success');
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
          safeSetInnerHTML(button, `<span class="btn-spinner"></span><span>${loadingLabel}</span>`);
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
          safeSetInnerHTML(button, `<span class="btn-spinner"></span><span>${cleanupLabel}中...</span>`);
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
            safeSetInnerHTML(button, `<span class="btn-spinner"></span><span>${resyncLabel}中...</span>`);
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
