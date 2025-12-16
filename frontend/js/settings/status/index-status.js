/**
 * @file status/index-status.js
 * @description 索引状态卡片渲染
 */

import { safeSetInnerHTML } from '../../shared/dom-utils.js';
import { generateStatusCardHTML, generateDetailItemHTML } from '../../features/gallery/ui-components.js';
import { getStatusClass, getStatusDisplayName, getIconSVG } from './shared.js';

/**
 * 计算索引进度百分比。
 * @param {Object} statusData 索引状态
 * @param {number} totalItems 总项目数
 * @returns {number} 百分比
 */
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

/**
 * 生成索引详情的HTML内容。
 * @param {Object} statusData 状态数据
 * @param {Object} computedData 计算数据
 * @returns {string} HTML字符串
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
 * 渲染索引状态卡片。
 * @param {Object} statusData 索引状态数据
 */
export function renderIndexStatus(statusData) {
    const container = document.getElementById('index-status');
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
        processedFiles,
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
        actions,
    });

    safeSetInnerHTML(container, html);
}
