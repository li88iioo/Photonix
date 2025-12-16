/**
 * @file status/thumbnail-status.js
 * @description 缩略图状态卡片渲染
 */

import { settingsLogger } from '../logger.js';
import { safeSetInnerHTML } from '../../shared/dom-utils.js';
import { generateStatusCardHTML, generateDetailItemHTML } from '../../features/gallery/ui-components.js';
import { getStatusClass, getStatusDisplayName, getIconSVG } from './shared.js';

/**
 * 计算缩略图已处理(success)数量。
 * @param {Object} statusData 缩略图状态
 * @returns {number} 已处理数量
 */
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
            actualFiles: statusData.fileSystemStats.actualFiles,
        });
        return statusData.fileSystemStats.actualFiles;
    }

    return 0;
}

/**
 * 生成状态卡片上的额外状态标识。
 * @param {Object} statusData 状态数据
 * @returns {string} HTML内容
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
 * 生成缩略图详情HTML内容。
 * @param {Object} statusData 状态数据
 * @param {Object} computedData 计算数据
 * @returns {string} HTML字符串
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
 * 渲染缩略图状态卡片。
 * @param {Object} statusData 缩略图状态数据
 */
export function renderThumbnailStatus(statusData) {
    const container = document.getElementById('thumbnail-status');
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
            icon: getIconSVG('paperclip'),
        },
        {
            action: 'resync',
            type: 'thumbnails',
            label: '同步',
            icon: getIconSVG('sync'),
        },
        {
            action: 'cleanup',
            type: 'thumbnail',
            label: '清理',
            icon: getIconSVG('trash'),
        },
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
        actions,
    });

    safeSetInnerHTML(container, html);
}
