/**
 * @file frontend/js/settings/index.js
 * @description 管理设置模态框的初始化、数据加载与渲染流程
 */

import settingsContext, { initializeContext, setInitialSettings } from './context.js';
import { settingsLogger } from './logger.js';
import { fetchSettings } from '../app/api.js';
import { safeClassList, safeSetInnerHTML } from '../shared/dom-utils.js';
import { populateForm, setupListeners } from './form.js';
import { setupSyncButtonListeners, loadStatusTables, triggerSync, showPodLoading } from './status.js';
import { getLocalAISettings, setLocalAISettings } from './storage.js';
import { state } from '../core/state.js';
import { SETTINGS } from '../core/constants.js';

initializeContext();

/**
 * 拉取设置数据并渲染设置弹窗。
 * @async
 * @function showSettingsModal
 * @returns {Promise<void>} 异步，无返回值
 */
export async function showSettingsModal() {
  const context = initializeContext();
  const { template } = context;

  // 使用共享对话框外壳
  const shell = (await import('../app/modal.js')).createModalShell({
    title: '设置',
    asForm: false,
    mobileFullscreen: true,
    useHeader: false,
    onClose: () => {
      try { safeSetInnerHTML(shell.body, ''); } catch {}
    }
  });
  context.modal = shell.container;
  context.card = shell.body;
  context.close = shell.close;

  // 展示 loading 状态
  safeSetInnerHTML(
    shell.body,
    '<div style="display:flex;justify-content:center;align-items:center;height:100%;"><div class="spinner" style="width:3rem;height:3rem;"></div></div>'
  );

  try {
    // 获取服务端设置和本地 AI 配置
    const settings = await fetchSettings();
    const localAI = getLocalAISettings();

    // 合并 AI 相关设置（优先本地配置）
    settings.AI_ENABLED = typeof localAI.AI_ENABLED !== 'undefined' ? localAI.AI_ENABLED : 'false';
    settings.AI_URL = localAI.AI_URL ?? '';
    settings.AI_MODEL = localAI.AI_MODEL ?? 'gemini-2.0-flash';
    settings.AI_PROMPT = localAI.AI_PROMPT ?? SETTINGS.DEFAULT_AI_PROMPT;
    settings.AI_KEY = '';

    // 合并所有设置
    const combined = { ...settings, ...localAI };
    combined.albumDeletionEnabled = Boolean(settings.albumDeletionEnabled);
    combined.manualSyncSchedule = settings.manualSyncSchedule || 'off';

    // 推断同步计划类型
    const derivedType =
      combined.manualSyncSchedule === 'off'
        ? 'off'
        : combined.manualSyncSchedule.includes(' ')
        ? 'cron'
        : 'interval';

    // 填充同步任务状态
    combined.manualSyncStatus =
      settings.manualSyncStatus || {
        schedule: combined.manualSyncSchedule,
        type: derivedType,
        nextRunAt: null,
        lastRunAt: null,
        running: false
      };
    combined.isAdminSecretConfigured = Boolean(settings.isAdminSecretConfigured);

    // 保存原始设置数据
    setInitialSettings(combined);

    // 更新全局状态
    state.update('albumDeletionEnabled', combined.albumDeletionEnabled);
    state.update('manualSyncSchedule', combined.manualSyncSchedule);
    state.update('adminSecretConfigured', combined.isAdminSecretConfigured);

    // 广播设置更改事件
    window.dispatchEvent(
      new CustomEvent('settingsChanged', {
        detail: {
          albumDeletionEnabled: combined.albumDeletionEnabled,
          manualSyncSchedule: combined.manualSyncSchedule,
          manualSyncStatus: combined.manualSyncStatus
        }
      })
    );

    // 用模板渲染主卡片
    safeSetInnerHTML(card, template?.innerHTML || '');

    // 表单与事件监听初始化（异步确保 DOM 插入后执行）
    requestAnimationFrame(() => {
      populateForm(settings);
      setupListeners();
      setupSyncButtonListeners();
      loadStatusTables({ silent: true });
    });
  } catch (error) {
    // 加载异常处理
    safeSetInnerHTML(card, '');
    const errorP = document.createElement('p');
    errorP.style.color = 'var(--red-400)';
    errorP.style.textAlign = 'center';
    errorP.textContent = `加载失败: ${error.message}`;
    card.appendChild(errorP);
    settingsLogger.error('加载设置失败', error);
  }
}

/**
 * 导出本地 AI 设置相关方法
 */
export { getLocalAISettings, setLocalAISettings };

// 为部分功能注入全局访问变量（调试/兼容旧逻辑）
window.triggerSync = triggerSync;
window.showPodLoading = showPodLoading;
