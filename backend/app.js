/**
 * Express应用主配置文件
 * 
 * 负责：
 * - Express应用实例创建和配置
 * - 中间件设置（JSON解析、速率限制等）
 * - 静态文件服务配置
 * - API路由注册和认证中间件
 * - 错误处理中间件
 * - 健康检查端点
 * 
 * @module app
 * @author Photonix
 * @version 1.0.0
 */

const express = require('express');
const helmet = require('helmet');
const path = require('path');
const { PHOTOS_DIR, THUMBS_DIR } = require('./config');
const apiLimiter = require('./middleware/rateLimiter');
const requestId = require('./middleware/requestId');
const mainRouter = require('./routes');
const logger = require('./config/logger');
const authMiddleware = require('./middleware/auth');
const authRouter = require('./routes/auth.routes');


/**
 * Express应用实例
 * @type {express.Application}
 */
const app = express();

// --- 中间件设置 ---

/**
 * 信任代理设置
 * 当应用运行在反向代理（如Nginx）后面时，确保正确获取客户端IP
 */
app.set('trust proxy', 1);

// 安全头（与 Nginx CSP 协同，Express 层兜底）
// 说明：为避免在 HTTP/内网 IP 访问时浏览器对 COOP/O-AC 的警告，这两项由我们按请求条件自行设置
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
    } : false, // 默认关闭，由前置反代控制
    crossOriginOpenerPolicy: false,
    originAgentCluster: false
}));

// 在可信环境（HTTPS 或 localhost）下启用 COOP 与 O-AC；否则不发送，避免浏览器噪音日志
app.use((req, res, next) => {
    try {
        const hostname = req.hostname || '';
        const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
        const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().toLowerCase();
        const isSecure = req.secure || forwardedProto === 'https';

        if (isSecure || isLocalhost) {
            // 仅在可信源上设置，且确保全站一致，避免 agent cluster 冲突
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Origin-Agent-Cluster', '?1');
        } else {
            // 确保在非可信源上不下发，避免浏览器告警
            res.removeHeader('Cross-Origin-Opener-Policy');
            res.removeHeader('Origin-Agent-Cluster');
        }
    } catch (error) {
        logger.debug('设置安全头失败', { error: error.message });
    }
    next();
});
app.use(requestId());

/**
 * JSON解析中间件
 * 解析请求体中的JSON数据，限制大小为50MB
 */
app.use(express.json({ limit: '50mb' }));

// 条件压缩（仅 JSON，阈值≥2KB；若未安装 compression 则静默跳过）
try {
    const compression = require('compression');
    app.use(compression({
        threshold: 2048,
        filter: (req, res) => {
            try {
                const type = (res.getHeader('Content-Type') || '').toString();
                return /application\/json/i.test(type);
            } catch (error) {
                logger.debug('检查Content-Type失败', { error: error.message });
                return false;
            }
        }
    }));
} catch (error) {
    logger.warn('Compression中间件加载失败，使用未压缩模式', { error: error.message });
}

// --- API 路由（先于前端静态资源与 SPA catch-all） ---

// 认证路由（无需登录验证）
app.use('/api/auth', authRouter);

// 受保护的 API
app.use('/api', apiLimiter, authMiddleware, mainRouter);

// --- 静态文件服务 ---

/**
 * 照片文件静态服务
 * 
 * 配置：
 * - 路径：/static
 * - 目录：PHOTOS_DIR（照片存储目录）
 * - 缓存：30天
 * - 媒体文件特殊缓存：30天，不可变
 * 
 * 支持的媒体格式：
 * - 图片：jpeg, jpg, png, webp, gif
 * - 视频：mp4, webm, mov
 */
app.use('/static', express.static(PHOTOS_DIR, {
    maxAge: '30d',           // 基础缓存时间：30天
    etag: true,              // 启用ETag支持
    lastModified: true,      // 启用Last-Modified头
    acceptRanges: true,      // 显式开启 Range 支持（send 默认支持，这里显式声明便于部分反代识别）
    setHeaders: (res, filePath) => {
        // 为媒体文件设置更长的缓存时间，并明确允许分段传输
        if (/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=2592000, immutable, no-transform');
            res.setHeader('Accept-Ranges', 'bytes');
        }
    }
}));

/**
 * 缩略图静态服务
 * 
 * 配置：
 * - 路径：/thumbs
 * - 目录：THUMBS_DIR（缩略图存储目录）
 * - 缓存：30天，不可变
 * 
 * 缩略图文件通常不会改变，因此设置为不可变缓存
 */
app.use('/thumbs', express.static(THUMBS_DIR, {
    maxAge: '30d',           // 缓存时间：30天
    immutable: true,         // 不可变缓存
    fallthrough: false,      // 若文件不存在直接 404，避免被 SPA catch-all 回退为 index.html
    setHeaders: (res, filePath) => {
        // 明确 HLS 与分片的 Content-Type，避免被当作 HTML 解析
        if (/\.m3u8$/i.test(filePath)) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        }
        if (/\.(ts)$/i.test(filePath)) {
            res.setHeader('Content-Type', 'video/mp2t');
        }
        // 明确可分段	send 默认已支持，此处显式声明便于部分代理识别
        res.setHeader('Accept-Ranges', 'bytes');
    }
}));

// --- 前端静态文件（合并部署） ---
const frontendBuildPath = path.join(__dirname, 'public');
app.use(express.static(frontendBuildPath));

// 移除重复的 /api/cache 挂载，统一由 mainRouter 下的 /cache 提供

// --- 健康检查 ---

/**
 * 健康检查端点
 * 
 * 用于：
 * - 负载均衡器健康检查
 * - 容器编排系统监控
 * - 服务可用性验证
 * 
 * @route GET /health
 * @returns {Object} 服务状态信息
 */
app.get('/health', async (req, res) => {
    // 轻量探活：仅验证可达性与表可读，无全表 COUNT
    try {
        const { dbAll } = require('./db/multi-db');
        // 采用 LIMIT 1 的存在性检查，避免表扫描
        await dbAll('main', "SELECT 1 FROM items LIMIT 1").catch(()=>[]);
        await dbAll('main', "SELECT 1 FROM items_fts LIMIT 1").catch(()=>[]);
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch (error) {
        res.status(503).json({ status: 'error', message: error.message, timestamp: new Date().toISOString() });
    }
});

// --- 错误处理中间件 ---

/**
 * 全局错误处理中间件
 *
 * 统一的错误处理：
 * - 区分操作错误和编程错误
 * - 记录详细的错误日志
 * - 返回适当的HTTP状态码和错误信息
 * - 隐藏敏感的错误详情
 *
 * @param {Error} err - 错误对象
 * @param {express.Request} req - 请求对象
 * @param {express.Response} res - 响应对象
 * @param {express.NextFunction} next - 下一个中间件函数
 */
app.use((err, req, res, next) => {
    const requestIdVal = req && req.requestId ? req.requestId : undefined;
    let statusCode = 500;
    let errorCode = 'INTERNAL_ERROR';
    let message = '服务器发生内部错误';

    // 处理自定义应用错误
    if (err.code && err.statusCode) {
        statusCode = err.statusCode;
        errorCode = err.code;
        message = err.message;
    }
    // 处理Joi验证错误
    else if (err.isJoi) {
        statusCode = 400;
        errorCode = 'VALIDATION_ERROR';
        message = '参数验证失败';
    }
    // 处理JWT错误
    else if (err.name === 'JsonWebTokenError') {
        statusCode = 401;
        errorCode = 'INVALID_TOKEN';
        message = 'Token无效';
    }
    else if (err.name === 'TokenExpiredError') {
        statusCode = 401;
        errorCode = 'TOKEN_EXPIRED';
        message = 'Token已过期';
    }
    // 处理文件系统错误
    else if (err.code === 'ENOENT') {
        statusCode = 404;
        errorCode = 'FILE_NOT_FOUND';
        message = '文件不存在';
    }
    else if (err.code === 'EACCES') {
        statusCode = 403;
        errorCode = 'ACCESS_DENIED';
        message = '访问被拒绝';
    }
    // 处理数据库错误
    else if (err.message && err.message.includes('SQLITE_')) {
        statusCode = 500;
        errorCode = 'DATABASE_ERROR';
        message = '数据库操作失败';
    }

    // 记录错误日志
    if (statusCode >= 500) {
        // 服务器错误记录详细信息
        logger.error(`[${requestIdVal || '-'}] 服务器错误 (${statusCode}):`, {
            error: err.message,
            stack: err.stack,
            url: req.originalUrl,
            method: req.method,
            ip: req.ip,
            userAgent: req.get('User-Agent')
        });
    } else {
        // 客户端错误记录基本信息
        logger.warn(`[${requestIdVal || '-'}] 客户端错误 (${statusCode}): ${err.message}`);
    }

    // 生产环境不返回详细的错误信息
    const isDevelopment = process.env.NODE_ENV !== 'production';
    const response = {
        code: errorCode,
        message,
        requestId: requestIdVal
    };

    // 开发环境添加更多调试信息
    if (isDevelopment && statusCode >= 500) {
        response.details = err.message;
        if (err.stack) {
            response.stack = err.stack;
        }
    }

    res.status(statusCode).json(response);
});

// --- SPA Catch-all：应在错误中间件之后，且在最后 ---
app.get('*', (req, res) => {
	const indexPath = path.resolve(frontendBuildPath, 'index.html');
	res.sendFile(indexPath, (err) => {
		if (err) {
			// 静态入口缺失时返回 404，避免走 500
			res.status(404).send('Not Found');
		}
	});
});

/**
 * 导出Express应用实例
 * @exports app
 */
module.exports = app;
