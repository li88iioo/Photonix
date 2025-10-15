/**
 * @file frontend/js/settings/ai.js
 * @description 提供设置界面中的 AI 接入自动补全与模型列表加载逻辑
 */

import settingsContext from './context.js';
import { fetchAvailableModels } from '../app/api.js';
import { showNotification } from '../shared/utils.js';
import { safeSetInnerHTML } from '../shared/dom-utils.js';

/**
 * 绑定 AI 接口地址输入框的自动补全与模型刷新事件。
 * @returns {void}
 */
export function setupApiUrlAutoComplete() {
  const { card } = settingsContext;
  if (!card) return;

  const aiUrlInput = card.querySelector('#ai-url');
  if (!aiUrlInput) return;

  aiUrlInput.addEventListener('input', () => {
    settingsContext.lastModelFetchSignature = null;
    if (settingsContext.modelFetchTimer) {
      clearTimeout(settingsContext.modelFetchTimer);
      settingsContext.modelFetchTimer = null;
    }
  });

  aiUrlInput.addEventListener('blur', (event) => {
    autoCompleteApiUrl(event.target);
    attemptModelFetch('blur');
  });
}

/**
 * 自动补全 OpenAI 兼容接口路径，确保包含版本与资源段。
 * @param {HTMLInputElement} inputElement - 用户输入的 API 地址元素
 * @returns {void}
 */
export function autoCompleteApiUrl(inputElement) {
  const value = inputElement.value.trim();

  if (!value) {
    return;
  }

  if (value.endsWith('#')) {
    inputElement.value = value.slice(0, -1);
    return;
  }

  const alreadyHasChat = /\/chat\/completions\/?$/i.test(value) || /\/v\d+\/chat\/completions\/?$/i.test(value);
  if (alreadyHasChat) {
    return;
  }

  if (isGeminiApiUrl(value)) {
    return;
  }

  const sanitized = value.replace(/\/+$/, '');
  const endsWithSlash = value.endsWith('/');
  const versionIncluded = /\/v\d+(?:[a-z]*)\/?$/i.test(sanitized);

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

/**
 * 检测当前地址是否为 Google Gemini API，避免重复补全。
 * @param {string} [value=''] - 待检测的 URL 字符串
 * @returns {boolean} 是否为 Gemini 接口地址
 */
export function isGeminiApiUrl(value = '') {
  return /generativelanguage\.googleapis\.com/i.test(value);
}

/**
 * 根据触发事件尝试异步拉取模型列表，内置防抖处理。
 * @param {('input'|'blur'|'focus'|'toggle')} [trigger='input'] - 模型获取的触发来源
 * @returns {void}
 */
export function attemptModelFetch(trigger = 'input') {
  const { card } = settingsContext;
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

  if (settingsContext.modelFetchTimer) clearTimeout(settingsContext.modelFetchTimer);
  const delay = ['blur', 'focus', 'toggle'].includes(trigger) ? 0 : 600;
  settingsContext.modelFetchTimer = setTimeout(() => fetchAndPopulateModels(apiUrl, apiKey), delay);
}

/**
 * 请求可用模型并将结果写入模型候选列表。
 * @param {string} apiUrl - AI 服务的接口地址
 * @param {string} apiKey - AI 服务使用的访问密钥
 * @returns {Promise<void>} 模型列表加载完成后的 Promise
 */
export async function fetchAndPopulateModels(apiUrl, apiKey) {
  const signature = `${apiUrl}::${apiKey}`;
  if (signature === settingsContext.lastModelFetchSignature) {
    return;
  }

  const { card } = settingsContext;
  if (!card) return;

  const aiModelInput = card.querySelector('#ai-model');
  const datalist = card.querySelector('#ai-model-options');
  if (!aiModelInput || !datalist) return;

  const originalPlaceholder = aiModelInput.getAttribute('data-original-placeholder') || aiModelInput.placeholder;
  aiModelInput.setAttribute('data-original-placeholder', originalPlaceholder);
  aiModelInput.placeholder = '正在加载模型列表...';
  aiModelInput.disabled = true;

  if (settingsContext.modelFetchAbortController) {
    settingsContext.modelFetchAbortController.abort();
  }
  settingsContext.modelFetchAbortController = new AbortController();

  try {
    const models = await fetchAvailableModels(apiUrl, apiKey, settingsContext.modelFetchAbortController.signal);
    updateModelOptions(models);
    settingsContext.lastModelFetchSignature = signature;

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
    settingsContext.lastModelFetchSignature = null;
    showNotification(error?.message || '获取模型列表失败，请稍后重试', 'error');
    updateModelOptions([]);
  } finally {
    aiModelInput.placeholder = aiModelInput.getAttribute('data-original-placeholder') || '';
    aiModelInput.disabled = false;
    settingsContext.modelFetchAbortController = null;
  }
}

/**
 * 将模型数组转换为 datalist 选项以供前端选择。
 * @param {Array<{id?: string, name?: string, displayName?: string}>} models - 可用模型元数据
 * @returns {void}
 */
export function updateModelOptions(models) {
  const { card } = settingsContext;
  if (!card) return;

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
