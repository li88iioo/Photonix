/**
 * @file 路由管理模块
 * @description 负责处理前端路由、页面导航和内容渲染
 */

import { state, clearExpiredAlbumTombstones, getAlbumTombstonesMap } from '../core/state.js';
import { elements } from '../shared/dom-elements.js';
import { applyMasonryLayout, getMasonryColumns } from '../features/gallery/masonry.js';
import { setupLazyLoading } from '../features/gallery/lazyload.js';
import { fetchSearchResults, fetchBrowseResults, postViewed } from './api.js';
import { renderBreadcrumb, renderBrowseGrid, renderSearchGrid, sortAlbumsByViewed, renderSortDropdown, applyLayoutMode, renderLayoutToggleOnly, ensureLayoutToggleVisible, adjustScrollOptimization } from '../features/gallery/ui.js';
import { saveViewed, getUnsyncedViewed, markAsSynced } from '../shared/indexeddb-helper.js';
import { AbortBus } from '../core/abort-bus.js';
import { refreshPageEventListeners } from '../features/gallery/listeners.js';
import { showNetworkError, showEmptySearchResults, showEmptyAlbum, showIndexBuildingError, showSkeletonGrid } from '../features/gallery/loading-states.js';
import { routerLogger } from '../core/logger.js';
import { safeSetInnerHTML, safeGetElementById, safeClassList, safeSetStyle } from '../shared/dom-utils.js';
import { executeAsync, ErrorTypes, ErrorSeverity } from '../core/error-handler.js';
import { setManagedTimeout } from '../core/timer-manager.js';
import { CACHE, ROUTER } from '../core/constants.js';
import { escapeHtml } from '../shared/security.js';
import { isDownloadRoute, showDownloadPage, hideDownloadPage } from '../features/download/index.js';

let currentRequestController = null;

/**
 * 过滤掉已被标记为“墓碑”（已删除或隐藏）的相册项
 * @param {Array} collection 原始项目集合（可能包含相册和照片）
 * @returns {Object} 包含过滤后的项目数组和被移除的数量
 */
function applyAlbumTombstones(collection) {
    // 清理过期的墓碑记录，防止无效数据影响过滤
    clearExpiredAlbumTombstones();

    // 获取当前所有有效的墓碑（被标记为删除的相册路径）
    const tombstones = getAlbumTombstonesMap();

    // 如果没有墓碑，直接返回原集合
    if (!(tombstones instanceof Map) || tombstones.size === 0) {
        return { items: collection, removed: 0 };
    }

    const filtered = []; // 存放未被墓碑过滤的项目
    let removed = 0;     // 记录被移除的项目数量

    // 遍历集合，过滤掉被墓碑标记的相册
    for (const item of collection || []) {
        if (item?.type === 'album') {
            const albumPath = item?.data?.path;
            // 如果该相册路径存在于墓碑中，则跳过
            if (albumPath && tombstones.has(albumPath)) {
                removed += 1;
                continue;
            }
        }
        filtered.push(item); // 其余项目保留
    }
    // 返回过滤后的集合和移除数量
    return { items: filtered, removed };
}

/**
 * 生成安全的面包屑导航HTML
 * @param {Object} data 搜索结果数据
 * @param {string} query 搜索查询
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

/**
 * 从URL hash中提取路径部分
 * @returns {string} 解码后的路径
 */
function getPathOnlyFromHash() {
    const cleanHashString = window.location.hash.replace(/#modal$/, '');
    const newDecodedPath = decodeURIComponent(cleanHashString.substring(1).replace(/^\//, ''));
    const questionMarkIndex = newDecodedPath.indexOf('?');
    return questionMarkIndex !== -1 ? newDecodedPath.substring(0, questionMarkIndex) : newDecodedPath;
}

/**
 * 初始化路由器，设置初始状态并处理hash变化
 */
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

/**
 * 处理hash变化事件，根据URL变化加载相应内容
 */
export async function handleHashChange() {
    persistRouteState();

    AbortBus.abortMany(['page', 'scroll']);
    const pageSignal = AbortBus.next('page');

    const { cleanHashString, newDecodedPath } = sanitizeHash();
    refreshRouteEventListenersSafely();

    if (isDownloadRoute(cleanHashString)) {
        await showDownloadPage();
        return;
    }

    hideDownloadPage();

    const navigation = buildNavigationContext(cleanHashString, newDecodedPath);

    if (shouldReuseExistingContent(navigation)) {
        return;
    }

    updatePreSearchHash(cleanHashString);

    if (navigation.isSearchRoute) {
        await handleSearchRoute(navigation, pageSignal);
    } else {
        await handleBrowseRoute(navigation, pageSignal);
    }
}

/**
 * 持久化当前路由状态（如滚动位置等）
 */
function persistRouteState() {
    if (typeof state.currentBrowsePath === 'string' && window.savePageLazyState) {
        window.savePageLazyState(state.currentBrowsePath);
    }

    if (window.clearRestoreProtection) {
        window.clearRestoreProtection();
    }

    if (typeof state.currentBrowsePath === 'string') {
        const key = state.currentBrowsePath;
        const newScrollPositions = new Map(state.scrollPositions);
        newScrollPositions.set(key, window.scrollY);
        state.scrollPositions = newScrollPositions;
    }
}

/**
 * 清洗hash，去除modal等后缀并解码
 * @returns {Object} 包含cleanHashString和newDecodedPath
 */
function sanitizeHash() {
    const cleanHashString = window.location.hash.replace(/#modal$/, '');
    const newDecodedPath = decodeURIComponent(cleanHashString.substring(1).replace(/^\//, ''));
    return { cleanHashString, newDecodedPath };
}

/**
 * 安全刷新路由相关事件监听器
 */
function refreshRouteEventListenersSafely() {
    try {
        refreshPageEventListeners();
    } catch (error) {
        routerLogger.warn('刷新页面事件监听失败', error);
    }
}

/**
 * 构建路由导航上下文对象
 * @param {string} cleanHashString 清洗后的hash字符串
 * @param {string} newDecodedPath 解码后的路径
 * @returns {Object} 路由导航上下文
 */
function buildNavigationContext(cleanHashString, newDecodedPath) {
    const questionMarkIndex = newDecodedPath.indexOf('?');
    const pathOnly = questionMarkIndex !== -1 ? newDecodedPath.substring(0, questionMarkIndex) : newDecodedPath;
    let sortParam = questionMarkIndex !== -1 ? newDecodedPath.substring(questionMarkIndex) : '';

    if (sortParam.startsWith('?sort=')) {
        sortParam = sortParam.substring(6);
    }

    const pathChanged = pathOnly !== state.currentBrowsePath;
    const previousSort = state.currentSort || 'smart';
    const currentSortValue = sortParam || (pathChanged ? previousSort : 'smart');
    const sortChanged = currentSortValue !== previousSort;

    return {
        cleanHashString,
        newDecodedPath,
        pathOnly,
        sortParam,
        currentSortValue,
        previousSort,
        pathChanged,
        sortChanged,
        isSearchRoute: newDecodedPath.startsWith('search?q=')
    };
}

/**
 * 判断是否可以复用现有内容（避免重复渲染）
 * @param {Object} navigation 路由导航上下文
 * @returns {boolean} 是否复用
 */
function shouldReuseExistingContent(navigation) {
    if (navigation.pathChanged || navigation.sortChanged || state.isInitialLoad) {
        return false;
    }
    return !!(elements.contentGrid && elements.contentGrid.querySelector('.grid-item'));
}

/**
 * 更新preSearchHash（用于返回按钮）
 * @param {string} cleanHashString 清洗后的hash字符串
 */
function updatePreSearchHash(cleanHashString) {
    if (!cleanHashString.startsWith('#/search?q=')) {
        return;
    }

    if (!state.currentBrowsePath || !state.currentBrowsePath.startsWith('search?q=')) {
        state.preSearchHash = state.currentBrowsePath ? `#/${encodeURIComponent(state.currentBrowsePath)}` : '#/';
    }
}

/**
 * 处理搜索路由
 * @param {Object} navigation 路由导航上下文
 * @param {AbortSignal} pageSignal 中止信号
 */
async function handleSearchRoute(navigation, pageSignal) {
    const queryIndex = navigation.newDecodedPath.indexOf('?');
    const searchParams = queryIndex !== -1 ? navigation.newDecodedPath.substring(queryIndex) : '';
    const urlParams = new URLSearchParams(searchParams);
    const query = urlParams.get('q') || '';
    await executeSearch(query, pageSignal);
}

/**
 * 处理浏览路由
 * @param {Object} navigation 路由导航上下文
 * @param {AbortSignal} pageSignal 中止信号
 */
async function handleBrowseRoute(navigation, pageSignal) {
    state.currentSort = navigation.currentSortValue;
    state.currentBrowsePath = navigation.pathOnly;
    renderBreadcrumb(navigation.pathOnly);

    if (navigation.pathChanged || navigation.sortChanged) {
        state.entrySort = navigation.currentSortValue;
    }

    await streamPath(navigation.pathOnly, pageSignal);

    try {
        setManagedTimeout(async () => {
            const stillSameRoute = getPathOnlyFromHash() === navigation.pathOnly && AbortBus.get('page') === pageSignal;
            const noRealContent = !(elements.contentGrid && elements.contentGrid.querySelector('.grid-item'));
            const notError = !(elements.contentGrid && safeClassList(elements.contentGrid, 'contains', 'error-container'));
            if (stillSameRoute && noRealContent && notError) {
                const retrySignal = AbortBus.next('page');
                await streamPath(navigation.pathOnly, retrySignal);
            }
        }, ROUTER.ROUTE_RETRY_DELAY, 'route-retry-delay');
    } catch {}
}

/**
 * 流式加载指定路径的内容
 * @param {string} path 要加载的路径
 * @param {AbortSignal} signal 中止信号
 */
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

        const { items: filteredItems, removed: removedAlbums } = applyAlbumTombstones(data.items || []);
        data.items = filteredItems;
        if (removedAlbums > 0 && typeof data.totalResults === 'number') {
            data.totalResults = Math.max(0, data.totalResults - removedAlbums);
        }

        state.currentBrowsePath = path;
        state.totalBrowsePages = data.totalPages;

        if (!data.items || data.items.length === 0) {
            const sortContainer = safeGetElementById('sort-container');
            if (sortContainer) safeSetInnerHTML(sortContainer, '');
            state.totalBrowsePages = 0;
            state.currentBrowsePage = 1;
            // 优化：隐藏无限滚动加载器，避免重排抖动
            if (elements.infiniteScrollLoader) safeClassList(elements.infiniteScrollLoader, 'remove', 'visible');
            showEmptyAlbum();
            return;
        }

        const hasMediaFiles = data.items.some(item => item.type === 'photo' || item.type === 'video');

        // 应用布局模式（网格或瀑布流）
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
        import('../shared/dom-elements.js').then(({ reinitializeElements }) => {
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

/**
 * 执行搜索操作
 * @param {string} query 搜索查询
 * @param {AbortSignal} signal 中止信号
 */
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
            // 优化：隐藏无限滚动加载器，避免重排抖动
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
        import('../shared/dom-elements.js').then(({ reinitializeElements }) => {
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

/**
 * 为新内容加载做准备，清理当前内容并显示骨架屏
 * @returns {Promise} 准备完成的Promise
 */
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
            // 优化：隐藏无限滚动加载器，避免重排抖动
            if (elements.infiniteScrollLoader) safeClassList(elements.infiniteScrollLoader, 'remove', 'visible');

            // 修复：只在真正需要时清空图片状态，保留缓存
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

/**
 * 完成新内容加载，设置懒加载、恢复滚动位置等
 * @param {string} pathKey 路径键值
 */
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

/**
 * 保存当前滚动位置
 */
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

// 监听页面可见性变化，自动保存滚动位置
window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        saveCurrentScrollPosition();
    }
});

// 监听页面卸载，自动保存滚动位置
window.addEventListener('beforeunload', () => {
    saveCurrentScrollPosition();
});

/**
 * 处理相册浏览事件，保存浏览记录并同步到后端
 * @param {string} path 相册路径
 */
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

// 监听网络恢复，自动同步未同步的浏览记录
window.addEventListener('online', async () => {
    const unsynced = await getUnsyncedViewed();
    for (const record of unsynced) {
        try {
            await postViewed(record.path);
            await markAsSynced(record.path);
        } catch (e) {}
    }
});
