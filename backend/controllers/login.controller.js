/**
 * 登录页背景控制器
 * 从缩略图目录中选择一张随机图片作为登录背景，并缓存3小时
 */
const path = require('path');
const { promises: fs } = require('fs');
const mime = require('mime-types');
const { redis } = require('../config/redis');
const logger = require('../config/logger');
const { THUMBS_DIR } = require('../config');

const CACHE_KEY = 'login_bg_thumb_relpath_v1';
const CACHE_TTL_SECONDS = 60 * 60 * 3; // 3小时

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    logger.warn(`[LoginBG] 读取目录失败: ${dir} - ${e && e.message}`);
    return;
  }
  for (const entry of entries) {
    if (entry.name === '@eaDir') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && /\.(jpe?g|png|webp|gif)$/i.test(entry.name)) {
      yield full;
    }
  }
}

async function pickRandomThumb() {
  // 优先使用 Redis 缓存的相对路径
  try {
    const relCached = await redis.get(CACHE_KEY);
    if (relCached) {
      const abs = path.join(THUMBS_DIR, relCached);
      if (await fileExists(abs)) return relCached;
    }
  } catch {}

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
  try { await redis.set(CACHE_KEY, chosen, 'EX', CACHE_TTL_SECONDS); } catch {}
  return chosen;
}

exports.serveLoginBackground = async (req, res) => {
  const rel = await pickRandomThumb();
  if (!rel) return res.status(404).json({ code: 'LOGIN_BG_NOT_FOUND', message: '暂无可用的背景图片', requestId: req.requestId });
  const abs = path.join(THUMBS_DIR, rel);
  const type = mime.lookup(abs) || 'image/jpeg';
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`);
  return res.sendFile(abs);
};


