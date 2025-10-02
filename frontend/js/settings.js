// frontend/js/settings.js

import { state, syncState, validateSyncState } from './state.js';
import { fetchSettings, saveSettings, waitForSettingsUpdate, fetchAvailableModels } from './api.js';
import { showNotification } from './utils.js';
import { getAuthToken, removeAuthToken } from './auth.js';
import { UI, NETWORK, SETTINGS, isDevelopment } from './constants.js';
import { createModuleLogger } from './logger.js';
import { safeSetInnerHTML, safeSetStyle, safeClassList, safeGetElementById, safeQuerySelector, safeGetStyle } from './dom-utils.js';
import {
    generateStatusCardHTML,
    generateDetailItemHTML} from './ui-components.js';

const settingsLogger = createModuleLogger('Settings');

let modelFetchTimer = null;
let modelFetchAbortController = null;
let lastModelFetchSignature = null;


/**
 * 智能API地址补全
 * 根据用户输入自动补全API路径
 */
function setupApiUrlAutoComplete() {
    const aiUrlInput = card.querySelector('#ai-url');
    if (!aiUrlInput) return;

    // 编辑时重置模型缓存，避免使用旧签名
    aiUrlInput.addEventListener('input', () => {
        lastModelFetchSignature = null;
        if (modelFetchTimer) {
            clearTimeout(modelFetchTimer);
            modelFetchTimer = null;
        }
    });

    // 仅在失去焦点时触发补全，避免重复追加
    aiUrlInput.addEventListener('blur', (event) => {
        autoCompleteApiUrl(event.target);
        attemptModelFetch('blur');
    });
}

/**
 * 执行API地址自动补全
 * @param {HTMLInputElement} inputElement - 输入框元素
 */
function autoCompleteApiUrl(inputElement) {
    const value = inputElement.value.trim();

    // 如果为空，不进行补全
    if (!value) {
        return;
    }

    // 以#结尾：强制使用输入地址，不补全
    if (value.endsWith('#')) {
        inputElement.value = value.slice(0, -1);
        return;
    }

    // 幂等保护：若已包含聊天资源路径则不再追加
    const alreadyHasChat = /\/chat\/completions\/?$/i.test(value) || /\/v\d+\/chat\/completions\/?$/i.test(value);
    if (alreadyHasChat) {
        return;
    }

    // Gemini 地址不做补全（由后端处理版本）
    if (isGeminiApiUrl(value)) {
        return;
    }

    // 规范化去除末尾多余斜杠（用于拼接判断）
    const sanitized = value.replace(/\/+$/, '');
    const endsWithSlash = value.endsWith('/');
    const versionIncluded = /\/v\d+(?:[a-z]*)\/?$/i.test(sanitized);

    // 规则：
    // - 无尾斜杠基地址 → /v1/chat/completions
    // - 有尾斜杠基地址 → /chat/completions
    // - 末尾已带版本段（如 /v1）→ /chat/completions
    if (versionIncluded) {
        inputElement.value = `${sanitized}/chat/completions`;
        return;
    }

    if (endsWithSlash) {
        inputElement.value = `${sanitized}/chat/completions`;
        return;
    }

    inputElement.value = `${sanitized}/v1/chat/completions`;
}

function isGeminiApiUrl(value = '') {
    return /generativelanguage\.googleapis\.com/i.test(value);
}

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
        settingsLogger.error('获取状态表数据失败', error);
        throw error;
    }
}

/**
 * 触发补全操作
 */
async function triggerSync(type, options = {}) {
    try {
        // 前端不再进行权限检查，交给后端处理

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

        // 恢复实时监控，使用优化的低频率模式
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
        // 静默处理错误，不输出日志
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
        // 静默处理错误，不输出日志
        throw error;
    } finally {
        // 隐藏加载状态
        showPodLoading(type, false);
        setTimeout(() => showProgressUpdate(type, false), UI.PROGRESS_UPDATE_DELAY); // 延迟隐藏进度更新指示器
    }
}

/**
 * 触发缩略图批量补全（支持循环模式）
 */
async function triggerThumbnailBatchSync(options = {}) {
    try {
        // 前端不再进行权限检查，交给后端处理

        // 静默模式下不输出启动日志
        // 注释掉批量补全日志以减少控制台噪音
        // if (!options.silent) {
        // }

        // 验证状态设置
        validateSyncState();

        // 发送批量补全请求到正确的API端点
        const token = getAuthToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        headers['Content-Type'] = 'application/json';

        const requestBody = {
            limit: NETWORK.MAX_RETRY_ATTEMPTS * 1000,
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
        // 静默处理错误，不输出日志
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
        // 静默处理错误，不输出日志
        throw error;
    } finally {
        // 隐藏加载状态
        showPodLoading('thumbnail', false);
        setTimeout(() => showProgressUpdate('thumbnail', false), UI.PROGRESS_UPDATE_DELAY);
    }
}

/**
 * 显示/隐藏信息环加载状态
 */
function showPodLoading(type, show) {
    const loadingElement = safeGetElementById(`${type}-loading`);
    if (loadingElement) {
        safeClassList(loadingElement, 'toggle', 'active', show);
    }
}

/**
 * 显示/隐藏进度更新指示器
 */
function showProgressUpdate(type, show) {
    const updateElement = safeGetElementById(`${type}-progress-update`);
    if (updateElement) {
        safeClassList(updateElement, 'toggle', 'active', show);
    }
}

/**
 * 实时更新状态数据
 */
function updateStatusRealtime(type, data) {
    const prefix = type;

    // 更新百分比
    const percentElement = safeGetElementById(`${prefix}-percent`);
    if (percentElement && data.percent !== undefined) {
        percentElement.textContent = `${data.percent}%`;

        // 更新进度环
        const progressCircle = safeQuerySelector(`[data-type="${type}"] .status-chart-progress-front`);
        if (progressCircle) {
            const progressOffset = 329 - (329 * data.percent / 100);
            safeSetStyle(progressCircle, 'strokeDashoffset', progressOffset);
        }
    }

    // 更新状态信息
    if (data.status) {
        const statusElement = safeGetElementById(`${prefix}-status`);
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
            const element = safeGetElementById(`${prefix}-${field}`);
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
            const element = safeGetElementById(`${prefix}-${stat.status}`);
            if (element) {
                const statusClass = getStatusClass(stat.status);
                element.className = `status-detail-value ${statusClass}`;
                element.textContent = stat.count;
            }
        });
    }

    // 更新时间戳
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
 * 开始实时进度监控
 */
function startRealtimeMonitoring(type) {
    // 使用状态管理类开始监控
    syncState.startMonitoring(type);

    // 验证监控开始状态
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
                        if (totalItems > 0) {
                            if (statusData.status === 'complete') {
                                // 索引完成时，显示100%
                                percent = 100;
                            } else {
                                // 其他状态使用原来的逻辑
                                percent = Math.round((statusData.processedFiles / totalItems) * 100);
                            }
                        } else {
                            percent = 0;
                        }
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
            // 静默处理监控错误，不输出日志
        }
    }, type === 'index' ? 2000 : 10000); // 索引使用2秒间隔，其他类型使用10秒

    // 30秒后停止监控
    const timeoutId = setTimeout(() => {
        // 静默停止监控，不输出日志
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
/**
 * 计算索引进度百分比
 * @param {Object} statusData - 状态数据
 * @param {number} totalItems - 总项目数
 * @returns {number} 进度百分比
 */
function calculateIndexProgress(statusData, totalItems) {
    if (totalItems === 0) return 0;

    if (statusData.status === 'complete') {
        return 100;
    }

    return Math.round((statusData.processedFiles / totalItems) * 100);
}

/**
 * 生成索引状态详情网格HTML
 * @param {Object} statusData - 状态数据
 * @param {Object} computedData - 计算后的数据
 * @returns {string} 详情网格HTML
 */
function generateIndexDetailsHTML(statusData, computedData) {
    const { statusClass, totalItems } = computedData;

    return [
        generateDetailItemHTML('状态', getStatusDisplayName(statusData.status), 'index-status', statusClass),
        generateDetailItemHTML('已处理', statusData.status === 'complete' ? totalItems : (statusData.processedFiles || 0), 'index-processed', 'status-success'),
        generateDetailItemHTML('FTS索引', statusData.ftsCount || 0, 'index-fts', 'status-success'),
        generateDetailItemHTML('总文件', totalItems, 'index-total')
    ].join('');
}

/**
 * 渲染索引状态
 * @param {Object} statusData - 状态数据
 */
function renderIndexStatus(statusData) {
    const container = safeGetElementById('index-status');
    if (!container) return;

    // 计算基础数据
    const statusClass = getStatusClass(statusData.status);
    const totalItems = statusData.itemsStats?.reduce((sum, stat) => sum + stat.count, 0) || 0;
    const processedPercent = calculateIndexProgress(statusData, totalItems);

    // 生成详情网格
    const computedData = { statusClass, totalItems };
    const detailsHTML = generateIndexDetailsHTML(statusData, computedData);

    // 生成操作按钮
    const actions = [{
        action: 'sync',
        type: 'index',
        label: '重建索引',
        icon: getIconSVG('vortexSync')
    }];

    // 使用通用UI组件生成完整HTML
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

/**
 * 渲染缩略图状态
 */
/**
 * 计算缩略图成功数量
 * @param {Object} statusData - 状态数据
 * @returns {number} 成功数量
 */
function calculateThumbnailSuccessCount(statusData) {
    const stats = statusData.stats || [];
    const successStates = ['exists', 'complete'];

    if (stats.length > 0) {
        return stats.reduce((sum, stat) => {
            return successStates.includes(stat.status) ? sum + stat.count : sum;
        }, 0);
    }

    // 使用文件系统统计作为fallback
    if (statusData.fileSystemStats?.actualFiles) {
        settingsLogger.debug('使用文件系统统计作为fallback', {
            actualFiles: statusData.fileSystemStats.actualFiles
        });
        return statusData.fileSystemStats.actualFiles;
    }

    return 0;
}

/**
 * 生成状态指示器HTML
 * @param {Object} statusData - 状态数据
 * @returns {string} 状态指示器HTML
 */
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

/**
 * 生成缩略图详情网格HTML
 * @param {Object} statusData - 状态数据
 * @param {Object} computedData - 计算后的数据
 * @returns {string} 详情网格HTML
 */
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


/**
 * 渲染缩略图状态
 * @param {Object} statusData - 状态数据
 */
function renderThumbnailStatus(statusData) {
    const container = safeGetElementById('thumbnail-status');
    if (!container) return;

    settingsLogger.debug('renderThumbnailStatus接收数据', statusData);

    // 计算基础数据
    const sourceTotal = statusData.sourceTotal || 0;
    const total = statusData.total || 0;
    const stats = statusData.stats || [];
    const actualSuccessCount = calculateThumbnailSuccessCount(statusData);
    const completedPercent = sourceTotal > 0 ? Math.round((actualSuccessCount / sourceTotal) * 100) : 0;

    // 生成状态指示器
    const statusIndicator = generateStatusIndicator(statusData);

    // 计算状态样式
    const missingCount = stats.find(stat => stat.status === 'missing')?.count || 0;
    const statusClass = missingCount > 0 ? getStatusClass('pending') : getStatusClass('complete');

    // 生成详情网格
    const computedData = { stats, sourceTotal, total, actualSuccessCount };
    const detailsHTML = generateThumbnailDetailsHTML(statusData, computedData);

    // 生成操作按钮
    const actions = [
        {
            action: 'sync',
            type: 'thumbnail',
            label: '补全',
            icon: getIconSVG('magicSync')
        },
        {
            action: 'resync',
            type: 'thumbnails',
            label: '重同步',
            icon: getIconSVG('vortexSync')
        },
        {
            action: 'cleanup',
            type: 'thumbnail',
            label: '清理',
            icon: getIconSVG('sweepClean')
        }
    ];

    // 使用通用UI组件生成完整HTML
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

/**
 * 渲染HLS状态
 */
function renderHlsStatus(statusData) {
    const container = safeGetElementById('hls-status');
    if (!container) return;

    const totalVideos = statusData.totalVideos || 0;
    const processedVideos = statusData.processedVideos || 0;
    const failedVideos = statusData.failedVideos || 0;
    const skippedVideos = statusData.skippedVideos || 0;
    const totalProcessed = statusData.totalProcessed || 0;
    
    // 使用总处理数计算进度，而不是只计算成功的
    const completedPercent = totalVideos > 0 ? Math.round((totalProcessed / totalVideos) * 100) : 100;
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

    safeSetInnerHTML(container, html);
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
        const container = safeGetElementById(id);
        if (container && !container.innerHTML.trim()) {
            safeSetInnerHTML(container, '<div class="status-loading"><div class="spinner"></div></div>');
        }
    });

    try {
        const statusData = await fetchStatusTables();

        renderIndexStatus(statusData.index);

        // 调试缩略图数据（开发模式下）
        settingsLogger.debug('Frontend缩略图数据', statusData.thumbnail);

        renderThumbnailStatus(statusData.thumbnail);
        renderHlsStatus(statusData.hls);

        showNotification('状态表数据已更新', 'success');
    } catch (error) {
        // 显示错误状态
        containers.forEach(id => {
            const container = safeGetElementById(id);
            if (container) {
                // XSS安全修复：使用安全的DOM操作替代innerHTML
                safeSetInnerHTML(container, ''); // 清空内容
                const errorDiv = document.createElement('div');
                errorDiv.className = 'status-loading';
                safeSetStyle(errorDiv, 'color', 'var(--red-400)');
                errorDiv.textContent = `加载失败: ${error.message}`;
                container.appendChild(errorDiv);
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
    const settingsCard = safeGetElementById('settings-card');
    if (!settingsCard) return;

    // 移除之前的监听器（如果存在）
    settingsCard.removeEventListener('click', handleStatusButtonClick);
    
    // 添加事件委托监听器
    settingsCard.addEventListener('click', handleStatusButtonClick);
}

/**
 * 更新按钮可用性状态
 * 基于密码设置状态控制按钮是否可点击
 */
function updateButtonStates() {
    try {
        // 节流控制，避免频繁调用
        const now = Date.now();
        if (now - lastButtonStateUpdate < SETTINGS.BUTTON_STATE_UPDATE_THROTTLE) {
            return; // 跳过本次调用
        }
        lastButtonStateUpdate = now;

        // 检查DOM元素是否已加载
        if (!card) {
            settingsLogger.debug('设置卡片未加载，跳过按钮状态更新');
            return;
        }

        // 检查用户是否已设置访问密码
        // 注意：这里检查的是用户实际设置的密码状态，而非系统配置开关
        const hasPassword = initialSettings?.hasPassword || false;

        // 获取ADMIN_SECRET配置状态
        const isAdminSecretConfigured = initialSettings?.isAdminSecretConfigured || false;

        // 获取所有需要控制的按钮（在设置模态框内部查找）
        const syncButtons = card.querySelectorAll('.sync-btn[data-action]');

        if (syncButtons.length === 0) {
            settingsLogger.debug('未找到需要控制的按钮，跳过更新');
            return;
        }

        syncButtons.forEach(button => {
            try {
                const action = button.dataset.action;
                const type = button.dataset.type;

                // 确保必要的属性存在
                if (!action || !type) {
                    settingsLogger.debug('按钮缺少必要属性', { action, type, buttonClass: button.className });
                    return;
                }

                // 确保按钮仍然在DOM中
                if (!button.isConnected) {
                    settingsLogger.debug('按钮已从DOM中移除，跳过更新');
                    return;
                }

                if (!hasPassword) {
                    // 未设置访问密码时，显示通知并保持按钮可用（让用户点击时能看到提示）
                    button.disabled = false;
                    safeSetStyle(button, {
                        opacity: '1',
                        cursor: 'pointer',
                        filter: 'none'
                    });
                    button.setAttribute('aria-disabled', 'false');
                    safeClassList(button, 'remove', 'disabled');
                } else {
                    // 已设置密码时，正常启用按钮
                    button.disabled = false;
                    safeSetStyle(button, {
                        opacity: '1',
                        cursor: 'pointer',
                        filter: 'none'
                    });
                    button.setAttribute('aria-disabled', 'false');
                    safeClassList(button, 'remove', 'disabled');
                }

                // 设置正常的提示信息
                let tooltipText = '';
                if (type === 'index' && action === 'sync') {
                    tooltipText = '重建搜索索引';
                } else if (type === 'thumbnail') {
                    if (action === 'sync') tooltipText = '补全缺失的缩略图';
                    else if (action === 'resync') tooltipText = '重新同步缩略图状态';
                    else if (action === 'cleanup') tooltipText = '清理失效的缩略图文件';
                } else if (type === 'hls') {
                    if (action === 'sync') tooltipText = '补全缺失的HLS流';
                    else if (action === 'cleanup') tooltipText = '清理HLS缓存';
                }
                button.title = tooltipText;
            } catch (buttonError) {
                settingsLogger.warn('更新单个按钮状态失败', {
                    error: buttonError?.message,
                    buttonClass: button?.className,
                    action: button?.dataset?.action,
                    type: button?.dataset?.type
                });
            }
        });

        settingsLogger.debug('按钮状态已更新', {
            hasPassword,
            isAdminSecretConfigured,
            totalButtons: syncButtons.length
        });

        // 添加用户友好的状态提示（只在必要时显示）
        if (!hasPassword && syncButtons.length > 0) {
            // 静默处理，不输出过多日志
        }

        // 只在开发环境下输出详细状态信息
        if (isDevelopment()) {
            const buttonStates = Array.from(syncButtons).map(button => ({
                action: button.dataset.action,
                type: button.dataset.type,
                disabled: button.disabled,
                pointerEvents: safeGetStyle(button, 'pointerEvents'),
                cursor: safeGetStyle(button, 'cursor')
            }));
            settingsLogger.debug('按钮状态详情', buttonStates);
        }

        // 强制刷新按钮状态，确保样式生效
        syncButtons.forEach(button => {
            const currentDisplay = safeGetStyle(button, 'display');
            safeSetStyle(button, 'display', currentDisplay);
            button.offsetHeight; // 触发重绘
        });

    } catch (error) {
        settingsLogger.error('更新按钮状态失败', {
            error: error?.message || '未知错误',
            stack: error?.stack,
            cardExists: !!card,
            initialSettings: !!initialSettings,
            hasPassword: initialSettings?.hasPassword,
            buttonCount: card ? card.querySelectorAll('.sync-btn[data-action]').length : 0
        });
    }
}

/**
 * 处理重建索引的ADMIN_SECRET验证
 */
async function handleIndexRebuildWithAuth(type, action) {
    try {
        // 先发送普通请求检查权限，不带管理员密钥
        const result = await triggerSync(type, { loop: false, silent: false });
        // 如果成功，说明有权限且不需要管理员密钥
        return;
    } catch (error) {
        // 直接检查用户是否设置了访问密码
        const currentSettings = initialSettings || {};
        const hasPassword = currentSettings.hasPassword || false;

        if (!hasPassword) {
            // 如果用户没有设置访问密码，绝对不弹出验证框
            showNotification('需要先设置访问密码才能重建索引', 'warning');
            return;
        }

        // 🎯 如果用户设置了访问密码，才可能弹出管理员密钥验证框
        if (error.message.includes('需要管理员密钥验证') || error.message.includes('必须提供管理员密钥')) {
            // 检查是否需要ADMIN_SECRET验证
            const isAdminSecretConfigured = initialSettings?.isAdminSecretConfigured || false;

            if (!isAdminSecretConfigured) {
                // 如果没有配置ADMIN_SECRET，显示权限不足提示
                showNotification('权限不足，无法重建索引', 'error');
                return;
            }

            // 弹出管理员密钥验证框
            return new Promise((resolve, reject) => {
                showPasswordPrompt({
                    useAdminSecret: true, // 使用管理员密钥模式
            onConfirm: async (adminSecret) => {
                try {
                    // 使用管理员密钥调用重建API
                    const result = await triggerSyncWithAuth(type, action, adminSecret);
                    // 验证成功后显示成功通知
                    showNotification('重建索引已启动', 'success');
                    resolve(true); // 确保外层Promise被resolve
                    return true; // 表示验证成功
                } catch (error) {
                    if (error.message.includes('401') || error.message.includes('管理员密钥错误')) {
                        throw new Error('管理员密钥错误，请重新输入');
                    } else {
                        throw new Error('重建索引失败: ' + error.message);
                    }
                }
            },
                    onCancel: () => {
                        showNotification('操作已取消', 'info');
                        resolve(false);
                    }
                });
            });
        }

        // 如果是其他权限错误（比如没有访问密码）
        if (error.message.includes('权限不足') || error.message.includes('403')) {
            showNotification('权限不足，无法重建索引', 'error');
            return;
        }

        // 其他错误直接显示
        showNotification('重建索引失败: ' + error.message, 'error');
    }
}

/**
 * 使用管理员密钥触发同步操作
 */
async function triggerSyncWithAuth(type, action, adminSecret) {
    // 修正API路径，使用后端实际定义的路由
    const response = await fetch(`/api/settings/sync/${type}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${getAuthToken()}`,
            'X-Admin-Secret': adminSecret
        },
        body: JSON.stringify({
            action: action,
            adminSecret: adminSecret
        })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `操作失败: ${response.status}`);
    }

    const data = await response.json();
    return data;
}

/**
 * 处理状态按钮点击事件
 */
async function handleStatusButtonClick(event) {
    const button = event.target.closest('.sync-btn[data-action]');
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();

    const currentSettings = initialSettings || {};
    const hasPassword = currentSettings.hasPassword || false;

    if (!hasPassword) {
        // 未设置访问密码时，显示通知并阻止操作
        showNotification('需要先设置访问密码才能使用这些功能', 'warning');
        return;
    }

    const action = button.dataset.action;
    const type = button.dataset.type;

    if (!action || !type) return;

    try {
        switch (action) {
            case 'sync':
                // 检查是否是重建索引操作，需要特殊处理
                const isIndexRebuild = type === 'index';

                if (isIndexRebuild) {
                    // 重建索引需要管理员密钥验证
                    await handleIndexRebuildWithAuth(type, action);
                    return;
                }

                // 缩略图补全默认启用循环模式，自动补全所有缺失文件
                const isThumbnailSync = type === 'thumbnail';

                // 显示视觉反馈
                showPodLoading(type, true);
                showProgressUpdate(type, true);

                // 保存原始禁用状态，避免覆盖权限禁用
                const originalDisabled = button.disabled;
                const originalHTML = button.innerHTML;

                // 只在按钮原本未禁用时才设置为处理中状态
                if (!originalDisabled) {
                    button.disabled = true;
                    safeSetInnerHTML(button, '<span>处理中...</span>');
                }

                try {
                    if (isThumbnailSync) {
                        // 缩略图补全使用专门的批量补全API，支持循环模式
                        await triggerThumbnailBatchSync({
                            loop: true,
                            silent: false  // 改为非静默模式，显示通知
                        });
                    } else if (type === 'index') {
                        // 重建索引特殊处理
                        await handleIndexRebuildWithAuth(type, action);
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

                    // 只恢复我们临时设置的禁用状态
                    if (!originalDisabled) {
                        button.disabled = false;
                        safeSetInnerHTML(button, originalHTML);
                    }
                }
                break;
            case 'cleanup':
                // 保存原始禁用状态，避免覆盖权限禁用
                const cleanupOriginalDisabled = button.disabled;
                const cleanupOriginalHTML = button.innerHTML;

                // 只在按钮原本未禁用时才设置为处理中状态
                if (!cleanupOriginalDisabled) {
                    button.disabled = true;
                    safeSetInnerHTML(button, '<span>清理中...</span>');
                }

                try {
                    await triggerCleanup(type);
                } catch (error) {
                    // 统一错误处理，避免双重通知
                    throw error;
                } finally {
                    // 恢复按钮状态
                    button.disabled = false;
                    safeSetInnerHTML(button, cleanupOriginalHTML);
                }
                break;
            case 'resync':
                if (type === 'thumbnails') {
                    // 保存原始禁用状态，避免覆盖权限禁用
                    const resyncOriginalDisabled = button.disabled;
                    const resyncOriginalHTML = button.innerHTML;

                    // 只在按钮原本未禁用时才设置为处理中状态
                    if (!resyncOriginalDisabled) {
                        button.disabled = true;
                        safeSetInnerHTML(button, '<span>重同步中...</span>');
                    }

                    try {
                        await resyncThumbnails();
                    } catch (error) {
                        // 统一错误处理，避免双重通知
                        throw error;
                    } finally {
                        // 恢复按钮状态
                        button.disabled = false;
                        safeSetInnerHTML(button, resyncOriginalHTML);
                    }
                }
                break;
            default:
                settingsLogger.warn('未知的操作类型', { action });
        }
    } catch (error) {
        // 统一错误处理和用户友好的错误信息
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

// --- DOM元素 ---
const modal = safeGetElementById('settings-modal');           // 设置模态框
const card = safeGetElementById('settings-card');             // 设置卡片容器
const settingsTemplate = safeGetElementById('settings-form-template'); // 设置表单模板

// 按钮状态更新去重，避免频繁调用时的重复错误
let lastButtonStateUpdate = 0;
// 使用统一的配置常量

let initialSettings = {};  // 初始设置状态，用于检测变更

/**
 * AI配置本地存储工具
 * 用于在本地存储中保存和获取AI相关设置
 */

/**
 * 获取本地存储的AI设置
 * @returns {Object} AI设置对象
 */
function getLocalAISettings() {
    try {
        return JSON.parse(localStorage.getItem(SETTINGS.AI_LOCAL_KEY)) || {};
    } catch { return {}; }
}

/**
 * 保存AI设置到本地存储
 * @param {Object} obj - 要保存的AI设置对象
 */
function setLocalAISettings(obj) {
    localStorage.setItem(SETTINGS.AI_LOCAL_KEY, JSON.stringify(obj || {}));
}

// --- 核心模态框函数 ---
/**
 * 显示设置模态框
 * 加载设置数据并初始化设置界面
 */
export async function showSettingsModal() {
    // 隐藏页面滚动条
    safeClassList(document.body, 'add', 'settings-open');
    
    // 显示加载状态
    safeSetInnerHTML(card, `<div style="display:flex;justify-content:center;align-items:center;height:100%;"><div class="spinner" style="width:3rem;height:3rem;"></div></div>`);
    safeClassList(modal, 'add', 'visible');
    
    try {
        // 获取服务器设置和本地AI设置
        const settings = await fetchSettings();
        const localAI = getLocalAISettings();
        
        // 合并设置，AI功能默认关闭
        settings.AI_ENABLED = (typeof localAI.AI_ENABLED !== 'undefined') ? localAI.AI_ENABLED : 'false';
        settings.AI_URL = localAI.AI_URL ?? ''; 
        settings.AI_MODEL = localAI.AI_MODEL ?? 'gemini-1.5-flash'; 
        settings.AI_PROMPT = localAI.AI_PROMPT ?? SETTINGS.DEFAULT_AI_PROMPT; 
        settings.AI_KEY = '';

        // 保存初始设置并渲染表单
        initialSettings = { ...settings, ...localAI };
        safeSetInnerHTML(card, settingsTemplate.innerHTML);
        requestAnimationFrame(() => {
            populateForm(settings);
            setupListeners();
            setupSyncButtonListeners();
            // 默认加载状态表数据
            loadStatusTables();
        });
    } catch (error) {
        // 显示错误信息 - XSS安全修复
        safeSetInnerHTML(card, ''); // 清空内容
        const errorP = document.createElement('p');
        safeSetStyle(errorP, {
            color: 'var(--red-400)',
            textAlign: 'center'
        });
        errorP.textContent = `加载失败: ${error.message}`;
        card.appendChild(errorP);
        settingsLogger.error('加载设置失败', error);
    }
}

/**
 * 关闭设置模态框
 * 移除可见状态并在过渡动画结束后清空内容
 */
function closeSettingsModal() {
    safeClassList(modal, 'remove', 'visible');
    // 恢复页面滚动条
    safeClassList(document.body, 'remove', 'settings-open');
    modal.addEventListener('transitionend', () => {
        safeSetInnerHTML(card, '');
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

    // 🎯 智能API地址补全
    setupApiUrlAutoComplete();
    card.querySelector('#ai-key').value = '';
    card.querySelector('#ai-model').value = settings.AI_MODEL || '';
    card.querySelector('#ai-prompt').value = settings.AI_PROMPT || '';

    // 在设置加载完成后立即更新按钮状态，确保基于最新设置
    updateDynamicUI(settings.PASSWORD_ENABLED === 'true', settings.AI_ENABLED === 'true', settings.hasPassword);

    // 立即更新按钮状态
    updateButtonStates();

    // 再次延迟更新，确保所有元素都加载完成
    setTimeout(() => {
        updateButtonStates();
    }, 200);
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
        safeSetStyle(passwordSettingsGroup, 'display', isPasswordEnabled ? 'block' : 'none');
    }
    if (apiSettingsGroup) {
        safeSetStyle(apiSettingsGroup, 'display', isAiEnabled ? 'block' : 'none');
    }

    // 检查是否应禁用敏感操作
    const shouldDisable = hasPassword && !initialSettings.isAdminSecretConfigured;

    // 更新密码启用开关的状态：只改变外观，不实际禁用，以确保change事件能被触发
    safeClassList(passwordEnabledWrapper, 'toggle', 'disabled', shouldDisable);
    passwordEnabledWrapper.title = shouldDisable ? '未配置超级管理员密码，无法更改此设置' : '';

    // 更新新密码输入框的状态
    if (isPasswordEnabled) {
        newPasswordInput.disabled = shouldDisable;
        safeClassList(newPasswordWrapper, 'toggle', 'disabled', shouldDisable);
        newPasswordWrapper.title = shouldDisable ? '未配置超级管理员密码，无法更改此设置' : '';
        newPasswordInput.placeholder = hasPassword ? '新密码' : '设置新密码';
    }

    // 更新按钮可用性状态
    updateButtonStates();
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
            safeClassList(saveBtn, 'remove', 'loading');
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
    safeClassList(saveBtn, 'add', 'loading');
    saveBtn.disabled = true;

    const newPassInput = card.querySelector('#new-password');
    safeClassList(newPassInput, 'remove', 'input-error');

    const isPasswordEnabled = card.querySelector('#password-enabled').checked;
    const newPasswordValue = newPassInput.value;

    // 校验：首次启用密码必须设置新密码
    if (isPasswordEnabled && !initialSettings.hasPassword && !newPasswordValue) {
        showNotification('请设置新密码以启用密码访问', 'error');
        card.querySelector('button[data-tab="security"]').click();
        newPassInput.focus();
        safeClassList(newPassInput, 'add', 'input-error');
        safeClassList(saveBtn, 'remove', 'loading');
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
                        parts.push(status === 'success' ? '访问密码已设置，请重新登录' : status === 'timeout' ? '启用访问密码超时' : '启用访问密码失败');
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

        // 设置保存成功后立即更新按钮状态
        setTimeout(() => {
            updateButtonStates();
        }, 200);

        // 处理密码访问状态变更
        if (prevPasswordEnabled !== nextPasswordEnabled) {
            if (settingsToSend.PASSWORD_ENABLED === 'true') {
                // 启用密码访问：清除当前认证令牌，强制重新认证
                removeAuthToken();

                // 触发认证状态重新检查事件
                window.dispatchEvent(new CustomEvent('auth:statusChanged', {
                    detail: { passwordEnabled: true }
                }));

            } else {
                // 关闭密码访问：清除认证令牌并触发状态更新
                removeAuthToken();

                // 触发认证状态重新检查事件
                window.dispatchEvent(new CustomEvent('auth:statusChanged', {
                    detail: { passwordEnabled: false }
                }));

            }
        }

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
            safeClassList(target, 'add', 'input-error');
            target.focus();
        }
        safeClassList(saveBtn, 'remove', 'loading');
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
    const aiUrlInput = card.querySelector('#ai-url');
    const aiKeyInput = card.querySelector('#ai-key');
    const aiModelInput = card.querySelector('#ai-model');
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
        safeClassList(nav.querySelector('.active'), 'remove', 'active');
        panels.forEach(p => safeClassList(p, 'remove', 'active'));
        safeClassList(btn, 'add', 'active');
        safeClassList(card.querySelector(`#${btn.dataset.tab}-settings-content`), 'add', 'active');

        // 当切换到状态标签页时，重新加载状态表数据并隐藏footer
        if (btn.dataset.tab === 'status') {
            // 立即显示加载状态，避免空白
            const containers = ['index-status', 'thumbnail-status', 'hls-status'];
            containers.forEach(id => {
                const container = safeGetElementById(id);
                if (container && !container.innerHTML.trim()) {
                    safeSetInnerHTML(container, '<div class="status-loading"><div class="spinner"></div></div>');
                }
            });
            
            loadStatusTables();
            // 隐藏footer
            const footer = card.querySelector('.settings-footer');
            if (footer) {
                safeSetStyle(footer, 'display', 'none');
            }
        } else {
            // 切换到其他标签页时显示footer
            const footer = card.querySelector('.settings-footer');
            if (footer) {
                safeSetStyle(footer, 'display', '');
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
            safeClassList(newPasswordInput, 'remove', 'input-error');
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
        attemptModelFetch('toggle');
    });

    if (aiKeyInput) {
        aiKeyInput.addEventListener('input', () => {
            if (modelFetchTimer) clearTimeout(modelFetchTimer);
            modelFetchTimer = setTimeout(() => attemptModelFetch('input'), 800);
        });
        aiKeyInput.addEventListener('blur', () => attemptModelFetch('blur'));
    }

    if (aiUrlInput) {
        aiUrlInput.addEventListener('blur', () => attemptModelFetch('blur'));
    }

    if (aiModelInput) {
        aiModelInput.addEventListener('focus', () => attemptModelFetch('focus'));
    }

    setupPasswordToggles();
}

function attemptModelFetch(trigger = 'input') {
    if (!card) return;
    const aiEnabledToggle = card.querySelector('#ai-enabled');
    if (aiEnabledToggle && !aiEnabledToggle.checked) return;

    const aiUrlInput = card.querySelector('#ai-url');
    const aiKeyInput = card.querySelector('#ai-key');
    const aiModelInput = card.querySelector('#ai-model');
    if (!aiUrlInput || !aiKeyInput || !aiModelInput) return;

    const apiUrl = aiUrlInput.value.trim();
    const apiKey = aiKeyInput.value.trim();
    if (!apiUrl || !apiKey) return;

    if (trigger === 'input' && apiKey.length < 8) {
        return;
    }

    if (modelFetchTimer) clearTimeout(modelFetchTimer);
    const delay = trigger === 'blur' || trigger === 'focus' || trigger === 'toggle' ? 0 : 600;
    modelFetchTimer = setTimeout(() => fetchAndPopulateModels(apiUrl, apiKey), delay);
}

async function fetchAndPopulateModels(apiUrl, apiKey) {
    const signature = `${apiUrl}::${apiKey}`;
    if (signature === lastModelFetchSignature) {
        return;
    }

    const aiModelInput = card.querySelector('#ai-model');
    const datalist = card.querySelector('#ai-model-options');
    if (!aiModelInput || !datalist) return;

    const originalPlaceholder = aiModelInput.getAttribute('data-original-placeholder') || aiModelInput.placeholder;
    aiModelInput.setAttribute('data-original-placeholder', originalPlaceholder);
    aiModelInput.placeholder = '正在加载模型列表...';
    aiModelInput.disabled = true;

    if (modelFetchAbortController) {
        modelFetchAbortController.abort();
    }
    modelFetchAbortController = new AbortController();

    try {
        const models = await fetchAvailableModels(apiUrl, apiKey, modelFetchAbortController.signal);
        updateModelOptions(models);
        lastModelFetchSignature = signature;

        if (Array.isArray(models) && models.length > 0) {
            const existing = models.find(model => model.id === aiModelInput.value);
            if (!existing) {
                aiModelInput.value = models[0].id;
            }
            showNotification(`已加载 ${models.length} 个可用模型`, 'success');
        } else {
            showNotification('未在当前 API 中找到可用的视觉模型，请手动填写模型名称', 'warning');
        }
    } catch (error) {
        if (error?.name === 'AbortError') {
            return;
        }
        lastModelFetchSignature = null;
        showNotification(error?.message || '获取模型列表失败，请稍后重试', 'error');
        updateModelOptions([]);
    } finally {
        aiModelInput.placeholder = aiModelInput.getAttribute('data-original-placeholder') || '';
        aiModelInput.disabled = false;
        modelFetchAbortController = null;
    }
}

function updateModelOptions(models) {
    const datalist = card.querySelector('#ai-model-options');
    if (!datalist) return;

    safeSetInnerHTML(datalist, '');

    if (!Array.isArray(models) || models.length === 0) {
        return;
    }

    const fragment = document.createDocumentFragment();
    models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id || model.name || '';
        if (model.displayName && model.displayName !== option.value) {
            option.label = model.displayName;
        }
        option.textContent = model.displayName || option.value;
        fragment.appendChild(option);
    });

    datalist.appendChild(fragment);
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
        safeSetStyle(openEye, 'display', input.type === 'password' ? 'block' : 'none');
        safeSetStyle(closedEye, 'display', input.type === 'password' ? 'none' : 'block');
        icon.addEventListener('click', (e) => {
            e.stopPropagation();
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            safeSetStyle(openEye, 'display', isPassword ? 'none' : 'block');
            safeSetStyle(closedEye, 'display', isPassword ? 'block' : 'none');
            const originalColor = safeGetStyle(icon, 'color');
            safeSetStyle(icon, 'color', 'white');
            setTimeout(() => {
                safeSetStyle(icon, 'color', originalColor || '');
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
    const template = safeGetElementById('password-prompt-template');
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

    // 跟踪关闭原因
    let closeReason = 'cancel'; // 'cancel' 或 'success'

    /**
     * 关闭弹窗
     */
    const closePrompt = () => {
        safeClassList(promptElement, 'remove', 'active');
        promptElement.addEventListener('transitionend', () => promptElement.remove(), { once: true });
        // 只有在取消情况下才调用onCancel
        if (closeReason === 'cancel' && onCancel) {
            onCancel();
        }
    };

    requestAnimationFrame(() => {
        safeClassList(promptElement, 'add', 'active');
        input.focus();
    });

    // 密码可见性切换
    toggleBtn.addEventListener('click', () => {
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        safeSetStyle(toggleBtn.querySelector('.eye-open'), 'display', isPassword ? 'none' : 'block');
        safeSetStyle(toggleBtn.querySelector('.eye-closed'), 'display', isPassword ? 'block' : 'none');
        input.focus();
    });

    // 确认按钮逻辑
    confirmBtn.addEventListener('click', async () => {
        safeClassList(inputGroup, 'remove', 'error');
        errorMsg.textContent = '';
        safeClassList(cardEl, 'remove', 'shake');
        if (!input.value) {
            errorMsg.textContent = '密码不能为空。';
            safeClassList(inputGroup, 'add', 'error');
            safeClassList(cardEl, 'add', 'shake');
            input.focus();
            return;
        }
        safeClassList(confirmBtn, 'add', 'loading');
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        try {
            const success = await onConfirm(input.value);
            if (success === true) {
                safeClassList(inputGroup, 'add', 'success');
                safeClassList(confirmBtn, 'remove', 'loading');
                closeReason = 'success'; // 标记为成功关闭
                setTimeout(closePrompt, 800);
            } else {
                throw new Error("密码错误或验证失败");
            }
        } catch (err) {
            safeClassList(confirmBtn, 'remove', 'loading');
            confirmBtn.disabled = false;
            cancelBtn.disabled = false;
            safeClassList(cardEl, 'add', 'shake');
            safeClassList(inputGroup, 'add', 'error');
            errorMsg.textContent = err.message || '密码错误或验证失败';
            input.focus();
            input.select();
        }
    });

    // 输入框事件
    input.addEventListener('input', () => {
        safeClassList(inputGroup, 'remove', 'error');
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