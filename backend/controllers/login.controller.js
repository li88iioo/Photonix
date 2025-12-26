/**
 * 登录页背景控制器模块
 * 实现登录页背景功能：从缩略图目录中选择一张随机图片作为登录背景，并做3小时缓存
 */

const path = require('path');
const { promises: fs } = require('fs');
const mime = require('mime-types');
const { redis } = require('../config/redis');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const { safeRedisGet, safeRedisSet } = require('../utils/helpers');
const { THUMBS_DIR } = require('../config');

const CACHE_KEY = 'login_bg_thumb_relpath_v1';
const CACHE_TTL_SECONDS = 60 * 60 * 3; // 3小时

/**
 * 检查指定路径的文件是否存在
 * @param {string} p - 文件路径
 * @returns {Promise<boolean>}
 */
async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch (error) {
    logger.debug(`[LoginBG] 检测文件存在失败，视为不存在: ${error && error.message}`);
    return false;
  }
}

/**
 * 递归遍历目录，异步生成所有图片文件的路径
 * 跳过隐藏目录、系统目录和临时目录
 * @param {string} dir - 目录路径
 * @returns {AsyncGenerator<string>}
 */
async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    logger.warn(`[LoginBG] 读取目录失败: ${dir} - ${e && e.message}`);
    return;
  }
  for (const entry of entries) {
    // 跳过系统目录、隐藏目录和临时目录
    if (entry.name === '@eaDir' || entry.name === '.tmp' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && /\.(jpe?g|png|webp|gif)$/i.test(entry.name)) {
      // 跳过临时文件
      if (entry.name.startsWith('temp_opt_') || entry.name.includes('.tmp')) continue;
      yield full;
    }
  }
}

/**
 * 从缩略图目录中随机挑选一张图片，支持缓存
 * 先尝试使用Redis缓存，缓存失效后重新随机挑选并缓存
 * @returns {Promise<string|null>} 选中的图片相对路径，失败时返回null
 */
async function pickRandomThumb() {
  // 优先使用 Redis 缓存的相对路径
  const relCached = await safeRedisGet(redis, CACHE_KEY, '登录背景缓存读取');
  if (relCached) {
    const abs = path.join(THUMBS_DIR, relCached);
    if (await fileExists(abs)) return relCached;
  }

  // 扫描缩略图目录，收集候选并随机选择
  const candidates = [];
  for await (const abs of walk(THUMBS_DIR)) {
    // 存储为相对路径，便于以后移动根目录
    const rel = path.relative(THUMBS_DIR, abs).replace(/\\/g, '/');
    candidates.push(rel);
    // 小优化：找到足够多候选即可随机取，避免遍历全部
    if (candidates.length >= 5000) break;
  }
  if (candidates.length === 0) return null;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];

  // 尝试缓存选择结果
  await safeRedisSet(redis, CACHE_KEY, chosen, 'EX', CACHE_TTL_SECONDS, '登录背景缓存写入');

  return chosen;
}

/**
 * 登录页背景图片请求处理器
 * 选取并返回一张随机图片作为背景，支持缓存及规范响应头
 * @param {import('express').Request} req - Express 请求对象
 * @param {import('express').Response} res - Express 响应对象
 */
exports.serveLoginBackground = async (req, res) => {
  async function respondWithRel(rel, allowRetry = true) {
    if (!rel) {
      return res.status(404).json({ code: 'LOGIN_BG_NOT_FOUND', message: '暂无可用的背景图片', requestId: req.requestId });
    }

    const abs = path.join(THUMBS_DIR, rel);
    const type = mime.lookup(abs) || 'image/jpeg';

    try {
      await fs.access(abs);
    } catch (error) {
      // 缓存失效：目标文件不存在，清除缓存并可选重试
      logger.warn(`[LoginBG] 缓存命中但文件缺失，刷新缓存: ${abs} -> ${error && error.message}`);
      await redis.del(CACHE_KEY).catch(() => { });
      if (allowRetry) {
        const nextRel = await pickRandomThumb();
        return respondWithRel(nextRel, false);
      }
      return res.status(404).json({ code: 'LOGIN_BG_NOT_FOUND', message: '暂无可用的背景图片', requestId: req.requestId });
    }

    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`);
    return res.sendFile(abs, (err) => {
      if (err) {
        logger.warn(`[LoginBG] 发送背景图失败，清除缓存: ${abs} -> ${err && err.message}`);
        redis.del(CACHE_KEY).catch(() => { });
        if (!res.headersSent) {
          res.status(404).json({ code: 'LOGIN_BG_NOT_FOUND', message: '暂无可用的背景图片', requestId: req.requestId });
        }
      }
    });
  }

  const rel = await pickRandomThumb();
  return respondWithRel(rel, true);
};
