/**
 * @file router/search.js
 * @description 搜索路由处理
 */

import { state } from '../../core/state.js';
import { elements } from '../../shared/dom-elements.js';
import { safeSetInnerHTML } from '../../shared/dom-utils.js';
import { setManagedTimeout } from '../../core/timer-manager.js';
import { AbortBus } from '../../core/abort-bus.js';
import { routerLogger } from '../../core/logger.js';
import { fetchSearchResults } from '../api.js';
import {
    renderSearchGrid,
    applyLayoutMode,
    renderLayoutToggleOnly,
    ensureLayoutToggleVisible,
    adjustScrollOptimization,
    removeSortControls
} from '../../features/gallery/ui.js';
import { scheduleThumbnailPreheat } from '../../features/gallery/preheat.js';
import {
    showNetworkError,
    showEmptySearchResults,
    showIndexBuildingError
} from '../../features/gallery/loading-states.js';
import { applyAlbumTombstones, generateBreadcrumbHTML } from './utils.js';
import { prepareForNewContent, finalizeNewContent } from './scroll.js';

/**
 * 搜索路由处理业务入口。
 * @param {Object} navigation
 * @param {AbortSignal} pageSignal
 */
export async function handleSearchRoute(navigation, pageSignal) {
    const queryIndex = navigation.newDecodedPath.indexOf('?');
    const searchParams = queryIndex !== -1 ? navigation.newDecodedPath.substring(queryIndex) : '';
    const urlParams = new URLSearchParams(searchParams);
    const query = urlParams.get('q') || '';
    await executeSearch(query, pageSignal);
}

/**
 * 执行全局搜索并渲染结果。
 * @param {string} query - 搜索关键词
 * @param {AbortSignal} signal - 中止信号
 */
async function executeSearch(query, signal) {
    const prepareControl = await prepareForNewContent();
    state.currentPhotos = [];
    state.currentSearchQuery = query;
    state.currentSearchPage = 1;
    state.totalSearchPages = 1;
    state.isSearchLoading = true;

    removeSortControls();

    try {
        const data = await fetchSearchResults(query, state.currentSearchPage, signal);

        const searchPathKey = `search?q=${query}`;
        if (signal.aborted || AbortBus.get('page') !== signal) return;

        // 到达后取消骨架
        if (prepareControl && prepareControl.cancelSkeleton) {
            prepareControl.cancelSkeleton();
        }

        if (!data || !data.results) {
            routerLogger.error('搜索返回数据不完整', data);
            showNetworkError();
            return;
        }

        const { items: filteredResults, removed: removedAlbums } = applyAlbumTombstones(data.results || []);
        data.results = filteredResults;
        if (removedAlbums > 0 && typeof data.totalResults === 'number') {
            data.totalResults = Math.max(0, data.totalResults - removedAlbums);
        }

        state.currentBrowsePath = searchPathKey;

        safeSetInnerHTML(elements.breadcrumbNav, generateBreadcrumbHTML(data, query));

        if (data.results.length === 0) {
            state.totalSearchPages = 0;
            state.currentSearchPage = 1;
            // 隐藏加载器
            const loaderContainer = document.getElementById('infinite-scroll-loader-container');
            if (loaderContainer) loaderContainer?.classList.remove('visible');
            showEmptySearchResults(query);
            elements.contentGrid.style.minHeight = '';
            return;
        }

        // 直接渲染所有搜索结果（移除分批渲染逻辑）
        const { contentElements, newMediaUrls } = renderSearchGrid(data.results, 0);
        const minimalLoader = document.getElementById('minimal-loader');
        if (minimalLoader) {
            minimalLoader.replaceWith(...contentElements);
        } else {
            safeSetInnerHTML(elements.contentGrid, '');
            elements.contentGrid.append(...contentElements);
        }

        scheduleThumbnailPreheat({
            mode: 'media',
            container: elements.contentGrid,
            reason: 'search-preheat'
        });

        // 更新状态
        state.currentPhotos = newMediaUrls;
        state.totalSearchPages = data.totalPages;
        state.currentSearchPage++;

        if (AbortBus.get('page') !== signal) return;
        import('../../shared/dom-elements.js').then(({ reinitializeElements }) => {
            reinitializeElements();
            // 搜索页是图片列表，使用动画
            renderLayoutToggleOnly(true);
            removeSortControls();
        });

        applyLayoutMode();
        finalizeNewContent(searchPathKey);

        setManagedTimeout(() => {
            ensureLayoutToggleVisible();
            adjustScrollOptimization(searchPathKey);
        }, 50, 'search-layout-post-render');
    } catch (error) {
        if (error.name === 'AbortError') {
            return;
        }
        routerLogger.warn('搜索请求失败', { query, error: error.message });
        if (error.message && error.message.includes('搜索索引正在构建中')) {
            showIndexBuildingError();
        } else {
            showNetworkError();
        }
        return;
    } finally {
        state.isSearchLoading = false;
        if (!elements.contentGrid?.classList.contains('error-container')) {
            elements.contentGrid.style.minHeight = '';
        }
    }
}
