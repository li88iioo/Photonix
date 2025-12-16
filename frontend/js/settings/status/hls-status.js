/**
 * @file status/hls-status.js
 * @description HLS状态卡片渲染
 */

import { safeSetInnerHTML } from '../../shared/dom-utils.js';
import { getStatusClass, getStatusDisplayName, getIconSVG } from './shared.js';

/**
 * 渲染 HLS 状态卡片。
 * @param {Object} statusData HLS 状态数据
 */
export function renderHlsStatus(statusData) {
    const container = document.getElementById('hls-status');
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
