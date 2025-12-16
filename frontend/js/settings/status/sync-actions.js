/**
 * @file status/sync-actions.js
 * @description 同步操作API调用和实时监控
 */

import { settingsLogger } from '../logger.js';
import { syncState, validateSyncState } from '../../core/state.js';
import { getAuthToken } from '../../app/auth.js';
import { showNotification } from '../../shared/utils.js';
import { NETWORK } from '../../core/constants.js';
import { showPodLoading, showProgressUpdate, getStatusClass } from './shared.js';

const ongoingRequests = new Map();

/**
 * 启动指定类型的同步/补全任务并显示进度。
 * @param {'index'|'thumbnail'|'hls'} type 同步任务类型
 * @param {{ loop?: boolean, silent?: boolean }} [options={}] 执行配置参数
 * @param {Function} loadStatusTables 状态刷新回调
 * @returns {Promise<Record<string, any>>} 后端返回的任务结果
 */
export async function triggerSync(type, options = {}, loadStatusTables) {
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
                silent: syncState.isSilent || false,
            }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            settingsLogger.error('补全请求失败', {
                type,
                status: response.status,
                statusText: response.statusText,
                error: errorData,
            });
            throw new Error(errorData.message || `补全失败: ${response.status}`);
        }

        const data = await response.json();

        if (!syncState.isSilent) {
            showNotification(
                `补全${type === 'index' ? '索引' : type === 'thumbnail' ? '缩略图' : 'HLS'} 成功`,
                'success',
            );
        } else if (type === 'thumbnail') {
            showNotification('缩略图后台补全已启动，将自动补全所有缺失文件', 'info');
        }

        if (loadStatusTables) {
            await loadStatusTables();
        }

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
 * @param {'index'|'thumbnail'|'hls'} type 清理任务类型
 * @param {Function} loadStatusTables 状态刷新回调
 * @returns {Promise<void>} 清理操作完成
 */
export async function triggerCleanup(type, loadStatusTables) {
    try {
        const token = getAuthToken();
        const headers = { 'Content-Type': 'application/json' };
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }

        const response = await fetch(`/api/settings/cleanup/${type}`, {
            method: 'POST',
            headers,
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `同步失败: ${response.status}`);
        }

        const data = await response.json();

        if (data.data && data.data.skipped) {
            showNotification(data.data.message, 'info');
        } else {
            showNotification(`同步${type === 'thumbnail' ? '缩略图' : 'HLS'} 成功`, 'success');
        }

        if (loadStatusTables) {
            await loadStatusTables();
        }

        return data;
    } catch (error) {
        throw error;
    }
}

/**
 * 启动缩略图批量补全任务。
 * @param {{ silent?: boolean, loop?: boolean }} [options={}] 参数
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
            silent: options.silent || false,
        };

        const response = await fetch('/api/thumbnail/batch', {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
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
 * @param {Function} loadStatusTables 状态刷新回调
 * @returns {Promise<void>} 同步完成
 */
export async function resyncThumbnails(loadStatusTables) {
    try {
        const token = getAuthToken();
        const headers = token ? { Authorization: `Bearer ${token}` } : {};

        const response = await fetch('/api/settings/resync/thumbnails', {
            method: 'POST',
            headers,
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `重同步失败: ${response.status}`);
        }

        const data = await response.json();
        showNotification(data.message || '缩略图状态重同步完成', 'success');

        if (loadStatusTables) {
            await loadStatusTables({ silent: true });
        }

        return data;
    } catch (error) {
        throw error;
    }
}

/**
 * 开启指定任务的实时状态监听。
 * @param {'index'|'thumbnail'|'hls'} type 任务类型
 */
export function startRealtimeMonitoring(type) {
    syncState.stopMonitoring();
    syncState.startMonitoring(type);
    validateSyncState();

    const intervalId = setInterval(async () => {
        try {
            const token = getAuthToken();
            const headers = token ? { Authorization: `Bearer ${token}` } : {};

            const response = await fetch('/api/settings/status-tables', { headers });

            if (response.ok) {
                const responseData = await response.json();
                // 修复：API 返回 { success, data: { index, thumbnail, hls } }
                const data = responseData.data || responseData;
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
                        percent,
                    });
                }
            }
        } catch (error) {
            // 忽略错误
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

/**
 * 实时更新状态卡片。
 * @param {'index'|'thumbnail'|'hls'} type 状态类型
 * @param {Object} data 状态数据
 */
function updateStatusRealtime(type, data) {
    const prefix = type;

    const percentElement = document.getElementById(`${prefix}-percent`);
    if (percentElement && data.percent !== undefined) {
        percentElement.textContent = `${data.percent}% `;

        const progressCircle = document.querySelector(`[data-type="${type}"] .status-chart-progress-front`);
        if (progressCircle) {
            const progressOffset = 329 - (329 * data.percent / 100);
            progressCircle.style.strokeDashoffset = progressOffset;
        }
    }

    const fields = ['processed', 'fts', 'total', 'files', 'unprocessed', 'sourceTotal'];
    fields.forEach(field => {
        if (data[field] !== undefined) {
            const element = document.getElementById(`${prefix}-${field}`);
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
            const element = document.getElementById(`${prefix}-${stat.status}`);
            if (element) {
                const statusClass = getStatusClass(stat.status);
                element.className = `status-detail-value ${statusClass}`;
                element.textContent = stat.count;
            }
        });
    }

    if (data.lastUpdated) {
        const timeElement = document.getElementById(`${prefix}-last-updated`);
        if (timeElement) {
            timeElement.textContent = new Date(data.lastUpdated).toLocaleString();
        }
    }

    if (data.lastSync) {
        const syncElement = document.getElementById(`${prefix}-last-sync`);
        if (syncElement) {
            syncElement.textContent = new Date(data.lastSync).toLocaleString();
        }
    }
}
