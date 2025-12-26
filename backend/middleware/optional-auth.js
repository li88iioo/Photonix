/**
 * @file optional-auth.js
 * @description 可选的JWT认证中间件 - 如果有Token则验证，没有则跳过
 */

const jwt = require('jsonwebtoken');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * 可选认证中间件
 * - 如果请求带有Bearer Token，验证它
 * - 如果没有Token，继续执行（让后续中间件处理）
 * - 用于支持JWT和密钥双重认证模式
 */
module.exports = async function optionalAuth(req, res, next) {
    try {
        // 从请求头获取JWT令牌
        const authHeader = req.header('Authorization');
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            // 没有Token，继续执行（可能使用密钥认证）
            req.user = null;
            return next();
        }

        const token = authHeader.replace('Bearer ', '');
        
        if (!JWT_SECRET) {
            logger.error(`${LOG_PREFIXES.AUTH} OptionalAuth JWT_SECRET 未配置`);
            req.user = null;
            return next();
        }

        try {
            // 验证Token
            const decoded = jwt.verify(token, JWT_SECRET);

            // Token有效，标记为已认证
            req.user = {
                ...decoded,
                authenticated: true,
                authMethod: 'jwt'
            };
        } catch (error) {
            if (error.name === 'TokenExpiredError') {
                req.user = null;
            } else if (error.name === 'JsonWebTokenError') {
                req.user = null;
            } else {
                logger.error(`${LOG_PREFIXES.AUTH} OptionalAuth Token 验证错误`, { error: error && error.message });
                req.user = null;
            }
        }
        
        next();
    } catch (error) {
        logger.error(`${LOG_PREFIXES.AUTH} OptionalAuth 中间件错误`, { error: error && error.message });
        req.user = null;
        next();
    }
};
