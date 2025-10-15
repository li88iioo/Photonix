/**
 * 系统维护服务模块
 * 
 * 负责处理系统维护相关的操作，包括：
 * - 缩略图状态同步和管理
 * - 索引状态查询
 * - HLS视频文件状态管理
 * - 补全任务执行（索引、缩略图、HLS）
 * - 清理任务执行（删除冗余文件）
 */

const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../../config/logger');
const { TraceManager } = require('../../utils/trace');
const { safeRedisDel } = require('../../utils/helpers');
const { THUMBS_DIR, PHOTOS_DIR } = require('../../config');
const { runHlsBatch } = require('../video.service');
const { dbAll, dbRun, dbAllWithCache, dbGetWithCache, runAsync } = require('../../db/multi-db');
const idxRepo = require('../../repositories/indexStatus.repo');
const { getMediaStats, getGroupStats, getCount } = require('../../repositories/stats.repo');
const { sanitizePath, isPathSafe } = require('../../utils/path.utils');
const { redis } = require('../../config/redis');

/**
 * 缩略图同步服务类
 * 
 * 负责管理缩略图状态同步，包括：
 * - 重建缩略图状态表
 * - 重新同步缩略图状态
 * - 获取缩略图状态统计
 * - 清理缩略图缓存
 */
class ThumbnailSyncService {
  /**
   * 构造函数
   * @param {Object} clientRedis - Redis客户端实例
   */
  constructor(clientRedis = redis) {
    this.fs = fs;
    this.path = path;
    this.db = require('../../db/multi-db');
    this.config = require('../../config');
    this.redis = clientRedis;
    this._resyncQueue = Promise.resolve();
    this._resyncPending = 0;
    this._resyncActive = false;
    this._currentTrigger = null;
    this._resyncStartedAt = null;
  }

  /**
   * 清空并重建缩略图状态表
   * 
   * 删除现有的缩略图状态记录，然后重新扫描所有媒体文件
   * 检查对应的缩略图文件是否存在，并更新状态表
   * 
   * @param {Array} mediaFiles - 媒体文件列表
   * @returns {Object} 同步结果统计
   */
  async clearAndRebuildThumbStatus(mediaFiles) {
    // 使用Repository清空现有的缩略图状态表
    const ThumbStatusRepository = require('../../repositories/thumbStatus.repo');
    const thumbStatusRepo = new ThumbStatusRepository();
    
    await this.db.dbRun('main', 'DELETE FROM thumb_status');
    let syncedCount = 0;
    let existsCount = 0;
    let missingCount = 0;

    // 遍历所有媒体文件，检查缩略图状态
    for (const file of mediaFiles) {
      try {
        const result = await this.processFileForSync(file);
        syncedCount++;
        if (result.status === 'exists') {
          existsCount++;
        } else {
          missingCount++;
        }
      } catch (error) {
        logger.debug(`处理文件失败 ${file.path}: ${error.message}`);
      }
    }

    return { syncedCount, existsCount, missingCount };
  }

  /**
   * 重新同步缩略图状态
   * 
   * 从数据库获取所有媒体文件，然后重新检查缩略图状态
   * 用于修复缩略图状态不一致的问题
   * 
   * @returns {number} 同步的文件数量
   */
  async resyncThumbnailStatus(options = {}) {
    const {
      trigger = 'unknown',
      waitForCompletion = true,
      skipIfRunning = false
    } = options;

    return this._scheduleThumbnailTask({
      trigger,
      waitForCompletion,
      skipIfRunning
    }, () => this._executeThumbnailResync(trigger));
  }

  async _executeThumbnailResync(trigger) {
    logger.info(`[ThumbnailSync] 开始重同步（触发源：${trigger}）`);
    const MAX_BUSY_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_BUSY_RETRIES; attempt += 1) {
      try {
        const mediaFiles = await this.db.dbAll('main', `
          SELECT path, type FROM items
          WHERE type IN ('photo', 'video')
        `);

        if (!mediaFiles || mediaFiles.length === 0) {
          logger.info('[ThumbnailSync] 未找到媒体文件，跳过重同步');
          return { syncedCount: 0, existsCount: 0, missingCount: 0 };
        }

        const { syncedCount, existsCount, missingCount } = await this.clearAndRebuildThumbStatus(mediaFiles);
        logger.info(`[ThumbnailSync] 重同步完成（触发源：${trigger}）: 总计=${syncedCount}, 存在=${existsCount}, 缺失=${missingCount}`);

        await this.cleanupThumbnailCache();
        return { syncedCount, existsCount, missingCount };
      } catch (error) {
        const isBusy = /SQLITE_BUSY/.test(error?.message || '') || error?.code === 'SQLITE_BUSY';
        if (isBusy && attempt < MAX_BUSY_RETRIES - 1) {
          const delayMs = 200 * (attempt + 1);
          logger.warn(`[ThumbnailSync] 数据库忙（触发源：${trigger}），将在 ${delayMs}ms 后重试 (${attempt + 1}/${MAX_BUSY_RETRIES})`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        logger.error(`[ThumbnailSync] 重同步失败（触发源：${trigger}）:`, error);
        throw error;
      }
    }
  }

  async updateThumbnailStatusIncremental(changeSet = {}) {
    const {
      addedPhotos = [],
      addedVideos = [],
      removed = [],
      trigger = 'incremental',
      waitForCompletion = true,
      skipIfRunning = false
    } = changeSet;

    return this._scheduleThumbnailTask({
      trigger,
      waitForCompletion,
      skipIfRunning
    }, () => this._executeIncrementalUpdate({ addedPhotos, addedVideos, removed, trigger }));
  }

  async _executeIncrementalUpdate({ addedPhotos = [], addedVideos = [], removed = [], trigger }) {
    logger.info(`[ThumbnailSync] 执行增量更新（触发源：${trigger}）：新增=${addedPhotos.length + addedVideos.length}，删除=${removed.length}`);

    const ThumbStatusRepository = require('../../repositories/thumbStatus.repo');
    const repo = new ThumbStatusRepository();

    const removalList = Array.from(new Set((removed || []).map((p) => String(p || '').trim()).filter(Boolean)));
    if (removalList.length > 0) {
      try {
        await repo.deleteBatch(removalList, false);
        logger.debug(`[ThumbnailSync] 已删除 ${removalList.length} 个缩略图状态（触发源：${trigger}）`);
      } catch (error) {
        logger.warn(`[ThumbnailSync] 删除缩略图状态失败（触发源：${trigger}）:`, error && error.message ? error.message : error);
      }
    }

    const files = [];
    const dedupe = new Set();
    const appendFile = (relPath, type) => {
      if (!relPath) return;
      const normalized = String(relPath).trim();
      if (!normalized || dedupe.has(normalized)) {
        return;
      }
      dedupe.add(normalized);
      files.push({ path: normalized, type });
    };

    (addedPhotos || []).forEach((rel) => appendFile(rel, 'photo'));
    (addedVideos || []).forEach((rel) => appendFile(rel, 'video'));

    if (files.length === 0) {
      return { updated: 0, deleted: removed.length };
    }

    const CHUNK_SIZE = 200;
    let updated = 0;
    for (let i = 0; i < files.length; i += CHUNK_SIZE) {
      const slice = files.slice(i, i + CHUNK_SIZE);
      for (const file of slice) {
        try {
          await this.processFileForSync(file);
          updated += 1;
        } catch (error) {
          logger.debug(`[ThumbnailSync] 增量更新失败 (path=${file.path})：`, error && error.message ? error.message : error);
        }
      }
    }

    logger.info(`[ThumbnailSync] 增量更新完成（触发源：${trigger}）: 更新=${updated}, 删除=${removalList.length}`);
    return { updated, deleted: removalList.length };
  }

  _scheduleThumbnailTask(options, taskFactory) {
    const { trigger = 'unknown', waitForCompletion = true, skipIfRunning = false } = options || {};

    const inProgress = this._resyncActive || this._resyncPending > 0;
    if (skipIfRunning && inProgress) {
      logger.info(`[ThumbnailSync] 当前已有任务运行中（触发源：${this._currentTrigger || '未知'}），跳过来自 ${trigger} 的请求`);
      return {
        inProgress: true,
        skipped: true,
        trigger: this._currentTrigger
      };
    }

    if (inProgress && !skipIfRunning) {
      logger.debug(`[ThumbnailSync] 将任务排队执行（当前运行：${this._currentTrigger || '无'}，新触发源：${trigger}）`);
    }

    this._resyncPending += 1;

    const scheduledRun = this._resyncQueue.then(async () => {
      this._resyncActive = true;
      this._currentTrigger = trigger;
      this._resyncStartedAt = Date.now();
      try {
        return await taskFactory();
      } finally {
        this._resyncActive = false;
        this._currentTrigger = null;
        this._resyncStartedAt = null;
      }
    });

    this._resyncQueue = scheduledRun.then(() => undefined, () => undefined);

    const finalize = () => {
      this._resyncPending = Math.max(0, this._resyncPending - 1);
    };
    scheduledRun.finally(finalize);

    if (!waitForCompletion) {
      scheduledRun.catch((error) => {
        logger.error(`[ThumbnailSync] 异步任务失败（触发源：${trigger}）:`, error);
      });
      return { started: true, trigger, promise: scheduledRun };
    }

    return scheduledRun;
  }

  getResyncState() {
    return {
      running: this._resyncActive,
      pending: this._resyncPending,
      trigger: this._currentTrigger,
      startedAt: this._resyncStartedAt
    };
  }

  /**
   * 处理单个文件的缩略图同步
   * 
   * 检查指定文件的缩略图是否存在，并更新状态表
   * 
   * @param {Object} file - 文件对象，包含path和type属性
   * @returns {Object} 处理结果，包含状态信息
   */
  async processFileForSync(file) {
    // 根据文件类型确定缩略图扩展名
    const thumbExt = file.type === 'video' ? '.jpg' : '.webp';
    const thumbPath = file.path.replace(/\.[^.]+$/, thumbExt);
    const thumbFullPath = this.path.join(this.config.THUMBS_DIR, thumbPath);

    // 检查缩略图文件是否存在
    let status = 'missing';
    try {
      await this.fs.access(thumbFullPath);
      status = 'exists';
    } catch (accessErr) {
      logger.silly(`[ThumbnailSync] 检查缩略图 ${thumbPath} 失败，标记为缺失: ${accessErr && accessErr.message}`);
    }

    // 更新缩略图状态表
    await this.db.dbRun('main', `
      INSERT INTO thumb_status (path, mtime, status, last_checked)
      VALUES (?, 0, ?, strftime('%s','now')*1000)
      ON CONFLICT(path) DO UPDATE SET
        mtime = excluded.mtime,
        status = excluded.status,
        last_checked = excluded.last_checked
    `, [file.path, status]);

    return { status };
  }

  /**
   * 获取缩略图状态统计信息
   * 
   * 返回缩略图状态的详细统计，包括总数、各状态分布等
   * 
   * @returns {Object} 缩略图状态统计信息
   */
  async getThumbnailStatus() {
    try {
      // 获取媒体文件统计
      const mediaStats = await getMediaStats(['photo', 'video']);
      const sourceCount = mediaStats.photo + mediaStats.video;
      
      // 获取缩略图状态统计
      const stats = await getGroupStats('thumb_status', 'status');
      const thumbStatusCount = await getCount('thumb_status');

      // 如果没有缩略图状态记录但有源文件，需要重新同步
      if (thumbStatusCount === 0 && sourceCount > 0) {
        return {
          total: 0,
          sourceTotal: sourceCount,
          stats: [{ status: 'unknown', count: sourceCount }],
          needsResync: true,
          lastSync: null
        };
      }

      return {
        total: thumbStatusCount,
        sourceTotal: sourceCount,
        stats: stats || [],
        lastSync: new Date().toISOString()
      };
    } catch (error) {
      logger.error('获取缩略图状态失败:', error);
      return {
        total: 0,
        sourceTotal: 0,
        stats: [],
        error: error.message,
        lastSync: new Date().toISOString()
      };
    }
  }

  /**
   * 清理缩略图缓存
   * 
   * 删除Redis中的缩略图状态缓存，确保下次查询获取最新数据
   */
  async cleanupThumbnailCache() {
    if (this.redis) {
      await safeRedisDel(this.redis, 'thumb_stats_cache', '缩略图状态缓存清理');
      logger.debug('已清理缩略图状态缓存');
    }
  }
}

// 创建缩略图同步服务实例
const thumbnailSyncService = new ThumbnailSyncService();

/**
 * 获取索引状态信息
 * 
 * 返回文件索引处理的详细状态，包括：
 * - 索引处理状态
 * - 已处理文件数量
 * - 总文件数量
 * - 各类型文件统计
 * - 全文搜索索引数量
 * 
 * @returns {Object} 索引状态信息
 */
async function getIndexStatus() {
  try {
    // 获取索引状态行数据
    const row = await idxRepo.getIndexStatusRow();
    
    // 获取各类型文件统计（带缓存，使用索引优化）
    const itemsStats = await dbAllWithCache('main', "SELECT type, COUNT(1) as count FROM items INDEXED BY idx_items_type_id GROUP BY type", [], {
      useCache: true,
      ttl: 30,
      tags: ['items-stats']
    });
    
    // 获取全文搜索索引统计（带缓存）
    const ftsStats = await dbAllWithCache('main', "SELECT COUNT(1) as count FROM items_fts", [], {
      useCache: true,
      ttl: 30,
      tags: ['fts-stats']
    });
    
    const currentTime = new Date().toISOString();

    return {
      status: row?.status || 'unknown',
      processedFiles: row?.processed_files || 0,
      totalFiles: row?.total_files || 0,
      lastUpdated: currentTime,
      itemsStats: itemsStats || [],
      ftsCount: ftsStats?.[0]?.count || 0
    };
  } catch (error) {
    logger.warn('获取索引状态失败:', error);
    return {
      status: 'error',
      error: error.message,
      processedFiles: 0,
      totalFiles: 0,
      itemsStats: [],
      ftsCount: 0,
      lastUpdated: new Date().toISOString()
    };
  }
}

/**
 * 获取HLS文件统计信息
 * 
 * 统计视频文件的HLS转换状态，包括：
 * - 总视频数量
 * - 已处理数量（有master.m3u8文件）
 * - 失败数量（Redis中记录）
 * - 跳过数量（路径不安全等）
 * 
 * @returns {Object} HLS文件统计信息
 */
async function getHlsFileStats() {
  try {
    // 使用Repository获取所有视频文件
    const ItemsRepository = require('../../repositories/items.repo');
    const itemsRepo = new ItemsRepository();
    const videos = await itemsRepo.getVideos();
    const totalVideos = videos.length;
    const toCheck = videos.map((v) => v.path);
    let processed = 0;
    let skip = 0;

    // 检查每个视频的HLS文件是否存在
    for (const videoPath of toCheck) {
      const sanitized = sanitizePath(videoPath || '');
      if (!sanitized || !isPathSafe(sanitized)) {
        skip++;
        continue;
      }
      
      // 检查master.m3u8文件是否存在
      const master = path.join(THUMBS_DIR, 'hls', sanitized, 'master.m3u8');
      try {
        await fs.access(master);
        processed++;
      } catch (hlsAccessErr) {
        logger.silly(`[Maintenance] 无法访问 HLS master (${master})，标记为未处理: ${hlsAccessErr && hlsAccessErr.message}`);
      }
    }

    // 从Redis获取失败记录数量
    let failed = 0;
    try {
      if (redis) {
        const keys = await redis.keys('video_failed_permanently:*');
        failed = keys.length;
      }
    } catch (redisErr) {
      logger.debug('[Maintenance] 统计 HLS 失败记录时读取 Redis 失败（忽略）:', redisErr && redisErr.message);
    }

    const skipped = Math.max(0, totalVideos - processed - failed);
    return {
      total: totalVideos,
      processed,
      failed,
      skipped,
      totalProcessed: processed + failed + skipped
    };
  } catch (error) {
    return { total: 0, processed: 0, failed: 0, skipped: 0, totalProcessed: 0 };
  }
}

/**
 * 获取HLS状态信息
 * 
 * 基于HLS文件统计信息，计算并返回HLS处理的整体状态
 * 
 * @returns {Object} HLS状态信息，包含状态和详细统计
 */
async function getHlsStatus() {
  try {
    const hlsStats = await getHlsFileStats();
    const totalVideos = hlsStats.total || 0;
    const processedVideos = hlsStats.processed || 0;
    const failedVideos = hlsStats.failed || 0;
    const skippedVideos = hlsStats.skipped || 0;
    const totalProcessed = hlsStats.totalProcessed || 0;

    // 根据处理情况确定状态
    let status = 'unknown';
    if (totalVideos === 0) {
      status = 'no-videos';
    } else if (totalProcessed === 0) {
      status = 'pending';
    } else if (totalProcessed < totalVideos) {
      status = 'processing';
    } else if (totalProcessed === totalVideos) {
      status = 'complete';
    }

    return {
      status,
      totalVideos,
      hlsFiles: hlsStats.total,
      processedVideos,
      failedVideos,
      skippedVideos,
      totalProcessed,
      lastSync: new Date().toISOString()
    };
  } catch (error) {
    logger.warn('获取HLS状态失败:', error);
    return {
      status: 'error',
      totalVideos: 0,
      hlsFiles: 0,
      processedVideos: 0,
      failedVideos: 0,
      skippedVideos: 0,
      totalProcessed: 0,
      error: error.message
    };
  }
}

async function performThumbnailReconcile() {
  try {
    const ThumbStatusRepository = require('../../repositories/thumbStatus.repo');
    const thumbStatusRepo = new ThumbStatusRepository();
    
    const missingFiles = await thumbStatusRepo.getByStatus('missing', 1000);

    if (!missingFiles || missingFiles.length === 0) {
      logger.debug('缩略图补全检查完成：没有发现需要补全的缩略图');
      return;
    }

    let changed = 0;
    let skipped = 0;

    for (const row of missingFiles) {
      try {
        const sanitizedPath = sanitizePath(row.path || '');
        if (!sanitizedPath || !isPathSafe(sanitizedPath)) {
          skipped++;
          continue;
        }

        const sourceAbsPath = path.resolve(PHOTOS_DIR, sanitizedPath);
        await fs.access(sourceAbsPath);

        await runAsync('main', `
          UPDATE thumb_status
          SET status = 'pending', last_checked = strftime('%s','now')*1000
          WHERE path = ?
        `, [sanitizedPath]);
        changed++;
      } catch (resyncErr) {
        skipped++;
        logger.debug(`[Maintenance] 缩略图补全标记失败，已跳过: ${sanitizedPath || row.path} -> ${resyncErr && resyncErr.message}`);
      }
    }

    logger.debug(`缩略图补全检查完成：发现 ${changed} 个文件需要补全缩略图，跳过 ${skipped} 个无效或缺失的记录`);

    try {
      const { batchGenerateMissingThumbnails } = require('../thumbnail.service');
      const result = await batchGenerateMissingThumbnails(1000);
      logger.debug(`[缩略图补全派发] 已启动: queued=${result.queued}, skipped=${result.skipped}, processed=${result.processed}`);
    } catch (dispatchErr) {
      logger.warn(`[缩略图补全派发] 启动失败（不影响状态更新）：${dispatchErr && dispatchErr.message}`);
    }
  } catch (error) {
    logger.error('缩略图补全检查失败:', error);
    throw error;
  }
}

async function performHlsReconcileOnce(limit = 1000) {
  try {
    const ItemsRepository = require('../../repositories/items.repo');
    const itemsRepo = new ItemsRepository();
    const videos = await itemsRepo.getVideos(limit);
    if (!videos || videos.length === 0) {
      logger.debug('HLS补全检查：没有发现需要处理的视频文件');
      return { total: 0, success: 0, failed: 0, skipped: 0 };
    }

    const toProcess = [];
    let skip = 0;

    for (const v of videos) {
      try {
        const sanitizedRelative = sanitizePath(v.path || '');
        if (!sanitizedRelative || !isPathSafe(sanitizedRelative)) {
          skip++;
          continue;
        }

        const master = path.join(THUMBS_DIR, 'hls', sanitizedRelative, 'master.m3u8');
        try {
          await fs.access(master);
          skip++;
          continue;
        } catch (missingHlsErr) {
          logger.silly(`[Maintenance] 视频 ${sanitizedRelative} 缺少 HLS master（继续补全）: ${missingHlsErr && missingHlsErr.message}`);
        }

        const sourceAbsPath = path.resolve(PHOTOS_DIR, sanitizedRelative);
        await fs.access(sourceAbsPath);
        toProcess.push({ absolute: sourceAbsPath, relative: sanitizedRelative });
      } catch (e) {
        logger.debug(`HLS补全检查视频失败: ${v.path}, ${e.message}`);
      }
    }

    const absoluteList = toProcess.map((item) => item.absolute);
    let batch = { total: absoluteList.length, success: 0, failed: 0, skipped: skip };
    try {
      if (absoluteList.length > 0) {
        batch = await runHlsBatch(absoluteList, { timeoutMs: process.env.HLS_BATCH_TIMEOUT_MS });
      }
    } catch (e) {
      logger.warn('HLS一次性批处理执行失败（忽略其余流程）:', e && e.message);
    }

    return {
      total: batch.total ?? absoluteList.length,
      success: batch.success || 0,
      failed: batch.failed || 0,
      skipped: (batch.skipped || 0) + skip
    };
  } catch (error) {
    logger.error('HLS补全检查失败:', error);
    throw error;
  }
}

async function performThumbnailCleanup() {
  try {
    const ThumbStatusRepository = require('../../repositories/thumbStatus.repo');
    const ItemsRepository = require('../../repositories/items.repo');
    const thumbStatusRepo = new ThumbStatusRepository();
    const itemsRepo = new ItemsRepository();

    const allThumbs = await thumbStatusRepo.getAll(['path', 'status']);
    const result = {
      thumbFilesRemoved: 0,
      permanentSourcesRemoved: 0,
      dbRecordsRemoved: 0,
      errors: 0
    };

    for (const thumb of allThumbs) {
      if (!thumb?.path) continue;

      const sanitizedPath = sanitizePath(thumb.path);
      if (!sanitizedPath || !isPathSafe(sanitizedPath)) {
        logger.warn(`[ThumbnailCleanup] 跳过可疑路径: ${thumb.path}`);
        continue;
      }

      const sourceAbsPath = path.join(PHOTOS_DIR, sanitizedPath);
      const isVideo = /\.(mp4|webm|mov)$/i.test(sanitizedPath);
      const thumbExt = isVideo ? '.jpg' : '.webp';
      const thumbRelPath = sanitizedPath.replace(/\.[^.]+$/, thumbExt);
      const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);

      let sourceExists = false;
      try {
        await fs.access(sourceAbsPath);
        sourceExists = true;
      } catch (sourceErr) {
        if (sourceErr.code !== 'ENOENT') {
          logger.warn(`[ThumbnailCleanup] 检测源文件失败: ${sourceAbsPath}`, sourceErr);
        }
      }

      const shouldRemoveSource = thumb.status === 'permanent_failed';
      const isOrphanThumb = !sourceExists;

      if (!shouldRemoveSource && !isOrphanThumb) {
        continue;
      }

      try {
        const removed = await itemsRepo.deleteWithRelations(sanitizedPath);
        if (removed) {
          result.dbRecordsRemoved += 1;
        } else {
          await runAsync('main', 'DELETE FROM thumb_status WHERE path=?', [sanitizedPath]);
        }

        if (redis) {
          const redisKey = `thumb_failed_permanently:${sanitizedPath}`;
          await safeRedisDel(redis, redisKey, '清理永久失败缩略图标记');
        }

        if (shouldRemoveSource && sourceExists) {
          try {
            await fs.unlink(sourceAbsPath);
            logger.info(`[ThumbnailCleanup] 删除永久失败源文件: ${sourceAbsPath}`);
            result.permanentSourcesRemoved += 1;
          } catch (unlinkErr) {
            if (unlinkErr.code !== 'ENOENT') {
              logger.warn(`[ThumbnailCleanup] 删除源文件失败: ${sourceAbsPath}`, unlinkErr);
            }
          }
        }

        try {
          await fs.unlink(thumbAbsPath);
          logger.info(`[ThumbnailCleanup] 删除缩略图文件: ${thumbAbsPath}`);
          result.thumbFilesRemoved += 1;
        } catch (thumbErr) {
          if (thumbErr.code !== 'ENOENT') {
            logger.warn(`[ThumbnailCleanup] 删除缩略图文件失败: ${thumbAbsPath}`, thumbErr);
          }
        }
      } catch (cleanupErr) {
        logger.warn(`[ThumbnailCleanup] 处理路径失败: ${sanitizedPath}`, cleanupErr);
        result.errors += 1;
      }
    }

    logger.info(`缩略图清理完成：移除缩略图 ${result.thumbFilesRemoved} 个，永久失败源文件 ${result.permanentSourcesRemoved} 个，数据库清理 ${result.dbRecordsRemoved} 条`);
    return result;
  } catch (error) {
    logger.error('缩略图清理失败:', error);
    throw error;
  }
}

async function performHlsCleanup() {
  try {
    const ItemsRepository = require('../../repositories/items.repo');
    const itemsRepo = new ItemsRepository();
    const allVideos = await itemsRepo.getVideos();
    const sourceVideoPaths = new Set(allVideos.map((v) => v.path));
    const hlsDir = path.join(THUMBS_DIR, 'hls');
    let deletedCount = 0;
    let errorCount = 0;

    async function scanAndDelete(dir, relativePath = '') {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const currentRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;

          if (entry.isDirectory()) {
            await scanAndDelete(fullPath, currentRelativePath);
            try {
              const remaining = await fs.readdir(fullPath);
              if (remaining.length === 0) {
                await fs.rmdir(fullPath);
                logger.info(`删除空的HLS目录: ${fullPath}`);
              }
            } catch (cleanupErr) {
              logger.debug(`[Maintenance] 删除空 HLS 目录失败（忽略）: ${fullPath} -> ${cleanupErr && cleanupErr.message}`);
            }
          } else if (entry.name === 'master.m3u8') {
            const videoExists = sourceVideoPaths.has(relativePath);
            if (!videoExists) {
              const dirToDelete = path.dirname(fullPath);
              logger.warn(`准备删除HLS目录，因为找不到对应的源视频。HLS路径: ${relativePath}`);
              try {
                await fs.rm(dirToDelete, { recursive: true, force: true });
                deletedCount++;
                logger.info(`删除冗余HLS目录: ${dirToDelete}`);
              } catch (deleteError) {
                logger.warn(`删除HLS目录失败: ${dirToDelete}`, deleteError);
                errorCount++;
              }
            }
          }
        }
      } catch (error) {
        logger.warn(`扫描HLS目录失败: ${dir}`, error);
        errorCount++;
      }
    }

    try {
      await fs.access(hlsDir);
      await scanAndDelete(hlsDir);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('访问HLS目录失败:', error);
      }
    }

    logger.info(`HLS清理完成：删除 ${deletedCount} 个冗余HLS目录，${errorCount} 个处理出错`);
    return { deleted: deletedCount, errors: errorCount };
  } catch (error) {
    logger.error('HLS清理失败:', error);
    throw error;
  }
}

async function checkSyncStatus(type) {
  try {
    if (type === 'thumbnail') {
      const ThumbStatusRepository = require('../../repositories/thumbStatus.repo');
      const thumbStatusRepo = new ThumbStatusRepository();

      const allThumbs = await thumbStatusRepo.getAll(['path', 'status']);
      let redundantCount = 0;
      let permanentFailedCount = 0;

      for (const thumb of allThumbs) {
        try {
          if (thumb.status === 'permanent_failed') {
            permanentFailedCount++;
          }

          const sourcePath = path.join(PHOTOS_DIR, thumb.path);
          const sourceExists = await fs.access(sourcePath).then(() => true).catch(() => false);
          if (!sourceExists) {
            redundantCount++;
          }
        } catch (scanErr) {
          logger.debug(`[Maintenance] 检查缩略图状态失败（忽略）: ${thumb.path} -> ${scanErr && scanErr.message}`);
        }
      }

      const total = allThumbs.length;
      const synced = total - redundantCount - permanentFailedCount;
      return {
        total,
        synced: Math.max(0, synced),
        redundant: redundantCount,
        permanentFailed: permanentFailedCount,
        isSynced: redundantCount === 0 && permanentFailedCount === 0
      };
    }

    if (type === 'hls') {
      const ItemsRepository = require('../../repositories/items.repo');
      const itemsRepo = new ItemsRepository();
      const allVideos = await itemsRepo.getVideos();
      const sourceVideoPaths = new Set(allVideos.map((v) => v.path));
      const hlsDir = path.join(THUMBS_DIR, 'hls');
      let totalDirs = 0;
      let redundantDirs = 0;

      async function scan(dir, relativePath = '') {
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const currentRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;

            if (entry.isDirectory()) {
              totalDirs++;
              const videoExists = sourceVideoPaths.has(currentRelativePath);
              if (!videoExists) {
                redundantDirs++;
              } else {
                await scan(fullPath, currentRelativePath);
              }
            }
          }
        } catch (scanErr) {
          logger.debug(`[Maintenance] 扫描 HLS 目录失败（忽略）: ${dir} -> ${scanErr && scanErr.message}`);
        }
      }

      await scan(hlsDir);
      const synced = totalDirs - redundantDirs;
      return { total: totalDirs, synced, redundant: redundantDirs, isSynced: redundantDirs === 0 };
    }

    return { total: 0, synced: 0, redundant: 0, isSynced: true };
  } catch (error) {
    logger.warn(`检查${type}同步状态失败:`, error);
    return { total: 0, synced: 0, redundant: 0, isSynced: false, error: error.message };
  }
}

/**
 * 获取类型显示名称
 * 
 * 将英文类型名称转换为中文显示名称
 * 
 * @param {string} type - 类型名称
 * @returns {string} 中文显示名称
 */
function getTypeDisplayName(type) {
  const names = {
    index: '索引',
    thumbnail: '缩略图',
    hls: 'HLS',
    all: '全部'
  };
  return names[type] || type;
}

/**
 * 触发补全操作
 * 
 * 根据指定类型触发相应的补全任务：
 * - index: 重建文件索引
 * - thumbnail: 补全缺失的缩略图
 * - hls: 补全缺失的HLS文件
 * - all: 执行所有补全任务
 * 
 * @param {string} type - 补全类型
 * @returns {Object} 补全操作结果
 */
async function triggerSyncOperation(type) {
  const { getIndexingWorker } = require('../worker.manager');

  switch (type) {
    case 'index': {
      // 发送消息给索引工作线程重建索引
      const message = TraceManager.injectToWorkerMessage({ type: 'rebuild_index', payload: { photosDir: PHOTOS_DIR, syncThumbnails: true } });
      getIndexingWorker().postMessage(message);
      return { message: '已启动索引补全任务' };
    }
    case 'thumbnail':
      // 执行缩略图补全
      await performThumbnailReconcile();
      return { message: '已启动缩略图补全任务' };
    case 'hls': {
      // 执行HLS补全
      const batch = await performHlsReconcileOnce();
      return { message: `HLS补全完成：total=${batch.total}, success=${batch.success}, failed=${batch.failed}, skipped=${batch.skipped}`, result: batch };
    }
    case 'all': {
      // 执行所有补全任务
      const message = TraceManager.injectToWorkerMessage({ type: 'rebuild_index', payload: { photosDir: PHOTOS_DIR, syncThumbnails: true } });
      getIndexingWorker().postMessage(message);
      await performThumbnailReconcile();
      const batchAll = await performHlsReconcileOnce();
      return {
        message: `已完成HLS补全：total=${batchAll.total}, success=${batchAll.success}, failed=${batchAll.failed}, skipped=${batchAll.skipped}`,
        result: { hls: batchAll }
      };
    }
    default: {
      const { ValidationError } = require('../../utils/errors');
      throw new ValidationError('未知的补全类型', { type, validTypes: ['indexing', 'hls', 'thumbnails'] });
    }
  }
}

/**
 * 触发清理操作
 * 
 * 根据指定类型触发相应的清理任务：
 * - thumbnail: 清理冗余的缩略图文件
 * - hls: 清理冗余的HLS文件
 * - all: 执行所有清理任务
 * 
 * 清理任务会删除源文件已不存在的缩略图和HLS文件
 * 
 * @param {string} type - 清理类型
 * @returns {Object} 清理操作结果
 */
async function triggerCleanupOperation(type) {
  // 检查当前同步状态
  const syncStatus = await checkSyncStatus(type);
  if (syncStatus.isSynced) {
    const { redundant = 0, permanentFailed = 0 } = syncStatus;
    return {
      message: `${getTypeDisplayName(type)}已经处于同步状态，无需清理（孤立缩略图 ${redundant} 个，永久失败 ${permanentFailed || 0} 个）`,
      status: syncStatus,
      skipped: true
    };
  }

  switch (type) {
    case 'thumbnail': {
      // 执行缩略图清理
      const thumbResult = await performThumbnailCleanup();
      const updatedStatus = await checkSyncStatus('thumbnail');
      return {
        message: `缩略图清理完成：移除缩略图 ${thumbResult.thumbFilesRemoved} 个，永久失败源文件 ${thumbResult.permanentSourcesRemoved} 个`,
        status: updatedStatus,
        result: thumbResult
      };
    }
    case 'hls': {
      // 执行HLS清理
      const hlsResult = await performHlsCleanup();
      return {
        message: `HLS同步完成：删除 ${hlsResult.deleted} 个冗余目录`,
        status: syncStatus,
        result: hlsResult
      };
    }
    case 'all': {
      // 执行所有清理任务
      const thumbResultAll = await performThumbnailCleanup();
      const hlsResultAll = await performHlsCleanup();
      return {
        message: `全量清理完成：缩略图移除 ${thumbResultAll.thumbFilesRemoved} 个，永久失败源 ${thumbResultAll.permanentSourcesRemoved} 个，HLS删除 ${hlsResultAll.deleted} 个`,
        status: {
          thumbnail: await checkSyncStatus('thumbnail'),
          hls: await checkSyncStatus('hls')
        },
        result: { thumbnail: thumbResultAll, hls: hlsResultAll }
      };
    }
    default: {
      const { ValidationError } = require('../../utils/errors');
      throw new ValidationError('未知的同步类型', { type, validTypes: ['full', 'partial'] });
    }
  }
}

/**
 * 模块导出
 * 
 * 导出所有公共函数和服务实例，供其他模块使用
 */
module.exports = {
  thumbnailSyncService,        // 缩略图同步服务实例
  getIndexStatus,             // 获取索引状态
  getHlsStatus,               // 获取HLS状态
  performThumbnailReconcile,  // 执行缩略图补全
  performHlsReconcileOnce,    // 执行HLS补全
  performThumbnailCleanup,    // 执行缩略图清理
  performHlsCleanup,          // 执行HLS清理
  checkSyncStatus,            // 检查同步状态
  triggerSyncOperation,       // 触发补全操作
  triggerCleanupOperation,    // 触发清理操作
  getTypeDisplayName,         // 获取类型显示名称
  getHlsFileStats             // 获取HLS文件统计
};
