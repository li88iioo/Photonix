/**
 * @file frontend/js/settings/ai.js
 * @description 提供设置界面中的 AI 接入自动补全与模型列表加载逻辑
 */

import settingsContext from './context.js';
import { fetchAvailableModels } from '../app/api.js';
import { showNotification } from '../shared/utils.js';
import { safeSetInnerHTML} from '../shared/dom-utils.js';
import { escapeHtml } from '../shared/security.js';

const MODELS_PER_PAGE = 12;

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
 * 初始化模型下拉面板控制。
 * @returns {void}
 */
export function setupModelDropdownControls() {
  const { card } = settingsContext;
  if (!card || settingsContext.modelDropdownInitialized) return;

  const toggle = card.querySelector('#ai-model-dropdown-toggle');
  const dropdown = card.querySelector('#ai-model-dropdown');
  const input = card.querySelector('#ai-model');

  if (!toggle || !dropdown || !input) {
    return;
  }

  settingsContext.modelDropdownInitialized = true;

  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    toggleModelDropdown();
  });

  input.addEventListener('focus', () => {
    if (!settingsContext.modelDropdownOpen) {
      openModelDropdown();
    }
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeModelDropdown();
      input.blur();
    }
  });

  renderModelList(settingsContext.modelList || [], { preservePage: true });
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
  const dropdown = card.querySelector('#ai-model-dropdown');
  if (!aiModelInput || !dropdown) return;

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
  if (Array.isArray(models)) {
    settingsContext.modelList = models;
  } else {
    settingsContext.modelList = [];
  }
  renderModelList(settingsContext.modelList, { preservePage: false });
}

function renderModelList(models = null, options = {}) {
  const { preservePage = false } = options;
  const { card } = settingsContext;
  if (!card) return;

  const container = card.querySelector('#ai-model-list');
  if (!container) return;

  ensureModelListListener(container);

  if (Array.isArray(models)) {
    settingsContext.modelList = models;
    if (!preservePage) {
      settingsContext.modelListPage = 0;
    }
  }

  const data = Array.isArray(settingsContext.modelList) ? settingsContext.modelList : [];
  const total = data.length;

  if (total === 0) {
    safeSetInnerHTML(
      container,
      '<div class="ai-model-list-empty">当前 API 未返回可用的视觉模型，您可以手动输入模型名称。</div>'
    );
    return;
  }

  const totalPages = Math.max(1, Math.ceil(total / MODELS_PER_PAGE));
  let currentPage = Math.min(settingsContext.modelListPage || 0, totalPages - 1);
  currentPage = Math.max(0, currentPage);
  settingsContext.modelListPage = currentPage;

  const start = currentPage * MODELS_PER_PAGE;
  const end = start + MODELS_PER_PAGE;
  const pageItems = data.slice(start, end);

  const listHtml = pageItems
    .map((model) => {
      const id = escapeHtml(model.id || '');
      const name = escapeHtml(model.displayName || id);
      const description = escapeHtml(model.description || '');
      const tags = Array.isArray(model.capabilities) && model.capabilities.length
        ? `<div class="ai-model-tags">${model.capabilities.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>`
        : '';
      return `
        <li class="ai-model-item" data-model-id="${id}">
          <div class="ai-model-item-main">
            <span class="ai-model-name">${name}</span>
            <span class="ai-model-id">${id}</span>
          </div>
          ${description ? `<p class="ai-model-desc">${description}</p>` : ''}
          ${tags}
        </li>`;
    })
    .join('');

  const paginationHtml = totalPages > 1
    ? `<div class="ai-model-pagination" role="toolbar" aria-label="AI模型分页">
        <button type="button" class="ai-model-page-btn" data-model-page="prev" ${currentPage === 0 ? 'disabled' : ''}>上一页</button>
        <span class="ai-model-page-indicator">${currentPage + 1} / ${totalPages}</span>
        <button type="button" class="ai-model-page-btn" data-model-page="next" ${currentPage >= totalPages - 1 ? 'disabled' : ''}>下一页</button>
      </div>`
    : '';

  safeSetInnerHTML(
    container,
    `<div class="ai-model-list-header">
        <span>共 ${total} 个视觉模型</span>
        ${paginationHtml}
     </div>
     <ul class="ai-model-grid">${listHtml}</ul>`
  );
}

function ensureModelListListener(container) {
  if (!container) return;

  if (!settingsContext.modelListPaginationHandler) {
    settingsContext.modelListPaginationHandler = (event) => {
      const option = event.target.closest('[data-model-id]');
      if (option) {
        const modelId = option.getAttribute('data-model-id');
        if (modelId) {
          handleModelSelection(modelId);
        }
        return;
      }

      const control = event.target.closest('[data-model-page]');
      if (!control) return;

      const total = Array.isArray(settingsContext.modelList) ? settingsContext.modelList.length : 0;
      if (total === 0) return;
      const totalPages = Math.max(1, Math.ceil(total / MODELS_PER_PAGE));

      const action = control.getAttribute('data-model-page');
      if (action === 'prev' && settingsContext.modelListPage > 0) {
        settingsContext.modelListPage -= 1;
      } else if (action === 'next' && settingsContext.modelListPage < totalPages - 1) {
        settingsContext.modelListPage += 1;
      } else {
        return;
      }

      renderModelList(null, { preservePage: true });
    };
  }

  if (settingsContext.modelListListenerTarget === container) {
    return;
  }

  if (settingsContext.modelListListenerTarget) {
    settingsContext.modelListListenerTarget.removeEventListener('click', settingsContext.modelListPaginationHandler);
  }

  container.addEventListener('click', settingsContext.modelListPaginationHandler);
  settingsContext.modelListListenerTarget = container;
}

function handleModelSelection(modelId) {
  const { card } = settingsContext;
  if (!card || !modelId) return;
  const input = card.querySelector('#ai-model');
  if (!input) return;
  input.value = modelId;
  const event = new Event('input', { bubbles: true });
  input.dispatchEvent(event);
  closeModelDropdown();
}

function toggleModelDropdown(forceState) {
  if (forceState === true) {
    openModelDropdown();
    return;
  }
  if (forceState === false) {
    closeModelDropdown();
    return;
  }
  if (settingsContext.modelDropdownOpen) {
    closeModelDropdown();
  } else {
    openModelDropdown();
  }
}

function openModelDropdown() {
  const { card } = settingsContext;
  if (!card || settingsContext.modelDropdownOpen) return;
  const dropdown = card.querySelector('#ai-model-dropdown');
  const toggle = card.querySelector('#ai-model-dropdown-toggle');
  const input = card.querySelector('#ai-model');
  if (!dropdown) return;
  dropdown?.classList.add('open');
  dropdown.setAttribute('aria-hidden', 'false');
  if (toggle) toggle.setAttribute('aria-expanded', 'true');
  if (input) input.setAttribute('aria-expanded', 'true');
  settingsContext.modelDropdownOpen = true;
  ensureDropdownOutsideHandler();
}

function closeModelDropdown() {
  const { card } = settingsContext;
  if (!card || !settingsContext.modelDropdownOpen) return;
  const dropdown = card.querySelector('#ai-model-dropdown');
  const toggle = card.querySelector('#ai-model-dropdown-toggle');
  const input = card.querySelector('#ai-model');
  if (!dropdown) return;
  dropdown?.classList.remove('open');
  dropdown.setAttribute('aria-hidden', 'true');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  if (input) input.setAttribute('aria-expanded', 'false');
  settingsContext.modelDropdownOpen = false;
  removeDropdownOutsideHandler();
}

function ensureDropdownOutsideHandler() {
  if (settingsContext.modelDropdownOutsideHandler) return;
  settingsContext.modelDropdownOutsideHandler = (event) => {
    const { card } = settingsContext;
    if (!card) return;
    const dropdown = card.querySelector('#ai-model-dropdown');
    const toggle = card.querySelector('#ai-model-dropdown-toggle');
    const input = card.querySelector('#ai-model');
    if (!dropdown) return;
    if (
      (dropdown && dropdown.contains(event.target)) ||
      (toggle && toggle.contains(event.target)) ||
      (input && input.contains(event.target))
    ) {
      return;
    }
    closeModelDropdown();
  };

  document.addEventListener('mousedown', settingsContext.modelDropdownOutsideHandler, true);
}

function removeDropdownOutsideHandler() {
  if (!settingsContext.modelDropdownOutsideHandler) return;
  document.removeEventListener('mousedown', settingsContext.modelDropdownOutsideHandler, true);
  settingsContext.modelDropdownOutsideHandler = null;
}
