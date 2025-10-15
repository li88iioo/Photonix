/**
 * @file frontend/js/shared/dom-utils.js
 * @description 封装常见 DOM 操作的安全接口，提升可维护性与可测试性
 */

import { domLogger } from '../core/logger.js';

/**
 * 安全获取 DOM 元素，避免 querySelector 抛出异常。
 * @param {string} selector - CSS选择器或ID
 * @param {Element} context - 查找上下文，默认为document
 * @returns {Element|null} 找到的元素或null
 */
export function safeQuerySelector(selector, context = document) {
    try {
        return context.querySelector(selector);
    } catch (error) {
        domLogger.warn('DOM查询失败', { selector, error: error.message });
        return null;
    }
}

/**
 * 安全地通过 ID 获取 DOM 元素。
 * @param {string} id - 元素ID
 * @returns {Element|null} 找到的元素或null
 */
export function safeGetElementById(id) {
    try {
        return document.getElementById(id);
    } catch (error) {
        domLogger.warn('DOM元素获取失败', { id, error: error.message });
        return null;
    }
}

/**
 * 批量获取 DOM 元素集合。
 * @param {string} selector - CSS选择器
 * @param {Element} context - 查找上下文，默认为document
 * @returns {NodeList} 元素集合
 */
export function safeQuerySelectorAll(selector, context = document) {
    try {
        return context.querySelectorAll(selector);
    } catch (error) {
        domLogger.warn('DOM批量查询失败', { selector, error: error.message });
        return [];
    }
}

/**
 * 安全地为元素设置 innerHTML，附带错误捕获。
 * @param {Element} element - 目标元素
 * @param {string} html - HTML内容
 * @returns {boolean} 是否成功
 */
export function safeSetInnerHTML(element, html) {
    if (!element) {
        domLogger.warn('设置innerHTML失败：元素不存在');
        return false;
    }

    try {
        element.innerHTML = html;
        return true;
    } catch (error) {
        domLogger.error('设置innerHTML失败', { error: error.message });
        return false;
    }
}

/**
 * 安全获取元素的 innerHTML。
 * @param {Element} element - 目标元素
 * @returns {string|null} HTML内容或null
 */
export function safeGetInnerHTML(element) {
    if (!element) {
        domLogger.warn('获取innerHTML失败：元素不存在');
        return null;
    }

    try {
        return element.innerHTML;
    } catch (error) {
        domLogger.error('获取innerHTML失败', { error: error.message });
        return null;
    }
}

/**
 * 安全设置元素的 textContent。
 * @param {Element} element - 目标元素
 * @param {string} text - 文本内容
 * @returns {boolean} 是否成功
 */
export function safeSetTextContent(element, text) {
    if (!element) {
        domLogger.warn('设置textContent失败：元素不存在');
        return false;
    }

    try {
        element.textContent = text;
        return true;
    } catch (error) {
        domLogger.error('设置textContent失败', { error: error.message });
        return false;
    }
}

/**
 * 安全设置元素样式，支持单个属性或批量对象。
 * @param {Element} element - 目标元素
 * @param {string|Object} property - CSS属性名或样式对象
 * @param {string} value - CSS属性值（当property为字符串时）
 * @returns {boolean} 是否成功
 */
export function safeSetStyle(element, property, value) {
    if (!element) {
        domLogger.warn('设置样式失败：元素不存在');
        return false;
    }

    try {
        if (typeof property === 'object') {
            // 批量设置样式
            Object.assign(element.style, property);
        } else {
            // 检查是否是CSS变量（以--开头）
            if (property.startsWith('--')) {
                element.style.setProperty(property, value);
            } else {
                // 单个样式设置
                element.style[property] = value;
            }
        }
        return true;
    } catch (error) {
        domLogger.error('设置样式失败', { property, value, error: error.message });
        return false;
    }
}

/**
 * 安全读取元素的样式值或 CSS 变量。
 * @param {Element} element - 目标元素
 * @param {string} property - CSS属性名
 * @returns {string|null} 属性值或null
 */
export function safeGetStyle(element, property) {
    if (!element) {
        domLogger.warn('获取样式失败：元素不存在');
        return null;
    }

    try {
        // 检查是否是CSS变量（以--开头）
        if (property.startsWith('--')) {
            return getComputedStyle(element).getPropertyValue(property) || null;
        } else {
            return element.style[property] || null;
        }
    } catch (error) {
        domLogger.error('获取样式失败', { property, error: error.message });
        return null;
    }
}

/**
 * 安全操作元素 classList，统一错误处理。
 * @param {Element} element - 目标元素
 * @param {string} operation - 操作类型：'add', 'remove', 'toggle', 'contains'
 * @param {string} className - 类名
 * @param {boolean} [force] - 对于toggle操作，强制添加(true)或移除(false)
 * @returns {boolean} 操作结果
 */
export function safeClassList(element, operation, className, force) {
    if (!element) {
        domLogger.warn('classList操作失败：元素不存在');
        return false;
    }

    try {
        switch (operation) {
            case 'add':
                element.classList.add(className);
                return true;
            case 'remove':
                element.classList.remove(className);
                return true;
            case 'toggle':
                return element.classList.toggle(className, force);
            case 'contains':
                return element.classList.contains(className);
            default:
                domLogger.warn('无效的classList操作', { operation });
                return false;
        }
    } catch (error) {
        domLogger.error('classList操作失败', { operation, className, error: error.message });
        return false;
    }
}

/**
 * 安全设置元素属性值。
 * @param {Element} element - 目标元素
 * @param {string} name - 属性名
 * @param {string} value - 属性值
 * @returns {boolean} 是否成功
 */
export function safeSetAttribute(element, name, value) {
    if (!element) {
        domLogger.warn('设置属性失败：元素不存在');
        return false;
    }

    try {
        element.setAttribute(name, value);
        return true;
    } catch (error) {
        domLogger.error('设置属性失败', { name, value, error: error.message });
        return false;
    }
}

/**
 * 安全获取元素属性值。
 * @param {Element} element - 目标元素
 * @param {string} name - 属性名
 * @returns {string|null} 属性值或null
 */
export function safeGetAttribute(element, name) {
    if (!element) {
        domLogger.warn('获取属性失败：元素不存在');
        return null;
    }

    try {
        return element.getAttribute(name);
    } catch (error) {
        domLogger.error('获取属性失败', { name, error: error.message });
        return null;
    }
}

/**
 * 安全创建 DOM 元素并支持常见配置。
 * @param {string} tagName - 标签名
 * @param {Object} options - 创建选项
 * @returns {Element|null} 创建的元素或null
 */
export function safeCreateElement(tagName, options = {}) {
    try {
        const element = document.createElement(tagName);

        if (options.classes && Array.isArray(options.classes)) {
            element.classList.add(...options.classes);
        }

        if (options.attributes) {
            Object.entries(options.attributes).forEach(([key, value]) => {
                element.setAttribute(key, value);
            });
        }

        if (options.textContent) {
            element.textContent = options.textContent;
        }

        if (options.children && Array.isArray(options.children)) {
            options.children.forEach(child => {
                if (child instanceof Element) {
                    element.appendChild(child);
                }
            });
        }

        return element;
    } catch (error) {
        domLogger.error('创建元素失败', { tagName, options, error: error.message });
        return null;
    }
}

/**
 * 安全删除指定元素。
 * @param {Element} element - 要删除的元素
 * @returns {boolean} 是否成功
 */
export function safeRemoveElement(element) {
    if (!element) {
        domLogger.warn('删除元素失败：元素不存在');
        return false;
    }

    try {
        element.remove();
        return true;
    } catch (error) {
        domLogger.error('删除元素失败', { error: error.message });
        return false;
    }
}

/**
 * 安全追加单个或多个子元素。
 * @param {Element} parent - 父元素
 * @param {Element|Element[]} children - 子元素或子元素数组
 * @returns {boolean} 是否成功
 */
export function safeAppendChild(parent, children) {
    if (!parent) {
        domLogger.warn('追加子元素失败：父元素不存在');
        return false;
    }

    try {
        if (Array.isArray(children)) {
            children.forEach(child => {
                if (child instanceof Element) {
                    parent.appendChild(child);
                }
            });
        } else if (children instanceof Element) {
            parent.appendChild(children);
        }
        return true;
    } catch (error) {
        domLogger.error('追加子元素失败', { error: error.message });
        return false;
    }
}

/**
 * 检查元素是否存在且已连接到 DOM。
 * @param {Element} element - 要检查的元素
 * @returns {boolean} 是否存在且已连接
 */
export function isElementConnected(element) {
    return element && element.isConnected;
}

/**
 * 安全获取元素的位置信息。
 * @param {Element} element - 目标元素
 * @returns {DOMRect|null} 位置信息或null
 */
export function safeGetBoundingClientRect(element) {
    if (!element) {
        domLogger.warn('获取位置信息失败：元素不存在');
        return null;
    }

    try {
        return element.getBoundingClientRect();
    } catch (error) {
        domLogger.error('获取位置信息失败', { error: error.message });
        return null;
    }
}

/**
 * 安全执行滚动操作，兼容 window 与元素。
 * @param {Element|Window} element - 要滚动的目标，默认为window
 * @param {Object} options - 滚动选项
 * @returns {boolean} 是否成功
 */
export function safeScrollTo(element = window, options = {}) {
    try {
        if (element === window) {
            window.scrollTo(options);
        } else if (element.scrollTo) {
            element.scrollTo(options);
        }
        return true;
    } catch (error) {
        domLogger.error('滚动操作失败', { options, error: error.message });
        return false;
    }
}

/**
 * 批量执行 DOM 操作以提升性能。
 * @param {Function[]} operations - 操作函数数组
 * @returns {boolean[]} 操作结果数组
 */
export function batchDomOperations(operations) {
    if (!Array.isArray(operations)) {
        domLogger.warn('batchDomOperations参数必须是数组');
        return [];
    }

    const results = [];
    for (const operation of operations) {
        if (typeof operation === 'function') {
            try {
                results.push(operation());
            } catch (error) {
                domLogger.error('批量DOM操作失败', { error: error.message });
                results.push(false);
            }
        } else {
            results.push(false);
        }
    }
    return results;
}
