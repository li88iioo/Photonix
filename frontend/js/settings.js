// frontend/js/settings.js

import { state, syncState, validateSyncState, cleanupSyncState } from './state.js';
import { fetchSettings, saveSettings, waitForSettingsUpdate } from './api.js';
import { showNotification } from './utils.js';
import { getAuthToken } from './auth.js';


/**
 * 获取状态表数据
 */
async function fetchStatusTables() {
    try {
        const token = getAuthToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

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
        console.error('获取状态表数据失败:', error);
        throw error;
    }
}

/**
 * 触发补全操作
 */
async function triggerSync(type, options = {}) {
    try {
        // 使用状态管理类设置静默模式
        syncState.setSilentMode(options.silent);
        const isSilentMode = syncState.isSilent;

        // 验证状态设置
        validateSyncState();

        // 非静默模式显示加载状态
        if (!isSilentMode) {
            showPodLoading(type, true);
            showProgressUpdate(type, true);
        }

        // 开始实时监控（静默模式也需要监控进度）
        startRealtimeMonitoring(type);

        const token = getAuthToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

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
            throw new Error(errorData.message || `补全失败: ${response.status}`);
        }

        const data = await response.json();

        // 非静默模式显示成功通知
        if (!syncState.isSilent) {
            showNotification(`补全${type === 'index' ? '索引' : type === 'thumbnail' ? '缩略图' : 'HLS'}成功`, 'success');
        } else if (type === 'thumbnail') {
            // 静默模式下只显示简短的后台补全开始提示
            showNotification('缩略图后台补全已启动，将自动补全所有缺失文件', 'info');
        }

        // 刷新状态数据
        await loadStatusTables();

        return data;
    } catch (error) {
        console.error(`触发${type}补全失败:`, error);
        // 静默模式下仍然显示错误通知，确保用户知道失败了
        showNotification(`补全失败: ${error.message}`, 'error');
        throw error;
    } finally {
        // 非静默模式隐藏加载状态
        if (!syncState.isSilent) {
            showPodLoading(type, false);
            // 注意：进度更新已在startRealtimeMonitoring中处理，这里不再重复
        }
    }
}

/**
 * 触发同步操作（删除冗余文件）
 */
async function triggerCleanup(type) {
    try {
        // 显示加载状态
        showPodLoading(type, true);
        showProgressUpdate(type, true);

        const token = getAuthToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

        const response = await fetch(`/api/settings/cleanup/${type}`, {
            method: 'POST',
            headers
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `同步失败: ${response.status}`);
        }

        const data = await response.json();

        // 检查是否已经同步
        if (data.data && data.data.skipped) {
            showNotification(data.data.message, 'info');
        } else {
            // 显示成功通知
            showNotification(`同步${type === 'thumbnail' ? '缩略图' : 'HLS'}成功`, 'success');
        }

        // 刷新状态数据
        await loadStatusTables();

        return data;
    } catch (error) {
        console.error(`触发${type}同步失败:`, error);
        showNotification(`同步失败: ${error.message}`, 'error');
        throw error;
    } finally {
        // 隐藏加载状态
        showPodLoading(type, false);
        setTimeout(() => showProgressUpdate(type, false), 2000); // 延迟2秒隐藏进度更新指示器
    }
}

/**
 * 触发缩略图批量补全（支持循环模式）
 */
async function triggerThumbnailBatchSync(options = {}) {
    try {
        // 静默模式下不输出启动日志
        // 注释掉批量补全日志以减少控制台噪音
        // if (!options.silent) {
        //     console.debug('[批量补全] 启动缩略图批量补全，启用循环模式');
        // }
        // console.debug('[批量补全] 接收到的参数:', options);

        // 验证状态设置
        validateSyncState();

        // 发送批量补全请求到正确的API端点
        const token = getAuthToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        headers['Content-Type'] = 'application/json';

        const requestBody = {
            limit: 1000,
            loop: options.loop || false,
            silent: options.silent || false
        };
        
        // console.debug('[批量补全] 发送的请求体:', requestBody);

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

        // 显示详细的通知信息
        const processedCount = data.data?.processed || 0;
        if (processedCount > 0) {
            showNotification(`缩略图补全已启动，正在处理 ${processedCount} 个文件`, 'success');
        } else {
            showNotification('缩略图补全已启动，正在扫描文件...', 'info');
        }

        // 启动实时监控（即使在静默模式下也需要监控进度）
        startRealtimeMonitoring('thumbnail');

        return data;
    } catch (error) {
        console.error('触发缩略图批量补全失败:', error);
        showNotification(`批量补全失败: ${error.message}`, 'error');
        throw error;
    }
}

/**
 * 重新同步缩略图状态
 */
async function resyncThumbnails() {
    try {
        // 显示加载状态
        showPodLoading('thumbnail', true);
        showProgressUpdate('thumbnail', true);

        const token = getAuthToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

        const response = await fetch('/api/settings/resync/thumbnails', {
            method: 'POST',
            headers
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `重同步失败: ${response.status}`);
        }

        const data = await response.json();

        // 显示成功通知
        showNotification(data.message || '缩略图状态重同步完成', 'success');

        // 刷新状态数据
        await loadStatusTables();

        return data;
    } catch (error) {
        console.error('缩略图状态重同步失败:', error);
        showNotification(`重同步失败: ${error.message}`, 'error');
        throw error;
    } finally {
        // 隐藏加载状态
        showPodLoading('thumbnail', false);
        setTimeout(() => showProgressUpdate('thumbnail', false), 2000);
    }
}

/**
 * 显示/隐藏信息环加载状态
 */
function showPodLoading(type, show) {
    const loadingElement = document.getElementById(`${type}-loading`);
    if (loadingElement) {
        loadingElement.classList.toggle('active', show);
    }
}

/**
 * 显示/隐藏进度更新指示器
 */
function showProgressUpdate(type, show) {
    const updateElement = document.getElementById(`${type}-progress-update`);
    if (updateElement) {
        updateElement.classList.toggle('active', show);
    }
}

/**
 * 实时更新状态数据
 */
function updateStatusRealtime(type, data) {
    const prefix = type;

    // 更新百分比
    const percentElement = document.getElementById(`${prefix}-percent`);
    if (percentElement && data.percent !== undefined) {
        percentElement.textContent = `${data.percent}%`;

        // 更新进度环
        const progressCircle = document.querySelector(`[data-type="${type}"] .status-chart-progress-front`);
        if (progressCircle) {
            const progressOffset = 329 - (329 * data.percent / 100);
            progressCircle.style.strokeDashoffset = progressOffset;
        }
    }

    // 更新状态信息
    if (data.status) {
        const statusElement = document.getElementById(`${prefix}-status`);
        if (statusElement) {
            const statusClass = getStatusClass(data.status);
            statusElement.className = `status-detail-value ${statusClass}`;
            statusElement.textContent = getStatusDisplayName(data.status);
        }
    }

    // 更新数值
    const fields = ['processed', 'fts', 'total', 'files', 'unprocessed', 'sourceTotal'];
    fields.forEach(field => {
        if (data[field] !== undefined) {
            const element = document.getElementById(`${prefix}-${field}`);
            if (element) {
                element.textContent = data[field];

                // 为processed和unprocessed添加状态颜色
                if (field === 'processed') {
                    element.className = 'status-detail-value status-success';
                } else if (field === 'unprocessed') {
                    element.className = 'status-detail-value status-warning';
                }
            }
        }
    });

    // 更新缩略图状态统计
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

    // 更新时间戳
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

/**
 * 开始实时进度监控
 */
function startRealtimeMonitoring(type) {
    // 使用状态管理类开始监控
    syncState.startMonitoring(type);

    // 验证监控开始状态
    // console.debug('[监控开始] 实时监控已启动，类型:', type);
    validateSyncState();
    
    // 设置定期更新
    const intervalId = setInterval(async () => {
        try {
            const token = getAuthToken();
            const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

            const response = await fetch('/api/settings/status-tables', {
                headers
            });

            if (response.ok) {
                const data = await response.json();
                let statusData = null;

                // 根据类型获取对应的状态数据
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
                    // 计算实时百分比
                    let percent = 0;
                    if (type === 'index') {
                        const totalItems = statusData.itemsStats?.reduce((sum, stat) => sum + stat.count, 0) || 0;
                        percent = totalItems > 0 ? Math.round((statusData.processedFiles / totalItems) * 100) : 0;
                    } else if (type === 'thumbnail') {
                        // 使用源文件总数进行准确的进度计算
                        const sourceTotal = statusData.sourceTotal || statusData.total || 0;

                        // 计算成功生成的缩略图数量
                        const successStates = ['exists', 'complete'];
                        const successCount = statusData.stats?.reduce((sum, stat) => {
                            return successStates.includes(stat.status) ? sum + stat.count : sum;
                        }, 0) || 0;

                        // fallback到旧的查找方式
                        const existsCount = statusData.stats?.find(s => s.status === 'exists')?.count || 0;
                        const actualSuccessCount = successCount > 0 ? successCount : existsCount;

                        percent = sourceTotal > 0 ? Math.round((actualSuccessCount / sourceTotal) * 100) : 0;
                    } else if (type === 'hls') {
                        const totalVideos = statusData.totalVideos || 0;
                        const processedVideos = statusData.processedVideos || 0;
                        percent = totalVideos > 0 ? Math.round((processedVideos / totalVideos) * 100) : 0;
                    }

                    // 更新实时数据
                    updateStatusRealtime(type, {
                        ...statusData,
                        percent
                    });
                }
            }
        } catch (error) {
            console.error('实时监控更新失败:', error);
        }
    }, 2000); // 每2秒更新一次

    // 30秒后停止监控
    const timeoutId = setTimeout(() => {
        console.debug('[监控结束] 30秒监控时间到，停止监控');
        // 使用状态管理类停止监控
        syncState.stopMonitoring();

        // 验证监控停止状态
        validateSyncState();

        // 根据静默模式决定是否隐藏进度更新
        if (!syncState.isSilent) {
            showProgressUpdate(type, false);
        }
    }, 30000);
    
    // 将定时器ID保存到状态管理类中
    syncState.setMonitoringTimers(intervalId, timeoutId);
}

/**
 * 获取图标SVG
 */
function getIconSVG(iconName) {
    const icons = {
        'magicSync': `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 3.5C10.5 2.5 8 2.5 6 3.5L4.5 4.5"/><path d="M3.5 12.5C5.5 13.5 8 13.5 10 12.5L11.5 11.5"/><path d="M11.5 4.5A5 5 0 0 1 11.5 11.5"/><path d="M4.5 11.5A5 5 0 0 0 4.5 4.5"/><path d="M8 5.5V4M10.5 6L11.5 5.5M12 8H13.5M10.5 10L11.5 10.5"/></svg>`,
        'vortexSync': `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 2.5A5.5 5.5 0 0 1 8 8.03A5.5 5.5 0 0 1 2.5 2.5"/><path d="M2.5 13.5A5.5 5.5 0 0 1 8 7.97A5.5 5.5 0 0 1 13.5 13.5"/><path d="M11.5 2.5h2v2"/><path d="M4.5 13.5h-2v-2"/></svg>`,
        'sweepClean': `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5C5.5 4.5 8.5 4.5 11.5 5.5"/><path d="M2.5 8C5.5 7 8.5 7 11.5 8"/><path d="M2.5 10.5C5.5 9.5 8.5 9.5 11.5 10.5"/><circle cx="13.5" cy="8" r="0.5" fill="currentColor"/><circle cx="13" cy="10.5" r="0.5" fill="currentColor"/></svg>`
    };
    return icons[iconName] || '';
}


/**
 * 渲染索引状态
 */
function renderIndexStatus(statusData) {
    const container = document.getElementById('index-status');
    if (!container) return;

    const statusClass = getStatusClass(statusData.status);
    const totalItems = statusData.itemsStats?.reduce((sum, stat) => sum + stat.count, 0) || 0;
    const processedPercent = totalItems > 0 ? Math.round((statusData.processedFiles / totalItems) * 100) : 0;

    let html = `
        <div class="status-card-new">
            <div class="status-pod-loading" id="index-loading">
                <div class="spinner"></div>
            </div>
            <div class="card-header-new">
                <h3 class="card-title-new">索引详细信息</h3>
                <span class="status-badge-new ${statusClass}" id="index-percent">${processedPercent}%</span>
            </div>
            <div class="linear-progress">
                <div class="linear-progress-bar" id="index-progress-bar" style="width: ${processedPercent}%;"></div>
            </div>
            <div class="details-grid-new">
                <div class="detail-item-new">
                    <span class="detail-label-new">状态</span>
                    <span class="detail-value-new ${statusClass}" id="index-status">${getStatusDisplayName(statusData.status)}</span>
                </div>
                <div class="detail-item-new">
                    <span class="detail-label-new">已处理</span>
                    <span class="detail-value-new status-success" id="index-processed">${statusData.processedFiles || 0}</span>
                </div>
                <div class="detail-item-new">
                    <span class="detail-label-new">FTS索引</span>
                    <span class="detail-value-new status-success" id="index-fts">${statusData.ftsCount || 0}</span>
                </div>
                <div class="detail-item-new">
                    <span class="detail-label-new">总文件</span>
                    <span class="detail-value-new" id="index-total">${totalItems}</span>
                </div>
            </div>
            <div class="card-footer-new">
                <span class="timestamp-new" id="index-last-updated">最后更新: ${statusData.lastUpdated ? new Date(statusData.lastUpdated).toLocaleString() : '从未'}</span>
            </div>
        </div>
    `;

    container.innerHTML = html;
}

/**
 * 渲染缩略图状态
 */
function renderThumbnailStatus(statusData) {
    const container = document.getElementById('thumbnail-status');
    if (!container) return;

    // 调试：输出接收到的数据（开发模式下）
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        console.debug('renderThumbnailStatus received:', statusData);
    }

    // 获取源媒体文件总数
    const sourceTotal = statusData.sourceTotal || 0;

    // 获取缩略图状态统计
    const total = statusData.total || 0;
    const stats = statusData.stats || [];

    // 计算成功生成的缩略图数量
    const successStates = ['exists', 'complete'];
    let actualSuccessCount = 0;

    if (stats.length > 0) {
        actualSuccessCount = stats.reduce((sum, stat) => {
            return successStates.includes(stat.status) ? sum + stat.count : sum;
        }, 0);
    } else if (statusData.fileSystemStats?.actualFiles) {
        // 使用文件系统统计作为fallback
        actualSuccessCount = statusData.fileSystemStats.actualFiles;
        console.debug('使用文件系统统计作为fallback:', actualSuccessCount);
    }

    // 计算完成百分比，确保不会出现除零错误
    const completedPercent = sourceTotal > 0 ? Math.round((actualSuccessCount / sourceTotal) * 100) : 0;

    // 状态指示器
    let statusIndicator = '';
    if (statusData.autoFixed) {
        statusIndicator = '<span class="status-indicator status-success">已自动修复</span>';
    } else if (statusData.usedFallback) {
        statusIndicator = '<span class="status-indicator status-warning">使用文件系统数据</span>';
    } else if (statusData.error) {
        statusIndicator = '<span class="status-indicator status-error">数据获取失败</span>';
    }

    // 计算缺失数量
    const missingCount = stats.find(stat => stat.status === 'missing')?.count || 0;
    const statusClass = missingCount > 0 ? getStatusClass('pending') : getStatusClass('complete');

    let html = `
        <div class="status-card-new">
            <div class="status-pod-loading" id="thumbnail-loading">
                <div class="spinner"></div>
            </div>
            <div class="card-header-new">
                <h3 class="card-title-new">缩略图详细信息 ${statusIndicator}</h3>
                <span class="status-badge-new ${statusClass}" id="thumbnail-percent">${completedPercent}%</span>
            </div>
            <div class="linear-progress">
                <div class="linear-progress-bar" id="thumbnail-progress-bar" style="width: ${completedPercent}%;"></div>
            </div>
            <div class="details-grid-new">
                ${stats.length > 0 ? stats.map(stat => {
                    const statusClass = getStatusClass(stat.status);
                    const displayName = getStatusDisplayName(stat.status);
                    return `
                        <div class="detail-item-new">
                            <span class="detail-label-new">${displayName}</span>
                            <span class="detail-value-new ${statusClass}" id="thumbnail-${stat.status}">${stat.count}</span>
                        </div>
                    `;
                }).join('') : `
                    <div class="detail-item-new">
                        <span class="detail-label-new">已生成</span>
                        <span class="detail-value-new status-success" id="thumbnail-exists">${actualSuccessCount}</span>
                    </div>
                `}
                <div class="detail-item-new">
                    <span class="detail-label-new">源文件总数</span>
                    <span class="detail-value-new" id="thumbnail-source-total">${sourceTotal}</span>
                </div>
                <div class="detail-item-new">
                    <span class="detail-label-new">数据库记录</span>
                    <span class="detail-value-new" id="thumbnail-total">${total}</span>
                </div>
                ${statusData.fileSystemStats ? `
                    <div class="detail-item-new">
                        <span class="detail-label-new">实际文件</span>
                        <span class="detail-value-new">${statusData.fileSystemStats.actualFiles}</span>
                    </div>
                ` : ''}
            </div>
            <div class="card-footer-new">
                <span class="timestamp-new" id="thumbnail-last-sync">最后同步: ${statusData.lastSync ? new Date(statusData.lastSync).toLocaleString() : '从未'}</span>
                <div class="actions-new">
                    <button class="sync-btn" data-action="sync" data-type="thumbnail">
                        ${getIconSVG('magicSync')}
                        <span>补全</span>
                    </button>
                    <button class="sync-btn" data-action="resync" data-type="thumbnails">
                        ${getIconSVG('vortexSync')}
                        <span>重同步</span>
                    </button>
                    <button class="sync-btn" data-action="cleanup" data-type="thumbnail">
                        ${getIconSVG('sweepClean')}
                        <span>清理</span>
                    </button>
                </div>
            </div>
        </div>
    `;

    container.innerHTML = html;
}

/**
 * 渲染HLS状态
 */
function renderHlsStatus(statusData) {
    const container = document.getElementById('hls-status');
    if (!container) return;

    const totalVideos = statusData.totalVideos || 0;
    const processedVideos = statusData.processedVideos || 0;
    const completedPercent = totalVideos > 0 ? Math.round((processedVideos / totalVideos) * 100) : 100;
    const statusClass = getStatusClass(statusData.status || 'complete');

    let html = `
        <div class="status-card-new">
            <div class="status-pod-loading" id="hls-loading">
                <div class="spinner"></div>
            </div>
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
                    <span class="detail-label-new">已处理</span>
                    <span class="detail-value-new status-success">${processedVideos}</span>
                </div>
                <div class="detail-item-new">
                    <span class="detail-label-new">总视频</span>
                    <span class="detail-value-new">${totalVideos}</span>
                </div>
            </div>
            <div class="card-footer-new">
                <span class="timestamp-new" id="hls-last-sync">最后同步: ${statusData.lastSync ? new Date(statusData.lastSync).toLocaleString('zh-CN') : '从未'}</span>
                <div class="actions-new">
                    <button class="sync-btn" data-action="sync" data-type="hls">
                        ${getIconSVG('magicSync')}
                        <span>补全</span>
                    </button>
                    <button class="sync-btn" data-action="cleanup" data-type="hls">
                        ${getIconSVG('sweepClean')}
                        <span>同步</span>
                    </button>
                </div>
            </div>
        </div>
    `;

    container.innerHTML = html;
}

/**
 * 获取状态对应的CSS类名
 */
function getStatusClass(status) {
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
            return 'status-error';
        case 'no-videos':
        case 'unknown':
            return 'status-info';
        default:
            return 'status-info';
    }
}

/**
 * 获取状态的显示名称
 */
function getStatusDisplayName(status) {
    const names = {
        'exists': '已生成',
        'pending': '待处理',
        'processing': '处理中',
        'failed': '失败',
        'complete': '完成',
        'building': '构建中',
        'error': '错误',
        'unknown': '未知',
        'no-videos': '无视频',
        'missing': '缺失',
        'idle': '空闲',
        'running': '运行中',
        'stopped': '已停止',
        'ready': '就绪'
    };
    return names[status] || status;
}

/**
 * 加载状态表数据
 */
async function loadStatusTables() {
    const containers = ['index-status', 'thumbnail-status', 'hls-status'];

    // 只在容器为空时显示加载状态，避免重复显示
    containers.forEach(id => {
        const container = document.getElementById(id);
        if (container && !container.innerHTML.trim()) {
            container.innerHTML = '<div class="status-loading"><div class="spinner"></div></div>';
        }
    });

    try {
        const statusData = await fetchStatusTables();

        renderIndexStatus(statusData.index);

        // 调试缩略图数据（开发模式下）
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            console.debug('Frontend thumbnail data:', statusData.thumbnail);
        }

        renderThumbnailStatus(statusData.thumbnail);
        renderHlsStatus(statusData.hls);

        showNotification('状态表数据已更新', 'success');
    } catch (error) {
        // 显示错误状态
        containers.forEach(id => {
            const container = document.getElementById(id);
            if (container) {
                container.innerHTML = `<div class="status-loading" style="color: var(--red-400);">加载失败: ${error.message}</div>`;
            }
        });
        showNotification('加载状态表失败', 'error');
    }
}

/**
 * 设置补全按钮事件监听器
 */
function setupSyncButtonListeners() {
    // 使用事件委托处理所有状态操作按钮
    const settingsCard = document.getElementById('settings-card');
    if (!settingsCard) return;

    // 移除之前的监听器（如果存在）
    settingsCard.removeEventListener('click', handleStatusButtonClick);
    
    // 添加事件委托监听器
    settingsCard.addEventListener('click', handleStatusButtonClick);
}

/**
 * 处理状态按钮点击事件
 */
async function handleStatusButtonClick(event) {
    const button = event.target.closest('.sync-btn[data-action]');
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();

    const action = button.dataset.action;
    const type = button.dataset.type;

    if (!action || !type) return;

    try {
        switch (action) {
            case 'sync':
                // 缩略图补全默认启用循环模式，自动补全所有缺失文件
                const isThumbnailSync = type === 'thumbnail';
                // console.debug('[状态按钮] 点击事件:', { action, type, isThumbnailSync });

                // 显示视觉反馈
                showPodLoading(type, true);
                showProgressUpdate(type, true);

                // 禁用按钮防止重复点击
                const originalHTML = button.innerHTML;
                button.disabled = true;
                button.innerHTML = '<span>处理中...</span>';

                try {
                    if (isThumbnailSync) {
                        // 缩略图补全使用专门的批量补全API，支持循环模式
                        // console.debug('[状态按钮] 调用缩略图批量补全，参数: {loop: true, silent: false}');
                        await triggerThumbnailBatchSync({
                            loop: true,
                            silent: false  // 改为非静默模式，显示通知
                        });
                    } else {
                        await triggerSync(type, {
                            loop: false,
                            silent: false
                        });
                    }
                } finally {
                    // 隐藏视觉反馈
                    showPodLoading(type, false);
                    setTimeout(() => showProgressUpdate(type, false), 2000);

                    // 恢复按钮状态
                    button.disabled = false;
                    button.innerHTML = originalHTML;
                }
                break;
            case 'cleanup':
                // 禁用按钮防止重复点击
                const cleanupOriginalHTML = button.innerHTML;
                button.disabled = true;
                button.innerHTML = '<span>清理中...</span>';

                try {
                    await triggerCleanup(type);
                } finally {
                    // 恢复按钮状态
                    button.disabled = false;
                    button.innerHTML = cleanupOriginalHTML;
                }
                break;
            case 'resync':
                if (type === 'thumbnails') {
                    // 禁用按钮防止重复点击
                    const resyncOriginalHTML = button.innerHTML;
                    button.disabled = true;
                    button.innerHTML = '<span>重同步中...</span>';

                    try {
                        await resyncThumbnails();
                    } finally {
                        // 恢复按钮状态
                        button.disabled = false;
                        button.innerHTML = resyncOriginalHTML;
                    }
                }
                break;
            default:
                console.warn('未知的操作类型:', action);
        }
    } catch (error) {
        console.error('状态操作失败:', error);
        showNotification(`操作失败: ${error.message}`, 'error');
    }
}

// --- DOM元素 ---
const modal = document.getElementById('settings-modal');           // 设置模态框
const card = document.getElementById('settings-card');             // 设置卡片容器
const settingsTemplate = document.getElementById('settings-form-template'); // 设置表单模板

let initialSettings = {};  // 初始设置状态，用于检测变更

/**
 * AI配置本地存储工具
 * 用于在本地存储中保存和获取AI相关设置
 */
const AI_LOCAL_KEY = 'ai_settings';  // AI设置的本地存储键名

/**
 * 获取本地存储的AI设置
 * @returns {Object} AI设置对象
 */
function getLocalAISettings() {
    try {
        return JSON.parse(localStorage.getItem(AI_LOCAL_KEY)) || {};
    } catch { return {}; }
}

/**
 * 保存AI设置到本地存储
 * @param {Object} obj - 要保存的AI设置对象
 */
function setLocalAISettings(obj) {
    localStorage.setItem(AI_LOCAL_KEY, JSON.stringify(obj || {}));
}

/**
 * AI提示词默认值
 * 定义AI对话的默认提示模板
 */
const DEFAULT_AI_PROMPT = `请你扮演这张照片中的人物，以第一人称的视角，对正在看照片的我说话。
你的任务是：
1.  仔细观察你的着装、姿态、表情和周围的环境。
2.  基于这些观察，构思一个符合你当前人设和心境的对话。
3.  你的话语可以是对我的邀请、提问，也可以是分享你此刻的感受或一个只属于我们之间的小秘密。
4.  语言风格要自然、有代入感，就像我们正在面对面交流。
5.  请直接开始对话，不要有任何前缀，比如“你好”或“嗨”。
6.  总字数控制在80字以内。
7.  中文回复。`;

// --- 核心模态框函数 ---
/**
 * 显示设置模态框
 * 加载设置数据并初始化设置界面
 */
export async function showSettingsModal() {
    // 隐藏页面滚动条
    document.body.classList.add('settings-open');
    
    // 显示加载状态
    card.innerHTML = `<div style="display:flex;justify-content:center;align-items:center;height:100%;"><div class="spinner" style="width:3rem;height:3rem;"></div></div>`;
    modal.classList.add('visible');
    
    try {
        // 获取服务器设置和本地AI设置
        const settings = await fetchSettings();
        const localAI = getLocalAISettings();
        
        // 合并设置，AI功能默认关闭
        settings.AI_ENABLED = (typeof localAI.AI_ENABLED !== 'undefined') ? localAI.AI_ENABLED : 'false';
        settings.AI_URL = localAI.AI_URL ?? ''; 
        settings.AI_MODEL = localAI.AI_MODEL ?? 'gemini-2.0-flash'; 
        settings.AI_PROMPT = localAI.AI_PROMPT ?? DEFAULT_AI_PROMPT; 
        settings.AI_KEY = '';

        // 保存初始设置并渲染表单
        initialSettings = { ...settings, ...localAI };
        card.innerHTML = settingsTemplate.innerHTML;
        requestAnimationFrame(() => {
            populateForm(settings);
            setupListeners();
            setupSyncButtonListeners();
            // 默认加载状态表数据
            loadStatusTables();
        });
    } catch (error) {
        // 显示错误信息
        card.innerHTML = `<p style="color:var(--red-400);text-align:center;">加载失败: ${error.message}</p>`;
        console.error("加载设置失败:", error);
    }
}

/**
 * 关闭设置模态框
 * 移除可见状态并在过渡动画结束后清空内容
 */
function closeSettingsModal() {
    modal.classList.remove('visible');
    // 恢复页面滚动条
    document.body.classList.remove('settings-open');
    modal.addEventListener('transitionend', () => {
        card.innerHTML = '';
    }, { once: true });
}

// --- 表单与数据处理 ---
/**
 * 根据设置对象填充表单内容
 * @param {Object} settings - 设置数据对象
 */
function populateForm(settings) {
    card.querySelector('#password-enabled').checked = settings.PASSWORD_ENABLED === 'true';
    card.querySelector('#ai-enabled').checked = settings.AI_ENABLED === 'true';
    card.querySelector('#ai-url').value = settings.AI_URL || '';
    card.querySelector('#ai-key').value = '';
    card.querySelector('#ai-model').value = settings.AI_MODEL || '';
    card.querySelector('#ai-prompt').value = settings.AI_PROMPT || '';
    updateDynamicUI(settings.PASSWORD_ENABLED === 'true', settings.AI_ENABLED === 'true', settings.hasPassword);
}

/**
 * 根据当前开关状态动态显示/隐藏相关设置区域
 * @param {boolean} isPasswordEnabled - 是否启用密码
 * @param {boolean} isAiEnabled - 是否启用AI
 * @param {boolean} hasPassword - 是否已设置过密码
 */
function updateDynamicUI(isPasswordEnabled, isAiEnabled, hasPassword) {
    const passwordSettingsGroup = card.querySelector('#password-settings-group');
    const apiSettingsGroup = card.querySelector('#api-settings-group');
    const newPasswordInput = card.querySelector('#new-password');
    const passwordEnabledWrapper = card.querySelector('#password-enabled-wrapper');
    const newPasswordWrapper = card.querySelector('#new-password-wrapper');

    // 根据总开关决定是否显示密码设置组和AI设置组
    if (passwordSettingsGroup) {
        passwordSettingsGroup.style.display = isPasswordEnabled ? 'block' : 'none';
    }
    if (apiSettingsGroup) {
        apiSettingsGroup.style.display = isAiEnabled ? 'block' : 'none';
    }

    // 检查是否应禁用敏感操作
    const shouldDisable = hasPassword && !initialSettings.isAdminSecretConfigured;

    // 更新密码启用开关的状态：只改变外观，不实际禁用，以确保change事件能被触发
    passwordEnabledWrapper.classList.toggle('disabled', shouldDisable);
    passwordEnabledWrapper.title = shouldDisable ? '未配置超级管理员密码，无法更改此设置' : '';

    // 更新新密码输入框的状态
    if (isPasswordEnabled) {
        newPasswordInput.disabled = shouldDisable;
        newPasswordWrapper.classList.toggle('disabled', shouldDisable);
        newPasswordWrapper.title = shouldDisable ? '未配置超级管理员密码，无法更改此设置' : '';
        newPasswordInput.placeholder = hasPassword ? '新密码' : '设置新密码';
    }
}

/**
 * 检查表单内容是否有变更，控制保存按钮状态
 */
function checkForChanges() {
    const saveBtn = card.querySelector('.save-btn');
    if (!saveBtn) return;
    const currentData = {
        PASSWORD_ENABLED: card.querySelector('#password-enabled').checked,
        AI_ENABLED: card.querySelector('#ai-enabled').checked,
        AI_URL: card.querySelector('#ai-url').value,
        AI_MODEL: card.querySelector('#ai-model').value,
        AI_PROMPT: card.querySelector('#ai-prompt').value,
    };
    let hasChanged = false;
    if (String(currentData.PASSWORD_ENABLED) !== String(initialSettings.PASSWORD_ENABLED === 'true') ||
        String(currentData.AI_ENABLED) !== String(initialSettings.AI_ENABLED === 'true') ||
        currentData.AI_URL !== initialSettings.AI_URL ||
        currentData.AI_MODEL !== initialSettings.AI_MODEL ||
        currentData.AI_PROMPT !== initialSettings.AI_PROMPT) {
        hasChanged = true;
    }
    if (card.querySelector('#new-password').value || card.querySelector('#ai-key').value) {
        hasChanged = true;
    }
    // 移除无条件启用：仅当确有变更或填写了敏感字段时，才启用保存
    saveBtn.disabled = !hasChanged;
}

async function handleSave() {
    const saveBtn = card.querySelector('.save-btn');
    const newPassInput = card.querySelector('#new-password');
    const isPasswordEnabled = card.querySelector('#password-enabled').checked;
    const newPasswordValue = newPassInput.value;

    // 检查是否为需要管理员权限的敏感操作
    const isChangingPassword = isPasswordEnabled && newPasswordValue.trim() !== '' && initialSettings.hasPassword;
    const isDisablingPassword = !isPasswordEnabled && initialSettings.hasPassword;
    const needsAdmin = isChangingPassword || isDisablingPassword;

    if (needsAdmin) {
        if (!initialSettings.isAdminSecretConfigured) {
            showNotification('操作失败：未配置超级管理员密码', 'error');
            saveBtn.classList.remove('loading');
            saveBtn.disabled = false;
            return;
        }

        showPasswordPrompt({
            useAdminSecret: true,
            onConfirm: async (adminSecret) => {
                // 直接返回 executeSave 的执行结果
                return await executeSave(adminSecret);
            }
        });
    } else {
        await executeSave();
    }
}

async function executeSave(adminSecret = null) {
    const saveBtn = card.querySelector('.save-btn');
    saveBtn.classList.add('loading');
    saveBtn.disabled = true;

    const newPassInput = card.querySelector('#new-password');
    newPassInput.classList.remove('input-error');

    const isPasswordEnabled = card.querySelector('#password-enabled').checked;
    const newPasswordValue = newPassInput.value;

    // 校验：首次启用密码必须设置新密码
    if (isPasswordEnabled && !initialSettings.hasPassword && !newPasswordValue) {
        showNotification('请设置新密码以启用密码访问', 'error');
        card.querySelector('button[data-tab="security"]').click();
        newPassInput.focus();
        newPassInput.classList.add('input-error');
        saveBtn.classList.remove('loading');
        saveBtn.disabled = false;
        return false; // 修复：返回 false 表示操作失败
    }

    // 组装本地AI设置
    const localAI = {
        AI_ENABLED: String(card.querySelector('#ai-enabled').checked),
        AI_URL: card.querySelector('#ai-url').value.trim(),
        AI_MODEL: card.querySelector('#ai-model').value.trim(),
        AI_PROMPT: card.querySelector('#ai-prompt').value.trim(),
    };
    const newApiKey = card.querySelector('#ai-key').value;
    if (newApiKey) {
        localAI.AI_KEY = newApiKey;
    } else {
        const oldAI = getLocalAISettings();
        if (oldAI.AI_KEY) localAI.AI_KEY = oldAI.AI_KEY;
    }
    setLocalAISettings(localAI);

    // 组装要发送到后端的设置
    const settingsToSend = {
        PASSWORD_ENABLED: String(isPasswordEnabled),
    };
    if (newPasswordValue) {
        settingsToSend.newPassword = newPasswordValue;
    }
    if (adminSecret) {
        settingsToSend.adminSecret = adminSecret;
    }

    try {
        const result = await saveSettings(settingsToSend);

        // 行为判定：用于细分通知
        const prevPasswordEnabled = String(initialSettings.PASSWORD_ENABLED) === 'true';
        const nextPasswordEnabled = isPasswordEnabled;
        const aiPrevEnabled = String(initialSettings.AI_ENABLED) === 'true';
        const aiNextEnabled = String(card.querySelector('#ai-enabled').checked) === 'true';
        const newPassProvided = !!newPasswordValue.trim();

        const actions = [];
        if (prevPasswordEnabled !== nextPasswordEnabled) {
            actions.push(nextPasswordEnabled ? 'enable_password' : 'disable_password');
        } else if (nextPasswordEnabled && newPassProvided) {
            actions.push('change_password');
        }
        if (aiPrevEnabled !== aiNextEnabled) {
            actions.push(aiNextEnabled ? 'enable_ai' : 'disable_ai');
        }

        const buildMessage = (status, extraMsg) => {
            const parts = [];
            for (const act of actions) {
                switch (act) {
                    case 'enable_password':
                        parts.push(status === 'success' ? '访问密码已设置' : status === 'timeout' ? '启用访问密码超时' : '启用访问密码失败');
                        break;
                    case 'disable_password':
                        parts.push(status === 'success' ? '访问密码已关闭' : status === 'timeout' ? '关闭访问密码超时' : '关闭访问密码失败');
                        break;
                    case 'change_password':
                        parts.push(status === 'success' ? '访问密码已修改' : status === 'timeout' ? '修改访问密码超时' : '修改访问密码失败');
                        break;
                    case 'enable_ai':
                        parts.push(status === 'success' ? 'AI密语功能已打开' : status === 'timeout' ? '开启 AI 密语功能超时' : '开启 AI 密语功能失败');
                        break;
                    case 'disable_ai':
                        parts.push(status === 'success' ? 'AI密语功能已关闭' : status === 'timeout' ? '关闭 AI 密语功能超时' : '关闭 AI 密语功能失败');
                        break;
                }
            }
            if (parts.length === 0) {
                // 回退：无识别到的动作
                parts.push(status === 'success' ? '设置更新成功' : status === 'timeout' ? '设置更新超时' : (extraMsg || '设置更新失败'));
            }
            if (extraMsg && status !== 'success') parts.push(extraMsg);
            return parts.join('；');
        };

        // 如果后端采用异步队列，返回202 + updateId，主动轮询直到完成
        if (result && result.status === 'pending' && result.updateId) {
            const { final, info } = await waitForSettingsUpdate(result.updateId, { intervalMs: 1000, timeoutMs: 30000 });
            if (final === 'success') {
                showNotification(buildMessage('success'), 'success');
            } else if (final === 'failed') {
                const extra = (info && info.message) ? info.message : null;
                showNotification(buildMessage('failed', extra), 'error');
            } else if (final === 'timeout') {
                showNotification(buildMessage('timeout'), 'warn');
            } else {
                const msg = info && info.message ? info.message : '设置更新发生错误';
                showNotification(buildMessage('failed', msg), 'error');
            }
        } else {
            // 立即返回成功的情形（当前主要用于非认证项；保持与细分提示一致）
            showNotification(buildMessage('success', result && result.message), 'success');
        }
        
        // 立即更新state，确保设置实时生效
        state.update('aiEnabled', localAI.AI_ENABLED === 'true');
        state.update('passwordEnabled', settingsToSend.PASSWORD_ENABLED === 'true');
        
        // 触发设置变更事件，通知其他组件
        window.dispatchEvent(new CustomEvent('settingsChanged', {
            detail: {
                aiEnabled: localAI.AI_ENABLED === 'true',
                passwordEnabled: settingsToSend.PASSWORD_ENABLED === 'true',
                aiSettings: localAI
            }
        }));
        
        // 延迟关闭设置模态框，让密码模态框先关闭
        setTimeout(closeSettingsModal, 1000);
        return true; // 新增：成功时返回 true
    } catch (error) {
        showNotification(error.message, 'error');
        if (error.message.includes('密码')) {
            const oldPassInput = card.querySelector('#old-password');
            const target = (error.message.includes('旧密码') && oldPassInput) ? oldPassInput : newPassInput;
            target.classList.add('input-error');
            target.focus();
        }
        saveBtn.classList.remove('loading');
        checkForChanges();
        return false; // 新增：失败时返回 false
    }
}

// --- 事件监听与交互 ---
/**
 * 设置界面所有事件监听器的初始化
 * 包括tab切换、保存、取消、输入变更等
 */
function setupListeners() {
    const nav = card.querySelector('.settings-nav');
    const panels = card.querySelectorAll('.settings-tab-content');
    const passwordEnabledToggle = card.querySelector('#password-enabled');
    const aiEnabledToggle = card.querySelector('#ai-enabled');
    const newPasswordInput = card.querySelector('#new-password');
    const newPasswordWrapper = card.querySelector('#new-password-wrapper');

    // 当新密码输入框的容器被点击时，如果输入框被禁用，则显示通知
    newPasswordWrapper.addEventListener('click', (e) => {
        if (newPasswordInput.disabled) {
            e.preventDefault();
            showNotification('未配置超级管理员密码，无法更改此设置', 'error');
        }
    });

    // Tab 切换
    nav.addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn) return;
        nav.querySelector('.active').classList.remove('active');
        panels.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        card.querySelector(`#${btn.dataset.tab}-settings-content`).classList.add('active');

        // 当切换到状态标签页时，重新加载状态表数据并隐藏footer
        if (btn.dataset.tab === 'status') {
            // 立即显示加载状态，避免空白
            const containers = ['index-status', 'thumbnail-status', 'hls-status'];
            containers.forEach(id => {
                const container = document.getElementById(id);
                if (container && !container.innerHTML.trim()) {
                    container.innerHTML = '<div class="status-loading"><div class="spinner"></div></div>';
                }
            });
            
            loadStatusTables();
            // 隐藏footer
            const footer = card.querySelector('.settings-footer');
            if (footer) {
                footer.style.display = 'none';
            }
        } else {
            // 切换到其他标签页时显示footer
            const footer = card.querySelector('.settings-footer');
            if (footer) {
                footer.style.display = '';
            }
        }
    });

    // 关闭与取消按钮
    card.querySelector('.close-btn').addEventListener('click', closeSettingsModal);
    card.querySelector('.cancel-btn').addEventListener('click', closeSettingsModal);
    card.querySelector('.save-btn').addEventListener('click', handleSave);

    // 输入变更检测 (通用)
    card.querySelectorAll('input:not(#password-enabled), textarea').forEach(el => {
        el.addEventListener('input', checkForChanges);
        el.addEventListener('change', checkForChanges);
    });

    // 新密码输入框的错误样式处理
    if(newPasswordInput) {
        newPasswordInput.addEventListener('input', () => {
            newPasswordInput.classList.remove('input-error');
        });
    }

    // --- 密码开关的特殊处理 ---
    // 1. 使用 click 事件在 'change' 事件触发前进行拦截
    passwordEnabledToggle.addEventListener('click', e => {
        const shouldBeDisabled = initialSettings.hasPassword && !initialSettings.isAdminSecretConfigured;

        // 如果开关当前是勾选状态，且应该被禁用，那么用户的意图是取消勾选。我们阻止这个行为。
        if (e.target.checked && shouldBeDisabled) {
            e.preventDefault(); // 这会阻止开关状态的改变，因此 'change' 事件不会触发
            showNotification('未配置超级管理员密码，无法更改此设置', 'error');
        }
    });

    // 2. 'change' 事件只在合法的状态改变后触发
    passwordEnabledToggle.addEventListener('change', e => {
        updateDynamicUI(e.target.checked, aiEnabledToggle.checked, initialSettings.hasPassword);
        checkForChanges(); // 合法改变，检查并更新保存按钮状态
    });

    // AI 开关逻辑
    aiEnabledToggle.addEventListener('change', e => {
        updateDynamicUI(passwordEnabledToggle.checked, e.target.checked, initialSettings.hasPassword);
        checkForChanges(); // AI开关总是合法的，检查并更新保存按钮状态
    });

    setupPasswordToggles();
}

/**
 * 密码输入框显示/隐藏切换功能
 * 绑定眼睛图标点击事件
 */
function setupPasswordToggles() {
    const wrappers = card.querySelectorAll('.password-wrapper');
    wrappers.forEach(wrapper => {
        const input = wrapper.querySelector('input');
        const icon = wrapper.querySelector('.password-toggle-icon');
        if (!input || !icon) return;
        const openEye = icon.querySelector('.eye-open');
        const closedEye = icon.querySelector('.eye-closed');
        openEye.style.display = input.type === 'password' ? 'block' : 'none';
        closedEye.style.display = input.type === 'password' ? 'none' : 'block';
        icon.addEventListener('click', (e) => {
            e.stopPropagation();
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            openEye.style.display = isPassword ? 'none' : 'block';
            closedEye.style.display = isPassword ? 'block' : 'none';
            const originalColor = icon.style.color;
            icon.style.color = 'white';
            setTimeout(() => {
                icon.style.color = originalColor || '';
            }, 200);
        });
    });
}

// --- 工具函数 ---

/**
 * 显示密码或管理员密钥验证弹窗
 * @param {Object} param0 - 配置对象，包含onConfirm和onCancel回调
 */
function showPasswordPrompt({ onConfirm, onCancel, useAdminSecret = false }) {
    const template = document.getElementById('password-prompt-template');
    if (!template) return;
    const promptElement = template.content.cloneNode(true).firstElementChild;
    document.body.appendChild(promptElement);

    const title = promptElement.querySelector('h3');
    const description = promptElement.querySelector('.password-prompt-description');
    const input = promptElement.querySelector('#prompt-password-input');

    if (useAdminSecret) {
        title.textContent = '需要管理员权限';
        description.textContent = '请输入管理员密钥以继续操作。';
        input.placeholder = '管理员密钥';
    } else {
        title.textContent = '身份验证';
        description.textContent = '请输入您的密码以继续操作。';
        input.placeholder = '密码';
    }

    const cardEl = promptElement.querySelector('.password-prompt-card');
    const inputGroup = promptElement.querySelector('.input-group');
    const errorMsg = promptElement.querySelector('#prompt-error-message');
    const confirmBtn = promptElement.querySelector('.confirm-btn');
    const cancelBtn = promptElement.querySelector('.cancel-btn');
    const toggleBtn = promptElement.querySelector('.password-toggle-btn');

    /**
     * 关闭弹窗
     */
    const closePrompt = () => {
        promptElement.classList.remove('active');
        promptElement.addEventListener('transitionend', () => promptElement.remove(), { once: true });
        if (onCancel) onCancel();
    };

    requestAnimationFrame(() => {
        promptElement.classList.add('active');
        input.focus();
    });

    // 密码可见性切换
    toggleBtn.addEventListener('click', () => {
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        toggleBtn.querySelector('.eye-open').style.display = isPassword ? 'none' : 'block';
        toggleBtn.querySelector('.eye-closed').style.display = isPassword ? 'block' : 'none';
        input.focus();
    });

    // 确认按钮逻辑
    confirmBtn.addEventListener('click', async () => {
        inputGroup.classList.remove('error');
        errorMsg.textContent = '';
        cardEl.classList.remove('shake');
        if (!input.value) {
            errorMsg.textContent = '密码不能为空。';
            inputGroup.classList.add('error');
            cardEl.classList.add('shake');
            input.focus();
            return;
        }
        confirmBtn.classList.add('loading');
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        try {
            const success = await onConfirm(input.value);
            if (success === true) {
                inputGroup.classList.add('success');
                confirmBtn.classList.remove('loading');
                setTimeout(closePrompt, 800);
            } else {
                throw new Error("密码错误或验证失败");
            }
        } catch (err) {
            confirmBtn.classList.remove('loading');
            confirmBtn.disabled = false;
            cancelBtn.disabled = false;
            cardEl.classList.add('shake');
            inputGroup.classList.add('error');
            errorMsg.textContent = err.message || '密码错误或验证失败';
            input.focus();
            input.select();
        }
    });

    // 输入框事件
    input.addEventListener('input', () => {
        inputGroup.classList.remove('error');
        errorMsg.textContent = '';
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmBtn.click(); });
    cancelBtn.addEventListener('click', closePrompt);
    promptElement.addEventListener('click', (e) => { if (e.target === promptElement) closePrompt(); });
    
    // ESC键关闭弹窗
    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            closePrompt();
            document.removeEventListener('keydown', escapeHandler);
        }
    };
    document.addEventListener('keydown', escapeHandler);
}

// --- 导出 ---
export { getLocalAISettings, setLocalAISettings };

// 将关键函数暴露到全局作用域供HTML onclick使用
window.triggerSync = triggerSync;
window.showPodLoading = showPodLoading;