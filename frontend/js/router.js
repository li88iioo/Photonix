// frontend/js/router.js

import { state } from './state.js';
import { elements } from './dom-elements.js';
import { applyMasonryLayout, getMasonryColumns } from './masonry.js';
import { setupLazyLoading } from './lazyload.js';
import { fetchSearchResults, fetchBrowseResults, postViewed } from './api.js';
import { renderBreadcrumb, renderBrowseGrid, renderSearchGrid, sortAlbumsByViewed, renderSortDropdown, applyLayoutMode, renderLayoutToggleOnly, ensureLayoutToggleVisible, adjustScrollOptimization } from './ui.js';
import { saveViewed, getUnsyncedViewed, markAsSynced } from './indexeddb-helper.js';
import { AbortBus } from './abort-bus.js';
import { refreshPageEventListeners } from './listeners.js';
import { showNetworkError, showEmptySearchResults, showEmptyAlbum, showIndexBuildingError, showSkeletonGrid } from './loading-states.js';
import { routerLogger } from './logger.js';
import { safeSetInnerHTML, safeGetElementById, safeClassList, safeSetStyle } from './dom-utils.js';
import { executeAsync, ErrorTypes, ErrorSeverity } from './error-handler.js';
import { setManagedTimeout } from './timer-manager.js';
import { CACHE, ROUTER } from './constants.js';
import { escapeHtml } from './security.js';


let currentRequestController = null;

/**
 * 生成安全的面包屑导航HTML
 * @param {Object} data - 搜索结果数据
 * @param {string} query - 搜索查询
 * @returns {string} 安全的HTML字符串
 */
function generateBreadcrumbHTML(data, query) {
    const preSearchHash = state.preSearchHash;
    const hasResults = data.results && data.results.length > 0;
    const searchQuery = escapeHtml(data.query || query || '');
    const totalResults = data.totalResults || 0;

    return `
       <div class="flex items-center justify-between w-full">
           <div class="flex items-center">
               <a href="${preSearchHash}" class="flex items-center text-purple-400 hover:text-purple-300 transition-colors duration-200 group">
                   <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mr-1 group-hover:-translate-x-1 transition-transform"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                   返回
               </a>
               ${hasResults ? `<span class="mx-3 text-gray-600">/</span><span class="text-white">搜索结果: "${searchQuery}" (${totalResults}项)</span>` : ''}
           </div>
           <div id="sort-container" class="flex-shrink-0 ml-4"></div>
       </div>`;
}

function getPathOnlyFromHash() {
    const cleanHashString = window.location.hash.replace(/#modal$/, '');
    const newDecodedPath = decodeURIComponent(cleanHashString.substring(1).replace(/^\//, ''));
    const questionMarkIndex = newDecodedPath.indexOf('?');
    return questionMarkIndex !== -1 ? newDecodedPath.substring(0, questionMarkIndex) : newDecodedPath;
}

export function initializeRouter() {
    try {
        const raw = sessionStorage.getItem('sg_scroll_positions');
        if (raw) {
            const obj = JSON.parse(raw);
            const entries = Object.entries(obj).slice(-CACHE.SCROLL_POSITION_STORAGE_LIMIT);
            const map = new Map(entries);
            state.update('scrollPositions', map);
        }
        const pre = sessionStorage.getItem('sg_pre_search_hash');
        if (pre) state.update('preSearchHash', pre);
    } catch {}

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
}

export async function handleHashChange() {
    // 保存当前页面的懒加载状态
    if (typeof state.currentBrowsePath === 'string' && window.savePageLazyState) {
        window.savePageLazyState(state.currentBrowsePath);
    }

    // 清理恢复防护，为新页面恢复做准备
    if (window.clearRestoreProtection) {
        window.clearRestoreProtection();
    }

    if (typeof state.currentBrowsePath === 'string') {
        const key = state.currentBrowsePath;
        const newScrollPositions = new Map(state.scrollPositions);
        newScrollPositions.set(key, window.scrollY);
        state.scrollPositions = newScrollPositions;
    }

    AbortBus.abortMany(['page','scroll']);
    const pageSignal = AbortBus.next('page');

    const cleanHashString = window.location.hash.replace(/#modal$/, '');
    const newDecodedPath = decodeURIComponent(cleanHashString.substring(1).replace(/^\//, ''));

    try {
        refreshPageEventListeners();
    } catch (error) {
        routerLogger.warn('刷新页面事件监听失败', error);
    }
    
    const questionMarkIndex = newDecodedPath.indexOf('?');
    const pathOnly = questionMarkIndex !== -1 ? newDecodedPath.substring(0, questionMarkIndex) : newDecodedPath;
    let newSortParam = questionMarkIndex !== -1 ? newDecodedPath.substring(questionMarkIndex) : '';
    
    if (newSortParam.startsWith('?sort=')) {
        newSortParam = newSortParam.substring(6);
    }

    const pathChanged = pathOnly !== state.currentBrowsePath;
    const currentSortValue = newSortParam || (pathChanged ? (state.currentSort || 'smart') : 'smart');
    const previousSort = state.currentSort || 'smart';
    const sortChanged = currentSortValue !== previousSort;
    
    if (!pathChanged && !sortChanged && !state.isInitialLoad) {
        const hasRealContent = !!(elements.contentGrid && elements.contentGrid.querySelector('.grid-item'));
        if (hasRealContent) {
            return;
        }
    }

    if (cleanHashString.startsWith('#/search?q=')) {
        if (!state.currentBrowsePath || !state.currentBrowsePath.startsWith('search?q=')) {
            state.preSearchHash = state.currentBrowsePath ? `#/${encodeURIComponent(state.currentBrowsePath)}` : '#/';
        }
    }

    if (newDecodedPath.startsWith('search?q=')) {
        const urlParams = new URLSearchParams(newDecodedPath.substring(newDecodedPath.indexOf('?')));
        const query = urlParams.get('q');
        await executeSearch(query || '', pageSignal);
    } else {
        state.currentSort = currentSortValue;
        state.currentBrowsePath = pathOnly;
        renderBreadcrumb(pathOnly);
        
        if (pathChanged) {
            state.entrySort = currentSortValue;
        } else if (sortChanged) {
            state.entrySort = currentSortValue;
        }
        
        await streamPath(pathOnly, pageSignal);

        try {
            setManagedTimeout(async () => {
                const stillSameRoute = getPathOnlyFromHash() === pathOnly && AbortBus.get('page') === pageSignal;
                const noRealContent = !(elements.contentGrid && elements.contentGrid.querySelector('.grid-item'));
                const notError = !(elements.contentGrid && safeClassList(elements.contentGrid, 'contains', 'error-container'));
                if (stillSameRoute && noRealContent && notError) {
                    const retrySignal = AbortBus.next('page');
                    await streamPath(pathOnly, retrySignal);
                }
            }, ROUTER.ROUTE_RETRY_DELAY, 'route-retry-delay');
        } catch {}
    }
}

export async function streamPath(path, signal) {
    await prepareForNewContent();
    state.isBrowseLoading = true;
    state.currentBrowsePage = 1;
    state.totalBrowsePages = 1;
    
    renderBreadcrumb(path);
    
    if (path.startsWith('search?q=')) {
        routerLogger.error('搜索页面不应该调用 streamPath 函数');
        return;
    }
    
    try {
        const data = await executeAsync(
            async () => {
                const [browseData] = await Promise.all([
                    fetchBrowseResults(path, state.currentBrowsePage, signal),
                    onAlbumViewed(path)
                ]);
                return browseData;
            },
            {
                context: { path, operation: 'streamPath' },
                errorType: ErrorTypes.NETWORK,
                errorSeverity: ErrorSeverity.MEDIUM,
                onError: (error, ctx) => {
                    routerLogger.warn(`路径流式加载失败 (尝试 ${ctx.attempt})`, {
                        path,
                        error: error.message
                    });
                }
            }
        );

        if (!data || signal.aborted || AbortBus.get('page') !== signal || getPathOnlyFromHash() !== path) return;

        state.currentBrowsePath = path;
        state.totalBrowsePages = data.totalPages;

        if (!data.items || data.items.length === 0) {
            const sortContainer = safeGetElementById('sort-container');
            if (sortContainer) safeSetInnerHTML(sortContainer, '');
            state.totalBrowsePages = 0;
            state.currentBrowsePage = 1;
            // 【优化】隐藏无限滚动加载器 - 避免重排抖动
            if (elements.infiniteScrollLoader) safeClassList(elements.infiniteScrollLoader, 'remove', 'visible');
            showEmptyAlbum();
            return;
        }

        const hasMediaFiles = data.items.some(item => item.type === 'photo' || item.type === 'video');

        // 应用布局模式（网格或瀑布）
        safeClassList(elements.contentGrid, 'add', 'masonry-mode');
        const { contentElements, newMediaUrls } = renderBrowseGrid(data.items, 0);
        const skeleton = safeGetElementById('skeleton-grid');
        if (skeleton) {
            skeleton.replaceWith(...contentElements);
        } else {
            safeSetInnerHTML(elements.contentGrid, ''); // 清空旧内容
            elements.contentGrid.append(...contentElements);
        }

        state.currentPhotos = newMediaUrls;
        state.currentBrowsePage++;

        if (AbortBus.get('page') !== signal || getPathOnlyFromHash() !== path) return;

        // 重新初始化DOM元素，确保sortContainer可用，然后渲染UI元素
        import('./dom-elements.js').then(({ reinitializeElements }) => {
            reinitializeElements();
            const sortContainer = safeGetElementById('sort-container');
            if (sortContainer) {
                if (hasMediaFiles) {
                    // 对于有媒体文件的相册，显示布局切换按钮
                    renderLayoutToggleOnly();
                } else {
                    // 对于只有相册的页面，显示排序下拉框
                    renderSortDropdown();
                }
            }

            // 在UI元素渲染完成后执行后续操作
            applyLayoutMode();
            finalizeNewContent(path);
        });

        // 确保布局切换按钮正确显示
        setManagedTimeout(() => {
            ensureLayoutToggleVisible();
            // 根据内容长度动态调整优化策略
            adjustScrollOptimization(path);
        }, 50, 'layout-post-render');

    } catch (error) {
        if (error.name !== 'AbortError') {
            // 错误已经由executeAsync处理，这里只需要处理UI反馈
            showNetworkError();
            return;
        }
    } finally {
        state.isBrowseLoading = false;
        if (!safeClassList(elements.contentGrid, 'contains', 'error-container')) {
            safeSetStyle(elements.contentGrid, 'minHeight', '');
        }
    }
}

async function executeSearch(query, signal) {
    await prepareForNewContent();
    state.currentPhotos = [];
    state.currentSearchQuery = query;
    state.currentSearchPage = 1;
    state.totalSearchPages = 1;
    state.isSearchLoading = true;
    
    try {
        const data = await executeAsync(
            () => fetchSearchResults(query, state.currentSearchPage, signal),
            {
                context: { query, operation: 'executeSearch' },
                errorType: ErrorTypes.NETWORK,
                errorSeverity: ErrorSeverity.MEDIUM,
                onError: (error, ctx) => {
                    routerLogger.warn(`搜索请求失败 (尝试 ${ctx.attempt})`, {
                        query,
                        error: error.message
                    });
                }
            }
        );

        const searchPathKey = `search?q=${query}`;
        if (signal.aborted || AbortBus.get('page') !== signal) return;

        if (!data || !data.results) {
            routerLogger.error('搜索返回数据不完整', data);
            showNetworkError();
            return;
        }

        state.currentBrowsePath = searchPathKey;
        
        safeSetInnerHTML(elements.breadcrumbNav, generateBreadcrumbHTML(data, query));

       if (data.results.length === 0) {
          state.totalSearchPages = 0;
          state.currentSearchPage = 1;
          // 【优化】隐藏无限滚动加载器 - 避免重排抖动
          const loaderContainer = safeGetElementById('infinite-scroll-loader-container');
          if (loaderContainer) safeClassList(loaderContainer, 'remove', 'visible');
          showEmptySearchResults(query);
          safeSetStyle(elements.contentGrid, 'minHeight', '');
          return;
       }

        safeClassList(elements.contentGrid, 'add', 'masonry-mode');
        const { contentElements, newMediaUrls } = renderSearchGrid(data.results, 0);
        const skeleton = safeGetElementById('skeleton-grid');
        if (skeleton) {
            skeleton.replaceWith(...contentElements);
        } else {
            safeSetInnerHTML(elements.contentGrid, ''); // 清空旧内容
            elements.contentGrid.append(...contentElements);
        }
        
        state.totalSearchPages = data.totalPages;
        state.currentPhotos = newMediaUrls;
        state.currentSearchPage++;
        
        if (AbortBus.get('page') !== signal) return;

        // 重新初始化DOM元素，确保sortContainer可用
        import('./dom-elements.js').then(({ reinitializeElements }) => {
            reinitializeElements();
            // 搜索页只显示布局切换按钮
            renderLayoutToggleOnly();
        });

        applyLayoutMode();
        finalizeNewContent(searchPathKey);

        // 确保布局切换按钮正确显示
        setManagedTimeout(() => {
            ensureLayoutToggleVisible();
            // 根据内容长度动态调整优化策略
            adjustScrollOptimization(searchPathKey);
        }, 50, 'search-layout-post-render');

    } catch (error) {
        if (error.name !== 'AbortError') {
            routerLogger.error("执行搜索失败", error);
            if (error.message && error.message.includes('搜索索引正在构建中')) {
                showIndexBuildingError();
            } else {
                showNetworkError();
            }
            return;
        }
    } finally {
        state.isSearchLoading = false;
        if (!safeClassList(elements.contentGrid, 'contains', 'error-container')) {
            safeSetStyle(elements.contentGrid, 'minHeight', '');
        }
    }
}

function prepareForNewContent() {
    return new Promise(resolve => {
        const scroller = state.virtualScroller;
        if (scroller) {
            scroller.destroy();
            state.update('virtualScroller', null);
        }

        window.scrollTo({ top: 0, behavior: 'instant' });
        safeSetStyle(elements.contentGrid, 'minHeight', `${elements.contentGrid.offsetHeight}px`);

        // 添加淡出 class
        safeClassList(elements.contentGrid, 'add', 'grid-leaving');

        // 等待动画完成
        setManagedTimeout(() => {
            showSkeletonGrid();
            safeClassList(elements.contentGrid, 'remove', 'masonry-mode');
            safeClassList(elements.contentGrid, 'remove', 'grid-leaving');
            safeClassList(elements.contentGrid, 'add', 'grid-entering');
            safeSetStyle(elements.contentGrid, 'height', 'auto');
            // 【优化】隐藏无限滚动加载器 - 避免重排抖动
            if (elements.infiniteScrollLoader) safeClassList(elements.infiniteScrollLoader, 'remove', 'visible');

            // 【修复】只在真正需要时清空图片状态，保留缓存
            // 检查是否是同一个相册路径的重新加载
            const currentPath = state.currentBrowsePath;
            const isSamePathReload = currentPath && currentPath === getPathOnlyFromHash();

            if (!isSamePathReload) {
                // 只有在切换到不同相册时才清空图片状态
                state.update('currentPhotos', []);
            }
            // 如果是同一相册的重新加载，保持 currentPhotos 不变，让懒加载系统复用

            // 动画结束后移除 entering class
            elements.contentGrid.addEventListener('transitionend', () => {
                safeClassList(elements.contentGrid, 'remove', 'grid-entering');
            }, { once: true });

            resolve();
        }, 150, 'content-transition'); // 匹配 CSS 中的 transition duration
    });
}

function finalizeNewContent(pathKey) {
    if (!state.virtualScroller) {
        setupLazyLoading();

        // 尝试恢复页面的懒加载状态
        let stateRestored = false;
        if (window.restorePageLazyState) {
            stateRestored = window.restorePageLazyState(pathKey);
        }

        // 仅在没有恢复状态且瀑布流模式下执行瀑布流布局
        if (!stateRestored && safeClassList(elements.contentGrid, 'contains', 'masonry-mode')) {
            applyMasonryLayout();
        }
    }

    sortAlbumsByViewed();
    state.update('currentColumnCount', getMasonryColumns());

    const scrollPositions = state.scrollPositions;
    const scrollY = scrollPositions.get(pathKey);
    if (scrollY) {
        window.scrollTo({ top: scrollY, behavior: 'instant' });
        const newScrollPositions = new Map(scrollPositions);
        newScrollPositions.delete(pathKey);
        state.scrollPositions = newScrollPositions;
    } else if (state.isInitialLoad) {
        window.scrollTo({ top: 0, behavior: 'instant' });
    }

    safeSetStyle(elements.contentGrid, 'minHeight', '');
    state.update('isInitialLoad', false);
}

function saveCurrentScrollPosition() {
    const key = state.currentBrowsePath;
    if (typeof key === 'string' && key.length > 0) {
        const newScrollPositions = new Map(state.scrollPositions);
        newScrollPositions.set(key, window.scrollY);
        state.scrollPositions = newScrollPositions;
        try {
            const obj = Object.fromEntries(state.scrollPositions);
            const entries = Object.entries(obj);
            const limited = entries.slice(-200);
            sessionStorage.setItem('sg_scroll_positions', JSON.stringify(Object.fromEntries(limited)));
            sessionStorage.setItem('sg_pre_search_hash', state.preSearchHash || '#/');
        } catch {}
    }
}

window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        saveCurrentScrollPosition();
    }
});

window.addEventListener('beforeunload', () => {
    saveCurrentScrollPosition();
});

async function onAlbumViewed(path) {
    if (!path) return;
    await saveViewed(path, Date.now(), navigator.onLine);
    if (navigator.onLine) {
        try {
            await postViewed(path);
            await markAsSynced(path);
        } catch (e) {}
    }
}

window.addEventListener('online', async () => {
    const unsynced = await getUnsyncedViewed();
    for (const record of unsynced) {
        try {
            await postViewed(record.path);
            await markAsSynced(record.path);
        } catch (e) {}
    }
});
