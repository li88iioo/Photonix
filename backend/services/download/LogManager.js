/**
 * @file LogManager.js
 * @description 日志管理器，负责日志记录、轮转和持久化
 */

const path = require('path');
const fsp = require('fs/promises');
const { v4: uuidv4 } = require('uuid');
const LRUCache = require('./LRUCache');

class LogManager {
  constructor(paths, maxEntries = 500) {
    this.paths = paths;
    this.logsCache = new LRUCache(maxEntries); // 使用LRU缓存替代数组
    this.logIndex = [];  // 仅保存日志ID索引，用于顺序访问
    this.MAX_LOG_ENTRIES = maxEntries;
  }

  /**
   * 记录日志
   * @param {'info'|'success'|'warning'|'error'} level 日志级别
   * @param {string} message 日志消息
   * @param {object} meta 元数据
   * @returns {object} 日志条目
   */
  log(level, message, meta = {}) {
    const normalizedLevel = this.normalizeLogLevel(level);
    const timestamp = new Date().toISOString();
    const scope = this.resolveLogScope(meta);
    
    const entry = {
      id: uuidv4(),
      level: normalizedLevel,
      message,
      meta,
      scope,
      timestamp,
      line: this.formatLogLine(normalizedLevel, message, meta, timestamp)
    };

    // 添加到LRU缓存和索引
    this.logsCache.set(entry.id, entry);
    this.logIndex.push(entry.id);
    
    // 日志轮转：保持最大条数限制
    if (this.logIndex.length > this.MAX_LOG_ENTRIES) {
      const removedIds = this.logIndex.splice(0, this.logIndex.length - this.MAX_LOG_ENTRIES);
      // LRU缓存会自动处理旧条目的移除
      removedIds.forEach(id => this.logsCache.delete(id));
    }

    // 异步写入文件
    this.appendActivityLog(entry).catch(() => {});
    
    // 错误和警告写入错误日志
    if (normalizedLevel === 'error' || normalizedLevel === 'warning') {
      this.appendErrorLog(entry).catch(() => {});
    }

    return entry;
  }

  /**
   * 规范化日志级别
   */
  normalizeLogLevel(level) {
    const value = String(level || '').toLowerCase();
    if (value === 'warn') return 'warning';
    if (['success', 'warning', 'error'].includes(value)) return value;
    return 'info';
  }

  /**
   * 解析日志作用域
   */
  resolveLogScope(meta = {}) {
    if (meta.scope) {
      return `[${meta.scope}]`;
    }
    
    const parts = [];
    
    // 优先使用任务名称，如果没有则使用任务ID
    const taskName = meta.taskName || meta.taskTitle;
    const taskId = meta.taskId || meta.task_id;
    
    if (taskName) {
      parts.push(taskName);
    } else if (taskId) {
      parts.push(`任务:${taskId.slice(0, 8)}`);
    }
    
    // 如果有RSS源信息且不与任务名重复
    const feed = meta.feedTitle || meta.feed || meta.source;
    if (feed && !parts.includes(feed) && feed !== taskName) {
      parts.push(feed);
    }
    
    // 如果有文章标题
    const article = meta.article || meta.title || meta.entryTitle;
    if (article && article !== taskName && article !== feed) {
      parts.push(article);
    }
    
    if (!parts.length) {
      return '[下载器]';
    }
    
    return `[${parts.join('][')}]`;
  }

  /**
   * 格式化日志行
   */
  formatLogLine(level, message, meta, timestamp) {
    const time = this.formatTimestamp(timestamp);
    const scope = this.resolveLogScope(meta);
    return `${time} - ${level.toUpperCase()} - ${scope} - ${message}`;
  }

  /**
   * 格式化时间戳
   */
  formatTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return new Date().toISOString().replace('T', ' ').slice(0, 19);
    }
    
    const pad = (input) => String(input).padStart(2, '0');
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  /**
   * 写入活动日志文件
   */
  async appendActivityLog(entry) {
    if (!this.paths?.activityLogPath) return;
    
    try {
      await fsp.mkdir(path.dirname(this.paths.activityLogPath), { recursive: true });
      await fsp.appendFile(this.paths.activityLogPath, `${entry.line}\n`, 'utf-8');
    } catch (error) {
      console.warn('[LogManager] 写入活动日志失败', error.message);
    }
  }

  /**
   * 写入错误日志文件
   */
  async appendErrorLog(entry) {
    if (!this.paths?.errorLogPath) return;
    
    try {
      await fsp.mkdir(path.dirname(this.paths.errorLogPath), { recursive: true });
      const line = this.formatLogLine(
        entry.level || 'error',
        entry.message,
        entry.meta,
        entry.timestamp
      );
      await fsp.appendFile(this.paths.errorLogPath, `${line}\n`, 'utf-8');
    } catch (error) {
      console.warn('[LogManager] 写入错误日志失败', error.message);
    }
  }

  /**
   * 获取日志列表
   * @param {object} query 查询参数
   * @returns {object} 日志结果
   */
  getLogs(query = {}) {
    const level = String(query.level || 'all').toLowerCase();
    const limit = Math.min(Number(query.limit) || 100, 200);
    const taskId = query.taskId;
    
    // 从索引获取日志条目
    let entries = this.logIndex
      .slice(-limit * 2)  // 获取更多条目用于过滤
      .map(id => this.logsCache.get(id))
      .filter(Boolean);  // 过滤掉可能已被删除的条目
    
    // 按任务过滤
    if (taskId) {
      entries = entries.filter((entry) => entry.meta.taskId === taskId);
    }
    
    // 按级别过滤
    if (level !== 'all') {
      entries = entries.filter((entry) => entry.level === level);
    }
    
    // 限制数量并倒序
    entries = entries.slice(-limit).reverse();
    
    return { entries };
  }

  /**
   * 清空日志
   * @param {object} options 清空选项
   */
  async clearLogs(options = {}) {
    this.logsCache.clear();
    this.logIndex = [];
    
    if (!options.keepFiles && this.paths?.activityLogPath) {
      try {
        await fsp.mkdir(path.dirname(this.paths.activityLogPath), { recursive: true });
        await fsp.writeFile(this.paths.activityLogPath, '', 'utf-8');
      } catch (error) {
        console.warn('[LogManager] 清空活动日志文件失败', error.message);
      }
    }
    
    return { cleared: true };
  }

  /**
   * 日志轮转（按大小或时间）
   */
  async rotateLogs() {
    if (!this.paths?.activityLogPath) return;
    
    try {
      const stats = await fsp.stat(this.paths.activityLogPath);
      const MAX_SIZE = 10 * 1024 * 1024; // 10MB
      
      if (stats.size > MAX_SIZE) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archivePath = this.paths.activityLogPath.replace('.log', `.${timestamp}.log`);
        
        await fsp.rename(this.paths.activityLogPath, archivePath);
        await fsp.writeFile(this.paths.activityLogPath, '', 'utf-8');
        
        this.log('info', '日志文件已轮转', {
          scope: '日志管理',
          oldSize: stats.size,
          archivePath
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[LogManager] 日志轮转失败', error.message);
      }
    }
  }

  /**
   * 获取日志统计
   */
  getStatistics() {
    const stats = {
      total: this.logIndex.length,
      info: 0,
      success: 0,
      warning: 0,
      error: 0
    };
    
    // 只统计最近的日志以提高性能
    const recentLogs = this.logIndex.slice(-200);
    recentLogs.forEach(id => {
      const entry = this.logsCache.get(id);
      if (entry) {
        stats[entry.level] = (stats[entry.level] || 0) + 1;
      }
    });
    
    return stats;
  }
}

module.exports = LogManager;
