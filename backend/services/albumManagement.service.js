const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { PHOTOS_DIR } = require('../config');
const { dbAll } = require('../db/multi-db');
const { processManualChanges } = require('./indexer.service');

// 媒体文件正则表达式（支持常见图片与视频格式）
const MEDIA_REGEX = /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i;
// 视频文件正则表达式（仅视频扩展名）
const VIDEO_REGEX = /\.(mp4|webm|mov)$/i;
// 应忽略的目录或文件名模式
const IGNORE_PATTERNS = [
  /(^|[\\/])@eaDir/, 
  /(^|[\\/])\.tmp/,
  /temp_opt_.*/,
  /.*\.tmp$/
];

/**
 * 规范化相对路径，统一为前后无“/”的形式，且路径分隔使用“/”
 * @param {string} relPath 
 * @returns {string}
 */
function normalizeRelative(relPath) {
  return String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/$/, '');
}

/**
 * 判断路径是否应被忽略
 * @param {string} anyPath 
 * @returns {boolean}
 */
function shouldIgnore(anyPath) {
  return IGNORE_PATTERNS.some((pattern) => pattern.test(anyPath));
}

/**
 * 检测文件为照片还是视频，非媒体类型则返回 null
 * @param {string} relativePath 
 * @returns {'photo'|'video'|null}
 */
function detectMediaKind(relativePath) {
  if (!MEDIA_REGEX.test(relativePath)) {
    return null;
  }
  return VIDEO_REGEX.test(relativePath) ? 'video' : 'photo';
}

/**
 * 遍历文件系统，收集所有相册（目录）和媒体（照片、视频）的规范化相对路径和类型
 * @returns {Promise<{albums:Set<string>, media:Map<string,'photo'|'video'>}>}
 */
async function collectFilesystemState() {
  const albums = new Set();
  const media = new Map();

  const root = path.resolve(PHOTOS_DIR);
  const stack = [{ abs: root, rel: '' }];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current.abs, { withFileTypes: true });
    } catch (error) {
      // 如果目录不存在则跳过
      if (error && error.code === 'ENOENT') {
        continue;
      }
      logger.debug(`[AlbumMgmt] 读取目录失败: ${current.abs}`, error && error.message);
      continue;
    }

    for (const entry of entries) {
      const nextRel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      const normalizedRel = normalizeRelative(nextRel);
      const absPath = path.join(current.abs, entry.name);

      if (shouldIgnore(normalizedRel) || shouldIgnore(absPath)) {
        continue;
      }

      // 跳过符号链接
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (normalizedRel) {
          albums.add(normalizedRel);
        }
        stack.push({ abs: absPath, rel: normalizedRel });
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const kind = detectMediaKind(normalizedRel);
      if (!kind) {
        continue;
      }
      media.set(normalizedRel, kind);
    }
  }

  return { albums, media };
}

/**
 * 查询数据库中的相册和媒体项
 * @returns {Promise<{albums:Set<string>, media:Map<string,'photo'|'video'>}>}
 */
async function collectDatabaseState() {
  const rows = await dbAll('main', "SELECT path, type FROM items WHERE type IN ('album','photo','video')");
  const albums = new Set();
  const media = new Map();

  for (const row of rows || []) {
    const normalized = normalizeRelative(row.path);
    if (!normalized) {
      continue;
    }
    if (row.type === 'album') {
      albums.add(normalized);
      continue;
    }
    if (row.type === 'photo' || row.type === 'video') {
      media.set(normalized, row.type);
    }
  }

  return { albums, media };
}

/**
 * 计算文件系统与数据库状态的差异
 * @param {*} fsState 
 * @param {*} dbState 
 * @returns {Object}
 */
function computeDiff(fsState, dbState) {
  const addedAlbums = [];
  const removedAlbums = [];
  const addedMedia = { photo: [], video: [] };
  const removedMedia = { photo: [], video: [] };

  // 新增相册
  for (const album of fsState.albums) {
    if (!dbState.albums.has(album)) {
      addedAlbums.push(album);
    }
  }

  // 被移除相册
  for (const album of dbState.albums) {
    if (!fsState.albums.has(album)) {
      removedAlbums.push(album);
    }
  }

  // 新增媒体文件
  for (const [pathKey, kind] of fsState.media.entries()) {
    if (!dbState.media.has(pathKey)) {
      addedMedia[kind].push(pathKey);
    }
  }

  // 被移除媒体文件
  for (const [pathKey, kind] of dbState.media.entries()) {
    if (!fsState.media.has(pathKey)) {
      removedMedia[kind].push(pathKey);
    }
  }

  return { addedAlbums, removedAlbums, addedMedia, removedMedia };
}

/**
 * 基于差异生成变更操作数组
 * @param {*} diff 
 * @returns {{changes:Object[],summary:Object}}
 */
function buildChangesFromDiff(diff) {
  const changeSet = new Map();
  const changes = [];

  /**
   * 添加一个变更操作，去重
   * @param {'add'|'unlink'|'addDir'|'unlinkDir'} type 
   * @param {string} relPath 
   */
  const addChange = (type, relPath) => {
    if (!relPath) return;
    const absPath = path.join(PHOTOS_DIR, relPath);
    const key = `${type}:${absPath}`;
    if (changeSet.has(key)) return;
    changeSet.set(key, true);
    changes.push({ type, filePath: absPath });
  };

  // 构造删除和新增变更列表
  diff.removedMedia.photo.forEach((rel) => addChange('unlink', rel));
  diff.removedMedia.video.forEach((rel) => addChange('unlink', rel));
  diff.removedAlbums.forEach((rel) => addChange('unlinkDir', rel));
  diff.addedAlbums.forEach((rel) => addChange('addDir', rel));
  diff.addedMedia.photo.forEach((rel) => addChange('add', rel));
  diff.addedMedia.video.forEach((rel) => addChange('add', rel));

  // 统计变更概要
  const summary = {
    added: {
      albums: diff.addedAlbums.length,
      photos: diff.addedMedia.photo.length,
      videos: diff.addedMedia.video.length,
    },
    removed: {
      albums: diff.removedAlbums.length,
      photos: diff.removedMedia.photo.length,
      videos: diff.removedMedia.video.length,
    }
  };
  summary.added.media = summary.added.photos + summary.added.videos;
  summary.removed.media = summary.removed.photos + summary.removed.videos;
  summary.totalChanges = changes.length;

  return { changes, summary };
}

/**
 * 获取并同步文件系统与数据库的相册、媒体状态（主入口函数）
 * @returns {Promise<{summary:Object,changesApplied:boolean,diff:Object}>}
 */
async function syncAlbumsAndMedia() {
  const fsState = await collectFilesystemState();
  const dbState = await collectDatabaseState();
  const diff = computeDiff(fsState, dbState);
  const { changes, summary } = buildChangesFromDiff(diff);

  if (changes.length === 0) {
    return { summary: { ...summary, totalChanges: 0 }, changesApplied: false, diff };
  }

  await processManualChanges(changes);
  return { summary, changesApplied: true, diff };
}

/**
 * 构建直接删除项目（如批量删除或移除相册）需要的变更列表
 * @param {string} rootRelativePath 根相册相对路径
 * @param {Array} items 额外需要删的媒体/相册项
 * @returns {{changes:Object[], removed:Object}}
 */
function buildDeletionChanges(rootRelativePath, items = []) {
  const normalizedRoot = normalizeRelative(rootRelativePath);
  const changeSet = new Map();
  const changes = [];
  const removed = { albums: 0, photos: 0, videos: 0 };

  /**
   * 添加变更（带去重）
   * @param {'unlink'|'unlinkDir'} type 
   * @param {string} rel 
   */
  const addChange = (type, rel) => {
    if (!rel) return;
    const abs = path.join(PHOTOS_DIR, rel);
    const key = `${type}:${abs}`;
    if (changeSet.has(key)) return;
    changeSet.set(key, true);
    changes.push({ type, filePath: abs });
  };

  // 根相册目录（如有）优先删除
  if (normalizedRoot) {
    addChange('unlinkDir', normalizedRoot);
    removed.albums += 1;
  }

  // 枚举子项
  for (const item of items || []) {
    const rel = normalizeRelative(item.path);
    if (!rel) continue;
    if (item.type === 'album') {
      if (rel === normalizedRoot) {
        continue;
      }
      removed.albums += 1;
      addChange('unlinkDir', rel);
      continue;
    }
    if (item.type === 'photo' || item.type === 'video') {
      removed[item.type === 'photo' ? 'photos' : 'videos'] += 1;
      addChange('unlink', rel);
    }
  }

  removed.media = removed.photos + removed.videos;

  return { changes, removed };
}

// 导出主同步与删除函数
module.exports = {
  syncAlbumsAndMedia,
  buildDeletionChanges
};
