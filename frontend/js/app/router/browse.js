/**
 * @file router/browse.js
 * @description 相册浏览路由处理
 */

import { state } from '../../core/state.js';
import { elements } from '../../shared/dom-elements.js';
import { safeSetInnerHTML } from '../../shared/dom-utils.js';
import { setManagedTimeout } from '../../core/timer-manager.js';
import { AbortBus } from '../../core/abort-bus.js';
import { ROUTER } from '../../core/constants.js';
import { routerLogger } from '../../core/logger.js';
import { showNotification } from '../../shared/utils.js';
import { fetchBrowseResults } from '../api.js';
import {
    renderBreadcrumb,
    renderBrowseGrid,
    renderSortDropdown,
    applyLayoutMode,
    renderLayoutToggleOnly,
    ensureLayoutToggleVisible,
    adjustScrollOptimization
} from '../../features/gallery/ui.js';
import { scheduleThumbnailPreheat } from '../../features/gallery/preheat.js';
import { recordHierarchyView, loadRecentHistoryRecords } from '../../features/history/history-service.js';
import {
    showNetworkError,
    showEmptyAlbum,
    showMissingAlbumState,
    showEmptyViewedHistory
} from '../../features/gallery/loading-states.js';
import { applyAlbumTombstones, getPathOnlyFromHash, onAlbumViewed, convertHistoryRecordToItem } from './utils.js';
import { prepareForNewContent, finalizeNewContent } from './scroll.js';

const HISTORY_RENDER_LIMIT = 1000;

/**
 * 普通相册浏览路由处理业务入口。
 * @param {Object} navigation
 * @param {AbortSignal} pageSignal
 */
export async function handleBrowseRoute(navigation, pageSignal) {
    const previousPath = state.currentBrowsePath;
    const enhancedNavigation = { ...navigation, previousPath };
    state.currentSort = navigation.currentSortValue;
    state.currentBrowsePath = navigation.pathOnly;
    renderBreadcrumb(navigation.pathOnly);

    if (navigation.pathChanged || navigation.sortChanged) {
        state.entrySort = navigation.currentSortValue;
    }

    if (navigation.currentSortValue === 'viewed_desc') {
        await renderRecentHistory(navigation.pathOnly, pageSignal);
        return;
    }

    await streamPath(navigation.pathOnly, pageSignal, enhancedNavigation);
    enhancedNavigation.previousPath = navigation.pathOnly;

    try {
        setManagedTimeout(async () => {
            const stillSameRoute = getPathOnlyFromHash() === navigation.pathOnly && AbortBus.get('page') === pageSignal;
            const noRealContent = !(elements.contentGrid && elements.contentGrid.querySelector('.grid-item'));
            const hasErrorState = elements.contentGrid && elements.contentGrid?.classList.contains('error-container');
            const hasEmptyState = elements.contentGrid && elements.contentGrid.querySelector('.empty-state');
            const allowRetry = !hasErrorState && !hasEmptyState;
            if (stillSameRoute && noRealContent && allowRetry) {
                const retrySignal = AbortBus.next('page');
                await streamPath(navigation.pathOnly, retrySignal, enhancedNavigation);
            }
        }, ROUTER.ROUTE_RETRY_DELAY, 'route-retry-delay');
    } catch { }
}

/**
 * 渲染最近浏览历史
 * @param {string} path 
 * @param {AbortSignal} signal 
 */
async function renderRecentHistory(path, signal) {
    const prepareControl = await prepareForNewContent();
    state.isBrowseLoading = true;
    state.currentBrowsePage = 1;
    state.totalBrowsePages = 1;

    renderBreadcrumb(path);

    try {
        const historyRecords = await loadRecentHistoryRecords(path, {
            limit: HISTORY_RENDER_LIMIT,
            signal
        });
        if (!historyRecords || signal.aborted || AbortBus.get('page') !== signal || getPathOnlyFromHash() !== path) {
            return;
        }

        if (prepareControl?.cancelSkeleton) {
            prepareControl.cancelSkeleton();
        }

        if (!historyRecords.length) {
            routerLogger.info('当前目录无浏览历史，回退到实时内容', { path });
            await streamPath(path, signal);
            return;
        }

        const items = historyRecords
            .map(convertHistoryRecordToItem)
            .filter(Boolean);

        if (!items.length) {
            routerLogger.info('浏览历史无有效项目，回退到实时内容', { path });
            await streamPath(path, signal);
            return;
        }

        const { contentElements, newMediaUrls } = renderBrowseGrid(items, 0);
        const minimalLoader = document.getElementById('minimal-loader');
        if (minimalLoader) {
            minimalLoader.replaceWith(...contentElements);
        } else {
            safeSetInnerHTML(elements.contentGrid, '');
            elements.contentGrid.append(...contentElements);
        }

        state.currentPhotos = newMediaUrls;
        state.currentBrowsePage = 1;
        state.totalBrowsePages = 1;

        if (AbortBus.get('page') !== signal || getPathOnlyFromHash() !== path) return;

        if (path) {
            recordHierarchyView(path, {
                entryType: 'album',
                name: path.split('/').pop() || ''
            }).catch(() => { });
        }

        const hasMediaFiles = items.some(item => item.type === 'photo' || item.type === 'video');

        import('../../shared/dom-elements.js').then(({ reinitializeElements }) => {
            reinitializeElements();
            const sortContainer = document.getElementById('sort-container');
            if (sortContainer) {
                if (hasMediaFiles) {
                    renderLayoutToggleOnly(true);
                } else {
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
        routerLogger.warn('加载最近浏览记录失败', error);
        showEmptyViewedHistory();
    } finally {
        state.isBrowseLoading = false;
        if (!elements.contentGrid?.classList.contains('error-container')) {
            elements.contentGrid.style.minHeight = '';
        }
    }
}

/**
 * 主相册/目录内容流式加载及UI渲染方法。
 * @param {string} path 路径
 * @param {AbortSignal} signal
 * @param {Object} [navigation] 导航上下文
 */
export async function streamPath(path, signal, navigation = null) {
    const requestStart = performance.now();
    const prepareControl = await prepareForNewContent(navigation);
    state.isBrowseLoading = true;
    state.currentBrowsePage = 1;
    state.totalBrowsePages = 1;

    renderBreadcrumb(path);

    if (path.startsWith('search?q=')) {
        routerLogger.error('搜索页面不应该调用 streamPath 函数');
        return;
    }

    try {
        const data = await fetchBrowseResults(path, state.currentBrowsePage, signal);

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

        // 提取当前路径的名称（最后一级目录名）
        const pathName = path ? path.split('/').pop() : '首页';

        if (!data.items || data.items.length === 0) {
            const sortContainer = document.getElementById('sort-container');
            if (sortContainer) safeSetInnerHTML(sortContainer, '');
            state.totalBrowsePages = 0;
            state.currentBrowsePage = 1;
            // 隐藏无限加载器，提升UI性能
            if (elements.infiniteScrollLoader) elements.infiniteScrollLoader?.classList.remove('visible');
            showEmptyAlbum();
            return;
        }

        const hasMediaFiles = data.items.some(item => item.type === 'photo' || item.type === 'video');

        // 记录浏览历史（目录与相册均记录）
        const coverSource = data.items.find(item => item.type === 'photo' || item.type === 'video')
            || data.items.find(item => item.type === 'album');
        const coverData = coverSource?.data || coverSource;
        const coverUrl = coverData?.coverUrl || coverData?.thumbnailUrl || '';
        const coverWidth = coverData?.coverWidth || coverData?.width || 0;
        const coverHeight = coverData?.coverHeight || coverData?.height || 0;

        onAlbumViewed(path, {
            name: pathName,
            coverUrl,
            thumbnailUrl: coverData?.thumbnailUrl || coverUrl,
            width: coverWidth,
            height: coverHeight
        }).catch(() => { });

        // 直接渲染所有项目（移除分批渲染逻辑）
        const { contentElements, newMediaUrls } = renderBrowseGrid(data.items, 0);
        const minimalLoader = document.getElementById('minimal-loader');
        if (minimalLoader) {
            minimalLoader.replaceWith(...contentElements);
        } else {
            safeSetInnerHTML(elements.contentGrid, '');
            elements.contentGrid.append(...contentElements);
        }

        const viewKind = (!path || path === '') ? 'home' : (hasMediaFiles ? 'album' : 'directory');
        scheduleThumbnailPreheat({
            mode: hasMediaFiles ? 'media' : 'album',
            container: elements.contentGrid,
            reason: `${viewKind}-preheat`
        });

        // 更新状态
        state.currentPhotos = newMediaUrls;
        state.currentBrowsePage++;

        if (AbortBus.get('page') !== signal || getPathOnlyFromHash() !== path) return;

        // UI恢复与布局切换
        import('../../shared/dom-elements.js').then(({ reinitializeElements }) => {
            reinitializeElements();
            const sortContainer = document.getElementById('sort-container');
            if (sortContainer) {
                // 优化：布局切换始终显示，排序按钮仅在相册列表时显示
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
        if (error?.code === 'ALBUM_NOT_FOUND') {
            if (prepareControl?.cancelSkeleton) {
                prepareControl.cancelSkeleton();
            }
            showMissingAlbumState();
            showNotification('相册不存在或已被移除', 'warning');
            state.isBrowseLoading = false;
            return;
        }
        if (error.name === 'AbortError') {
            return;
        }
        routerLogger.warn('路径流式加载失败', { path, error: error.message });
        showNetworkError();
        return;
    } finally {
        state.isBrowseLoading = false;
        if (!elements.contentGrid?.classList.contains('error-container')) {
            elements.contentGrid.style.minHeight = '';
        }
    }
}
