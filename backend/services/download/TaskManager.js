/**
 * @file TaskManager.js
 * @description 任务管理器，负责任务的数据库存储和查询
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../config/logger');
const { LOG_PREFIXES } = logger;

class TaskManager {
  constructor(dbOrGetter) {
    if (typeof dbOrGetter === 'function') {
      this.getDb = dbOrGetter;
      this.db = null;
    } else {
      this.db = dbOrGetter || null;
      this.getDb = null;
    }
  }

  resolveDb() {
    let candidate = this.getDb ? this.getDb() : this.db;
    if (!candidate) {
      return null;
    }

    if (typeof candidate.open === 'boolean' && candidate.open === false) {
      if (this.getDb) {
        candidate = this.getDb();
      }
    }

    if (!candidate || (typeof candidate.open === 'boolean' && candidate.open === false)) {
      return null;
    }

    this.db = candidate;
    return candidate;
  }

  /**
   * 从数据库加载所有任务
   * @returns {Array} 任务列表
   */
  loadAllTasks() {
    const db = this.resolveDb();
    if (!db) return [];

    try {
      const stmt = db.prepare(`
        SELECT * FROM tasks ORDER BY created_at DESC
      `);
      const rows = stmt.all();

      return rows.map(row => this.deserializeTask(row));
    } catch (error) {
      logger.error(`${LOG_PREFIXES.DOWNLOADER} 加载任务失败`, { error: error.message });
      return [];
    }
  }

  /**
   * 保存任务到数据库
   * @param {object} task 任务对象
   */
  saveTask(task) {
    const db = this.resolveDb();
    if (!db) return;

    try {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO tasks (
          id, title, feed_url, interval, status,
          created_at, updated_at,
          schedule_interval, schedule_next,
          category, exclude_keywords, tags, notes,
          cookie, cookie_domain,
          stats_articles_downloaded, stats_images_downloaded,
          stats_last_run_at, stats_last_success_at,
          stats_last_error_at, stats_last_error
        ) VALUES (
          @id, @title, @feed_url, @interval, @status,
          @created_at, @updated_at,
          @schedule_interval, @schedule_next,
          @category, @exclude_keywords, @tags, @notes,
          @cookie, @cookie_domain,
          @stats_articles_downloaded, @stats_images_downloaded,
          @stats_last_run_at, @stats_last_success_at,
          @stats_last_error_at, @stats_last_error
        )
      `);

      const serialized = this.serializeTaskForDB(task);
      stmt.run(serialized);
    } catch (error) {
      logger.error(`${LOG_PREFIXES.DOWNLOADER} 保存任务失败`, { taskId: task.id, error: error.message });
    }
  }

  /**
   * 批量保存任务
   * @param {Array} tasks 任务列表
   */
  saveAllTasks(tasks) {
    const db = this.resolveDb();
    if (!db) return;

    const taskList = Array.isArray(tasks) ? tasks : [];

    const deleteStmt = db.prepare('DELETE FROM tasks');
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO tasks (
        id, title, feed_url, interval, status,
        created_at, updated_at,
        schedule_interval, schedule_next,
        category, exclude_keywords, tags, notes,
        cookie, cookie_domain,
        stats_articles_downloaded, stats_images_downloaded,
        stats_last_run_at, stats_last_success_at,
        stats_last_error_at, stats_last_error
      ) VALUES (
        @id, @title, @feed_url, @interval, @status,
        @created_at, @updated_at,
        @schedule_interval, @schedule_next,
        @category, @exclude_keywords, @tags, @notes,
        @cookie, @cookie_domain,
        @stats_articles_downloaded, @stats_images_downloaded,
        @stats_last_run_at, @stats_last_success_at,
        @stats_last_error_at, @stats_last_error
      )
    `);

    const transaction = db.transaction((list) => {
      deleteStmt.run();
      if (!list.length) return;
      for (const task of list) {
        insertStmt.run(this.serializeTaskForDB(task));
      }
    });

    try {
      transaction(taskList);
    } catch (error) {
      logger.error(`${LOG_PREFIXES.DOWNLOADER} 批量保存任务失败`, { error: error.message });
    }
  }

  /**
   * 删除任务
   * @param {string} taskId 任务ID
   */
  deleteTask(taskId) {
    const db = this.resolveDb();
    if (!db) return;

    try {
      const stmt = db.prepare('DELETE FROM tasks WHERE id = ?');
      stmt.run(taskId);
    } catch (error) {
      logger.error(`${LOG_PREFIXES.DOWNLOADER} 删除任务失败`, { taskId, error: error.message });
    }
  }

  /**
   * 更新任务状态
   * @param {string} taskId 任务ID
   * @param {string} status 新状态
   */
  updateTaskStatus(taskId, status) {
    const db = this.resolveDb();
    if (!db) return;

    try {
      const stmt = db.prepare(`
        UPDATE tasks 
        SET status = @status, updated_at = @updated_at 
        WHERE id = @id
      `);
      stmt.run({
        id: taskId,
        status,
        updated_at: new Date().toISOString()
      });
    } catch (error) {
      logger.error(`${LOG_PREFIXES.DOWNLOADER} 更新任务状态失败`, { taskId, status, error: error.message });
    }
  }

  /**
   * 更新任务统计
   * @param {string} taskId 任务ID
   * @param {object} stats 统计信息
   */
  updateTaskStats(taskId, stats) {
    const db = this.resolveDb();
    if (!db) return;

    try {
      const stmt = db.prepare(`
        UPDATE tasks 
        SET 
          stats_articles_downloaded = @articles_downloaded,
          stats_images_downloaded = @images_downloaded,
          stats_last_run_at = @last_run_at,
          stats_last_success_at = @last_success_at,
          stats_last_error_at = @last_error_at,
          stats_last_error = @last_error,
          updated_at = @updated_at
        WHERE id = @id
      `);

      stmt.run({
        id: taskId,
        articles_downloaded: stats.articlesDownloaded || 0,
        images_downloaded: stats.imagesDownloaded || 0,
        last_run_at: stats.lastRunAt,
        last_success_at: stats.lastSuccessAt,
        last_error_at: stats.lastErrorAt,
        last_error: stats.lastError,
        updated_at: new Date().toISOString()
      });
    } catch (error) {
      logger.error(`${LOG_PREFIXES.DOWNLOADER} 更新任务统计失败`, { taskId, error: error.message });
    }
  }

  /**
   * 查询任务
   * @param {object} query 查询条件
   * @returns {Array} 任务列表
   */
  queryTasks(query = {}) {
    const db = this.resolveDb();
    if (!db) return [];

    try {
      let sql = 'SELECT * FROM tasks WHERE 1=1';
      const params = {};

      if (query.status) {
        sql += ' AND status = @status';
        params.status = query.status;
      }

      if (query.search) {
        sql += ' AND (title LIKE @search OR feed_url LIKE @search)';
        params.search = `%${query.search}%`;
      }

      sql += ' ORDER BY updated_at DESC';

      if (query.limit) {
        sql += ' LIMIT @limit';
        params.limit = query.limit;
      }

      const stmt = db.prepare(sql);
      const rows = stmt.all(params);

      return rows.map(row => this.deserializeTask(row));
    } catch (error) {
      logger.error(`${LOG_PREFIXES.DOWNLOADER} 查询任务失败`, { error: error.message });
      return [];
    }
  }

  /**
   * 获取任务统计信息
   * @returns {object} 统计信息
   */
  getTaskStatistics() {
    const db = this.resolveDb();
    if (!db) {
      return {
        total: 0,
        running: 0,
        paused: 0,
        totalArticles: 0,
        totalImages: 0
      };
    }

    try {
      const countStmt = db.prepare(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
          SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused,
          SUM(stats_articles_downloaded) as total_articles,
          SUM(stats_images_downloaded) as total_images
        FROM tasks
      `);

      const stats = countStmt.get();

      return {
        total: stats.total || 0,
        running: stats.running || 0,
        paused: stats.paused || 0,
        totalArticles: stats.total_articles || 0,
        totalImages: stats.total_images || 0
      };
    } catch (error) {
      logger.error(`${LOG_PREFIXES.DOWNLOADER} 获取任务统计失败`, { error: error.message });
      return {
        total: 0,
        running: 0,
        paused: 0,
        totalArticles: 0,
        totalImages: 0
      };
    }
  }

  /**
   * 序列化任务为数据库格式
   * @param {object} task 任务对象
   * @returns {object} 数据库格式
   */
  serializeTaskForDB(task) {
    return {
      id: task.id,
      title: task.title,
      feed_url: task.feedUrl,
      interval: task.interval,
      status: task.status,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      schedule_interval: task.schedule?.interval,
      schedule_next: task.schedule?.next,
      category: task.category || '',
      exclude_keywords: JSON.stringify(task.excludeKeywords || []),
      tags: JSON.stringify(task.tags || []),
      notes: task.notes || '',
      cookie: task.cookie || '',
      cookie_domain: task.cookieDomain || '',
      stats_articles_downloaded: task.stats?.articlesDownloaded || 0,
      stats_images_downloaded: task.stats?.imagesDownloaded || 0,
      stats_last_run_at: task.stats?.lastRunAt,
      stats_last_success_at: task.stats?.lastSuccessAt,
      stats_last_error_at: task.stats?.lastErrorAt,
      stats_last_error: task.stats?.lastError
    };
  }

  /**
   * 反序列化数据库记录为任务对象
   * @param {object} row 数据库记录
   * @returns {object} 任务对象
   */
  deserializeTask(row) {
    return {
      id: row.id,
      title: row.title,
      feedUrl: row.feed_url,
      interval: row.interval,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      schedule: {
        interval: row.schedule_interval || row.interval,
        next: row.schedule_next
      },
      category: row.category || '',
      excludeKeywords: this.parseJSON(row.exclude_keywords, []),
      tags: this.parseJSON(row.tags, []),
      notes: row.notes || '',
      cookie: row.cookie || '',
      cookieDomain: row.cookie_domain || '',
      stats: {
        articlesDownloaded: row.stats_articles_downloaded || 0,
        imagesDownloaded: row.stats_images_downloaded || 0,
        lastRunAt: row.stats_last_run_at,
        lastSuccessAt: row.stats_last_success_at,
        lastErrorAt: row.stats_last_error_at,
        lastError: row.stats_last_error
      }
    };
  }

  /**
   * 安全解析JSON
   * @param {string} str JSON字符串
   * @param {any} fallback 解析失败时的默认值
   * @returns {any} 解析结果
   */
  parseJSON(str, fallback = null) {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  /**
   * 迁移JSON文件中的任务到数据库
   * @param {Array} tasks 任务列表
   */
  async migrateFromJSON(tasks) {
    const db = this.resolveDb();
    if (!db || !tasks || tasks.length === 0) return;

    logger.info(`${LOG_PREFIXES.DOWNLOADER} 开始迁移任务到数据库...`, { count: tasks.length });
    const deleteStmt = db.prepare('DELETE FROM tasks');
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO tasks (
        id, title, feed_url, interval, status,
        created_at, updated_at,
        schedule_interval, schedule_next,
        category, exclude_keywords, tags, notes,
        cookie, cookie_domain,
        stats_articles_downloaded, stats_images_downloaded,
        stats_last_run_at, stats_last_success_at,
        stats_last_error_at, stats_last_error
      ) VALUES (
        @id, @title, @feed_url, @interval, @status,
        @created_at, @updated_at,
        @schedule_interval, @schedule_next,
        @category, @exclude_keywords, @tags, @notes,
        @cookie, @cookie_domain,
        @stats_articles_downloaded, @stats_images_downloaded,
        @stats_last_run_at, @stats_last_success_at,
        @stats_last_error_at, @stats_last_error
      )
    `);

    const transaction = db.transaction((taskList) => {
      deleteStmt.run();
      for (const task of taskList) {
        insertStmt.run(this.serializeTaskForDB(task));
      }
    });

    try {
      transaction(tasks);
      logger.info(`${LOG_PREFIXES.DOWNLOADER} 任务迁移完成`, { count: tasks.length });
      return true;
    } catch (error) {
      logger.error(`${LOG_PREFIXES.DOWNLOADER} 任务迁移失败`, { error: error.message });
      return false;
    }
  }
}

module.exports = TaskManager;
