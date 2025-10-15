/**
 * @file optional-auth.js
 * @description 可选的JWT认证中间件 - 如果有Token则验证，没有则跳过
 */

const jwt = require('jsonwebtoken');
const logger = require('../config/logger');

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
            logger.error('[OptionalAuth] JWT_SECRET未配置');
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
            
            // 只在详细调试模式下记录，避免刷屏
            // logger.debug(`[OptionalAuth] JWT认证成功: ${decoded.sub || decoded.userId || 'download_user'}`);
        } catch (error) {
            if (error.name === 'TokenExpiredError') {
                // logger.debug('[OptionalAuth] Token已过期');
            } else if (error.name === 'JsonWebTokenError') {
                // logger.debug('[OptionalAuth] Token无效');
            } else {
                logger.error('[OptionalAuth] Token验证错误:', error);
            }
            
            // Token无效，但不阻止请求（可能使用密钥）
            req.user = null;
        }
        
        next();
    } catch (error) {
        logger.error('[OptionalAuth] 中间件错误:', error);
        req.user = null;
        next();
    }
};
