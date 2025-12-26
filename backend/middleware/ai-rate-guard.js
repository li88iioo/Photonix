const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const { redis } = require('../config/redis');
const crypto = require('crypto');
const { safeRedisIncr, safeRedisExpire, safeRedisGet, safeRedisSet } = require('../utils/helpers');
const settingsService = require('../services/settings.service');

/**
 * 对输入进行 SHA-256 哈希，输出前 16 位十六进制字符串
 * @param {string} input - 输入内容
 * @returns {string} 哈希值（16位字符串）
 */
function hash(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 16);
}

/**
 * AI 频控与配额守卫中间件
 * 实现功能说明：
 * 1. 按用户每日配额（DAILY_LIMIT）限制请求次数，超限则阻止
 * 2. 对同一用户+图片在短时间窗口内的重复请求做去重（短锁，冷却锁）
 * 3. 智能冷却：仅在 AI 内容生成成功后才设置短期冷却锁，防止重复请求生成
 * 4. 在无 Redis 环境下自动放行，保障系统可用性
 *
 * @param {import('express').Request} req - Express 请求对象
 * @param {import('express').Response} res - Express 响应对象
 * @param {Function} next - 下一步回调
 */
module.exports = async function aiRateGuard(req, res, next) {
  try {
    // 若 Redis 不可用（isNoRedis 为 true），直接放行以保证系统可用性
    if (redis && redis.isNoRedis === true) {
      return next();
    }

    // === 1. 用户身份识别 ===
    // 优先顺序：req.user.id（经过鉴权） > header(x-user-id/x-userid/x-user) > IP > 'anonymous'
    const headerUserId = req.headers['x-user-id'] || req.headers['x-userid'] || req.headers['x-user'];
    const userIdRaw = (req.user && req.user.id) || headerUserId || req.ip || 'anonymous';
    const userId = String(userIdRaw);

    // === 2. 配额参数环境变量（如无则使用默认） ===
    // 每用户每日最大次数（默认200），单图片请求冷却秒数（默认30）
    let configuredLimit = null;
    try {
      const clientSettings = await settingsService.getAllSettings({ preferFreshSensitive: true });
      configuredLimit = clientSettings?.AI_DAILY_LIMIT;
    } catch {}
    const DAILY_LIMIT = parseInt(configuredLimit || process.env.AI_DAILY_LIMIT || '200', 10);
    const PER_IMAGE_COOLDOWN_SEC = parseInt(process.env.AI_PER_IMAGE_COOLDOWN_SEC || '30', 10);

    // === 3. 计算分区 key（年月日） ===
    const nowDate = new Date();
    const ymd = `${nowDate.getUTCFullYear()}${String(nowDate.getUTCMonth() + 1).padStart(2, '0')}${String(nowDate.getUTCDate()).padStart(2, '0')}`;

    // === 4. 日配额计数与限制 ===
    // quotaKey: ai_quota:用户:日期
    const quotaKey = `ai_quota:${userId}:${ymd}`;
    let current = await safeRedisIncr(redis, quotaKey, 'AI日配额计数') || 0;
    if (current === 1) {
      // 第一次计数，设置今日剩余秒数为 key 过期时间，避免配额穿透
      const nowSec = Math.floor(Date.now() / 1000);
      const tomorrowSec = Math.floor(new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() + 1, 0, 0, 0)).getTime() / 1000);
      await safeRedisExpire(redis, quotaKey, Math.max(60, tomorrowSec - nowSec), 'AI配额过期');
    }
    if (DAILY_LIMIT > 0 && current > DAILY_LIMIT) {
      // 配额超限，直接拦截
      return res.status(429).json({
        code: 'AI_QUOTA_EXCEEDED',
        message: '今日 AI 配额已用完，如需继续使用请在设置中调整 AI_DAILY_LIMIT 或明日再试。',
        detail: `当前上限：${DAILY_LIMIT} 次`
      });
    }

    // === 5. 单图片短期冷却锁 ===
    // 获取图片路径参数
    const imagePathRaw = (req.body && (req.body.image_path || req.body.imagePath)) || '';
    const imageSig = hash(imagePathRaw); // 哈希防止 key 过长 & 信息泄露
    const dedupeKey = `ai_cooldown:${userId}:${imageSig}`;

    // 检查冷却锁是否已存在
    const existingLock = await safeRedisGet(redis, dedupeKey, 'AI冷却锁检查');
    if (existingLock) {
      // 冷却锁关闭原因分析
      if (existingLock === 'success') {
        // 已成功生成，触发冷却，提示需等待
        return res.status(202).json({
          message: '该图片的AI密语已生成，请稍后再试。',
          cooldownSeconds: PER_IMAGE_COOLDOWN_SEC,
          reason: 'already_generated'
        });
      } else {
        // 若正有其它请求处理中，直接放行进入主业务（防止同请求排队）
        return next();
      }
    }

    // 设置处理中的锁（短暂 10 秒），防止重复提交
    await safeRedisSet(redis, dedupeKey, 'processing', 'EX', 10, 'AI请求锁');

    // 全部校验通过，进入主业务流程
    return next();
  } catch (error) {
    // 出现异常时降级放行，并打印调试信息
    logger.debug(`${LOG_PREFIXES.AI_RATE_GUARD} 降级放行，遇到异常`, error && error.message ? { message: error.message } : { error });
    return next();
  }
};
