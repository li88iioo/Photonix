/**
 * 日志模块
 * @module logger
 */
const logger = require('./logger');
const { LOG_PREFIXES } = logger;

/**
 * 配置错误类
 * @typedef {Error} ConfigurationError
 */
const { ConfigurationError } = require('../utils/errors');

/**
 * JWT 密钥最小长度
 * @type {number}
 */
const MIN_JWT_SECRET_LENGTH = 32;

/**
 * 弱 JWT 密钥集合
 * @type {Set<string>}
 */
const WEAK_JWT_SECRETS = new Set([
    'changeme',
    'change_me',
    'change-me',
    'default',
    'password',
    '123456',
    'jwt_secret',
    'photonix'
]);

/**
 * JWT 密钥占位字符串集合
 * @type {Set<string>}
 */
const JWT_PLACEHOLDERS = new Set([
    'change_me_to_a_secure_32_plus_char_string',
    'replace_me_with_secure_value',
    'set_me'
]);

/**
 * 管理员密钥最小长度
 * @type {number}
 */
const MIN_ADMIN_SECRET_LENGTH = 6;

/**
 * 弱管理员密钥集合
 * @type {Set<string>}
 */
const WEAK_ADMIN_SECRETS = new Set([
    'admin',
    'administrator',
    'changeme',
    'password',
    '123456'
]);

/**
 * 规范化密钥字符串，去除空白
 * @param {string} value
 * @returns {string}
 */
function normalizeSecret(value) {
    return (value || '').trim();
}

/**
 * 判断 JWT 密钥是否为已知弱口令/占位符
 * @param {string} jwtSecret
 * @returns {boolean}
 */
function isWeak(jwtSecret) {
    const normalized = jwtSecret.toLowerCase();
    return WEAK_JWT_SECRETS.has(normalized) || JWT_PLACEHOLDERS.has(normalized);
}

/**
 * 判断管理员密钥是否为已知弱口令
 * @param {string} secret
 * @returns {boolean}
 */
function isWeakAdmin(secret) {
    const normalized = secret.toLowerCase();
    return WEAK_ADMIN_SECRETS.has(normalized);
}

/**
 * 收集关键配置问题及警告
 * @param {object} [settings={}] 配置设置
 * @returns {{issues: string[], warnings: string[]}}
 */
function collectCriticalConfigIssues(settings = {}) {
    const issues = [];
    const warnings = [];

    const jwtSecret = normalizeSecret(process.env.JWT_SECRET);
    const adminSecret = normalizeSecret(process.env.ADMIN_SECRET);

    const passwordEnabled = String(settings.PASSWORD_ENABLED || 'false') === 'true';
    const passwordHash = normalizeSecret(settings.PASSWORD_HASH);

    // 密码登录启用场景下的校验
    if (passwordEnabled) {
        if (!jwtSecret) {
            issues.push('密码登录已启用，但未配置 JWT_SECRET 环境变量。');
        } else {
            if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
                issues.push(`密码登录已启用，但 JWT_SECRET 长度不足 ${MIN_JWT_SECRET_LENGTH} 字符。`);
            }
            if (isWeak(jwtSecret)) {
                issues.push('密码登录已启用，但 JWT_SECRET 使用了默认或弱口令。');
            }
        }

        if (!passwordHash) {
            warnings.push('密码登录已启用，但未检测到有效的 PASSWORD_HASH，用户可能无法登录。');
        }
    } else {
        // 未启用密码时的提示
        if (!jwtSecret) {
            warnings.push('未配置 JWT_SECRET，当前无需密码保护。如计划启用密码登录，请准备 32+ 字符强随机密钥。');
        } else {
            if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
                warnings.push(`JWT_SECRET 长度不足 ${MIN_JWT_SECRET_LENGTH} 字符，建议更换为更强的密钥。`);
            }
            if (isWeak(jwtSecret)) {
                warnings.push('检测到弱 JWT_SECRET，建议更换为强随机值。');
            }
        }
    }

    // 管理员密钥检测
    if (!adminSecret) {
        warnings.push('ADMIN_SECRET 未配置，安全敏感操作（如重置设置）将被拒绝。');
    } else {
        if (adminSecret.length < MIN_ADMIN_SECRET_LENGTH) {
            warnings.push(`ADMIN_SECRET 长度不足 ${MIN_ADMIN_SECRET_LENGTH} 字符，建议更换为更强的密钥。`);
        }
        if (isWeakAdmin(adminSecret)) {
            warnings.push('ADMIN_SECRET 使用了常见弱口令，请尽快更换。');
        }
    }

    return { issues, warnings };
}

/**
 * 对关键配置项进行校验，并抛出异常阻止启动（如有严重问题）
 * @throws {ConfigurationError} 配置错误异常
 * @returns {Promise<{issues: string[], warnings: string[]}>}
 */
async function validateCriticalConfig() {
    let settings = {};
    try {
        // 获取所有设置（优先拿最新的敏感项）
        const { getAllSettings } = require('../services/settings.service');
        settings = await getAllSettings({ preferFreshSensitive: true });
    } catch (error) {
        logger.warn(`${LOG_PREFIXES.CONFIG_VALIDATION} 获取设置时出错，使用默认配置继续校验。`, error && error.message ? { error: error.message } : undefined);
    }

    // 收集配置问题及警告
    const { issues, warnings } = collectCriticalConfigIssues(settings);

    // 输出所有警告
    warnings.forEach((msg) => {
        logger.warn(`${LOG_PREFIXES.CONFIG_VALIDATION} ${msg}`);
    });

    // 若存在阻断性问题，输出错误并抛出异常
    if (issues.length > 0) {
        issues.forEach((msg) => {
            logger.error(`${LOG_PREFIXES.CONFIG_VALIDATION} ${msg}`);
        });
        const error = new ConfigurationError('关键配置缺失或不安全', { issues });
        error.code = 'CONFIG_VALIDATION_FAILED';
        throw error;
    }

    logger.info(`${LOG_PREFIXES.CONFIG_VALIDATION} 关键配置校验完成。`);
    return { issues, warnings };
}

module.exports = {
    validateCriticalConfig,
    collectCriticalConfigIssues
};
