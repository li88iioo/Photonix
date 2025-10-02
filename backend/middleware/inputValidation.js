/**
 * 输入验证中间件模块
 * 提供安全的输入验证和清理功能
 */

const logger = require('../config/logger');

/**
 * 危险字符模式 - 修复版，区分真正的安全威胁和正常字符
 */
const DANGEROUS_PATTERNS = [
    // 路径遍历攻击模式
    /(\.\.\/|\.\.\\|~\/|\/~)/,  // 路径遍历变体
    /(%2e%2e%2f|%2e%2e\\|%2f%2e%2e)/i,  // URL编码的路径遍历
    
    // XSS攻击模式
    /(<script|javascript:|vbscript:|onload=|onerror=|onclick=|onmouseover=)/i,  // XSS
    
    // SQL注入模式（更精确的检测）
    /(\\x27|\\x2D\\x2D|;|\\\\|(\$\{)|(\$\())/,  // SQL注入/SQL命令注入
];

/**
 * 文件名中的正常特殊字符（允许使用）
 */
const ALLOWED_SPECIAL_CHARS = /[|&(){}[\]!@#$%^+=,;:'"<>?~`]/;

/**
 * 验证文件路径安全性 - 修复版，更智能的检测
 * @param {string} filePath - 文件路径
 * @returns {boolean} 是否安全
 */
function isSafeFilePath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return false;
    }

    // 1. 检查真正的危险模式（路径遍历、XSS、SQL注入）
    if (DANGEROUS_PATTERNS.some(pattern => pattern.test(filePath))) {
        return false;
    }

    // 2. 检查是否包含危险的文件名
    const dangerousFileNames = [
        '.htaccess', '.htpasswd', 'web.config',
        'passwd', 'shadow', 'hosts', 'resolv.conf',
        'autoexec.bat', 'config.sys', 'boot.ini'
    ];

    const fileName = filePath.split(/[/\\]/).pop()?.toLowerCase();
    if (dangerousFileNames.includes(fileName)) {
        return false;
    }

    // 3. 检查路径长度（防止过长的路径）
    if (filePath.length > 2048) {
        return false;
    }

    // 4. 检查路径深度（防止过深的路径）
    const pathParts = filePath.split(/[/\\]/);
    if (pathParts.length > 20) {
        return false;
    }

    // 5. 检查是否包含控制字符（ASCII 0-31，除了常见的制表符和换行符）
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(filePath)) {
        return false;
    }

    return true;
}

/**
 * 清理和验证用户输入
 * @param {string} input - 用户输入
 * @param {Object} options - 验证选项
 * @returns {string|null} 清理后的输入或null(如果无效)
 */
function sanitizeInput(input, options = {}) {
    if (!input || typeof input !== 'string') {
        return options.allowEmpty ? '' : null;
    }

    let sanitized = input.trim();

    // 长度检查
    if (options.maxLength && sanitized.length > options.maxLength) {
        return null;
    }

    if (options.minLength && sanitized.length < options.minLength) {
        return null;
    }

    // 移除危险字符
    if (options.removeDangerous) {
        DANGEROUS_PATTERNS.forEach(pattern => {
            sanitized = sanitized.replace(pattern, '');
        });
    }

    // 只允许特定字符
    if (options.allowedChars) {
        const allowedRegex = new RegExp(`^[${options.allowedChars}]+$`);
        if (!allowedRegex.test(sanitized)) {
            return null;
        }
    }

    return sanitized;
}

/**
 * 验证搜索查询参数
 * @param {Object} query - 查询参数对象
 * @returns {Object} 验证结果 {isValid: boolean, sanitized: Object, errors: Array}
 */
function validateSearchQuery(query) {
    const result = {
        isValid: true,
        sanitized: {},
        errors: []
    };

    // 验证查询字符串
    if (query.q !== undefined) {
        const sanitized = sanitizeInput(query.q, {
            maxLength: 500,
            removeDangerous: true
        });

        if (sanitized === null) {
            result.isValid = false;
            result.errors.push('查询字符串无效或过长');
        } else {
            result.sanitized.q = sanitized;
        }
    }

    // 验证分页参数
    if (query.page !== undefined) {
        const page = parseInt(query.page, 10);
        if (isNaN(page) || page < 1 || page > 10000) {
            result.isValid = false;
            result.errors.push('页码无效');
        } else {
            result.sanitized.page = page;
        }
    }

    if (query.limit !== undefined) {
        const limit = parseInt(query.limit, 10);
        if (isNaN(limit) || limit < 1 || limit > 1000) {
            result.isValid = false;
            result.errors.push('每页数量无效');
        } else {
            result.sanitized.limit = limit;
        }
    }

    // 验证排序参数
    if (query.sort !== undefined) {
        const allowedSorts = ['name', 'date', 'size', 'smart'];
        if (!allowedSorts.includes(query.sort)) {
            result.isValid = false;
            result.errors.push('排序参数无效');
        } else {
            result.sanitized.sort = query.sort;
        }
    }

    return result;
}

/**
 * 验证文件路径参数 - 增强调试版本
 * @param {string} filePath - 文件路径
 * @returns {Object} 验证结果 {isValid: boolean, sanitized: string, errors: Array}
 */
function validateFilePath(filePath) {
    const result = {
        isValid: true,
        sanitized: null,
        errors: []
    };

    // 调试模式：记录详细的验证过程
    const isDebugMode = process.env.NODE_ENV === 'development' || process.env.DEBUG_VALIDATION === 'true';
    
    if (isDebugMode) {
        logger.debug(`[路径验证] 开始验证路径: "${filePath}"`);
    }

    if (!isSafeFilePath(filePath)) {
        result.isValid = false;
        result.errors.push('文件路径包含危险字符或模式');
        
        if (isDebugMode) {
            // 详细分析哪个模式匹配了
            for (const pattern of DANGEROUS_PATTERNS) {
                if (pattern.test(filePath)) {
                    logger.debug(`[路径验证] 危险模式匹配: ${pattern} 在路径 "${filePath}"`);
                }
            }
        }
        
        return result;
    }

    // 清理路径
    let sanitized = filePath.replace(/\/+/g, '/').replace(/\\+/g, '/');
    sanitized = sanitized.replace(/^\//, ''); // 移除开头的斜杠

    // 检查路径深度
    const pathParts = sanitized.split('/');
    if (pathParts.length > 20) {
        result.isValid = false;
        result.errors.push('文件路径过深');
        return result;
    }

    result.sanitized = sanitized;
    
    if (isDebugMode) {
        logger.debug(`[路径验证] 路径验证通过: "${filePath}" -> "${sanitized}"`);
    }
    
    return result;
}

/**
 * 输入验证中间件生成器
 * @param {Object} validationRules - 验证规则
 * @returns {Function} Express中间件函数
 */
function validateInput(validationRules) {
    return (req, res, next) => {
        try {
            const errors = [];
            const sanitized = {};

            // 验证查询参数
            if (validationRules.query) {
                const queryValidation = validateSearchQuery(req.query);
                if (!queryValidation.isValid) {
                    errors.push(...queryValidation.errors);
                } else {
                    Object.assign(sanitized, queryValidation.sanitized);
                }
            }

            // 验证路径参数
            if (validationRules.params && validationRules.params.filePath) {
                const pathValidation = validateFilePath(req.params.path || req.query.path);
                if (!pathValidation.isValid) {
                    errors.push(...pathValidation.errors);
                } else {
                    sanitized.filePath = pathValidation.sanitized;
                }
            }

            // 验证请求体
            if (validationRules.body) {
                for (const [field, rules] of Object.entries(validationRules.body)) {
                    if (req.body[field] !== undefined) {
                        const sanitizedValue = sanitizeInput(req.body[field], rules);
                        if (sanitizedValue === null) {
                            errors.push(`${field} 参数无效`);
                        } else {
                            sanitized[field] = sanitizedValue;
                        }
                    } else if (rules.required) {
                        errors.push(`${field} 参数缺失`);
                    }
                }
            }

            if (errors.length > 0) {
                // 详细记录验证失败的原因，特别是文件路径问题
                const filePathError = errors.find(error => error.includes('文件路径包含危险字符或模式'));
                if (filePathError) {
                    logger.warn(`[${req.requestId || '-'}] 文件路径验证失败`, {
                        path: req.path,
                        method: req.method,
                        filePath: req.params.path || req.query.path,
                        query: req.query,
                        requestId: req.requestId,
                        validationError: filePathError
                    });
                } else {
                    logger.warn(`[${req.requestId || '-'}] 输入验证失败: ${errors.join(', ')}`);
                }

                return res.status(400).json({
                    code: 'INVALID_INPUT',
                    message: '输入参数无效',
                    errors: errors,
                    requestId: req.requestId
                });
            }

            // 将清理后的数据添加到请求对象
            req.sanitizedInput = sanitized;

            next();
        } catch (error) {
            logger.error(`[${req.requestId || '-'}] 输入验证过程中出错:`, error);

            return res.status(500).json({
                code: 'VALIDATION_ERROR',
                message: '输入验证时发生错误',
                requestId: req.requestId
            });
        }
    };
}

/**
 * 预定义验证规则
 */
const VALIDATION_RULES = {
    searchQuery: {
        query: true
    },

    filePath: {
        params: { filePath: true }
    },

    settingsUpdate: {
        body: {
            PASSWORD_ENABLED: { required: false, maxLength: 10 },
            ALLOW_PUBLIC_ACCESS: { required: false, maxLength: 10 },
            THUMBNAIL_QUALITY: { required: false, allowedChars: '0-9', maxLength: 3 }
        }
    }
};

module.exports = {
    validateInput,
    sanitizeInput,
    validateSearchQuery,
    validateFilePath,
    isSafeFilePath,
    VALIDATION_RULES
};
