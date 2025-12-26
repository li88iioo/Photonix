/**
 * 读取请求中的管理员密钥。
 * 检查请求头（x-admin-secret 或 x-photonix-admin-secret）、请求体和查询参数中的 adminSecret 字段。
 * @param {Object} req - Express 请求对象
 * @returns {string|undefined} 管理员密钥或未找到时为 undefined
 */
function readAdminSecret(req) {
  return req?.headers?.['x-admin-secret']
    || req?.headers?.['x-photonix-admin-secret']
    || req?.body?.adminSecret
    || req?.query?.adminSecret;
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
