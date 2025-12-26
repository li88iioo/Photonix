const { redis } = require('../config/redis');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const { safeRedisGet, safeRedisSet } = require('../utils/helpers');
const { addTagsToKey } = require('../services/cache.service.js');

/**
 * 缓存命中/未命中/总请求计数
 * @type {{ hits: number, misses: number, totalRequests: number }}
 */
const cacheStats = { hits: 0, misses: 0, totalRequests: 0 };

/**
 * SingleFlight 控制表，确保缓存 miss 时只有一个请求负责重建缓存。
 * key -> { promise, resolve, reject, createdAt }
 */
const singleFlightEntries = new Map();
const SINGLE_FLIGHT_WAIT_TIMEOUT_MS = Number(process.env.CACHE_SINGLEFLIGHT_WAIT_TIMEOUT_MS || 10000);
const SINGLE_FLIGHT_STALE_MS = Number(process.env.CACHE_SINGLEFLIGHT_STALE_MS || 30000);
const SINGLE_FLIGHT_CLEANUP_INTERVAL_MS = Number(process.env.CACHE_SINGLEFLIGHT_CLEANUP_INTERVAL_MS || 60000);

function acquireSingleFlight(key) {
    const existing = singleFlightEntries.get(key);
    if (existing) {
        return { isLeader: false, promise: existing.promise, entry: existing };
    }
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });
    const entry = {
        promise,
        resolve: resolveFn,
        reject: rejectFn,
        createdAt: Date.now()
    };
    // 预附加 catch，避免在没有跟随者时触发未处理的 Promise 拒绝日志
    promise.catch(() => { });
    singleFlightEntries.set(key, entry);
    return { isLeader: true, promise, entry };
}

function resolveSingleFlight(key, entry) {
    const current = singleFlightEntries.get(key);
    if (current !== entry) return;
    singleFlightEntries.delete(key);
    entry.resolve();
}

function rejectSingleFlight(key, entry, error) {
    const current = singleFlightEntries.get(key);
    if (current !== entry) return;
    singleFlightEntries.delete(key);
    entry.reject(error);
}

const singleFlightCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of singleFlightEntries.entries()) {
        if (now - entry.createdAt > SINGLE_FLIGHT_STALE_MS) {
            rejectSingleFlight(key, entry, new Error('singleflight_stale'));
        }
    }
}, SINGLE_FLIGHT_CLEANUP_INTERVAL_MS);
singleFlightCleanupTimer.unref?.();

function waitWithTimeout(promise, timeoutMs, message = 'singleflight_timeout') {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        promise
            .then((value) => {
                clearTimeout(timer);
                resolve(value);
            })
            .catch((err) => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

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
            const segments = browsePath.split('/').filter(Boolean).map(segment => {
                try {
                    return decodeURIComponent(segment);
                } catch (error) {
                    return segment;
                }
            });
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
            // 新增：如果响应标记为不缓存（如封面未就绪），则跳过缓存
            if (res.get('X-No-Cache') === 'true') {
                logger.debug(`${LOG_PREFIXES.CACHE} 响应标记为不缓存，跳过: ${key}`);
                return;
            }
            if (!streamingWritten && res.statusCode >= 200 && res.statusCode < 300 && res.req && res.req.method === 'GET') {
                const env = buildEnvelope(res, body);
                if (env) {
                    // 新增：支持响应头指定自定义 TTL（如空结果使用短 TTL）
                    const customTtl = res.get('X-Cache-TTL');
                    const effectiveTtl = customTtl ? parseInt(customTtl, 10) : ttlSeconds;
                    const finalTtl = Number.isFinite(effectiveTtl) && effectiveTtl > 0 ? effectiveTtl : ttlSeconds;

                    safeRedisSet(redis, key, JSON.stringify(env), 'EX', finalTtl, '路由缓存')
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
        // Redis 不可用或近期标记绕过时直接走实时路径，避免陈旧缓存导致空白卡片
        const bypassRouteCache = (global.__PH_ROUTE_CACHE_BYPASS_UNTIL && Date.now() < global.__PH_ROUTE_CACHE_BYPASS_UNTIL);
        if ((redis && redis.isNoRedis) || bypassRouteCache) {
            return next();
        }

        // 仅信任通过认证的 req.user.id，未认证一律 anonymous，防止缓存键爆炸劫持
        const userId = (req.user && req.user.id) ? String(req.user.id) : 'anonymous';

        // 某些路由按 userId 隔离缓存，避免不同用户数据互串
        const urlObj = new URL(req.originalUrl, 'http://local');
        const pathname = urlObj.pathname || '';
        const sortParam = (urlObj.searchParams.get('sort') || 'smart').toLowerCase();
        let bucket = 'public';
        if (pathname.startsWith('/api/browse')) {
            // smart 模式依赖用户视图信息，因此需要按用户隔离缓存
            if (sortParam === 'smart') {
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
                res.setHeader('X-Cache', 'HIT');
                try {
                    const parsed = JSON.parse(cachedData);
                    if (parsed && parsed.__cached_envelope === 1) {
                        res.setHeader('Cache-Control', cacheControlValue);
                        return replayEnvelope(res, parsed);
                    }
                } catch (error) {
                    logger.debug(`${LOG_PREFIXES.CACHE} 解析缓存条目失败，降级为未命中: ${error && error.message}`);
                }
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Cache-Control', cacheControlValue);
                res.setHeader('Vary', 'Authorization');
                return res.send(cachedData);
            }

            // 缓存未命中逻辑
            res.setHeader('Vary', 'Authorization');
            res.setHeader('Cache-Control', cacheControlValue);

            const handleLeaderResponse = (flightOwner) => {
                cacheStats.misses++;
                res.setHeader('X-Cache', 'MISS');
                attachWritersWithCache(res, key, cacheDuration);

                let settled = false;
                const settle = (err) => {
                    if (settled) return;
                    settled = true;
                    if (!flightOwner?.entry) return;
                    if (err) {
                        const reason = err && err.message ? err.message : 'unknown';
                        const logLevel = reason === 'response_aborted' ? 'debug' : 'error';
                        const logMessage = reason === 'response_aborted'
                            ? `${LOG_PREFIXES.CACHE} SingleFlight 领导者响应在构建缓存时中断（客户端主动断开）: ${req.originalUrl}`
                            : `${LOG_PREFIXES.CACHE} SingleFlight 领导者执行异常: ${req.originalUrl} -> ${reason}`;
                        logger[logLevel](logMessage);
                        if (flightOwner?.entry) {
                            rejectSingleFlight(key, flightOwner.entry, err);
                        }
                    } else {
                        if (flightOwner?.entry) {
                            resolveSingleFlight(key, flightOwner.entry);
                        }
                    }
                };

                const finishHandler = () => settle();
                const closeHandler = () => {
                    if (!res.writableEnded) settle(new Error('response_aborted'));
                };
                const errorHandler = (err) => settle(err || new Error('response_error'));

                res.once('finish', finishHandler);
                res.once('close', closeHandler);
                res.once('error', errorHandler);

                next();
            };

            const serveFromCache = async () => {
                let cachedAfterLeader = await safeRedisGet(redis, key, '路由缓存等待后的读取');
                if (!cachedAfterLeader) return false;
                cacheStats.hits++;
                // 将之前计入的 totalRequests 仍保留，缓存命中无需修改
                res.setHeader('X-Cache', 'HIT');
                try {
                    const parsed = JSON.parse(cachedAfterLeader);
                    if (parsed && parsed.__cached_envelope === 1) {
                        replayEnvelope(res, parsed);
                        return true;
                    }
                } catch (error) {
                    logger.debug(`${LOG_PREFIXES.CACHE} follower 解析缓存失败 ${key}: ${error && error.message}`);
                }
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Cache-Control', cacheControlValue);
                res.setHeader('Vary', 'Authorization');
                res.send(cachedAfterLeader);
                return true;
            };

            const waitAndServe = async (flightPromise) => {
                try {
                    await waitWithTimeout(flightPromise, SINGLE_FLIGHT_WAIT_TIMEOUT_MS);
                    return await serveFromCache();
                } catch (waitError) {
                    logger.debug(`${LOG_PREFIXES.CACHE} SingleFlight follower 等待失败 ${key}: ${waitError && waitError.message}`);
                    return false;
                }
            };

            const initialFlight = acquireSingleFlight(key);
            if (!initialFlight.isLeader) {
                res.setHeader('X-Cache', 'WAIT');
                const served = await waitAndServe(initialFlight.promise);
                if (served) {
                    return;
                }
                // 等待失败或领导者未缓存，尝试成为新的领导者
                rejectSingleFlight(key, initialFlight.entry, new Error('follower_retry'));
                const retryFlight = acquireSingleFlight(key);
                if (!retryFlight.isLeader) {
                    // 极少数情况下仍无法成为领导者，直接放弃SingleFlight以保证可用性
                    logger.debug(`${LOG_PREFIXES.CACHE} SingleFlight follower 重试仍非领导者，直接回源 ${key}`);
                    handleLeaderResponse(null);
                    return;
                }
                handleLeaderResponse(retryFlight);
                return;
            }

            handleLeaderResponse(initialFlight);
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
