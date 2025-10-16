export {
  ensureDownloadRoot,
  getRootElement,
  setRootVisible,
  switchPage,
  openSidebar,
  closeSidebar,
  isSidebarOpen
} from './view/root.js';

export { setServiceStatus, setLoading, setError } from './view/status.js';

export {
  renderMetrics,
  renderQueue,
  renderRecentDownloads,
  renderTaskTable
} from './view/dashboard.js';

export { renderFeeds } from './view/feeds.js';
export { renderHistory } from './view/history.js';
export { renderLogs } from './view/logs.js';

export { updateConfigForm, getConfigValues } from './view/config.js';

export { applyInteractiveEffects } from './view/effects.js';
