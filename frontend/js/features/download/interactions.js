/**
 * @file interactions.js
 * @description 下载页事件绑定
 */

import { debounce, runDeferred } from './helpers.js';
import { deriveTaskId } from './view/utils.js';
import {
  toggleFeedSelection,
  selectAllFeeds,
  clearFeedSelection,
  getSelectedFeeds
} from './state.js';

let interactionsBound = false;
let eventListeners = []; // 跟踪所有添加的事件监听器

export function bindInteractions(options) {
  if (interactionsBound) return;
  const {
    getRootElement,
    downloadState,
    switchPage,
    openSidebar,
    closeSidebar,
    isSidebarOpen,
    hideDownloadPage,
    updateFilter,
    setFeedSearch,
    setHistorySearch,
    setHistoryFilter,
    setLogLevel,
    renderTaskTable,
    renderFeeds,
    renderHistory,
    renderLogs,
    getFilteredTasks,
    getFilteredFeeds,
    getFilteredHistory,
    getFilteredLogs,
    handleSaveConfig,
    reloadConfigSnapshot,
    handleExportConfig,
    handleImportConfig,
    handleRefreshLogs,
    handleClearLogs,
    handleCreateTask,
    handleImportOpml,
    handleExportOpml,
    handleTaskCommand,
    handlePreviewTask,
    handleTaskEdit,
    handleTaskDelete,
    handleFeedPreview,
    handleFeedEdit,
    handleFeedToggle,
    handleFeedDelete,
    resolveTaskById
  } = options;

  const root = getRootElement();
  if (!root) return;

  interactionsBound = true;
  downloadState.initialized = true;

  // 简单的事件监听器跟踪函数
  const addTrackedListener = (element, event, handler) => {
    if (!element) return;
    element.addEventListener(event, handler);
    eventListeners.push({ element, event, handler });
  };

  const closeAllTaskMenus = (exceptMenu = null) => {
    const menus = root.querySelectorAll('.task-actions-menu.is-open');
    menus.forEach((menu) => {
      if (menu === exceptMenu) return;
      menu.classList.remove('is-open');
      let toggle = menu.previousElementSibling;
      if (!toggle || toggle.dataset.action !== 'toggle-task-actions') {
        toggle = menu.nextElementSibling;
      }
      if (toggle?.dataset.action === 'toggle-task-actions') {
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  };

  const dropdowns = Array.from(root.querySelectorAll('[data-dropdown]'));
  const closeAllDropdowns = (except = null) => {
    dropdowns.forEach((dropdown) => {
      if (dropdown === except) return;
      dropdown.classList.remove('is-open');
      const trigger = dropdown.querySelector('[data-dropdown-trigger]');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
  };

  const openHistoryBtn = root.querySelector('[data-action="open-history"]');
  if (openHistoryBtn) {
    openHistoryBtn.addEventListener('click', () => {
      downloadState.activePage = 'history';
      switchPage('history');
      const body = root.querySelector('.download-body');
      if (body) {
        requestAnimationFrame(() => {
          body.scrollTo({ top: 0, behavior: 'smooth' });
        });
      }
    });
  }

  const viewTasksBtn = root.querySelector('[data-action="view-tasks"]');
  if (viewTasksBtn) {
    viewTasksBtn.addEventListener('click', () => {
      downloadState.activePage = 'dashboard';
      switchPage('dashboard');
      closeSidebar();
      const panel = root.querySelector('[data-role="task-table"]')?.closest('.panel');
      if (panel) {
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  const saveConfigBtn = root.querySelector('[data-action="save-config"]');
  if (saveConfigBtn) saveConfigBtn.addEventListener('click', () => handleSaveConfig());

  const reloadConfigBtn = root.querySelector('[data-action="reload-config"]');
  if (reloadConfigBtn) reloadConfigBtn.addEventListener('click', () => reloadConfigSnapshot());

  const exportConfigBtn = root.querySelector('[data-action="export-config"]');
  if (exportConfigBtn) exportConfigBtn.addEventListener('click', () => handleExportConfig());

  const importConfigBtn = root.querySelector('[data-action="import-config"]');
  if (importConfigBtn) importConfigBtn.addEventListener('click', () => handleImportConfig());

  const refreshLogsBtn = root.querySelector('[data-action="refresh-logs"]');
  if (refreshLogsBtn) refreshLogsBtn.addEventListener('click', () => handleRefreshLogs());

  const clearLogsBtn = root.querySelector('[data-action="clear-logs"]');
  if (clearLogsBtn) clearLogsBtn.addEventListener('click', () => handleClearLogs());

  const newTaskBtn = root.querySelector('[data-action="new-task"]');
  if (newTaskBtn) newTaskBtn.addEventListener('click', () => handleCreateTask());

  const importOpmlBtn = root.querySelector('[data-action="import-opml"]');
  if (importOpmlBtn) importOpmlBtn.addEventListener('click', () => handleImportOpml());

  const exportOpmlBtn = root.querySelector('[data-action="export-opml"]');
  if (exportOpmlBtn) exportOpmlBtn.addEventListener('click', () => handleExportOpml());

  const addFeedBtn = root.querySelector('[data-action="add-feed"]');
  if (addFeedBtn) addFeedBtn.addEventListener('click', () => handleCreateTask());

  const openSidebarBtn = root.querySelector('[data-action="open-sidebar"]');
  if (openSidebarBtn) openSidebarBtn.addEventListener('click', () => openSidebar());

  const closeSidebarBtn = root.querySelector('[data-action="close-sidebar"]');
  if (closeSidebarBtn) closeSidebarBtn.addEventListener('click', () => closeSidebar());

  const backHomeButtons = root.querySelectorAll('[data-action="back-home"]');
  backHomeButtons.forEach((btn) => {
    btn.addEventListener('click', () => hideDownloadPage({ redirect: true }));
  });

  const navButtons = root.querySelectorAll('[data-role="download-nav"] .nav-item');
  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetPage = btn.dataset.page || 'dashboard';
      downloadState.activePage = targetPage;
      switchPage(targetPage);
      if (window.innerWidth <= 1024 && isSidebarOpen()) {
        closeSidebar();
      }
    });
  });

  dropdowns.forEach((dropdown) => {
    const select = dropdown.querySelector('select');
    const toggle = dropdown.querySelector('[data-dropdown-trigger]');
    const labelEl = dropdown.querySelector('[data-dropdown-label]');
    const menu = dropdown.querySelector('.dropdown-menu');
    const menuItems = menu ? Array.from(menu.querySelectorAll('[data-value]')) : [];

    const syncLabel = () => {
      if (!labelEl || !select) return;
      const option = select.selectedOptions && select.selectedOptions[0]
        ? select.selectedOptions[0]
        : select.querySelector(`option[value="${select.value}"]`);
      if (option) {
        labelEl.textContent = option.textContent || option.value;
      }
    };

    if (select) {
      syncLabel();
      select.addEventListener('change', () => {
        syncLabel();
      });
    }

    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const isOpen = dropdown.classList.contains('is-open');
        closeAllDropdowns(isOpen ? null : dropdown);
        dropdown.classList.toggle('is-open', !isOpen);
        toggle.setAttribute('aria-expanded', String(!isOpen));
      });
    }

    const handleMenuSelect = (value) => {
      if (select && value !== undefined) {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        syncLabel();
      }
      dropdown.classList.remove('is-open');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    };

    if (menu) {
      menuItems.forEach((item) => {
        item.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          handleMenuSelect(item.dataset.value);
        });
      });
    }

    if (select && menuItems.length) {
      select.addEventListener('change', () => {
        const currentValue = select.value;
        menuItems.forEach((item) => {
          item.classList.toggle('is-active', item.dataset.value === currentValue);
        });
      });
      menuItems.forEach((item) => {
        if (item.dataset.value === select.value) {
          item.classList.add('is-active');
        }
      });
    }
  });

  const searchInput = root.querySelector('[data-role="task-search"]');
  if (searchInput) {
    const handleTaskSearch = debounce((value) => {
      updateFilter({ search: value || '' });
      renderTaskTable(getFilteredTasks());
    }, 220);
    searchInput.addEventListener('input', (event) => {
      handleTaskSearch(event.target.value || '');
    });
  }

  const statusSelect = root.querySelector('[data-role="task-filter"]');
  if (statusSelect) {
    statusSelect.addEventListener('change', (event) => {
      updateFilter({ status: event.target.value || 'all' });
      renderTaskTable(getFilteredTasks());
    });
  }

  const feedSearchInput = root.querySelector('[data-role="feed-search"]');
  if (feedSearchInput) {
    feedSearchInput.value = downloadState.feedSearch || '';
    const handleFeedSearch = debounce((value) => {
      setFeedSearch(value || '');
      runDeferred(() => renderFeeds(getFilteredFeeds(), downloadState.feedSearch || ''));
    }, 220);
    feedSearchInput.addEventListener('input', (event) => {
      handleFeedSearch(event.target.value || '');
    });
  }

  const feedSelectAll = root.querySelector('[data-role="feed-select-all"]');
  if (feedSelectAll) {
    feedSelectAll.addEventListener('change', (event) => {
      const checked = event.target.checked;
      const feeds = getFilteredFeeds();
      if (checked) {
        selectAllFeeds(feeds.map((feed, index) => deriveTaskId(feed, index)));
      } else {
        clearFeedSelection();
      }
      renderFeeds(getFilteredFeeds(), downloadState.feedSearch || '');
    });
  }

  addTrackedListener(root, 'change', (event) => {
    const checkbox = event.target?.closest('input[data-role="feed-select"]');
    if (!checkbox) return;
    const encodedId = checkbox.dataset.feedId;
    if (!encodedId) return;
    let feedId = encodedId;
    try {
      feedId = decodeURIComponent(encodedId);
    } catch {}
    toggleFeedSelection(feedId, checkbox.checked);
    renderFeeds(getFilteredFeeds(), downloadState.feedSearch || '');
  });

  const historySearchInput = root.querySelector('[data-role="history-search"]');
  if (historySearchInput) {
    const handleHistorySearch = debounce((value) => {
      setHistorySearch(value || '');
      runDeferred(() => renderHistory(getFilteredHistory()));
    }, 250);
    historySearchInput.addEventListener('input', (event) => {
      handleHistorySearch(event.target.value || '');
    });
  }

  const historyFilterSelect = root.querySelector('[data-role="history-filter"]');
  if (historyFilterSelect) {
    historyFilterSelect.addEventListener('change', (event) => {
      setHistoryFilter(event.target.value || 'recent');
      renderHistory(getFilteredHistory());
    });
  }

  const logLevelSelect = root.querySelector('[data-role="log-level"]');
  if (logLevelSelect) {
    logLevelSelect.addEventListener('change', (event) => {
      setLogLevel(event.target.value || 'all');
      renderLogs(getFilteredLogs());
    });
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) {
      const insideMenu = event.target.closest('.task-actions-menu');
      if (!insideMenu) closeAllTaskMenus();
      const insideDropdown = event.target.closest('[data-dropdown]');
      if (!insideDropdown) closeAllDropdowns();
      return;
    }

    const action = button.dataset.action;
    if (!action) return;
    if (action !== 'toggle-task-actions') {
      closeAllTaskMenus();
    }
    const dropdownTriggerContainer = button.closest('[data-dropdown]');
    if (!dropdownTriggerContainer) {
      closeAllDropdowns();
    }

    switch (action) {
      case 'toggle-task-actions': {
        event.preventDefault();
        const container = button.closest('.actions-compact');
        if (!container) return;
        const menu = container.querySelector('.task-actions-menu');
        if (!menu) return;
        const isOpen = menu.classList.contains('is-open');
        closeAllTaskMenus(menu);
        if (isOpen) {
          menu.classList.remove('is-open');
          button.setAttribute('aria-expanded', 'false');
        } else {
          menu.classList.add('is-open');
          button.setAttribute('aria-expanded', 'true');
        }
        break;
      }
      case 'resume-task': {
        event.preventDefault();
        const task = resolveTaskById(button.dataset.taskId || button.dataset.feedId);
        if (task) handleTaskCommand(task, 'resume', '任务已启动');
        break;
      }
      case 'pause-task': {
        event.preventDefault();
        const task = resolveTaskById(button.dataset.taskId || button.dataset.feedId);
        if (task) handleTaskCommand(task, 'pause', '任务已暂停');
        break;
      }
      case 'preview-task': {
        event.preventDefault();
        const task = resolveTaskById(button.dataset.taskId);
        if (task) handlePreviewTask(task);
        break;
      }
      case 'edit-task': {
        event.preventDefault();
        const task = resolveTaskById(button.dataset.taskId);
        if (task) handleTaskEdit(task);
        break;
      }
      case 'delete-task': {
        event.preventDefault();
        const task = resolveTaskById(button.dataset.taskId);
        if (task) handleTaskDelete(task);
        break;
      }
      case 'preview-feed':
        event.preventDefault();
        handleFeedPreview(button.dataset.feedId);
        break;
      case 'edit-feed':
        event.preventDefault();
        handleFeedEdit(button.dataset.feedId);
        break;
      case 'toggle-feed':
        event.preventDefault();
        handleFeedToggle(button.dataset.feedId);
        break;
      case 'delete-feed':
        event.preventDefault();
        handleFeedDelete(button.dataset.feedId);
        break;
    case 'bulk-feed-start':
      event.preventDefault();
      (async () => {
        const selectedIds = getSelectedFeeds();
        for (const id of selectedIds) {
          const task = resolveTaskById(id);
          if (!task) continue;
          const status = String(task.status || '').toLowerCase();
          if (status === 'running') continue;
          await handleTaskCommand(task, 'resume', '任务已启动');
        }
        renderFeeds(getFilteredFeeds(), downloadState.feedSearch || '');
      })();
      break;
    case 'bulk-feed-pause':
      event.preventDefault();
      (async () => {
        const selectedIds = getSelectedFeeds();
        for (const id of selectedIds) {
          const task = resolveTaskById(id);
          if (!task) continue;
          const status = String(task.status || '').toLowerCase();
          if (status !== 'running') continue;
          await handleTaskCommand(task, 'pause', '任务已暂停');
        }
        renderFeeds(getFilteredFeeds(), downloadState.feedSearch || '');
      })();
      break;
    case 'bulk-feed-delete':
      event.preventDefault();
      (async () => {
        const selectedIds = getSelectedFeeds();
        if (!selectedIds.length) return;
        for (const id of selectedIds) {
          const task = resolveTaskById(id);
          if (!task) continue;
          await handleFeedDelete(id);
        }
        clearFeedSelection();
        renderFeeds(getFilteredFeeds(), downloadState.feedSearch || '');
      })();
      break;
      default:
        break;
    }
  });

  // 使用跟踪的方式添加 document 级别的监听器
  const documentClickHandler = (event) => {
    if (!root.contains(event.target)) {
      closeAllTaskMenus();
      closeAllDropdowns();
    }
  };
  document.addEventListener('click', documentClickHandler);
  eventListeners.push({ element: document, event: 'click', handler: documentClickHandler });
}

// 清理所有事件监听器
export function cleanupInteractions() {
  if (!interactionsBound) return;
  
  // 清理跟踪的事件监听器
  eventListeners.forEach(({ element, event, handler }) => {
    if (element) {
      element.removeEventListener(event, handler);
    }
  });
  
  eventListeners = [];
  interactionsBound = false;
  
  console.log('[Interactions] 事件监听器已清理');
}
