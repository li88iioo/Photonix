const { sanitizePath, isPathSafe } = require('../utils/path.utils');

/**
 * 路径验证中间件工厂函数
 * @param {'param' | 'body'} source - 路径来源 ('param' for req.params[0], 'body' for req.body.path)
 * @returns {function} Express中间件
 */
const validatePath = (source = 'param') => (req, res, next) => {
    let rawPath = '';

    if (source === 'param') {
        rawPath = req.params[0] || '';
    } else if (source === 'body') {
        rawPath = req.body.path || '';
    } else {
        // 如果来源无效，直接抛出服务器错误
        return next(new Error('无效的路径验证来源'));
    }

    const sanitizedPath = sanitizePath(rawPath);

    if (!isPathSafe(sanitizedPath)) {
        return res.status(403).json({ code: 'PATH_FORBIDDEN', message: '路径访问被拒绝', requestId: req.requestId });
    }

    // 将清理和验证过的路径附加到请求对象上，供后续处理器使用
    req.sanitizedPath = sanitizedPath;
    next();
};

module.exports = validatePath;
