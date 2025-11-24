/**
 * @file frontend/js/settings/form.js
 * @description 处理设置表单渲染、交互与保存流程
 */

import settingsContext from './context.js';
import { settingsLogger } from './logger.js';
import { saveSettings, waitForSettingsUpdate, toggleAlbumDeletion } from '../app/api.js';
import { showNotification } from '../shared/utils.js';
import { removeAuthToken } from '../app/auth.js';
import { SETTINGS, isDevelopment } from '../core/constants.js';
import { safeClassList, safeSetStyle, safeGetStyle } from '../shared/dom-utils.js';
import { setupApiUrlAutoComplete, attemptModelFetch } from './ai.js';
import { setupManagementTab, renderManualSyncScheduleStatus } from './management.js';
import { loadStatusTables } from './status.js';
import { getLocalAISettings, setLocalAISettings } from './storage.js';
import { showPasswordPrompt } from './password-prompt.js';
import { closeSettingsModal } from './modal.js';
import { state } from '../core/state.js';

let lastButtonStateUpdate = 0;

const NAV_LABEL_RESPONSIVE_BREAKPOINT = '(max-width: 430px)';
const NAV_LABEL_MAP = {
  security: { short: '安全' },
  ai: { short: 'AI' },
  status: { short: '状态' },
  manage: { short: '运维' }
};

function updateNavLabels(nav, useShort) {
  if (!nav) return;
  nav.querySelectorAll('button').forEach((btn) => {
    const labelEl = btn.querySelector('span');
    if (!labelEl) return;
    const full = btn.dataset.fullLabel || labelEl.textContent.trim();
    if (!btn.dataset.fullLabel) {
      btn.dataset.fullLabel = full;
    }
    if (useShort) {
      const shortLabel = NAV_LABEL_MAP[btn.dataset.tab]?.short;
      if (shortLabel) {
        labelEl.textContent = shortLabel;
        return;
      }
    }
    labelEl.textContent = btn.dataset.fullLabel;
  });
}

function setupResponsiveNavLabels(nav) {
  if (!nav || nav.dataset.labelResponsive === 'true' || typeof window === 'undefined') return;
  const mediaQuery = window.matchMedia(NAV_LABEL_RESPONSIVE_BREAKPOINT);
  const handler = (event) => updateNavLabels(nav, event.matches);
  handler(mediaQuery);
  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', handler);
  } else if (typeof mediaQuery.addListener === 'function') {
    mediaQuery.addListener(handler);
  }
  nav.dataset.labelResponsive = 'true';
}

/**
 * 根据初始配置更新相册删除相关控件的可用状态。
 * @returns {void}
 */
function updateAlbumDeletionControls() {
  const { card, initialSettings } = settingsContext;
  if (!card) return;

  const deleteToggle = card.querySelector('#album-delete-toggle');
  const toggleRow = card.querySelector('#album-delete-toggle-row');
  const hasPassword = Boolean(initialSettings?.hasPassword);
  const adminConfigured = Boolean(initialSettings?.isAdminSecretConfigured);
  const disabled = !hasPassword || !adminConfigured;

  if (deleteToggle) {
    deleteToggle.checked = Boolean(initialSettings?.albumDeletionEnabled);
    deleteToggle.disabled = disabled;
    if (disabled) {
      deleteToggle.title = hasPassword ? '未配置超级管理员密码，无法更改此设置' : '需要先设置访问密码才能使用这些功能';
    } else {
      deleteToggle.title = '';
    }
  }

  if (toggleRow) {
    toggleRow.setAttribute('aria-pressed', String(Boolean(initialSettings?.albumDeletionEnabled)));
    toggleRow.classList.toggle('disabled', disabled);
    if (disabled) {
      toggleRow.setAttribute('aria-disabled', 'true');
    } else {
      toggleRow.removeAttribute('aria-disabled');
    }
  }
}

/**
 * 使用后端返回的设置初始化表单显示。
 * @param {Record<string, any>} settings - 当前系统设置
 * @returns {void}
 */
export function populateForm(settings) {
  const { card, initialSettings } = settingsContext;
  if (!card) return;

  card.querySelector('#password-enabled').checked = settings.PASSWORD_ENABLED === 'true';
  card.querySelector('#ai-enabled').checked = settings.AI_ENABLED === 'true';
  card.querySelector('#ai-url').value = settings.AI_URL || '';

  setupApiUrlAutoComplete();
  card.querySelector('#ai-key').value = '';
  card.querySelector('#ai-model').value = settings.AI_MODEL || '';
  card.querySelector('#ai-prompt').value = settings.AI_PROMPT || '';

  initialSettings.albumDeletionEnabled = Boolean(settings.albumDeletionEnabled);
  updateAlbumDeletionControls();

  const scheduleInput = card.querySelector('#manual-sync-schedule');
  if (scheduleInput) {
    scheduleInput.value = initialSettings.manualSyncSchedule || 'off';
  }

  renderManualSyncScheduleStatus(initialSettings.manualSyncStatus || null);

  updateDynamicUI(settings.PASSWORD_ENABLED === 'true', settings.AI_ENABLED === 'true', settings.hasPassword);

  updateButtonStates();

  setTimeout(() => {
    updateButtonStates();
  }, 200);
}

/**
 * 为设置表单绑定交互事件与状态切换逻辑。
 * @returns {void}
 */
export function setupListeners() {
  const { card, initialSettings } = settingsContext;
  if (!card) return;

  const nav = card.querySelector('.settings-nav');
  const panels = card.querySelectorAll('.settings-tab-content');
  const passwordEnabledToggle = card.querySelector('#password-enabled');
  const aiEnabledToggle = card.querySelector('#ai-enabled');
  const aiUrlInput = card.querySelector('#ai-url');
  const aiKeyInput = card.querySelector('#ai-key');
  const aiModelInput = card.querySelector('#ai-model');
  const newPasswordInput = card.querySelector('#new-password');
  const newPasswordWrapper = card.querySelector('#new-password-wrapper');

  if (newPasswordWrapper) {
    newPasswordWrapper.addEventListener('click', (e) => {
      if (newPasswordInput && newPasswordInput.disabled) {
        e.preventDefault();
        showNotification('未配置超级管理员密码，无法更改此设置', 'error');
      }
    });
  }

  setupResponsiveNavLabels(nav);

  nav.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    safeClassList(nav.querySelector('.active'), 'remove', 'active');
    panels.forEach(p => safeClassList(p, 'remove', 'active'));
    safeClassList(btn, 'add', 'active');
    const targetTab = card.querySelector(`#${btn.dataset.tab}-settings-content`);
    if (targetTab) {
      safeClassList(targetTab, 'add', 'active');
      targetTab.scrollTop = 0;
    }

    if (btn.dataset.tab === 'status') {
      const containers = ['index-status', 'thumbnail-status', 'hls-status'];
      containers.forEach(id => {
        const container = document.getElementById(id);
        if (container && !container.innerHTML.trim()) {
          container.innerHTML = '<div class="status-loading"><div class="spinner"></div></div>';
        }
      });

      loadStatusTables({ silent: true });
    }
  });

  const closeButtons = card.querySelectorAll('.settings-close-btn');
  const cancelButtons = card.querySelectorAll('#security-settings-content .cancel-btn, #ai-settings-content .cancel-btn');
  const saveButtons = card.querySelectorAll('#security-settings-content .save-btn, #ai-settings-content .save-btn');

  closeButtons.forEach((btn) => {
    btn.addEventListener('click', closeSettingsModal);
  });
  cancelButtons.forEach((btn) => {
    btn.addEventListener('click', closeSettingsModal);
  });
  saveButtons.forEach((btn) => {
    btn.addEventListener('click', handleSave);
  });

  card.querySelectorAll('input:not(#password-enabled), textarea').forEach(el => {
    el.addEventListener('input', checkForChanges);
    el.addEventListener('change', checkForChanges);
  });

  if (newPasswordInput) {
    newPasswordInput.addEventListener('input', () => {
      safeClassList(newPasswordInput, 'remove', 'input-error');
    });
  }

  passwordEnabledToggle.addEventListener('click', e => {
    const shouldBeDisabled = initialSettings.hasPassword && !initialSettings.isAdminSecretConfigured;
    if (e.target.checked && shouldBeDisabled) {
      e.preventDefault();
      showNotification('未配置超级管理员密码，无法更改此设置', 'error');
    }
  });

  passwordEnabledToggle.addEventListener('change', e => {
    updateDynamicUI(e.target.checked, aiEnabledToggle.checked, initialSettings.hasPassword);
    checkForChanges();
  });

  aiEnabledToggle.addEventListener('change', e => {
    updateDynamicUI(passwordEnabledToggle.checked, e.target.checked, initialSettings.hasPassword);
    checkForChanges();
    attemptModelFetch('toggle');
  });

  if (aiKeyInput) {
    aiKeyInput.addEventListener('input', () => {
      if (settingsContext.modelFetchTimer) clearTimeout(settingsContext.modelFetchTimer);
      settingsContext.modelFetchTimer = setTimeout(() => attemptModelFetch('input'), 800);
    });
    aiKeyInput.addEventListener('blur', () => attemptModelFetch('blur'));
  }

  if (aiUrlInput) {
    aiUrlInput.addEventListener('blur', () => attemptModelFetch('blur'));
  }

  if (aiModelInput) {
    aiModelInput.addEventListener('focus', () => attemptModelFetch('focus'));
  }

  setupPasswordToggles();
  setupManagementTab();
}

/**
 * 绑定密码输入框的可见性切换控制。
 * @returns {void}
 */
function setupPasswordToggles() {
  const { card } = settingsContext;
  if (!card) return;

  const wrappers = card.querySelectorAll('.password-wrapper');
  wrappers.forEach(wrapper => {
    const input = wrapper.querySelector('input');
    const icon = wrapper.querySelector('.password-toggle-icon');
    if (!input || !icon) return;
    const openEye = icon.querySelector('.eye-open');
    const closedEye = icon.querySelector('.eye-closed');
    safeSetStyle(openEye, 'display', input.type === 'password' ? 'block' : 'none');
    safeSetStyle(closedEye, 'display', input.type === 'password' ? 'none' : 'block');
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      safeSetStyle(openEye, 'display', isPassword ? 'none' : 'block');
      safeSetStyle(closedEye, 'display', isPassword ? 'block' : 'none');
      const originalColor = safeGetStyle(icon, 'color');
      safeSetStyle(icon, 'color', 'white');
      setTimeout(() => {
        safeSetStyle(icon, 'color', originalColor || '');
      }, 200);
    });
  });
}

/**
 * 根据启用状态切换 password/API 设置区域的展示与交互。
 * @param {boolean} isPasswordEnabled - 是否启用访问密码
 * @param {boolean} isAiEnabled - 是否启用 AI 功能
 * @param {boolean} hasPassword - 当前是否已配置访问密码
 * @returns {void}
 */
function updateDynamicUI(isPasswordEnabled, isAiEnabled, hasPassword) {
  const { card, initialSettings } = settingsContext;
  if (!card) return;

  const passwordSettingsGroup = card.querySelector('#password-settings-group');
  const apiSettingsGroup = card.querySelector('#api-settings-group');
  const newPasswordInput = card.querySelector('#new-password');
  const passwordEnabledWrapper = card.querySelector('#password-enabled-wrapper');
  const newPasswordWrapper = card.querySelector('#new-password-wrapper');

  if (passwordSettingsGroup) {
    safeSetStyle(passwordSettingsGroup, 'display', isPasswordEnabled ? 'block' : 'none');
  }
  if (apiSettingsGroup) {
    safeSetStyle(apiSettingsGroup, 'display', isAiEnabled ? 'block' : 'none');
  }

  const shouldDisable = hasPassword && !initialSettings.isAdminSecretConfigured;

  safeClassList(passwordEnabledWrapper, 'toggle', 'disabled', shouldDisable);
  passwordEnabledWrapper.title = shouldDisable ? '未配置超级管理员密码，无法更改此设置' : '';

  if (isPasswordEnabled && newPasswordInput) {
    newPasswordInput.disabled = shouldDisable;
    safeClassList(newPasswordWrapper, 'toggle', 'disabled', shouldDisable);
    newPasswordWrapper.title = shouldDisable ? '未配置超级管理员密码，无法更改此设置' : '';
    newPasswordInput.placeholder = hasPassword ? '新密码' : '设置新密码';
  }

  updateButtonStates();
}

/**
 * 更新同步与管理按钮的可用状态及提示信息。
 * @returns {void}
 */
function updateButtonStates() {
  try {
    const now = Date.now();
    if (now - lastButtonStateUpdate < SETTINGS.BUTTON_STATE_UPDATE_THROTTLE) {
      return;
    }
    lastButtonStateUpdate = now;

    const { card, initialSettings } = settingsContext;
    if (!card) {
      settingsLogger.debug('设置卡片未加载，跳过按钮状态更新');
      return;
    }

    const hasPassword = initialSettings?.hasPassword || false;
    const syncButtons = card.querySelectorAll('.sync-btn[data-action]');

    if (syncButtons.length === 0) {
      settingsLogger.debug('未找到需要控制的按钮，跳过更新');
      return;
    }

    syncButtons.forEach(button => {
      try {
        const action = button.dataset.action;
        const type = button.dataset.type;

        if (!action || !type) {
          settingsLogger.debug('按钮缺少必要属性', { action, type, buttonClass: button.className });
          return;
        }

        if (!button.isConnected) {
          settingsLogger.debug('按钮已从DOM中移除，跳过更新');
          return;
        }

        if (!hasPassword) {
          button.disabled = false;
          safeSetStyle(button, {
            opacity: '1',
            cursor: 'pointer',
            filter: 'none'
          });
          button.setAttribute('aria-disabled', 'false');
          safeClassList(button, 'remove', 'disabled');
        } else {
          button.disabled = false;
          safeSetStyle(button, {
            opacity: '1',
            cursor: 'pointer',
            filter: 'none'
          });
          button.setAttribute('aria-disabled', 'false');
          safeClassList(button, 'remove', 'disabled');
        }

        let tooltipText = '';
        if (type === 'index' && action === 'sync') {
          tooltipText = '重建搜索索引';
        } else if (type === 'thumbnail') {
          if (action === 'sync') tooltipText = '补全缺失的缩略图';
          else if (action === 'resync') tooltipText = '重新同步缩略图状态';
          else if (action === 'cleanup') tooltipText = '清理失效的缩略图文件';
        } else if (type === 'hls') {
          if (action === 'sync') tooltipText = '补全缺失的HLS流';
          else if (action === 'cleanup') tooltipText = '清理HLS缓存';
        }
        button.title = tooltipText;
      } catch (buttonError) {
        settingsLogger.warn('更新单个按钮状态失败', {
          error: buttonError?.message,
          buttonClass: button?.className,
          action: button?.dataset?.action,
          type: button?.dataset?.type
        });
      }
    });

    settingsLogger.debug('按钮状态已更新', {
      hasPassword,
      totalButtons: syncButtons.length
    });

    if (isDevelopment()) {
      const buttonStates = Array.from(syncButtons).map(button => ({
        action: button.dataset.action,
        type: button.dataset.type,
        disabled: button.disabled,
        pointerEvents: safeGetStyle(button, 'pointerEvents'),
        cursor: safeGetStyle(button, 'cursor')
      }));
      settingsLogger.debug('按钮状态详情', buttonStates);
    }

    syncButtons.forEach(button => {
      const currentDisplay = safeGetStyle(button, 'display');
      safeSetStyle(button, 'display', currentDisplay);
      // eslint-disable-next-line no-unused-expressions
      button.offsetHeight;
    });

  } catch (error) {
    const { card, initialSettings } = settingsContext;
    settingsLogger.error('更新按钮状态失败', {
      error: error?.message || '未知错误',
      stack: error?.stack,
      cardExists: !!card,
      initialSettings: !!initialSettings,
      hasPassword: initialSettings?.hasPassword,
      buttonCount: card ? card.querySelectorAll('.sync-btn[data-action]').length : 0
    });
  }
}

/**
 * 检测表单是否发生变更以控制保存按钮状态。
 * @returns {void}
 */
function checkForChanges() {
  const { card, initialSettings } = settingsContext;
  if (!card) return;
  const saveButtons = card.querySelectorAll('#security-settings-content .save-btn, #ai-settings-content .save-btn');
  if (saveButtons.length === 0) return;
  const currentData = {
    PASSWORD_ENABLED: card.querySelector('#password-enabled').checked,
    AI_ENABLED: card.querySelector('#ai-enabled').checked,
    AI_URL: card.querySelector('#ai-url').value,
    AI_MODEL: card.querySelector('#ai-model').value,
    AI_PROMPT: card.querySelector('#ai-prompt').value
  };
  let hasChanged = false;
  if (String(currentData.PASSWORD_ENABLED) !== String(initialSettings.PASSWORD_ENABLED === 'true') ||
    String(currentData.AI_ENABLED) !== String(initialSettings.AI_ENABLED === 'true') ||
    currentData.AI_URL !== initialSettings.AI_URL ||
    currentData.AI_MODEL !== initialSettings.AI_MODEL ||
    currentData.AI_PROMPT !== initialSettings.AI_PROMPT) {
    hasChanged = true;
  }
  if (card.querySelector('#new-password').value || card.querySelector('#ai-key').value) {
    hasChanged = true;
  }
  saveButtons.forEach(btn => {
    btn.disabled = !hasChanged;
  });
}

/**
 * 提交表单变更到后端并处理状态反馈。
 * @returns {Promise<void>} 保存流程完成的 Promise
 */
async function handleSave() {
  const { card, initialSettings } = settingsContext;
  if (!card) return;

  const saveButtons = card.querySelectorAll('#security-settings-content .save-btn, #ai-settings-content .save-btn');
  const newPassInput = card.querySelector('#new-password');
  const isPasswordEnabled = card.querySelector('#password-enabled').checked;
  const newPasswordValue = newPassInput.value;

  const isChangingPassword = isPasswordEnabled && newPasswordValue.trim() !== '' && initialSettings.hasPassword;
  const isDisablingPassword = !isPasswordEnabled && initialSettings.hasPassword;
  const needsAdmin = isChangingPassword || isDisablingPassword;

  if (needsAdmin) {
    if (!initialSettings.isAdminSecretConfigured) {
      showNotification('操作失败：未配置超级管理员密码', 'error');
      saveButtons.forEach(btn => {
        safeClassList(btn, 'remove', 'loading');
        btn.disabled = false;
      });
      return;
    }

    const shouldDisableAlbumDeletion = isDisablingPassword && initialSettings.albumDeletionEnabled;

    showPasswordPrompt({
      useAdminSecret: true,
      onConfirm: async (adminSecret) => {
        if (shouldDisableAlbumDeletion) {
          try {
            await toggleAlbumDeletion(false, adminSecret);
            initialSettings.albumDeletionEnabled = false;
            state.update('albumDeletionEnabled', false);
            updateAlbumDeletionControls();
            showNotification('已同时关闭相册删除功能', 'info');
          } catch (error) {
            throw error;
          }
        }

        return await executeSave(adminSecret, {
          suppressGlobalErrors: true,
          restoreToggleOnFailure: true
        });
      }
    });
  } else {
    try {
      await executeSave();
    } catch {
      // handled internally
    }
  }
}

async function executeSave(adminSecret = null, options = {}) {
  const { suppressGlobalErrors = false, restoreToggleOnFailure = false } = options;
  const { card, initialSettings } = settingsContext;
  if (!card) return false;

  const saveButtons = card.querySelectorAll('#security-settings-content .save-btn, #ai-settings-content .save-btn');
  saveButtons.forEach(btn => {
    safeClassList(btn, 'add', 'loading');
    btn.disabled = true;
  });

  const newPassInput = card.querySelector('#new-password');
  safeClassList(newPassInput, 'remove', 'input-error');

  const isPasswordEnabled = card.querySelector('#password-enabled').checked;
  const newPasswordValue = newPassInput.value;

  if (isPasswordEnabled && !initialSettings.hasPassword && !newPasswordValue) {
        showNotification('请设置新密码以启用密码访问', 'error');
        card.querySelector('button[data-tab="security"]').click();
        newPassInput.focus();
        safeClassList(newPassInput, 'add', 'input-error');
        saveButtons.forEach(btn => {
          safeClassList(btn, 'remove', 'loading');
          btn.disabled = false;
        });
    return false;
  }

  const localAI = {
    AI_ENABLED: String(card.querySelector('#ai-enabled').checked),
    AI_URL: card.querySelector('#ai-url').value.trim(),
    AI_MODEL: card.querySelector('#ai-model').value.trim(),
    AI_PROMPT: card.querySelector('#ai-prompt').value.trim(),
  };
  const newApiKey = card.querySelector('#ai-key').value;
  if (newApiKey) {
    localAI.AI_KEY = newApiKey;
  } else {
    const oldAI = getLocalAISettings();
    if (oldAI.AI_KEY) localAI.AI_KEY = oldAI.AI_KEY;
  }
  setLocalAISettings(localAI);

  const settingsToSend = {
    PASSWORD_ENABLED: String(isPasswordEnabled),
  };
  if (newPasswordValue) {
    settingsToSend.newPassword = newPasswordValue;
  }
  if (adminSecret) {
    settingsToSend.adminSecret = adminSecret;
  }

  try {
    const result = await saveSettings(settingsToSend);

    const prevPasswordEnabled = String(initialSettings.PASSWORD_ENABLED) === 'true';
    const nextPasswordEnabled = isPasswordEnabled;
    const aiPrevEnabled = String(initialSettings.AI_ENABLED) === 'true';
    const aiNextEnabled = String(card.querySelector('#ai-enabled').checked) === 'true';
    const newPassProvided = !!newPasswordValue.trim();

    const actions = [];
    if (prevPasswordEnabled !== nextPasswordEnabled) {
      actions.push(nextPasswordEnabled ? 'enable_password' : 'disable_password');
    } else if (nextPasswordEnabled && newPassProvided) {
      actions.push('change_password');
    }
    if (aiPrevEnabled !== aiNextEnabled) {
      actions.push(aiNextEnabled ? 'enable_ai' : 'disable_ai');
    }

    const buildMessage = (status, extraMsg) => {
      const parts = [];
      for (const act of actions) {
        switch (act) {
          case 'enable_password':
            parts.push(status === 'success' ? '访问密码已设置，请重新登录' : status === 'timeout' ? '启用访问密码超时' : '启用访问密码失败');
            break;
          case 'disable_password':
            parts.push(status === 'success' ? '访问密码已关闭' : status === 'timeout' ? '关闭访问密码超时' : '关闭访问密码失败');
            break;
          case 'change_password':
            parts.push(status === 'success' ? '访问密码已修改' : status === 'timeout' ? '修改访问密码超时' : '修改访问密码失败');
            break;
          case 'enable_ai':
            parts.push(status === 'success' ? 'AI密语功能已打开' : status === 'timeout' ? '开启 AI 密语功能超时' : '开启 AI 密语功能失败');
            break;
          case 'disable_ai':
            parts.push(status === 'success' ? 'AI密语功能已关闭' : status === 'timeout' ? '关闭 AI 密语功能超时' : '关闭 AI 密语功能失败');
            break;
        }
      }
      if (parts.length === 0) {
        parts.push(status === 'success' ? '设置更新成功' : status === 'timeout' ? '设置更新超时' : (extraMsg || '设置更新失败'));
      }
      if (extraMsg && status !== 'success') parts.push(extraMsg);
      return parts.join('；');
    };

    if (result && result.status === 'pending' && result.updateId) {
      const { final, info } = await waitForSettingsUpdate(result.updateId, { intervalMs: 1000, timeoutMs: 30000 });
      if (final === 'success') {
        showNotification(buildMessage('success'), 'success');
      } else if (final === 'failed') {
        const extra = (info && info.message) ? info.message : null;
        showNotification(buildMessage('failed', extra), 'error');
      } else if (final === 'timeout') {
        showNotification(buildMessage('timeout'), 'warn');
      } else {
        const msg = info && info.message ? info.message : '设置更新发生错误';
        showNotification(buildMessage('failed', msg), 'error');
      }
    } else {
      showNotification(buildMessage('success', result && result.message), 'success');
    }

    state.update('aiEnabled', localAI.AI_ENABLED === 'true');
    state.update('passwordEnabled', settingsToSend.PASSWORD_ENABLED === 'true');

    setTimeout(() => {
      updateButtonStates();
    }, 200);

    if (prevPasswordEnabled !== nextPasswordEnabled) {
      removeAuthToken();

      window.dispatchEvent(new CustomEvent('auth:statusChanged', {
        detail: { passwordEnabled: settingsToSend.PASSWORD_ENABLED === 'true' }
      }));
    }

    window.dispatchEvent(new CustomEvent('settingsChanged', {
      detail: {
        aiEnabled: localAI.AI_ENABLED === 'true',
        passwordEnabled: settingsToSend.PASSWORD_ENABLED === 'true',
        aiSettings: localAI
      }
    }));

    initialSettings.PASSWORD_ENABLED = settingsToSend.PASSWORD_ENABLED;
    initialSettings.hasPassword = settingsToSend.PASSWORD_ENABLED === 'true';
    updateAlbumDeletionControls();

    setTimeout(closeSettingsModal, 1000);
    saveButtons.forEach(btn => {
      safeClassList(btn, 'remove', 'loading');
      btn.disabled = false;
    });
    checkForChanges();
    return true;
  } catch (error) {
    if (!suppressGlobalErrors) {
      showNotification(error.message, 'error');
    }
    if (error.message.includes('密码')) {
      const oldPassInput = card.querySelector('#old-password');
      const target = (error.message.includes('旧密码') && oldPassInput) ? oldPassInput : newPassInput;
      safeClassList(target, 'add', 'input-error');
      target.focus();
    }
    if (restoreToggleOnFailure) {
      const passwordToggle = card.querySelector('#password-enabled');
      if (passwordToggle) {
        passwordToggle.checked = initialSettings.PASSWORD_ENABLED === 'true';
        updateButtonStates();
      }
    }
    saveButtons.forEach(btn => {
      safeClassList(btn, 'remove', 'loading');
      btn.disabled = false;
    });
    checkForChanges();
    throw error;
  }
}
