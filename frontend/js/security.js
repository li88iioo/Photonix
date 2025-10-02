// frontend/js/security.js
// XSS防护统一策略和安全插值助手

import { isDevelopment, SECURITY } from './constants.js';
import { createModuleLogger } from './logger.js';
import { safeSetInnerHTML } from './dom-utils.js';

const securityLogger = createModuleLogger('Security');

/**
 * XSS防护级别枚举
 */
export const SecurityLevel = {
    STRICT: 'strict',     // 严格模式：只允许纯文本
    BASIC: 'basic',       // 基本模式：允许简单HTML标签
    RICH: 'rich',         // 丰富模式：允许复杂HTML
    CUSTOM: 'custom'      // 自定义模式：根据白名单
};

// 使用统一的SECURITY.HTML_WHITELIST配置

// 使用统一的SECURITY.ATTRIBUTE_WHITELIST和SECURITY.DANGEROUS_PATTERNS配置

/**
 * 检测字符串是否包含危险内容
 * @param {string} input - 输入字符串
 * @returns {boolean} 是否包含危险内容
 */
export function containsDangerousContent(input) {
    if (typeof input !== 'string') return false;

    return SECURITY.DANGEROUS_PATTERNS.some(pattern => pattern.test(input));
}

/**
 * HTML实体转义
 * @param {string} text - 需要转义的文本
 * @returns {string} 转义后的文本
 */
export function escapeHtml(text) {
    if (typeof text !== 'string') {
        return '';
    }

    const entityMap = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        '/': '&#x2F;',
        '`': '&#x60;',
        '=': '&#x3D;'
    };

    return text.replace(/[&<>"'`=/]/g, char => entityMap[char]);
}

/**
 * HTML实体反转义
 * @param {string} text - 需要反转义的文本
 * @returns {string} 反转义后的文本
 */
export function unescapeHtml(text) {
    if (typeof text !== 'string') {
        return '';
    }

    const entityMap = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#x27;': "'",
        '&#x2F;': '/',
        '&#x60;': '`',
        '&#x3D;': '='
    };

    return text.replace(/&(?:amp|lt|gt|quot|#x27|#x2F|#x60|#x3D);/g, entity => entityMap[entity]);
}

/**
 * 清理HTML标签，只保留白名单中的标签
 * @param {string} html - HTML字符串
 * @param {string} level - 安全级别
 * @returns {string} 清理后的HTML
 */
export function sanitizeHtml(html, level = SecurityLevel.BASIC) {
    if (typeof html !== 'string') return '';

    // 首先检测危险内容
    if (containsDangerousContent(html)) {
        securityLogger.warn('检测到危险HTML内容，已进行清理');
        // 对于危险内容，只返回转义后的文本
        return escapeHtml(html);
    }

    // 使用DOM解析器清理HTML
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // 递归清理节点
        const cleanNode = (node) => {
            // 文本节点直接返回
            if (node.nodeType === Node.TEXT_NODE) {
                return document.createTextNode(node.textContent);
            }

            // 注释节点跳过
            if (node.nodeType === Node.COMMENT_NODE) {
                return null;
            }

            // 元素节点
            if (node.nodeType === Node.ELEMENT_NODE) {
                const tagName = node.tagName.toLowerCase();

                // 检查标签是否在白名单中
                if (!SECURITY.HTML_WHITELIST[level].has(tagName)) {
                    // 如果标签不在白名单中，返回其文本内容
                    return document.createTextNode(node.textContent);
                }

                // 创建新元素
                const cleanElement = document.createElement(tagName);

                // 清理属性
                for (const attr of node.attributes) {
                    const attrName = attr.name.toLowerCase();
                    const attrValue = attr.value;

                    // 检查属性是否在白名单中
                    const isAllowedAttr = SECURITY.ATTRIBUTE_WHITELIST.has(attrName) ||
                                         attrName.startsWith('data-') ||
                                         attrName.startsWith('aria-');

                    if (isAllowedAttr) {
                        // 额外检查URL属性
                        if (['href', 'src'].includes(attrName)) {
                            if (containsDangerousContent(attrValue)) {
                                securityLogger.warn('移除危险属性', { attrName, attrValue });
                                continue;
                            }
                        }

                        cleanElement.setAttribute(attrName, attrValue);
                    }
                }

                // 递归清理子节点
                for (const child of node.childNodes) {
                    const cleanChild = cleanNode(child);
                    if (cleanChild) {
                        cleanElement.appendChild(cleanChild);
                    }
                }

                return cleanElement;
            }

            return null;
        };

        // 清理所有顶级节点
        const fragment = document.createDocumentFragment();
        for (const child of doc.body.childNodes) {
            const cleanChild = cleanNode(child);
            if (cleanChild) {
                fragment.appendChild(cleanChild);
            }
        }

        return fragment.innerHTML || '';

    } catch (error) {
        securityLogger.warn('HTML清理失败，回退到转义', error);
        return escapeHtml(html);
    }
}

/**
 * 安全的模板插值函数
 * @param {string} template - 模板字符串
 * @param {object} data - 插值数据
 * @param {string} securityLevel - 安全级别
 * @returns {string} 插值后的安全HTML
 */
export function safeInterpolate(template, data = {}, securityLevel = SecurityLevel.BASIC) {
    if (typeof template !== 'string') return '';

    let result = template;

    // 替换插值变量
    for (const [key, value] of Object.entries(data)) {
        const placeholder = new RegExp(`\\$\\{${key}\\}`, 'g');

        if (typeof value === 'string') {
            // 根据安全级别处理字符串值
            let safeValue;
            switch (securityLevel) {
                case SecurityLevel.STRICT:
                    safeValue = escapeHtml(value);
                    break;
                case SecurityLevel.BASIC:
                case SecurityLevel.RICH:
                    safeValue = sanitizeHtml(value, securityLevel);
                    break;
                default:
                    safeValue = escapeHtml(value);
            }

            result = result.replace(placeholder, safeValue);
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            // 数字和布尔值直接转换为字符串
            result = result.replace(placeholder, String(value));
        } else {
            // 其他类型的值转换为JSON字符串并转义
            result = result.replace(placeholder, escapeHtml(JSON.stringify(value)));
        }
    }

    return result;
}

/**
 * 创建安全的DOM元素
 * @param {string} tagName - 标签名
 * @param {object} properties - 属性对象
 * @param {string} content - 文本内容
 * @returns {HTMLElement} 安全的DOM元素
 */
export function createSafeElement(tagName, properties = {}, content = '') {
    const element = document.createElement(tagName);

    // 设置属性
    for (const [key, value] of Object.entries(properties)) {
        if (typeof value === 'string') {
            // 检查属性值是否安全
            if (containsDangerousContent(value)) {
                securityLogger.warn('跳过危险属性', { key, value });
                continue;
            }
        }

        try {
            element.setAttribute(key, value);
        } catch (error) {
            securityLogger.warn('设置属性失败', { key, error });
        }
    }

    // 设置文本内容
    if (content) {
        element.textContent = content;
    }

    return element;
}

/**
 * 安全的innerHTML设置函数
 * @param {Element} element - 目标元素
 * @param {string} html - HTML字符串
 * @param {string} securityLevel - 安全级别
 */
export function setSafeInnerHTML(element, html, securityLevel = SecurityLevel.BASIC) {
    if (!element || typeof html !== 'string') return;

    try {
        const sanitizedHtml = sanitizeHtml(html, securityLevel);
        safeSetInnerHTML(element, sanitizedHtml);
    } catch (error) {
        securityLogger.warn('设置innerHTML失败', error);
        // 回退到文本内容
        element.textContent = escapeHtml(html);
    }
}

/**
 * 验证URL是否安全
 * @param {string} url - URL字符串
 * @returns {boolean} 是否安全
 */
export function isSafeUrl(url) {
    if (typeof url !== 'string') return false;

    try {
        const parsedUrl = new URL(url, window.location.origin);

        // 只允许http和https协议
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return false;
        }

        // 检查是否包含危险字符
        return !containsDangerousContent(url);
    } catch {
        return false;
    }
}

/**
 * 安全的URL创建函数
 * @param {string} url - URL字符串
 * @param {string} baseUrl - 基础URL
 * @returns {URL|null} 安全的URL对象
 */
export function createSafeUrl(url, baseUrl = window.location.origin) {
    try {
        const safeUrl = new URL(url, baseUrl);

        if (!isSafeUrl(safeUrl.href)) {
            return null;
        }

        return safeUrl;
    } catch {
        return null;
    }
}

/**
 * 安全的内容类型检测
 * @param {string} content - 内容字符串
 * @returns {string} 内容类型 ('text', 'html', 'mixed')
 */
export function detectContentType(content) {
    if (typeof content !== 'string') return 'unknown';

    const hasHtml = /<[^>]*>/i.test(content);
    const hasEntities = /&[a-zA-Z0-9#]+;/g.test(content);

    if (hasHtml) {
        return hasEntities ? 'mixed' : 'html';
    } else if (hasEntities) {
        return 'encoded';
    } else {
        return 'text';
    }
}

/**
 * 扩展HTML白名单（仅用于自定义模式）
 * @param {string[]} tags - 要添加的标签
 */
export function extendHtmlWhitelist(tags) {
    if (Array.isArray(tags)) {
        tags.forEach(tag => {
            SECURITY.HTML_WHITELIST[SecurityLevel.CUSTOM].add(tag.toLowerCase());
        });
    }
}

/**
 * 获取安全统计信息（开发模式）
 * @returns {object} 安全统计
 */
export function getSecurityStats() {
    if (!isDevelopment()) {
        return null; // 生产环境不暴露统计信息
    }

    return {
        securityLevel: SecurityLevel,
        htmlWhitelist: {
            strict: SECURITY.HTML_WHITELIST[SecurityLevel.STRICT].size,
            basic: SECURITY.HTML_WHITELIST[SecurityLevel.BASIC].size,
            rich: SECURITY.HTML_WHITELIST[SecurityLevel.RICH].size,
            custom: SECURITY.HTML_WHITELIST[SecurityLevel.CUSTOM].size
        },
        dangerousPatterns: SECURITY.DANGEROUS_PATTERNS.length,
        timestamp: Date.now()
    };
}
