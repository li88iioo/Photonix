const { redis } = require('../config/redis');
const crypto = require('crypto');

function hash(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 16);
}

/**
 * AI 频控与配额守卫
 * - 按用户的日配额限制
 * - 对同一用户+图片在短时间窗口内的重复请求做去重（短锁）
 */
module.exports = async function aiRateGuard(req, res, next) {
  try {
    // 识别用户：优先 token 注入的 req.user.id，其次 header，最后 IP
    const headerUserId = req.headers['x-user-id'] || req.headers['x-userid'] || req.headers['x-user'];
    const userIdRaw = (req.user && req.user.id) || headerUserId || req.ip || 'anonymous';
    const userId = String(userIdRaw);

    // 环境参数（提供默认）
    const DAILY_LIMIT = parseInt(process.env.AI_DAILY_LIMIT || '200', 10); // 每用户每日最大次数
    const PER_IMAGE_COOLDOWN_SEC = parseInt(process.env.AI_PER_IMAGE_COOLDOWN_SEC || '60', 10); // 单图冷却

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

    // 单图片冷却（防抖幂等）
    const imagePathRaw = (req.body && (req.body.image_path || req.body.imagePath)) || '';
    const imageSig = hash(imagePathRaw);
    const dedupeKey = `ai_cooldown:${userId}:${imageSig}`;
    const ok = await redis.set(dedupeKey, '1', 'NX', 'EX', PER_IMAGE_COOLDOWN_SEC);
    if (ok === null) {
      return res.status(202).json({ message: '最近已提交过该图片的生成请求，请稍后再试。', cooldownSeconds: PER_IMAGE_COOLDOWN_SEC });
    }

    return next();
  } catch (e) {
    // 降级：Redis 不可用时放行
    return next();
  }
};


