/**
 * 设置管理服务模块
 * 处理系统设置的存储、缓存和更新，支持内存缓存和数据库事务
 */
const { dbAll, dbRun, getDB } = require('../db/multi-db'); // 使用多数据库管理器
const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { safeRedisDel, safeRedisGet, safeRedisSet } = require('../utils/helpers');

// --- 内存缓存配置 ---
let settingsCache = null;           // 设置缓存对象
let cacheTimestamp = 0;             // 缓存时间戳（毫秒）
const CACHE_TTL = 5 * 60 * 1000;    // 默认TTL：5分钟
const SENSITIVE_TTL = 30 * 1000;    // 敏感键TTL：30秒
const SETTINGS_REDIS_CACHE = (process.env.SETTINGS_REDIS_CACHE || 'false') === 'true';
const REDIS_CACHE_KEY = 'settings_cache_v1';
const DEFAULT_SYNC_SCHEDULE = 'off';

function applyDefaultSettings(settings = {}) {
    if (typeof settings.ALLOW_PUBLIC_ACCESS === 'undefined') {
        settings.ALLOW_PUBLIC_ACCESS = 'true';
    }
    if (typeof settings.ALBUM_DELETE_ENABLED === 'undefined') {
        settings.ALBUM_DELETE_ENABLED = 'false';
    }
    if (typeof settings.MANUAL_SYNC_SCHEDULE === 'undefined') {
        settings.MANUAL_SYNC_SCHEDULE = DEFAULT_SYNC_SCHEDULE;
    }
    if (typeof settings.AI_DAILY_LIMIT === 'undefined' || settings.AI_DAILY_LIMIT === null) {
        settings.AI_DAILY_LIMIT = process.env.AI_DAILY_LIMIT || '200';
    }
    return settings;
}

/**
 * 检查缓存是否有效
 * 验证缓存是否存在且未过期
 * @returns {boolean} 如果缓存有效返回true，否则返回false
 */
function isCacheValid(ttl = CACHE_TTL) {
    return settingsCache && (Date.now() - cacheTimestamp) < ttl;
}

/**
 * 清除缓存
 * 重置缓存对象和时间戳，强制下次从数据库读取
 */
function clearCache() {
    settingsCache = null;
    cacheTimestamp = 0;
    logger.debug('设置缓存已清除');
}

/**
 * 从数据库获取所有设置项
 * 优先从内存缓存读取，缓存无效时从数据库读取并更新缓存
 * @returns {Promise<Object>} 一个包含所有设置的键值对对象
 */
async function getAllSettings(options = {}) {
    try {
        const preferFreshSensitive = options.preferFreshSensitive === true;

        // 1) 尝试使用内存缓存（敏感键可要求更短TTL）
        if (isCacheValid(preferFreshSensitive ? SENSITIVE_TTL : CACHE_TTL)) {
            // 设置缓存命中 - 降级为 trace 级别避免刷屏
            return applyDefaultSettings(settingsCache);
        }

        // 2) 可选：从 Redis 兜底读取
        if (SETTINGS_REDIS_CACHE) {
            const cached = await safeRedisGet(redis, REDIS_CACHE_KEY, 'Settings缓存读取');
            if (cached) {
                const parsed = JSON.parse(cached);
                settingsCache = parsed;
                cacheTimestamp = Date.now();
                logger.debug('从 Redis 缓存获取设置');
                return applyDefaultSettings(settingsCache);
            }
        }

        // 3) 缓存无效，从数据库读取
        logger.debug('从设置数据库获取设置');
        const rows = await dbAll('settings', 'SELECT key, value FROM settings');
        const settings = {};
        for (const row of rows) {
            settings[row.key] = row.value;
        }
        settingsCache = applyDefaultSettings(settings);
        cacheTimestamp = Date.now();

        // 写回 Redis 兜底缓存
        if (SETTINGS_REDIS_CACHE) {
            await safeRedisSet(redis, REDIS_CACHE_KEY, JSON.stringify(settingsCache), 'EX', Math.floor(CACHE_TTL / 1000), 'Settings缓存写入');
        }
        return settingsCache;
    } catch (error) {
        logger.error('从数据库获取设置失败:', error);
        // 回退策略：优先使用进程内过期缓存；再尝试 Redis；最后给出保守默认
        try {
            if (settingsCache) {
                logger.debug('使用过期的内存设置缓存作为回退');
                return settingsCache;
            }
            if (SETTINGS_REDIS_CACHE) {
                const cached = await safeRedisGet(redis, REDIS_CACHE_KEY, 'Settings缓存回退读取');
                if (cached) {
                    const parsed = JSON.parse(cached);
                    logger.debug('使用 Redis 设置缓存作为回退');
                    return parsed;
                }
            }
        } catch (fallbackError) {
            logger.debug('设置服务回退缓存读取失败，继续使用默认值:', fallbackError && fallbackError.message);
        }
        // 最终兜底：最关键的公共开关默认放开，避免首页完全不可用
        return { ALLOW_PUBLIC_ACCESS: 'true', PASSWORD_ENABLED: 'false', ALBUM_DELETE_ENABLED: 'false', MANUAL_SYNC_SCHEDULE: DEFAULT_SYNC_SCHEDULE };
    }
}

/**
 * 批量更新一个或多个设置项
 * 使用数据库事务确保原子性，更新成功后清除缓存
 * @param {Object} settingsToUpdate - 一个包含要更新的设置的键值对对象
 * @returns {Promise<{success: boolean}>} 更新操作的结果
 */
async function updateSettings(settingsToUpdate) {
    try {
        // 使用 prepare 可以提高批量操作的性能
        const db = getDB('settings');
        const updateStmt = db.prepare('INSERT OR REPLACE INTO settings (value, key) VALUES (?, ?)');

        // 批量更新设置项
        // better-sqlite3 的 transaction() 会自动处理 BEGIN/COMMIT/ROLLBACK
        const executeBatch = db.transaction((items) => {
            for (const [key, value] of Object.entries(items)) {
                updateStmt.run(value, key);
            }
        });

        executeBatch(settingsToUpdate);
        // better-sqlite3 statements are automatically finalized when garbage collected, or reused. No explicit finalize needed here for this flow.

        // 更新成功后立即清除缓存
        clearCache();
        // 删除 Redis 兜底缓存
        if (SETTINGS_REDIS_CACHE) {
            await safeRedisDel(redis, REDIS_CACHE_KEY, 'Settings缓存删除');
        }

        // 检查是否包含认证相关设置，如果是则强制清除缓存
        const authRelatedKeys = ['PASSWORD_ENABLED', 'PASSWORD_HASH', 'AI_ENABLED'];
        const hasAuthChanges = Object.keys(settingsToUpdate).some(key => authRelatedKeys.includes(key));
        if (hasAuthChanges) {
            logger.info('检测到认证相关设置变更，已强制清除缓存');
        }

        logger.info('成功更新设置:', Object.keys(settingsToUpdate).join(', '));
        return { success: true };
    } catch (error) {
        logger.error('更新设置时发生错误:', error);
        throw error;
    }
}

// 导出设置服务函数
module.exports = {
    getAllSettings,    // 获取所有设置（支持 { preferFreshSensitive: true }）
    updateSettings,    // 批量更新设置
    clearCache         // 清除缓存方法，供外部调用
};
