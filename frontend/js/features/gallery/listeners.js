/**
 * @file 事件监听器模块
 * @description 负责处理所有用户交互事件，包括滚动、点击、键盘、触摸等
 */

import { state, addAlbumTombstone } from '../../core/state.js';
import { elements } from '../../shared/dom-elements.js';
import { applyMasonryLayout, getMasonryColumns, applyMasonryLayoutIncremental, triggerMasonryUpdate } from './masonry.js';
import { closeModal, navigateModal, _handleThumbnailClick, _navigateToAlbum, startFastNavigate, stopFastNavigate } from '../../app/modal.js';
import { SwipeHandler } from './touch.js';
import { fetchBrowseResults, fetchSearchResults, deleteAlbum } from '../../app/api.js';
import { renderBrowseGrid, renderSearchGrid, updateLayoutToggleButton, applyLayoutMode } from './ui.js';
import { AbortBus } from '../../core/abort-bus.js';
import { setupLazyLoading } from './lazyload.js';
import { UI, getCommonScrollConfig } from '../../core/constants.js';
import { showSettingsModal } from '../../app/settings.js';
import { createPageGroup, createComponentGroup, cleanupPage, on } from '../../core/event-manager.js';
import { createModuleLogger } from '../../core/logger.js';
import { showNotification } from '../../shared/utils.js';
import { showMissingAlbumState } from './loading-states.js';
import { recordHierarchyView } from '../history/history-service.js';

const listenersLogger = createModuleLogger('Listeners');

const LONG_PRESS_DELAY = 550;
let deleteLongPressTimer = null;
let deleteLongPressTarget = null;
let activeAlbumDeleteOverlay = null;



/**
 * 切换所有媒体元素的模糊状态（图片、视频等）
 */
function toggleMediaBlur() {
    state.isBlurredMode = !state.isBlurredMode;
    document.querySelectorAll('.lazy-image, #modal-img, .lazy-video, #modal-video').forEach(media => {
        media?.classList.toggle('blurred', state.isBlurredMode);
    });
}

/**
 * 统一 document 点击事件处理器
 * 合并所有 document click 监听逻辑，避免重复绑定
 * @param {Event} e - 点击事件对象
 */
function handleDocumentClick(e) {
    // 0. 处理布局切换按钮点击（事件委托）
    if (e.target.closest('#layout-toggle-btn')) {
        e.preventDefault();
        e.stopPropagation();
        try {
            const current = state.layoutMode;
            const next = current === 'grid' ? 'masonry' : 'grid';
            state.update('layoutMode', next);
            try { localStorage.setItem('sg_layout_mode', next); } catch { }

            // 修复：使用直接导入的函数更新UI
            setTimeout(() => {
                // 应用布局模式
                applyLayoutMode();

                // 更新按钮图标
                if (elements.layoutToggleBtn) {
                    updateLayoutToggleButton(elements.layoutToggleBtn);
                }
            }, 0);
        } catch (error) {
            listenersLogger.error('切换布局模式出错', error);
        }
        return;
    }

    // 1. 关闭移动端搜索层
    const topbar = document.getElementById('topbar');
    if (topbar && topbar?.classList.contains('topbar--search-open')) {
        const isInsideSearch = e.target.closest && e.target.closest('.search-container');
        const isToggle = e.target.closest && e.target.closest('#search-toggle-btn');
        if (!isInsideSearch && !isToggle) {
            topbar?.classList.remove('topbar--search-open');
        }
    }

    // 2. 隐藏搜索历史
    if (elements.searchInput && elements.searchInput.contains) {
        const searchHistoryContainer = document.getElementById('search-history');
        if (searchHistoryContainer && !elements.searchInput.contains(e.target) && !searchHistoryContainer.contains(e.target)) {
            // 异步加载搜索历史模块
            import('./search-history.js').then(module => {
                if (module.hideSearchHistory) {
                    module.hideSearchHistory(searchHistoryContainer);
                }
            }).catch(() => {
                // 搜索历史模块加载失败，静默处理
            });
        }
    }

    // 3. PC端密语气泡框现在默认显示，不需要点击外部关闭
    // (移动端密语在工具栏中)

    // 4. 关闭相册删除浮层
    if (activeAlbumDeleteOverlay) {
        const overlayCard = activeAlbumDeleteOverlay.closest('.album-link');
        if (!overlayCard || (!activeAlbumDeleteOverlay.contains(e.target) && (!overlayCard.contains(e.target) || e.target.closest('.album-delete-overlay') !== activeAlbumDeleteOverlay))) {
            closeActiveAlbumDeleteOverlay();
        }
    }
}

/**
 * 判断相册删除功能是否启用
 * @returns {boolean}
 */
function isAlbumDeletionEnabled() {
    return Boolean(state.albumDeletionEnabled);
}

/**
 * 关闭当前激活的相册删除浮层
 */
function closeActiveAlbumDeleteOverlay() {
    if (!activeAlbumDeleteOverlay) return;
    activeAlbumDeleteOverlay.dataset.state = 'idle';
    activeAlbumDeleteOverlay?.classList.remove('active');
    const albumCard = activeAlbumDeleteOverlay.closest('.album-card');
    if (albumCard) {
        albumCard?.classList.remove('delete-active');
    }
    activeAlbumDeleteOverlay = null;
}

/**
 * 显示指定相册的删除浮层
 * @param {Element} albumLink - 相册链接元素
 * @returns {Element|null} - 删除浮层元素
 */
function showAlbumDeleteOverlay(albumLink) {
    if (!albumLink) return null;
    const overlay = albumLink.querySelector('.album-delete-overlay');
    if (!overlay) return null;

    if (activeAlbumDeleteOverlay && activeAlbumDeleteOverlay !== overlay) {
        closeActiveAlbumDeleteOverlay();
    }

    overlay.dataset.state = 'idle';
    overlay?.classList.add('active');
    const albumCard = albumLink.querySelector('.album-card');
    if (albumCard) {
        albumCard?.classList.add('delete-active');
    }
    activeAlbumDeleteOverlay = overlay;
    return overlay;
}

/**
 * 进入相册删除确认状态
 * @param {Element} overlay - 删除浮层元素
 */
function enterAlbumDeleteConfirm(overlay) {
    if (!overlay) return;
    overlay.dataset.state = 'confirm';
}

/**
 * 退出相册删除确认状态
 * @param {Element} overlay - 删除浮层元素
 */
function exitAlbumDeleteConfirm(overlay) {
    if (!overlay) return;
    overlay.dataset.state = 'idle';
}

/**
 * 确认删除相册
 * @param {Element} overlay - 删除浮层元素
 * @param {Element} confirmBtn - 确认按钮
 * @param {Element} cancelBtn - 取消按钮
 */
async function confirmAlbumDeletion(overlay, confirmBtn, cancelBtn) {
    if (!overlay) return;
    const albumLink = overlay.closest('.album-link');
    const path = albumLink?.dataset?.path;
    if (!path) {
        showNotification('无法确定相册路径', 'error');
        exitAlbumDeleteConfirm(overlay);
        return;
    }

    overlay.dataset.state = 'processing';
    if (confirmBtn) confirmBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;

    try {
        const result = await deleteAlbum(path);
        showNotification(result?.message || '相册已删除', 'success');
        addAlbumTombstone(path);
        closeActiveAlbumDeleteOverlay();
        if (albumLink && albumLink.parentElement) {
            albumLink.remove();
            triggerMasonryUpdate();
        }
        state.update('pageCache', new Map());
    } catch (error) {
        overlay.dataset.state = 'confirm';
        if (confirmBtn) confirmBtn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
        showNotification(error?.message || '删除失败', 'error');
    }
}

/**
 * 定时调度显示删除浮层（长按触发）
 * @param {Element} overlayTarget - 目标相册元素
 */
function scheduleDeleteOverlay(overlayTarget) {
    if (deleteLongPressTimer) {
        clearTimeout(deleteLongPressTimer);
        deleteLongPressTimer = null;
    }
    deleteLongPressTarget = overlayTarget;
    deleteLongPressTimer = setTimeout(() => {
        if (deleteLongPressTarget) {
            showAlbumDeleteOverlay(deleteLongPressTarget);
        }
        deleteLongPressTimer = null;
        deleteLongPressTarget = null;
    }, LONG_PRESS_DELAY);
}

/**
 * 取消删除浮层的定时器
 */
function cancelDeleteOverlayTimer() {
    if (deleteLongPressTimer) {
        clearTimeout(deleteLongPressTimer);
        deleteLongPressTimer = null;
    }
    deleteLongPressTarget = null;
}



/**
 * 浏览页面滚动处理，触发无限滚动加载
 */
export function handleBrowseScroll() {
    handleScroll('browse');
}

/**
 * 搜索页面滚动处理，触发无限滚动加载
 */
export function handleSearchScroll() {
    handleScroll('search');
}

// 滚动处理防抖定时器
let scrollTimeout = null;

/**
 * 通用滚动处理函数（带防抖），实现无限滚动加载
 * @param {string} type - 滚动类型（'browse' 或 'search'）
 */
async function handleScroll(type) {
    // 防抖：清除之前的定时器
    if (scrollTimeout) {
        clearTimeout(scrollTimeout);
    }

    const debounceDelay = getCommonScrollConfig('SCROLL_THROTTLE_MS') || 16;
    scrollTimeout = setTimeout(async () => {
        await handleScrollCore(type);
    }, debounceDelay);
}

/**
 * 滚动处理核心逻辑
 * @param {string} type - 滚动类型
 */
// 预加载缓存：避免重复请求
const prefetchCache = {
    browse: new Map(), // key: `${path}_${page}`, value: Promise<data>
    search: new Map()  // key: `${query}_${page}`, value: Promise<data>
};

/**
 * 清理预加载缓存（路由切换时调用）
 * @export
 */
export function clearPrefetchCache() {
    prefetchCache.browse.clear();
    prefetchCache.search.clear();
    listenersLogger.debug('预加载缓存已清理');
}

// 暴露到全局，供 router.js 调用
if (typeof window !== 'undefined') {
    window.clearPrefetchCache = clearPrefetchCache;
}

/**
 * 预加载下一页数据（静默加载，不渲染）
 * @param {string} type - 'browse' 或 'search'
 */
async function prefetchNextPage(type) {
    const currentPage = type === 'browse' ? state.currentBrowsePage : state.currentSearchPage;
    const totalPages = type === 'browse' ? state.totalBrowsePages : state.totalSearchPages;

    // 已到最后一页，无需预加载
    if (currentPage > totalPages) return;

    const nextPage = currentPage;
    const cacheKey = type === 'browse'
        ? `${state.currentBrowsePath}_${nextPage}`
        : `${state.currentSearchQuery}_${nextPage}`;

    const cache = prefetchCache[type];

    // 已经在预加载或已缓存，跳过
    if (cache.has(cacheKey)) return;

    // 创建预加载请求（使用顶部已导入的 fetchBrowseResults 和 fetchSearchResults）
    const signal = AbortBus.next('prefetch');
    const fetchPromise = type === 'browse'
        ? fetchBrowseResults(state.currentBrowsePath, nextPage, signal)
        : fetchSearchResults(state.currentSearchQuery, nextPage, signal);

    // 缓存Promise
    cache.set(cacheKey, fetchPromise);

    try {
        await fetchPromise;
        listenersLogger.debug(`预加载成功: ${type} page ${nextPage}`);
    } catch (error) {
        // 预加载失败不影响正常流程，静默处理
        cache.delete(cacheKey);
        if (error.name !== 'AbortError') {
            listenersLogger.debug(`预加载失败: ${type} page ${nextPage}`, error.message);
        }
    }
}

async function handleScrollCore(type) {
    // 获取对应类型的状态
    const isLoading = type === 'browse' ? state.isBrowseLoading : state.isSearchLoading;
    const currentPage = type === 'browse' ? state.currentBrowsePage : state.currentSearchPage;
    const totalPages = type === 'browse' ? state.totalBrowsePages : state.totalSearchPages;

    // 若为空态/连接态/错误态/骨架屏，则不触发无限滚动
    const grid = document.getElementById('content-grid');
    if (grid) {
        const firstChild = grid.firstElementChild;
        const isBlockedState = firstChild && (
            firstChild?.classList.contains('empty-state') ||
            firstChild?.classList.contains('connecting-container') ||
            firstChild?.classList.contains('error-container') ||
            firstChild.id === 'skeleton-grid' ||
            firstChild.id === 'minimal-loader'
        );
        if (isBlockedState) {
            // 优化：使用新容器控制可见性，避免重排抖动
            if (elements.infiniteScrollLoader) elements.infiniteScrollLoader?.classList.remove('visible');
            return;
        }
    }

    // 正在加载或已到最后一页则跳过
    if (isLoading || currentPage > totalPages) return;

    // 预加载优化：滚动到80%时触发预加载
    const scrollPercentage = (window.scrollY + window.innerHeight) / document.documentElement.scrollHeight;
    if (scrollPercentage >= 0.8 && scrollPercentage < 0.95) {
        // 静默预加载下一页，不阻塞当前滚动
        prefetchNextPage(type).catch(() => { });
    }

    // 优化：滚动位置检查，距离底部 500px 时触发渲染
    if (window.scrollY > 100 && (window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight - 500) {
        // 设置加载状态
        if (type === 'browse') state.isBrowseLoading = true;
        else state.isSearchLoading = true;

        // 优化：使用新容器控制可见性，避免重排抖动
        if (elements.infiniteScrollLoader) elements.infiniteScrollLoader?.classList.add('visible');

        try {
            let data;

            // 尝试从预加载缓存获取数据
            const cacheKey = type === 'browse'
                ? `${state.currentBrowsePath}_${currentPage}`
                : `${state.currentSearchQuery}_${currentPage}`;

            const cache = prefetchCache[type];

            if (cache.has(cacheKey)) {
                // 使用预加载的数据，无需重新请求
                listenersLogger.debug(`使用预加载缓存: ${type} page ${currentPage}`);
                try {
                    data = await cache.get(cacheKey);
                    cache.delete(cacheKey); // 用完即删，避免内存泄漏
                } catch (error) {
                    // 预加载数据损坏，降级到正常请求
                    cache.delete(cacheKey);
                    listenersLogger.warn(`预加载缓存失效，降级请求: ${type} page ${currentPage}`);
                    data = null;
                }
            }

            // 缓存未命中或失效，发起正常请求
            if (!data) {
                const signal = AbortBus.next('scroll');
                if (type === 'browse') {
                    data = await fetchBrowseResults(state.currentBrowsePath, currentPage, signal);
                } else {
                    data = await fetchSearchResults(state.currentSearchQuery, currentPage, signal);
                }
            }

            if (!data) return;

            const items = type === 'browse' ? data.items : data.results;
            if (items.length === 0) {
                if (type === 'browse') state.isBrowseLoading = false; else state.isSearchLoading = false;
                // 优化：使用新容器控制可见性，避免重排抖动
                if (elements.infiniteScrollLoader) elements.infiniteScrollLoader?.classList.remove('visible');
                return;
            }

            // 更新总页数
            if (type === 'browse') state.totalBrowsePages = data.totalPages;
            else state.totalSearchPages = data.totalPages;

            // 渐进式渲染优化：无限滚动也应用分批加载策略
            const SCROLL_BATCH_SIZE = 12; // 滚动加载每批12张
            const firstBatch = items.slice(0, SCROLL_BATCH_SIZE);
            const remainingBatch = items.slice(SCROLL_BATCH_SIZE);

            const prevCount = elements.contentGrid.children.length;

            // 立即渲染第一批
            const renderResult = type === 'browse'
                ? renderBrowseGrid(firstBatch, state.currentPhotos.length)
                : renderSearchGrid(firstBatch, state.currentPhotos.length);

            const { contentElements: firstElements, newMediaUrls: firstUrls, fragment } = renderResult;

            // 在瀑布流模式下，先隐藏新元素，避免"闪过"
            const isMasonryMode = elements.contentGrid?.classList.contains('masonry-mode');
            if (isMasonryMode) {
                if (fragment && fragment.children.length > 0) {
                    Array.from(fragment.children).forEach(child => {
                        child.style.opacity = '0';
                        child.style.pointerEvents = 'none';
                    });
                } else {
                    firstElements.forEach(el => {
                        el.style.opacity = '0';
                        el.style.pointerEvents = 'none';
                    });
                }
            }

            // 批量插入第一批 DOM 元素
            if (fragment && fragment.children.length > 0) {
                elements.contentGrid.appendChild(fragment);
            } else {
                elements.contentGrid.append(...firstElements);
            }
            state.currentPhotos = state.currentPhotos.concat(firstUrls);

            // 后续内容在下一帧渲染，避免阻塞
            if (remainingBatch.length > 0) {
                requestAnimationFrame(() => {
                    const remainingResult = type === 'browse'
                        ? renderBrowseGrid(remainingBatch, state.currentPhotos.length)
                        : renderSearchGrid(remainingBatch, state.currentPhotos.length);

                    const { contentElements: remainingElements, newMediaUrls: remainingUrls } = remainingResult;

                    // 同样先隐藏延迟批次的元素
                    if (isMasonryMode) {
                        remainingElements.forEach(el => {
                            el.style.opacity = '0';
                            el.style.pointerEvents = 'none';
                        });
                    }

                    elements.contentGrid.append(...remainingElements);
                    state.currentPhotos = state.currentPhotos.concat(remainingUrls);

                    // 延迟批次也需要懒加载和布局
                    setupLazyLoading();
                    const newRemainingItems = Array.from(elements.contentGrid.children).slice(prevCount + firstBatch.length);
                    applyMasonryLayoutIncremental(newRemainingItems);
                });
            }

            // 更新页码
            if (type === 'browse') state.currentBrowsePage++;
            else state.currentSearchPage++;

            // 设置懒加载和瀑布流布局
            setupLazyLoading();
            const newItems = Array.from(elements.contentGrid.children).slice(prevCount);
            applyMasonryLayoutIncremental(newItems);
        } catch (error) {
            if (error?.code === 'ALBUM_NOT_FOUND' || error?.status === 404) {
                if (type === 'browse') {
                    state.totalBrowsePages = Math.min(state.totalBrowsePages, state.currentBrowsePage - 1);
                    showMissingAlbumState();
                }
                showNotification('相册不存在或已被移除', 'warning');
            } else if (error.name !== 'AbortError') {
                listenersLogger.error('获取更多项目失败', error);
            }
        } finally {
            if (type === 'browse') state.isBrowseLoading = false;
            else state.isSearchLoading = false;
            // 优化：使用新容器控制可见性，避免重排抖动
            if (elements.infiniteScrollLoader) elements.infiniteScrollLoader?.classList.remove('visible');
        }
    }
}

// 当前活动的页面组
let currentPageGroup = null;

/**
 * 刷新当前页面类型的事件监听配置
 * 路由切换后重新绑定对应的滚动与尺寸事件
 */
export function refreshPageEventListeners() {
    if (currentPageGroup) {
        cleanupPage(currentPageGroup);
        currentPageGroup = null;
    }
    setupCurrentPageEvents();
}

/**
 * 设置全局事件（所有页面通用）
 */
function setupGlobalEvents() {
    const globalController = createComponentGroup('global');
    registerSettingsChangeHandler(globalController);
    registerKeyboardShortcuts(globalController);
    registerBlurGesture(globalController);
}

/**
 * 注册设置变更事件处理
 * @param {AbortController} controller - 事件控制器
 */
function registerSettingsChangeHandler(controller) {
    on(window, 'settingsChanged', (event) => {
        const detail = event.detail || {};
        const { aiEnabled, passwordEnabled, aiSettings, albumDeletionEnabled, manualSyncSchedule } = detail;

        if (typeof aiEnabled !== 'undefined') {
            state.update('aiEnabled', aiEnabled);
        }
        if (typeof passwordEnabled !== 'undefined') {
            state.update('passwordEnabled', passwordEnabled);
        }

        if (aiSettings) {
            // 可在此响应 AI 设置变更
        }

        if (typeof albumDeletionEnabled !== 'undefined') {
            const enabled = Boolean(albumDeletionEnabled);
            state.update('albumDeletionEnabled', enabled);
            if (!enabled) {
                closeActiveAlbumDeleteOverlay();
            }
        }

        if (typeof manualSyncSchedule !== 'undefined') {
            state.update('manualSyncSchedule', manualSyncSchedule);
        }
    }, { signal: controller.signal });
}

/**
 * 注册全局键盘快捷键
 * @param {AbortController} controller - 事件控制器
 */
function registerKeyboardShortcuts(controller) {
    on(document, 'keydown', (e) => {
        if (e.key === 'Escape' && activeAlbumDeleteOverlay) {
            closeActiveAlbumDeleteOverlay();
            return;
        }

        if (!elements.modal?.classList.contains('opacity-0')) {
            if (e.key === 'Escape') {
                if (window.location.hash.endsWith('#modal')) window.history.back();
            }
            else if (e.key === 'ArrowLeft') { navigateModal('prev'); }
            else if (e.key === 'ArrowRight') { navigateModal('next'); }
        }

        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        switch (e.key.toLowerCase()) {
            case 'b':
                toggleMediaBlur();
                break;
            case 'f':
                if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen().catch(err => {
                        listenersLogger.debug('全屏模式失败', err);
                    });
                } else {
                    document.exitFullscreen();
                }
                break;
            case 's':
                e.preventDefault();
                elements.searchInput.focus();
                elements.searchInput.select();
                break;
            case 'r':
                e.preventDefault();
                window.location.reload();
                break;
            case 'h':
                e.preventDefault();
                window.location.hash = '#/';
                break;
            case 'g':
                e.preventDefault();
                try {
                    const current = state.layoutMode;
                    const next = current === 'grid' ? 'masonry' : 'grid';
                    state.update('layoutMode', next);
                    try { localStorage.setItem('sg_layout_mode', next); } catch { }
                    listenersLogger.debug(`布局模式切换: ${current} → ${next}`);
                } catch (error) {
                    listenersLogger.error('切换布局模式出错', error);
                }
                break;
            case 'escape':
                if (window.location.hash.includes('search?q=')) {
                    window.location.hash = state.preSearchHash || '#/';
                }
                break;
        }

        // 数字键 1-9 快捷打开对应图片
        if (/^[1-9]$/.test(e.key)) {
            const index = parseInt(e.key, 10) - 1;
            const photoLinks = document.querySelectorAll('.photo-link');
            if (photoLinks[index]) {
                photoLinks[index].click();
            }
        }
    }, { signal: controller.signal });
}

/**
 * 注册三指触摸模糊手势
 * @param {AbortController} controller - 事件控制器
 */
function registerBlurGesture(controller) {
    on(document, 'touchstart', (e) => {
        if (e.touches.length === 3) {
            e.preventDefault();
            toggleMediaBlur();
        }
    }, { passive: false, signal: controller.signal });
}

/**
 * 设置当前页面的特定事件
 */
function setupCurrentPageEvents() {
    // 基于当前路由确定页面类型
    const hash = window.location.hash;
    let pageType = 'browse'; // 默认页面

    if (hash.includes('/search')) {
        pageType = 'search';
    } else if (hash.includes('/album')) {
        pageType = 'album';
    }

    currentPageGroup = pageType;

    // 创建页面特定的事件控制器
    const pageController = createPageGroup(pageType);

    // 设置页面特定的滚动事件
    if (pageType === 'browse') {
        on(window, 'scroll', handleBrowseScroll, { passive: true, signal: pageController.signal });
    } else if (pageType === 'search') {
        on(window, 'scroll', handleSearchScroll, { passive: true, signal: pageController.signal });
    }

    // 设置窗口大小变化事件（所有页面都需要）
    let resizeTimeout;
    on(window, 'resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const newColumnCount = getMasonryColumns();
            const containerWidth = document.getElementById('content-grid')?.clientWidth || 0;
            const changedCols = newColumnCount !== state.currentColumnCount;
            const changedWidth = Math.abs(containerWidth - (state.currentLayoutWidth || 0)) > 1;
            if ((changedCols || changedWidth) && elements.contentGrid?.classList.contains('masonry-mode')) {
                state.currentColumnCount = newColumnCount;
                state.currentLayoutWidth = containerWidth;
                applyMasonryLayout();
            }
            // 骨架屏已废弃，无需刷新
        }, 60);
    }, { signal: pageController.signal });
}

/**
 * 设置所有事件监听器，包括点击、搜索、键盘、滚动、触摸等
 */
export function setupEventListeners() {
    // 清理之前的页面组
    if (currentPageGroup) {
        cleanupPage(currentPageGroup);
    }

    // 设置全局事件
    setupGlobalEvents();

    // 设置当前页面的特定事件
    setupCurrentPageEvents();

    // 顶栏滚动方向显示/隐藏 + 移动端搜索开关
    setupTopbarInteractions();

    // 内容区交互
    setupContentInteractions();

    // 搜索交互
    setupSearchInteractions();

    // 模态框交互
    setupModalInteractions();

    // 窗口大小变化处理 + 容器尺寸变化监听（避免仅滚动触发才更新的情况）
    let resizeTimeout;
    function reflowIfNeeded() {
        const newColumnCount = getMasonryColumns();
        const containerWidth = document.getElementById('content-grid')?.clientWidth || 0;
        const changedCols = newColumnCount !== state.currentColumnCount;
        const changedWidth = Math.abs(containerWidth - (state.currentLayoutWidth || 0)) > 1;
        if ((changedCols || changedWidth) && elements.contentGrid?.classList.contains('masonry-mode')) {
            state.currentColumnCount = newColumnCount;
            state.currentLayoutWidth = containerWidth;
            applyMasonryLayout();
        }
    }
    // resize 监听器已统一在 setupCurrentPageEvents 处理
    // 监听主容器 Resize，处理浏览器 UI 缩放或滚动条出现/消失带来的布局宽度变化
    if (window.ResizeObserver) {
        let ticking = false;
        let lastWidth = 0;
        const ro = new ResizeObserver((entries) => {
            if (ticking) return;

            // 只在宽度真正变化时才触发重排
            const currentWidth = entries[0]?.contentRect?.width || 0;
            if (Math.abs(currentWidth - lastWidth) < 1) return;

            lastWidth = currentWidth;
            ticking = true;
            requestAnimationFrame(() => {
                reflowIfNeeded();
                ticking = false;
            });
        });
        const grid = document.getElementById('content-grid');
        if (grid) ro.observe(grid);
        const pageInner = document.getElementById('page-inner');
        if (pageInner) ro.observe(pageInner);
    }

    // 其他 UI 组件事件
    const uiController = createComponentGroup('ui');

    // 回到顶部按钮
    const backToTopBtn = document.getElementById('back-to-top-btn');
    if (backToTopBtn) {
        // 点击回到顶部
        on(backToTopBtn, 'click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }, { signal: uiController.signal });
    }

    // 设置按钮 - 动态导入实现按需加载
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
        on(settingsBtn, 'click', async () => {
            try {
                showSettingsModal();
            } catch (error) {
                listenersLogger.error('加载设置模块失败', error);
                alert('加载设置页面失败，请刷新页面重试');
            }
        }, { signal: uiController.signal });
    }

    // Photonix 标题点击返回首页
    const mainTitle = document.getElementById('main-title');
    if (mainTitle) {
        on(mainTitle, 'click', () => {
            // 和键盘快捷键 'h' 行为保持一致
            window.location.hash = '#/';
        }, { signal: uiController.signal });
    }
}

/**
 * 设置顶栏相关交互事件
 */
function setupTopbarInteractions() {
    const topbarController = createComponentGroup('topbar');
    const topbar = document.getElementById('topbar');
    const searchToggleBtn = document.getElementById('search-toggle-btn');
    const commandSearchBtn = document.getElementById('command-search-btn');
    const mobileSearchBtn = document.getElementById('mobile-search-btn');
    const mobileSearchBackBtn = document.getElementById('mobile-search-back-btn');
    const searchSubmitBtn = document.getElementById('search-submit-btn');
    const searchInput = document.getElementById('search-input');
    const searchContainer = searchInput ? searchInput.closest('.search-container') : null;
    if (!topbar) {
        return;
    }

    let lastScrollY = window.scrollY;
    let ticking = false;

    /**
     * 顶栏滚动处理
     */
    function onScroll() {
        const currentY = window.scrollY;
        const delta = currentY - lastScrollY;

        // 增加滚动阈值，避免滚动到底部时的微小波动导致topbar抽搐
        const SCROLL_DELTA_THRESHOLD = 4; // 降低阈值，提高响应速度

        // 检测是否在页面底部（允许10px误差）
        const isAtBottom = (window.innerHeight + window.scrollY) >= (document.documentElement.scrollHeight - 10);

        if (currentY < 50) {
            // 顶部50px内：完全显示
            topbar?.classList.remove('topbar--hidden');
            topbar?.classList.remove('topbar--condensed');
            lastScrollY = currentY;
        } else if (isAtBottom) {
            // 在底部时：保持当前状态不变，避免抽搐
            // 不更新lastScrollY，不改变topbar状态
            return;
        } else if (delta > SCROLL_DELTA_THRESHOLD && currentY > UI.SCROLL_THRESHOLD_DOWN) {
            // 明显向下滚动：隐藏topbar
            topbar?.classList.add('topbar--hidden');
            topbar?.classList.add('topbar--condensed');
            lastScrollY = currentY;
        } else if (delta < -SCROLL_DELTA_THRESHOLD) {
            // 明显向上滚动：显示topbar
            topbar?.classList.remove('topbar--hidden');
            topbar?.classList.remove('topbar--condensed');
            lastScrollY = currentY;
        }
        // 微小滚动（|delta| <= 5px）不更新状态
    }

    let lastTopbarOffset = 0;
    /**
     * 更新回到顶部按钮可见性
     */
    function updateBackToTopButton() {
        const backToTopBtn = document.getElementById('back-to-top-btn');
        if (!backToTopBtn) return;
        if (window.scrollY > 400) {
            backToTopBtn?.classList.add('visible');
        } else {
            backToTopBtn?.classList.remove('visible');
        }
    }

    /**
     * 更新顶栏 offset 变量
     */
    function updateTopbarOffset() {
        const appContainer = document.getElementById('app-container');
        if (!appContainer) return;
        const persistentHeight = topbar.querySelector('.topbar-inner')?.offsetHeight || 56;
        const contextEl = document.getElementById('topbar-context');
        const contextHeight = (contextEl && !topbar?.classList.contains('topbar--condensed')) ? contextEl.offsetHeight : 0;
        const total = persistentHeight + contextHeight + 16;

        if (Math.abs(total - lastTopbarOffset) >= 1) {
            lastTopbarOffset = total;
            appContainer.style.setProperty('--topbar-offset', `${total}px`);
        }
    }

    const contextEl = document.getElementById('topbar-context');
    // 移除多次延迟重试，改由router.js在路由切换前预计算
    // 仅保留初始化调用和响应式更新
    updateTopbarOffset();
    on(window, 'resize', () => { updateTopbarOffset(); }, { signal: topbarController.signal });
    on(window, 'scroll', () => {
        if (ticking) return;
        requestAnimationFrame(() => {
            onScroll();
            updateTopbarOffset();
            updateBackToTopButton();
            ticking = false;
        });
        ticking = true;
    }, { passive: true, signal: topbarController.signal });

    if (window.ResizeObserver) {
        let topbarResizeTimeout;
        const ro = new ResizeObserver(() => {
            clearTimeout(topbarResizeTimeout);
            topbarResizeTimeout = setTimeout(() => {
                updateTopbarOffset();
            }, 16);
        });
        ro.observe(topbar);
        if (contextEl) ro.observe(contextEl);
    }

    if (searchToggleBtn) {
        on(searchToggleBtn, 'click', (e) => {
            e.stopPropagation();
            topbar?.classList.toggle('topbar--search-open');
            if (topbar?.classList.contains('topbar--search-open') && searchInput) {
                setTimeout(() => { searchInput.focus(); }, 0);
            }
        }, { signal: topbarController.signal });
    }

    /**
     * 打开命令式搜索
     */
    function openCommandSearch() {
        if (!searchInput) return;
        if (!topbar?.classList.contains('topbar--inline-search')) {
            topbar?.classList.add('topbar--search-open');
        }
        const isMobile = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
        if (!isMobile) {
            setTimeout(() => {
                searchInput.focus();
                searchInput.select?.();
            }, 0);
        }
    }

    if (commandSearchBtn) {
        on(commandSearchBtn, 'click', (e) => {
            e.stopPropagation();
            openCommandSearch();
        }, { signal: topbarController.signal });
    }

    if (mobileSearchBtn) {
        on(mobileSearchBtn, 'click', (e) => {
            e.stopPropagation();
            topbar?.classList.add('topbar--inline-search');
            openCommandSearch();
        }, { signal: topbarController.signal });
    }

    if (mobileSearchBackBtn) {
        on(mobileSearchBackBtn, 'click', () => {
            topbar?.classList.remove('topbar--search-open');
            topbar?.classList.remove('topbar--inline-search');
            if (searchContainer) searchContainer.removeAttribute('style');
            if (searchInput) searchInput.blur();
        }, { signal: topbarController.signal });
    }

    if (searchSubmitBtn) {
        on(searchSubmitBtn, 'click', (e) => {
            e.preventDefault();
            if (!searchInput) return;
            const q = (searchInput.value || '').trim();
            if (q) {
                window.location.hash = `/search?q=${encodeURIComponent(q)}`;
            }
        }, { signal: topbarController.signal });
    }

    on(document, 'click', handleDocumentClick, { signal: topbarController.signal });
}

/**
 * 设置内容区交互事件
 */
function setupContentInteractions() {
    const contentController = createComponentGroup('content');

    const grid = elements.contentGrid;
    if (!grid) {
        return;
    }

    on(grid, 'click', async (e) => {
        const deleteTriggerBtn = e.target.closest('.album-delete-trigger');
        if (deleteTriggerBtn) {
            e.preventDefault();
            e.stopPropagation();
            const overlay = deleteTriggerBtn.closest('.album-delete-overlay');
            if (overlay) {
                enterAlbumDeleteConfirm(overlay);
            }
            return;
        }

        const deleteConfirmBtn = e.target.closest('.album-delete-confirm');
        if (deleteConfirmBtn) {
            e.preventDefault();
            e.stopPropagation();
            const overlay = deleteConfirmBtn.closest('.album-delete-overlay');
            const cancelBtn = overlay?.querySelector('.album-delete-cancel');
            if (overlay) {
                await confirmAlbumDeletion(overlay, deleteConfirmBtn, cancelBtn);
            }
            return;
        }

        const deleteCancelBtn = e.target.closest('.album-delete-cancel');
        if (deleteCancelBtn) {
            e.preventDefault();
            e.stopPropagation();
            const overlay = deleteCancelBtn.closest('.album-delete-overlay');
            if (overlay) {
                exitAlbumDeleteConfirm(overlay);
            }
            closeActiveAlbumDeleteOverlay();
            return;
        }

        if (e.target.closest('.album-delete-overlay')) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        const albumLink = e.target.closest('.album-link');
        const photoLink = e.target.closest('.photo-link');

        if (albumLink) {
            if (activeAlbumDeleteOverlay && albumLink.contains(activeAlbumDeleteOverlay) && activeAlbumDeleteOverlay.dataset.state !== 'processing') {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            e.preventDefault();
            const path = albumLink.dataset.path;
            if (state.currentSort === 'viewed_desc' && path) {
                const img = albumLink.querySelector('img[data-src]');
                const titleEl = albumLink.querySelector('.album-title');
                const coverUrl = img?.dataset?.src || '';
                recordHierarchyView(path, {
                    entryType: 'album',
                    name: titleEl?.textContent?.trim() || path.split('/').pop() || '',
                    coverUrl,
                    thumbnailUrl: coverUrl,
                    width: Number(albumLink.dataset.width) || 0,
                    height: Number(albumLink.dataset.height) || 0
                }).catch(() => { });
            }
            _navigateToAlbum(e, path);
        } else if (photoLink) {
            e.preventDefault();
            const url = photoLink.dataset.url;
            const index = parseInt(photoLink.dataset.index, 10);
            _handleThumbnailClick(photoLink, url, index);
        }
    }, { signal: contentController.signal });

    on(grid, 'contextmenu', (e) => {
        if (!isAlbumDeletionEnabled()) return;
        const albumLink = e.target.closest('.album-link');
        if (!albumLink) return;
        e.preventDefault();
        e.stopPropagation();
        showAlbumDeleteOverlay(albumLink);
    }, { signal: contentController.signal });

    on(grid, 'touchstart', (e) => {
        if (!isAlbumDeletionEnabled()) return;
        if (e.touches && e.touches.length > 1) return;
        const albumLink = e.target.closest('.album-link');
        if (!albumLink) return;
        scheduleDeleteOverlay(albumLink);
    }, { passive: true, signal: contentController.signal });

    const cancelTouch = () => {
        cancelDeleteOverlayTimer();
    };

    on(grid, 'touchmove', cancelTouch, { passive: true, signal: contentController.signal });
    on(grid, 'touchend', (e) => {
        if (deleteLongPressTimer) {
            cancelDeleteOverlayTimer();
            return;
        }
        const albumLink = e.target.closest('.album-link');
        if (albumLink && activeAlbumDeleteOverlay && albumLink.contains(activeAlbumDeleteOverlay)) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, { passive: false, signal: contentController.signal });
    on(grid, 'touchcancel', cancelTouch, { passive: true, signal: contentController.signal });
}

/**
 * 设置搜索相关交互事件
 */
function setupSearchInteractions() {
    if (!elements.searchInput) {
        return;
    }

    const searchController = createComponentGroup('search');

    const searchHistoryContainer = document.getElementById('search-history');
    let searchHistoryModule = null;

    import('./search-history.js').then(module => {
        searchHistoryModule = module;
    }).catch(error => {
        listenersLogger.warn('搜索历史模块加载失败，将在需要时重试', error);
    });

    on(elements.searchInput, 'input', (e) => {
        clearTimeout(state.searchDebounceTimer);
        const query = e.target.value;

        if (!query.trim()) {
            if (searchHistoryModule) {
                searchHistoryModule.showSearchHistory(elements.searchInput, searchHistoryContainer);
            }
            return;
        }

        if (searchHistoryModule) {
            searchHistoryModule.hideSearchHistory(searchHistoryContainer);
        }

        state.searchDebounceTimer = setTimeout(() => {
            const latest = elements.searchInput.value;
            const latestTrimmed = (latest || '').trim();
            const currentQuery = new URLSearchParams(window.location.hash.substring(window.location.hash.indexOf('?'))).get('q');
            if (latestTrimmed) {
                if (latestTrimmed !== currentQuery) {
                    window.location.hash = `/search?q=${encodeURIComponent(latestTrimmed)}`;
                    if (searchHistoryModule) {
                        searchHistoryModule.saveSearchHistory(latestTrimmed);
                    }
                }
            } else if (window.location.hash.includes('search?q=')) {
                window.location.hash = state.preSearchHash || '#/';
            }
        }, 800);
    }, { signal: searchController.signal });

    on(elements.searchInput, 'focus', () => {
        if (!elements.searchInput.value.trim() && searchHistoryModule) {
            searchHistoryModule.showSearchHistory(elements.searchInput, searchHistoryContainer);
        }
    }, { signal: searchController.signal });
}

/**
 * 设置模态框相关交互事件
 */
function setupModalInteractions() {
    const modalController = createComponentGroup('modal');

    on(window, 'popstate', () => {
        if (!window.location.hash.endsWith('#modal') && !elements.modal?.classList.contains('opacity-0')) {
            closeModal();
        }
    }, { signal: modalController.signal });

    on(elements.modalClose, 'click', () => {
        if (window.location.hash.endsWith('#modal')) {
            window.history.back();
        }
    }, { signal: modalController.signal });

    let touchMoved = false;
    on(elements.mediaPanel, 'touchstart', () => { touchMoved = false; }, { passive: true, signal: modalController.signal });
    on(elements.mediaPanel, 'touchmove', () => { touchMoved = true; }, { passive: true, signal: modalController.signal });
    on(elements.mediaPanel, 'click', (e) => {
        if (e.target === elements.mediaPanel && window.location.hash.endsWith('#modal') && !touchMoved) {
            window.history.back();
        }
    }, { signal: modalController.signal });

    on(elements.modal, 'click', (event) => {
        if (!document.body.classList.contains('ai-chat-visible')) return;
        if (!window.location.hash.endsWith('#modal')) return;
        const layout = elements.modalLayout;
        if (layout && layout.contains(event.target)) return;
        if (elements.modalToolbar && elements.modalToolbar.contains(event.target)) return;
        if (elements.aiCloseHint && elements.aiCloseHint.contains(event.target)) return;
        window.history.back();
    }, { signal: modalController.signal });

    // PC端密语气泡框现在默认显示，不需要切换按钮
    // 移动端密语显示在工具栏中

    on(elements.modal, 'wheel', (e) => {
        if (window.innerWidth <= 768) return;
        const now = Date.now();
        if (now - state.lastWheelTime < 300) return;
        state.lastWheelTime = now;
        if (e.deltaY < 0) {
            navigateModal('prev');
        } else {
            navigateModal('next');
        }
    }, { passive: true, signal: modalController.signal });

    // 滑动手势处理
    const swipeHandler = new SwipeHandler(elements.mediaPanel, {
        shouldAllowSwipe: () => {
            const isImage = !elements.modalImg?.classList.contains('hidden');
            const zoomed = elements.mediaPanel?.dataset?.isZoomed === '1';
            return !(isImage && zoomed);
        },
        onSwipe: (direction) => {
            if (elements.modal?.classList.contains('opacity-0')) return;
            if (direction === 'left') {
                navigateModal('next');
            } else if (direction === 'right') {
                navigateModal('prev');
            }
        },
        onFastSwipe: (direction) => {
            if (elements.modal?.classList.contains('opacity-0')) return;
            if (direction === 'right') {
                startFastNavigate('prev');
            } else if (direction === 'left') {
                startFastNavigate('next');
            }
        }
    });

    on(elements.mediaPanel, 'touchend', () => {
        stopFastNavigate();
        if (swipeHandler) {
            swipeHandler.resetState();
            swipeHandler.resetCoordinates();
        }
    }, { signal: modalController.signal });
}
