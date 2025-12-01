/**
 * @file app.js
 * @module app
 * @author Photonix
 * @version 1.0.0
 * @description Express 主应用配置
 * 
 * 职责：
 * 1. 创建与配置 Express 应用实例
 * 2. 注册全局中间件（如安全、JSON 解析、请求追踪等）
 * 3. 提供静态资源服务（原图、缩略图、前端构建产物）
 * 4. 注册 API 路由及相关中间件（认证、限流等）
 * 5. 健康检查、404 及全局错误处理
 */

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const { PHOTOS_DIR, THUMBS_DIR } = require('./config');
const { rateLimiterMiddleware } = require('./middleware/rateLimiter');
const requestId = require('./middleware/requestId');
const { traceMiddleware } = require('./utils/trace');
const mainRouter = require('./routes');
const logger = require('./config/logger');
const authMiddleware = require('./middleware/auth');
const authRouter = require('./routes/auth.routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const HEALTH_CACHE_TTL_MS = Number(process.env.HEALTH_CACHE_TTL_MS || 30000);
let healthCache = { snapshot: null, expiresAt: 0 };
let pendingHealthCheckPromise = null;

function parseWorkerList(value, fallback = []) {
    if (typeof value === 'string' && value.trim().length > 0) {
        return value.split(',').map((name) => name.trim()).filter(Boolean);
    }
    return fallback;
}

const REQUIRED_WORKERS = new Set(parseWorkerList(process.env.HEALTH_REQUIRED_WORKERS, ['indexing']));
const OPTIONAL_WORKERS = new Set(
    parseWorkerList(process.env.HEALTH_OPTIONAL_WORKERS, ['settings', 'video'])
        .filter((name) => !REQUIRED_WORKERS.has(name))
);

/**
 * @constant {express.Application} app Express 应用实例
 */
const app = express();

/* =========================
   中间件配置
   ========================= */

/**
 * 配置代理信任，用于获取真实客户端 IP。
 */
app.set('trust proxy', 1);

/**
 * 安全相关 HTTP 头设置。
 * - CSP 依据 ENV 动态启用；
 * - COOP, O-AC 另由自定义中间件动态设置（下方）。
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
            upgradeInsecureRequests: null,
        },
    } : false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
}));

/**
 * 动态设置 Cross-Origin-Opener-Policy/Origin-Agent-Cluster。
 * 仅当 HTTPS 或 localhost 时设置。
 */
app.use((req, res, next) => {
    try {
        const hostname = req.hostname || '';
        const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
        const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().toLowerCase();
        const isSecure = req.secure || forwardedProto === 'https';
        if (isSecure || isLocalhost) {
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Origin-Agent-Cluster', '?1');
        } else {
            res.removeHeader('Cross-Origin-Opener-Policy');
            res.removeHeader('Origin-Agent-Cluster');
        }
    } catch (error) {
        logger.debug('设置安全头失败', { error: error.message });
    }
    next();
});

/**
 * 请求追踪与分布式 Trace。
 */
app.use(requestId());
app.use(traceMiddleware);

/**
 * JSON 请求体解析，限制体积 1MB。
 */
app.use(express.json({ limit: '1mb' }));

/**
 * Cookie 解析中间件，支持从 httpOnly cookie 读取认证 token
 */
app.use(cookieParser());

/**
 * 有条件启用 Gzip 压缩，仅压缩 ≥2KB 且类型为 JSON 的响应。
 * 未安装依赖时仅报警告。
 */
try {
    const compression = require('compression');
    app.use(
        compression({
            threshold: 2048,
            filter: (req, res) => {
                if (!compression.filter(req, res)) return false;
                try {
                    const explicitType = res.getHeader('Content-Type');
                    if (explicitType) return /application\/json/i.test(String(explicitType));
                    const acceptHeader = req.headers['accept'];
                    if (typeof acceptHeader === 'string' && acceptHeader.length > 0)
                        return /application\/json|\*\//i.test(acceptHeader);
                    return true;
                } catch (error) {
                    logger.debug('检查Content-Type失败', { error: error.message });
                    return true;
                }
            },
        })
    );
} catch (error) {
    logger.warn('Compression中间件加载失败，使用未压缩模式', { error: error.message });
}

/* =========================
   API 路由配置
   ========================= */

/**
 * 认证相关接口（不需登录）
 * 路径前缀：/api/auth
 */
app.use('/api/auth', authRouter);

/**
 * 其他 API（需登录、限流、再到主路由）
 * 路径前缀：/api
 */
app.use('/api', rateLimiterMiddleware, authMiddleware, mainRouter);

/* =========================
   静态文件服务
   ========================= */

/**
 * 原图静态资源服务
 * 路径：/static
 * 目录：PHOTOS_DIR
 * 类型：图片、视频
 * 缓存：30 天
 */
app.use(
    '/static',
    express.static(PHOTOS_DIR, {
        maxAge: '30d',
        etag: true,
        lastModified: true,
        acceptRanges: true,
        setHeaders: (res, filePath) => {
            if (/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(filePath)) {
                res.setHeader('Cache-Control', 'public, max-age=2592000, immutable, no-transform');
                res.setHeader('Accept-Ranges', 'bytes');
            }
        },
    })
);

/**
 * 缩略图静态服务
 * 路径：/thumbs
 * 目录：THUMBS_DIR
 * 恒定可缓存 30 天，不存在则立即 404。
 * 特定扩展额外指定 Content-Type。
 */
app.use(
    '/thumbs',
    express.static(THUMBS_DIR, {
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
        },
    })
);

/**
 * 前端静态资源服务（如合并部署）
 * 目录：public
 */
const frontendBuildPath = path.join(__dirname, 'public');
app.use(express.static(frontendBuildPath));

/* =========================
   健康检查
   ========================= */

/**
 * 构建健康检查摘要信息
 * @returns {Promise<object>} 服务健康状态报告
 */
async function computeHealthSummary() {
    const timestamp = new Date().toISOString();
    const summary = {
        status: 'ok',
        timestamp,
        issues: [],
        dependencies: {
            database: {},
            redis: {},
            workers: {},
        },
    };

    let healthy = true;

    try {
        const { dbAll, checkDatabaseHealth, dbHealthStatus } = require('./db/multi-db');
        await checkDatabaseHealth();
        const connections = {};
        for (const [name, state] of dbHealthStatus.entries()) {
            connections[name] = state;
        }
        summary.dependencies.database.connections = connections;
        const connectionStates = Object.values(connections);
        const connectionsHealthy =
            connectionStates.length === 0 ||
            connectionStates.every((state) => state === 'connected');
        if (!connectionsHealthy) {
            healthy = false;
            summary.issues.push('database_connections');
        }

        const schema = {};
        try {
            await dbAll('main', 'SELECT 1 FROM items LIMIT 1');
            schema.items = { status: 'ok' };
        } catch (error) {
            schema.items = { status: 'missing', error: error.message };
            healthy = false;
            summary.issues.push('items_table');
        }

        try {
            await dbAll('main', 'SELECT 1 FROM items_fts LIMIT 1');
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

    try {
        const { getAvailability, redis } = require('./config/redis');
        const availability = getAvailability();
        summary.dependencies.redis.availability = availability;
        const redisRequired =
            (process.env.ENABLE_REDIS || 'false').toLowerCase() === 'true';

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

    try {
        const { performWorkerHealthCheck } = require('./services/worker.manager');
        const workerStatus = performWorkerHealthCheck() || {};
        const decoratedWorkers = {};
        const requiredWorkers = REQUIRED_WORKERS.size > 0 ? REQUIRED_WORKERS : new Set(['indexing']);
        const optionalWorkers = OPTIONAL_WORKERS;

        Object.entries(workerStatus).forEach(([key, stateInfo]) => {
            const normalizedInfo = typeof stateInfo === 'object' && stateInfo !== null
                ? stateInfo
                : { state: stateInfo };
            const baseActive = typeof normalizedInfo.state === 'string'
                ? normalizedInfo.state === 'active'
                : Boolean(normalizedInfo.active);
            const workerActive = Boolean(baseActive);
            const isRequired = requiredWorkers.has(key);
            const status = workerActive
                ? 'active'
                : (isRequired ? 'unavailable' : (optionalWorkers.has(key) ? 'inactive_optional' : 'inactive'));

            decoratedWorkers[key] = {
                ...normalizedInfo,
                active: workerActive,
                status
            };

            if (isRequired && !workerActive) {
                healthy = false;
                summary.issues.push(`worker_${key}`);
            }
        });

        requiredWorkers.forEach((key) => {
            if (!decoratedWorkers[key]) {
                decoratedWorkers[key] = { active: false, status: 'missing' };
                healthy = false;
                summary.issues.push(`worker_${key}`);
            }
        });

        summary.dependencies.workers = decoratedWorkers;
    } catch (error) {
        healthy = false;
        summary.issues.push('worker_error');
        summary.dependencies.workers = { error: error.message };
    }

    if (!healthy) {
        summary.status = 'error';
    }

    return summary;
}

/**
 * 返回并缓存健康检查摘要
 * @returns {Promise<object>}
 */
async function getHealthSummary() {
    const now = Date.now();
    if (healthCache.snapshot && now < healthCache.expiresAt) {
        return healthCache.snapshot;
    }

    // Atomic check-and-set: only create Promise if none exists
    if (!pendingHealthCheckPromise) {
        pendingHealthCheckPromise = computeHealthSummary()
            .then((summary) => {
                const ttl =
                    summary.status === 'ok'
                        ? HEALTH_CACHE_TTL_MS
                        : Math.min(HEALTH_CACHE_TTL_MS, 5000);
                healthCache = {
                    snapshot: summary,
                    expiresAt: Date.now() + ttl,
                };
                return summary;
            })
            .finally(() => {
                pendingHealthCheckPromise = null;
            });
    }
    return pendingHealthCheckPromise;
}

/**
 * GET /health
 * 健康检查接口，返回服务状态报告
 * 200/503，根据状态
 */
app.get('/health', async (req, res) => {
    try {
        const summary = await getHealthSummary();
        const statusCode = summary.status === 'ok' ? 200 : 503;
        return res.status(statusCode).json(summary);
    } catch (error) {
        logger.error('Health endpoint failed', { error: error.message });
        return res.status(500).json({
            status: 'error',
            timestamp: new Date().toISOString(),
            issues: ['health_unhandled'],
            dependencies: {},
            error: error.message,
        });
    }
});

/**
 * API 未匹配路径 404 处理（应放在 SPA 和全局错误之前）
 */
app.use('/api/*', notFoundHandler);

/**
 * 全局错误处理（必须 Router 之后）
 */
app.use(errorHandler);

/**
 * SPA 前端单页支持（兜底，index.html 不存在则返回 404）
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
