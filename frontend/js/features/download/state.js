/**
 * @file 下载页面状态管理模块
 * @description 负责管理下载功能相关的所有状态，提供操作方法
 */

/**
 * 下载页全局状态对象
 * @type {Object}
 */
const downloadState = {
  /** 是否已初始化 */
  initialized: false,
  /** 管理员密钥 */
  adminSecret: null,
  /** 上次验证管理员时间戳（毫秒） */
  lastVerifiedAt: 0,
  /** 页面是否处于加载中 */
  loading: false,
  /** 错误信息，若有 */
  error: null,
  /** 下载服务状态数据 */
  status: null,
  /** 下载任务列表 */
  tasks: [],
  /** 下载服务配置 */
  config: null,
  /** RSS 源列表 */
  feeds: [],
  /** RSS 源选中集合 */
  selectedFeeds: new Set(),
  /** RSS 源搜索关键词 */
  feedSearch: '',
  /** 最近下载的文件列表 */
  recent: [],
  /** 历史下载记录 */
  history: [],
  historyPagination: {
    page: 1,
    pageSize: 50,
    total: 0
  },
  /** 日志数据 */
  logs: [],
  /** 当前日志过滤级别 */
  logLevel: 'all',
  /** 指标走势图历史 */
  metricHistory: {
    tasks: [],
    articles: [],
    images: [],
    storage: []
  },
  /** 当前页面（如 dashboard/feeds/history 等） */
  activePage: 'dashboard',
  /** 任务表过滤状态 */
  filter: {
    /** 任务搜索关键词 */
    search: '',
    /** 任务状态筛选值 */
    status: 'all'
  },
  /** 历史记录页的时间筛选（如 recent/24h/7d） */
  historyFilter: 'recent',
  /** 历史记录搜索关键词 */
  historySearch: '',
  /** 自动刷新计时器 ID */
  autoRefreshTimer: null,
  /** 预览弹窗状态 */
  preview: {
    taskId: null,
    feed: null,
    items: [],
    filter: 'all',
    selection: []
  }
};

/**
 * 记录关键指标快照用于趋势图展示
 * @param {{tasks?:number,articles?:number,images?:number,storage?:number}} snapshot
 */
export function pushMetricSnapshot(snapshot = {}) {
  const timestamp = Date.now();
  const targets = downloadState.metricHistory;
  const maxPoints = 60;
  if (typeof snapshot.tasks === 'number') {
    targets.tasks.push({ timestamp, value: snapshot.tasks });
    if (targets.tasks.length > maxPoints) targets.tasks.shift();
  }
  if (typeof snapshot.articles === 'number') {
    targets.articles.push({ timestamp, value: snapshot.articles });
    if (targets.articles.length > maxPoints) targets.articles.shift();
  }
  if (typeof snapshot.images === 'number') {
    targets.images.push({ timestamp, value: snapshot.images });
    if (targets.images.length > maxPoints) targets.images.shift();
  }
  if (typeof snapshot.storage === 'number') {
    targets.storage.push({ timestamp, value: snapshot.storage });
    if (targets.storage.length > maxPoints) targets.storage.shift();
  }
}

/**
 * 获取指标历史数据
 * @returns {{tasks:Array,articles:Array,images:Array,storage:Array}}
 */
export function getMetricHistory() {
  return downloadState.metricHistory;
}

/**
 * 设置管理员密钥并记录验证时间
 * @param {string|null} secret 
 */
export function setAdminSecret(secret) {
  downloadState.adminSecret = secret || null;
  downloadState.lastVerifiedAt = secret ? Date.now() : 0;
}

/**
 * 清除管理员密钥及验证时间
 */
export function clearAdminSecret() {
  downloadState.adminSecret = null;
  downloadState.lastVerifiedAt = 0;
}

/**
 * 设置自动刷新计时器 ID
 * @param {number|null} timerId 
 */
export function setAutoRefreshTimer(timerId) {
  downloadState.autoRefreshTimer = timerId || null;
}

/**
 * 清除自动刷新计时器
 */
export function clearAutoRefreshTimer() {
  if (downloadState.autoRefreshTimer) {
    clearInterval(downloadState.autoRefreshTimer);
  }
  downloadState.autoRefreshTimer = null;
}

/**
 * 更新任务列表筛选条件
 * @param {Object} partial 
 */
export function updateFilter(partial = {}) {
  downloadState.filter = {
    ...downloadState.filter,
    ...partial
  };
}

/**
 * 设置历史记录的时间筛选类型
 * @param {string} filter 
 */
export function setHistoryFilter(filter) {
  downloadState.historyFilter = filter || 'recent';
}

/**
 * 设置历史记录搜索关键词
 * @param {string} keyword 
 */
export function setHistorySearch(keyword) {
  downloadState.historySearch = keyword || '';
}

/**
 * 设置 RSS 源搜索关键词
 * @param {string} keyword
 */
export function setFeedSearch(keyword) {
  downloadState.feedSearch = keyword || '';
}

/**
 * 设置日志过滤级别
 * @param {string} level 
 */
export function setLogLevel(level) {
  downloadState.logLevel = level || 'all';
}

export function toggleFeedSelection(feedId, selected) {
  if (!feedId) return;
  if (selected) {
    downloadState.selectedFeeds.add(feedId);
  } else {
    downloadState.selectedFeeds.delete(feedId);
  }
}

export function clearFeedSelection() {
  downloadState.selectedFeeds.clear();
}

export function selectAllFeeds(feedIds = []) {
  downloadState.selectedFeeds = new Set(feedIds.filter(Boolean));
}

export function getSelectedFeeds() {
  return Array.from(downloadState.selectedFeeds);
}

export default downloadState;
