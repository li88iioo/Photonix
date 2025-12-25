/**
 * @file search-history.js
 * @description 搜索历史管理模块，负责搜索历史的存储、获取、显示和管理。
 */

import { escapeHtml } from '../../shared/security.js';
import { createModuleLogger } from '../../core/logger.js';
import { SEARCH_HISTORY } from '../../core/constants.js';
import { safeSetInnerHTML} from '../../shared/dom-utils.js';

const searchLogger = createModuleLogger('SearchHistory');

/**
 * 获取本地存储中的搜索历史记录。
 * @returns {string[]} 搜索历史数组
 */
export function getSearchHistory() {
    try {
        const history = localStorage.getItem(SEARCH_HISTORY.KEY);
        return history ? JSON.parse(history) : [];
    } catch (error) {
        searchLogger.error('获取搜索历史失败', error);
        return [];
    }
}

/**
 * 保存新的搜索历史项到本地存储。
 * @param {string} query - 搜索关键词
 * @returns {void}
 */
export function saveSearchHistory(query) {
    if (!query || query.trim() === '') return;

    try {
        const history = getSearchHistory();
        const trimmedQuery = query.trim();

        // 移除重复项
        const filteredHistory = history.filter(item => item !== trimmedQuery);

        // 添加新项到开头
        filteredHistory.unshift(trimmedQuery);

        // 限制历史记录最大数量
        if (filteredHistory.length > SEARCH_HISTORY.MAX_ITEMS) {
            filteredHistory.splice(SEARCH_HISTORY.MAX_ITEMS);
        }

        localStorage.setItem(SEARCH_HISTORY.KEY, JSON.stringify(filteredHistory));
    } catch (error) {
        searchLogger.error('保存搜索历史失败', error);
    }
}

/**
 * 清空所有搜索历史记录。
 * @returns {void}
 */
export function clearSearchHistory() {
    try {
        localStorage.removeItem(SEARCH_HISTORY.KEY);
    } catch (error) {
        searchLogger.error('清除搜索历史失败', error);
    }
}

/**
 * 删除指定的搜索历史项。
 * @param {string} query - 要删除的搜索关键词
 * @returns {void}
 */
export function removeSearchHistoryItem(query) {
    try {
        const history = getSearchHistory();
        const filteredHistory = history.filter(item => item !== query);
        localStorage.setItem(SEARCH_HISTORY.KEY, JSON.stringify(filteredHistory));
    } catch (error) {
        searchLogger.error('删除搜索历史项失败', error);
    }
}

/**
 * 渲染搜索历史下拉列表。
 * @param {HTMLElement} searchInput - 搜索输入框元素
 * @param {HTMLElement} historyContainer - 历史记录容器元素
 * @returns {void}
 */
export function renderSearchHistory(searchInput, historyContainer) {
    const history = getSearchHistory();

    if (history.length === 0) {
        safeSetInnerHTML(historyContainer, '');
        historyContainer?.classList.add('hidden');
        historyContainer?.classList.remove('search-panel-active');
        return;
    }

    const historyHtml = history.map(query => `
        <li class="search-history-item" data-query="${escapeHtml(query)}">
            <span class="search-history-text">
                <svg class="search-history-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                ${escapeHtml(query)}
            </span>
            <button class="search-history-remove remove-history-btn" data-query="${escapeHtml(query)}" title="删除" aria-label="删除历史项">×</button>
        </li>
    `).join('');

    safeSetInnerHTML(historyContainer, `
        <div class="search-history-header">
            <span class="search-history-title">搜索历史</span>
            <button class="search-history-clear clear-history-btn" title="清空所有历史">清空</button>
        </div>
        <ul id="history-list" class="search-history-list">
            ${historyHtml}
        </ul>
    `);

    historyContainer?.classList.remove('hidden');

    // 绑定事件
    bindSearchHistoryEvents(searchInput, historyContainer);
}

/**
 * 绑定搜索历史相关的事件（点击、删除、清空）。
 * @param {HTMLElement} searchInput - 搜索输入框元素
 * @param {HTMLElement} historyContainer - 历史记录容器元素
 * @returns {void}
 */
function bindSearchHistoryEvents(searchInput, historyContainer) {
    // 选择历史项进行搜索
    historyContainer.addEventListener('click', (e) => {
        const historyItem = e.target.closest('li[data-query]');
        if (historyItem && !e.target.closest('.remove-history-btn')) {
            const query = historyItem.dataset.query;
            searchInput.value = query;
            searchInput.focus();
            historyContainer?.classList.add('hidden');

            // 触发 input 事件以执行搜索
            const inputEvent = new Event('input', { bubbles: true });
            searchInput.dispatchEvent(inputEvent);
        }
    });

    // 删除单个历史项
    historyContainer.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.remove-history-btn');
        if (removeBtn) {
            e.stopPropagation();
            const query = removeBtn.dataset.query;
            removeSearchHistoryItem(query);
            renderSearchHistory(searchInput, historyContainer);
        }
    });

    // 清空所有历史
    historyContainer.addEventListener('click', (e) => {
        const clearBtn = e.target.closest('.clear-history-btn');
        if (clearBtn) {
            e.stopPropagation();
            clearSearchHistory();
            historyContainer?.classList.add('hidden');
        }
    });
}

/**
 * 显示搜索历史下拉列表。
 * @param {HTMLElement} searchInput - 搜索输入框元素
 * @param {HTMLElement} historyContainer - 历史记录容器元素
 * @returns {void}
 */
export function showSearchHistory(searchInput, historyContainer) {
    // 先渲染,renderSearchHistory会检查是否有历史记录
    renderSearchHistory(searchInput, historyContainer);

    // 只有在容器不是hidden状态时才添加动画类
    // (renderSearchHistory在没有历史记录时会添加hidden类)
    if (!historyContainer?.classList.contains('hidden')) {
        // 移除hidden类并添加动画类
        historyContainer?.classList.remove('hidden');
        // 触发重排以确保动画生效
        requestAnimationFrame(() => {
            historyContainer?.classList.add('search-panel-active');
        });
    }
}

/**
 * 隐藏搜索历史下拉列表。
 * @param {HTMLElement} historyContainer - 历史记录容器元素
 * @returns {void}
 */
export function hideSearchHistory(historyContainer) {
    historyContainer?.classList.remove('search-panel-active');
    // 等待动画完成后再隐藏
    setTimeout(() => {
        historyContainer?.classList.add('hidden');
    }, 200);
}
