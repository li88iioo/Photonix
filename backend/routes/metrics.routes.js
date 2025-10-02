const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
let metricsStore;
try {
  const { redis } = require('../config/redis');
  const useRedis = (process.env.RATE_LIMIT_USE_REDIS || 'false').toLowerCase() === 'true';
  if (redis && !redis.isNoRedis && useRedis) {
    const RedisStore = require('rate-limit-redis');
    metricsStore = new RedisStore({ sendCommand: (...args) => redis.call(...args) });
  }
} catch {}
const { getCacheStats } = require('../middleware/cache');
// 注意：AI队列已移除，AI功能已重构为微服务架构

// 轻量限流，避免监控轮询放大流量
const metricsLimiter = rateLimit({
  windowMs: 30 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: metricsStore
});

// 可选的 Admin Token 保护（设置 METRICS_TOKEN 时启用；本地白名单）
function metricsGuard(req, res, next) {
  try {
    const required = String(process.env.METRICS_TOKEN || '').trim();
    if (!required) return next();

    // 本地白名单判断
    const ip = (req.ip || '').toString();
    const host = (req.hostname || '').toString().toLowerCase();
    const isLocal =
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip.endsWith('::ffff:127.0.0.1') ||
      host === 'localhost';

    if (isLocal) return next();

    const provided = (req.get('x-admin-metrics-token') || req.query.token || '').toString();
    if (provided && provided === required) return next();

    return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Metrics access denied' });
  } catch (e) {
    return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Metrics access denied' });
  }
}


// 缓存命中率指标
router.get('/cache', metricsLimiter, (req, res) => {
  const stats = getCacheStats();
  res.json({ success: true, data: stats });
});

// AI微服务状态指标
router.get('/ai-service', metricsLimiter, async (req, res) => {
  try {
    // 动态导入AI微服务，避免循环依赖
    const aiMicroservice = require('../services/ai-microservice');
    const status = aiMicroservice.getStatus();

    return res.json({
      success: true,
      service: 'ai-microservice',
      data: status,
      note: 'AI功能已重构为微服务架构，不再使用BullMQ队列'
    });
  } catch (e) {
    return res.json({
      success: true,
      service: 'ai-microservice',
      disabled: true,
      note: 'AI微服务状态获取失败',
      data: { activeTasks: 0, queuedTasks: 0, maxConcurrent: 2, isProcessing: false }
    });
  }
});

// 运行期汇总指标（轻量、安全降级）
router.get('/summary', metricsLimiter, async (req, res) => {
  try {
    // 运行配置（从统一 config 暴露）
    const cfg = require('../config');
    const runtime = {
      INDEX_CONCURRENCY: cfg.INDEX_CONCURRENCY,
      INDEX_BATCH_SIZE: cfg.INDEX_BATCH_SIZE,
      SHARP_CONCURRENCY: cfg.SHARP_CONCURRENCY,
      NUM_WORKERS: cfg.NUM_WORKERS
    };

    // Redis 状态（安全降级）
    let redisStatus = { enabled: false, isNoRedis: true };
    try {
      const { redis } = require('../config/redis');
      redisStatus = {
        enabled: !!(redis && !redis.isNoRedis),
        isNoRedis: !!(redis && redis.isNoRedis)
      };
    } catch {}

    // 索引状态（仓储层）
    let index = null;
    try {
      const idxRepo = require('../repositories/indexStatus.repo');
      index = await idxRepo.getIndexStatusRow();
    } catch {}

    // 基础表统计（轻量 COUNT/聚合，可通过 ?fast=1 跳过）
    const { dbAll } = require('../db/multi-db');
    const fast = ['1','true','yes'].includes(String(req.query.fast || '').toLowerCase());
    let itemsCount = [{ c: 0 }], ftsCount = [{ c: 0 }], albumCoversCount = [{ c: 0 }], thumbStats = [];
    if (!fast) {
      itemsCount = await dbAll('main', "SELECT COUNT(1) AS c FROM items").catch(() => [{ c: 0 }]);
      ftsCount = await dbAll('main', "SELECT COUNT(1) AS c FROM items_fts").catch(() => [{ c: 0 }]);
      albumCoversCount = await dbAll('main', "SELECT COUNT(1) AS c FROM album_covers").catch(() => [{ c: 0 }]);
      thumbStats = await dbAll('main', "SELECT status, COUNT(1) AS count FROM thumb_status GROUP BY status").catch(() => []);
    }

    // 进程与缩略图即时指标（安全降级）
    let processInfo = {};
    try {
      const mu = process.memoryUsage();
      processInfo = {
        pid: process.pid,
        uptimeSec: Math.floor(process.uptime()),
        rssMB: Math.round((mu.rss || 0) / 1048576),
        heapUsedMB: Math.round((mu.heapUsed || 0) / 1048576)
      };
    } catch {}
    let thumb = { active: 0, queueLen: 0, batchActive: false };
    try {
      thumb = {
        active: Number(global.__thumbActiveCount || 0),
        queueLen: Number(global.__thumbOndemandQueueLen || 0),
        batchActive: Boolean(global.__thumbBatchActive || false)
      };
    } catch {}

    let thumbTaskMetrics = null;
    try {
        const thumbService = require('../services/thumbnail.service');
        if (thumbService && typeof thumbService.getThumbnailTaskMetrics === 'function') {
            thumbTaskMetrics = thumbService.getThumbnailTaskMetrics();
        }
    } catch {}

    let schedulerMetrics = null;
    let videoTaskMetrics = null;
    try {
        const workerManager = require('../services/worker.manager');
        if (workerManager && typeof workerManager.getTaskSchedulerMetrics === 'function') {
            schedulerMetrics = workerManager.getTaskSchedulerMetrics();
        }
        if (workerManager && typeof workerManager.getVideoTaskMetrics === 'function') {
            videoTaskMetrics = workerManager.getVideoTaskMetrics();
        }
    } catch {}

    if (thumbTaskMetrics) {
        thumb.metrics = thumbTaskMetrics;
    }

    res.json({
      success: true,
      data: {
        runtime,
        redis: redisStatus,
        index,
        db: {
          items: Number(itemsCount?.[0]?.c || 0),
          itemsFts: Number(ftsCount?.[0]?.c || 0),
          albumCovers: Number(albumCoversCount?.[0]?.c || 0),
          thumbStatus: thumbStats
        },
        process: processInfo,
        thumb,
        backgroundTasks: {
            workerScheduler: schedulerMetrics,
            video: videoTaskMetrics
        },
        fast
      },
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'SUMMARY_ERROR', message: e.message });
  }
});

module.exports = router;


