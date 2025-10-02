// frontend/js/ui-components.js
// 通用UI组件库 - 抽取重复的渲染逻辑

import { setSafeInnerHTML, SecurityLevel } from './security.js';
import { safeSetInnerHTML, safeGetElementById, safeSetStyle, safeClassList } from './dom-utils.js';
import { UI_COMPONENTS } from './constants.js';

// 使用统一的UI_COMPONENTS配置常量

/**
 * 生成加载状态HTML
 * @param {string} loadingId - 加载元素ID
 * @returns {string} 加载状态HTML
 */
export function generateLoadingHTML(loadingId) {
    return `
        <div class="${UI_COMPONENTS.STATUS_CARD.classes.loading}" id="${loadingId}">
            <div class="${UI_COMPONENTS.STATUS_CARD.classes.spinner}"></div>
        </div>
    `;
}

/**
 * 生成进度条HTML
 * @param {string} progressId - 进度条ID
 * @param {number} percent - 进度百分比
 * @returns {string} 进度条HTML
 */
export function generateProgressBarHTML(progressId, percent) {
    return `
        <div class="${UI_COMPONENTS.STATUS_CARD.classes.progress}">
            <div class="${UI_COMPONENTS.STATUS_CARD.classes.progressBar}" id="${progressId}" style="width: ${percent}%;"></div>
        </div>
    `;
}

/**
 * 生成状态卡片头部HTML
 * @param {string} title - 标题
 * @param {string} badgeId - 徽章ID
 * @param {number} percent - 进度百分比
 * @param {string} statusClass - 状态样式类
 * @param {string} [statusIndicator] - 状态指示器
 * @returns {string} 头部HTML
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
 * 生成详情项HTML
 * @param {string} label - 标签文本
 * @param {string} value - 值文本
 * @param {string} [valueId] - 值元素ID
 * @param {string} [valueClass] - 值样式类
 * @returns {string} 详情项HTML
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
 * 生成时间戳HTML
 * @param {string} timestampId - 时间戳元素ID
 * @param {string} label - 时间戳标签
 * @param {Date|string} timestamp - 时间戳
 * @returns {string} 时间戳HTML
 */
export function generateTimestampHTML(timestampId, label, timestamp) {
    const formattedTime = timestamp ? new Date(timestamp).toLocaleString() : '从未';
    return `<span class="${UI_COMPONENTS.STATUS_CARD.classes.timestamp}" id="${timestampId}">${label}: ${formattedTime}</span>`;
}

/**
 * 生成操作按钮HTML
 * @param {Array} actions - 操作按钮配置数组
 * @returns {string} 操作按钮HTML
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
 * @param {Object} config - 卡片配置
 * @returns {string} 完整卡片HTML
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
 * 通用状态卡片渲染器
 * @param {string} containerId - 容器元素ID
 * @param {Object} data - 渲染数据
 * @param {Function} detailsGenerator - 详情内容生成函数
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
 * 显示/隐藏加载状态
 * @param {string} containerId - 容器ID
 * @param {boolean} show - 是否显示加载状态
 */
export function toggleLoadingState(containerId, show) {
    const loadingElement = safeGetElementById(containerId);
    if (loadingElement) {
        safeSetStyle(loadingElement, 'display', show ? 'block' : 'none');
    }
}

/**
 * 更新进度条
 * @param {string} progressBarId - 进度条ID
 * @param {number} percent - 进度百分比
 */
export function updateProgressBar(progressBarId, percent) {
    const progressBar = safeGetElementById(progressBarId);
    if (progressBar) {
        safeSetStyle(progressBar, 'width', `${percent}%`);
    }
}

/**
 * 更新状态徽章
 * @param {string} badgeId - 徽章ID
 * @param {number} percent - 百分比
 * @param {string} statusClass - 状态样式类
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
 * @param {string} tag - 标签名
 * @param {Object} options - 选项
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
 * 批量更新DOM元素
 * @param {Array} updates - 更新配置数组
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
