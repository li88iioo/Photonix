/**
 * @file inputValidation.js
 * @module inputValidation
 * @description 输入校验中间件模块，提供输入参数校验和清理功能，防范路径遍历、XSS、SQL注入等常见安全风险
 */

const logger = require('../config/logger');

/**
 * @const {RegExp[]} DANGEROUS_PATTERNS
 * 危险字符检测正则集合：用于拦截路径遍历、XSS、SQL注入等攻击向量
 */
const DANGEROUS_PATTERNS = [
    // 路径遍历攻击模式
    /(\.\.\/|\.\.\\|~\/|\/~)/, // 路径遍历变体
    /(%2e%2e%2f|%2e%2e\\|%2f%2e%2e)/i, // URL编码路径遍历
    // XSS攻击模式
    /(<script|javascript:|vbscript:|onload=|onerror=|onclick=|onmouseover=)/i, // XSS相关
    // SQL注入模式
    /(\\x27|\\x2D\\x2D|;|\\\\|(\$\{)|(\$\())/, // SQL命令注入
];

/**
 * @const {RegExp} ALLOWED_SPECIAL_CHARS
 * 允许出现在文件名中的特殊符号，用于白名单辅助
 */
const ALLOWED_SPECIAL_CHARS = /[|&(){}[\]!@#$%^+=,;:'"<>?~`]/;

/**
 * 判断文件路径是否安全
 * @param {string} filePath - 待检测的文件路径
 * @returns {boolean} 若路径安全则返回true，否则返回false
 */
function isSafeFilePath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return false;
    }

    // 检查危险正则
    if (DANGEROUS_PATTERNS.some(pattern => pattern.test(filePath))) {
        return false;
    }

    // 检查危险文件名
    const dangerousFileNames = [
        '.htaccess', '.htpasswd', 'web.config',
        'passwd', 'shadow', 'hosts', 'resolv.conf',
        'autoexec.bat', 'config.sys', 'boot.ini'
    ];
    const fileName = filePath.split(/[/\\]/).pop()?.toLowerCase();
    if (dangerousFileNames.includes(fileName)) {
        return false;
    }

    // 路径长度限制
    if (filePath.length > 2048) {
        return false;
    }

    // 路径深度限制
    const pathParts = filePath.split(/[/\\]/);
    if (pathParts.length > 20) {
        return false;
    }

    // 控制字符过滤
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(filePath)) {
        return false;
    }

    return true;
}

/**
 * 用户输入清理与验证
 * @param {string} input - 原始输入
 * @param {Object} options - 校验规则
 * @param {boolean} [options.allowEmpty] - 是否允许空字符串
 * @param {number} [options.maxLength] - 最大长度
 * @param {number} [options.minLength] - 最小长度
 * @param {boolean} [options.removeDangerous] - 是否移除危险字符
 * @param {string} [options.allowedChars] - 允许字符的正则片段
 * @returns {string|null} 返回处理后输入，或无效时返回null
 */
function sanitizeInput(input, options = {}) {
    if (!input || typeof input !== 'string') {
        return options.allowEmpty ? '' : null;
    }

    let sanitized = input.trim();

    // 长度校验
    if (options.maxLength && sanitized.length > options.maxLength) {
        return null;
    }
    if (options.minLength && sanitized.length < options.minLength) {
        return null;
    }

    // 危险字符移除
    if (options.removeDangerous) {
        DANGEROUS_PATTERNS.forEach(pattern => {
            sanitized = sanitized.replace(pattern, '');
        });
    }

    // 字符集白名单
    if (options.allowedChars) {
        const allowedRegex = new RegExp(`^[${options.allowedChars}]+$`);
        if (!allowedRegex.test(sanitized)) {
            return null;
        }
    }

    return sanitized;
}

/**
 * 搜索参数校验
 * @param {Object} query - 查询参数对象
 * @returns {Object} 校验结果对象 {isValid: boolean, sanitized: Object, errors: Array}
 */
function validateSearchQuery(query) {
    const result = {
        isValid: true,
        sanitized: {},
        errors: []
    };

    // 校验查询关键词
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

    // 校验分页参数
    if (query.page !== undefined) {
        const page = parseInt(query.page, 10);
        if (isNaN(page) || page < 1 || page > 10000) {
            result.isValid = false;
            result.errors.push('页码无效');
        } else {
            result.sanitized.page = page;
        }
    }

    // 校验limit
    if (query.limit !== undefined) {
        const limit = parseInt(query.limit, 10);
        if (isNaN(limit) || limit < 1 || limit > 1000) {
            result.isValid = false;
            result.errors.push('每页数量无效');
        } else {
            result.sanitized.limit = limit;
        }
    }

    // 校验排序字段
    if (query.sort !== undefined) {
        const allowedSorts = [
            'smart', 'name_asc', 'name_desc',
            'mtime_asc', 'mtime_desc', 'viewed_desc'
        ];
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
 * 文件路径参数校验并返回结构体（含调试日志）
 * @param {string} filePath - 文件路径
 * @returns {Object} 校验结构体 {isValid, sanitized, errors}
 */
function validateFilePath(filePath) {
    const result = {
        isValid: true,
        sanitized: null,
        errors: []
    };
    const isDebugMode = process.env.NODE_ENV === 'development' || process.env.DEBUG_VALIDATION === 'true';
    if (isDebugMode) {
        logger.debug(`[路径验证] 开始验证路径: "${filePath}"`);
    }

    if (!isSafeFilePath(filePath)) {
        result.isValid = false;
        result.errors.push('文件路径包含危险字符或模式');
        if (isDebugMode) {
            for (const pattern of DANGEROUS_PATTERNS) {
                if (pattern.test(filePath)) {
                    logger.debug(`[路径验证] 危险模式匹配: ${pattern} 在路径 "${filePath}"`);
                }
            }
        }
        return result;
    }

    // 路径格式标准化：多余的斜杠合并、去首斜杠
    let sanitized = filePath.replace(/\/+/g, '/').replace(/\\+/g, '/');
    sanitized = sanitized.replace(/^\//, '');

    // 校验路径深度
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
 * 输入校验中间件工厂
 * @param {Object} validationRules - 校验规则配置
 * @returns {Function} Express中间件函数
 */
function validateInput(validationRules) {
    return (req, res, next) => {
        try {
            const errors = [];
            const sanitized = {};
            
            // 查询参数校验
            if (validationRules.query) {
                const queryValidation = validateSearchQuery(req.query);
                if (!queryValidation.isValid) {
                    errors.push(...queryValidation.errors);
                } else {
                    Object.assign(sanitized, queryValidation.sanitized);
                }
            }

            // 路径参数校验
            if (validationRules.params && validationRules.params.filePath) {
                const pathValidation = validateFilePath(req.params.path || req.query.path);
                if (!pathValidation.isValid) {
                    errors.push(...pathValidation.errors);
                } else {
                    sanitized.filePath = pathValidation.sanitized;
                }
            }

            // 请求体校验
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
                // 文件路径详尽警告
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

            // 清理结果注入req
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
 *  inputValidation 预设规则常量
 * @readonly
 * @enum {Object}
 */
const VALIDATION_RULES = {
    searchQuery: { query: true },
    filePath: { params: { filePath: true } },
    settingsUpdate: {
        body: {
            PASSWORD_ENABLED:    { required: false, maxLength: 10 },
            ALLOW_PUBLIC_ACCESS: { required: false, maxLength: 10 },
            THUMBNAIL_QUALITY:   { required: false, allowedChars: '0-9', maxLength: 3 }
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
