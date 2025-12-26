/**
 * @file pathValidator.js
 * @module middleware/pathValidator
 * @description 路径安全验证中间件，负责过滤、校验接口所涉及的路径字符串，防范恶意路径攻击、目录遍历和非法访问
 */

const { sanitizePath, isPathSafe } = require('../utils/path.utils');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;

/**
 * @const {number} MAX_PATH_LENGTH
 * 路径最大允许长度（默认2048，可通过环境变量 MAX_PATH_LENGTH 配置）
 * 注意：URL编码后的中文字符会占用3倍字节，因此需要更大的限制
 */
const MAX_PATH_LENGTH = Number(process.env.MAX_PATH_LENGTH) || 2048;

/**
 * @const {number} MAX_PATH_DEPTH
 * 路径最大允许嵌套层数（默认20，可通过环境变量 MAX_PATH_DEPTH 配置）
 */
const MAX_PATH_DEPTH = Number(process.env.MAX_PATH_DEPTH) || 20;

/**
 * 路径验证中间件工厂函数
 * 对请求路径进行长度、深度和安全性校验，附加清理后的安全路径到 req.sanitizedPath
 *
 * @param {'param'|'body'} source 路径的来源('param'用于 req.params[0]，'body'用于 req.body.path)
 * @returns {import('express').RequestHandler} 路径验证中间件
 */
const validatePath = (source = 'param') => (req, res, next) => {
    let rawPath = '';

    if (source === 'param') {
        rawPath = req.params[0] || '';
    } else if (source === 'body') {
        rawPath = req.body.path || '';
    } else {
        // 路径来源参数非法
        return next(new Error('无效的路径验证来源'));
    }

    // 1. 路径长度校验（先于清理，防止消耗内存资源）
    if (rawPath.length > MAX_PATH_LENGTH) {
        logger.warn(`[${req.requestId || '-'}] 路径长度超过限制: ${rawPath.length} > ${MAX_PATH_LENGTH}`);
        return res.status(400).json({
            code: 'PATH_TOO_LONG',
            message: `路径长度超过限制（最大${MAX_PATH_LENGTH}字符）`,
            requestId: req.requestId
        });
    }

    // 2. 路径深度校验（防范多级嵌套目录攻击）
    const pathParts = rawPath.split(/[/\\]/).filter(Boolean);
    if (pathParts.length > MAX_PATH_DEPTH) {
        logger.warn(`[${req.requestId || '-'}] 路径深度超过限制: ${pathParts.length} > ${MAX_PATH_DEPTH}`);
        return res.status(400).json({
            code: 'PATH_TOO_DEEP',
            message: `路径深度超过限制（最大${MAX_PATH_DEPTH}层）`,
            requestId: req.requestId
        });
    }

    // 3. 路径清理（去除危险字符及序列）
    const sanitizedPath = sanitizePath(rawPath);

    // 4. 路径安全性验证（判断是否在允许访问的目录范围）
    if (!isPathSafe(sanitizedPath)) {
        return res.status(403).json({
            code: 'PATH_FORBIDDEN',
            message: '路径访问被拒绝',
            requestId: req.requestId
        });
    }

    /**
     * @property {string} req.sanitizedPath
     * 清理及校验后的安全路径，提供给后续请求流程使用
     */
    req.sanitizedPath = sanitizedPath;
    next();
};

module.exports = validatePath;
