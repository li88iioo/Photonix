/**
 * 设置更新服务模块
 * 
 * 负责处理设置更新的核心逻辑，包括：
 * - 设置参数验证和过滤
 * - 密码操作处理（设置、修改、删除）
 * - 敏感操作验证（管理员密钥验证）
 * - 更新任务分发（同步/异步）
 * - 响应构建
 * 
 */

const bcrypt = require('bcryptjs');
const logger = require('../../config/logger');
const { LOG_PREFIXES } = logger;
const { secureCompare } = require('../../utils/secureCompare');
const { TraceManager } = require('../../utils/trace');
const settingsService = require('../settings.service');
const { getSettingsWorker } = require('../worker.manager');
const { redis } = require('../../config/redis');
const { applyStatusUpdate } = require('./status.service');

const SETTINGS_ASYNC_MODE = (process.env.SETTINGS_ASYNC_MODE || 'auto').toLowerCase();
const SETTINGS_AUTH_ASYNC = (process.env.SETTINGS_AUTH_ASYNC || 'auto').toLowerCase();

function shouldPreferSync(hasAuthChanges) {
  const redisUnavailable = !redis || redis.isNoRedis === true;
  if (SETTINGS_ASYNC_MODE === 'sync') {
    return true;
  }
  if (SETTINGS_ASYNC_MODE === 'async') {
    return false;
  }
  if (redisUnavailable) {
    return true;
  }
  if (hasAuthChanges && SETTINGS_AUTH_ASYNC !== 'async' && SETTINGS_AUTH_ASYNC !== 'true') {
    return true;
  }
  return false;
}

/**
 * 创建认证错误对象
 * 
 * @param {number} code - HTTP状态码
 * @param {string} message - 错误消息
 * @returns {Object} 错误对象
 */
function createAuthError(code, message) {
  return { ok: false, code, msg: message };
}

/**
 * 创建认证成功对象
 * 
 * @returns {Object} 成功对象
 */
function createAuthSuccess() {
  return { ok: true };
}

/**
 * 生成唯一ID
 * 
 * 用于标识设置更新操作，格式：时间戳-随机字符串
 * 
 * @returns {string} 唯一ID
 */
function generateUniqueId() {
  const ID_RANDOM_LENGTH = 6;
  return `${Date.now()}-${Math.random().toString(36).slice(2, 2 + ID_RANDOM_LENGTH)}`;
}

/**
 * 验证和过滤设置参数
 * 
 * 从请求体中提取设置参数，过滤掉敏感字段，分离密码和管理员密钥
 * 
 * @param {Object} reqBody - 请求体对象
 * @returns {Object} 包含过滤后设置、密码和管理员密钥的对象
 */
function validateAndFilterSettings(reqBody = {}) {
  const { newPassword, adminSecret, ...rawSettings } = reqBody;

  // 禁止直接更新的敏感字段
  const forbiddenKeys = ['AI_KEY', 'AI_API_KEY', 'OPENAI_API_KEY'];

  // 过滤掉敏感字段
  const settingsToUpdate = Object.fromEntries(
    Object.entries(rawSettings).filter(([key]) => !forbiddenKeys.includes(key))
  );

  return { newPassword, adminSecret, settingsToUpdate };
}

/**
 * 处理密码相关操作
 * 
 * 处理密码的设置、修改和删除操作，包括：
 * - 检查当前密码状态
 * - 生成新密码哈希
 * - 清空密码哈希（禁用密码）
 * - 判断是否为敏感操作
 * 
 * @param {Object} settingsToUpdate - 要更新的设置
 * @param {string} newPassword - 新密码
 * @param {Object} allSettings - 所有当前设置
 * @returns {Object} 密码操作结果
 */
async function handlePasswordOperations(settingsToUpdate, newPassword, allSettings) {
  // 检查当前是否已设置密码
  const passwordIsCurrentlySet = Boolean(allSettings.PASSWORD_HASH && allSettings.PASSWORD_HASH !== '');

  // 检查是否尝试设置或修改密码
  const isTryingToSetOrChangePassword = Boolean(newPassword && newPassword.trim() !== '');

  // 检查是否尝试禁用密码
  const isTryingToDisablePassword = Object.prototype.hasOwnProperty.call(settingsToUpdate, 'PASSWORD_ENABLED')
    && settingsToUpdate.PASSWORD_ENABLED === 'false';

  // 处理密码设置或修改
  if (isTryingToSetOrChangePassword) {
    logger.info('正在为新密码生成哈希值...');
    const salt = await bcrypt.genSalt(10);
    settingsToUpdate.PASSWORD_HASH = await bcrypt.hash(newPassword, salt);
  } else if (isTryingToDisablePassword && passwordIsCurrentlySet) {
    // 禁用密码时清空哈希
    settingsToUpdate.PASSWORD_HASH = '';
  }

  return {
    passwordIsCurrentlySet,
    isTryingToSetOrChangePassword,
    isTryingToDisablePassword,
    isSensitiveOperation: (isTryingToSetOrChangePassword || isTryingToDisablePassword)
  };
}

/**
 * 检测认证相关更改
 * 
 * 检查设置更新中是否包含认证相关的字段
 * 
 * @param {Object} settingsToUpdate - 要更新的设置
 * @returns {boolean} 是否包含认证相关更改
 */
function detectAuthChanges(settingsToUpdate = {}) {
  const authRelatedKeys = ['PASSWORD_ENABLED', 'PASSWORD_HASH', 'AI_ENABLED', 'AI_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_PROMPT'];
  return Object.keys(settingsToUpdate).some((key) => authRelatedKeys.includes(key));
}

/**
 * 构建审计上下文
 * 
 * 从请求对象中提取审计所需的信息，用于记录操作日志
 * 
 * @param {Object} req - Express请求对象
 * @param {Object} extra - 额外的审计信息
 * @returns {Object} 审计上下文对象
 */
function buildAuditContext(req, extra = {}) {
  // 安全策略：仅信任已鉴权的用户身份，不信任可伪造的 x-user-id 等 header
  const userId = (req.user && req.user.id) ? String(req.user.id) : 'anonymous';
  const { reason, ...restExtra } = extra || {};
  return {
    ...(reason ? { reason } : {}),
    requestId: req.requestId || '-',
    ip: req.ip,
    userId,
    ...restExtra
  };
}

const AUDIT_FIELD_LABELS = {
  requestId: '请求ID',
  ip: '客户端IP',
  userId: '用户ID',
  action: '操作',
  sensitive: '敏感操作',
  type: '类型',
  summary: '摘要',
  schedule: '原始计划',
  normalizedSchedule: '解析后计划',
  status: '状态',
  message: '说明',
  updatedKeys: '更新字段'
};

const AUDIT_ACTION_LABELS = {
  update_manual_sync_schedule: '更新手动同步计划',
  manual_album_sync: '手动相册同步',
  verify_admin_secret: '验证管理员密钥',
  rebuild_index: '重建索引',
  toggle_album_delete: '切换相册删除开关',
  update_settings: '更新系统设置',
  trigger_sync: '触发同步任务'
};

const AUDIT_STATUS_LABELS = {
  approved: '已通过',
  submitted: '已提交',
  pending: '处理中',
  denied: '已拒绝',
  failed: '失败'
};

function translateAuditLog(ctx = {}) {
  const translated = {};
  Object.entries(ctx || {}).forEach(([key, value]) => {
    const label = AUDIT_FIELD_LABELS[key] || key;
    let formatted = value;
    if (key === 'action' && typeof value === 'string') {
      formatted = AUDIT_ACTION_LABELS[value] || value;
    } else if (key === 'status' && typeof value === 'string') {
      formatted = AUDIT_STATUS_LABELS[value] || value;
    } else if (key === 'sensitive') {
      formatted = value ? '是' : '否';
    }
    if (formatted && typeof formatted === 'object') {
      try {
        formatted = JSON.stringify(formatted);
      } catch (e) {
        formatted = String(formatted);
      }
    }
    translated[label] = formatted;
  });
  return translated;
}

/**
 * 验证管理员密钥
 * 
 * 验证提供的管理员密钥是否与服务器配置的密钥匹配
 * 
 * @param {string} adminSecret - 管理员密钥
 * @returns {Object} 验证结果
 */
async function verifyAdminSecret(adminSecret) {
  // 检查服务器是否配置了管理员密钥
  if (!process.env.ADMIN_SECRET || process.env.ADMIN_SECRET.trim() === '') {
    logger.warn('安全操作失败：管理员密钥未在环境变量中配置。');
    return createAuthError(500, '管理员密钥未在服务器端配置，无法执行此操作');
  }

  // 检查是否提供了管理员密钥（类型安全校验）
  if (typeof adminSecret !== 'string' || adminSecret.trim() === '') {
    return createAuthError(400, '必须提供管理员密钥');
  }

  // 验证密钥是否匹配（使用 secureCompare 防止时序攻击，基于 Buffer 字节长度比较）
  const serverSecret = process.env.ADMIN_SECRET;
  if (!secureCompare(adminSecret, serverSecret)) {
    return createAuthError(401, '管理员密钥错误');
  }

  logger.info('管理员密钥验证成功');
  return createAuthSuccess();
}

/**
 * 验证敏感操作
 * 
 * 对于敏感操作（如密码修改），需要验证管理员密钥
 * 
 * @param {boolean} isSensitiveOperation - 是否为敏感操作
 * @param {string} adminSecret - 管理员密钥
 * @param {Function} auditContextBuilder - 审计上下文构建函数
 * @returns {Object} 验证结果
 */
async function verifySensitiveOperations(isSensitiveOperation, adminSecret, auditContextBuilder) {
  // 如果不是敏感操作，直接通过
  if (!isSensitiveOperation) {
    return { ok: true };
  }

  // 验证管理员密钥
  const result = await verifyAdminSecret(adminSecret);
  if (!result.ok) {
    // 记录拒绝的审计日志
    logger.warn(`${LOG_PREFIXES.AUTH} 管理员验证被拒绝`, translateAuditLog(auditContextBuilder({
      action: 'update_settings',
      sensitive: true,
      status: 'denied',
      reason: result.msg
    })));
    return { ok: false, code: result.code, msg: result.msg };
  }
  return { ok: true };
}

/**
 * 分发更新任务
 * 
 * 根据是否有认证更改和系统配置，选择同步或异步方式处理设置更新
 * 
 * @param {Object} settingsToUpdate - 要更新的设置
 * @param {string} updateId - 更新ID
 * @param {boolean} hasAuthChanges - 是否有认证相关更改
 * @param {Function} buildAuditContext - 审计上下文构建函数
 * @returns {Object} 分发结果
 */
async function dispatchUpdateTask(settingsToUpdate, updateId, hasAuthChanges, buildAuditContext) {
  const runSyncUpdate = async (reason = 'auto') => {
    logger.info(`${LOG_PREFIXES.SETTINGS_UPDATE} 使用同步路径 (${reason})`);
    await settingsService.updateSettings(settingsToUpdate);
    try {
      applyStatusUpdate(updateId, 'success', '配置已同步更新');
    } catch (statusError) {
      logger.debug('同步状态写入失败（忽略）:', statusError && statusError.message);
    }
    return { type: 'sync_success', updateId };
  };

  if (shouldPreferSync(hasAuthChanges)) {
    return runSyncUpdate(redis && redis.isNoRedis ? 'redis_unavailable' : 'pref_sync');
  }

  try {
    const worker = getSettingsWorker();
    if (!worker) {
      logger.warn('设置 worker 不可用，回退同步执行');
      return runSyncUpdate('worker_missing');
    }
    const message = TraceManager.injectToWorkerMessage({ type: 'update_settings', payload: { settingsToUpdate, updateId } });
    worker.postMessage(message);
    try {
      applyStatusUpdate(updateId, 'processing', '任务已提交至后台');
    } catch (statusErr) {
      logger.debug('标记后台处理状态失败（忽略）:', statusErr && statusErr.message);
    }
    logger.info('设置更新任务已发送至工作线程');
    return { type: 'async_success', updateId };
  } catch (workerError) {
    logger.error('分发设置更新任务失败，回退到同步路径:', workerError && workerError.message);
    return runSyncUpdate('dispatch_failed');
  }
}

/**
 * 构建更新响应
 * 
 * 根据分发结果和是否有认证更改，构建相应的HTTP响应
 * 
 * @param {Object} dispatchResult - 分发结果
 * @param {boolean} hasAuthChanges - 是否有认证相关更改
 * @param {Object} settingsToUpdate - 要更新的设置
 * @param {Function} buildAuditContext - 审计上下文构建函数
 * @returns {Object} HTTP响应对象
 */
function buildUpdateResponse(dispatchResult, hasAuthChanges, settingsToUpdate, buildAuditContext) {
  // 如果是同步成功，直接返回成功
  if (dispatchResult.type === 'sync_success') {
    return {
      statusCode: 200,
      body: {
        success: true,
        message: '配置已更新',
        status: 'success',
        updateId: dispatchResult.updateId
      }
    };
  }

  // 如果有认证更改，返回202状态码表示已接受处理
  if (hasAuthChanges) {
    logger.info(`${LOG_PREFIXES.AUTH} 检测到认证相关设置变更，任务已提交到后台处理...`);
    logger.info(`${LOG_PREFIXES.AUTH} 认证设置更新已提交`, translateAuditLog(buildAuditContext({
      action: 'update_settings',
      sensitive: true,
      status: 'submitted',
      updatedKeys: Object.keys(settingsToUpdate)
    })));

    return {
      statusCode: 202,
      body: {
        success: true,
        message: '设置更新任务已接受，正在后台处理',
        status: 'pending',
        updateId: dispatchResult.updateId
      }
    };
  }

  // 非认证相关更改，返回200状态码
  logger.info(`${LOG_PREFIXES.SETTINGS_UPDATE} 非认证相关设置变更，立即返回成功`);
  logger.info(`${LOG_PREFIXES.SETTINGS_UPDATE} 设置更新已提交`, translateAuditLog(buildAuditContext({
    action: 'update_settings',
    sensitive: false,
    status: 'submitted',
    updatedKeys: Object.keys(settingsToUpdate)
  })));

  return {
    statusCode: 200,
    body: {
      success: true,
      message: '配置更新任务已提交',
      status: 'submitted',
      updateId: dispatchResult.updateId
    }
  };
}

/**
 * 模块导出
 * 
 * 导出所有公共函数，供其他模块使用
 */
module.exports = {
  createAuthError,              // 创建认证错误对象
  createAuthSuccess,            // 创建认证成功对象
  generateUniqueId,             // 生成唯一ID
  validateAndFilterSettings,    // 验证和过滤设置参数
  handlePasswordOperations,     // 处理密码相关操作
  detectAuthChanges,            // 检测认证相关更改
  buildAuditContext,            // 构建审计上下文
  translateAuditLog,            // 审计日志中文映射
  verifySensitiveOperations,    // 验证敏感操作
  dispatchUpdateTask,           // 分发更新任务
  buildUpdateResponse,          // 构建更新响应
  verifyAdminSecret             // 验证管理员密钥
};
