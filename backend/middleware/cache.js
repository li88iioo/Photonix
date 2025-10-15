const { redis } = require('../config/redis');
const logger = require('../config/logger');
const { safeRedisGet, safeRedisSet } = require('../utils/helpers');
const { addTagsToKey } = require('../services/cache.service.js');
const { QueryCacheOptimizer } = require('../services/queryOptimizer.service.js');

/**
 * 缓存命中/未命中/总请求计数
 * @type {{ hits: number, misses: number, totalRequests: number }}
 */
const cacheStats = { hits: 0, misses: 0, totalRequests: 0 };

/**
 * 记录正在构建缓存的 Promise，避免并发穿透
 * @type {Map<string, Promise<any>>}
 */
const inFlight = new Map();
/**
 * 记录 inFlight 请求的时间戳，用于超时清理
 * @type {Map<string, number>}
 */
const inFlightTimestamps = new Map();

/** 单个 inFlight 超时时间(ms) */
const INFLIGHT_TIMEOUT_MS = 8000;
/** inFlight 清理时间间隔(ms)，默认5分钟 */
const INFLIGHT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 定期清理超时的 inFlight 请求，防止内存泄漏
 */
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, timestamp] of inFlightTimestamps.entries()) {
        // 超过两倍超时时间未更新则清除
        if ((now - timestamp) > INFLIGHT_TIMEOUT_MS * 2) {
            inFlight.delete(key);
            inFlightTimestamps.delete(key);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        logger.debug(`[CACHE CLEANUP] 清理了 ${cleaned} 个超时的inFlight请求`);
    }
}, INFLIGHT_CLEANUP_INTERVAL_MS);

/**
 * 根据请求信息生成缓存标签(tag)，用于细粒度缓存失效和依赖管理
 * @param {import('express').Request} req
 * @returns {string[]} 标签数组
 */
function generateTagsFromReq(req) {
    const tags = new Set();
    const url = req.originalUrl || req.url;
    const urlParts = new URL(url, 'http://local');
    const routePath = urlParts.pathname;

    // 设置类路由标签
    if (routePath.startsWith('/api/settings')) {
        tags.add('settings');
    }
    if (routePath.startsWith('/api/thumbnail')) {
        const itemPath = urlParts.searchParams.get('path');
        if (itemPath) tags.add(`item:${itemPath}`);
    }
    if (routePath.startsWith('/api/browse')) {
        // album 类标签
        const browsePath = routePath.substring('/api/browse'.length).replace(/^\/|\/$/g, '');
        tags.add('album:/');
        if (browsePath) {
            const segments = browsePath.split('/').filter(Boolean);
            let currentPath = '';
            for (const segment of segments) {
                currentPath = `${currentPath}/${segment}`;
                tags.add(`album:${currentPath}`);
            }
        }
    }

    // 专门处理缩略图API的标签
    if (routePath.startsWith('/api/thumbnail')) {
        const thumbPath = req.query.path;
        if (thumbPath) {
            // 缩略图自身标签
            tags.add(`thumbnail:${thumbPath}`);

            // 所属相册标签
            const dirname = thumbPath.substring(0, thumbPath.lastIndexOf('/') + 1);
            tags.add(`album:${dirname || '/'}`);
            tags.add('album:/');
        }
    }
    return Array.from(tags);
}

/**
 * 单飞(SingleFlight)并发去抖: 同一个key的请求只会触发一次producer，其它请求等待
 * @param {string} key 标识
 * @param {function():Promise<any>} producer 主体异步函数
 * @returns {Promise<any>} 共享的异步结果
 */
async function singleflight(key, producer) {
    const isLeader = !inFlight.has(key);
    if (isLeader) {
        // 领导者请求, 执行producer并记录
        const p = (async () => {
            try { return await producer(); }
            finally {
                setTimeout(() => {
                    inFlight.delete(key);
                    inFlightTimestamps.delete(key);
                }, 0);
            }
        })();
        inFlight.set(key, p);
        inFlightTimestamps.set(key, Date.now());
        // 领导者不设超时（核心缓存创写）
        return p;
    } else {
        // 跟随者最多等待 INFLIGHT_TIMEOUT_MS, 避免挂死所有等待者
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('singleflight_timeout')), INFLIGHT_TIMEOUT_MS));
        return Promise.race([inFlight.get(key), timeout]);
    }
}

/** 单次最大可缓存体积 1MB */
const MAX_CACHEABLE_BYTES = 1024 * 1024;

/**
 * 构建缓存封包(envelope)，序列化所有响应信息
 * @param {import('express').Response} res
 * @param {Buffer|string|object} body
 * @returns {object|null} 可用返回值为带 __cached_envelope 字段的对象，否则为 null
 */
function buildEnvelope(res, body) {
    const contentType = res.get('Content-Type') || 'application/octet-stream';
    let isBase64 = false, payload;
    if (Buffer.isBuffer(body)) {
        isBase64 = true;
        payload = body.toString('base64');
    } else {
        payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    if (payload && payload.length > MAX_CACHEABLE_BYTES) return null;
    return { __cached_envelope: 1, status: res.statusCode || 200, headers: { 'Content-Type': contentType }, body: payload, isBase64 };
}

/**
 * 重放封包响应 (缓存命中分支)
 * @param {import('express').Response} res
 * @param {object} envelope buildEnvelope 返回的缓存对象
 */
function replayEnvelope(res, envelope) {
    res.setHeader('Vary', 'Authorization');
    if (envelope.headers && envelope.headers['Content-Type']) {
        res.setHeader('Content-Type', envelope.headers['Content-Type']);
    }
    const status = envelope.status || 200;
    const body = envelope.body || '';
    return res.status(status).send(envelope.isBase64 ? Buffer.from(body, 'base64') : body);
}

/**
 * 动态挂载Response写入钩子以便缓存响应内容
 * @param {import('express').Response} res
 * @param {string} key 缓存 key
 * @param {number} ttlSeconds 生存秒数
 * @returns {import('express').Response}
 */
function attachWritersWithCache(res, key, ttlSeconds) {
    let streamingWritten = false;
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const originalSend = res.send.bind(res);
    const originalJson = res.json.bind(res);

    /**
     * 响应正文成型后尝试进行缓存并打标签
     * @param {*} body
     */
    const cacheAndTag = (body) => {
        try {
            if (!streamingWritten && res.statusCode >= 200 && res.statusCode < 300 && res.req && res.req.method === 'GET') {
                const env = buildEnvelope(res, body);
                if (env) {
                    safeRedisSet(redis, key, JSON.stringify(env), 'EX', ttlSeconds, '路由缓存')
                        .then(() => {
                            const tags = generateTagsFromReq(res.req);
                            if (tags.length > 0) addTagsToKey(key, tags);
                        })
                        .catch(err => logger.debug(`缓存或标记失败 for key ${key}:`, err));
                }
            }
        } catch (e) { logger.debug(`缓存封装或标记过程中出错 for key ${key}:`, e); }
    };

    // streaming/大二进制类型 不缓存
    res.write = (chunk, encoding, cb) => { streamingWritten = true; return originalWrite(chunk, encoding, cb); };
    res.end = (chunk, encoding, cb) => { if (chunk && !res.headersSent) cacheAndTag(chunk); return originalEnd(chunk, encoding, cb); };
    res.send = (body) => { cacheAndTag(body); return originalSend(body); };
    res.json = (body) => { if (!res.get('Content-Type')) res.set('Content-Type', 'application/json; charset=utf-8'); cacheAndTag(body); return originalJson(body); };

    return res;
}

/**
 * 路由级缓存中间件
 * @param {number} duration 缓存有效秒数，默认300
 * @returns {import('express').RequestHandler}
 */
function cache(duration) {
    return async (req, res, next) => {
        if (req.method !== 'GET') return next();
        if (redis && redis.isNoRedis) return next();

        // 仅信任通过认证的 req.user.id，未认证一律 anonymous，防止缓存键爆炸劫持
        const userId = (req.user && req.user.id) ? String(req.user.id) : 'anonymous';

        // 某些路由按 userId 隔离缓存，避免不同用户数据互串
        const urlObj = new URL(req.originalUrl, 'http://local');
        const pathname = urlObj.pathname || '';
        const sortParam = (urlObj.searchParams.get('sort') || 'smart').toLowerCase();
        let bucket = 'public';
        if (pathname.startsWith('/api/browse')) {
            const suffix = pathname.substring('/api/browse'.length);
            const isSubdir = !!(suffix && suffix !== '/');
            if (sortParam === 'viewed_desc' || (sortParam === 'smart' && isSubdir)) {
                bucket = userId !== 'anonymous' ? `user:${userId}` : 'public';
            }
        }
        const isUserScoped = bucket.startsWith('user:');
        const key = `route_cache:${bucket}:${req.originalUrl}`;
        const cacheDuration = duration || 300;
        const cacheControlValue = `${isUserScoped ? 'private' : 'public'}, max-age=${cacheDuration}`;

        try {
            cacheStats.totalRequests++;
            let cachedData = await safeRedisGet(redis, key, '路由缓存读取');

            if (cachedData) {
                // 缓存命中处理
                cacheStats.hits++;
                logger.debug(`成功命中路由缓存: ${key}`);
                res.setHeader('X-Cache', 'HIT');
                try {
                    const parsed = JSON.parse(cachedData);
                    if (parsed && parsed.__cached_envelope === 1) {
                        res.setHeader('Cache-Control', cacheControlValue);
                        return replayEnvelope(res, parsed);
                    }
                } catch (error) {
                    logger.debug(`[CACHE] 解析缓存条目失败，降级为未命中: ${error && error.message}`);
                }
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Cache-Control', cacheControlValue);
                res.setHeader('Vary', 'Authorization');
                return res.send(cachedData);
            }

            // 缓存未命中逻辑
            cacheStats.misses++;
            res.setHeader('X-Cache', 'MISS');
            res.setHeader('Vary', 'Authorization');
            res.setHeader('Cache-Control', cacheControlValue);

            // 先附加 writer 钩子保证只要响应经过都能被缓存
            attachWritersWithCache(res, key, cacheDuration);

            // 使用 singleflight 限流构建逻辑，领导者负责缓存创写，跟随者等待
            singleflight(`build:${key}`, async () => {}).catch(() => {
                // 跟随者超时，容错直通主业务
                next();
            });

            next();
        } catch (err) {
            logger.debug(`缓存中间件出错 for key ${key}:`, err.message);
            next();
        }
    };
}

/**
 * Redis SCAN 批量删除工具（支持大规模扫描删key）
 * @param {string} pattern 通配符匹配（如 route_cache:*）
 * @returns {Promise<number>} 实际删除的 key 数
 */
async function scanAndDelete(pattern) {
    let cursor = '0', total = 0;
    const BATCH = 200;
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = next;
        if (keys && keys.length) {
            for (let i = 0; i < keys.length; i += BATCH) {
                const slice = keys.slice(i, i + BATCH);
                const pipeline = redis.pipeline();
                slice.forEach(k => {
                    if (typeof redis.unlink === 'function') {
                        pipeline.unlink(k);
                    } else {
                        pipeline.del(k);
                    }
                });
                await pipeline.exec();
                total += slice.length;
            }
        }
    } while (cursor !== '0');
    return total;
}

/**
 * 调用 scanAndDelete 清空缓存的HTTP处理器
 * @param {string} pattern 匹配模式(默认全部)
 * @returns {import('express').RequestHandler}
 */
function clearCache(pattern = '*') {
    return async (req, res) => {
        try {
            const cleared = await scanAndDelete(pattern);
            res.json({ success: true, clearedKeys: cleared });
        } catch (error) {
            logger.error('清理缓存失败:', error);
            res.status(500).json({ error: '清理缓存失败' });
        }
    };
}

module.exports = {
    cache,
    clearCache,
    getCacheStats: () => cacheStats,
    scanAndDelete
};