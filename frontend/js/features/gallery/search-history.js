/**
 * @file search-history.js
 * @description 搜索历史管理模块，负责搜索历史的存储、获取、显示和管理。
 */

import { escapeHtml } from '../../shared/security.js';
import { createModuleLogger } from '../../core/logger.js';
import { SEARCH_HISTORY } from '../../core/constants.js';
import { safeSetInnerHTML, safeClassList } from '../../shared/dom-utils.js';

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
        safeClassList(historyContainer, 'add', 'hidden');
        return;
    }

    const historyHtml = history.map(query => `
        <div class="search-history-item flex items-center justify-between px-3 py-2 hover:bg-gray-700 cursor-pointer group">
            <div class="flex items-center flex-1">
                <svg class="w-4 h-4 text-gray-400 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
                </svg>
                <span class="text-white text-sm">${escapeHtml(query)}</span>
            </div>
            <button class="remove-history-btn opacity-30 hover:opacity-100 text-gray-400 hover:text-red-400 transition-all duration-200 p-1 rounded" data-query="${escapeHtml(query)}" title="删除">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        </div>
    `).join('');

    safeSetInnerHTML(historyContainer, `
        <div class="search-history-header flex items-center justify-between px-3 py-2 border-b border-gray-600">
            <span class="text-gray-400 text-xs">搜索历史</span>
            <button class="clear-history-btn text-gray-400 hover:text-red-400 text-xs px-2 py-1 rounded hover:bg-gray-700 transition-colors" title="清空所有历史">
                清空
            </button>
        </div>
        ${historyHtml}
    `);

    safeClassList(historyContainer, 'remove', 'hidden');

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
        const historyItem = e.target.closest('.search-history-item');
        if (historyItem) {
            const query = historyItem.querySelector('span').textContent;
            searchInput.value = query;
            searchInput.focus();
            safeClassList(historyContainer, 'add', 'hidden');

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
            safeClassList(historyContainer, 'add', 'hidden');
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
    renderSearchHistory(searchInput, historyContainer);
}

/**
 * 隐藏搜索历史下拉列表。
 * @param {HTMLElement} historyContainer - 历史记录容器元素
 * @returns {void}
 */
export function hideSearchHistory(historyContainer) {
    safeClassList(historyContainer, 'add', 'hidden');
}