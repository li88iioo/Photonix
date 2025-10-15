const path = require('path');
const fsNative = require('fs');
const { promises: fs } = fsNative;
const logger = require('../config/logger');
const settingsService = require('../services/settings.service');
const albumManagementService = require('../services/albumManagement.service');
const { enqueueManualChanges, processManualChanges } = require('../services/indexer.service');
const { invalidateCoverCache } = require('../services/file.service');
const { invalidateTags } = require('../services/cache.service');
const { PHOTOS_DIR, THUMBS_DIR } = require('../config');
const { dbAll } = require('../db/multi-db');

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
  for (const segment of segments) {
    current = `${current}/${segment}`;
    tags.add(`album:${current}`);
  }

  return Array.from(tags);
}
