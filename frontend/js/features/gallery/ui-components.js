/**
 * @file ui-components.js
 * @description 通用UI组件库，抽取重复的渲染逻辑，提供状态卡片、进度条、按钮等常用UI生成与操作方法。
 */

import { setSafeInnerHTML, SecurityLevel } from '../../shared/security.js';
import { safeSetInnerHTML, safeGetElementById, safeSetStyle, safeClassList } from '../../shared/dom-utils.js';
import { UI_COMPONENTS } from '../../core/constants.js';

/**
 * 生成加载状态的HTML片段
 * @param {string} loadingId 加载元素ID
 * @returns {string} 加载状态HTML字符串
 */
export function generateLoadingHTML(loadingId) {
    return `
        <div class="${UI_COMPONENTS.STATUS_CARD.classes.loading}" id="${loadingId}">
            <div class="${UI_COMPONENTS.STATUS_CARD.classes.spinner}"></div>
        </div>
    `;
}

/**
 * 生成进度条HTML片段
 * @param {string} progressId 进度条ID
 * @param {number} percent 进度百分比
 * @returns {string} 进度条HTML字符串
 */
export function generateProgressBarHTML(progressId, percent) {
    return `
        <div class="${UI_COMPONENTS.STATUS_CARD.classes.progress}">
            <div class="${UI_COMPONENTS.STATUS_CARD.classes.progressBar}" id="${progressId}" style="width: ${percent}%;"></div>
        </div>
    `;
}

/**
 * 生成状态卡片头部HTML片段
 * @param {string} title 标题文本
 * @param {string} badgeId 徽章ID
 * @param {number} percent 进度百分比
 * @param {string} statusClass 状态样式类
 * @param {string} [statusIndicator] 状态指示器（可选）
 * @returns {string} 头部HTML字符串
 */
export function generateCardHeaderHTML(title, badgeId, percent, statusClass, statusIndicator = '') {
    return `
        <div class="${UI_COMPONENTS.STATUS_CARD.classes.header}">
            <h3 class="${UI_COMPONENTS.STATUS_CARD.classes.title}">${title}${statusIndicator}</h3>
            <span class="${UI_COMPONENTS.STATUS_CARD.classes.badge} ${statusClass}" id="${badgeId}">${percent}%</span>
        </div>
    `;
}

/**
 * 生成详情项HTML片段
 * @param {string} label 标签文本
 * @param {string} value 值文本
 * @param {string} [valueId] 值元素ID（可选）
 * @param {string} [valueClass] 值样式类（可选）
 * @returns {string} 详情项HTML字符串
 */
export function generateDetailItemHTML(label, value, valueId = '', valueClass = '') {
    const idAttr = valueId ? ` id="${valueId}"` : '';
    const classAttr = valueClass ? ` ${valueClass}` : '';

    return `
        <div class="${UI_COMPONENTS.STATUS_CARD.classes.detailItem}">
            <span class="${UI_COMPONENTS.STATUS_CARD.classes.detailLabel}">${label}</span>
            <span class="${UI_COMPONENTS.STATUS_CARD.classes.detailValue}${classAttr}"${idAttr}>${value}</span>
        </div>
    `;
}

/**
 * 生成时间戳HTML片段
 * @param {string} timestampId 时间戳元素ID
 * @param {string} label 时间戳标签
 * @param {Date|string} timestamp 时间戳
 * @returns {string} 时间戳HTML字符串
 */
export function generateTimestampHTML(timestampId, label, timestamp) {
    const formattedTime = timestamp ? new Date(timestamp).toLocaleString() : '从未';
    return `<span class="${UI_COMPONENTS.STATUS_CARD.classes.timestamp}" id="${timestampId}">${label}: ${formattedTime}</span>`;
}

/**
 * 生成操作按钮HTML片段
 * @param {Array} actions 操作按钮配置数组
 * @returns {string} 操作按钮HTML字符串
 */
export function generateActionsHTML(actions) {
    const buttonsHTML = actions.map(action => `
        <button class="${action.class || 'sync-btn'}" data-action="${action.action}" data-type="${action.type}">
            ${action.icon ? action.icon : ''}
            <span>${action.label}</span>
        </button>
    `).join('');

    return `<div class="${UI_COMPONENTS.STATUS_CARD.classes.actions}">${buttonsHTML}</div>`;
}

/**
 * 生成完整的状态卡片HTML
 * @param {Object} config 卡片配置对象
 * @param {string} config.loadingId 加载元素ID
 * @param {string} config.title 标题
 * @param {string} config.badgeId 徽章ID
 * @param {number} config.percent 进度百分比
 * @param {string} config.statusClass 状态样式类
 * @param {string} [config.statusIndicator] 状态指示器（可选）
 * @param {string} config.progressId 进度条ID
 * @param {string} config.detailsHTML 详情内容HTML
 * @param {string} config.timestampId 时间戳元素ID
 * @param {string} config.timestampLabel 时间戳标签
 * @param {Date|string} config.timestamp 时间戳
 * @param {Array} config.actions 操作按钮配置数组
 * @returns {string} 完整卡片HTML字符串
 */
export function generateStatusCardHTML(config) {
    const {
        loadingId,
        title,
        badgeId,
        percent,
        statusClass,
        statusIndicator = '',
        progressId,
        detailsHTML,
        timestampId,
        timestampLabel,
        timestamp,
        actions
    } = config;

    return `
        <div class="${UI_COMPONENTS.STATUS_CARD.classes.card}">
            ${generateLoadingHTML(loadingId)}
            ${generateCardHeaderHTML(title, badgeId, percent, statusClass, statusIndicator)}
            ${generateProgressBarHTML(progressId, percent)}
            <div class="${UI_COMPONENTS.STATUS_CARD.classes.details}">
                ${detailsHTML}
            </div>
            <div class="${UI_COMPONENTS.STATUS_CARD.classes.footer}">
                ${generateTimestampHTML(timestampId, timestampLabel, timestamp)}
                ${generateActionsHTML(actions)}
            </div>
        </div>
    `;
}

/**
 * 渲染通用状态卡片
 * @param {string} containerId 容器元素ID
 * @param {Object} data 渲染数据对象
 * @param {Function} detailsGenerator 详情内容生成函数，参数为data
 * @returns {void}
 */
export function renderStatusCard(containerId, data, detailsGenerator) {
    const container = safeGetElementById(containerId);
    if (!container) return;

    const detailsHTML = detailsGenerator(data);
    const html = generateStatusCardHTML({
        ...data,
        detailsHTML
    });

    safeSetInnerHTML(container, html);
}

/**
 * 显示或隐藏加载状态
 * @param {string} containerId 容器ID
 * @param {boolean} show 是否显示加载状态
 * @returns {void}
 */
export function toggleLoadingState(containerId, show) {
    const loadingElement = safeGetElementById(containerId);
    if (loadingElement) {
        safeSetStyle(loadingElement, 'display', show ? 'block' : 'none');
    }
}

/**
 * 更新进度条宽度
 * @param {string} progressBarId 进度条ID
 * @param {number} percent 进度百分比
 * @returns {void}
 */
export function updateProgressBar(progressBarId, percent) {
    const progressBar = safeGetElementById(progressBarId);
    if (progressBar) {
        safeSetStyle(progressBar, 'width', `${percent}%`);
    }
}

/**
 * 更新状态徽章内容与样式
 * @param {string} badgeId 徽章ID
 * @param {number} percent 百分比
 * @param {string} statusClass 状态样式类
 * @returns {void}
 */
export function updateStatusBadge(badgeId, percent, statusClass) {
    const badge = safeGetElementById(badgeId);
    if (badge) {
        badge.textContent = `${percent}%`;
        badge.className = `status-badge-new ${statusClass}`;
    }
}

/**
 * 创建安全的DOM元素
 * @param {string} tag 标签名
 * @param {Object} [options={}] 选项对象
 * @param {Array<string>} [options.classes] 类名数组
 * @param {Object} [options.attributes] 属性对象
 * @param {string} [options.textContent] 文本内容
 * @param {Array<HTMLElement|string>} [options.children] 子元素或文本数组
 * @returns {HTMLElement} 创建的元素
 */
export function createSafeElement(tag, options = {}) {
    const element = document.createElement(tag);

    if (options.classes) {
        if (options.classes && options.classes.length) {
            options.classes.forEach(cls => safeClassList(element, 'add', cls));
        }
    }

    if (options.attributes) {
        Object.entries(options.attributes).forEach(([key, value]) => {
            element.setAttribute(key, value);
        });
    }

    if (options.textContent) {
        element.textContent = options.textContent;
    }

    if (options.children) {
        options.children.forEach(child => {
            if (typeof child === 'string') {
                element.appendChild(document.createTextNode(child));
            } else {
                element.appendChild(child);
            }
        });
    }

    return element;
}

/**
 * 批量更新DOM元素内容、样式和类名
 * @param {Array<Object>} updates 更新配置数组，每项包含id及要更新的属性
 * @returns {void}
 */
export function batchUpdateElements(updates) {
    updates.forEach(update => {
        const element = safeGetElementById(update.id);
        if (element) {
            if (update.textContent !== undefined) {
                element.textContent = update.textContent;
            }
            if (update.innerHTML !== undefined) {
                safeSetInnerHTML(element, update.innerHTML);
            }
            if (update.className !== undefined) {
                element.className = update.className;
            }
            if (update.style !== undefined) {
                Object.assign(element.style, update.style);
            }
        }
    });
}
