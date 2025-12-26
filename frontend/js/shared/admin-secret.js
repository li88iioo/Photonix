/**
 * 向请求头中添加管理员密钥（X-Admin-Secret）。
 * 如果未提供 adminSecret，则原样返回 headers。
 * 支持 Headers 实例和普通对象两种格式。
 *
 * @param {Headers|Object} headers - 请求头对象，可为 Headers 实例或普通对象
 * @param {string} adminSecret - 管理员密钥
 * @returns {Headers|Object} 已添加密钥的 headers
 */
export function applyAdminSecretHeader(headers, adminSecret) {
  if (!adminSecret) return headers;
  if (headers instanceof Headers) {
    headers.set('X-Admin-Secret', adminSecret);
    return headers;
  }
  headers['X-Admin-Secret'] = adminSecret;
  return headers;
}
