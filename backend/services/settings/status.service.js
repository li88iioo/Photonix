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

// 内存中的状态映射表
const updateStatusMap = new Map();

// 完成状态集合（这些状态表示操作已完成）
const COMPLETED_STATUS = new Set(['success', 'failed', 'timeout']);

// 状态超时时间（毫秒），默认5分钟
const STATUS_TTL_MS = Number(process.env.SETTINGS_STATUS_TTL_MS || 5 * 60 * 1000);

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
  const initialStatus = {
    timestamp: Date.now(),
    status: 'pending',
    updatedKeys,
    message: null
  };
  updateStatusMap.set(updateId, initialStatus);
  return initialStatus;
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
  
  const existing = updateStatusMap.get(updateId);
  if (!existing) {
    logger.warn('applyStatusUpdate: 未找到有效的 updateId，状态更新被忽略');
    return false;
  }

  // 更新状态信息
  existing.status = status;
  existing.message = message;
  existing.timestamp = Date.now();

  // 如果操作已完成，从内存中移除状态记录
  if (COMPLETED_STATUS.has(status)) {
    updateStatusMap.delete(updateId);
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

  // 首先尝试从Redis获取状态
  try {
    const raw = await redis.get(`settings_update_status:${updateId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      const ts = parsed.ts || updateStatusMap.get(updateId)?.timestamp || Date.now();

      // 如果操作成功或失败，清理设置缓存
      try {
        if (parsed.status === 'success' || parsed.status === 'failed') {
          const settingsService = require('../settings.service');
          settingsService.clearCache();
        }
      } catch {}

      // 如果操作已完成，清理Redis和内存中的记录
      if (COMPLETED_STATUS.has(parsed.status)) {
        try { await redis.del(`settings_update_status:${updateId}`); } catch {}
        updateStatusMap.delete(updateId);
      }

      return {
        statusCode: 200,
        body: {
          status: parsed.status,
          timestamp: ts,
          updatedKeys: parsed.updatedKeys || updateStatusMap.get(updateId)?.updatedKeys || [],
          message: parsed.message || null
        }
      };
    }
  } catch {}

  // 如果Redis中没有，检查内存中的状态
  if (updateStatusMap.has(updateId)) {
    const current = updateStatusMap.get(updateId);
    const age = Date.now() - (Number(current.timestamp) || Date.now());
    
    // 检查是否超时
    if (current.status === 'pending' && age > STATUS_TTL_MS) {
      current.status = 'timeout';
    }
    
    // 如果操作已完成，从内存中移除
    if (COMPLETED_STATUS.has(current.status)) {
      updateStatusMap.delete(updateId);
    }

    return {
      statusCode: 200,
      body: {
        status: current.status,
        timestamp: current.timestamp,
        updatedKeys: current.updatedKeys,
        message: current.message || null
      }
    };
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
