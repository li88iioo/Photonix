/**
 * 设置控制器模块
 * 
 * 负责处理所有与系统设置相关的HTTP请求，包括：
 * - 获取客户端设置信息
 * - 更新系统设置
 * - 查询设置更新状态
 * - 管理系统维护操作（索引、缩略图、HLS等）
 * 
 */

const logger = require('../config/logger');
const settingsService = require('../services/settings.service');
const { hasPermission, getUserRole, PERMISSIONS } = require('../middleware/permissions');

// 导入设置更新服务模块
const {
  generateUniqueId,
  validateAndFilterSettings,
  handlePasswordOperations,
  detectAuthChanges,
  buildAuditContext,
  verifySensitiveOperations,
  dispatchUpdateTask,
  buildUpdateResponse
} = require('../services/settings/update.service');

// 导入设置状态管理服务模块
const {
  seedUpdateStatus,
  applyStatusUpdate,
  resolveUpdateStatus
} = require('../services/settings/status.service');

// 导入系统维护服务模块
const {
  thumbnailSyncService,
  getIndexStatus,
  getHlsStatus,
  triggerSyncOperation,
  triggerCleanupOperation,
  getTypeDisplayName
} = require('../services/settings/maintenance.service');

/**
 * 获取客户端所需的设置信息
 * 
 * 返回前端页面需要的基础设置信息，包括：
 * - AI功能启用状态
 * - 密码保护启用状态
 * - 密码是否已设置
 * - 管理员密钥是否已配置
 * 
 * @param {Object} _req - Express请求对象（未使用）
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应，包含客户端设置信息
 */
exports.getSettingsForClient = async (_req, res) => {
  const allSettings = await settingsService.getAllSettings();
  res.json({
    AI_ENABLED: allSettings.AI_ENABLED, // AI功能是否启用
    PASSWORD_ENABLED: allSettings.PASSWORD_ENABLED, // 密码功能是否启用
    hasPassword: Boolean(allSettings.PASSWORD_HASH && allSettings.PASSWORD_HASH !== ''), // 是否已设置密码
    isAdminSecretConfigured: Boolean(process.env.ADMIN_SECRET && process.env.ADMIN_SECRET.trim() !== '') // 是否配置了管理员密钥
  });
};

/**
 * 更新系统设置
 * 
 * 处理设置更新请求，包括：
 * - 验证和过滤设置参数
 * - 处理密码相关操作（设置、修改、删除）
 * - 验证敏感操作的管理员权限
 * - 分发更新任务到后台处理
 * - 返回更新状态和结果
 * 
 * @param {Object} req - Express请求对象，包含要更新的设置
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应，包含更新结果或错误信息
 */
exports.updateSettings = async (req, res) => {
  try {
    // 校验并过滤请求体中的设置，移除敏感字段
    const { newPassword, adminSecret, settingsToUpdate } = validateAndFilterSettings(req.body);
    
    // 获取所有当前设置，用于密码操作判断
    const allSettings = await settingsService.getAllSettings();
    
    // 处理密码相关操作（设置新密码、修改密码、删除密码）
    const passwordOps = await handlePasswordOperations(settingsToUpdate, newPassword, allSettings);
    
    // 构建审计上下文，用于记录操作日志
    const auditContextBuilder = (extra) => buildAuditContext(req, extra);

    // 校验敏感操作（如修改密码等）是否通过管理员密钥验证
    const verifyResult = await verifySensitiveOperations(passwordOps.isSensitiveOperation, adminSecret, auditContextBuilder);
    if (!verifyResult.ok) {
      return res.status(verifyResult.code).json({ error: verifyResult.msg });
    }

    // 如果启用密码访问但未设置新密码，返回错误
    if (
      Object.prototype.hasOwnProperty.call(settingsToUpdate, 'PASSWORD_ENABLED') &&
      settingsToUpdate.PASSWORD_ENABLED === 'true' &&
      !passwordOps.passwordIsCurrentlySet &&
      !passwordOps.isTryingToSetOrChangePassword
    ) {
      return res.status(400).json({ error: '请设置新密码以启用密码访问' });
    }

    // 检查是否有认证相关的更改（密码、AI设置等）
    const hasAuthChanges = detectAuthChanges(settingsToUpdate);
    
    // 生成唯一更新ID，用于跟踪更新状态
    const updateId = generateUniqueId();
    
    // 初始化更新状态，记录要更新的设置项
    seedUpdateStatus(updateId, Object.keys(settingsToUpdate));

    // 分发设置更新任务到后台处理
    const dispatchResult = await dispatchUpdateTask(settingsToUpdate, updateId, hasAuthChanges, auditContextBuilder);
    
    // 构建响应，根据是否有认证更改返回不同的状态码
    const response = buildUpdateResponse(dispatchResult, hasAuthChanges, settingsToUpdate, auditContextBuilder);
    return res.status(response.statusCode).json(response.body);
  } catch (error) {
    logger.error('设置更新过程中发生未预期的错误:', error);
    return res.status(500).json({
      error: '服务器内部错误，请稍后重试',
      message: error.message
    });
  }
};

/**
 * 获取设置更新状态
 * 
 * 查询指定更新ID的设置更新状态，支持多种参数名：
 * - query.id 或 query.updateId
 * - body.id 或 body.updateId
 * 
 * @param {Object} req - Express请求对象，包含更新ID参数
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应，包含更新状态信息
 */
exports.getSettingsUpdateStatus = async (req, res) => {
  // 支持多种参数名获取更新ID
  const id = req.query?.id || req.query?.updateId || req.body?.id || req.body?.updateId;
  const result = await resolveUpdateStatus(id);
  return res.status(result.statusCode).json(result.body);
};

/**
 * 更新设置状态（内部调用）
 * 
 * 用于内部服务更新设置操作的状态，通常由后台任务调用
 * 
 * @param {string} status - 更新状态（pending、success、failed、timeout）
 * @param {string} message - 状态消息（可选）
 * @param {string} updateId - 更新ID（可选）
 */
exports.updateSettingsStatus = (status, message = null, updateId = null) => {
  applyStatusUpdate(updateId, status, message);
};

/**
 * 获取各类状态表信息
 * 
 * 获取系统中各种处理任务的状态信息，包括：
 * - 索引状态：文件索引处理的进度和状态
 * - 缩略图状态：缩略图生成和同步状态
 * - HLS状态：视频HLS转换状态
 * 
 * @param {Object} _req - Express请求对象（未使用）
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应，包含各类状态信息
 */
exports.getStatusTables = async (_req, res) => {
  try {
    const statusTables = {
      index: await getIndexStatus(), // 索引状态
      thumbnail: await thumbnailSyncService.getThumbnailStatus(), // 缩略图状态
      hls: await getHlsStatus() // HLS状态
    };

    res.json({
      success: true,
      data: statusTables,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('获取状态表信息失败:', error);
    res.status(500).json({ success: false, error: '获取状态表信息失败', message: error.message });
  }
};

/**
 * 触发补全任务
 * 
 * 手动触发系统补全任务，支持的类型包括：
 * - index: 重建文件索引
 * - thumbnail: 补全缺失的缩略图
 * - hls: 补全缺失的HLS视频文件
 * - all: 执行所有补全任务
 * 
 * 索引补全需要特殊权限验证和管理员密钥验证
 * 
 * @param {Object} req - Express请求对象，包含补全类型参数
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应，包含补全任务启动结果
 */
exports.triggerSync = async (req, res) => {
  try {
    const { type } = req.params;
    const validTypes = ['index', 'thumbnail', 'hls', 'all'];

    // 校验类型是否合法
    if (!validTypes.includes(type)) {
      return res.status(400).json({ success: false, error: '无效的补全类型', validTypes });
    }

    // 如果是索引补全，需要权限校验和管理员密钥校验
    if (type === 'index') {
      const hasPermissionToRun = hasPermission(getUserRole(req), PERMISSIONS.GENERATE_THUMBNAILS);
      if (!hasPermissionToRun) {
        return res.status(403).json({
          success: false,
          error: '权限不足，无法访问此资源',
          message: '需要先设置访问密码才能重建索引'
        });
      }

      // 获取管理员密钥
      const adminSecret = req.headers['x-admin-secret'] || req.body?.adminSecret;
      
      // 构建审计上下文
      const buildCtx = (extra) => ({
        requestId: req.requestId || '-',
        userId: (req.user && req.user.id) ? String(req.user.id) : 'anonymous',
        action: 'trigger_sync',
        type: 'index',
        sensitive: true,
        ...extra
      });

      // 校验敏感操作
      const verifyResult = await verifySensitiveOperations(true, adminSecret, buildCtx);
      if (!verifyResult.ok) {
        return res.status(verifyResult.code).json({ success: false, error: '重建索引验证失败', message: verifyResult.msg });
      }

      logger.info(JSON.stringify(buildCtx({ status: 'approved', message: '重建索引管理员密钥验证成功' })));
    }

    // 触发补全操作
    const syncResult = await triggerSyncOperation(type);
    res.json({
      success: true,
      message: `已启动${getTypeDisplayName(type)}补全任务`,
      data: syncResult,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`触发${req.params.type}补全失败:`, error);
    res.status(500).json({ success: false, error: '补全操作失败', message: error.message });
  }
};

/**
 * 手动重同步缩略图状态
 * 
 * 重新扫描所有媒体文件，更新缩略图状态表
 * 用于修复缩略图状态不一致的问题
 * 
 * @param {Object} _req - Express请求对象（未使用）
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应，包含同步结果
 */
exports.resyncThumbnails = async (_req, res) => {
  try {
    logger.info('手动触发缩略图状态重同步请求');
    const syncedCount = await thumbnailSyncService.resyncThumbnailStatus();
    res.json({
      success: true,
      message: `缩略图状态重同步完成，共同步 ${syncedCount} 个文件`,
      data: { syncedCount },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('手动触发缩略图状态重同步请求失败:', error);
    res.status(500).json({ success: false, error: '缩略图状态重同步失败', message: error.message });
  }
};

/**
 * 触发清理任务
 * 
 * 手动触发系统清理任务，支持的类型包括：
 * - thumbnail: 清理冗余的缩略图文件
 * - hls: 清理冗余的HLS视频文件
 * - all: 执行所有清理任务
 * 
 * 清理任务会删除源文件已不存在的缩略图和HLS文件
 * 
 * @param {Object} req - Express请求对象，包含清理类型参数
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应，包含清理任务结果
 */
exports.triggerCleanup = async (req, res) => {
  try {
    const { type } = req.params;
    const validTypes = ['thumbnail', 'hls', 'all'];

    // 校验类型是否合法
    if (!validTypes.includes(type)) {
      return res.status(400).json({ success: false, error: '无效的同步类型', validTypes });
    }

    // 触发清理操作
    const cleanupResult = await triggerCleanupOperation(type);
    res.json({
      success: true,
      message: `已启动${getTypeDisplayName(type)}同步任务`,
      data: cleanupResult,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`触发${req.params.type}同步失败:`, error);
    res.status(500).json({ success: false, error: '同步操作失败', message: error.message });
  }
};