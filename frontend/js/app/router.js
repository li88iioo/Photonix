/**
 * @file router.js
 * @description 前端路由管理。负责页面导航、内容渲染、多路由场景切换等。
 * 
 * 模块拆分：
 * - router/utils.js    - 工具函数（墓碑过滤、面包屑HTML、路径处理）
 * - router/scroll.js   - 滚动位置管理、页面内容准备
 * - router/search.js   - 搜索路由处理
 * - router/browse.js   - 相册浏览路由处理
 */

import { state } from '../core/state.js';
import { CACHE } from '../core/constants.js';
import { AbortBus } from '../core/abort-bus.js';
import { routerLogger } from '../core/logger.js';
import { refreshPageEventListeners } from '../features/gallery/listeners.js';
import { clearSortCache } from '../features/gallery/ui.js';
import { clearLazyloadQueue, savePageLazyState, clearRestoreProtection } from '../features/gallery/lazyload.js';
import { isDownloadRoute, showDownloadPage, hideDownloadPage } from '../features/download/index.js';
import { elements } from '../shared/dom-elements.js';

// 导入子模块
import { handleSearchRoute } from './router/search.js';
import { handleBrowseRoute, streamPath } from './router/browse.js';
import { saveCurrentScrollPosition } from './router/scroll.js';
import { getPathOnlyFromHash } from './router/utils.js';

// 重新导出供外部使用
export { streamPath };

/**
 * 路由初始化。恢复session状态并监听hash变化。
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
        const fromSearch = sessionStorage.getItem('sg_from_search_hash');
        if (fromSearch) state.update('fromSearchHash', fromSearch);
    } catch { }
    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
}

/**
 * hash路由主入口，处理内容加载与导航切换。
 */
export async function handleHashChange() {
    clearSortCache(); // 切换路由时清除排序缓存，确保浏览记录实时生效
    persistRouteState();
    AbortBus.abortMany(['page', 'scroll']);
    clearLazyloadQueue(true); // 清空懒加载队列和缓存，避免页面切换后图片空白
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
    manageFromSearchHash(newDecodedPath);
    if (navigation.isSearchRoute) {
        await handleSearchRoute(navigation, pageSignal);
    } else {
        await handleBrowseRoute(navigation, pageSignal);
    }
}

/**
 * 持久化当前路由相关状态（比如滚动位置）。
 */
function persistRouteState() {
    if (typeof state.currentBrowsePath === 'string') {
        savePageLazyState(state.currentBrowsePath);
    }
    clearRestoreProtection();
    if (typeof state.currentBrowsePath === 'string') {
        const key = state.currentBrowsePath;

        // 检测是否是关闭modal（相册）
        const oldHash = sessionStorage.getItem('sg_last_hash') || '';
        const newHash = location.hash;
        const isClosingModal = oldHash.includes('#modal') && !newHash.includes('#modal');

        // 如果是关闭modal，不覆盖之前保存的滚动位置
        if (!isClosingModal) {
            const newScrollPositions = new Map(state.scrollPositions);
            newScrollPositions.set(key, window.scrollY);
            state.scrollPositions = newScrollPositions;
        }

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

    const searchParamsString = questionMarkIndex !== -1 ? newDecodedPath.substring(questionMarkIndex) : '';
    const urlParams = new URLSearchParams(searchParamsString);
    const sortParam = urlParams.get('sort') || '';
    const pathChanged = pathOnly !== state.currentBrowsePath;
    const previousSort = state.currentSort || 'mtime_desc';
    const currentSortValue = sortParam || (pathChanged ? previousSort : 'mtime_desc');
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
 * 判断是否需要复用当前内容（避免重复渲染）。
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
 * 只在从搜索页直接进入的第一个相册显示"返回"，继续导航到子相册时清除。
 * @param {string} newDecodedPath - 新的路径
 */
function manageFromSearchHash(newDecodedPath) {
    const isTargetSearch = newDecodedPath.startsWith('search?q=');

    // 如果进入搜索页或首页，清除fromSearchHash
    if (isTargetSearch || newDecodedPath === '') {
        try {
            sessionStorage.removeItem('sg_from_search_hash');
            sessionStorage.removeItem('sg_from_search_first_album');
            state.update('fromSearchHash', null);
        } catch (e) {
            // 忽略sessionStorage错误
        }
    } else {
        // 非搜索页/首页，检查是否是从搜索页直接进入的第一个相册
        try {
            const savedHash = sessionStorage.getItem('sg_from_search_hash');
            const firstAlbum = sessionStorage.getItem('sg_from_search_first_album');

            if (savedHash) {
                if (!firstAlbum) {
                    // 第一次从搜索页进入相册：记录这个相册路径，显示返回链接
                    sessionStorage.setItem('sg_from_search_first_album', newDecodedPath);
                    state.update('fromSearchHash', savedHash);
                } else if (firstAlbum === newDecodedPath) {
                    // 仍在第一个相册（可能是回退）：保持返回链接
                    state.update('fromSearchHash', savedHash);
                } else {
                    // 已导航到其他相册：清除返回链接
                    state.update('fromSearchHash', null);
                }
            } else {
                state.update('fromSearchHash', null);
            }
        } catch (e) {
            // 忽略sessionStorage错误
        }
    }
}
