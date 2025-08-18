// frontend/js/search-history.js

/**
 * 搜索历史管理模块
 * 负责搜索历史的存储、获取、显示和管理
 */

const SEARCH_HISTORY_KEY = 'gallery_search_history';
const MAX_HISTORY_ITEMS = 10;

/**
 * 获取搜索历史
 * @returns {Array<string>} 搜索历史数组
 */
export function getSearchHistory() {
    try {
        const history = localStorage.getItem(SEARCH_HISTORY_KEY);
        return history ? JSON.parse(history) : [];
    } catch (error) {
        console.error('获取搜索历史失败:', error);
        return [];
    }
}

/**
 * 保存搜索历史
 * @param {string} query - 搜索查询
 */
export function saveSearchHistory(query) {
    if (!query || query.trim() === '') return;
    
    try {
        const history = getSearchHistory();
        const trimmedQuery = query.trim();
        
        // 移除重复项
        const filteredHistory = history.filter(item => item !== trimmedQuery);
        
        // 添加到开头
        filteredHistory.unshift(trimmedQuery);
        
        // 限制历史记录数量
        if (filteredHistory.length > MAX_HISTORY_ITEMS) {
            filteredHistory.splice(MAX_HISTORY_ITEMS);
        }
        
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(filteredHistory));
    } catch (error) {
        console.error('保存搜索历史失败:', error);
    }
}

/**
 * 清除搜索历史
 */
export function clearSearchHistory() {
    try {
        localStorage.removeItem(SEARCH_HISTORY_KEY);
    } catch (error) {
        console.error('清除搜索历史失败:', error);
    }
}

/**
 * 删除单个搜索历史项
 * @param {string} query - 要删除的搜索查询
 */
export function removeSearchHistoryItem(query) {
    try {
        const history = getSearchHistory();
        const filteredHistory = history.filter(item => item !== query);
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(filteredHistory));
    } catch (error) {
        console.error('删除搜索历史项失败:', error);
    }
}

/**
 * 渲染搜索历史下拉列表
 * @param {HTMLElement} searchInput - 搜索输入框元素
 * @param {HTMLElement} historyContainer - 历史记录容器
 */
export function renderSearchHistory(searchInput, historyContainer) {
    const history = getSearchHistory();
    
    if (history.length === 0) {
        historyContainer.innerHTML = '';
        historyContainer.classList.add('hidden');
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
    
    historyContainer.innerHTML = `
        <div class="search-history-header flex items-center justify-between px-3 py-2 border-b border-gray-600">
            <span class="text-gray-400 text-xs">搜索历史</span>
            <button class="clear-history-btn text-gray-400 hover:text-red-400 text-xs px-2 py-1 rounded hover:bg-gray-700 transition-colors" title="清空所有历史">
                清空
            </button>
        </div>
        ${historyHtml}
    `;
    
    historyContainer.classList.remove('hidden');
    
    // 绑定事件
    bindSearchHistoryEvents(searchInput, historyContainer);
}

/**
 * 绑定搜索历史事件
 * @param {HTMLElement} searchInput - 搜索输入框
 * @param {HTMLElement} historyContainer - 历史记录容器
 */
function bindSearchHistoryEvents(searchInput, historyContainer) {
    // 点击历史项
    historyContainer.addEventListener('click', (e) => {
        const historyItem = e.target.closest('.search-history-item');
        if (historyItem) {
            const query = historyItem.querySelector('span').textContent;
            searchInput.value = query;
            searchInput.focus();
            historyContainer.classList.add('hidden');
            
            // 触发搜索
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
            historyContainer.classList.add('hidden');
        }
    });
}

/**
 * HTML转义函数
 * @param {string} text - 要转义的文本
 * @returns {string} 转义后的文本
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 显示搜索历史
 * @param {HTMLElement} searchInput - 搜索输入框
 * @param {HTMLElement} historyContainer - 历史记录容器
 */
export function showSearchHistory(searchInput, historyContainer) {
    renderSearchHistory(searchInput, historyContainer);
}

/**
 * 隐藏搜索历史
 * @param {HTMLElement} historyContainer - 历史记录容器
 */
export function hideSearchHistory(historyContainer) {
    historyContainer.classList.add('hidden');
} 