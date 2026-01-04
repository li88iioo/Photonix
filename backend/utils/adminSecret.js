const logger = require('../config/logger');

/**
 * 读取请求中的管理员密钥。
 * 检查请求头（x-admin-secret 或 x-photonix-admin-secret）、请求体和查询参数中的 adminSecret 字段。
 * 注意：通过查询参数传递密钥存在安全风险（可能被记录到日志/浏览器历史），建议优先使用请求头。
 * @param {Object} req - Express 请求对象
 * @returns {string|undefined} 管理员密钥或未找到时为 undefined
 */
function readAdminSecret(req) {
  // 优先使用请求头（更安全）
  const fromHeader = req?.headers?.['x-admin-secret']
    || req?.headers?.['x-photonix-admin-secret'];
  if (fromHeader) return fromHeader;

  // 请求体次之
  if (req?.body?.adminSecret) return req.body.adminSecret;

  // 查询参数最后（记录警告，因为存在泄露风险）
  if (req?.query?.adminSecret) {
    logger.debug('[AdminSecret] 检测到通过查询参数传递密钥，建议改用请求头 x-admin-secret');
    return req.query.adminSecret;
  }

  return undefined;
}

/**
 * 移除请求体和查询参数中的 adminSecret 字段，以防止敏感信息泄露。
 * @param {Object} req - Express 请求对象
 */
function scrubAdminSecret(req) {
  if (req?.body && Object.prototype.hasOwnProperty.call(req.body, 'adminSecret')) {
    delete req.body.adminSecret;
  }
  if (req?.query && Object.prototype.hasOwnProperty.call(req.query, 'adminSecret')) {
    delete req.query.adminSecret;
  }
}

module.exports = {
  readAdminSecret,
  scrubAdminSecret,
};
