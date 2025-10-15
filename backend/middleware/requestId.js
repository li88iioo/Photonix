/**
 * 请求ID中间件
 * 
 * 本中间件用于为每个HTTP请求分配唯一的请求ID（X-Request-Id），
 * 优先使用请求头中传入的 x-request-id，否则自动生成一个UUID。
 * 该ID会绑定在 req.requestId 上，并在响应头中返回，
 * 便于请求链路追踪和日志记录。
 */

const { v4: uuidv4 } = require('uuid');

/**
 * 返回一个中间件函数，用于生成或获取请求ID
 * @returns {Function} Express中间件
 */
function requestId() {
  return (req, res, next) => {
    // 获取请求头中的 x-request-id，无则生成UUID
    const id = req.headers['x-request-id'] || uuidv4();
    // 在req对象和响应头中设置请求ID
    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

module.exports = requestId;

