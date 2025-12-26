const downloadService = require('../services/download.service');
const {
  ValidationError,
  AuthorizationError,
  ConfigurationError,
  AppError
} = require('../utils/errors');
const { verifyAdminSecret } = require('../services/settings/update.service');
const { readAdminSecret, scrubAdminSecret } = require('../utils/adminSecret');
const settingsService = require('../services/settings.service');

const ADMIN_SECRET_CACHE_TTL_MS = Number(process.env.DOWNLOAD_ADMIN_CACHE_TTL_MS || 5 * 60 * 1000);
const adminSecretCache = {
  secret: null,
  expiresAt: 0
};

/**
 * 从请求中提取管理员密钥
 * 支持两种方式：
 * 1. JWT Token (推荐，更安全)
 * 2. 直接传递密钥 (向后兼容)
 * @param {Request} req 
 * @returns {string|undefined}
 */
function extractAdminSecret(req) {
  // 如果有JWT认证，直接通过（已在auth中间件验证）
  if (req.user && req.user.authenticated) {
    return 'JWT_AUTHENTICATED'; // 特殊标记，表示已通过JWT认证
  }

  // 优先 Header；兼容旧客户端 body/query（读取后会立刻删除，尽量避免泄露）
  return readAdminSecret(req);
}

/**
 * 将下载服务返回的密钥校验结果转为合适的错误对象
 * @param {Object} result 
 * @returns {Error}
 */
function mapAdminSecretError(result) {
  const message = result?.msg || '管理员密钥验证失败';
  const code = Number(result?.code) || 500;

  if (code === 400) {
    return new ValidationError(message);
  }

  if (code === 401 || code === 403) {
    return new AuthorizationError(message);
  }

  if (code === 500) {
    return new ConfigurationError(message);
  }

  return new AppError(message, code);
}

/**
 * 校验管理员权限，不通过则抛出错误，否则自动删除明文密钥
 * @param {Request} req 
 */
async function ensureAdminAccess(req) {
  // 若请求中错误地携带了明文密钥，提前删除，避免后续日志/中间件误记录
  const adminSecret = extractAdminSecret(req);
  scrubAdminSecret(req);

  // 如果已通过JWT认证，直接放行
  if (adminSecret === 'JWT_AUTHENTICATED') {
    return;
  }

  // 检查密码功能是否开启 - 下载管理功能需要密码功能已启用
  try {
    const settings = await settingsService.getAllSettings();
    const isPasswordEnabled = settings?.PASSWORD_ENABLED === 'true';
    if (!isPasswordEnabled) {
      // 密码功能未启用，禁止访问下载管理页面
      throw new AuthorizationError('下载管理功能需要先启用访问密码');
    }
  } catch (settingsError) {
    // 如果是我们抛出的 AuthorizationError，直接传递
    if (settingsError instanceof AuthorizationError) {
      throw settingsError;
    }
    // 其他错误（如获取设置失败），继续原有验证流程
  }

  const now = Date.now();

  if (
    adminSecretCache.secret === adminSecret &&
    adminSecretCache.expiresAt > now
  ) {
    return;
  }

  const result = await verifyAdminSecret(adminSecret);
  if (!result.ok) {
    throw mapAdminSecretError(result);
  }

  adminSecretCache.secret = adminSecret;
  adminSecretCache.expiresAt = now + ADMIN_SECRET_CACHE_TTL_MS;
}

/**
 * 获取下载服务状态
 * @route GET /download/status
 */
exports.getServiceStatus = async (req, res) => {
  await ensureAdminAccess(req);
  const data = await downloadService.getServiceStatus();
  res.json({
    success: true,
    data,
    timestamp: new Date().toISOString()
  });
};

/**
 * 分页获取下载历史
 * @route GET /download/history
 */
exports.getHistory = async (req, res) => {
  await ensureAdminAccess(req);
  const page = Number(req.query?.page) || 1;
  const pageSize = Number(req.query?.pageSize) || 50;
  const data = await downloadService.getHistory({ page, pageSize });
  res.json({
    success: true,
    data,
    timestamp: new Date().toISOString()
  });
};

/**
 * 获取下载任务列表
 * @route GET /download/tasks
 */
exports.listTasks = async (req, res) => {
  await ensureAdminAccess(req);
  const tasks = await downloadService.listTasks(req.query || {});
  res.json({
    success: true,
    data: tasks,
    timestamp: new Date().toISOString()
  });
};

/**
 * 创建新的下载任务
 * @route POST /download/tasks
 */
exports.createTask = async (req, res) => {
  await ensureAdminAccess(req);
  const payload = req.body || {};
  const result = await downloadService.createTask(payload);
  res.status(201).json({
    success: true,
    data: result,
    timestamp: new Date().toISOString()
  });
};

/**
 * 更新指定下载任务
 * @route PATCH /download/tasks/:taskId
 */
exports.updateTask = async (req, res) => {
  await ensureAdminAccess(req);
  const { taskId } = req.params;
  const payload = req.body || {};
  const result = await downloadService.updateTask(taskId, payload);
  res.json({
    success: true,
    data: result,
    timestamp: new Date().toISOString()
  });
};

/**
 * 对单个任务执行指定动作（如重试、暂停等）
 * @route POST /download/tasks/:taskId/:action
 */
exports.triggerTaskAction = async (req, res) => {
  await ensureAdminAccess(req);
  const { taskId, action } = req.params;
  const payload = req.body || {};
  const result = await downloadService.triggerTaskAction(taskId, action, payload);
  res.json({
    success: true,
    data: result,
    timestamp: new Date().toISOString()
  });
};

/**
 * 删除指定下载任务
 * @route DELETE /download/tasks/:taskId
 */
exports.deleteTask = async (req, res) => {
  await ensureAdminAccess(req);
  const { taskId } = req.params;
  const result = await downloadService.deleteTask(taskId);
  res.json({
    success: true,
    data: result,
    timestamp: new Date().toISOString()
  });
};

/**
 * 获取某任务的日志
 * @route GET /download/tasks/:taskId/logs
 */
exports.getTaskLogs = async (req, res) => {
  await ensureAdminAccess(req);
  const { taskId } = req.params;
  const logs = await downloadService.getTaskLogs(taskId, req.query || {});
  res.json({
    success: true,
    data: logs,
    timestamp: new Date().toISOString()
  });
};

/**
 * 获取全局日志
 * @route GET /download/logs
 */
exports.getGlobalLogs = async (req, res) => {
  await ensureAdminAccess(req);
  const logs = await downloadService.getGlobalLogs(req.query || {});
  res.json({
    success: true,
    data: logs,
    timestamp: new Date().toISOString()
  });
};

exports.clearGlobalLogs = async (req, res) => {
  await ensureAdminAccess(req);
  const result = await downloadService.clearGlobalLogs(req.body || {});
  res.json({
    success: true,
    data: result,
    timestamp: new Date().toISOString()
  });
};

exports.previewFeed = async (req, res) => {
  await ensureAdminAccess(req);
  const { taskId } = req.params;
  const preview = await downloadService.previewFeed(taskId, req.query || {});
  res.json({
    success: true,
    data: preview,
    timestamp: new Date().toISOString()
  });
};

exports.downloadSelectedEntries = async (req, res) => {
  await ensureAdminAccess(req);
  const { taskId } = req.params;
  const payload = req.body || {};
  const result = await downloadService.downloadSelectedEntries(taskId, payload);
  res.json({
    success: true,
    data: result,
    timestamp: new Date().toISOString()
  });
};

/**
 * 获取下载服务配置
 * @route GET /download/config
 */
exports.getConfig = async (req, res) => {
  await ensureAdminAccess(req);
  const config = await downloadService.getConfig();
  res.json({
    success: true,
    data: config,
    timestamp: new Date().toISOString()
  });
};

/**
 * 更新下载服务配置
 * @route PUT /download/config
 */
exports.updateConfig = async (req, res) => {
  await ensureAdminAccess(req);
  const payload = req.body || {};
  const config = await downloadService.updateConfig(payload);
  res.json({
    success: true,
    data: config,
    timestamp: new Date().toISOString()
  });
};

exports.exportOpml = async (req, res) => {
  await ensureAdminAccess(req);
  const result = await downloadService.exportOpml();
  res.json({
    success: true,
    data: result,
    timestamp: new Date().toISOString()
  });
};

exports.importOpml = async (req, res) => {
  await ensureAdminAccess(req);
  const payload = req.body || {};
  const result = await downloadService.importOpml(payload.content, { mode: payload.mode });
  res.json({
    success: true,
    data: result,
    timestamp: new Date().toISOString()
  });
};

/**
 * 代理下载服务其他接口请求
 * @route ANY /download/proxy/:path*
 */
exports.proxy = async (req, res) => {
  await ensureAdminAccess(req);
  const { path } = req.params;

  const proxied = await downloadService.proxy({
    method: req.method,
    path: `/${path || ''}`,
    body: req.body,
    query: req.query
  });

  res.json({
    success: true,
    data: proxied,
    timestamp: new Date().toISOString()
  });
};
