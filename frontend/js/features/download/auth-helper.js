/**
 * @file auth-helper.js
 * @description 下载功能的认证助手，处理密钥到Token的转换
 */

import { createModuleLogger } from '../../core/logger.js';
import { getAuthToken, setAuthToken, removeAuthToken } from '../../app/auth.js';

const authLogger = createModuleLogger('DownloadAuth');

/**
 * 下载功能专用的Token存储键
 */
const DOWNLOAD_TOKEN_KEY = 'download_auth_token';
const DOWNLOAD_TOKEN_EXPIRY_KEY = 'download_auth_expiry';

/**
 * 使用管理员密钥交换JWT Token
 * @param {string} adminSecret - 管理员密钥
 * @returns {Promise<{success: boolean, token?: string, error?: string}>}
 */
export async function exchangeSecretForToken(adminSecret) {
  try {
    // 使用密码登录获取Token
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: adminSecret })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return {
        success: false,
        error: error.message || '密钥验证失败'
      };
    }

    const data = await response.json();
    const token = data.token || data.data?.token;
    
    if (!token) {
      return {
        success: false,
        error: '未能获取认证令牌'
      };
    }

    // 保存Token（使用sessionStorage，更安全）
    sessionStorage.setItem(DOWNLOAD_TOKEN_KEY, token);
    
    // 计算过期时间（默认12小时）
    const expiresIn = data.expiresIn || data.data?.expiresIn || 12 * 60 * 60 * 1000;
    const expiryTime = Date.now() + expiresIn;
    sessionStorage.setItem(DOWNLOAD_TOKEN_EXPIRY_KEY, String(expiryTime));
    
    // 同时设置到全局auth系统
    setAuthToken(token);

    authLogger.info('Token获取成功，有效期:', new Date(expiryTime).toLocaleString());

    return {
      success: true,
      token: token
    };
  } catch (error) {
    authLogger.error('Token交换失败', error);
    return {
      success: false,
      error: error.message || '网络错误'
    };
  }
}

/**
 * 获取下载功能的Token
 * @returns {string|null}
 */
export function getDownloadToken() {
  // 检查是否过期
  const expiryTime = sessionStorage.getItem(DOWNLOAD_TOKEN_EXPIRY_KEY);
  if (expiryTime && Number(expiryTime) < Date.now()) {
    authLogger.info('Token已过期');
    clearDownloadToken();
    return null;
  }
  
  // 优先使用下载专用Token
  const downloadToken = sessionStorage.getItem(DOWNLOAD_TOKEN_KEY);
  if (downloadToken) {
    return downloadToken;
  }
  
  // 降级到全局Token
  return getAuthToken();
}

/**
 * 清除下载功能的Token
 */
export function clearDownloadToken() {
  sessionStorage.removeItem(DOWNLOAD_TOKEN_KEY);
  sessionStorage.removeItem(DOWNLOAD_TOKEN_EXPIRY_KEY);
  removeAuthToken();
  authLogger.info('Token已清除');
}

/**
 * 刷新Token
 * @returns {Promise<boolean>}
 */
export async function refreshDownloadToken() {
  const token = getDownloadToken();
  if (!token) {
    return false;
  }

  try {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      authLogger.warn('Token刷新失败');
      return false;
    }

    const data = await response.json();
    const newToken = data.token || data.data?.token;
    
    if (newToken && newToken !== token) {
      sessionStorage.setItem(DOWNLOAD_TOKEN_KEY, newToken);
      setAuthToken(newToken);
      
      // 更新过期时间
      const expiresIn = data.expiresIn || data.data?.expiresIn || 12 * 60 * 60 * 1000;
      const expiryTime = Date.now() + expiresIn;
      sessionStorage.setItem(DOWNLOAD_TOKEN_EXPIRY_KEY, String(expiryTime));

      authLogger.info('Token刷新成功');
    }

    return true;
  } catch (error) {
    authLogger.error('Token刷新出错', error);
    return false;
  }
}

/**
 * 检查是否有有效的认证
 * @returns {Promise<boolean>}
 */
export async function hasValidAuth() {
  const token = getDownloadToken();
  if (!token) {
    return false;
  }

  try {
    // 验证Token是否有效
    const response = await fetch('/api/download/status', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    return response.ok;
  } catch {
    return false;
  }
}
