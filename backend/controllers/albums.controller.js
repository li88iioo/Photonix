const path = require('path');
const fsNative = require('fs');
const { promises: fs } = fsNative;
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const settingsService = require('../services/settings.service');
const albumManagementService = require('../services/albumManagement.service');
const { enqueueManualChanges, processManualChanges } = require('../services/indexer.service');
const { invalidateCoverCache, findCoverPhotosBatch } = require('../services/file.service');
const { invalidateTags } = require('../services/cache.service');
const { redis } = require('../config/redis');
const AlbumCoversRepository = require('../repositories/albumCovers.repo');
const { PHOTOS_DIR, THUMBS_DIR } = require('../config');
const { dbAll, dbGet } = require('../db/multi-db');
const { safeRedisSet } = require('../utils/helpers');

const COVER_CACHE_TTL = Number(process.env.FILE_CACHE_DURATION || 604800); // 与 file.service 中缓存策略保持一致

/**
 * @function deleteAlbum
 * @description
 * 删除相册接口，支持级联数据库和缩略图清理、缓存失效及索引任务同步。
 *
 * 1. 检查相册删除功能是否开启
 * 2. 规范并校验路径，禁止根相册删除
 * 3. 验证相册目录有效性
 * 4. 查询数据库内相关条目
 * 5. 删除目标相册物理目录
 * 6. 删除主缩略图及 HLS 缩略图目录（忽略失败）
 * 7. 提交索引器队列任务，若队列不可用则同步处理
 * 8. 使封面缓存失效（忽略失败）
 * 9. 触发相关路由缓存标签失效（忽略失败）
 * 10. 日志记录与返回响应
 *
 * @param {Request} req - Express请求对象
 * @param {Response} res - Express响应对象
 */
exports.deleteAlbum = async (req, res) => {
  try {
    // 1. 检查相册删除功能是否启用
    const allSettings = await settingsService.getAllSettings({ preferFreshSensitive: true });
    if (allSettings.ALBUM_DELETE_ENABLED !== 'true') {
      return res.status(403).json({ success: false, error: '相册删除已禁用' });
    }

    // 2. 规范化并校验路径，禁止删除根相册
    const sanitizedPath = normalizeRelative(req.sanitizedPath || '');
    if (!sanitizedPath) {
      return res.status(400).json({ success: false, error: '无法删除根相册' });
    }

    // 3. 检查相册目录是否存在且为目录
    const albumAbsPath = path.join(PHOTOS_DIR, sanitizedPath);
    let stats;
    try {
      stats = await fs.lstat(albumAbsPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return res.status(404).json({ success: false, error: '相册不存在' });
      }
      throw error;
    }

    if (!stats.isDirectory()) {
      return res.status(400).json({ success: false, error: '目标不是有效的相册目录' });
    }

    // 4. 查询数据库中该目录下的所有 items 条目
    const relatedItems = await dbAll(
      'main',
      "SELECT path, type FROM items WHERE path = ? OR path LIKE ?",
      [sanitizedPath, `${sanitizedPath}/%`]
    );
    const { changes, removed } = albumManagementService.buildDeletionChanges(sanitizedPath, relatedItems);

    // 5. 物理删除相册目录
    try {
      await fs.rm(albumAbsPath, { recursive: true, force: true });
    } catch (removeError) {
      if (removeError?.code === 'EACCES' || removeError?.code === 'EPERM') {
        logger.warn(`[Album] 无法删除目录，权限不足: ${albumAbsPath}`);
        return res.status(403).json({
          success: false,
          error: '没有权限删除相册目录，请检查挂载目录的写入权限',
          code: 'FS_PERMISSION_DENIED'
        });
      }
      throw removeError;
    }

    // 6. 删除缩略图目录（主缩略图与 HLS 缩略图，失败忽略）
    await fs.rm(path.join(THUMBS_DIR, sanitizedPath), { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join(THUMBS_DIR, 'hls', sanitizedPath), { recursive: true, force: true }).catch(() => {});

    // 6.1 立即清理该目录及子目录的封面记录，避免 album_covers 残留指向已删文件
    try {
      const albumCoversRepo = new AlbumCoversRepository();
      const affectedAlbumPaths = await albumCoversRepo.getAlbumPathsByCoverPrefix(sanitizedPath);
      if (affectedAlbumPaths.length > 0) {
        // 主动清理引用被删除目录内文件的封面记录，避免父目录首刷触发自愈慢路径
        await albumCoversRepo.deleteByCoverPrefix(sanitizedPath);
        const invalidateTargets = new Set();
        for (const rel of affectedAlbumPaths) {
          const abs = path.join(PHOTOS_DIR, rel);
          invalidateTargets.add(abs);
        }
        // 同时包含当前删除目录自身（可能也是 affectedAlbumPaths 之一）
        invalidateTargets.add(albumAbsPath);
        for (const abs of invalidateTargets) {
          await invalidateCoverCache(abs).catch(() => {});
        }

        // 预热受影响相册封面，减少后续浏览首屏空白
        const warmupTargets = Array.from(invalidateTargets)
          .filter(abs => abs !== albumAbsPath); // 已删除目录无需预热
        if (warmupTargets.length > 0) {
          try {
            await findCoverPhotosBatch(warmupTargets);
          } catch (warmErr) {
            logger.debug('[Album] 删除后封面预热失败（忽略）:', warmErr && warmErr.message);
          }
        }

        // 预计算并持久化受影响相册的封面，避免后续首次浏览落入计算路径
        for (const rel of affectedAlbumPaths) {
          try {
            // 排除正在删除的目录，避免选到即将删除的封面文件
            const candidates = await dbAll(
              'main',
              `SELECT path, width, height, mtime
               FROM items i
               WHERE type IN ('photo','video')
                 AND (path = ? OR path LIKE ? || '/%')
                 AND path NOT LIKE ? || '/%'
                 AND path != ?
                 AND NOT EXISTS (
                   SELECT 1 FROM thumb_status ts
                   WHERE ts.path = i.path AND ts.status = 'permanent_failed'
                 )
               ORDER BY mtime DESC
               LIMIT 5`,
              [rel, rel, sanitizedPath, sanitizedPath]
            );

            let chosen = null;
            for (const row of candidates || []) {
              if (!row || !row.path) continue;
              const absCover = path.join(PHOTOS_DIR, row.path);
              const exists = await fs.access(absCover).then(() => true).catch(() => false);
              if (exists) {
                chosen = {
                  relCoverPath: row.path,
                  absCover,
                  width: row.width || 1,
                  height: row.height || 1,
                  mtime: row.mtime || Date.now()
                };
                break;
              }
            }

            if (chosen) {
              await albumCoversRepo.upsert(rel, chosen.relCoverPath, chosen.width, chosen.height, chosen.mtime);
              safeRedisSet(redis, `cover_info:/${rel}`, JSON.stringify({
                path: chosen.absCover,
                width: chosen.width,
                height: chosen.height,
                mtime: chosen.mtime
              }), 'EX', COVER_CACHE_TTL, '封面预热写入').catch(() => {});
            } else {
              // 无可用封面，清理 album_covers 与缓存，保持下一次计算自愈
              await albumCoversRepo.deleteByAlbumPath(rel);
              safeRedisSet(redis, `cover_info:/${rel}`, '', 'EX', 1, '封面清空占位').catch(() => {});
            }
          } catch (persistErr) {
            logger.debug('[Album] 预计算封面失败（忽略）:', persistErr && persistErr.message);
          }
        }
      }
      await albumCoversRepo.deleteByDirectory(sanitizedPath);
    } catch (coverDeleteError) {
      logger.debug('[Album] 清理 album_covers 记录失败（忽略）:', coverDeleteError && coverDeleteError.message);
    }

    // 7. 提交索引变化：队列成功则排队，失败或队列不可用则直接同步执行
    let indexingDispatch = { mode: 'none', queued: 0, processed: 0 };
    if (changes.length > 0) {
      try {
        const enqueueResult = await enqueueManualChanges(changes, { reason: `album-delete:${sanitizedPath}` });
        const queued = enqueueResult?.queued || 0;
        indexingDispatch = queued > 0
          ? { mode: 'queued', queued, processed: 0 }
          : { mode: 'none', queued: 0, processed: 0 };

        if (queued === 0) {
          // 若未入队，则直接同步处理
          const manualResult = await processManualChanges(changes);
          indexingDispatch = { mode: 'immediate', queued: 0, processed: manualResult.processed || 0 };
        }
      } catch (enqueueError) {
        logger.warn(`[Album] 排队索引变更失败，回退同步处理: ${enqueueError.message}`);
        const fallbackResult = await processManualChanges(changes);
        indexingDispatch = { mode: 'immediate', queued: 0, processed: fallbackResult.processed || 0 };
      }
    }

    // 8. 使相册封面缓存失效（失败忽略）
    try {
      await invalidateCoverCache(albumAbsPath);
    } catch (cacheError) {
      logger.debug('清理封面缓存失败（忽略）:', cacheError && cacheError.message);
    }

    // 9. 刷新相关路由缓存标签（失败忽略）
    try {
      const cacheTags = buildAlbumCacheTags(sanitizedPath);
      if (cacheTags.length > 0) {
        await invalidateTags(cacheTags);
      }
      await clearBrowseRouteCacheByPath(sanitizedPath);
    } catch (cacheInvalidateError) {
      logger.debug('删除相册后刷新路由缓存失败（忽略）:', cacheInvalidateError && cacheInvalidateError.message);
    }

    // 10. 记录日志并返回响应
    logger.info(`[Album] 已删除相册 ${sanitizedPath}`, { removed });

    res.json({
      success: true,
      message: '相册已删除',
      removed,
      path: sanitizedPath,
      timestamp: new Date().toISOString(),
      indexing: indexingDispatch
    });
  } catch (error) {
    logger.error('删除相册失败:', error);
    res.status(500).json({ success: false, error: '删除失败', message: error.message });
  }
};

/**
 * @function normalizeRelative
 * @description
 * 规范化相对路径，统一分隔符为 / ，去除首尾多余斜杠
 * @param {string} relPath - 原始路径
 * @returns {string} 处理后的相对路径
 */
function normalizeRelative(relPath) {
  return String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/$/, '');
}

/**
 * @function buildAlbumCacheTags
 * @description
 * 基于相对路径递归构建层级型相册缓存标签集
 * @param {string} relativePath - 相册相对路径
 * @returns {string[]} 标签数组
 */
function buildAlbumCacheTags(relativePath) {
  const tags = new Set(['album:/']);
  const segments = String(relativePath || '')
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return Array.from(tags);
  }

  let current = '';
  let encodedCurrent = '';
  for (const segment of segments) {
    current = `${current}/${segment}`;
    tags.add(`album:${current}`);
    const noLeadingSlash = current.replace(/^\/+/, '');
    if (noLeadingSlash) {
      tags.add(`album:${noLeadingSlash}`);
      tags.add(`album:${noLeadingSlash}/`);
    }
    const encodedSegment = encodeURIComponent(segment);
    encodedCurrent = `${encodedCurrent}/${encodedSegment}`;
    tags.add(`album:${encodedCurrent}`);
  }

  return Array.from(tags);
}

/**
 * 兜底清理 browse 路由缓存（避免标签不匹配时依赖 TTL）
 * @param {string} relativePath
 */
async function clearBrowseRouteCacheByPath(relativePath) {
  if (!redis || redis.isNoRedis) return;
  const encoded = encodeURIComponent(relativePath);
  const patterns = [
    'route_cache:*browse*' + encoded + '*',
    'route_cache:*browse*' + relativePath + '*'
  ];
  for (const pattern of patterns) {
    let cursor = '0';
    do {
      const res = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = res[0];
      const keys = res[1] || [];
      if (keys.length > 0) {
        try {
          const pipeline = redis.pipeline();
          pipeline.unlink(...keys);
          await pipeline.exec();
        } catch (e) {
          logger.debug(`[Album] 清理 browse 路由缓存失败（忽略）: ${e && e.message}`);
        }
      }
    } while (cursor !== '0');
  }
}
