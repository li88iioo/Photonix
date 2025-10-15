/**
 * @file cache.js
 * @description 计算结果缓存，避免重复计算
 */

/**
 * 简单的 LRU 缓存实现
 */
class LRUCache {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    
    // 移到末尾（最近使用）
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    // 如果已存在，先删除
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    
    // 如果缓存满了，删除最老的
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, value);
  }

  clear() {
    this.cache.clear();
  }

  has(key) {
    return this.cache.has(key);
  }
}

/**
 * 创建记忆化函数
 */
export function memoize(fn, options = {}) {
  const {
    maxSize = 100,
    keyGenerator = (...args) => JSON.stringify(args),
    ttl = 0 // 生存时间（毫秒），0 表示永不过期
  } = options;

  const cache = new LRUCache(maxSize);
  const timestamps = new Map();

  return function memoized(...args) {
    const key = keyGenerator(...args);
    
    // 检查缓存
    if (cache.has(key)) {
      // 检查是否过期
      if (ttl > 0) {
        const timestamp = timestamps.get(key);
        if (timestamp && Date.now() - timestamp > ttl) {
          cache.clear();
          timestamps.delete(key);
        } else {
          return cache.get(key);
        }
      } else {
        return cache.get(key);
      }
    }
    
    // 计算并缓存结果
    const result = fn.apply(this, args);
    cache.set(key, result);
    
    if (ttl > 0) {
      timestamps.set(key, Date.now());
    }
    
    return result;
  };
}

/**
 * 缓存的 metrics 聚合函数
 */
let metricsCache = null;
let metricsCacheKey = null;

export function cachedAggregateMetrics(data) {
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const status = data.status || {};
  const history = Array.isArray(data.history) ? data.history : [];
  const recent = Array.isArray(data.recent) ? data.recent : [];
  const serverMetrics = status.metrics || {};

  const computedArticles = tasks.reduce((sum, task) => {
    const stats = task?.stats || {};
    const fromTask = Number(stats.articlesDownloaded ?? task?.articlesDownloaded ?? 0);
    return sum + (Number.isFinite(fromTask) ? fromTask : 0);
  }, 0);

  const computedImages = tasks.reduce((sum, task) => {
    const stats = task?.stats || {};
    const fromTask = Number(stats.imagesDownloaded ?? task?.imagesDownloaded ?? 0);
    return sum + (Number.isFinite(fromTask) ? fromTask : 0);
  }, 0);

  const serverArticles = Number(serverMetrics.articlesDownloaded);
  const serverImages = Number(serverMetrics.imagesDownloaded);
  const serverStorage = Number(serverMetrics.storageBytes ?? status.storage?.bytes ?? status.storageBytes ?? NaN);

  const articlesDownloaded = Number.isFinite(serverArticles) ? serverArticles : computedArticles;
  const imagesDownloaded = Number.isFinite(serverImages) ? serverImages : computedImages;

  const historyBytes = history.reduce((sum, entry) => {
    const value = Number(entry?.size || 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);

  const recentBytes = recent.reduce((sum, entry) => {
    const value = Number(entry?.size || 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);

  let storageBytes = Number.isFinite(serverStorage) && serverStorage >= 0
    ? serverStorage
    : historyBytes + recentBytes;

  if (!Number.isFinite(storageBytes) || storageBytes < 0) {
    storageBytes = 0;
  }

  const keyPayload = {
    taskCount: tasks.length,
    aggregatedArticles: articlesDownloaded,
    aggregatedImages: imagesDownloaded,
    computedArticles,
    computedImages,
    storageBytes,
    historyBytes,
    recentBytes,
    statusVersion: status.version ?? null,
    metricsUpdatedAt: serverMetrics.updatedAt ?? serverMetrics.timestamp ?? status.metricsUpdatedAt ?? null
  };

  const key = JSON.stringify(keyPayload);

  if (metricsCache && metricsCacheKey === key) {
    return metricsCache;
  }

  const result = {
    articlesDownloaded,
    imagesDownloaded,
    storageBytes,
    storageFormatted: typeof serverMetrics.storageFormatted === 'string'
      ? serverMetrics.storageFormatted
      : (typeof status.storage?.formatted === 'string' ? status.storage.formatted : null),
    timestamp: Date.now()
  };

  metricsCache = result;
  metricsCacheKey = key;

  return result;
}

/**
 * 格式化函数缓存
 */
export const formatCache = {
  // 缓存格式化数字
  formatNumber: memoize((num, options) => {
    if (typeof num !== 'number' || !Number.isFinite(num)) return '0';
    return new Intl.NumberFormat('zh-CN', options).format(num);
  }, { maxSize: 50 }),
  
  // 缓存格式化字节
  formatBytes: memoize((bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let value = bytes;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
  }, { maxSize: 50 }),
  
  // 缓存格式化相对时间
  formatRelativeTime: memoize((date) => {
    if (!date) return '从未';
    const timestamp = typeof date === 'string' ? Date.parse(date) : date;
    if (!Number.isFinite(timestamp)) return '未知';
    
    const now = Date.now();
    const diff = now - timestamp;
    
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 2592000000) return `${Math.floor(diff / 86400000)} 天前`;
    return new Date(timestamp).toLocaleDateString('zh-CN');
  }, { maxSize: 100, ttl: 30000 }) // 30秒过期
};

/**
 * 趋势图路径缓存 - 使用LRU限制大小，避免内存泄漏
 */
let trendPathCache = new LRUCache(50); // 最多缓存50个路径

export function cachedCalculateTrendPath(data, width, height) {
  const key = `${JSON.stringify(data)}_${width}_${height}`;
  
  const cached = trendPathCache.get(key);
  if (cached) {
    return cached;
  }
  
  // 限制缓存大小
  if (trendPathCache.size > 20) {
    trendPathCache.clear();
  }
  
  // 计算路径
  if (!data || data.length === 0) {
    return '';
  }
  
  const maxValue = Math.max(...data, 1);
  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * width;
    const y = height - (value / maxValue) * height;
    return `${x},${y}`;
  });
  
  const path = `M ${points.join(' L ')}`;
  trendPathCache.set(key, path);
  
  return path;
}

/**
 * 清理所有缓存
 */
export function clearAllCaches() {
  metricsCache = null;
  metricsCacheKey = null;
  trendPathCache.clear();
  formatCache.formatNumber.cache?.clear();
  formatCache.formatBytes.cache?.clear();
  formatCache.formatRelativeTime.cache?.clear();
  console.log('[Cache] 所有缓存已清理');
}
