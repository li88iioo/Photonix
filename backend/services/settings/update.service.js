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
const settingsService = require('../settings.service');
const { settingsWorker } = require('../worker.manager');
const { settingsUpdateQueue, redis, bullConnection } = require('../../config/redis');

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
    isSensitiveOperation: (isTryingToSetOrChangePassword || isTryingToDisablePassword) && passwordIsCurrentlySet
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
  const headerUserId = req.headers['x-user-id'] || req.headers['x-userid'] || req.headers['x-user'];
  const userId = (req.user && req.user.id) ? String(req.user.id) : (headerUserId ? String(headerUserId) : 'anonymous');
  return {
    requestId: req.requestId || '-',
    ip: req.ip,
    userId,
    ...extra
  };
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

  // 检查是否提供了管理员密钥
  if (!adminSecret || adminSecret.trim() === '') {
    return createAuthError(400, '必须提供管理员密钥');
  }

  // 验证密钥是否匹配
  if (adminSecret !== process.env.ADMIN_SECRET) {
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
    logger.warn(JSON.stringify(auditContextBuilder({
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
  try {
    // 判断是否使用同步路径（无Redis或Redis不可用）
    const useSyncPath = !bullConnection || (redis && redis.isNoRedis === true);
    
    // 如果有认证更改且使用同步路径，直接同步更新
    if (hasAuthChanges && useSyncPath) {
      await settingsService.updateSettings(settingsToUpdate);
      return { type: 'sync_success', updateId };
    }
  } catch (e) {
    logger.debug('同步更新失败，继续异步处理:', e && e.message);
  }

  try {
    // 尝试投递到队列
    await settingsUpdateQueue.add('update_settings', { settingsToUpdate, updateId });

    // 如果队列不可用，使用工作线程
    if (!bullConnection || (redis && redis.isNoRedis === true)) {
      try {
        settingsWorker.postMessage({ type: 'update_settings', payload: { settingsToUpdate, updateId } });
      } catch (e) {
        logger.debug('线程消息发送失败（忽略）:', e && e.message);
      }
    }

    logger.info('设置更新任务已投递到队列');
    return { type: 'async_success', updateId };
  } catch (e) {
    logger.warn('投递到设置队列失败，降级使用线程消息：', e && e.message);
    try {
      // 降级使用工作线程
      settingsWorker.postMessage({ type: 'update_settings', payload: { settingsToUpdate, updateId } });
    } catch (workerError) {
      logger.debug('线程消息降级也失败（忽略）:', workerError && workerError.message);
    }
    return { type: 'async_success', updateId };
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
    logger.info('检测到认证相关设置变更，任务已提交到后台处理...');
    logger.info(JSON.stringify(buildAuditContext({
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
  logger.info('非认证相关设置变更，立即返回成功');
  logger.info(JSON.stringify(buildAuditContext({
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
  verifySensitiveOperations,    // 验证敏感操作
  dispatchUpdateTask,           // 分发更新任务
  buildUpdateResponse,          // 构建更新响应
  verifyAdminSecret             // 验证管理员密钥
};
