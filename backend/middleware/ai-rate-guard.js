const { redis } = require('../config/redis');
const crypto = require('crypto');

function hash(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 16);
}

/**
 * AI 频控与配额守卫
 * - 按用户的日配额限制
 * - 对同一用户+图片在短时间窗口内的重复请求做去重（短锁）
 * - 智能冷却：只有在AI成功生成内容后才设置冷却锁
 * - 无 Redis 环境下自动放行，避免误伤
 */
module.exports = async function aiRateGuard(req, res, next) {
  try {
    // 无 Redis 时直接放行（redis 是 Proxy，isNoRedis 为 true 表示回退）
    if (redis && redis.isNoRedis === true) {
      return next();
    }

    // 识别用户：优先 token 注入的 req.user.id，其次 header，最后 IP
    const headerUserId = req.headers['x-user-id'] || req.headers['x-userid'] || req.headers['x-user'];
    const userIdRaw = (req.user && req.user.id) || headerUserId || req.ip || 'anonymous';
    const userId = String(userIdRaw);

    // 环境参数（提供默认）
    const DAILY_LIMIT = parseInt(process.env.AI_DAILY_LIMIT || '200', 10); // 每用户每日最大次数
    const PER_IMAGE_COOLDOWN_SEC = parseInt(process.env.AI_PER_IMAGE_COOLDOWN_SEC || '30', 10); // 单图冷却（缩短为30秒）

    // 计算日期分区 key
    const y = new Date();
    const ymd = `${y.getUTCFullYear()}${String(y.getUTCMonth() + 1).padStart(2, '0')}${String(y.getUTCDate()).padStart(2, '0')}`;

    // 日配额计数
    const quotaKey = `ai_quota:${userId}:${ymd}`;
    let current = await redis.incr(quotaKey);
    if (current === 1) {
      // 第一次设置过期到当天结束
      const now = Math.floor(Date.now() / 1000);
      const tomorrow0 = Math.floor(new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate() + 1, 0, 0, 0)).getTime() / 1000);
      await redis.expire(quotaKey, Math.max(60, tomorrow0 - now));
    }
    if (current > DAILY_LIMIT) {
      return res.status(429).json({ code: 'AI_QUOTA_EXCEEDED', message: '今日 AI 生成次数已用尽，请明日再试。' });
    }

    // 🎯 智能单图片冷却：检查是否有正在进行的请求
    const imagePathRaw = (req.body && (req.body.image_path || req.body.imagePath)) || '';
    const imageSig = hash(imagePathRaw);
    const dedupeKey = `ai_cooldown:${userId}:${imageSig}`;

    // 先检查是否已有冷却锁
    const existingLock = await redis.get(dedupeKey);
    if (existingLock) {
      // 检查锁是否是因为成功生成设置的（值为'success'）
      if (existingLock === 'success') {
        return res.status(202).json({
          message: '该图片的AI密语已生成，请稍后再试。',
          cooldownSeconds: PER_IMAGE_COOLDOWN_SEC,
          reason: 'already_generated'
        });
      } else {
        // 如果是正在进行的请求，允许继续（不设置新的锁）
        return next();
      }
    }

    // 设置临时的请求锁（值为'processing'，短过期时间）
    await redis.set(dedupeKey, 'processing', 'EX', 10); // 10秒过期，用于检测正在进行的请求

    return next();
  } catch (e) {
    // 降级：异常时放行
    return next();
  }
};