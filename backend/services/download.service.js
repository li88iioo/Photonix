/**
 * @file download.service.refactored.js
 * @description 重构后的下载服务，使用模块化架构
 */

const path = require('path');
const fsp = require('fs/promises');
const { v4: uuidv4 } = require('uuid');

// 导入模块
const TaskScheduler = require('./download/TaskScheduler');
const ConfigManager = require('./download/ConfigManager');
const FeedProcessor = require('./download/FeedProcessor');
const ImageDownloader = require('./download/ImageDownloader');
const HistoryTracker = require('./download/HistoryTracker');
const LogManager = require('./download/LogManager');
const TaskManager = require('./download/TaskManager');

// 导入错误类
const {
  ConfigurationError,
  ExternalServiceError,
  ValidationError
} = require('../utils/errors');

// 常量定义
const DATA_ROOT = path.resolve(__dirname, '../../data/download-service');
const STATE_ROOT = path.join(DATA_ROOT, 'state');
const TASKS_FILE = path.join(STATE_ROOT, 'tasks.json');
const HISTORY_FILE = path.join(STATE_ROOT, 'history.json');
const MAX_ITEMS_PER_RUN = Number(process.env.DOWNLOAD_MAX_ITEMS || 20);

/**
 * 重构后的下载管理器
 */
class DownloadManager {
  constructor() {
    // 初始化模块
    this.configManager = new ConfigManager(DATA_ROOT);
    this.scheduler = null; // 配置加载后初始化
    this.logManager = null; // 配置加载后初始化
    this.feedProcessor = null; // 配置加载后初始化
    this.imageDownloader = null; // 配置加载后初始化
    this.historyTracker = null; // 配置加载后初始化
    this.taskManager = null; // 配置加载后初始化

    // 任务管理
    this.tasks = new Map();
    this.skipFeeds = new Set();

    // 服务状态
    this.startedAt = Date.now();
    this.ready = this.initialize();
  }

  /**
   * 初始化服务
   */
  async initialize() {
    // 创建必要目录
    await fsp.mkdir(DATA_ROOT, { recursive: true });
    await fsp.mkdir(STATE_ROOT, { recursive: true });

    // 加载配置
    const config = await this.configManager.loadConfig();
    const paths = this.configManager.paths;

    // 初始化各模块
    this.logManager = new LogManager(paths);
    this.scheduler = new TaskScheduler(this.logManager);
    this.feedProcessor = new FeedProcessor(config, this.logManager);
    this.imageDownloader = new ImageDownloader(config, this.logManager);
    this.historyTracker = new HistoryTracker(config, paths);

    // 初始化历史追踪数据库
    await this.historyTracker.initializeDatabase();

    // 清理上次意外中断留下的临时文件
    await this.cleanupStaleTempFiles(paths.baseFolder);

    // 初始化任务管理器
    this.taskManager = new TaskManager(() => this.historyTracker.db);

    // P1优化: 优先从数据库加载任务
    let tasks = this.taskManager.loadAllTasks();

    // 如果数据库为空，尝试从JSON文件迁移
    if (tasks.length === 0) {
      const jsonTasks = await this.readJSON(TASKS_FILE, []);
      if (jsonTasks.length > 0) {
        // JSON任务文件迁移，直接执行，不输出日志
        const migrated = await this.taskManager.migrateFromJSON(
          jsonTasks.map(raw => this.normalizeTask(raw))
        );
        if (migrated) {
          tasks = this.taskManager.loadAllTasks();
          // 迁移成功后可以删除JSON文件
          try {
            await fsp.rename(TASKS_FILE, TASKS_FILE + '.migrated');
          } catch (e) {
            // 忽略文件操作错误
          }
        }
      }
    }

    // 恢复任务到内存Map
    tasks.forEach((task) => {
      this.tasks.set(task.id, task);
    });

    // 更新跳过的源列表
    this.skipFeeds = new Set(config.skipFeeds);

    // 重新调度运行中的任务
    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        this.scheduler.scheduleTask(
          task,
          (taskId) => this.executeTask(taskId),
          { immediate: false }
        );
      }
    }

    const totalTasks = this.tasks.size;
    const runningTasks = this.getRunningTasks().length;

    this.logManager.log('info', `发现 ${totalTasks} 个订阅源，将处理 ${runningTasks || totalTasks} 个。`, {
      scope: '下载器',
      totalTasks,
      runningTasks
    });

    this.logManager.log('info', '启动成功', {
      scope: '下载器',
      downloadRoot: paths.baseFolder
    });
  }

  /**
   * 等待初始化完成
   */
  async ensureReady() {
    await this.ready;
  }

  /**
   * 执行下载任务
   */
  async executeTask(taskId, options = {}) {
    await this.ensureReady();

    const task = this.tasks.get(taskId);
    if (!task) {
      throw new ConfigurationError('下载任务不存在', { taskId });
    }

    const lock = this.scheduler.getTaskMutex(taskId);

    return lock.runExclusive(async () => {
      const runId = uuidv4();
      const startedAt = Date.now();

      this.logManager.log('info', '准备执行下载任务', {
        scope: '下载器',
        taskId,
        runId,
        manual: options.manual === true
      });

      task.stats.lastRunAt = new Date().toISOString();
      task.updatedAt = task.stats.lastRunAt;
      // P1优化: 只更新单个任务
      this.taskManager.saveTask(task);

      try {
        // 获取执行槽
        await this.scheduler.acquireGlobalSlot(this.configManager.config.maxConcurrentFeeds);

        // 拉取Feed
        const feed = await this.feedProcessor.fetchFeed(task);
        const feedTitle = feed.title || task.title || task.feedUrl;

        this.logManager.log('info', '开始处理订阅源', {
          taskId,
          runId,
          feedTitle,
          taskName: feedTitle || task.title || task.name || `任务${taskId.slice(0, 8)}`
        });

        if (this.skipFeeds.has(feedTitle)) {
          this.logManager.log('info', '跳过被列入忽略清单的订阅源', {
            taskId,
            runId,
            feedTitle,
            taskName: feedTitle || task.title || task.name || `任务${taskId.slice(0, 8)}`
          });
          return;
        }

        // 处理条目
        const items = (feed.items || []).slice(0, MAX_ITEMS_PER_RUN);
        const onlyEntries = Array.isArray(options.onlyEntries)
          ? new Set(options.onlyEntries.map(v => String(v)))
          : null;
        const forceDownload = options.force === true;

        let downloadedArticles = 0;
        let downloadedImages = 0;
        const batch = [];

        for (const item of items) {
          const result = await this.processItem({
            task,
            item,
            feedTitle,
            taskId,
            runId,
            onlyEntries,
            forceDownload
          });

          if (result) {
            downloadedArticles += 1;
            downloadedImages += result.images.length;
            batch.push(result.entry);
          }
        }

        // 更新历史和统计
        if (batch.length > 0) {
          this.historyTracker.addHistoryBatch(batch);
          await this.persistState();
        }

        task.stats.articlesDownloaded += downloadedArticles;
        task.stats.imagesDownloaded += downloadedImages;
        task.stats.lastSuccessAt = new Date().toISOString();
        task.stats.lastError = null;
        task.stats.lastErrorAt = null;
        // P1优化: 更新任务统计到数据库
        this.taskManager.updateTaskStats(task.id, task.stats);

        const duration = Date.now() - startedAt;
        this.logManager.log('info', `处理完毕。发现 ${downloadedArticles} 篇新文章，下载了 ${downloadedImages} 张新图片。`, {
          taskId,
          runId,
          feedTitle,
          articles: downloadedArticles,
          images: downloadedImages,
          durationMs: duration
        });

      } catch (error) {
        task.stats.lastError = error.message;
        task.stats.lastErrorAt = new Date().toISOString();
        // P1优化: 更新错误状态到数据库
        this.taskManager.updateTaskStats(task.id, task.stats);

        this.logManager.log('error', '下载任务执行失败', {
          taskId,
          runId,
          error: error.message
        });

        throw new ExternalServiceError('下载任务执行失败', {
          taskId,
          error: error.message
        });
      } finally {
        this.scheduler.releaseGlobalSlot();

        if (task.status === 'running') {
          this.scheduler.scheduleTask(
            task,
            (id) => this.executeTask(id),
            { immediate: false }
          );
        }
      }
    });
  }

  /**
   * 异步调度任务执行，避免阻塞请求线程
   * @param {string} taskId
   * @param {object} options
   */
  scheduleTaskExecution(taskId, options = {}) {
    Promise.resolve()
      .then(() => this.executeTask(taskId, options))
      .catch((error) => {
        if (this.logManager) {
          this.logManager.log('error', '手动任务执行失败', {
            scope: '下载器',
            taskId,
            error: error?.message || String(error)
          });
        }
      });
  }

  /**
   * 处理单个RSS条目
   */
  async processItem({ task, item, feedTitle, taskId, runId, onlyEntries, forceDownload }) {
    const identifier = this.resolveItemIdentifier(item);
    const articleTitle = item.title || '(未命名文章)';

    // 检查是否只处理特定条目
    if (onlyEntries && !onlyEntries.has(identifier) && !(item.link && onlyEntries.has(item.link))) {
      return null;
    }

    // 检查去重
    const shouldSkip = this.historyTracker.hasDownloaded({
      taskId,
      title: item.title,
      feedTitle,
      entryLink: item.link
    });

    if (shouldSkip && !forceDownload) {
      this.logManager.log('info', '跳过已下载文章', {
        taskId,
        runId,
        feedTitle,
        article: articleTitle,
        identifier
      });
      return null;
    }

    this.logManager.log('info', `处理新文章: '${articleTitle}'`, {
      taskId,
      runId,
      feedTitle,
      article: articleTitle,
      identifier
    });

    // 提取图片URL
    let images = await this.feedProcessor.extractImageUrls(item, task.feedUrl);

    // 如果没有图片，尝试从源站获取
    if (images.length === 0 && this.configManager.config.allowFallbackToSourceSite && item.link) {
      images = await this.feedProcessor.fetchFallbackImages(task, item.link);
    }

    if (images.length === 0) {
      this.logManager.log('warning', '未找到可下载的图片', {
        taskId,
        runId,
        feedTitle,
        article: articleTitle,
        identifier
      });
      return null;
    }

    // 创建保存目录
    const articleSlug = this.slugify(item.title || item.guid || item.link || `entry-${Date.now()}`);
    const taskSlug = this.slugify(task.title || task.feedUrl || task.id || 'download-task');
    const articleDir = path.join(this.configManager.paths.baseFolder, taskSlug, articleSlug);
    await fsp.mkdir(articleDir, { recursive: true });

    // 下载图片
    const downloaded = await this.imageDownloader.downloadImagesWithLimits(
      task,
      images,
      articleDir,
      { taskId, runId, feedTitle, article: articleTitle }
    );

    if (downloaded.length === 0) {
      this.logManager.log('warning', '所有图片下载失败或被过滤', {
        taskId,
        runId,
        feedTitle,
        article: articleTitle,
        identifier
      });
      return null;
    }

    // 记录下载
    this.historyTracker.recordDownload({
      taskId,
      title: item.title || articleSlug,
      feedTitle,
      entryLink: item.link || null
    });

    // 创建历史条目
    const entry = {
      id: uuidv4(),
      taskId,
      identifier,
      title: articleTitle,
      feed: feedTitle,
      articleUrl: item.link || null,
      images: downloaded,
      completedAt: new Date().toISOString(),
      size: downloaded.reduce((sum, file) => sum + file.size, 0)
    };

    return { images: downloaded, entry };
  }

  // ==================== 任务管理 API ====================

  /**
   * 创建任务
   */
  async createTask(payload) {
    await this.ensureReady();

    const feedUrl = payload.feedUrl?.trim();
    if (!feedUrl) {
      throw new ValidationError('必须提供有效的订阅地址');
    }

    const now = new Date().toISOString();
    const task = this.normalizeTask({
      id: uuidv4(),
      title: payload.title?.trim() || feedUrl,
      feedUrl,
      interval: payload.interval?.trim() || '60m',
      status: payload.autoStart ? 'running' : 'paused',
      createdAt: now,
      updatedAt: now,
      category: payload.category?.trim() || '',
      excludeKeywords: this.normalizeStringArray(payload.excludeKeywords),
      tags: this.unique(this.normalizeStringArray(payload.tags)),
      notes: payload.notes?.trim() || '',
      cookie: payload.cookie?.trim() || '',
      cookieDomain: this.normalizeCookieDomain(payload.cookieDomain)
    });

    this.tasks.set(task.id, task);
    await this.persistState();

    if (task.status === 'running') {
      this.scheduler.scheduleTask(
        task,
        (taskId) => this.executeTask(taskId),
        { immediate: true }
      );
    }

    this.logManager.log('info', '创建下载任务', {
      taskId: task.id,
      feedUrl: task.feedUrl,
      autoStart: payload.autoStart
    });

    return this.serializeTask(task);
  }

  /**
   * 更新任务
   */
  async updateTask(taskId, payload) {
    await this.ensureReady();

    const task = this.tasks.get(taskId);
    if (!task) {
      throw new ConfigurationError('下载任务不存在', { taskId });
    }

    // 更新属性
    if (payload.title !== undefined) {
      task.title = payload.title.trim() || task.title;
    }

    if (payload.feedUrl !== undefined) {
      const feedUrl = payload.feedUrl.trim();
      if (!feedUrl) {
        throw new ValidationError('订阅地址不能为空');
      }
      task.feedUrl = feedUrl;
    }

    if (payload.interval !== undefined) {
      task.interval = payload.interval.trim() || task.interval || '60m';
      task.schedule.interval = task.interval;
      if (task.status === 'running') {
        this.scheduler.scheduleTask(
          task,
          (id) => this.executeTask(id),
          { immediate: false }
        );
      }
    }

    // 更新其他属性
    if (payload.category !== undefined) task.category = String(payload.category || '').trim();
    if (payload.excludeKeywords !== undefined) task.excludeKeywords = this.normalizeStringArray(payload.excludeKeywords);
    if (payload.tags !== undefined) task.tags = this.unique(this.normalizeStringArray(payload.tags));
    if (payload.notes !== undefined) task.notes = String(payload.notes || '').trim();
    if (payload.cookie !== undefined) task.cookie = String(payload.cookie || '').trim();
    if (payload.cookieDomain !== undefined && task.cookie) {
      task.cookieDomain = this.normalizeCookieDomain(payload.cookieDomain);
    }

    // 处理启用/禁用
    if (payload.enabled !== undefined) {
      const enabled = Boolean(payload.enabled);
      if (enabled && task.status !== 'running') {
        task.status = 'running';
        this.scheduler.scheduleTask(
          task,
          (id) => this.executeTask(id),
          { immediate: false }
        );
      } else if (!enabled && task.status === 'running') {
        task.status = 'paused';
        task.schedule.next = null;
        this.scheduler.clearSchedule(taskId);
      }
    }

    task.updatedAt = new Date().toISOString();
    await this.persistState();

    this.logManager.log('info', '更新下载任务', {
      taskId,
      taskName: task.title || task.name || task.feedTitle || `任务${taskId.slice(0, 8)}`
    });
    return this.serializeTask(task);
  }

  /**
   * 删除任务
   */
  async deleteTask(taskId) {
    await this.ensureReady();

    const task = this.tasks.get(taskId);
    if (!task) {
      throw new ConfigurationError('下载任务不存在', { taskId });
    }

    this.scheduler.clearSchedule(taskId);
    this.taskManager.deleteTask(taskId);
    this.tasks.delete(taskId);
    await this.persistState();

    const deletedTaskName = task?.title || task?.name || task?.feedTitle || `任务${taskId.slice(0, 8)}`;
    this.logManager.log('info', '删除下载任务', {
      taskId,
      taskName: deletedTaskName
    });
    return { deleted: true };
  }

  /**
   * 触发任务操作
   */
  async triggerTaskAction(taskId, action) {
    await this.ensureReady();

    const task = this.tasks.get(taskId);
    if (!task) {
      throw new ConfigurationError('下载任务不存在', { taskId });
    }

    const normalized = String(action || '').toLowerCase();

    switch (normalized) {
      case 'start':
      case 'resume':
        task.status = 'running';
        task.updatedAt = new Date().toISOString();
        this.scheduler.scheduleTask(
          task,
          (id) => this.executeTask(id),
          { immediate: true }
        );
        await this.persistState();
        this.logManager.log('info', '任务已启动', {
          taskId,
          taskName: task.title || task.name || task.feedTitle || `任务${taskId.slice(0, 8)}`
        });
        return this.serializeTask(task);

      case 'pause':
        task.status = 'paused';
        task.schedule.next = null;
        task.updatedAt = new Date().toISOString();
        this.scheduler.clearSchedule(taskId);
        await this.persistState();
        this.logManager.log('info', '任务已暂停', {
          taskId,
          taskName: task.title || task.name || task.feedTitle || `任务${taskId.slice(0, 8)}`
        });
        return this.serializeTask(task);

      case 'refresh':
      case 'run':
        {
          const queuedAt = new Date().toISOString();
          if (this.logManager) {
            this.logManager.log('info', '收到手动运行请求，已排队等待执行', {
              scope: '下载器',
              taskId,
              queuedAt
            });
          }
          this.scheduleTaskExecution(taskId, { manual: true });
          return {
            queued: true,
            queuedAt,
            task: this.serializeTask(task)
          };
        }

      default:
        throw new ValidationError(`不支持的任务操作: ${action}`);
    }
  }

  // ==================== 查询 API ====================

  /**
   * 获取服务状态
   */
  async getServiceStatus() {
    await this.ensureReady();

    const now = Date.now();
    const taskStats = this.taskManager.getTaskStatistics();
    const historyStats = this.historyTracker.getStatistics();
    const recentDownloads = this.historyTracker
      .getRecentHistory(10)
      .map((entry) => this.historyTracker.normalizeEntryShape(entry))
      .filter(Boolean);
    const storageBytes = this.historyTracker.getTotalSizeEstimate();

    return {
      status: 'online',
      online: true,
      version: 'refactored-2.0.0',
      uptimeMs: now - this.startedAt,
      tasks: {
        total: taskStats.total,
        running: taskStats.running,
        paused: taskStats.paused
      },
      metrics: {
        articlesDownloaded: taskStats.totalArticles,
        imagesDownloaded: taskStats.totalImages,
        storageBytes,
        storageFormatted: this.formatBytes(storageBytes)
      },
      history: {
        totalEntries: this.historyTracker.getHistoryCount(),
        totalDownloads: historyStats.totalDownloads,
        uniqueFeeds: historyStats.uniqueFeeds,
        recentDownloads: historyStats.recentDownloads
      },
      recentDownloads,
      config: this.configManager.getConfig()
    };
  }

  /**
   * 获取配置
   */
  async getConfig() {
    await this.ensureReady();
    return this.configManager.getConfig();
  }

  /**
   * 更新配置
   */
  async updateConfig(partialConfig = {}) {
    await this.ensureReady();

    // 保存旧路径用于比较
    const oldPaths = { ...this.configManager.paths };

    // 更新配置（会重新解析路径）
    const config = await this.configManager.updateConfig(partialConfig);
    const newPaths = this.configManager.paths;

    // 检测关键路径是否变化
    const databasePathChanged = oldPaths.databasePath !== newPaths.databasePath;
    const logsPathChanged = oldPaths.activityLogPath !== newPaths.activityLogPath
      || oldPaths.errorLogPath !== newPaths.errorLogPath;

    // 如果数据库路径变化，重新初始化数据库连接
    if (databasePathChanged) {
      this.logManager.log('warning', '数据库路径已变更，正在重新初始化...', {
        scope: '下载器',
        oldPath: oldPaths.databasePath,
        newPath: newPaths.databasePath
      });

      // 关闭旧连接并重新初始化
      await this.historyTracker.initializeDatabase();

      // 重新加载任务（因为数据库变了）
      const tasks = this.taskManager.loadAllTasks();
      this.tasks.clear();
      tasks.forEach(task => {
        this.tasks.set(task.id, task);
      });

      this.logManager.log('info', '数据库重新初始化完成', {
        scope: '下载器',
        tasksLoaded: this.tasks.size
      });
    }

    // 如果日志路径变化，重新初始化 LogManager
    if (logsPathChanged) {
      this.logManager = new LogManager(newPaths);
      this.logManager.log('info', '日志路径已更新', {
        scope: '下载器',
        activityLog: newPaths.activityLogPath,
        errorLog: newPaths.errorLogPath
      });
      if (this.scheduler) {
        this.scheduler.logManager = this.logManager;
      }
      if (this.feedProcessor) {
        this.feedProcessor.logManager = this.logManager;
      }
      if (this.imageDownloader) {
        this.imageDownloader.logger = this.logManager;
      }
    }

    // 更新模块配置
    this.feedProcessor.config = config;
    this.imageDownloader.config = config;
    this.historyTracker.config = config;
    this.skipFeeds = new Set(config.skipFeeds);

    return this.configManager.getConfig();
  }

  /**
   * 获取任务列表
   */
  async listTasks(query = {}) {
    await this.ensureReady();

    const keyword = String(query.search || '').trim().toLowerCase();
    const statusFilter = query.status ? String(query.status).toLowerCase() : null;

    let items = Array.from(this.tasks.values());

    if (statusFilter && statusFilter !== 'all') {
      items = items.filter(task => String(task.status).toLowerCase() === statusFilter);
    }

    if (keyword) {
      items = items.filter(task => {
        return [task.title, task.feedUrl]
          .filter(Boolean)
          .map(value => value.toLowerCase())
          .some(value => value.includes(keyword));
      });
    }

    return {
      tasks: items.map(task => this.serializeTask(task)),
      total: items.length
    };
  }

  /**
   * 分页获取历史记录
   * @param {{page?:number,pageSize?:number}} query
   * @returns {{entries:Array,pagination:{page:number,pageSize:number,total:number}}}
   */
  async getHistory(query = {}) {
    await this.ensureReady();
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 50;
    return this.historyTracker.getHistoryPage({ page, pageSize });
  }

  /**
   * 获取任务日志
   */
  async getTaskLogs(taskId, query = {}) {
    await this.ensureReady();

    if (!this.tasks.has(taskId)) {
      throw new ConfigurationError('下载任务不存在', { taskId });
    }

    return this.logManager.getLogs({ ...query, taskId });
  }

  /**
   * 获取全局日志
   */
  async getGlobalLogs(query = {}) {
    await this.ensureReady();
    return this.logManager.getLogs(query);
  }

  /**
   * 清空全局日志
   */
  async clearGlobalLogs(options = {}) {
    await this.ensureReady();
    return this.logManager.clearLogs(options);
  }

  /**
   * 预览Feed
   */
  async previewFeed(taskId, query = {}) {
    await this.ensureReady();

    const task = this.tasks.get(taskId);
    if (!task) {
      throw new ConfigurationError('下载任务不存在', { taskId });
    }

    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50);
    const feed = await this.feedProcessor.fetchFeed(task);
    const items = (feed.items || []).slice(0, limit);

    const previews = [];
    for (const item of items) {
      const identifier = this.resolveItemIdentifier(item);
      const images = await this.feedProcessor.extractImageUrls(item, task.feedUrl);
      const downloaded = this.historyTracker.hasDownloaded({
        taskId,
        title: item.title,
        feedTitle: feed.title,
        entryLink: item.link
      });

      previews.push({
        id: identifier,
        title: item.title || '(未命名文章)',
        link: item.link || null,
        guid: item.guid || null,
        images,
        downloaded
      });
    }

    return {
      task: this.serializeTask(task),
      feed: {
        title: feed.title || task.title,
        link: feed.link || task.feedUrl
      },
      items: previews
    };
  }

  /**
   * 选择性下载条目
   */
  async downloadSelectedEntries(taskId, payload = {}) {
    await this.ensureReady();

    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    if (entries.length === 0) {
      throw new ValidationError('请至少选择一个条目');
    }

    const task = this.tasks.get(taskId);
    if (!task) {
      throw new ConfigurationError('下载任务不存在', { taskId });
    }

    const queuedAt = new Date().toISOString();
    if (this.logManager) {
      this.logManager.log('info', '收到手动下载请求，已排队等待执行', {
        scope: '下载器',
        taskId,
        requestedEntries: entries.length,
        queuedAt
      });
    }

    this.scheduleTaskExecution(taskId, {
      manual: true,
      onlyEntries: entries,
      force: payload.force !== false
    });

    return {
      queued: true,
      queuedAt,
      pendingEntries: entries.length,
      task: this.serializeTask(task)
    };
  }

  /**
   * 导出OPML
   */
  async exportOpml() {
    await this.ensureReady();

    const result = this.feedProcessor.exportOpml(this.tasks);
    const opmlPath = this.configManager.paths.opmlPath;

    await fsp.mkdir(path.dirname(opmlPath), { recursive: true });
    await fsp.writeFile(opmlPath, result.content, 'utf-8');

    return {
      ...result,
      path: opmlPath
    };
  }

  /**
   * 导入OPML
   */
  async importOpml(content, options = {}) {
    await this.ensureReady();

    if (!content || typeof content !== 'string') {
      throw new ValidationError('OPML 内容不能为空');
    }

    const feeds = this.feedProcessor.importOpml(content);
    if (!feeds.length) {
      throw new ValidationError('OPML 文件中未找到任何订阅源');
    }

    const mode = String(options.mode || 'merge').toLowerCase();
    if (mode === 'replace') {
      for (const id of Array.from(this.tasks.keys())) {
        this.scheduler.clearSchedule(id);
      }
      this.tasks.clear();
    }

    const byUrl = new Map(Array.from(this.tasks.values()).map(task => [task.feedUrl, task]));
    const summary = { added: 0, updated: 0, skipped: 0, total: feeds.length };
    const now = new Date().toISOString();

    feeds.forEach(feedData => {
      const existing = byUrl.get(feedData.feedUrl);

      if (existing) {
        // 更新现有任务
        Object.assign(existing, feedData, { updatedAt: now });
        summary.updated += 1;
      } else {
        // 创建新任务
        const task = this.normalizeTask({
          ...feedData,
          id: uuidv4(),
          status: 'paused',
          createdAt: now,
          updatedAt: now
        });
        this.tasks.set(task.id, task);
        summary.added += 1;
      }
    });

    // P1优化: 批量保存到数据库
    this.taskManager.saveAllTasks(Array.from(this.tasks.values()));

    const opmlPath = this.configManager.paths.opmlPath;
    await fsp.mkdir(path.dirname(opmlPath), { recursive: true });
    await fsp.writeFile(opmlPath, content, 'utf-8');

    this.logManager.log('info', '导入 OPML 完成', summary);
    return summary;
  }

  /**
   * 代理接口（不支持）
   */
  async proxy() {
    throw new ConfigurationError('当前部署模式已内嵌下载服务，不再支持代理请求');
  }

  // ==================== 辅助方法 ====================

  /**
   * 读取JSON文件
   */
  async readJSON(filePath, fallback) {
    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      this.logManager?.log('warning', `读取 JSON 失败: ${filePath}`, {
        filePath,
        error: error.message
      });
      return fallback;
    }
  }

  /**
   * 写入JSON文件
   */
  async writeJSON(filePath, data) {
    const tmp = `${filePath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fsp.rename(tmp, filePath);
  }

  /**
   * 持久化状态
   */
  async persistState() {
    // 任务直接保存到数据库
    const tasks = Array.from(this.tasks.values());
    this.taskManager.saveAllTasks(tasks);
    // 历史记录已在 addHistoryEntry/addHistoryBatch 中实时写入数据库，无需单独持久化
  }



  /**
   * 规范化任务数据
   */
  normalizeTask(raw) {
    const now = new Date().toISOString();
    return {
      id: raw.id || uuidv4(),
      title: raw.title || raw.feedUrl,
      feedUrl: raw.feedUrl,
      interval: raw.interval || '60m',
      status: raw.status || 'paused',
      createdAt: raw.createdAt || now,
      updatedAt: raw.updatedAt || now,
      schedule: {
        interval: raw.schedule?.interval || raw.interval || '60m',
        next: raw.schedule?.next || null
      },
      category: raw.category || '',
      excludeKeywords: Array.isArray(raw.excludeKeywords) ? raw.excludeKeywords : [],
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      notes: raw.notes || '',
      cookie: raw.cookie || '',
      cookieDomain: raw.cookieDomain || '',
      stats: {
        articlesDownloaded: Number(raw.stats?.articlesDownloaded || 0),
        imagesDownloaded: Number(raw.stats?.imagesDownloaded || 0),
        lastRunAt: raw.stats?.lastRunAt || null,
        lastSuccessAt: raw.stats?.lastSuccessAt || null,
        lastErrorAt: raw.stats?.lastErrorAt || null,
        lastError: raw.stats?.lastError || null
      }
    };
  }

  /**
   * 序列化任务用于持久化
   */
  serializeTask(task) {
    return {
      id: task.id,
      title: task.title,
      feedUrl: task.feedUrl,
      interval: task.interval,
      status: task.status,
      enabled: task.status === 'running',
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      schedule: task.schedule,
      category: task.category || '',
      excludeKeywords: Array.isArray(task.excludeKeywords) ? task.excludeKeywords : [],
      tags: Array.isArray(task.tags) ? task.tags : [],
      notes: task.notes || '',
      cookie: task.cookie || '',
      cookieDomain: task.cookieDomain || '',
      stats: task.stats,
      nextRunAt: task.schedule?.next,
      lastRunAt: task.stats?.lastRunAt,
      lastSuccessAt: task.stats?.lastSuccessAt,
      articlesDownloaded: task.stats?.articlesDownloaded,
      imagesDownloaded: task.stats?.imagesDownloaded
    };
  }

  /**
   * 获取运行中的任务
   */
  getRunningTasks() {
    return Array.from(this.tasks.values()).filter(task => task.status === 'running');
  }

  /**
   * 解析条目标识符
   */
  resolveItemIdentifier(item, fallbackIndex = 0) {
    const candidates = [
      item?.guid,
      item?.id,
      item?.link,
      item?.slug,
      item?.title ? this.slugify(item.title) : null,
      fallbackIndex ? `entry-${fallbackIndex}` : null
    ];
    const found = candidates.find(value => value && String(value).trim() !== '');
    return found ? String(found) : `entry-${fallbackIndex}`;
  }

  /**
   * 字符串slug化
   */
  slugify(value, fallback = 'item') {
    if (!value || typeof value !== 'string') return fallback;
    const sanitized = value
      .normalize('NFC')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/[^\p{L}\p{N}\s\-_.]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return sanitized ? sanitized.slice(0, 120) : fallback;
  }

  /**
   * 规范化字符串数组
   */
  normalizeStringArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
    if (typeof value === 'string') {
      return value.split(/[,\n]/).map(item => item.trim()).filter(Boolean);
    }
    return [];
  }

  /**
   * 规范化Cookie域名
   */
  normalizeCookieDomain(value) {
    if (!value || typeof value !== 'string') return '';
    let domain = value.trim().toLowerCase();
    if (!domain) return '';
    domain = domain.replace(/^[a-z]+:\/\//i, '');
    domain = domain.split(/[/?#]/)[0];
    domain = domain.replace(/:\d+$/, '');
    domain = domain.replace(/^[.]+/, '');
    return domain;
  }

  /**
   * 数组去重
   */
  unique(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
  }

  /**
   * 将字节数格式化为可读字符串
   * @param {number} bytes
   * @returns {string}
   */
  formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const size = value / Math.pow(1024, exponent);
    const precision = size >= 10 ? 0 : 1;
    return `${size.toFixed(precision)} ${units[exponent]}`;
  }

  /**
   * 清理意外中断遗留的临时下载文件
   * 
   * 当容器重启或进程崩溃时，正在下载的文件会以 .download.tmp 后缀残留。
   * 此方法在服务启动时递归扫描下载目录，删除这些不完整的文件。
   * 
   * @param {string} directory - 要扫描的根目录
   * @returns {Promise<number>} 删除的文件数量
   */
  async cleanupStaleTempFiles(directory) {
    if (!directory) return 0;

    let cleanedCount = 0;
    const TEMP_SUFFIX = '.download.tmp';

    const scanDir = async (dir) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (err) {
        // 目录不存在或无权访问，静默跳过
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            await scanDir(fullPath);
          } else if (entry.isFile() && entry.name.endsWith(TEMP_SUFFIX)) {
            await fsp.unlink(fullPath);
            cleanedCount += 1;
            if (this.logManager) {
              this.logManager.log('info', `清理残留临时文件: ${entry.name}`, {
                scope: '下载器',
                path: fullPath
              });
            }
          }
        } catch (unlinkErr) {
          // 删除失败时记录但不中断
          if (this.logManager) {
            this.logManager.log('warning', `无法删除临时文件: ${fullPath}`, {
              scope: '下载器',
              error: unlinkErr.message
            });
          }
        }
      }
    };

    try {
      await scanDir(directory);
      if (cleanedCount > 0 && this.logManager) {
        this.logManager.log('info', `启动清理完成：删除了 ${cleanedCount} 个残留临时文件`, {
          scope: '下载器',
          cleanedCount
        });
      }
    } catch (error) {
      if (this.logManager) {
        this.logManager.log('warning', '清理临时文件时发生错误', {
          scope: '下载器',
          error: error.message
        });
      }
    }

    return cleanedCount;
  }
}

// 导出单例
module.exports = new DownloadManager();
