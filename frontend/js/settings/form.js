/**
 * @file frontend/js/settings/form.js
 * @description 处理设置表单渲染、交互与保存流程
 */

import settingsContext from './context.js';
import { settingsLogger } from './logger.js';
import { saveSettings, waitForSettingsUpdate, toggleAlbumDeletion } from '../app/api.js';
import { showNotification } from '../shared/utils.js';
import { iconGitHub } from '../shared/svg-templates.js';
import { removeAuthToken } from '../app/auth.js';
import { SETTINGS, isDevelopment } from '../core/constants.js';
import { setupApiUrlAutoComplete, setupModelDropdownControls, attemptModelFetch } from './ai.js';
import { setupManagementTab, renderManualSyncScheduleStatus } from './management.js';
import { loadStatusTables } from './status.js';
import { getLocalAISettings, setLocalAISettings } from './storage.js';
import { showPasswordPrompt } from './password-prompt.js';
import { closeSettingsModal } from './modal.js';
import { state } from '../core/state.js';
import { exportConversationHistory, importConversationHistory } from '../features/ai/ai-conversation-store.js';

// 注入 GitHub 链接
const GITHUB_LINK_HTML = `
  ${iconGitHub()}
  <span>GitHub</span>
`;

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
  setupModelDropdownControls();
  card.querySelector('#ai-key').value = '';
  card.querySelector('#ai-model').value = settings.AI_MODEL || '';
  card.querySelector('#ai-prompt').value = settings.AI_PROMPT || '';
  const aiDailyLimitInput = card.querySelector('#ai-daily-limit');
  if (aiDailyLimitInput) {
    aiDailyLimitInput.value = String(settings.AI_DAILY_LIMIT || '');
  }

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

  // Inject GitHub link
  if (nav && !nav.querySelector('.github-link')) {
    const githubLink = document.createElement('a');
    githubLink.href = 'https://github.com/li88iioo/Photonix';
    githubLink.target = '_blank';
    githubLink.className = 'github-link mt-auto';
    githubLink.innerHTML = GITHUB_LINK_HTML;
    nav.appendChild(githubLink);
  }

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
    nav.querySelector('.active')?.classList.remove('active');
    panels.forEach(p => p?.classList.remove('active'));
    btn?.classList.add('active');
    const targetTab = card.querySelector(`#${btn.dataset.tab}-settings-content`);
    if (targetTab) {
      targetTab?.classList.add('active');
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

  card.querySelectorAll('input:not(#password-enabled):not(#ai-daily-limit), textarea').forEach(el => {
    el.addEventListener('input', checkForChanges);
    el.addEventListener('change', checkForChanges);
  });

  if (newPasswordInput) {
    newPasswordInput.addEventListener('input', () => {
      newPasswordInput?.classList.remove('input-error');
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
  setupDailyLimitControls();
  setupConversationHistoryTools();
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
    openEye.style.display = input.type === 'password' ? 'block' : 'none';
    closedEye.style.display = input.type === 'password' ? 'none' : 'block';
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      openEye.style.display = isPassword ? 'none' : 'block';
      closedEye.style.display = isPassword ? 'block' : 'none';
      const originalColor = icon.style.color;
      icon.style.color = 'white';
      setTimeout(() => {
        icon.style.color = originalColor || '';
      }, 200);
    });
  });
}

function setupDailyLimitControls() {
  const { card, initialSettings } = settingsContext;
  if (!card) return;

  const input = card.querySelector('#ai-daily-limit');
  const button = card.querySelector('#ai-daily-limit-save');
  if (!input || !button) return;

  const setLoading = (loading) => {
    if (loading) {
      if (!button.dataset.originalText) {
        button.dataset.originalText = button.textContent;
      }
      button.textContent = '保存中...';
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || '保存';
      button.disabled = false;
    }
  };

  button.addEventListener('click', () => {
    if (!initialSettings.isAdminSecretConfigured) {
      showNotification('未配置超级管理员密码，无法更改此设置', 'error');
      return;
    }
    const rawValue = input.value.trim();
    if (!rawValue) {
      showNotification('请填写 AI 每日配额上限', 'error');
      input.focus();
      return;
    }
    const parsed = parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10000) {
      showNotification('AI 每日配额需设置为 1 - 10000 之间的整数', 'error');
      input.focus();
      return;
    }

    const normalized = String(parsed);
    if (normalized === String(initialSettings.AI_DAILY_LIMIT ?? '')) {
      showNotification('当前配额未改变，无需保存', 'info');
      return;
    }

    showPasswordPrompt({
      useAdminSecret: true,
      onConfirm: async (adminSecret) => {
        setLoading(true);
        try {
          await saveSettings({ AI_DAILY_LIMIT: normalized }, adminSecret);
          initialSettings.AI_DAILY_LIMIT = normalized;
          input.value = normalized;
          showNotification('AI 每日配额已更新', 'success');
        } catch (error) {
          showNotification(error?.message || '更新 AI 配额失败', 'error');
          throw error;
        } finally {
          setLoading(false);
        }
      }
    });
  });
}

function setupConversationHistoryTools() {
  const { card } = settingsContext;
  if (!card) return;
  const exportBtn = card.querySelector('#ai-history-export');
  const importBtn = card.querySelector('#ai-history-import');
  const importInput = card.querySelector('#ai-history-import-input');
  if (!exportBtn && !importBtn) return;

  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      let data = null;
      try {
        data = await exportConversationHistory();
      } catch (error) {
        showNotification('导出失败，请稍后重试', 'error');
        return;
      }
      const total = data ? Object.keys(data).length : 0;
      if (!total) {
        showNotification('暂无会话可导出', 'info');
        return;
      }
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        conversations: data
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `photonix-ai-history-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showNotification('已导出 AI 会话历史', 'success');
    });
  }

  if (importBtn && importInput) {
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async (event) => {
      const file = event.target?.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          showNotification('导入失败：文件不是有效的 JSON', 'error');
          return;
        }
        const result = await importConversationHistory(parsed);
        if (result.ok) {
          const { conversations = 0, entries = 0 } = result.stats || {};
          showNotification(`导入成功：${conversations} 张照片，共 ${entries} 条记录`, 'success');
        } else {
          showNotification(result.reason || '导入失败：文件格式不正确', 'error');
        }
      } catch (error) {
        showNotification(error?.message || '导入失败，请重试', 'error');
      } finally {
        event.target.value = '';
      }
    });
  }
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
    passwordSettingsGroup.style.display = isPasswordEnabled ? 'block' : 'none';
  }
  if (apiSettingsGroup) {
    apiSettingsGroup.style.display = isAiEnabled ? 'block' : 'none';
  }

  const shouldDisable = hasPassword && !initialSettings.isAdminSecretConfigured;

  passwordEnabledWrapper?.classList.toggle('disabled', shouldDisable);
  passwordEnabledWrapper.title = shouldDisable ? '未配置超级管理员密码，无法更改此设置' : '';

  if (isPasswordEnabled && newPasswordInput) {
    newPasswordInput.disabled = shouldDisable;
    newPasswordWrapper?.classList.toggle('disabled', shouldDisable);
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
          Object.assign(button.style, {
            opacity: '1',
            cursor: 'pointer',
            filter: 'none'
          });
          button.setAttribute('aria-disabled', 'false');
          button?.classList.remove('disabled');
        } else {
          button.disabled = false;
          Object.assign(button.style, {
            opacity: '1',
            cursor: 'pointer',
            filter: 'none'
          });
          button.setAttribute('aria-disabled', 'false');
          button?.classList.remove('disabled');
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
        pointerEvents: getComputedStyle(button).pointerEvents,
        cursor: getComputedStyle(button).cursor
      }));
      settingsLogger.debug('按钮状态详情', buttonStates);
    }

    syncButtons.forEach(button => {
      const currentDisplay = getComputedStyle(button).display;
      button.style.display = currentDisplay;
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

  const hasNewPasswordValue = newPasswordValue.trim() !== '';
  const isSettingOrChangingPassword = isPasswordEnabled && hasNewPasswordValue;
  const isDisablingPassword = !isPasswordEnabled && initialSettings.hasPassword;
  const needsAdmin = isSettingOrChangingPassword || isDisablingPassword;

  if (needsAdmin) {
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
    btn?.classList.add('loading');
    btn.disabled = true;
  });

  const newPassInput = card.querySelector('#new-password');
  newPassInput?.classList.remove('input-error');

  const isPasswordEnabled = card.querySelector('#password-enabled').checked;
  const newPasswordValue = newPassInput.value;

  if (isPasswordEnabled && !initialSettings.hasPassword && !newPasswordValue) {
    showNotification('请设置新密码以启用密码访问', 'error');
    card.querySelector('button[data-tab="security"]').click();
    newPassInput.focus();
    newPassInput?.classList.add('input-error');
    saveButtons.forEach(btn => {
      btn?.classList.remove('loading');
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
    if (newApiKey.trim() && !localStorage.getItem('ai_security_hint_seen')) {
      showNotification('提示：API 密钥保存在浏览器本地，请只安装可信的浏览器插件。', 'info');
      localStorage.setItem('ai_security_hint_seen', 'true');
    }
  } else {
    const oldAI = getLocalAISettings();
    if (oldAI.AI_KEY) localAI.AI_KEY = oldAI.AI_KEY;
  }
  setLocalAISettings(localAI);
  card.querySelector('#ai-key').value = '';

  const aiPrevEnabled = String(initialSettings.AI_ENABLED) === 'true';
  const aiNextEnabled = localAI.AI_ENABLED === 'true';
  const aiSettingsChanged =
    aiPrevEnabled !== aiNextEnabled ||
    (localAI.AI_URL || '') !== (initialSettings.AI_URL || '') ||
    (localAI.AI_MODEL || '') !== (initialSettings.AI_MODEL || '') ||
    (localAI.AI_PROMPT || '') !== (initialSettings.AI_PROMPT || '');

  const settingsToSend = {
    PASSWORD_ENABLED: String(isPasswordEnabled),
  };
  if (newPasswordValue) {
    settingsToSend.newPassword = newPasswordValue;
  }

  const passwordStateChanged = String(isPasswordEnabled) !== String(initialSettings.PASSWORD_ENABLED === 'true');
  const newPassProvided = !!newPasswordValue.trim();
  const needsServerSave = passwordStateChanged || newPassProvided;

  if (!needsServerSave) {
    initialSettings.AI_ENABLED = localAI.AI_ENABLED;
    initialSettings.AI_URL = localAI.AI_URL;
    initialSettings.AI_MODEL = localAI.AI_MODEL;
    initialSettings.AI_PROMPT = localAI.AI_PROMPT;
    if (localAI.AI_KEY) {
      initialSettings.AI_KEY = localAI.AI_KEY;
    }

    state.update('aiEnabled', aiNextEnabled);

    window.dispatchEvent(new CustomEvent('settingsChanged', {
      detail: {
        aiEnabled: aiNextEnabled,
        aiSettings: localAI
      }
    }));

    const message = aiPrevEnabled !== aiNextEnabled
      ? (aiNextEnabled ? 'AI密语功能已打开' : 'AI密语功能已关闭')
      : (aiSettingsChanged ? 'AI 设置已更新' : 'AI 设置未改变');
    showNotification(message, 'success');

    saveButtons.forEach(btn => {
      btn?.classList.remove('loading');
      btn.disabled = true;
    });
    checkForChanges();
    setTimeout(() => {
      closeSettingsModal();
    }, 600);
    return true;
  }

  try {
    const result = await saveSettings(settingsToSend, adminSecret);

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
      btn?.classList.remove('loading');
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
      target?.classList.add('input-error');
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
      btn?.classList.remove('loading');
      btn.disabled = false;
    });
    checkForChanges();
    throw error;
  }
}
