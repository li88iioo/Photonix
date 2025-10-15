/**
 * @file HistoryTracker.js
 * @description 历史记录追踪器，负责去重和历史管理
 */

const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const LRUCache = require('./LRUCache');

class HistoryTracker {
  constructor(config, paths) {
    this.config = config;
    this.paths = paths;
    this.db = null;
    this.historyCache = new LRUCache(200); // 使用LRU缓存管理历史
    this.historyIndex = []; // 历史ID索引
    this.MAX_HISTORY_ENTRIES = 200;
    this.MAX_RECENT_ENTRIES = 25;
  }

  /**
   * 初始化数据库
   */
  async initializeDatabase() {
    if (this.db) {
      try {
        this.db.close();
      } catch (error) {
        console.warn('关闭旧的下载数据库连接时发生错误', { error: error.message });
      }
      this.db = null;
    }

    try {
      this.db = new Database(this.paths.databasePath);
      this.db.pragma('journal_mode = WAL');
      
      // 创建下载历史表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS download_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT,
          post_title TEXT,
          feed_title TEXT,
          entry_link TEXT,
          downloaded_at TEXT NOT NULL
        );
      `);
      
      // 创建索引
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_history_title ON download_history(post_title);');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_history_feed_title ON download_history(feed_title, post_title);');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_history_link ON download_history(entry_link);');
      
      // P1优化: 创建任务表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          feed_url TEXT NOT NULL,
          interval TEXT DEFAULT '60m',
          status TEXT DEFAULT 'paused',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          schedule_interval TEXT,
          schedule_next TEXT,
          category TEXT DEFAULT '',
          exclude_keywords TEXT DEFAULT '[]',
          tags TEXT DEFAULT '[]',
          notes TEXT DEFAULT '',
          cookie TEXT DEFAULT '',
          cookie_domain TEXT DEFAULT '',
          stats_articles_downloaded INTEGER DEFAULT 0,
          stats_images_downloaded INTEGER DEFAULT 0,
          stats_last_run_at TEXT,
          stats_last_success_at TEXT,
          stats_last_error_at TEXT,
          stats_last_error TEXT
        );
      `);
      
      // 创建任务索引
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_feed_url ON tasks(feed_url);');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);');
      
      console.info(`数据库连接成功 (去重模式: ${this.getDedupScopeDisplay(this.config.dedupScope)})`, {
        scope: '下载器',
        databasePath: this.paths.databasePath,
        dedupScope: this.config.dedupScope
      });
    } catch (error) {
      console.error('初始化下载历史数据库失败', { error: error.message });
      throw new Error('无法初始化下载历史数据库');
    }
  }

  /**
   * 检查是否已下载
   * @param {object} params 检查参数
   * @returns {boolean} 是否已下载
   */
  hasDownloaded({ taskId, title, feedTitle, entryLink }) {
    if (!this.db) return false;
    
    try {
      const scope = this.config.dedupScope;
      
      if (scope === 'by_link' && entryLink) {
        const stmt = this.db.prepare('SELECT 1 FROM download_history WHERE entry_link = ? LIMIT 1');
        return Boolean(stmt.get(entryLink));
      }
      
      if (scope === 'per_feed' && feedTitle && title) {
        const stmt = this.db.prepare('SELECT 1 FROM download_history WHERE feed_title = ? AND post_title = ? LIMIT 1');
        return Boolean(stmt.get(feedTitle, title));
      }
      
      if (title) {
        const stmt = this.db.prepare('SELECT 1 FROM download_history WHERE post_title = ? LIMIT 1');
        return Boolean(stmt.get(title));
      }
    } catch (error) {
      console.warn('查询历史记录失败', { error: error.message });
    }
    
    return false;
  }

  /**
   * 记录下载
   * @param {object} params 记录参数
   */
  recordDownload({ taskId, title, feedTitle, entryLink }) {
    if (!this.db) return;
    
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO download_history (task_id, post_title, feed_title, entry_link, downloaded_at)
        VALUES (@taskId, @title, @feedTitle, @entryLink, datetime('now'))
      `);
      stmt.run({ taskId, title, feedTitle, entryLink });
    } catch (error) {
      console.warn('写入下载历史失败', { error: error.message });
    }
  }

  /**
   * 添加历史记录条目
   * @param {object} entry 历史条目
   */
  addHistoryEntry(entry) {
    const normalizedEntry = {
      id: entry.id || uuidv4(),
      taskId: entry.taskId,
      identifier: entry.identifier,
      title: entry.title,
      feed: entry.feed,
      articleUrl: entry.articleUrl,
      images: entry.images || [],
      completedAt: entry.completedAt || new Date().toISOString(),
      size: entry.size || 0
    };
    
    // 添加到缓存和索引
    this.historyCache.set(normalizedEntry.id, normalizedEntry);
    this.historyIndex.unshift(normalizedEntry.id);
    
    if (this.historyIndex.length > this.MAX_HISTORY_ENTRIES) {
      const removedIds = this.historyIndex.splice(this.MAX_HISTORY_ENTRIES);
      removedIds.forEach(id => this.historyCache.delete(id));
    }
    
    return normalizedEntry;
  }

  /**
   * 批量添加历史记录
   * @param {Array} entries 历史条目数组
   */
  addHistoryBatch(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    
    entries.forEach(entry => this.addHistoryEntry(entry));
  }

  /**
   * 获取最近的下载记录
   * @param {number} limit 限制数量
   * @returns {Array} 历史记录
   */
  getRecentHistory(limit = this.MAX_RECENT_ENTRIES) {
    return this.historyIndex
      .slice(0, limit)
      .map(id => this.historyCache.peek(id))
      .filter(Boolean);
  }

  /**
   * 获取全部历史记录
   * @returns {Array} 历史记录
   */
  getAllHistory() {
    return this.historyIndex
      .map(id => this.historyCache.peek(id))
      .filter(Boolean);
  }

  /**
   * 获取历史记录数量
   * @returns {number}
   */
  getHistoryCount() {
    return this.historyIndex.length;
  }

  /**
   * 分页获取历史记录
   * @param {{page?:number,pageSize?:number}} [options]
   * @returns {{entries:Array,pagination:{page:number,pageSize:number,total:number}}}
   */
  getHistoryPage({ page = 1, pageSize = 50 } = {}) {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const safeSize = Number.isFinite(pageSize) && pageSize > 0
      ? Math.min(Math.floor(pageSize), this.MAX_HISTORY_ENTRIES)
      : 50;
    const start = (safePage - 1) * safeSize;
    const slice = this.historyIndex.slice(start, start + safeSize);
    const entries = slice
      .map((id) => this.historyCache.peek(id))
      .filter(Boolean)
      .map((entry) => this.normalizeEntryShape(entry))
      .filter(Boolean);

    return {
      entries,
      pagination: {
        page: safePage,
        pageSize: safeSize,
        total: this.getHistoryCount()
      }
    };
  }

  /**
   * 估算历史记录占用的字节数
   * @returns {number}
   */
  getTotalSizeEstimate() {
    return this.historyCache
      .values()
      .reduce((sum, entry) => sum + this.calculateEntrySize(entry), 0);
  }

  /**
   * 设置历史记录（从持久化恢复）
   * @param {Array} history 历史记录数组
   */
  setHistory(history) {
    const items = Array.isArray(history) ? history.slice(0, this.MAX_HISTORY_ENTRIES) : [];
    this.historyCache.clear();
    this.historyIndex = [];
    
    items.forEach(item => {
      if (item && item.id) {
        this.historyCache.set(item.id, item);
        this.historyIndex.push(item.id);
      }
    });
  }

  /**
   * 清理过期的历史记录
   * @param {number} daysToKeep 保留天数
   */
  cleanupOldHistory(daysToKeep = 30) {
    if (!this.db) return;
    
    try {
      const stmt = this.db.prepare(`
        DELETE FROM download_history 
        WHERE downloaded_at < datetime('now', '-' || ? || ' days')
      `);
      const result = stmt.run(daysToKeep);
      
      if (result.changes > 0) {
        console.info(`清理了 ${result.changes} 条过期的下载历史记录`);
      }
    } catch (error) {
      console.warn('清理历史记录失败', { error: error.message });
    }
  }

  /**
   * 获取统计信息
   * @returns {object} 统计信息
   */
  getStatistics() {
    if (!this.db) {
      return {
        totalDownloads: 0,
        uniqueFeeds: 0,
        recentDownloads: 0
      };
    }
    
    try {
      const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM download_history');
      const feedsStmt = this.db.prepare('SELECT COUNT(DISTINCT feed_title) as count FROM download_history');
      const recentStmt = this.db.prepare(`
        SELECT COUNT(*) as count FROM download_history 
        WHERE downloaded_at > datetime('now', '-24 hours')
      `);
      
      return {
        totalDownloads: totalStmt.get().count,
        uniqueFeeds: feedsStmt.get().count,
        recentDownloads: recentStmt.get().count
      };
    } catch (error) {
      console.warn('获取统计信息失败', { error: error.message });
      return {
        totalDownloads: 0,
        uniqueFeeds: 0,
        recentDownloads: 0
      };
    }
  }

  /**
   * 标准化历史条目结构
   * @param {object} entry
   * @returns {object|null}
   */
  normalizeEntryShape(entry) {
    if (!entry) return null;
    const images = Array.isArray(entry.images) ? entry.images : [];
    const normalizedImages = images.map((image) => ({
      url: image?.url || null,
      path: image?.path || null,
      size: Number(image?.size || 0)
    }));

    return {
      id: entry.id,
      taskId: entry.taskId,
      identifier: entry.identifier,
      title: entry.title,
      feed: entry.feed,
      articleUrl: entry.articleUrl || null,
      images: normalizedImages,
      imageCount: normalizedImages.length,
      size: Number(entry.size || 0),
      completedAt: entry.completedAt || new Date().toISOString()
    };
  }

  /**
   * 计算历史条目的体积估算
   * @param {object} entry
   * @returns {number}
   */
  calculateEntrySize(entry) {
    if (!entry) return 0;
    if (typeof entry.size === 'number' && Number.isFinite(entry.size)) {
      return Math.max(entry.size, 0);
    }
    if (Array.isArray(entry.images)) {
      return entry.images.reduce((sum, image) => {
        const value = Number(image?.size || 0);
        return sum + (Number.isFinite(value) && value > 0 ? value : 0);
      }, 0);
    }
    return 0;
  }

  /**
   * 获取去重策略的中文描述
   */
  getDedupScopeDisplay(scope) {
    const scopeMap = {
      'by_link': '按链接去重',
      'per_feed': '按订阅源去重',
      'global': '全局去重'
    };
    return scopeMap[scope] || scope;
  }

  /**
   * 关闭数据库连接
   */
  close() {
    if (this.db) {
      try {
        this.db.close();
        this.db = null;
      } catch (error) {
        console.warn('关闭数据库连接失败', { error: error.message });
      }
    }
  }
}

module.exports = HistoryTracker;
