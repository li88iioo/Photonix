/**
 * 缩略图控制器 - 简化版
 * 处理缩略图的按需生成和批量补全请求
 */
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { PHOTOS_DIR, THUMBS_DIR } = require('../config');
const { ensureThumbnailExists, batchGenerateMissingThumbnails } = require('../services/thumbnail.service');

// 内存监控（仅在开发环境启用）
const enableMemoryMonitoring = process.env.NODE_ENV !== 'production';
if (enableMemoryMonitoring) {
    setInterval(() => {
        const memUsage = process.memoryUsage();
        const memUsageMB = {
            rss: Math.round(memUsage.rss / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024)
        };

        // 记录内存使用情况
        logger.debug(`[内存监控] RSS: ${memUsageMB.rss}MB, 堆使用: ${memUsageMB.heapUsed}/${memUsageMB.heapTotal}MB, 外部: ${memUsageMB.external}MB`);

        // 如果内存使用过高，记录警告
        if (memUsageMB.heapUsed > 200) { // 200MB阈值
            logger.warn(`[内存警告] 堆内存使用过高: ${memUsageMB.heapUsed}MB`);
        }
    }, 60000); // 每分钟监控一次
}

// 请求频率计数器（平衡限流）
const requestCounter = new Map();
const REQUEST_WINDOW_MS = 1000; // 1秒时间窗口
const MAX_REQUESTS_PER_WINDOW = 20; // 每秒最大请求数（增加到20个，适合正常浏览）
const BURST_ALLOWANCE = 10; // 突发流量允许额外请求数（增加到10个）
const NORMAL_BURST_DURATION = 3000; // 正常浏览允许的突发持续时间（3秒）

// 记录最近的请求时间，用于检测突发流量模式
let recentRequestTimes = [];
let burstModeStartTime = 0;
let isInBurstMode = false;

/**
 * 检查请求频率是否超限（智能版本）
 * 能够区分正常浏览和异常流量
 * @param {object} req - 请求对象，用于判断请求类型
 * @returns {boolean} 是否允许请求
 */
function checkRequestRate(req = null) {
    const now = Date.now();
    const windowStart = now - REQUEST_WINDOW_MS;

    // 清理过期记录
    for (const [timestamp] of requestCounter) {
        if (timestamp < windowStart) {
            requestCounter.delete(timestamp);
        }
    }

    // 清理过期的请求时间记录
    recentRequestTimes = recentRequestTimes.filter(time => now - time < 5000);

    // 计算当前窗口内的请求数
    let currentRequests = 0;
    for (const count of requestCounter.values()) {
        currentRequests += count;
    }

    // 记录当前请求时间
    recentRequestTimes.push(now);

    // 检测是否处于突发模式（最近5秒内请求数过多）
    const recentRequests = recentRequestTimes.length;
    if (recentRequests > 15 && !isInBurstMode) {
        // 进入突发模式
        isInBurstMode = true;
        burstModeStartTime = now;
        logger.debug(`[频率控制] 进入突发模式，最近5秒内有${recentRequests}个请求`);
    } else if (isInBurstMode && (now - burstModeStartTime > NORMAL_BURST_DURATION)) {
        // 退出突发模式
        isInBurstMode = false;
        logger.debug(`[频率控制] 退出突发模式`);
    }

    // 限制计数器大小，避免内存泄漏
    if (requestCounter.size > 20) {
        const keys = Array.from(requestCounter.keys()).sort();
        const keysToDelete = keys.slice(0, keys.length - 20);
        keysToDelete.forEach(key => requestCounter.delete(key));
    }

    // 根据模式设置不同的限制
    let effectiveLimit;
    if (isInBurstMode) {
        // 突发模式下允许更多的请求（正常浏览时的批量加载）
        effectiveLimit = MAX_REQUESTS_PER_WINDOW + BURST_ALLOWANCE;
    } else {
        // 正常模式
        effectiveLimit = MAX_REQUESTS_PER_WINDOW;
    }

    // 检查是否为重试请求
    const isRetryRequest = req?.headers?.['x-thumbnail-retry'] === 'true';
    if (isRetryRequest) {
        effectiveLimit += 5; // 重试请求额外宽松
    }

    // 如果超过限制，记录警告但不立即拒绝
    if (currentRequests >= effectiveLimit) {
        logger.warn(`[频率控制] 请求频率较高: ${currentRequests}/${effectiveLimit} (${isInBurstMode ? '突发模式' : '正常模式'})`);

        // 在突发模式下更宽松
        if (isInBurstMode && currentRequests < effectiveLimit * 1.5) {
            // 允许一定的超限，但记录警告
        } else if (!isInBurstMode) {
            return false; // 非突发模式下严格限制
        } else {
            return false; // 突发模式下也有限制
        }
    }

    // 记录当前请求
    const currentSecond = Math.floor(now / 1000) * 1000;
    requestCounter.set(currentSecond, (requestCounter.get(currentSecond) || 0) + 1);

    return true;
}

/**
 * 获取缩略图 - 按需生成版本（优化版）
 * 增加请求频率限制，避免服务器过载
 */
async function getThumbnail(req, res) {
    try {
        // 检查请求频率
        if (!checkRequestRate(req)) {
            logger.warn('[缩略图请求] 请求频率过高，暂时拒绝');
            const errorSvg = generateErrorSvg();
            res.set({
                'Content-Type': 'image/svg+xml',
                'Cache-Control': 'no-cache',
                'X-Rate-Limit': 'exceeded'
            });
            return res.status(429).send(errorSvg);
        }

        const { path: relativePath } = req.query;

        logger.debug(`[缩略图请求] 收到请求: ${relativePath}`);

        if (!relativePath) {
            return res.status(400).json({ error: '缺少 path 参数' });
        }

        // 安全检查：防止路径遍历攻击
        const normalizedPath = path.normalize(relativePath).replace(/\\/g, '/');
        if (normalizedPath.includes('..') || normalizedPath.startsWith('/')) {
            return res.status(400).json({ error: '无效的文件路径' });
        }

        const sourceAbsPath = path.join(PHOTOS_DIR, normalizedPath);

        // 检查源文件是否存在
        try {
            await fs.access(sourceAbsPath);
        } catch {
            return res.status(404).json({ error: '源文件不存在' });
        }

        // 确保缩略图存在（按需生成）
        const result = await ensureThumbnailExists(sourceAbsPath, normalizedPath);

        if (result.status === 'exists') {
            // 缩略图已存在，直接返回文件
            const isVideo = /\.(mp4|webm|mov)$/i.test(normalizedPath);
            const extension = isVideo ? '.jpg' : '.webp';
            const thumbRelPath = normalizedPath.replace(/\.[^.]+$/, extension);
            const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);

            try {
                // 设置缓存头
                res.set({
                    'Cache-Control': 'public, max-age=2592000', // 30天缓存
                    'Content-Type': isVideo ? 'image/jpeg' : 'image/webp'
                });

                return res.sendFile(thumbAbsPath);
            } catch (error) {
                logger.error(`发送缩略图文件失败: ${thumbAbsPath}`, error);
                return res.status(500).json({ error: '缩略图文件读取失败' });
            }
        } else if (result.status === 'processing') {
            // 缩略图正在生成中，返回加载中的SVG占位符
            const loadingSvg = generateLoadingSvg();
            res.set({
                'Content-Type': 'image/svg+xml',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'X-Thumbnail-Status': 'processing'
            });
            return res.status(202).send(loadingSvg);
        } else {
            // 缩略图生成失败
            const errorSvg = generateErrorSvg();
            res.set({
                'Content-Type': 'image/svg+xml',
                'Cache-Control': 'public, max-age=300', // 5分钟缓存
                'X-Thumbnail-Status': 'failed'
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
 * 批量补全缺失的缩略图
 * 提供给设置页面的手动补全功能
 */
async function batchGenerateThumbnails(req, res) {
    try {
        const { limit = 1000 } = req.body;
        
        // 参数验证
        const processLimit = Math.min(Math.max(1, parseInt(limit) || 1000), 5000);
        
        // 调试：记录请求参数
        logger.debug(`[批量补全] 收到请求参数: limit=${limit}, loop=${req.body?.loop}, mode=${req.body?.mode}`);
        logger.debug(`[批量补全] 请求体: ${JSON.stringify(req.body)}`);
        logger.debug(`[批量补全] 请求体类型: ${typeof req.body}, 键: ${Object.keys(req.body || {})}`);
        logger.debug(`[批量补全] req.body.loop 类型: ${typeof req.body?.loop}, 值: ${req.body?.loop}`);
        
        // 支持自动循环：loop=true 或 mode=loop 时，后台持续批次派发直到无缺失
        const loopFlag = (
            String(req.body?.loop ?? '').toLowerCase() === 'true' ||
            req.body?.loop === true ||
            String(req.body?.mode ?? '').toLowerCase() === 'loop'
        );
        
        logger.debug(`[批量补全] 循环标志判断结果: loopFlag=${loopFlag}`);

        if (loopFlag) {
            logger.info(`[批量补全] 自动循环模式启动：单批限制 ${processLimit}`);
            setImmediate(async () => {
                try {
                    let rounds = 0;
                    let totalProcessed = 0, totalQueued = 0, totalSkipped = 0;
                    while (true) {
                        logger.debug(`[批量补全] 开始第${rounds + 1}轮处理`);

                        const r = await batchGenerateMissingThumbnails(processLimit);
                        rounds++;
                        totalProcessed += r?.processed || 0;
                        totalQueued += r?.queued || 0;
                        totalSkipped += r?.skipped || 0;

                        // 调试日志
                        logger.debug(`[批量补全] 第${rounds}轮完成: processed=${r?.processed || 0}, queued=${r?.queued || 0}, skipped=${r?.skipped || 0}, foundMissing=${r?.foundMissing || 0}`);
                        logger.debug(`[批量补全] 累计统计: totalProcessed=${totalProcessed}, totalQueued=${totalQueued}, totalSkipped=${totalSkipped}`);

                        // 修复：基于实际找到的缺失数量判断是否继续
                        // 如果本轮没有找到任何缺失的缩略图，说明已经全部补全完成
                        if (!r || (r.foundMissing || 0) === 0) {
                            logger.info(`[批量补全] 检测到无更多缺失任务，第${rounds}轮后退出循环`);
                            logger.info(`[批量补全] 退出时状态: r=${!!r}, foundMissing=${r?.foundMissing || 0}, queued=${r?.queued || 0}`);
                            break;
                        }

                        // 添加轮次间延迟，给数据库和任务处理一些时间
                        logger.debug(`[批量补全] 第${rounds}轮后继续下一轮处理，等待2秒...`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                    logger.info(`[批量补全] 自动循环完成：轮次=${rounds} processed=${totalProcessed} queued=${totalQueued} skipped=${totalSkipped}`);
                } catch (e) {
                    logger.error('自动循环批量补全失败:', e);
                }
            });
            return res.json({
                success: true,
                message: '批量补全已启动（自动循环直到无缺失）',
                data: { mode: 'loop', limit: processLimit }
            });
        }

        logger.info(`[批量补全] 开始批量生成缩略图，限制: ${processLimit}`);
        
        const result = await batchGenerateMissingThumbnails(processLimit);
        
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
 * 获取缩略图生成状态统计
 * 提供给设置页面显示系统状态
 */
async function getThumbnailStats(req, res) {
    try {
        const { dbGet, dbAll } = require('../db/multi-db');
        
        // 获取各种状态的缩略图数量
        const stats = await Promise.all([
            dbGet('main', 'SELECT COUNT(*) as count FROM thumb_status WHERE status = ?', ['exists']),
            dbGet('main', 'SELECT COUNT(*) as count FROM thumb_status WHERE status = ?', ['missing']),
            dbGet('main', 'SELECT COUNT(*) as count FROM thumb_status WHERE status = ?', ['failed']),
            dbGet('main', 'SELECT COUNT(*) as count FROM thumb_status WHERE status = ?', ['pending']),
            dbGet('main', 'SELECT COUNT(*) as total FROM thumb_status'),
        ]);

        const [existsResult, missingResult, failedResult, pendingResult, totalResult] = stats;
        
        // 如果是调试模式，返回更详细的信息
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
                    activeTasks: global.__thumbActiveCount || 0,
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
                activeTasks: global.__thumbActiveCount || 0
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
 * 生成加载中的SVG占位符
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
 * 生成错误状态的SVG占位符
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
    getThumbnailStats
};