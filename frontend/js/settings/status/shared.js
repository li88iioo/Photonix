/**
 * @file status/shared.js
 * @description 状态管理共享工具函数
 */

import settingsContext from '../context.js';
import { settingsLogger } from '../logger.js';
import { getAuthToken } from '../../app/auth.js';
import { safeSetInnerHTML } from '../../shared/dom-utils.js';

/**
 * 控制指定类型的加载动画显示。
 * @param {'index'|'thumbnail'|'hls'} type 任务类型
 * @param {boolean} show 是否显示动画
 */
export function showPodLoading(type, show) {
    const loadingElement = document.getElementById(`${type}-loading`);
    if (loadingElement) {
        loadingElement?.classList.toggle('active', show);
    }
}

/**
 * 控制进度提示条的展示与隐藏。
 * @param {'index'|'thumbnail'|'hls'} type 任务类型
 * @param {boolean} show 是否显示进度
 */
export function showProgressUpdate(type, show) {
    const updateElement = document.getElementById(`${type}-progress-update`);
    if (updateElement) {
        updateElement?.classList.toggle('active', show);
    }
}

/**
 * 将任务状态字符串转换为 CSS 类名。
 * @param {string} status 状态字符串
 * @returns {string} 对应的 CSS 类名
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
 * 获取状态对应的中文可读名称。
 * @param {string} status 状态字符串
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
        ready: '就绪',
    };
    return names[status] || status;
}

/**
 * 获取指定名称的SVG图标字符串。
 * @param {string} iconName 图标名
 * @returns {string} SVG字符串
 */
export function getIconSVG(iconName) {
    const icons = {
        paperclip: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><title>补全</title><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>`,
        sync: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><title>同步</title><polyline points="1 4 1 10 7 10"></polyline><polyline points="23 20 23 14 17 14"></polyline><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path></svg>`,
        rebuild: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><title>重建索引</title><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`,
        trash: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><title>清理</title><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`
    };
    return icons[iconName] || '';
}

/**
 * 从后端获取状态表数据。
 * @returns {Promise<Record<string, any>>} 状态表数据对象
 */
export async function fetchStatusTables() {
    try {
        const token = getAuthToken();
        const headers = token ? { Authorization: `Bearer ${token}` } : {};

        const response = await fetch('/api/settings/status-tables', {
            method: 'GET',
            headers,
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
