/**
 * @file modals.js
 * @description 下载页弹窗与对话框封装
 */

import { createModuleLogger } from '../../core/logger.js';
const modalsLogger = createModuleLogger('DownloadModals');

import { applyInteractiveEffects } from './view.js';
import {
  PREVIEW_FILTERS,
  runDeferred,
  splitLines,
  splitTags,
  formatRelativeTime as formatRelativeTimeHelper
} from './helpers.js';
import { iconDownload, iconCircleCheck, iconCircleX } from '../../shared/svg-utils.js';
import { IncrementalList } from '../../shared/incremental-update.js';
import { setSafeInnerHTML, SecurityLevel } from '../../shared/security.js';

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const modalStack = [];

// 清理所有模态框（用于页面隐藏时）
export function cleanupAllModals() {
  while (modalStack.length > 0) {
    const modal = modalStack[modalStack.length - 1];
    if (modal && modal.onClose) {
      modal.onClose('cleanup');
    }
  }
  modalsLogger.debug('清理了所有模态框');
}

function getFocusableElements(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter((node) => !node.hasAttribute('disabled'));
}

function focusElement(element) {
  if (!element || typeof element.focus !== 'function') return;
  try {
    element.focus({ preventScroll: false });
  } catch {
    element.focus();
  }
}

export function createModalShell(options = {}) {
  const {
    title = '',
    description = '',
    asForm = true,
    onClose = () => {},
    variant = '',
    mobileFullscreen = false
  } = options;

  const overlay = document.createElement('div');
  overlay.className = 'download-modal-backdrop';
  overlay.setAttribute('data-modal-backdrop', 'true');

  const container = document.createElement(asForm ? 'form' : 'div');
  container.className = 'download-modal';
  if (variant) container.classList.add(variant);
  if (mobileFullscreen) container.classList.add('modal-fullscreen-mobile');
  if (asForm) container.setAttribute('novalidate', 'novalidate');
  container.setAttribute('role', 'dialog');
  container.setAttribute('aria-modal', 'true');
  container.tabIndex = -1;

  const header = document.createElement('header');
  const heading = document.createElement('h3');
  heading.textContent = title;
  const headingId = `download-modal-title-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
  heading.id = headingId;
  container.setAttribute('aria-labelledby', headingId);
  header.appendChild(heading);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'modal-close';
  closeButton.setAttribute('aria-label', '关闭');
  closeButton.innerHTML = '&times;';
  header.appendChild(closeButton);

  container.appendChild(header);

  let descriptionId = null;
  if (description) {
    const desc = document.createElement('p');
    desc.className = 'modal-description';
    desc.textContent = description;
    descriptionId = `${headingId}-desc`;
    desc.id = descriptionId;
    container.appendChild(desc);
  }
  if (descriptionId) {
    container.setAttribute('aria-describedby', descriptionId);
  } else {
    container.removeAttribute('aria-describedby');
  }

  const body = document.createElement('div');
  body.className = 'modal-body';
  container.appendChild(body);

  const footer = document.createElement('footer');
  container.appendChild(footer);

  overlay.appendChild(container);
  document.body.appendChild(overlay);

  applyInteractiveEffects(container);

  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const stackEntry = { overlay, container, onClose, returnFocus: previouslyFocused };
  modalStack.push(stackEntry);

  const handleBackdrop = (event) => {
    if (event.target === overlay) {
      cleanup('cancel');
    }
  };

  const handleKeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cleanup('cancel');
      return;
    }
    if (event.key === 'Tab') {
      const focusable = getFocusableElements(container);
      if (!focusable.length) {
        event.preventDefault();
        focusElement(container);
        return;
      }
      const current = focusable.indexOf(document.activeElement);
      let nextIndex = current;
      if (event.shiftKey) {
        nextIndex = current <= 0 ? focusable.length - 1 : current - 1;
      } else {
        nextIndex = current === focusable.length - 1 ? 0 : current + 1;
      }
      event.preventDefault();
      focusElement(focusable[nextIndex]);
    }
  };

  let closed = false;
  const cleanup = (reason) => {
    if (closed) return;
    closed = true;
    
    // 移除事件监听器
    container.removeEventListener('keydown', handleKeydown);
    overlay.removeEventListener('pointerdown', handleBackdrop);
    
    // 从栈中移除
    const index = modalStack.indexOf(stackEntry);
    if (index !== -1) {
      modalStack.splice(index, 1);
    }
    
    // 移除 DOM
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    
    // 清理引用，防止内存泄漏
    stackEntry.overlay = null;
    stackEntry.container = null;
    stackEntry.onClose = null;
    stackEntry.returnFocus = null;
    
    // 恢复焦点
    runDeferred(() => {
      if (modalStack.length > 0) {
        const top = modalStack[modalStack.length - 1];
        focusElement(top?.container || null);
      } else if (previouslyFocused && previouslyFocused.isConnected) {
        focusElement(previouslyFocused);
      }
    });
    
    // 调用关闭回调
    if (onClose) {
      onClose(reason);
    }
  };

  closeButton.addEventListener('click', () => cleanup('cancel'));
  overlay.addEventListener('pointerdown', handleBackdrop, { passive: true });
  container.addEventListener('keydown', handleKeydown);

  runDeferred(() => {
    const focusable = getFocusableElements(container);
    if (focusable.length) {
      focusElement(focusable[0]);
    } else {
      focusElement(container);
    }
  });

  return {
    overlay,
    container,
    body,
    footer,
    close: cleanup
  };
}

export function showConfirmDialog({
  title = '确认操作',
  message = '确定要执行此操作吗？',
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'danger'
} = {}) {
  return new Promise((resolve) => {
    const { body, footer, close } = createModalShell({
      title,
      description: '',
      asForm: false,
      onClose: (reason) => {
        resolve(reason === 'confirm');
      }
    });

    const messageEl = document.createElement('p');
    messageEl.className = 'modal-description';
    messageEl.textContent = message;
    body.appendChild(messageEl);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = cancelLabel;
    cancelBtn.addEventListener('click', () => close('cancel'));

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = tone === 'danger' ? 'btn-danger' : 'btn-primary';
    confirmBtn.textContent = confirmLabel;
    confirmBtn.addEventListener('click', () => close('confirm'));

    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);
    applyInteractiveEffects(footer);
    window.setTimeout(() => confirmBtn.focus(), 20);
  });
}

export function openTaskFormModal({ mode = 'create', initial = {}, includeEnabledToggle = mode !== 'create' } = {}) {
  const title = mode === 'create' ? '新建订阅任务' : '编辑订阅任务';
  return new Promise((resolve, reject) => {
    let submittedValues = null;
    const cleanupCallbacks = [];
    const runCleanups = () => {
      while (cleanupCallbacks.length) {
        const fn = cleanupCallbacks.pop();
        try {
          fn();
        } catch (error) {
          modalsLogger.error('tooltip cleanup failed', error);
        }
      }
    };
    const { container: form, body, footer, close } = createModalShell({
      title,
      description: '填写订阅源地址、抓取周期等信息',
      asForm: true,
      variant: 'modal-task',
      mobileFullscreen: true,
      onClose: (reason) => {
        runCleanups();
        if (reason === 'submit' && submittedValues) {
          resolve(submittedValues);
        } else if (reason === 'cancel') {
          reject(new Error('CANCELLED'));
        }
      }
    });

    const createTooltipIcon = (content) => {
      if (!content) return null;
      const tip = document.createElement('span');
      tip.className = 'form-help';
      tip.textContent = '?';
      tip.tabIndex = 0;
      tip.setAttribute('role', 'button');
      const bubble = document.createElement('div');
      bubble.className = 'form-help-bubble';
      // 安全设置提示内容，防止潜在的XSS
      setSafeInnerHTML(bubble, content, SecurityLevel.BASIC);
      document.body.appendChild(bubble);
      const margin = 16;
      const updatePlacement = () => {
        if (!bubble.classList.contains('is-visible')) return;
        const rect = tip.getBoundingClientRect();
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        bubble.style.visibility = 'hidden';
        bubble.style.left = '0px';
        bubble.style.top = '0px';
        const bubbleRect = bubble.getBoundingClientRect();
        let side = rect.left + rect.width / 2 < viewportWidth / 2 ? 'right' : 'left';
        if (rect.right + bubbleRect.width + margin > viewportWidth) {
          side = 'left';
        } else if (rect.left - bubbleRect.width - margin < 0) {
          side = 'right';
        }
        bubble.dataset.side = side;
        let left = side === 'right' ? rect.right + 12 : rect.left - bubbleRect.width - 12;
        if (left < margin) left = margin;
        if (left + bubbleRect.width > viewportWidth - margin) {
          left = viewportWidth - bubbleRect.width - margin;
        }
        let top = rect.top + rect.height / 2 - bubbleRect.height / 2;
        if (top < margin) top = margin;
        if (top + bubbleRect.height > viewportHeight - margin) {
          top = viewportHeight - bubbleRect.height - margin;
        }
        bubble.style.left = `${Math.round(left)}px`;
        bubble.style.top = `${Math.round(top)}px`;
        bubble.style.visibility = 'visible';
      };
      const showBubble = () => {
        bubble.classList.add('is-visible');
        requestAnimationFrame(updatePlacement);
      };
      const hideBubble = () => {
        bubble.classList.remove('is-visible');
        bubble.style.visibility = 'hidden';
      };
      tip.addEventListener('mouseenter', showBubble);
      tip.addEventListener('focusin', showBubble);
      tip.addEventListener('mouseleave', hideBubble);
      tip.addEventListener('blur', hideBubble);
      bubble.addEventListener('mouseenter', showBubble);
      bubble.addEventListener('mouseleave', hideBubble);
      window.addEventListener('resize', updatePlacement);
      document.addEventListener('scroll', updatePlacement, true);
      cleanupCallbacks.push(() => {
        window.removeEventListener('resize', updatePlacement);
        document.removeEventListener('scroll', updatePlacement, true);
        tip.removeEventListener('mouseenter', showBubble);
        tip.removeEventListener('focusin', showBubble);
        tip.removeEventListener('mouseleave', hideBubble);
        tip.removeEventListener('blur', hideBubble);
        bubble.removeEventListener('mouseenter', showBubble);
        bubble.removeEventListener('mouseleave', hideBubble);
        bubble.remove();
      });
      return tip;
    };

    const createFieldGroup = ({ label, element, tooltip, span }) => {
      const group = document.createElement('div');
      group.className = `field-group ${span || 'col-12'}`;
      const labelEl = document.createElement('label');
      labelEl.className = 'field-label';
      labelEl.textContent = label;
      if (tooltip) {
        const tip = createTooltipIcon(tooltip);
        if (tip) labelEl.appendChild(tip);
      }
      group.appendChild(labelEl);
      group.appendChild(element);
      return group;
    };

    const normalizeCookieDomain = (value) => {
      if (!value) return '';
      let domain = String(value).trim().toLowerCase();
      if (!domain) return '';
      domain = domain.replace(/^[a-z]+:\/\//i, '');
      domain = domain.split(/[/?#]/)[0];
      domain = domain.replace(/:\d+$/, '');
      domain = domain.replace(/^\.+/, '');
      return domain;
    };

    const feedInput = document.createElement('input');
    feedInput.type = 'url';
    feedInput.required = true;
    feedInput.value = initial.feedUrl || '';
    feedInput.className = 'form-control';

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = initial.title || initial.name || '';
    titleInput.className = 'form-control';

    const categoryInput = document.createElement('input');
    categoryInput.type = 'text';
    categoryInput.value = initial.category || '';
    categoryInput.className = 'form-control';

    const intervalInput = document.createElement('input');
    intervalInput.type = 'text';
    intervalInput.placeholder = '例如：30 或 */30 * * * *';
    intervalInput.value = String(initial.interval || initial.schedule?.interval || '').trim();
    intervalInput.className = 'form-control';

    const excludeInput = document.createElement('input');
    excludeInput.type = 'text';
    excludeInput.value = Array.isArray(initial.excludeKeywords)
      ? initial.excludeKeywords.join(', ')
      : '';
    excludeInput.className = 'form-control';

    const tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.value = Array.isArray(initial.tags)
      ? initial.tags.join(', ')
      : '';
    tagsInput.className = 'form-control';

    const cookieDomainInput = document.createElement('input');
    cookieDomainInput.type = 'text';
    cookieDomainInput.placeholder = '例如：www.example.com';
    cookieDomainInput.value = initial.cookieDomain || '';
    cookieDomainInput.className = 'form-control';

    const cookieInput = document.createElement('input');
    cookieInput.type = 'text';
    cookieInput.placeholder = 'sessionid=xxx; path=/';
    cookieInput.value = initial.cookie || '';
    cookieInput.className = 'form-control';

    const grid = document.createElement('div');
    grid.className = 'task-form-grid';

    grid.appendChild(createFieldGroup({
      label: '任务名称',
      element: titleInput,
      tooltip: '将作为下载目录名称显示，可自定义任意描述。',
      span: 'col-8'
    }));

    grid.appendChild(createFieldGroup({
      label: '分类（可选）',
      element: categoryInput,
      tooltip: '用于在控制台快速筛选任务，可随意填写类别名称。如：Cosplay / 摄影。',
      span: 'col-4'
    }));

    grid.appendChild(createFieldGroup({
      label: 'RSS / Atom 地址',
      element: feedInput,
      span: 'col-9'
    }));

    grid.appendChild(createFieldGroup({
      label: '刷新周期',
      element: intervalInput,
      tooltip: '数字表示秒，例如 30 代表 30 秒；若需 30 分钟请写 <code>30m</code>。同样支持 5 位 cron 表达式，例如 <code>*/30 * * * *</code>。',
      span: 'col-3'
    }));

    grid.appendChild(createFieldGroup({
      label: '排除关键词（逗号分隔）',
      element: excludeInput,
      tooltip: '使用逗号分隔多个关键词，命中这些词的文章会被跳过下载。',
      span: 'col-4'
    }));

    grid.appendChild(createFieldGroup({
      label: '标签（逗号分隔）',
      element: tagsInput,
      tooltip: '给任务打标签，使用逗号进行分隔，例如：写真, 高清。',
      span: 'col-4'
    }));

    grid.appendChild(createFieldGroup({
      label: 'Cookie 作用域（可选）',
      element: cookieDomainInput,
      tooltip: '仅当 Cookie 生效域名与订阅源不同域时填写；留空则表示对匹配的所有请求附带。',
      span: 'col-4'
    }));

    grid.appendChild(createFieldGroup({
      label: 'Cookie 内容（可选）',
      element: cookieInput,
      tooltip: '粘贴完整的 Cookie 请求头字符串，将随该任务的订阅和图片请求一起发送；留空则不附带 Cookie。',
      span: 'col-12'
    }));

    let autoStartInput = null;
    let enabledInput = null;

    if (mode === 'create') {
      const autoStartField = document.createElement('label');
      autoStartField.className = 'config-switch col-12';
      autoStartField.innerHTML = '<span>创建后立即启动任务</span>';
      autoStartInput = document.createElement('input');
      autoStartInput.type = 'checkbox';
      autoStartInput.checked = false;
      autoStartField.appendChild(autoStartInput);
      grid.appendChild(autoStartField);
    } else if (includeEnabledToggle) {
      const enabledField = document.createElement('label');
      enabledField.className = 'config-switch col-12';
      enabledField.innerHTML = '<span>启用任务（保存后自动调度）</span>';
      enabledInput = document.createElement('input');
      enabledInput.type = 'checkbox';
      enabledInput.checked = String(initial.status || '').toLowerCase() === 'running';
      enabledField.appendChild(enabledInput);
      grid.appendChild(enabledField);
    }

    const errorHint = document.createElement('p');
    errorHint.className = 'modal-error';
    errorHint.style.display = 'none';
    body.appendChild(errorHint);
    body.appendChild(grid);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = '取消';

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn-primary';
    submitBtn.textContent = mode === 'create' ? '创建任务' : '保存';

    footer.appendChild(cancelBtn);
    footer.appendChild(submitBtn);

    cancelBtn.addEventListener('click', () => close('cancel'));
    applyInteractiveEffects(footer);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const feedUrl = feedInput.value.trim();
      if (!feedUrl) {
        errorHint.textContent = '请填写有效的订阅地址';
        errorHint.style.display = '';
        feedInput.focus();
        return;
      }

      errorHint.style.display = 'none';
      errorHint.textContent = '';

      const cookieRaw = cookieInput.value.trim();
      const cookieDomainValue = cookieRaw ? normalizeCookieDomain(cookieDomainInput.value) : '';

      const values = {
        feedUrl,
        title: titleInput.value.trim() || feedUrl,
        interval: intervalInput.value.trim(),
        category: categoryInput.value.trim(),
        cookie: cookieRaw,
        cookieDomain: cookieDomainValue,
        excludeKeywords: splitLines(excludeInput.value),
        tags: splitTags(tagsInput.value)
      };

      if (!values.interval) {
        errorHint.textContent = '请填写刷新周期';
        errorHint.style.display = '';
        intervalInput.focus();
        return;
      }

      if (mode === 'create' && autoStartInput) {
        values.autoStart = autoStartInput.checked;
      }
      if (includeEnabledToggle && mode !== 'create' && enabledInput) {
        values.enabled = enabledInput.checked;
      }

      submittedValues = values;
      close('submit');
    });

    window.setTimeout(() => {
      feedInput.focus();
    }, 10);
  });
}

export function showPreviewModal({
  task,
  preview,
  serverId,
  filters = PREVIEW_FILTERS,
  ensureReadyForMutation,
  submitDownloadEntries,
  markAdminVerified,
  refreshData,
  showNotification,
  resolveMessage,
  applyEffects = applyInteractiveEffects,
  formatRelativeTime = formatRelativeTimeHelper
}) {
  return new Promise((resolve) => {
    const { container, body, footer, close } = createModalShell({
      title: `${task.title || task.feedUrl || '订阅源'} 预览`,
      description: '勾选条目后可批量下载，可按状态筛选。',
      asForm: false,
      variant: 'modal-preview',
      mobileFullscreen: true,
      onClose: resolve
    });

    const items = Array.isArray(preview?.items) ? preview.items.slice() : [];
    const selection = new Set();
    let activeFilter = 'all';
    let busy = false;

    const summaryRow = document.createElement('div');
    summaryRow.className = 'preview-summary';

    const selectAllLabel = document.createElement('label');
    selectAllLabel.className = 'preview-select-all';
    const selectAllCheckbox = document.createElement('input');
    selectAllCheckbox.type = 'checkbox';
    selectAllCheckbox.className = 'preview-checkbox';
    const selectAllText = document.createElement('span');
    selectAllText.textContent = '全选';
    selectAllLabel.appendChild(selectAllCheckbox);
    selectAllLabel.appendChild(selectAllText);

    const summaryText = document.createElement('span');
    summaryText.className = 'preview-count';

    summaryRow.appendChild(selectAllLabel);
    summaryRow.appendChild(summaryText);

    const list = document.createElement('div');
    list.className = 'preview-grid';

    body.appendChild(summaryRow);
    body.appendChild(list);
    let listView = null;

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.className = 'btn-primary btn-icon preview-download-action';
    downloadButton.innerHTML = iconDownload();
    downloadButton.title = '批量下载所选';
    downloadButton.setAttribute('aria-label', '批量下载所选');

    const filterGroup = document.createElement('div');
    filterGroup.className = 'preview-filter-group';

    filters.forEach((filter) => {
      if (filter.value === 'all') return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary btn-icon';
      btn.dataset.filter = filter.value;
      btn.innerHTML = filter.value === 'completed' ? iconCircleCheck() : iconCircleX();
      btn.title = filter.label;
      btn.setAttribute('aria-label', filter.label);
      filterGroup.appendChild(btn);
    });

    applyEffects(filterGroup);

    footer.className = 'preview-actions';
    const leftGroup = document.createElement('div');
    leftGroup.style.display = 'flex';
    leftGroup.style.gap = '10px';
    leftGroup.style.marginLeft = '4px';
    leftGroup.appendChild(downloadButton);

    applyEffects(leftGroup);

    const rightGroup = document.createElement('div');
    rightGroup.style.display = 'flex';
    rightGroup.style.gap = '8px';
    rightGroup.appendChild(filterGroup);

    footer.appendChild(leftGroup);
    footer.appendChild(rightGroup);

    applyEffects(footer);

    const getItemKey = (item, index = 0) => (
      item.id
      || item.guid
      || item.link
      || item.url
      || item.identifier
      || `${task.id || 'task'}-${index}`
    );

    const getApiIdentifier = (item, index = 0) => (
      item.id
      || item.guid
      || item.link
      || item.url
      || item.identifier
      || getItemKey(item, index)
    );

    const isItemDownloaded = (item) => {
      if (typeof item.downloaded === 'boolean') return item.downloaded;
      if (typeof item.processed === 'boolean') return item.processed;
      if (typeof item.completed === 'boolean') return item.completed;
      const status = String(item.status || '').toLowerCase();
      if (['completed', 'done', 'success'].includes(status)) return true;
      if (['pending', 'queued', 'waiting'].includes(status)) return false;
      return false;
    };

    const markItemDownloaded = (item, value) => {
      item.downloaded = value;
      if (Object.prototype.hasOwnProperty.call(item, 'processed')) {
        item.processed = value;
      }
      if (value) item.status = 'completed';
    };

    const updateSelectAllState = () => {
      if (!items.length) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
        return;
      }
      if (selection.size === items.length) {
        selectAllCheckbox.checked = true;
        selectAllCheckbox.indeterminate = false;
      } else if (selection.size === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
      } else {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = true;
      }
    };

    const updateSummary = () => {
      summaryText.textContent = `共 ${items.length} 条 · 已选择 ${selection.size} 条`;
      updateSelectAllState();
    };

    const updateFilterButtons = () => {
      filterGroup.querySelectorAll('button').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.filter === activeFilter);
      });
    };

    const getFilteredItems = () => {
      if (activeFilter === 'pending') {
        return items.filter((item) => !isItemDownloaded(item));
      }
      if (activeFilter === 'completed') {
        return items.filter((item) => isItemDownloaded(item));
      }
      return items;
    };

    const updateDownloadButtonState = () => {
      downloadButton.disabled = busy || selection.size === 0;
      downloadButton.classList.toggle('is-active', !downloadButton.disabled && selection.size > 0);
    };

    const syncSelectionState = () => {
      if (!listView || !listView.itemElements) return;
      listView.itemElements.forEach((element, key) => {
        const checkbox = element.querySelector('.preview-checkbox');
        if (!checkbox) return;
        const checked = selection.has(key);
        if (checkbox.checked !== checked) {
          checkbox.checked = checked;
        }
        checkbox.indeterminate = false;
        checkbox.setAttribute('aria-checked', checked ? 'true' : 'false');
        element.classList.toggle('is-selected', checked);
      });
    };

    const resolveEntriesForApi = (keys) => {
      const resolved = [];
      keys.forEach((key) => {
        const entryIndex = items.findIndex((entry, index) => getItemKey(entry, index) === key);
        if (entryIndex === -1) return;
        const entry = items[entryIndex];
        const identifier = getApiIdentifier(entry, entryIndex);
        if (identifier) {
          resolved.push(String(identifier));
        }
      });
      return Array.from(new Set(resolved));
    };

    const downloadEntries = async (entryKeys) => {
      if (!entryKeys || entryKeys.length === 0) return;
      if (typeof ensureReadyForMutation === 'function') {
        const ready = await ensureReadyForMutation();
        if (!ready) return;
      }
      const payloadIds = resolveEntriesForApi(entryKeys);
      if (!payloadIds.length) {
        if (showNotification) {
          showNotification('未找到可下载的条目', 'warning');
        }
        return;
      }
      busy = true;
      updateDownloadButtonState();
      try {
        await submitDownloadEntries(serverId, payloadIds);
        if (showNotification) {
          showNotification('已提交下载任务', 'success');
        }
        if (typeof markAdminVerified === 'function') {
          markAdminVerified();
        }
        entryKeys.forEach((key) => {
          const target = items.find((item, index) => getItemKey(item, index) === key);
          if (target) markItemDownloaded(target, true);
          selection.delete(key);
        });
        renderList();
        if (typeof refreshData === 'function') {
          refreshData({ silent: true }).catch((error) => {
            modalsLogger.warn('PreviewModal 刷新数据失败', error);
          });
        }
      } catch (error) {
        if (showNotification) {
          const message = typeof resolveMessage === 'function'
            ? resolveMessage(error, '下载失败')
            : '下载失败';
          showNotification(message, 'error');
        }
      } finally {
        busy = false;
        updateDownloadButtonState();
      }
    };

    const createRow = (item, index) => {
      const row = document.createElement('div');
      const key = getItemKey(item, index);
      row.className = 'preview-item';
      row.dataset.id = key;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'preview-checkbox';
      checkbox.checked = selection.has(key);

      const infoCell = document.createElement('div');
      infoCell.className = 'preview-info';
      const titleEl = document.createElement('span');
      titleEl.className = 'preview-title';
      titleEl.textContent = item.title || '(未命名文章)';
      const link = item.link || item.url;
      if (link) {
        titleEl.title = link;
      }
      infoCell.appendChild(titleEl);

      const statusCell = document.createElement('span');
      const downloaded = isItemDownloaded(item);
      statusCell.className = `preview-status ${downloaded ? 'is-completed' : 'is-pending'}`;
      statusCell.textContent = downloaded ? '已处理' : '未处理';

      const timeCell = document.createElement('span');
      timeCell.className = 'preview-time';
      timeCell.textContent = formatRelativeTime(item.publishedAt || item.updatedAt || item.pubDate || item.date);

      const actionsCell = document.createElement('div');
      actionsCell.className = 'preview-actions-cell';
      const downloadBtn = document.createElement('button');
      downloadBtn.type = 'button';
      downloadBtn.className = 'btn-secondary btn-icon';
      downloadBtn.innerHTML = iconDownload();
      downloadBtn.title = '下载';
      downloadBtn.setAttribute('aria-label', '下载');
      actionsCell.appendChild(downloadBtn);

      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selection.add(key);
        } else {
          selection.delete(key);
        }
        row.classList.toggle('is-selected', checkbox.checked);
        updateSummary();
        updateDownloadButtonState();
      });

      downloadBtn.addEventListener('click', (event) => {
        event.preventDefault();
        downloadEntries([key]);
      });

      row.classList.toggle('is-selected', selection.has(key));
      row.appendChild(checkbox);
      row.appendChild(infoCell);
      row.appendChild(statusCell);
      row.appendChild(timeCell);
      row.appendChild(actionsCell);
      applyEffects(row);
      return row;
    };

    const renderList = () => {
      const filtered = getFilteredItems();
      const renderItem = (item) => {
        const originalIndex = items.indexOf(item);
        const indexValue = originalIndex === -1 ? 0 : originalIndex;
        return createRow(item, indexValue);
      };
      const getKey = (item) => {
        const originalIndex = items.indexOf(item);
        const indexValue = originalIndex === -1 ? 0 : originalIndex;
        return String(getItemKey(item, indexValue));
      };
      if (!listView) {
        listView = new IncrementalList({
          container: list,
          items: filtered,
          getKey,
          renderItem
        });
      } else {
        listView.update(filtered);
      }
      updateSummary();
      updateFilterButtons();
      updateDownloadButtonState();
      syncSelectionState();
    };

    downloadButton.addEventListener('click', () => {
      downloadEntries(Array.from(selection));
    });

    selectAllCheckbox.addEventListener('change', () => {
      selectAllCheckbox.indeterminate = false;
      if (selectAllCheckbox.checked) {
        items.forEach((item, index) => {
          selection.add(getItemKey(item, index));
        });
      } else {
        selection.clear();
      }
      renderList();
      syncSelectionState();
    });

    filterGroup.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-filter]');
      if (!btn) return;
      const value = btn.dataset.filter;
      activeFilter = value === activeFilter ? 'all' : value;
      renderList();
    });

    renderList();
  });
}
