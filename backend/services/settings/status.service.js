/**
 * 设置状态管理服务模块
 * 
 * 负责管理设置更新操作的状态跟踪，包括：
 * - 初始化更新状态
 * - 更新操作状态
 * - 查询更新状态
 * - 状态超时处理
 * 
 * @author Photonix Team
 * @version 1.0.0
 */

const logger = require('../../config/logger');
const { redis } = require('../../config/redis');
const { safeRedisDel, safeRedisGet } = require('../../utils/helpers');

// 内存中的状态映射表
const updateStatusMap = new Map();

// 完成状态集合（这些状态表示操作已完成）
const COMPLETED_STATUS = new Set(['success', 'failed', 'timeout']);
const IN_PROGRESS_STATUS = new Set(['pending', 'processing']);

// 状态超时时间（毫秒），默认5分钟
const STATUS_TTL_MS = Number(process.env.SETTINGS_STATUS_TTL_MS || 5 * 60 * 1000);

function getOrCreateEntry(updateId, defaults = {}) {
  if (!updateId) return null;
  if (!updateStatusMap.has(updateId)) {
    updateStatusMap.set(updateId, {
      timestamp: Date.now(),
      status: defaults.status || 'pending',
      updatedKeys: Array.isArray(defaults.updatedKeys) ? defaults.updatedKeys : [],
      message: defaults.message || null,
      completedAt: defaults.completedAt || null
    });
  }
  const entry = updateStatusMap.get(updateId);
  if (Array.isArray(defaults.updatedKeys) && defaults.updatedKeys.length) {
    entry.updatedKeys = defaults.updatedKeys;
  }
  if (typeof defaults.message === 'string') {
    entry.message = defaults.message;
  }
  return entry;
}

function normalizeLocalEntry(updateId) {
  if (!updateStatusMap.has(updateId)) {
    return null;
  }
  const entry = updateStatusMap.get(updateId);
  const now = Date.now();
  const normalized = {
    status: entry.status || 'pending',
    updatedKeys: Array.isArray(entry.updatedKeys) ? entry.updatedKeys : [],
    timestamp: entry.timestamp || now,
    message: entry.message || null
  };

  if (IN_PROGRESS_STATUS.has(normalized.status)) {
    const age = now - normalized.timestamp;
    if (age > STATUS_TTL_MS) {
      normalized.status = 'timeout';
      normalized.message = normalized.message || '等待超时';
      normalized.timestamp = now;
      entry.status = 'timeout';
      entry.message = normalized.message;
      entry.timestamp = now;
      entry.completedAt = now;
    }
  } else if (COMPLETED_STATUS.has(normalized.status)) {
    const completedAt = entry.completedAt || normalized.timestamp;
    entry.completedAt = completedAt;
    if (now - completedAt > STATUS_TTL_MS) {
      updateStatusMap.delete(updateId);
      return null;
    }
  }
  return normalized;
}

function buildStatusResponse(entry) {
  if (!entry) {
    return null;
  }
  return {
    statusCode: 200,
    body: {
      status: entry.status,
      timestamp: entry.timestamp,
      updatedKeys: entry.updatedKeys || [],
      message: entry.message || null
    }
  };
}

/**
 * 初始化更新状态
 * 
 * 为新的设置更新操作创建初始状态记录
 * 
 * @param {string} updateId - 更新操作ID
 * @param {Array} updatedKeys - 要更新的设置键列表
 * @returns {Object} 初始状态对象
 */
function seedUpdateStatus(updateId, updatedKeys = []) {
  if (!updateId) {
    logger.warn('seedUpdateStatus: 缺少 updateId，状态初始化被忽略');
    return null;
  }
  const entry = getOrCreateEntry(updateId, { status: 'pending', updatedKeys });
  entry.status = 'pending';
  entry.message = null;
  entry.timestamp = Date.now();
  entry.updatedKeys = Array.isArray(updatedKeys) ? updatedKeys : [];
  entry.completedAt = null;
  return entry;
}

/**
 * 应用状态更新
 * 
 * 更新指定操作的状态信息，如果操作完成则从内存中移除
 * 
 * @param {string} updateId - 更新操作ID
 * @param {string} status - 新状态
 * @param {string} message - 状态消息（可选）
 * @returns {boolean} 更新是否成功
 */
function applyStatusUpdate(updateId, status, message = null) {
  if (!updateId) {
    logger.warn('applyStatusUpdate: 缺少 updateId，状态更新被忽略');
    return false;
  }

  const entry = getOrCreateEntry(updateId);
  if (!entry) {
    return false;
  }
  entry.status = status;
  entry.message = message;
  entry.timestamp = Date.now();
  if (COMPLETED_STATUS.has(status)) {
    entry.completedAt = entry.timestamp;
  }
  return true;
}

/**
 * 解析更新状态
 * 
 * 查询指定更新ID的状态信息，优先从Redis获取，回退到内存
 * 处理状态超时和缓存清理
 * 
 * @param {string} updateId - 更新操作ID
 * @returns {Object} 包含状态码和状态信息的响应对象
 */
async function resolveUpdateStatus(updateId) {
  if (!updateId) {
    return { statusCode: 400, body: { error: '请提供有效的更新ID (id 或 updateId 参数)' } };
  }

  const localBeforeRedis = normalizeLocalEntry(updateId);
  if (localBeforeRedis && !IN_PROGRESS_STATUS.has(localBeforeRedis.status)) {
    return buildStatusResponse(localBeforeRedis);
  }

  // 首先尝试从Redis获取状态
  try {
    const raw = await safeRedisGet(redis, `settings_update_status:${updateId}`, '设置更新状态查询');
    if (raw) {
      const parsed = JSON.parse(raw);
      const ts = parsed.ts || updateStatusMap.get(updateId)?.timestamp || Date.now();

       // 缓存在内存中，作为 Redis 失效的兜底
      const entry = getOrCreateEntry(updateId, { updatedKeys: parsed.updatedKeys });
      if (entry) {
        entry.status = parsed.status;
        entry.message = parsed.message || null;
        entry.timestamp = ts;
        if (COMPLETED_STATUS.has(parsed.status)) {
          entry.completedAt = ts;
        }
      }

      // 如果操作成功或失败，清理设置缓存
      try {
        if (parsed.status === 'success' || parsed.status === 'failed') {
          const settingsService = require('../settings.service');
          settingsService.clearCache();
        }
      } catch (e) { logger.debug(`操作失败: ${e.message}`); }

      // 如果操作已完成，清理Redis和内存中的记录
      if (COMPLETED_STATUS.has(parsed.status)) {
        await safeRedisDel(redis, `settings_update_status:${updateId}`, '设置更新状态清理');
        updateStatusMap.delete(updateId);
      }

      return buildStatusResponse({
        status: parsed.status,
        timestamp: ts,
        updatedKeys: parsed.updatedKeys || entry?.updatedKeys || [],
        message: parsed.message || null
      });
    }
  } catch (statusErr) {
    logger.debug('[SettingsStatus] 从 Redis 获取状态失败，将尝试内存缓存:', statusErr && statusErr.message);
  }

  // 如果Redis中没有，检查内存中的状态
  const local = normalizeLocalEntry(updateId);
  if (local) {
    return buildStatusResponse(local);
  }

  return { statusCode: 404, body: { error: '未找到该更新ID的状态' } };
}

/**
 * 模块导出
 * 
 * 导出所有公共函数和常量，供其他模块使用
 */
module.exports = {
  seedUpdateStatus,      // 初始化更新状态
  applyStatusUpdate,     // 应用状态更新
  resolveUpdateStatus,   // 解析更新状态
  COMPLETED_STATUS,      // 完成状态集合
  STATUS_TTL_MS          // 状态超时时间
};
