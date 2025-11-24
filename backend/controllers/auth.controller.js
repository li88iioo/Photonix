const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getAllSettings } = require('../services/settings.service');
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { safeRedisIncr, safeRedisExpire, safeRedisSet, safeRedisGet, safeRedisDel, safeRedisTtl } = require('../utils/helpers');
const { getDirectoryContents } = require('../services/file.service');

/**
 * @const {string} JWT_SECRET
 * 用于签发/验证 JWT Token 的密钥，仅在相关操作时检查
 */
const JWT_SECRET = process.env.JWT_SECRET;

/**
 * 计算登录防爆破锁定时长（单位：秒）
 * 策略参考 iOS 风格的递增策略
 * @param {number} failures - 连续失败次数
 * @returns {number} 锁定秒数
 */
function computeLoginLockSeconds(failures) {
    if (failures <= 4) return 0;         // 前4次不锁定
    if (failures === 5) return 60;       // 第5次：1分钟
    if (failures === 6) return 300;      // 第6次：5分钟
    if (failures === 7) return 900;      // 第7次：15分钟
    if (failures >= 8 && failures <= 10) return 3600; // 8-10次：60分钟
    return 3600;                         // ≥11次：持续60分钟（可调整为更长）
}

/**
 * 获取登录爆破防护 Key
 * 强制基于 IP 地址生成，移除任何可伪造头部的依赖
 * @param {Request} req - Express 请求对象
 * @returns {string} key
 */
function getLoginKeyBase(req) {
    const userKey = `ip:${req.ip || req.connection?.remoteAddress || 'unknown'}`;
    return `login_guard:${userKey}`;
}

/**
 * @const {number} LOGIN_FAIL_TTL_SECONDS
 * 登录失败计数过期时间（秒）
 */
const LOGIN_FAIL_TTL_SECONDS = 24 * 60 * 60;
/** @const {number} LOCAL_FAIL_TTL_MS - 本地计数过期时间（毫秒） */
const LOCAL_FAIL_TTL_MS = LOGIN_FAIL_TTL_SECONDS * 1000;
/** @const {number} LOCAL_GUARD_SWEEP_MS - 本地清理周期（毫秒） */
const LOCAL_GUARD_SWEEP_MS = 5 * 60 * 1000;

/** 
 * @type {Map}
 * 内存本地登录防爆破数据存储
 */
const localLoginGuardStore = new Map();
let localGuardWarned = false;
let localGuardCleanupInitialized = false;

/**
 * 清理已过期的本地登录防护记录
 */
function pruneExpiredLocalGuards() {
    const now = Date.now();
    for (const [key, entry] of localLoginGuardStore.entries()) {
        if (!entry) {
            localLoginGuardStore.delete(key);
            continue;
        }
        const expired = entry.expiresAt && entry.expiresAt <= now;
        const lockExpired = entry.lockUntil && entry.lockUntil <= now;
        if (expired && (!entry.lockUntil || lockExpired)) {
            localLoginGuardStore.delete(key);
            continue;
        }
        if (lockExpired) {
            entry.lockUntil = 0;
        }
    }
}

/**
 * 启动本地登录防护数据的定时清理
 */
function ensureLocalGuardCleanup() {
    if (localGuardCleanupInitialized) {
        return;
    }
    const timer = setInterval(pruneExpiredLocalGuards, LOCAL_GUARD_SWEEP_MS);
    if (typeof timer.unref === 'function') { // 防止阻止进程退出
        timer.unref();
    }
    localGuardCleanupInitialized = true;
}

/**
 * 获取或创建本地登录防护条目
 * @param {string} base - key
 * @param {boolean} [create=false] - 是否如不存在则创建
 * @returns {object|null}
 */
function getLocalEntry(base, create = false) {
    const now = Date.now();
    let entry = localLoginGuardStore.get(base);
    if (entry && entry.expiresAt && entry.expiresAt <= now) {
        localLoginGuardStore.delete(base);
        entry = null;
    }
    if (!entry && create) {
        ensureLocalGuardCleanup();
        entry = { fails: 0, lockUntil: 0, expiresAt: now + LOCAL_FAIL_TTL_MS };
        localLoginGuardStore.set(base, entry);
    }
    return entry;
}

/**
 * 本地记录一次登录失败
 * @param {string} base - key
 * @returns {{fails: number, lockSec: number}}
 */
function localRecordFailure(base) {
    const entry = getLocalEntry(base, true);
    entry.fails = (entry.fails || 0) + 1;
    entry.expiresAt = Date.now() + LOCAL_FAIL_TTL_MS;
    const lockSec = computeLoginLockSeconds(entry.fails);
    if (lockSec > 0) {
        entry.lockUntil = Date.now() + lockSec * 1000;
    } else {
        entry.lockUntil = 0;
    }
    return { fails: entry.fails, lockSec };
}

/**
 * 本地获取剩余锁定时长
 * @param {string} base 
 * @returns {number} 剩余秒数
 */
function localGetLockSeconds(base) {
    const entry = getLocalEntry(base, false);
    if (!entry || !entry.lockUntil) {
        return 0;
    }
    const remainingMs = entry.lockUntil - Date.now();
    if (remainingMs <= 0) {
        entry.lockUntil = 0;
        return 0;
    }
    return Math.ceil(remainingMs / 1000);
}

/**
 * 本地获取失败次数
 * @param {string} base 
 * @returns {number}
 */
function localGetFailures(base) {
    const entry = getLocalEntry(base, false);
    return entry ? entry.fails || 0 : 0;
}

/**
 * 清除本地防护记录
 * @param {string} base 
 */
function localClear(base) {
    localLoginGuardStore.delete(base);
}

/**
 * 本地登录防护实现
 */
const localLoginGuard = {
    useLocal: true,
    /**
     * 获取剩余锁定时间（秒）
     */
    async getLockSeconds(base) {
        return localGetLockSeconds(base);
    },
    /**
     * 记录登录失败
     */
    async recordFailure(base) {
        return localRecordFailure(base);
    },
    /**
     * 查询失败次数
     */
    async getFailures(base) {
        return localGetFailures(base);
    },
    /**
     * 清除本地登录防护记录
     */
    async clear(base) {
        localClear(base);
    }
};

/**
 * Redis 登录防护实现
 */
const redisLoginGuard = {
    useLocal: false,
    /**
     * 获取剩余锁定时间（秒）
     */
    async getLockSeconds(base) {
        const ttl = await safeRedisTtl(redis, `${base}:lock`, '检查登录锁定');
        return ttl && ttl > 0 ? ttl : 0;
    },
    /**
     * 记录登录失败并可能设置锁定
     */
    async recordFailure(base, context) {
        const failKey = `${base}:fails`;
        const lockKey = `${base}:lock`;
        let fails = Number(await safeRedisIncr(redis, failKey, context)) || 0;
        if (fails === 1) {
            await safeRedisExpire(redis, failKey, LOGIN_FAIL_TTL_SECONDS, '登录失败计数过期');
        }
        const lockSec = computeLoginLockSeconds(fails);
        if (lockSec > 0) {
            await safeRedisSet(redis, lockKey, '1', 'EX', lockSec, '登录锁定');
        }
        return { fails, lockSec };
    },
    /**
     * 获取登录失败次数
     */
    async getFailures(base) {
        const value = await safeRedisGet(redis, `${base}:fails`, '获取失败次数');
        return Number(value) || 0;
    },
    /**
     * 清除 Redis 失败次数与锁定
     */
    async clear(base) {
        await safeRedisDel(redis, [`${base}:fails`, `${base}:lock`], '清理登录失败记录');
    }
};

/**
 * 选择合适的登录防护实现
 * 优先使用 Redis，不可用时降级为本地内存
 * @returns {object}
 */
function createLoginGuard() {
    const redisAvailable = redis && !redis.isNoRedis;
    if (!redisAvailable) {
        if (!localGuardWarned) {
            logger.warn('Redis 未启用或不可用，登录防爆破降级为进程内内存锁，仅适用于单实例部署。');
            localGuardWarned = true;
        }
        return localLoginGuard;
    }
    return redisLoginGuard;
}

/**
 * 获取当前鉴权状态，判断是否已开启密码认证
 * @route GET /api/auth/status
 */
exports.getAuthStatus = async (req, res) => {
    const { PASSWORD_ENABLED } = await getAllSettings({ preferFreshSensitive: true });
    res.json({
        passwordEnabled: PASSWORD_ENABLED === 'true'
    });
};

/**
 * 登录接口
 * 校验密码，处理爆破防护、多场景异常，签发 JWT
 * @route POST /api/auth/login
 */
exports.login = async (req, res) => {
    const guard = createLoginGuard();
    const base = getLoginKeyBase(req);

    let lockSeconds = 0;
    try {
        lockSeconds = await guard.getLockSeconds(base);
    } catch (e) {
        logger.debug('检查登录锁定状态失败（已忽略）:', e && e.message);
    }

    // 若当前处于锁定，直接返回
    if (lockSeconds > 0) {
        res.setHeader('Retry-After', String(lockSeconds));
        return res.status(429).json({
            code: 'LOGIN_LOCKED',
            message: `尝试过于频繁，请在 ${lockSeconds} 秒后重试`,
            retryAfterSeconds: lockSeconds,
            requestId: req.requestId
        });
    }

    const { password } = req.body;
    const { PASSWORD_ENABLED, PASSWORD_HASH } = await getAllSettings();

    // 1. 优先检查是否匹配管理员密钥 (ADMIN_SECRET)
    // 这允许管理员使用 ADMIN_SECRET 直接登录，解决 RSS 下载等场景的认证问题
    const isAdminSecretMatch = process.env.ADMIN_SECRET && password === process.env.ADMIN_SECRET;

    if (isAdminSecretMatch) {
        logger.info(`[${req.requestId || '-'}] 使用管理员密钥 (ADMIN_SECRET) 登录成功`);
    } else {
        // 2. 常规用户密码登录流程

        // 检查是否启用密码
        if (PASSWORD_ENABLED !== 'true') {
            return res.status(400).json({
                code: 'PASSWORD_DISABLED',
                message: '密码访问未开启',
                requestId: req.requestId
            });
        }

        // 验证请求体和后端存储密码
        if (!password || !PASSWORD_HASH) {
            let failureStats = { fails: 0, lockSec: 0 };
            try {
                failureStats = await guard.recordFailure(base, '登录失败计数(无密码)');
            } catch (e) {
                logger.debug('记录登录失败（无密码）时出错（已忽略）:', e && e.message);
            }

            const failsNow = Number(failureStats && failureStats.fails) || 0;
            let lockSec = Number(failureStats && failureStats.lockSec) || 0;
            if (!lockSec) {
                try {
                    lockSec = await guard.getLockSeconds(base);
                } catch (e) {
                    logger.debug('检查登录锁定状态失败（已忽略）:', e && e.message);
                }
            }

            if (lockSec > 0) {
                res.setHeader('Retry-After', String(lockSec));
                return res.status(429).json({
                    code: 'LOGIN_LOCKED',
                    message: `尝试过于频繁，请在 ${lockSec} 秒后重试`,
                    retryAfterSeconds: lockSec,
                    requestId: req.requestId
                });
            }

            const remaining = Math.max(0, 5 - failsNow);
            const nextLock = computeLoginLockSeconds(failsNow + 1) || 0;
            return res.status(401).json({
                code: 'INVALID_CREDENTIALS',
                message: '密码错误',
                remainingAttempts: remaining,
                nextLockSeconds: nextLock,
                requestId: req.requestId
            });
        }
    }

    // 校验密码 (如果不是管理员密钥，则进行哈希比对)
    const isMatch = isAdminSecretMatch || await bcrypt.compare(password, PASSWORD_HASH);

    if (!isMatch) {
        let failureStats = { fails: 0, lockSec: 0 };
        try {
            failureStats = await guard.recordFailure(base, '登录失败计数(密码错误)');
        } catch (e) {
            logger.debug('记录登录失败（密码不匹配）时出错（已忽略）:', e && e.message);
        }

        const failsNow = Number(failureStats && failureStats.fails) || 0;
        let lockSec = Number(failureStats && failureStats.lockSec) || 0;
        if (!lockSec) {
            try {
                lockSec = await guard.getLockSeconds(base);
            } catch (e) {
                logger.debug('检查登录锁定状态失败（已忽略）:', e && e.message);
            }
        }

        if (lockSec > 0) {
            res.setHeader('Retry-After', String(lockSec));
            return res.status(429).json({
                code: 'LOGIN_LOCKED',
                message: `尝试过于频繁，请在 ${lockSec} 秒后重试`,
                retryAfterSeconds: lockSec,
                requestId: req.requestId
            });
        }

        const remaining = Math.max(0, 5 - failsNow);
        const nextLock = computeLoginLockSeconds(failsNow + 1) || 0;
        return res.status(401).json({
            code: 'INVALID_CREDENTIALS',
            message: '密码错误',
            remainingAttempts: remaining,
            nextLockSeconds: nextLock,
            requestId: req.requestId
        });
    }

    // 缺少 JWT 配置
    if (!JWT_SECRET) {
        return res.status(500).json({
            code: 'SERVER_CONFIG_MISSING',
            message: '服务器缺少 JWT 配置',
            requestId: req.requestId
        });
    }

    // 成功登录，签发 Token
    const token = jwt.sign({
        sub: 'gallery_user',
        userId: 'download_admin',  // 添加用户标识
        type: 'download'
    }, JWT_SECRET, { expiresIn: '7d' });
    logger.info('用户登录成功，已签发 Token。');

    // 清除失败计数与锁定
    try {
        await guard.clear(base);
    } catch (e) {
        logger.debug('清理登录失败记录时出错（已忽略）:', e && e.message);
    }

    res.json({ success: true, token });

    // 登录后后台缓存在 0ms 后预热，不影响正常响应
    try {
        setTimeout(async () => {
            try {
                await getDirectoryContents('', 1, 50, null, 'smart');
                logger.info('后台缓存预热任务已触发。');
            } catch (e) {
                logger.debug('后台缓存预热任务执行失败（已忽略）:', e && e.message);
            }
        }, 0);
    } catch (e) {
        logger.debug('后台缓存预热任务启动失败（已忽略）:', e && e.message);
    }
};

/**
 * 刷新 Token（简易滑动续期）
 * 前端以现有 Authorization: Bearer <token> 调用本接口，通过后重新签发新的 7 天 token
 * @route POST /api/auth/refresh
 */
exports.refresh = async (req, res) => {
    const authHeader = req.header('Authorization') || req.header('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(400).json({
            code: 'MISSING_TOKEN',
            message: '缺少 Authorization Bearer Token',
            requestId: req.requestId
        });
    }

    const oldToken = authHeader.replace('Bearer ', '');
    let decoded;
    if (!JWT_SECRET) {
        return res.status(500).json({
            code: 'SERVER_CONFIG_MISSING',
            message: '服务器缺少 JWT 配置',
            requestId: req.requestId
        });
    }
    try {
        decoded = jwt.verify(oldToken, JWT_SECRET);
    } catch (e) {
        // 区分 Token 过期/无效
        const code = e.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
        return res.status(401).json({
            code,
            message: 'Token 无效或已过期',
            requestId: req.requestId
        });
    }

    // 保留原Token的信息
    const subject = decoded?.sub || 'gallery_user';
    const userId = decoded?.userId || 'download_admin';
    const newToken = jwt.sign({
        sub: subject,
        userId: userId,
        type: 'download'
    }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ success: true, token: newToken });
};