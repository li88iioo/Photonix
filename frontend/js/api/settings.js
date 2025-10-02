// 设置相关 API：获取、保存、轮询更新状态
import { apiGet, APIErrorTypes, RequestPolicies } from '../api-client.js';
import { removeAuthToken, getAuthToken } from '../auth.js';
import { apiLogger, getAuthHeaders, requestJSONWithDedup } from './shared.js';

// 获取失败时的保底默认设置
const DEFAULT_SETTINGS = {
    AI_ENABLED: 'false',
    PASSWORD_ENABLED: 'false',
    ALLOW_PUBLIC_ACCESS: 'true'
};

// 拉取设置：鉴权失败或超时返回默认值
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

// 保存设置：根据是否登录添加/去除 Authorization
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

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.error || '保存设置失败');
    }
    return result;
}

// 查询设置更新状态（与后端 /api/settings/status 对应）
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
        throw new Error(error?.message || '无法获取设置更新状态');
    }
}

// 轮询等待设置更新完成，返回最终状态（success/failed/timeout）
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
