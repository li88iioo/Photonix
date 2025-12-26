import { getAuthHeaders, requestJSONWithDedup } from './shared.js';
import { resolveMessage } from '../shared/utils.js';
import { applyAdminSecretHeader } from '../shared/admin-secret.js';

/**
 * 构建带查询参数的下载服务接口 URL
 * @param {string} path 路径
 * @param {object} [query={}] 查询参数
 * @returns {string} 完整 URL
 */
function buildUrl(path, query = {}) {
  const url = new URL(`/api/download${path}`, window.location.origin);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, value);
  });
  return url.toString();
}

/**
 * 解析请求响应体
 * @param {Response} response fetch 返回的响应对象
 * @returns {Promise<any>} 响应数据，自动提取 data 字段
 */
async function parseResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return payload.data;
  }
  return payload;
}

/**
 * 构造用于错误对象的响应消息字符串
 * @param {Response} response fetch 返回的响应对象
 * @param {string} fallback 解析失败时的备用消息
 * @returns {Promise<string>} 规范化后的错误提示
 */
function buildErrorMessage(response, fallback) {
  return response
    .clone()
    .json()
    .catch(() => response.clone().text())
    .then((data) => resolveMessage(data, fallback))
    .catch(() => fallback);
}

/**
 * 通用下载服务请求封装
 * @param {string} path API 路径
 * @param {object} options 选项
 * @param {string} [options.method='GET'] 请求方法
 * @param {string} [options.adminSecret] 管理员密钥（已废弃，使用JWT Token）
 * @param {object} [options.body] POST/PATCH/PUT 请求正文
 * @param {object} [options.query] GET 查询参数
 * @param {object} [options.options={}] 其他 fetch 选项
 * @returns {Promise<any>} 响应数据
 * @throws {Error} 请求错误（包含响应状态码）
 */
async function request(path, { method = 'GET', adminSecret, body, query, options = {} } = {}) {
  const isGetLike = method === 'GET' || method === 'HEAD';
  const headers = {
    ...getAuthHeaders() // 这里已经会自动添加 Bearer Token
  };
  const finalQuery = { ...(query || {}) };
  let url = `/api/download${path}`;
  
  // 如果有JWT Token，就不需要传adminSecret了
  const hasToken = headers.Authorization && headers.Authorization.startsWith('Bearer ');
  if (!hasToken && adminSecret) {
    applyAdminSecretHeader(headers, adminSecret);
  }
  
  if (isGetLike) {
    url = buildUrl(path, finalQuery);
  }

  const fetchOptions = {
    method,
    headers,
    cache: 'no-store',
    ...options
  };

  if (!isGetLike) {
    fetchOptions.body = JSON.stringify({ ...(body || {}) });
  }

  if (!isGetLike && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, fetchOptions);
  if (!response.ok) {
    const message = await buildErrorMessage(response, '下载服务请求失败');
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return parseResponse(response);
}

/**
 * 获取下载服务运行状态
 * @param {string} [adminSecret] 管理员密钥（可选）
 * @returns {Promise<object>} 服务状态数据
 */
export async function fetchDownloadStatus(adminSecret) {
  const headers = getAuthHeaders();
  const hasToken = headers.Authorization && headers.Authorization.startsWith('Bearer ');
  if (!hasToken && adminSecret) {
    applyAdminSecretHeader(headers, adminSecret);
  }
  return requestJSONWithDedup(buildUrl('/status'), {
    method: 'GET',
    headers,
    cache: 'no-store'
  }).then((payload) => (payload?.data ? payload.data : payload));
}

/**
 * 获取下载任务列表
 * @param {string} [adminSecret] 管理员密钥（可选）
 * @param {object} [query={}] 查询参数
 * @returns {Promise<object[]>} 任务数组
 */
export async function fetchDownloadTasks(adminSecret, query = {}) {
  return request('/tasks', { method: 'GET', adminSecret, query });
}

/**
 * 创建新下载任务
 * @param {string} adminSecret 管理员密钥
 * @param {object} payload 任务数据
 * @returns {Promise<object>} 创建结果
 */
export async function createDownloadTask(adminSecret, payload) {
  return request('/tasks', { method: 'POST', adminSecret, body: payload });
}

/**
 * 更新指定下载任务
 * @param {string} adminSecret 管理员密钥
 * @param {string} taskId 任务 ID
 * @param {object} payload 任务修改内容
 * @returns {Promise<object>} 更新结果
 */
export async function updateDownloadTask(adminSecret, taskId, payload) {
  return request(`/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', adminSecret, body: payload });
}

/**
 * 执行下载任务动作（如重试、暂停等）
 * @param {string} adminSecret 管理员密钥
 * @param {string} taskId 任务 ID
 * @param {string} action 动作（retry/pause/等）
 * @param {object} [payload={}] 附加数据
 * @returns {Promise<object>} 操作结果
 */
export async function triggerDownloadTaskAction(adminSecret, taskId, action, payload = {}) {
  return request(`/tasks/${encodeURIComponent(taskId)}/${encodeURIComponent(action)}`, {
    method: 'POST',
    adminSecret,
    body: payload
  });
}

/**
 * 删除指定下载任务
 * @param {string} adminSecret 管理员密钥
 * @param {string} taskId 任务 ID
 * @returns {Promise<object>} 删除操作结果
 */
export async function deleteDownloadTask(adminSecret, taskId) {
  return request(`/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE', adminSecret });
}

/**
 * 获取指定任务日志
 * @param {string} adminSecret 管理员密钥
 * @param {string} taskId 任务 ID
 * @param {object} [query={}] 查询参数
 * @returns {Promise<object[]>} 日志数组
 */
export async function fetchDownloadTaskLogs(adminSecret, taskId, query = {}) {
  return request(`/tasks/${encodeURIComponent(taskId)}/logs`, { method: 'GET', adminSecret, query });
}

/**
 * 获取下载服务通用日志
 * @param {string} adminSecret 管理员密钥
 * @param {object} [query={}] 查询参数
 * @returns {Promise<object[]>} 日志数组
 */
export async function fetchDownloadLogs(adminSecret, query = {}) {
  return request('/logs', { method: 'GET', adminSecret, query });
}

export async function clearDownloadLogs(adminSecret, payload = {}) {
  return request('/logs', { method: 'DELETE', adminSecret, body: payload });
}

export async function fetchDownloadConfig(adminSecret) {
  return request('/config', { method: 'GET', adminSecret });
}

export async function updateDownloadConfig(adminSecret, payload) {
  return request('/config', { method: 'PUT', adminSecret, body: payload });
}

export async function previewDownloadFeed(adminSecret, taskId, query = {}) {
  return request(`/tasks/${encodeURIComponent(taskId)}/preview`, { method: 'GET', adminSecret, query });
}

export async function downloadSelectedEntries(adminSecret, taskId, payload) {
  return request(`/tasks/${encodeURIComponent(taskId)}/download`, {
    method: 'POST',
    adminSecret,
    body: payload
  });
}

export async function exportDownloadOpml(adminSecret) {
  return request('/opml', { method: 'GET', adminSecret });
}

export async function importDownloadOpml(adminSecret, payload) {
  return request('/opml', { method: 'POST', adminSecret, body: payload });
}

export async function fetchDownloadHistory(adminSecret, query = {}) {
  return request('/history', { method: 'GET', adminSecret, query });
}
