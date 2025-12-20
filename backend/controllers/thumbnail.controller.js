/**
 * 缩略图控制器
 * 负责处理缩略图的按需生成、批量补全等相关请求。
 */
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const { PHOTOS_DIR, THUMBS_DIR } = require('../config');
const { ensureThumbnailExists, batchGenerateMissingThumbnails } = require('../services/thumbnail.service');
const { getThumbStatusStats, getCount } = require('../repositories/stats.repo');
const state = require('../services/state.manager');
const { dbRun } = require('../db/multi-db');

/**
 * 内存监控，仅在开发环境启用（可通过环境变量覆盖）。
 * 默认按分钟采样，但仅每 5 分钟输出一次日志，防止刷屏。
 */
const memoryMonitorToggle = (process.env.MEMORY_MONITOR_ENABLED || '').trim().toLowerCase();
const enableMemoryMonitoring = memoryMonitorToggle
    ? memoryMonitorToggle === 'true'
    : process.env.NODE_ENV !== 'production';
const MEMORY_MONITOR_INTERVAL_MS = Math.max(60000, Number(process.env.MEMORY_MONITOR_INTERVAL_MS) || 60000);
const MEMORY_MONITOR_LOG_THROTTLE_MS = Math.max(
    MEMORY_MONITOR_INTERVAL_MS,
    Number(process.env.MEMORY_MONITOR_LOG_THROTTLE_MS) || 5 * 60 * 1000
);
const MEMORY_MONITOR_LOG_LEVEL = (process.env.MEMORY_MONITOR_LOG_LEVEL || 'debug').toLowerCase();
const logMemory = typeof logger[MEMORY_MONITOR_LOG_LEVEL] === 'function'
    ? message => logger[MEMORY_MONITOR_LOG_LEVEL](message)
    : message => logger.debug(message);

if (enableMemoryMonitoring) {
    let lastMemoryLogAt = 0;

    const emitMemoryUsage = () => {
        const memUsage = process.memoryUsage();
        const memUsageMB = {
            rss: Math.round(memUsage.rss / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024)
        };

        if (memUsageMB.heapUsed > 200) {
            logger.warn(`${LOG_PREFIXES.MEMORY_WARNING} 堆内存使用过高: ${memUsageMB.heapUsed}MB`);
        }

        if (Date.now() - lastMemoryLogAt < MEMORY_MONITOR_LOG_THROTTLE_MS) {
            return;
        }

        logMemory(
            `${LOG_PREFIXES.MEMORY_MONITOR} RSS: ${memUsageMB.rss}MB, 堆使用: ${memUsageMB.heapUsed}/${memUsageMB.heapTotal}MB, 外部: ${memUsageMB.external}MB`
        );
        lastMemoryLogAt = Date.now();
    };

    emitMemoryUsage();
    setInterval(emitMemoryUsage, MEMORY_MONITOR_INTERVAL_MS);
}

// ======== 请求频率控制参数区 ========
/** 批量补全频率限制Map */
const batchThrottleMap = new Map();

/** 
 * 缩略图存在性缓存（Redis 优先 + 内存降级）
 * 优先使用 Redis 存储，Redis 不可用时降级到内存缓存
 * 大幅减少磁盘 I/O，提升响应速度
 */
const { resolveRedisClient } = require('../services/cache.service');
const { safeRedisGet, safeRedisSet, safeRedisDel } = require('../utils/helpers');

// 内存降级缓存（当 Redis 不可用时使用）
const memoryFallbackCache = new Map();
const THUMB_CACHE_TTL_SECONDS = 300; // 5分钟过期 (Redis 用秒)
const THUMB_CACHE_TTL_MS = THUMB_CACHE_TTL_SECONDS * 1000; // 内存缓存用毫秒
const MEMORY_CACHE_MAX_SIZE = 2000; // 内存降级时最大条目（比 Redis 小）
const REDIS_THUMB_PREFIX = 'thumb_exists:';

/**
 * 检查缩略图是否存在（带缓存）
 * @param {string} thumbAbsPath 缩略图绝对路径
 * @returns {Promise<boolean>}
 */
async function checkThumbExists(thumbAbsPath) {
    const cacheKey = REDIS_THUMB_PREFIX + thumbAbsPath;
    const now = Date.now();
    const redisClient = resolveRedisClient('缩略图缓存');

    // 尝试从 Redis 读取
    if (redisClient) {
        try {
            const cached = await safeRedisGet(redisClient, cacheKey, '缩略图缓存');
            if (cached !== null) {
                return cached === '1';
            }
        } catch {
            // Redis 读取失败，继续检查文件
        }
    } else {
        // Redis 不可用，检查内存缓存
        const memCached = memoryFallbackCache.get(thumbAbsPath);
        if (memCached && (now - memCached.time) < THUMB_CACHE_TTL_MS) {
            return memCached.exists;
        }
    }

    // 缓存未命中，检查文件系统
    try {
        await fs.access(thumbAbsPath);

        // 存在，写入缓存
        if (redisClient) {
            await safeRedisSet(redisClient, cacheKey, '1', 'EX', THUMB_CACHE_TTL_SECONDS, '缩略图缓存');
        } else {
            // 内存降级
            memoryFallbackCache.set(thumbAbsPath, { exists: true, time: now });
            // 更积极的清理：80% 阈值触发，按时间排序删除最旧的 50% 条目（真正的 LRU）
            if (memoryFallbackCache.size > MEMORY_CACHE_MAX_SIZE * 0.8) {
                const keysToDelete = Math.floor(memoryFallbackCache.size * 0.5);
                // 按时间戳排序，最旧的在前
                const sortedEntries = Array.from(memoryFallbackCache.entries())
                    .sort((a, b) => a[1].time - b[1].time);
                for (let i = 0; i < keysToDelete && i < sortedEntries.length; i++) {
                    memoryFallbackCache.delete(sortedEntries[i][0]);
                }
            }
        }



        return true;
    } catch {
        // 不存在，缓存较短时间（1分钟）
        if (redisClient) {
            await safeRedisSet(redisClient, cacheKey, '0', 'EX', 60, '缩略图缓存(不存在)');
        } else {
            memoryFallbackCache.set(thumbAbsPath, { exists: false, time: now - THUMB_CACHE_TTL_MS + 60000 });
        }
        return false;
    }
}

/**
 * 使缩略图缓存失效
 * @param {string} thumbAbsPath 
 */
async function invalidateThumbCache(thumbAbsPath) {
    const cacheKey = REDIS_THUMB_PREFIX + thumbAbsPath;
    memoryFallbackCache.delete(thumbAbsPath);
    const redisClient = resolveRedisClient('清除缩略图缓存');
    if (redisClient) {
        await safeRedisDel(redisClient, cacheKey, '清除缩略图缓存');
    }
}



/**
 * 获取（按需生成）单个缩略图。
 * 增加频率限制，自动返回SVG占位/错误图。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getThumbnail(req, res) {
    try {
        const { path: relativePath } = req.query;

        // 节流打印缩略图日志
        if (state.logThrottle.shouldLogThumb(5000)) {
            logger.debug(`${LOG_PREFIXES.THUMB_REQUEST} 收到请求: ${relativePath}`);
        }

        if (!relativePath) {
            return res.status(400).json({ error: '缺少 path 参数' });
        }

        // 路径检查（防止路径遍历攻击）
        const normalizedPath = path.normalize(relativePath).replace(/\\/g, '/');
        const pathSegments = normalizedPath.split('/').filter(Boolean);
        const hasPathTraversal = pathSegments.some(seg => seg === '..' || seg === '.');
        if (hasPathTraversal || normalizedPath.startsWith('/')) {
            return res.status(400).json({ error: '无效的文件路径' });
        }

        // 根据文件类型确定缩略图路径
        const isVideo = /\.(mp4|webm|mov)$/i.test(normalizedPath);
        const extension = isVideo ? '.jpg' : '.webp';
        const thumbRelPath = normalizedPath.replace(/\.[^.]+$/, extension);
        const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);

        // ✅ 优化：先检查缩略图缓存，避免重复的磁盘 I/O
        let thumbExists = await checkThumbExists(thumbAbsPath);

        if (thumbExists) {
            // 缓存可能过期，先验证文件存在
            try {
                await fs.access(thumbAbsPath);
            } catch (error) {
                await invalidateThumbCache(thumbAbsPath);
                logger.warn(`缩略图缓存失效，文件缺失: ${thumbAbsPath} -> ${error && error.message}`);
                thumbExists = false;
            }
        }

        if (thumbExists) {
            // 缩略图存在，直接发送（跳过源文件检查和 ensureThumbnailExists）
            res.set({
                'Cache-Control': 'public, max-age=2592000', // 30天
                'Content-Type': isVideo ? 'image/jpeg' : 'image/webp'
            });
            return res.sendFile(thumbAbsPath, (err) => {
                if (err) {
                    logger.warn(`发送缩略图文件失败，清除缓存: ${thumbAbsPath} -> ${err && err.message}`);
                    invalidateThumbCache(thumbAbsPath).catch(() => {});
                    if (!res.headersSent) {
                        const errorSvg = generateErrorSvg();
                        res.set({
                            'Content-Type': 'image/svg+xml',
                            'Cache-Control': 'public, max-age=300',
                            'X-Thumbnail-Status': 'failed',
                            'X-Thumb-Status': 'failed'
                        });
                        res.status(404).send(errorSvg);
                    }
                }
            });
        }

        // 缩略图不存在，需要验证源文件并可能生成
        const sourceAbsPath = path.join(PHOTOS_DIR, normalizedPath);

        // 验证源文件是否存在
        try {
            await fs.access(sourceAbsPath);
        } catch (error) {
            logger.debug(`${LOG_PREFIXES.THUMB_REQUEST || '[缩略图请求]'} 源文件缺失: ${sourceAbsPath} -> ${error && error.message}`);
            await purgeOrphanMedia(normalizedPath);
            return res.status(404).json({ error: '源文件不存在' });
        }

        // 按需生成缩略图
        const result = await ensureThumbnailExists(sourceAbsPath, normalizedPath);

        if (result.status === 'exists') {
            // 文件刚生成，更新缓存（使用正确的缓存键和机制）
            const cacheKey = REDIS_THUMB_PREFIX + thumbAbsPath;
            const redisClient = resolveRedisClient('缩略图缓存');
            if (redisClient) {
                await safeRedisSet(redisClient, cacheKey, '1', 'EX', THUMB_CACHE_TTL_SECONDS, '缩略图缓存');
            } else {
                memoryFallbackCache.set(thumbAbsPath, { exists: true, time: Date.now() });
            }

            res.set({
                'Cache-Control': 'public, max-age=2592000',
                'Content-Type': isVideo ? 'image/jpeg' : 'image/webp'
            });
            return res.sendFile(thumbAbsPath, (err) => {
                if (err) {
                    logger.error(`发送缩略图文件失败: ${thumbAbsPath}`, err);
                    invalidateThumbCache(thumbAbsPath).catch(() => {});
                    if (!res.headersSent) {
                        const errorSvg = generateErrorSvg();
                        res.set({
                            'Content-Type': 'image/svg+xml',
                            'Cache-Control': 'public, max-age=300',
                            'X-Thumbnail-Status': 'failed',
                            'X-Thumb-Status': 'failed'
                        });
                        res.status(404).send(errorSvg);
                    }
                }
            });
        } else if (result.status === 'processing') {
            // 正在生成，返回加载中SVG
            const loadingSvg = generateLoadingSvg();
            res.set({
                'Content-Type': 'image/svg+xml',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'X-Thumbnail-Status': 'processing',
                'X-Thumb-Status': 'processing'
            });
            return res.status(202).send(loadingSvg);
        } else {
            // 生成失败，返回错误SVG
            const errorSvg = generateErrorSvg();
            res.set({
                'Content-Type': 'image/svg+xml',
                'Cache-Control': 'public, max-age=300',
                'X-Thumbnail-Status': 'failed',
                'X-Thumb-Status': 'failed'
            });
            return res.status(404).send(errorSvg);
        }
    } catch (error) {
        logger.error('获取缩略图时发生错误:', error);
        const errorSvg = generateErrorSvg();
        res.set({
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'no-cache'
        });
        return res.status(500).send(errorSvg);
    }
}


/**
 * 批量补全缺失的缩略图（用于设置页发起补全）。
 * 支持自动循环补全（loop=true），频率限制防止滥用。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function batchGenerateThumbnails(req, res) {
    try {
        const { limit = 1000 } = req.body;

        // 限制批量补全调用频率（每用户30秒一次）
        const now = Date.now();
        const userKey = `batch_${req.user?.id || 'anonymous'}`;
        const lastBatchTime = batchThrottleMap.get(userKey) || 0;

        if (now - lastBatchTime < 30000) {
            const remaining = Math.ceil((30000 - (now - lastBatchTime)) / 1000);
            logger.warn(`${LOG_PREFIXES.BATCH_BACKFILL} 频率过高，用户 ${userKey} 需等待 ${remaining} 秒`);
            return res.status(429).json({
                code: 'RATE_LIMIT_EXCEEDED',
                message: `批量补全过于频繁，请等待 ${remaining} 秒后再试`,
                retryAfter: remaining
            });
        }

        // 更新限制时间
        batchThrottleMap.set(userKey, now);

        // 清理过多的记录，防止内存泄漏
        if (batchThrottleMap.size > 200) {
            const cutoff = now - 60000;
            for (const [key, timestamp] of batchThrottleMap.entries()) {
                if (timestamp < cutoff) {
                    batchThrottleMap.delete(key);
                }
            }
        }

        // limit校验
        const processLimit = Math.min(Math.max(1, parseInt(limit) || 1000), 5000);

        // 日志调试信息
        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 收到请求参数: limit=${limit}, loop=${req.body?.loop}, mode=${req.body?.mode}`);
        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 请求体: ${JSON.stringify(req.body)}`);
        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 请求体类型: ${typeof req.body}, 键: ${Object.keys(req.body || {})}`);
        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} req.body.loop 类型: ${typeof req.body?.loop}, 值: ${req.body?.loop}`);

        /**
         * 检查是否需要循环补全
         * loop=true 或 mode=loop 进入自动循环模式
         */
        const loopFlag = (
            String(req.body?.loop ?? '').toLowerCase() === 'true' ||
            req.body?.loop === true ||
            String(req.body?.mode ?? '').toLowerCase() === 'loop'
        );

        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 循环标志判断结果: loopFlag=${loopFlag}`);

        if (loopFlag) {
            logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 自动循环模式启动：单批限制 ${processLimit}`);
            // 启动循环标记，防止任务池提前销毁
            state.thumbnail.setBatchLoopActive(true);
            setImmediate(async () => {
                try {
                    let rounds = 0;
                    let totalProcessed = 0, totalQueued = 0, totalSkipped = 0;
                    while (true) {
                        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 开始第${rounds + 1}轮处理`);
                        const r = await batchGenerateMissingThumbnails(processLimit);
                        rounds++;
                        totalProcessed += r?.processed || 0;
                        totalQueued += r?.queued || 0;
                        totalSkipped += r?.skipped || 0;
                        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 第${rounds}轮完成: processed=${r?.processed || 0}, queued=${r?.queued || 0}, skipped=${r?.skipped || 0}, foundMissing=${r?.foundMissing || 0}`);
                        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 累计统计: totalProcessed=${totalProcessed}, totalQueued=${totalQueued}, totalSkipped=${totalSkipped}`);
                        if (!r || (r.foundMissing || 0) === 0) {
                            logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 检测到无更多缺失任务，第${rounds}轮后退出循环`);
                            logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 退出时状态: r=${!!r}, foundMissing=${r?.foundMissing || 0}, queued=${r?.queued || 0}`);
                            break;
                        }
                        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 第${rounds}轮后继续下一轮处理，等待2秒...`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                    logger.info(`${LOG_PREFIXES.BATCH_BACKFILL} 自动循环完成：轮次=${rounds} processed=${totalProcessed} queued=${totalQueued} skipped=${totalSkipped}`);
                } catch (e) {
                    logger.error('自动循环批量补全失败:', e);
                } finally {
                    state.thumbnail.setBatchLoopActive(false);
                }
            });
            return res.json({
                success: true,
                message: '批量补全已启动（自动循环直到无缺失）',
                data: { mode: 'loop', limit: processLimit }
            });
        }

        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 开始批量生成缩略图，限制: ${processLimit}`);

        const result = await batchGenerateMissingThumbnails(processLimit);

        // 普通模式确保循环标志已清除
        state.thumbnail.setBatchLoopActive(false);

        res.json({
            success: true,
            message: result.message,
            data: {
                processed: result.processed,
                queued: result.queued,
                skipped: result.skipped,
                limit: processLimit
            }
        });
    } catch (error) {
        logger.error('批量生成缩略图失败:', error);
        res.status(500).json({
            success: false,
            error: '批量生成缩略图失败',
            message: error.message
        });
    }
}

/**
 * 获取缩略图生成状态统计。
 * 用于设置页展示缩略图任务状态及调试数据。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getThumbnailStats(req, res) {
    try {
        const { dbAll } = require('../db/multi-db');

        // 查询缩略图状态统计
        const statusStats = await getThumbStatusStats();
        const totalCount = await getCount('thumb_status');

        // 整理统计结果
        const existsResult = { count: statusStats.exists || 0 };
        const missingResult = { count: statusStats.missing || 0 };
        const failedResult = { count: statusStats.failed || 0 };
        const pendingResult = { count: statusStats.pending || 0 };
        const totalResult = { total: totalCount };

        // debug模式下返回部分缺失/失败样本
        if (req.query.debug === 'true') {
            const sampleMissing = await dbAll('main', 'SELECT path FROM thumb_status WHERE status = ? LIMIT 10', ['missing']);
            const sampleFailed = await dbAll('main', 'SELECT path FROM thumb_status WHERE status = ? LIMIT 5', ['failed']);
            const samplePending = await dbAll('main', 'SELECT path FROM thumb_status WHERE status = ? LIMIT 5', ['pending']);

            return res.json({
                success: true,
                data: {
                    exists: existsResult?.count || 0,
                    missing: missingResult?.count || 0,
                    failed: failedResult?.count || 0,
                    pending: pendingResult?.count || 0,
                    total: totalResult?.total || 0,
                    activeTasks: state.thumbnail.getActiveCount(),
                    debug: {
                        sampleMissing: sampleMissing?.map(row => row.path) || [],
                        sampleFailed: sampleFailed?.map(row => row.path) || [],
                        samplePending: samplePending?.map(row => row.path) || []
                    }
                }
            });
        }

        res.json({
            success: true,
            data: {
                exists: existsResult?.count || 0,
                missing: missingResult?.count || 0,
                failed: failedResult?.count || 0,
                pending: pendingResult?.count || 0,
                total: totalResult?.total || 0,
                activeTasks: state.thumbnail.getActiveCount()
            }
        });
    } catch (error) {
        logger.error('获取缩略图统计失败:', error);
        res.status(500).json({
            success: false,
            error: '获取缩略图统计失败',
            message: error.message
        });
    }
}

/**
 * 返回加载中SVG占位图（用于缩略图生成中）。
 * @returns {string} SVG字符串
 */
function generateLoadingSvg() {
    return `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect width="200" height="200" fill="#f0f0f0"/>
        <circle cx="100" cy="100" r="20" fill="none" stroke="#007bff" stroke-width="3">
            <animate attributeName="stroke-dasharray" values="0 126;63 63;0 126" dur="1.5s" repeatCount="indefinite"/>
            <animate attributeName="stroke-dashoffset" values="0;-63;-126" dur="1.5s" repeatCount="indefinite"/>
        </circle>
        <text x="100" y="140" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#666">
            生成中...
        </text>
    </svg>`;
}

/**
 * 返回缩略图生成失败时的SVG占位图。
 * @returns {string} SVG字符串
 */
function generateErrorSvg() {
    return `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect width="200" height="200" fill="#f8f9fa"/>
        <circle cx="100" cy="100" r="30" fill="none" stroke="#dc3545" stroke-width="2"/>
        <line x1="85" y1="85" x2="115" y2="115" stroke="#dc3545" stroke-width="2"/>
        <line x1="115" y1="85" x2="85" y2="115" stroke="#dc3545" stroke-width="2"/>
        <text x="100" y="140" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#666">
            无法生成
        </text>
    </svg>`;
}

module.exports = {
    getThumbnail,
    batchGenerateThumbnails,
    getThumbnailStats,
    generateErrorSvg
};
async function purgeOrphanMedia(pathValue) {
    const cleanPath = typeof pathValue === 'string' ? pathValue.trim() : '';
    if (!cleanPath) return;
    try {
        const deleteItems = await dbRun('main', 'DELETE FROM items WHERE path = ?', [cleanPath]);
        const deleteThumb = await dbRun('main', 'DELETE FROM thumb_status WHERE path = ?', [cleanPath]);
        const removed = (deleteItems?.changes || 0) + (deleteThumb?.changes || 0);
        if (removed > 0) {
            logger.info(`${LOG_PREFIXES.THUMB_REQUEST || '[缩略图请求]'} 检测到孤立缩略图记录，已自动清理: ${cleanPath}`);
        }
    } catch (purgeError) {
        logger.debug(`${LOG_PREFIXES.THUMB_REQUEST || '[缩略图请求]'} 自动清理孤立缩略图记录失败 (path=${cleanPath}): ${purgeError && purgeError.message}`);
    }
}
