/**
 * @file settings.js
 * @description
 *   设置相关 API，包括获取、保存、轮询更新状态等功能。
 */

import { apiGet, APIErrorTypes, RequestPolicies } from './api-client.js';
import { removeAuthToken, getAuthToken } from '../app/auth.js';
import { apiLogger, getAuthHeaders, requestJSONWithDedup } from './shared.js';
import { resolveMessage } from '../shared/utils.js';

/**
 * 默认设置（获取失败时使用）
 * @type {object}
 * @constant
 */
const DEFAULT_SETTINGS = {
    AI_ENABLED: 'false',
    PASSWORD_ENABLED: 'false',
    ALLOW_PUBLIC_ACCESS: 'true'
};

/**
 * 获取设置
 * - 鉴权失败或超时返回默认值
 * @returns {Promise<object>} 设置数据对象
 */
export async function fetchSettings() {
    try {
        const url = `/settings?_=${Date.now()}`;
        return await apiGet(url, {
            cache: 'no-store',
            policy: RequestPolicies.RELIABLE
        });
    } catch (error) {
        if (error.type === APIErrorTypes.AUTHENTICATION) {
            removeAuthToken();
            return { ...DEFAULT_SETTINGS };
        }
        if (error.type === APIErrorTypes.TIMEOUT) {
            apiLogger.warn('获取设置超时，使用默认设置');
            return { ...DEFAULT_SETTINGS };
        }
        throw error;
    }
}

/**
 * 构建错误消息
 * @param {Response} response HTTP 响应对象
 * @param {string} fallbackMessage 备用错误消息
 * @returns {Promise<string>} 错误消息字符串
 */
async function buildErrorMessage(response, fallbackMessage) {
    try {
        let payload;
        try {
            payload = await response.clone().json();
        } catch {
            const text = await response.clone().text();
            payload = text || null;
        }
        const fallback = fallbackMessage || `请求失败 (${response.status}${response.statusText ? `: ${response.statusText}` : ''})`;
        return resolveMessage(payload, fallback);
    } catch (error) {
        apiLogger.warn('解析错误响应失败', { status: response.status, error: error?.message });
        return fallbackMessage || `请求失败 (${response.status})`;
    }
}

/**
 * 保存设置
 * - 根据是否登录添加/去除 Authorization
 * @param {object} settingsData 设置数据对象
 * @returns {Promise<object>} 保存结果对象
 * @throws {Error} 保存失败时抛出错误
 */
export async function saveSettings(settingsData) {
    const headers = getAuthHeaders();
    if (!getAuthToken()) {
        delete headers.Authorization;
    }

    const response = await fetch('/api/settings', {
        method: 'POST',
        headers,
        cache: 'no-store',
        body: JSON.stringify(settingsData)
    });

    if (!response.ok) {
        const message = await buildErrorMessage(response, '保存设置失败');
        throw new Error(message);
    }
    return await response.json().catch(() => ({}));
}

/**
 * 查询设置更新状态
 * - 对应后端 /api/settings/status
 * @param {string} updateId 更新 ID
 * @returns {Promise<object>} 更新状态对象
 * @throws {Error} 获取状态失败时抛出错误
 */
export async function fetchSettingsUpdateStatus(updateId) {
    const headers = getAuthHeaders();
    if (!getAuthToken()) {
        delete headers.Authorization;
    }

    const url = `/api/settings/status?id=${encodeURIComponent(updateId)}`;
    try {
        return await requestJSONWithDedup(url, {
            method: 'GET',
            headers,
            cache: 'no-store'
        });
    } catch (error) {
        throw new Error(resolveMessage(error, '无法获取设置更新状态'));
    }
}

/**
 * 轮询等待设置更新完成
 * - 返回最终状态（success/failed/timeout）
 * @param {string} updateId 更新 ID
 * @param {object} options 轮询选项
 * @param {number} options.intervalMs 轮询间隔（毫秒）
 * @param {number} options.timeoutMs 超时时间（毫秒）
 * @returns {Promise<object>} 最终状态对象
 */
export async function waitForSettingsUpdate(updateId, { intervalMs = 1000, timeoutMs = 30000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const status = await fetchSettingsUpdateStatus(updateId);
            if (status && (status.status === 'success' || status.status === 'failed')) {
                return { final: status.status, info: status };
            }
        } catch (error) {
            return { final: 'error', info: { message: error?.message || '未知错误' } };
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return { final: 'timeout' };
}

/**
 * 手动同步相册
 * @param {string} adminSecret 管理员密钥
 * @returns {Promise<object>} 同步结果对象
 * @throws {Error} 同步失败时抛出错误
 */
export async function manualAlbumSync(adminSecret) {
    const headers = {
        ...getAuthHeaders(),
        'Content-Type': 'application/json'
    };

    const response = await fetch('/api/settings/manage/manual-sync', {
        method: 'POST',
        headers,
        body: JSON.stringify({ adminSecret })
    });

    if (!response.ok) {
        const message = await buildErrorMessage(response, '手动同步失败');
        throw new Error(message);
    }
    return await response.json().catch(() => ({}));
}

/**
 * 验证管理员密钥
 * @param {string} adminSecret 管理员密钥
 * @returns {Promise<object>} 验证结果对象
 * @throws {Error} 验证失败时抛出错误
 */
export async function verifyAdminSecret(adminSecret) {
    const headers = {
        ...getAuthHeaders(),
        'Content-Type': 'application/json'
    };

    const response = await fetch('/api/settings/manage/verify-secret', {
        method: 'POST',
        headers,
        body: JSON.stringify({ adminSecret })
    });

    if (!response.ok) {
        const message = await buildErrorMessage(response, '管理员密钥验证失败');
        throw new Error(message);
    }

    return await response.json().catch(() => ({}));
}

/**
 * 切换相册删除功能
 * @param {boolean} enabled 是否启用删除功能
 * @param {string} adminSecret 管理员密钥
 * @returns {Promise<object>} 切换结果对象
 * @throws {Error} 切换失败时抛出错误
 */
export async function toggleAlbumDeletion(enabled, adminSecret) {
    const headers = {
        ...getAuthHeaders(),
        'Content-Type': 'application/json'
    };

    const response = await fetch('/api/settings/manage/delete-toggle', {
        method: 'POST',
        headers,
        body: JSON.stringify({ enabled, adminSecret })
    });

    if (!response.ok) {
        const message = await buildErrorMessage(response, '更新相册删除开关失败');
        throw new Error(message);
    }
    return await response.json().catch(() => ({}));
}

/**
 * 更新手动同步计划
 * @param {string} schedule 同步计划字符串
 * @param {string} adminSecret 管理员密钥
 * @returns {Promise<object>} 更新结果对象
 * @throws {Error} 更新失败时抛出错误
 */
export async function updateManualSyncSchedule(schedule, adminSecret) {
    const headers = {
        ...getAuthHeaders(),
        'Content-Type': 'application/json'
    };

    const response = await fetch('/api/settings/manage/update-schedule', {
        method: 'POST',
        headers,
        body: JSON.stringify({ schedule, adminSecret })
    });

    if (!response.ok) {
        const message = await buildErrorMessage(response, '更新自动维护计划失败');
        throw new Error(message);
    }
    return await response.json().catch(() => ({}));
}
