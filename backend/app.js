/**
 * @file Express 应用主配置文件
 * @module app
 * @author Photonix
 * @version 1.0.0
 * @description
 * 主要职责:
 * 1. 创建并配置 Express 应用实例
 * 2. 配置全局中间件: JSON 解析、安全、请求追踪等
 * 3. 配置静态资源（原图/缩略图/前端打包）
 * 4. 注册 API 路由及认证/限流中间件
 * 5. 健康检查、404 和全局错误处理
 */

const express = require('express');
const helmet = require('helmet');
const path = require('path');
const { PHOTOS_DIR, THUMBS_DIR } = require('./config');
const { rateLimiterMiddleware } = require('./middleware/rateLimiter');
const requestId = require('./middleware/requestId');
const { traceMiddleware } = require('./utils/trace');
const mainRouter = require('./routes');
const logger = require('./config/logger');
const authMiddleware = require('./middleware/auth');
const authRouter = require('./routes/auth.routes');
const { watcherRestartMiddleware } = require('./middleware/watcherRestart');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

/**
 * @const {express.Application} app Express 应用实例
 */
const app = express();

// ========== 中间件配置 ==========

/**
 * 设置信任代理, 以便在反向代理后获取真实客户端 IP
 */
app.set('trust proxy', 1);

/**
 * 配置安全头。对于 CSP、COOP 和 O-AC，仅在需要时按请求动态设置，
 * 默认由前置反代/网关控制。
 */
const ENABLE_APP_CSP = (process.env.ENABLE_APP_CSP || 'false').toLowerCase() === 'true';
app.use(helmet({
    contentSecurityPolicy: ENABLE_APP_CSP ? {
        useDefaults: true,
        directives: {
            defaultSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'blob:'],
            mediaSrc: ["'self'", 'blob:'],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'self'"],
            upgradeInsecureRequests: null
        }
    } : false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false
}));

/**
 * 动态设置 Cross-Origin-Opener-Policy & Origin-Agent-Cluster
 * 只在 HTTPS 或 localhost 环境下设置，避免内网 HTTP 警告
 */
app.use((req, res, next) => {
    try {
        const hostname = req.hostname || '';
        const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
        const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().toLowerCase();
        const isSecure = req.secure || forwardedProto === 'https';

        if (isSecure || isLocalhost) {
            // 可信请求设置 COOP 和 O-AC
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Origin-Agent-Cluster', '?1');
        } else {
            // 非可信环境下移除
            res.removeHeader('Cross-Origin-Opener-Policy');
            res.removeHeader('Origin-Agent-Cluster');
        }
    } catch (error) {
        logger.debug('设置安全头失败', { error: error.message });
    }
    next();
});

/**
 * 请求 ID 与分布式追踪中间件
 */
app.use(requestId());
app.use(traceMiddleware);

/**
 * JSON 请求体解析，大小限制为 1MB
 */
app.use(express.json({ limit: '1mb' }));

/**
 * 条件 Gzip 压缩，仅针对 JSON 内容且 ≥2KB。未安装 compression 时警告但不阻断。
 */
try {
    const compression = require('compression');
    app.use(compression({
        threshold: 2048,
        filter: (req, res) => {
            if (!compression.filter(req, res)) {
                return false;
            }
            try {
                const explicitType = res.getHeader('Content-Type');
                if (explicitType) {
                    return /application\/json/i.test(String(explicitType));
                }
                const acceptHeader = req.headers['accept'];
                if (typeof acceptHeader === 'string' && acceptHeader.length > 0) {
                    return /application\/json|\*\//i.test(acceptHeader);
                }
                return true;
            } catch (error) {
                logger.debug('检查Content-Type失败', { error: error.message });
                return true;
            }
        }
    }));
} catch (error) {
    logger.warn('Compression中间件加载失败，使用未压缩模式', { error: error.message });
}

// ========== API 路由配置 ==========

/**
 * 监听器自动重启中间件（保护诸如数据变更后自动重启服务的机制）
 */
app.use(watcherRestartMiddleware);

/**
 * 认证相关路由（无需认证）
 */
app.use('/api/auth', authRouter);

/**
 * 受保护的 API 路由，依次经过限流、认证、总路由
 */
app.use('/api', rateLimiterMiddleware, authMiddleware, mainRouter);

// ========== 静态文件服务 ==========

/**
 * @section 照片原图静态服务
 * 路径: /static
 * 位置: PHOTOS_DIR
 * 支持多媒体类型：图片(jpeg/png/webp/gif), 视频(mp4/webm/mov)
 * 缓存策略：30 天
 */
app.use('/static', express.static(PHOTOS_DIR, {
    maxAge: '30d',
    etag: true,
    lastModified: true,
    acceptRanges: true,
    setHeaders: (res, filePath) => {
        if (/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=2592000, immutable, no-transform');
            res.setHeader('Accept-Ranges', 'bytes');
        }
    }
}));

/**
 * @section 缩略图静态服务
 * 路径: /thumbs
 * 位置: THUMBS_DIR
 * 所有缩略图均为不可变，30 天缓存，不存在时直接 404
 * 包含 HLS/TS 格式分片额外声明 Content-Type
 */
app.use('/thumbs', express.static(THUMBS_DIR, {
    maxAge: '30d',
    immutable: true,
    fallthrough: false,
    setHeaders: (res, filePath) => {
        if (/\.m3u8$/i.test(filePath)) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        }
        if (/\.(ts)$/i.test(filePath)) {
            res.setHeader('Content-Type', 'video/mp2t');
        }
        res.setHeader('Accept-Ranges', 'bytes');
    }
}));

/**
 * @section 前端静态文件（合并部署场景）
 * 根目录 public 下资源由前端构建工具生成
 */
const frontendBuildPath = path.join(__dirname, 'public');
app.use(express.static(frontendBuildPath));

// ========== 健康检查 ==========

/**
 * 健康检查 API
 * @route GET /health
 * @returns {object} 服务状态摘要
 * 用于负载均衡器、容器编排平台自动探活与监控
 */
app.get('/health', async (req, res) => {
    const timestamp = new Date().toISOString();
    const summary = {
        status: 'ok',
        timestamp,
        issues: [],
        dependencies: {
            database: {},
            redis: {},
            workers: {}
        }
    };

    let healthy = true;

    // 数据库健康检查
    try {
        const { dbAll, checkDatabaseHealth, dbHealthStatus } = require('./db/multi-db');
        await checkDatabaseHealth();
        const connections = {};
        for (const [name, state] of dbHealthStatus.entries()) {
            connections[name] = state;
        }
        summary.dependencies.database.connections = connections;
        const connectionStates = Object.values(connections);
        const connectionsHealthy = connectionStates.length === 0 || connectionStates.every((state) => state === 'connected');
        if (!connectionsHealthy) {
            healthy = false;
            summary.issues.push('database_connections');
        }

        const schema = {};
        try {
            await dbAll('main', "SELECT 1 FROM items LIMIT 1");
            schema.items = { status: 'ok' };
        } catch (error) {
            schema.items = { status: 'missing', error: error.message };
            healthy = false;
            summary.issues.push('items_table');
        }

        try {
            await dbAll('main', "SELECT 1 FROM items_fts LIMIT 1");
            schema.itemsFts = { status: 'ok' };
        } catch (error) {
            schema.itemsFts = { status: 'missing', error: error.message };
            healthy = false;
            summary.issues.push('items_fts_table');
        }

        summary.dependencies.database.schema = schema;
    } catch (error) {
        healthy = false;
        summary.issues.push('database_error');
        summary.dependencies.database.error = error.message;
    }

    // Redis 健康检查
    try {
        const { getAvailability, redis } = require('./config/redis');
        const availability = getAvailability();
        summary.dependencies.redis.availability = availability;
        const redisRequired = (process.env.ENABLE_REDIS || 'false').toLowerCase() === 'true';

        if (availability === 'ready') {
            try {
                summary.dependencies.redis.ping = await redis.ping();
            } catch (error) {
                healthy = false;
                summary.issues.push('redis_ping');
                summary.dependencies.redis.error = error.message;
            }
        } else if (redisRequired) {
            healthy = false;
            summary.issues.push('redis_unavailable');
        }
    } catch (error) {
        healthy = false;
        summary.issues.push('redis_error');
        summary.dependencies.redis.error = error.message;
    }

    // Worker 健康检查
    try {
        const { performWorkerHealthCheck } = require('./services/worker.manager');
        const workerStatus = performWorkerHealthCheck();
        summary.dependencies.workers = workerStatus;
        const unhealthyWorkers = [];
        ['indexing', 'settings', 'history', 'video'].forEach((key) => {
            const stateInfo = workerStatus[key];
            if (!stateInfo) {
                unhealthyWorkers.push(key);
                return;
            }
            const workerState = typeof stateInfo === 'string' ? stateInfo : stateInfo.state;
            if (!workerState || workerState !== 'active') {
                unhealthyWorkers.push(key);
            }
        });
        if (unhealthyWorkers.length > 0) {
            healthy = false;
            unhealthyWorkers.forEach((name) => summary.issues.push(`worker_${name}`));
        }
    } catch (error) {
        healthy = false;
        summary.issues.push('worker_error');
        summary.dependencies.workers = { error: error.message };
    }

    if (!healthy) {
        summary.status = 'error';
        return res.status(503).json(summary);
    }

    return res.json(summary);
});

/**
 * API 404 处理，响应所有未匹配的 /api/* 路由
 * 必须在错误处理中间件与前端 SPA catch-all 之前注册
 */
app.use('/api/*', notFoundHandler);

/**
 * 全局错误处理中间件，要放在所有路由之后
 */
app.use(errorHandler);

/**
 * SPA 应用入口的 Catch-all 路由，错误中间件之后最后注册
 * 若前端 index.html 缺失则直接返回 404
 */
app.get('*', (req, res) => {
	const indexPath = path.resolve(frontendBuildPath, 'index.html');
	res.sendFile(indexPath, (err) => {
		if (err) {
			res.status(404).send('Not Found');
		}
	});
});

/**
 * 导出 Express 应用实例
 */
module.exports = app;
