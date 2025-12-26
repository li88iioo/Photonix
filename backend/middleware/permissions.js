/**
 * @file 权限控制中间件模块
 * @description 实现基于角色的访问控制（RBAC），支持细粒度权限检查。当前仅区分普通用户和访客两种角色。
 */

const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;

/**
 * 用户角色常量枚举
 * @readonly
 * @enum {string}
 * @property {string} USER  - 认证用户，仅有普通用户角色
 * @property {string} GUEST - 未认证用户，访客角色
 * @note 当前项目无账户体系，仅区分普通用户和访客
 */
const ROLES = {
    USER: 'user',
    GUEST: 'guest'
};

/**
 * 权限常量枚举
 * @readonly
 * @enum {string}
 * @property {string} GENERATE_THUMBNAILS - 生成缩略图权限
 * @property {string} VIEW_THUMBNAILS     - 查看缩略图权限
 * @property {string} SEARCH_FILES        - 文件搜索权限
 * @property {string} VIEW_SETTINGS       - 查看系统设置权限
 * @property {string} USE_AI_FEATURES     - 使用AI功能权限
 * @note 本项目所有认证用户均为普通用户身份，相关权限按需指定
 */
const PERMISSIONS = {
    GENERATE_THUMBNAILS: 'generate:thumbnails',  // 生成缩略图
    VIEW_THUMBNAILS: 'view:thumbnails',          // 查看缩略图
    SEARCH_FILES: 'search:files',                // 文件搜索
    VIEW_SETTINGS: 'view:settings',              // 查看设置
    USE_AI_FEATURES: 'use:ai_features'           // AI核心功能
    // 文件操作以及高级搜索等权限未启用
};

/**
 * 角色 - 权限映射表
 * @type {Object.<string, string[]>}
 * @desc 配置各角色所拥有的权限列表
 * @note 仅包含"普通用户"和"访客"两类角色
 */
const ROLE_PERMISSIONS = {
    [ROLES.USER]: [
        // 普通用户的所有权限
        PERMISSIONS.GENERATE_THUMBNAILS,  // 核心功能：缩略图批量补全
        PERMISSIONS.VIEW_THUMBNAILS,      // 查看缩略图
        PERMISSIONS.SEARCH_FILES,         // 文件搜索
        PERMISSIONS.VIEW_SETTINGS,        // 查看设置
        PERMISSIONS.USE_AI_FEATURES       // AI功能
    ],
    [ROLES.GUEST]: [
        // 访客的只读权限
        PERMISSIONS.VIEW_THUMBNAILS,      // 查看缩略图
        PERMISSIONS.SEARCH_FILES          // 文件搜索
    ]
};

/**
 * 获取当前请求用户角色
 * @function
 * @param {import('express').Request} req - Express请求对象
 * @returns {string} 用户角色字符串（user/guest）
 * @description
 *   判断逻辑：
 *     1. 存在 req.user 且存在 user.id 视为认证用户，角色为 USER
 *     2. 否则视为访客，角色为 GUEST
 */
function getUserRole(req) {
    // 约定：auth 中间件会将未认证用户设置为 { id: 'anonymous' } 以保证下游安全访问。
    // RBAC 必须显式将该占位身份视为访客，否则会导致匿名请求被误判为认证用户。
    if (req.user && req.user.id && req.user.id !== 'anonymous') {
        return ROLES.USER;
    }
    return ROLES.GUEST;
}

/**
 * 检查指定用户角色是否包含给定权限
 * @function
 * @param {string} userRole - 用户角色
 * @param {string} requiredPermission - 所需权限
 * @returns {boolean} 是否具有该权限
 */
function hasPermission(userRole, requiredPermission) {
    const rolePermissions = ROLE_PERMISSIONS[userRole] || [];
    return rolePermissions.includes(requiredPermission);
}

/**
 * 权限中间件生成器
 * @function
 * @param {string|string[]} requiredPermissions - 期望检测的权限（单个或权限数组）
 * @param {Object} [options={}] - 可选配置
 * @returns {function(import('express').Request, import('express').Response, import('express').NextFunction):void}
 *  Express中间件，检查用户是否具备所有指定权限
 *
 * @example
 *   router.post('/ai', requirePermission(PERMISSIONS.USE_AI_FEATURES), handler)
 */
function requirePermission(requiredPermissions, options = {}) {
    const permissions = Array.isArray(requiredPermissions) ? requiredPermissions : [requiredPermissions];

    return (req, res, next) => {
        try {
            const userRole = getUserRole(req);
            const userPermissions = ROLE_PERMISSIONS[userRole] || [];

            // 判断用户是否拥有所有必需权限
            const hasAllPermissions = permissions.every(permission =>
                userPermissions.includes(permission)
            );

            if (!hasAllPermissions) {
                const missingPermissions = permissions.filter(permission =>
                    !userPermissions.includes(permission)
                );

                logger.warn(`[${req.requestId || '-'}] 权限不足: 用户角色=${userRole}, 缺少权限=${missingPermissions.join(', ')}, 路径=${req.method} ${req.originalUrl}`);
                logger.debug(`[${req.requestId || '-'}] 权限调试信息:`, {
                    userId: req.user?.id,
                    userRole: userRole,
                    userPermissions: userPermissions,
                    requiredPermissions: permissions,
                    missingPermissions: missingPermissions
                });

                return res.status(403).json({
                    code: 'INSUFFICIENT_PERMISSIONS',
                    message: '权限不足，无法访问此资源',
                    requestId: req.requestId,
                    requiredPermissions: permissions,
                    userRole: userRole
                });
            }

            // 添加用户角色和权限至请求对象
            req.userRole = userRole;
            req.userPermissions = userPermissions;

            next();
        } catch (error) {
            logger.error(`[${req.requestId || '-'}] 权限检查失败:`, error);
            return res.status(500).json({
                code: 'PERMISSION_CHECK_ERROR',
                message: '权限检查时发生错误',
                requestId: req.requestId
            });
        }
    };
}

/**
 * 移除说明：
 * - 条件权限检查函数 conditionalPermission
 * - 基于请求方法的权限映射函数 methodBasedPermissions
 * - 文件操作权限检查 fileOperationPermission
 * 项目当前未使用以上高级权限机制，如需请自行添加。
 */

/**
 * 管理员角色和 requireAdmin 函数已移除。
 * 若需管理功能请使用环境变量 ADMIN_SECRET 做额外验证。
 */

module.exports = {
    ROLES,
    PERMISSIONS,
    ROLE_PERMISSIONS,
    requirePermission,
    // conditionalPermission,     // 已移除：无条件权限检查需求
    // methodBasedPermissions,    // 已移除：无方法基权限需求
    // fileOperationPermission,   // 已移除：无文件操作权限需求
    getUserRole,
    hasPermission
};
