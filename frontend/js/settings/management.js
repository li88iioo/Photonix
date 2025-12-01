/**
 * @file frontend/js/settings/management.js
 * @description 管理设置相关功能，包括手动同步、管理员验证等逻辑
 */

import settingsContext from './context.js';
import { settingsLogger } from './logger.js';
import { state } from '../core/state.js';
import { manualAlbumSync, toggleAlbumDeletion, updateManualSyncSchedule, verifyAdminSecret } from '../app/api.js';
import { showNotification, resolveMessage } from '../shared/utils.js';
import { safeSetInnerHTML} from '../shared/dom-utils.js';
import { showPasswordPrompt } from './password-prompt.js';
import { loadStatusTables } from './status.js';
import { closeSettingsModal } from './modal.js';

const DOWNLOAD_SECRET_STORAGE_KEY = 'photonix:download:adminSecret';
const DOWNLOAD_VERIFIED_AT_KEY = 'photonix:download:verifiedAt';
const DOWNLOAD_VERIFICATION_MAX_AGE = 12 * 60 * 60 * 1000; // 12 小时

function getStoredDownloadSecret() {
  try {
    const value = localStorage.getItem(DOWNLOAD_SECRET_STORAGE_KEY);
    return value ? String(value) : null;
  } catch {
    return null;
  }
}

function getStoredDownloadVerifiedAt() {
  try {
    const raw = localStorage.getItem(DOWNLOAD_VERIFIED_AT_KEY);
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function isDownloadVerificationFresh(timestamp) {
  if (!timestamp) return false;
  return Date.now() - Number(timestamp) <= DOWNLOAD_VERIFICATION_MAX_AGE;
}

/**
 * 初始化管理选项卡的手动同步、相册删除开关及相关控制逻辑
 * @function
 * @returns {void}
 */
export function setupManagementTab() {
  const { card, initialSettings } = settingsContext;
  if (!card) return;

  const manualBtn = card.querySelector('#manual-sync-btn');
  const reportEl = card.querySelector('#manual-sync-report');
  if (reportEl) {
    safeSetInnerHTML(reportEl, '');
  }

  renderManualSyncScheduleStatus(initialSettings.manualSyncStatus || null);

  if (manualBtn) {
    const originalManualText = manualBtn.textContent;

    /**
     * 切换手动同步按钮的加载状态
     * @param {boolean} loading
     */
    const setLoading = (loading) => {
      manualBtn.disabled = loading;
      manualBtn.classList.toggle('loading', loading);
      manualBtn.textContent = loading ? '执行中...' : originalManualText;
    };

    /**
     * 执行手动同步逻辑
     * @param {string} adminSecret
     * @returns {Promise<boolean>}
     */
    const performManualSync = async (adminSecret) => {
      setLoading(true);

      try {
        const result = await manualAlbumSync(adminSecret);
        const successMessage = resolveMessage(result?.message, '手动同步完成');
        renderManualSyncReport(result?.summary, result?.timestamp, successMessage);
        showNotification(successMessage, 'success');

        const statusSnapshot = initialSettings.manualSyncStatus || {};
        const derivedType = statusSnapshot?.type || (initialSettings.manualSyncSchedule === 'off'
          ? 'off'
          : (initialSettings.manualSyncSchedule.includes(' ') ? 'cron' : 'interval'));

        initialSettings.manualSyncStatus = {
          ...statusSnapshot,
          schedule: statusSnapshot?.schedule || initialSettings.manualSyncSchedule,
          type: derivedType,
          lastRunAt: new Date().toISOString(),
          nextRunAt: statusSnapshot?.nextRunAt || null,
          running: false
        };
        renderManualSyncScheduleStatus(initialSettings.manualSyncStatus);

        if (scheduleInput) {
          scheduleInput.value = initialSettings.manualSyncSchedule || 'off';
        }
        if (typeof state?.update === 'function') {
          state.update('manualSyncSchedule', initialSettings.manualSyncSchedule);
        }
        showNotification('自动维护计划未保存，当前仍按已保存的计划执行', 'info');

        await loadStatusTables({ silent: true });

        return true;
      } catch (error) {
        const errorMessage = resolveMessage(error, '手动同步失败');
        showNotification(errorMessage, 'error');
        throw new Error(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    manualBtn.addEventListener('click', () => {
      const hasPassword = initialSettings?.hasPassword || false;
      if (!hasPassword) {
        showNotification('需要先设置访问密码才能使用这些功能', 'warning');
        return;
      }

      if (!initialSettings.isAdminSecretConfigured) {
        showNotification('未配置超级管理员密码，无法执行此操作', 'error');
        return;
      }

      showPasswordPrompt({
        useAdminSecret: true,
        onConfirm: async (adminSecret) => {
          await verifyAdminSecret(adminSecret);
          performManualSync(adminSecret).catch((error) => {
            settingsLogger.error('手动同步执行失败:', error?.message || error);
          });
          return true;
        },
        onCancel: () => {
          setLoading(false);
        }
      });
    });
  }

  const deleteToggle = card.querySelector('#album-delete-toggle');
  const toggleRow = card.querySelector('#album-delete-toggle-row');
  if (deleteToggle) {
    /**
     * 获取当前删除功能被禁用的原因
     * @returns {string}
     */
    const getDisabledReason = () => {
      if (!initialSettings?.hasPassword) {
        return '需要先设置访问密码才能使用这些功能';
      }
      if (!initialSettings.isAdminSecretConfigured) {
        return '未配置超级管理员密码，无法更改此设置';
      }
      return '';
    };

    /**
     * 同步删除开关的视觉状态
     * @param {boolean} [enabled]
     */
    const syncToggleVisualState = (enabled = initialSettings.albumDeletionEnabled) => {
      if (toggleRow) {
        toggleRow.setAttribute('aria-pressed', String(Boolean(enabled)));
      }
    };

    /**
     * 应用禁用状态到删除开关
     */
    const applyDisabledState = () => {
      const disabledReason = getDisabledReason();
      const disabled = Boolean(disabledReason);
      deleteToggle.disabled = disabled;
      deleteToggle.title = disabled ? disabledReason : '';
      if (toggleRow) {
        toggleRow.classList.toggle('disabled', disabled);
        if (disabled) {
          toggleRow.setAttribute('aria-disabled', 'true');
        } else {
          toggleRow.removeAttribute('aria-disabled');
        }
      }
    };

    /**
     * 设置删除开关的选中和禁用状态
     * @param {boolean} enabled
     */
    const setToggleState = (enabled) => {
      deleteToggle.checked = Boolean(enabled);
      syncToggleVisualState(enabled);
      applyDisabledState();
    };

    /**
     * 处理删除开关的切换意图（带验证）
     * @param {boolean} desired
     */
    const handleToggleIntent = (desired) => {
      const disabledReason = getDisabledReason();
      if (disabledReason) {
        showNotification(disabledReason, 'warning');
        setToggleState(initialSettings.albumDeletionEnabled);
        return;
      }

      showPasswordPrompt({
        useAdminSecret: true,
        onConfirm: async (adminSecret) => {
          try {
            await toggleAlbumDeletion(desired, adminSecret);
            initialSettings.albumDeletionEnabled = desired;
            state.update('albumDeletionEnabled', desired);
            setToggleState(desired);
            window.dispatchEvent(new CustomEvent('settingsChanged', {
              detail: { albumDeletionEnabled: desired }
            }));
            showNotification(desired ? '已启用相册删除' : '已禁用相册删除', 'success');
            return true;
          } catch (error) {
            const message = resolveMessage(error, '更新失败');
            settingsLogger.warn('切换相册删除失败', { error: message });
            setToggleState(initialSettings.albumDeletionEnabled);
            throw new Error(message);
          }
        },
        onCancel: () => {
          setToggleState(initialSettings.albumDeletionEnabled);
        }
      });
    };

    setToggleState(initialSettings.albumDeletionEnabled);

    deleteToggle.addEventListener('change', (event) => {
      event.preventDefault();
      const desired = event.target.checked;
      setToggleState(initialSettings.albumDeletionEnabled);
      handleToggleIntent(desired);
    });

    if (toggleRow) {
      /**
       * 试图切换状态，包括检查前置条件
       */
      const attemptToggle = () => {
        const disabledReason = getDisabledReason();
        if (disabledReason) {
          showNotification(disabledReason, 'warning');
          return;
        }
        const desired = !Boolean(initialSettings.albumDeletionEnabled);
        handleToggleIntent(desired);
      };

      toggleRow.addEventListener('click', (event) => {
        event.preventDefault();
        attemptToggle();
      });

      toggleRow.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          attemptToggle();
        }
      });
    }
  }

  const downloadCard = card.querySelector('#download-service-card');
  if (downloadCard) {
    const openBtn = downloadCard.querySelector('#download-service-open-btn');
    const computeDisabledReason = () => {
      if (!initialSettings?.hasPassword) {
        return '需要先设置访问密码才能使用这些功能';
      }
      if (!initialSettings.isAdminSecretConfigured) {
        return '未配置超级管理员密码，无法执行此操作';
      }
      return '';
    };

    const applyDownloadButtonState = () => {
      if (!openBtn) return;
      const reason = computeDisabledReason();
      openBtn.disabled = Boolean(reason);
      openBtn.title = reason || '';
    };

    applyDownloadButtonState();

    if (downloadCard.dataset.downloadListenersBound !== 'true') {
      window.addEventListener('settingsChanged', applyDownloadButtonState);

      if (!openBtn) {
        downloadCard.dataset.downloadListenersBound = 'true';
        return;
      }

      openBtn.addEventListener('click', async () => {
        const reason = computeDisabledReason();
        if (reason) {
          showNotification(reason, 'warning');
          return;
        }

        const attemptOpen = (adminSecret) => {
          window.__PHOTONIX_DOWNLOAD_ADMIN_SECRET__ = adminSecret;
          try {
            localStorage.setItem(DOWNLOAD_SECRET_STORAGE_KEY, adminSecret);
            localStorage.setItem(DOWNLOAD_VERIFIED_AT_KEY, String(Date.now()));
          } catch {}
          closeSettingsModal();
          window.location.hash = '#/download';
        };

        const storedSecret = getStoredDownloadSecret();
        const storedAt = getStoredDownloadVerifiedAt();
        if (storedSecret && isDownloadVerificationFresh(storedAt)) {
          try {
            await verifyAdminSecret(storedSecret);
            attemptOpen(storedSecret);
            return;
          } catch (error) {
            try {
              localStorage.removeItem(DOWNLOAD_SECRET_STORAGE_KEY);
              localStorage.removeItem(DOWNLOAD_VERIFIED_AT_KEY);
            } catch {}
          }
        }

        showPasswordPrompt({
          useAdminSecret: true,
          onConfirm: async (adminSecret) => {
            await verifyAdminSecret(adminSecret);
            attemptOpen(adminSecret);
            return true;
          }
        });
      });

      downloadCard.dataset.downloadListenersBound = 'true';
    }
  }

  const scheduleInput = card.querySelector('#manual-sync-schedule');
  const scheduleSaveBtn = card.querySelector('#manual-sync-schedule-save');
  if (scheduleInput) {
    scheduleInput.value = initialSettings.manualSyncSchedule || 'off';
  }

  if (scheduleSaveBtn) {
    const originalText = scheduleSaveBtn.textContent;

    /**
     * 切换保存按钮保存状态
     * @param {boolean} saving
     */
    const setSaving = (saving) => {
      scheduleSaveBtn.disabled = saving;
      scheduleSaveBtn.classList.toggle('loading', saving);
      scheduleSaveBtn.textContent = saving ? '保存中...' : originalText;
    };

    scheduleSaveBtn.addEventListener('click', () => {
      const hasPassword = initialSettings?.hasPassword || false;
      if (!hasPassword) {
        showNotification('需要先设置访问密码才能使用这些功能', 'warning');
        return;
      }

      if (!initialSettings.isAdminSecretConfigured) {
        showNotification('未配置超级管理员密码，无法执行此操作', 'error');
        return;
      }

      const rawValue = (scheduleInput?.value || '').trim();
      const validation = validateManualSyncSchedule(rawValue);
      if (!validation.ok) {
        showNotification(validation.message, 'error');
        return;
      }

      showPasswordPrompt({
        useAdminSecret: true,
        onConfirm: async (adminSecret) => {
          try {
            setSaving(true);
            const result = await updateManualSyncSchedule(validation.normalized, adminSecret);
            initialSettings.manualSyncSchedule = result?.schedule || validation.normalized;
            initialSettings.manualSyncStatus = {
              schedule: result?.schedule || validation.normalized,
              type: result?.type || (validation.type || 'off'),
              nextRunAt: result?.nextRunAt || null,
              lastRunAt: result?.lastRunAt || null,
              running: result?.running || false
            };
            state.update('manualSyncSchedule', initialSettings.manualSyncSchedule);
            renderManualSyncScheduleStatus(initialSettings.manualSyncStatus);
            if (scheduleInput) {
              scheduleInput.value = initialSettings.manualSyncSchedule;
            }
            const detail = {
              manualSyncSchedule: initialSettings.manualSyncSchedule,
              manualSyncStatus: initialSettings.manualSyncStatus
            };
            window.dispatchEvent(new CustomEvent('settingsChanged', { detail }));
            showNotification(result?.message || '已更新自动维护计划', 'success');
            setSaving(false);
            return true;
          } catch (error) {
            const message = resolveMessage(error, '更新失败');
            settingsLogger.warn('更新自动维护计划失败', { error: message });
            setSaving(false);
            throw new Error(message);
          }
        },
        onCancel: () => {
          setSaving(false);
        }
      });
    });
  }
}

/**
 * 渲染手动同步结果到报告区域
 * @function
 * @param {Record<string, any>} summary - 手动同步返回的统计信息
 * @param {string|number|Date} timestamp - 同步执行完成时间
 * @param {string} message - 展示给用户的摘要文案
 * @returns {void}
 */
export function renderManualSyncReport(summary, timestamp, message) {
  const { card } = settingsContext;
  if (!card) return;
  const report = card.querySelector('#manual-sync-report');
  if (!report) return;
  safeSetInnerHTML(report, '');
  if (!summary && !message) return;

  const lines = [];
  if (message) {
    lines.push(message);
  }

  if (summary) {
    const addedAlbums = Number(summary?.added?.albums || 0);
    const addedMedia = Number(summary?.added?.media || 0);
    const removedAlbums = Number(summary?.removed?.albums || 0);
    const removedMedia = Number(summary?.removed?.media || 0);
    const totalChanges = Number(summary?.totalChanges ?? (addedAlbums + addedMedia + removedAlbums + removedMedia));

    if (totalChanges > 0) {
      lines.push(`共处理 ${totalChanges} 项变更：新增 ${addedAlbums} 个相册、${addedMedia} 个文件；删除 ${removedAlbums} 个相册、${removedMedia} 个文件。`);
    } else {
      lines.push('未检测到需要变更的内容，一切保持最新状态。');
    }
  } else if (!message) {
    lines.push('未检测到需要变更的内容，一切保持最新状态。');
  }

  if (timestamp) {
    try {
      lines.push(`时间：${new Date(timestamp).toLocaleString()}`);
    } catch {
      lines.push(`时间：${timestamp}`);
    }
  }

  const fragment = document.createDocumentFragment();
  lines.forEach((text) => {
    const p = document.createElement('p');
    p.textContent = text;
    fragment.appendChild(p);
  });
  report.appendChild(fragment);
}

/**
 * 校验手动同步计划输入是否合法，返回标准化计划对象
 * @function
 * @param {string} rawValue 用户输入的计划字符串
 * @returns {Object} 解析后的计划信息 {ok, normalized, type, [minutes], message}
 */
function validateManualSyncSchedule(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) {
    return { ok: true, normalized: 'off', type: 'off', message: '' };
  }

  if (value.toLowerCase() === 'off') {
    return { ok: true, normalized: 'off', type: 'off', message: '' };
  }

  if (/^\d+$/.test(value)) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { ok: false, message: '分钟间隔必须为正整数' };
    }
    if (minutes > 24 * 60 * 7) {
      return { ok: false, message: '分钟间隔过大，建议小于 10080' };
    }
    return { ok: true, normalized: String(minutes), type: 'interval', minutes };
  }

  const fields = value.split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    return { ok: false, message: 'Cron 表达式需由 5 个字段组成 (分 时 日 月 星期)' };
  }

  const cronFieldPattern = /^[0-9*\/,-]+$/;
  const valid = fields.every((field) => cronFieldPattern.test(field));
  if (!valid) {
    return { ok: false, message: 'Cron 字段仅支持数字、*、/、-、, 组合' };
  }

  return { ok: true, normalized: value, type: 'cron' };
}

/**
 * 格式化时间戳为本地化日期字符串
 * @function
 * @param {string|number|Date|null} timestamp 需要展示的时间
 * @returns {string} 本地化字符串
 */
function formatScheduleDate(timestamp) {
  if (!timestamp) return '未定';
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return timestamp;
  }
}

/**
 * 渲染同步计划及最新状态信息到页面
 * @function
 * @param {null|{schedule?: string, type?: string, lastRunAt?: string, nextRunAt?: string, running?: boolean}} status 手动同步状态对象
 * @returns {void}
 */
export function renderManualSyncScheduleStatus(status) {
  const { card } = settingsContext;
  if (!card) return;

  const statusEl = card.querySelector('#manual-sync-schedule-status');
  if (!statusEl) return;

  safeSetInnerHTML(statusEl, '');

  if (!status) {
    const p = document.createElement('p');
    p.textContent = '尚未配置自动维护计划。需要同步时，可随时点击上方按钮手动执行。';
    statusEl.appendChild(p);
    return;
  }

  const schedule = status.schedule || 'off';
  const normalizedType = status.type || (schedule === 'off' ? 'off' : (String(schedule).includes(' ') ? 'cron' : 'interval'));
  const messages = [];

  if (normalizedType === 'off' || schedule === 'off') {
    messages.push('自动维护已关闭，系统不会在后台自动扫描。');
    messages.push('当需要刷新内容时，可手动触发同步任务。');
  } else {
    if (normalizedType === 'interval') {
      messages.push(`自动维护已开启，将每 ${schedule} 分钟自动同步一次。`);
    } else {
      messages.push(`自动维护已开启，按照 cron 表达式 ${schedule} 执行同步。`);
    }

    if (status.nextRunAt) {
      messages.push(`下一次同步计划在 ${formatScheduleDate(status.nextRunAt)} 触发。`);
    } else {
      messages.push('正在计算下一次同步时间，请稍候。');
    }
  }

  if (status.lastRunAt) {
    messages.push(`最近一次同步发生在 ${formatScheduleDate(status.lastRunAt)}。`);
  }

  if (status.running) {
    messages.push('后台同步正在运行，请稍候查看结果。');
  }

  const fragment = document.createDocumentFragment();
  messages.forEach((text) => {
    const p = document.createElement('p');
    p.textContent = text;
    fragment.appendChild(p);
  });
  statusEl.appendChild(fragment);
}
