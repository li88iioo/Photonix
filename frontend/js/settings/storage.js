/**
 * @file frontend/js/settings/storage.js
 * @description 负责设置模块本地存储的读取与写入
 */

import { SETTINGS } from '../core/constants.js';

/**
 * 读取本地缓存的 AI 设置。
 * @returns {Record<string, any>} 本地存储的 AI 设置对象
 */
export function getLocalAISettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS.AI_LOCAL_KEY)) || {};
  } catch {
    return {};
  }
}

/**
 * 将 AI 设置写入本地存储。
 * @param {Record<string, any>} obj - 需要保存的设置对象
 * @returns {void}
 */
export function setLocalAISettings(obj) {
  localStorage.setItem(SETTINGS.AI_LOCAL_KEY, JSON.stringify(obj || {}));
}
