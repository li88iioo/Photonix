/**
 * @file router.js
 * @description 前端路由管理。负责页面导航、内容渲染、多路由场景切换等。
 */

import { state, clearExpiredAlbumTombstones, getAlbumTombstonesMap } from '../core/state.js';
import { elements } from '../shared/dom-elements.js';
import { applyMasonryLayout, getMasonryColumns } from '../features/gallery/masonry.js';
import { setupLazyLoading } from '../features/gallery/lazyload.js';
import { fetchSearchResults, fetchBrowseResults, postViewed } from './api.js';
import {
    renderBreadcrumb,
    renderBrowseGrid,
    renderSearchGrid,
    sortAlbumsByViewed,
    renderSortDropdown,
    applyLayoutMode,
    renderLayoutToggleOnly,
    ensureLayoutToggleVisible,
    adjustScrollOptimization
} from '../features/gallery/ui.js';
import { saveViewed, getUnsyncedViewed, markAsSynced } from '../shared/indexeddb-helper.js';
import { AbortBus } from '../core/abort-bus.js';
import { refreshPageEventListeners } from '../features/gallery/listeners.js';
import {
    showNetworkError,
    showEmptySearchResults,
    showEmptyAlbum,
    showIndexBuildingError,
    showMinimalLoader
} from '../features/gallery/loading-states.js';
import { routerLogger } from '../core/logger.js';
import { safeSetInnerHTML, safeGetElementById, safeClassList, safeSetStyle } from '../shared/dom-utils.js';
import { executeAsync, ErrorTypes, ErrorSeverity } from '../core/error-handler.js';
import { setManagedTimeout } from '../core/timer-manager.js';
import { CACHE, ROUTER } from '../core/constants.js';
import { escapeHtml } from '../shared/security.js';
import { isDownloadRoute, showDownloadPage, hideDownloadPage } from '../features/download/index.js';

let currentRequestController = null;

/**
 * 构建用于区分不同上下文（路径+排序/搜索）的路由键
 * @param {string} pathOnly 纯路径（不含?参数）
 * @param {string} sortValue 当前排序值（如 smart/name_asc 等），可为空
 * @returns {string}
 */
function buildRouteKey(pathOnly, sortValue) {
    const sort = (sortValue && typeof sortValue === 'string') ? sortValue : 'smart';
    return `${pathOnly || ''}::sort=${sort}`;
}

/**
 * 从hash中解析排序参数
 * @param {string} hash
 * @returns {string}
 */
function getSortFromHash(hash) {
    try {
        const questionMarkIndex = hash.indexOf('?');
        const params = new URLSearchParams(questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '');
        return params.get('sort') || 'smart';
    } catch {
        return 'smart';
    }
}

/**
 * 获取当前Topbar占位高度（与 --topbar-offset 保持一致），用于避免CLS
 * @returns {number}
 */
function getTopbarOffsetHeight() {
    const app = safeGetElementById('app-container');
    if (!app) return 112;
    try {
        const v = getComputedStyle(app).getPropertyValue('--topbar-offset');
        const n = parseInt(String(v).trim().replace('px', ''), 10);
        return Number.isFinite(n) ? n : 112;
    } catch {
        return 112;
    }
}

/**
 * 读取父层列表的可见锚点信息
 * @returns {{ id: string, type: 'album'|'photo'|null, relativeOffset: number, headerHeight: number, scrollY: number }|null}
 */
function getFirstVisibleAnchor() {
    const grid = elements?.contentGrid;
    if (!grid) return null;
    const headerHeight = getTopbarOffsetHeight();
    const items = Array.from(grid.querySelectorAll('.grid-item'));
    if (items.length === 0) return {
        id: '', type: null, relativeOffset: 0, headerHeight, scrollY: window.scrollY
    };
    // 找到第一个与视口相交的项目（下边缘超过顶部偏移即视为可见）
    const first = items.find(el => {
        const rect = el.getBoundingClientRect();
        return rect.bottom > headerHeight; // 与可视区域产生交集
    }) || items[0];
    const rect = first.getBoundingClientRect();
    const relativeOffset = Math.round(rect.top - headerHeight);
    let id = '';
    let type = null;
    if (first.classList.contains('album-link')) {
        id = first.getAttribute('data-path') || '';
        type = 'album';
    } else if (first.classList.contains('photo-link')) {
        id = first.getAttribute('data-url') || '';
        type = 'photo';
    }
    return { id, type, relativeOffset, headerHeight, scrollY: window.scrollY };
}

/**
 * 读取/写入会话内的锚点集合
 */
function loadNavAnchors() {
    try {
        const raw = sessionStorage.getItem('sg_nav_anchors');
        return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
}
function saveNavAnchors(obj) {
    try { sessionStorage.setItem('sg_nav_anchors', JSON.stringify(obj)); } catch {}
}
function saveAnchorForRouteKey(routeKey, anchor) {
    if (!routeKey || !anchor) return;
    const data = loadNavAnchors();
    data[routeKey] = anchor;
    saveNavAnchors(data);
    try {
        // 同步到 history.state，便于 bfcache 恢复
        const prev = history.state && typeof history.state === 'object' ? history.state : {};
        history.replaceState({ ...prev, sg_nav_anchors: data }, '');
    } catch {}
}

/**
 * 根据已保存的锚点恢复滚动位置
 * @param {string} routeKey
 * @returns {boolean} 是否恢复成功
 */
function tryRestoreFromAnchor(routeKey) {
    if (!routeKey) return false;
    const data = (history.state && history.state.sg_nav_anchors) || loadNavAnchors();
    const anchor = data?.[routeKey];
    if (!anchor) return false;
    const grid = elements?.contentGrid;
    if (!grid) return false;
    const headerNow = getTopbarOffsetHeight();
    // 优先通过共享元素精确定位
    let selector = '';
    if (anchor.type === 'album' && anchor.id) selector = `.grid-item.album-link[data-path="${anchor.id}"]`;
    else if (anchor.type === 'photo' && anchor.id) selector = `.grid-item.photo-link[data-url="${anchor.id}"]`;
    let targetEl = null;
    try { targetEl = selector ? grid.querySelector(selector) : null; } catch { targetEl = null; }
    if (targetEl) {
        const rect = targetEl.getBoundingClientRect();
        const absoluteTop = window.scrollY + rect.top;
        const desired = Math.max(0, Math.round(absoluteTop - headerNow - (anchor.relativeOffset || 0)));
        window.scrollTo({ top: desired, behavior: 'auto' });
        return true;
    }
    // 回退：使用粗略 scrollY
    if (typeof anchor.scrollY === 'number') {
        window.scrollTo({ top: Math.max(0, anchor.scrollY | 0), behavior: 'auto' });
        return true;
    }
    return false;
}

/**
 * 过滤集合，剔除被“墓碑”标记的相册项。
 * @param {Array} collection - 原始项目集合（相册和照片）
 * @returns {Object} { items: 过滤后的集合, removed: 被移除数量 }
 */
function applyAlbumTombstones(collection) {
    clearExpiredAlbumTombstones();
    const tombstones = getAlbumTombstonesMap();
    if (!(tombstones instanceof Map) || tombstones.size === 0) {
        return { items: collection, removed: 0 };
    }
    const filtered = [];
    let removed = 0;
    for (const item of collection || []) {
        if (item?.type === 'album') {
            const albumPath = item?.data?.path;
            if (albumPath && tombstones.has(albumPath)) {
                removed += 1;
                continue;
            }
        }
        filtered.push(item);
    }
    return { items: filtered, removed };
}

/**
 * 生成面包屑导航HTML，保证安全性。
 * @param {Object} data - 搜索结果数据
 * @param {string} query - 搜索查询词
 * @returns {string} HTML 字符串
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
 * 获取当前hash对应的路由路径（去除modal后缀与参数）。
 * @returns {string} 路径
 */
function getPathOnlyFromHash() {
    const cleanHashString = window.location.hash.replace(/#modal$/, '');
    const newDecodedPath = decodeURIComponent(cleanHashString.substring(1).replace(/^\//, ''));
    const questionMarkIndex = newDecodedPath.indexOf('?');
    return questionMarkIndex !== -1 ? newDecodedPath.substring(0, questionMarkIndex) : newDecodedPath;
}

/**
 * 路由初始化。恢复session状态并监听hash变化。
 */
export function initializeRouter() {
    try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch {}
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
        const fromSearch = sessionStorage.getItem('sg_from_search_hash');
        if (fromSearch) state.update('fromSearchHash', fromSearch);
    } catch {}
    // bfcache 恢复时避免重复滚动恢复
    window.addEventListener('pageshow', (e) => {
        if (e.persisted) {
            // 在bfcache恢复场景下，保持现有滚动，不触发额外恢复
        }
    });
    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
}

/**
 * hash路由主入口，处理内容加载与导航切换。
 */
export async function handleHashChange() {
    persistRouteState();

    // 计算是否为返回到父层级（目录/首页）
    const previousPath = typeof state.currentBrowsePath === 'string' ? state.currentBrowsePath : '';
    const { cleanHashString, newDecodedPath } = sanitizeHash();
    const questionMarkIndex = newDecodedPath.indexOf('?');
    const targetPathOnly = questionMarkIndex !== -1 ? newDecodedPath.substring(0, questionMarkIndex) : newDecodedPath;
    const isBackToParent = !!previousPath && !!targetPathOnly && previousPath.startsWith(targetPathOnly + '/') && !cleanHashString.endsWith('#modal');
    const targetRouteKey = buildRouteKey(targetPathOnly, getSortFromHash(window.location.hash));
    state.update('isBackNavigation', isBackToParent);
    state.update('restoreTargetRouteKey', isBackToParent ? targetRouteKey : null);

    const doRoute = async () => {
        AbortBus.abortMany(['page', 'scroll']);
        const pageSignal = AbortBus.next('page');
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
        manageFromSearchHash(newDecodedPath);
        if (navigation.isSearchRoute) {
            await handleSearchRoute(navigation, pageSignal);
        } else {
            await handleBrowseRoute(navigation, pageSignal);
        }
    };

    // 支持的浏览器使用 View Transitions API 实现优雅过渡
    try {
        if (isBackToParent && typeof document !== 'undefined' && typeof document.startViewTransition === 'function') {
            await document.startViewTransition(() => doRoute());
            return;
        }
    } catch (e) {
        // 忽略视图转场错误，使用降级方案
    }

    await doRoute();
}

/**
 * 持久化当前路由相关状态（比如滚动位置）。
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
        
        // 检测是否是关闭modal（相册）
        const oldHash = sessionStorage.getItem('sg_last_hash') || '';
        const newHash = location.hash;
        const isClosingModal = oldHash.includes('#modal') && !newHash.includes('#modal');
        const isOpeningModal = !oldHash.includes('#modal') && newHash.includes('#modal');
        
        // 如果是关闭modal，不覆盖之前保存的滚动位置
        if (!isClosingModal) {
            const newScrollPositions = new Map(state.scrollPositions);
            newScrollPositions.set(key, window.scrollY);
            state.scrollPositions = newScrollPositions;
        }

        // 进入子层级时，记录父层列表锚点（首页->目录、目录->相册）
        try {
            const newPathOnly = getPathOnlyFromHash();
            const goingDeeper = !!key && !!newPathOnly && newPathOnly.startsWith(key + '/') && !isOpeningModal;
            if (goingDeeper) {
                const anchor = getFirstVisibleAnchor();
                const sortValue = state.currentSort || getSortFromHash(oldHash);
                const routeKey = buildRouteKey(key, sortValue);
                saveAnchorForRouteKey(routeKey, anchor);
            }
        } catch {}
        
        // 如果当前在搜索页，保存搜索hash（在离开前保存）
        if (key.startsWith('search?q=')) {
            try {
                sessionStorage.setItem('sg_from_search_hash', oldHash || newHash);
            } catch (e) {
                // 忽略错误
            }
        }
        
        // 保存当前hash供下次判断
        sessionStorage.setItem('sg_last_hash', newHash);
    }
}

/**
 * hash清洗与解码。
 * @returns {{ cleanHashString: string, newDecodedPath: string }}
 */
function sanitizeHash() {
    const cleanHashString = window.location.hash.replace(/#modal$/, '');
    const newDecodedPath = decodeURIComponent(cleanHashString.substring(1).replace(/^\//, ''));
    return { cleanHashString, newDecodedPath };
}

/**
 * 安全刷新全局页面事件监听（防止异常阻断）。
 */
function refreshRouteEventListenersSafely() {
    try {
        refreshPageEventListeners();
    } catch (error) {
        routerLogger.warn('刷新页面事件监听失败', error);
    }
}

/**
 * 构建导航上下文对象，用于路由状态判断和内容渲染逻辑。
 * @param {string} cleanHashString
 * @param {string} newDecodedPath
 * @returns {Object} 导航上下文
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
 * 判断是否需要复用当前内容（避免重复渲染）。只有路径与排序都不变且已渲染内容时复用。
 * @param {Object} navigation
 * @returns {boolean}
 */
function shouldReuseExistingContent(navigation) {
    if (navigation.pathChanged || navigation.sortChanged || state.isInitialLoad) {
        return false;
    }
    return !!(elements.contentGrid && elements.contentGrid.querySelector('.grid-item'));
}

/**
 * 根据hash内容更新preSearchHash（搜索页返回用）。
 * @param {string} cleanHashString
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
 * 管理"来源搜索页"的hash，用于面包屑"返回搜索"功能。
 * @param {string} newDecodedPath - 新的路径
 */
function manageFromSearchHash(newDecodedPath) {
    const isTargetSearch = newDecodedPath.startsWith('search?q=');
    
    // 如果进入搜索页或首页，清除fromSearchHash
    if (isTargetSearch || newDecodedPath === '') {
        try {
            sessionStorage.removeItem('sg_from_search_hash');
            state.update('fromSearchHash', null);
        } catch (e) {
            // 忽略sessionStorage错误
        }
    } else {
        // 不是搜索页，从sessionStorage同步到state
        try {
            const savedHash = sessionStorage.getItem('sg_from_search_hash');
            if (savedHash) {
                state.update('fromSearchHash', savedHash);
            }
        } catch (e) {
            // 忽略sessionStorage错误
        }
    }
}

/**
 * 搜索路由处理业务入口。
 * @param {Object} navigation
 * @param {AbortSignal} pageSignal
 */
async function handleSearchRoute(navigation, pageSignal) {
    const queryIndex = navigation.newDecodedPath.indexOf('?');
    const searchParams = queryIndex !== -1 ? navigation.newDecodedPath.substring(queryIndex) : '';
    const urlParams = new URLSearchParams(searchParams);
    const query = urlParams.get('q') || '';
    await executeSearch(query, pageSignal);
}

/**
 * 普通相册浏览路由处理业务入口。
 * @param {Object} navigation
 * @param {AbortSignal} pageSignal
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
 * 主相册/目录内容流式加载及UI渲染方法。
 * @param {string} path 路径
 * @param {AbortSignal} signal
 */
export async function streamPath(path, signal) {
    const requestStart = performance.now();
    const prepareControl = await prepareForNewContent();
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

        // 数据到达后取消加载器
        const responseTime = performance.now() - requestStart;
        if (prepareControl && prepareControl.cancelSkeleton) {
            prepareControl.cancelSkeleton();
        }

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
            // 隐藏无限加载器，提升UI性能
            if (elements.infiniteScrollLoader) safeClassList(elements.infiniteScrollLoader, 'remove', 'visible');
            showEmptyAlbum();
            return;
        }

        const hasMediaFiles = data.items.some(item => item.type === 'photo' || item.type === 'video');

        // 直接渲染所有项目（移除分批渲染逻辑）
        const { contentElements, newMediaUrls } = renderBrowseGrid(data.items, 0);
        const minimalLoader = safeGetElementById('minimal-loader');
        if (minimalLoader) {
            minimalLoader.replaceWith(...contentElements);
        } else {
            safeSetInnerHTML(elements.contentGrid, '');
            elements.contentGrid.append(...contentElements);
        }

        // 更新状态
        state.currentPhotos = newMediaUrls;
        state.currentBrowsePage++;

        if (AbortBus.get('page') !== signal || getPathOnlyFromHash() !== path) return;

        // UI恢复与布局切换
        import('../shared/dom-elements.js').then(({ reinitializeElements }) => {
            reinitializeElements();
            const sortContainer = safeGetElementById('sort-container');
            if (sortContainer) {
                // ✅ 优化：布局切换始终显示，排序按钮仅在相册列表时显示
                if (hasMediaFiles) {
                    // 图片/视频页（相册页）：使用动画
                    renderLayoutToggleOnly(true);
                } else {
                    // 相册列表页（首页/目录页）：不使用动画
                    renderLayoutToggleOnly(false);
                    renderSortDropdown();
                }
            }
            applyLayoutMode();
            finalizeNewContent(path);
        });

        setManagedTimeout(() => {
            ensureLayoutToggleVisible();
            adjustScrollOptimization(path);
        }, 50, 'layout-post-render');
    } catch (error) {
        if (error.name !== 'AbortError') {
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
            const loaderContainer = safeGetElementById('infinite-scroll-loader-container');
            if (loaderContainer) safeClassList(loaderContainer, 'remove', 'visible');
            showEmptySearchResults(query);
            safeSetStyle(elements.contentGrid, 'minHeight', '');
            return;
        }

        // 直接渲染所有搜索结果（移除分批渲染逻辑）
        const { contentElements, newMediaUrls } = renderSearchGrid(data.results, 0);
        const minimalLoader = safeGetElementById('minimal-loader');
        if (minimalLoader) {
            minimalLoader.replaceWith(...contentElements);
        } else {
            safeSetInnerHTML(elements.contentGrid, '');
            elements.contentGrid.append(...contentElements);
        }
        
        // 更新状态
        state.currentPhotos = newMediaUrls;
        state.totalSearchPages = data.totalPages;
        state.currentSearchPage++;

        if (AbortBus.get('page') !== signal) return;
        import('../shared/dom-elements.js').then(({ reinitializeElements }) => {
            reinitializeElements();
            // 搜索页是图片列表，使用动画
            renderLayoutToggleOnly(true);
        });

        applyLayoutMode();
        finalizeNewContent(searchPathKey);

        setManagedTimeout(() => {
            ensureLayoutToggleVisible();
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
 * 预计算并设置topbar高度，确保在内容渲染前padding-top已正确
 * @param {string} targetPath - 目标路径
 */
function preCalculateTopbarOffset(targetPath) {
    const topbar = safeGetElementById('topbar');
    const topbarContext = safeGetElementById('topbar-context');
    const appContainer = safeGetElementById('app-container');
    
    if (!topbar || !appContainer) return;
    
    // 预测topbar-context是否会显示
    // 规则：所有页面都显示context（包含排序和布局按钮）
    // 首页显示空白面包屑+按钮，子目录显示完整面包屑+按钮
    const willShowContext = true;
    
    // 立即设置topbar状态为完全展开（移除hidden和condensed）
    safeClassList(topbar, 'remove', 'topbar--hidden');
    safeClassList(topbar, 'remove', 'topbar--condensed');
    
    // 如果context存在但不应该显示，临时隐藏（避免测量错误）
    let contextWasHidden = false;
    if (topbarContext && !willShowContext) {
        const currentDisplay = window.getComputedStyle(topbarContext).display;
        if (currentDisplay !== 'none') {
            contextWasHidden = true;
            safeSetStyle(topbarContext, 'display', 'none');
        }
    }
    
    // 强制浏览器同步布局，获取真实高度
    const topbarInner = topbar.querySelector('.topbar-inner');
    const persistentHeight = topbarInner?.offsetHeight || 56;
    
    // context高度：只有在应该显示时才计算
    let contextHeight = 0;
    if (willShowContext && topbarContext) {
        // 临时显示context以测量高度
        const originalDisplay = topbarContext.style.display;
        safeSetStyle(topbarContext, 'display', '');
        contextHeight = topbarContext.offsetHeight;
        // 恢复原始状态
        if (contextWasHidden) {
            safeSetStyle(topbarContext, 'display', 'none');
        }
    }
    
    // 计算总高度（+16px为额外间距）
    const totalOffset = persistentHeight + contextHeight + 16;
    
    // 立即设置CSS变量
    safeSetStyle(appContainer, '--topbar-offset', `${totalOffset}px`);
    
    routerLogger.debug('预计算topbar高度', {
        path: targetPath,
        willShowContext,
        persistentHeight,
        contextHeight,
        totalOffset
    });
}

/**
 * 准备新内容渲染，清理旧页面与状态，并处理loading效果。
 * @returns {Promise<{ cancelSkeleton():void }>} 控制对象
 */
function prepareForNewContent() {
    return new Promise(resolve => {
        // 0. 获取目标路径并预计算topbar高度（最优先）
        const { cleanHashString, newDecodedPath } = sanitizeHash();
        const navigation = buildNavigationContext(cleanHashString, newDecodedPath);
        const targetPath = navigation?.pathOnly || '';
        
        // 预先计算并设置topbar高度，避免后续跳动
        preCalculateTopbarOffset(targetPath);
        
        // 1. 先清空内容，避免滚动时看到旧内容移动
        safeSetInnerHTML(elements.contentGrid, '');
        
        // 2. 立即滚动到顶部（此时内容已清空，看不到滚动）
        if (window.scrollY > 0) {
            window.scrollTo(0, 0);
        }
        
        // 3. 清除目标路径的保存位置，避免恢复到旧位置
        // 但不清除以下情况：
        // - 当前路径的位置（用于modal返回）
        // - 上级路径的位置（用于返回上级目录）
        if (navigation && navigation.pathOnly && navigation.pathOnly !== state.currentBrowsePath) {
            // 判断是否是返回上级目录
            const isGoingBack = state.currentBrowsePath && 
                               state.currentBrowsePath.startsWith(navigation.pathOnly + '/');
            
            // 只有前进到新页面时才清除，返回上级时保留
            if (!isGoingBack) {
                const newScrollPositions = new Map(state.scrollPositions);
                newScrollPositions.delete(navigation.pathOnly);
                state.scrollPositions = newScrollPositions;
            }
        }
        
        // 4. topbar状态已在preCalculateTopbarOffset中处理
        
        const scroller = state.virtualScroller;
        if (scroller) {
            scroller.destroy();
            state.update('virtualScroller', null);
        }
        // 清理预加载缓存
        if (typeof window !== 'undefined' && window.clearPrefetchCache) {
            window.clearPrefetchCache();
        }

        let loaderShown = false;
        let dataArrived = false;
        let loaderTimer = null;
        
        // 延迟 600ms 显示加载器（局域网不显示，3G网络必定显示）
        loaderTimer = setTimeout(() => {
            if (!loaderShown && !dataArrived) {
                showMinimalLoader({ text: '加载中' });
                loaderShown = true;
            }
        }, 600);

        // 立即返回控制对象
        const controlObject = {
            cancelSkeleton: () => {
                dataArrived = true;
                
                if (loaderTimer) {
                    clearTimeout(loaderTimer);
                    loaderTimer = null;
                }
                
                if (loaderShown) {
                    const loader = safeGetElementById('minimal-loader');
                    if (loader && loader.parentNode) {
                        loader.remove();
                    }
                    loaderShown = false;
                }
            }
        };
        
        // 立即resolve，让streamPath能马上调用cancelSkeleton
        resolve(controlObject);
        
        // 后台继续执行清理工作
        setManagedTimeout(() => {
            safeSetStyle(elements.contentGrid, 'height', 'auto');
            // 隐藏加载器
            if (elements.infiniteScrollLoader) {
                safeClassList(elements.infiniteScrollLoader, 'remove', 'visible');
            }
            // 仅路径切换才清空图片状态
            const currentPath = state.currentBrowsePath;
            const isSamePathReload = currentPath && currentPath === getPathOnlyFromHash();
            if (!isSamePathReload) {
                state.update('currentPhotos', []);
            }
        }, 100, 'content-transition');
    });
}

/**
 * 新内容渲染完成后，处理懒加载与滚动状态恢复。
 * @param {string} pathKey
 */
function finalizeNewContent(pathKey) {
    if (!state.virtualScroller) {
        setupLazyLoading();
        let stateRestored = false;
        if (window.restorePageLazyState) {
            stateRestored = window.restorePageLazyState(pathKey);
        }
        if (!stateRestored && safeClassList(elements.contentGrid, 'contains', 'masonry-mode')) {
            // ✅ 延迟执行瀑布流布局，确保图片容器已正确渲染
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    applyMasonryLayout();
                });
            });
        }
    }
    sortAlbumsByViewed();
    state.update('currentColumnCount', getMasonryColumns());
    preloadVisibleImages();

    // 层级返回：精确恢复父层位置（优先使用锚点）
    const currentSort = getSortFromHash(window.location.hash);
    const routeKey = buildRouteKey(pathKey, currentSort);
    const shouldRestore = !!state.isBackNavigation && state.restoreTargetRouteKey === routeKey;

    if (shouldRestore) {
        // 降级动画：不支持 View Transitions 时，使用轻微淡入
        const useFade = !(typeof document !== 'undefined' && typeof document.startViewTransition === 'function');
        if (useFade && elements?.contentGrid) {
            safeSetStyle(elements.contentGrid, 'opacity', '0.001');
            safeSetStyle(elements.contentGrid, 'transform', 'translateZ(0)');
            safeSetStyle(elements.contentGrid, 'transition', 'opacity 180ms ease');
        }
        // 等待布局稳定后再恢复精确位置
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const ok = tryRestoreFromAnchor(routeKey);
                if (useFade && elements?.contentGrid) {
                    // 同帧更新，避免CLS
                    requestAnimationFrame(() => {
                        safeSetStyle(elements.contentGrid, 'opacity', '1');
                    });
                }
                if (!ok) {
                    // 兜底：使用旧的粗略 scrollY
                    const scrollPositions = state.scrollPositions;
                    const roughY = scrollPositions.get(pathKey);
                    if (roughY && roughY > 0) {
                        window.scrollTo({ top: roughY, behavior: 'auto' });
                    }
                }
            });
        });
    }
    
    safeSetStyle(elements.contentGrid, 'minHeight', '');
    state.update('isInitialLoad', false);
}

/**
 * 预加载首屏与可视区域图片，加速首屏体验与布局稳定性。
 */
function preloadVisibleImages() {
    if (!elements.contentGrid) return;
    const viewportHeight = window.innerHeight;
    const lazyImages = Array.from(elements.contentGrid.querySelectorAll('.lazy-image:not(.loaded)'));
    if (lazyImages.length === 0) return;
    // 可见范围判断
    const visibleImages = lazyImages.filter(img => {
        const rect = img.getBoundingClientRect();
        return rect.top < viewportHeight * 2.5;
    });
    // 优先前20张图片
    const priorityImages = visibleImages.slice(0, 20);
    if (priorityImages.length > 0) {
        import('../features/gallery/lazyload.js').then(lazyloadModule => {
            priorityImages.forEach(img => {
                if (typeof lazyloadModule.enqueueLazyImage === 'function') {
                    lazyloadModule.enqueueLazyImage(img, {
                        rect: img.getBoundingClientRect(),
                        priority: 'high'
                    });
                }
            });
        }).catch(error => {
            routerLogger.warn('预加载图片失败', error);
        });
    }
}

/**
 * 保存当前滚动位置到state和sessionStorage。
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

// 页面可见性变化时自动保存当前滚动位置
window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        saveCurrentScrollPosition();
    }
});

// 页面卸载前自动保存当前滚动位置
window.addEventListener('beforeunload', () => {
    saveCurrentScrollPosition();
});

/**
 * 上传并记录某路径被浏览的行为，支持离线同步。
 * @param {string} path
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

// 监听网络恢复后自动同步本地未上传的浏览记录
window.addEventListener('online', async () => {
    const unsynced = await getUnsyncedViewed();
    for (const record of unsynced) {
        try {
            await postViewed(record.path);
            await markAsSynced(record.path);
        } catch (e) {}
    }
});
