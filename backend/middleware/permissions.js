/**
 * 权限控制中间件模块
 * 提供细粒度的权限控制，支持基于角色的访问控制(RBAC)
 */

const logger = require('../config/logger');

/**
 * 用户角色枚举
 * 注意：项目没有完整的账户系统，只有普通用户和访客两种角色
 */
const ROLES = {
    USER: 'user',
    GUEST: 'guest'
};

/**
 * 权限枚举
 * 注意：项目没有完整的账户系统，所有认证用户都是普通用户角色
 */
const PERMISSIONS = {
    // 核心功能权限（项目实际需要的）
    GENERATE_THUMBNAILS: 'generate:thumbnails',  // 缩略图批量补全
    VIEW_THUMBNAILS: 'view:thumbnails',         // 查看缩略图
    SEARCH_FILES: 'search:files',               // 文件搜索
    VIEW_SETTINGS: 'view:settings',             // 查看设置
    USE_AI_FEATURES: 'use:ai_features'          // AI功能

    // 注意：移除了以下权限，因为项目不需要
    // READ_FILES, WRITE_FILES, DELETE_FILES - 文件操作权限
    // ADVANCED_SEARCH - 高级搜索权限
};

/**
 * 角色权限映射
 * 注意：项目没有完整的账户系统，只有普通用户和访客两种角色
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
 * 获取用户角色
 * @param {Object} req - 请求对象
 * @returns {string} 用户角色
 */
function getUserRole(req) {
    // 简化权限模型：项目没有账户系统
    // 所有认证用户都是普通用户，未认证用户是访客
    if (req.user && req.user.id) {
        return ROLES.USER;
    }
    return ROLES.GUEST;
}

/**
 * 检查用户是否有指定权限
 * @param {string} userRole - 用户角色
 * @param {string} requiredPermission - 所需权限
 * @returns {boolean} 是否有权限
 */
function hasPermission(userRole, requiredPermission) {
    const rolePermissions = ROLE_PERMISSIONS[userRole] || [];
    return rolePermissions.includes(requiredPermission);
}

/**
 * 权限检查中间件生成器
 * @param {string|string[]} requiredPermissions - 所需权限
 * @param {Object} options - 配置选项
 * @returns {Function} Express中间件函数
 */
function requirePermission(requiredPermissions, options = {}) {
    const permissions = Array.isArray(requiredPermissions) ? requiredPermissions : [requiredPermissions];

    return (req, res, next) => {
        try {
            const userRole = getUserRole(req);
            const userPermissions = ROLE_PERMISSIONS[userRole] || [];

            // 检查是否拥有所有必需权限
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

            // 将用户信息添加到请求对象
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
 * 注意：移除了以下高级权限函数，因为项目中不需要
 * - conditionalPermission (条件权限检查)
 * - methodBasedPermissions (基于请求方法的权限映射)
 * - fileOperationPermission (文件操作权限检查)
 *
 * 如需这些高级功能，可以重新添加
 */

/**
 * 注意：项目没有管理员角色，requireAdmin函数已移除
 * 如需管理员功能，请使用ADMIN_SECRET环境变量进行验证
 */

module.exports = {
    ROLES,
    PERMISSIONS,
    ROLE_PERMISSIONS,
    requirePermission,
    // conditionalPermission,     // 已移除：项目不需要条件权限检查
    // methodBasedPermissions,    // 已移除：项目不需要基于请求方法的权限映射
    // fileOperationPermission,   // 已移除：项目不需要文件操作权限检查
    getUserRole,
    hasPermission
};
