// frontend/js/listeners.js

import { state } from './state.js';
import { elements } from './dom-elements.js';
import { applyMasonryLayout, getMasonryColumns, applyMasonryLayoutIncremental } from './masonry.js';
import { closeModal, navigateModal, _handleThumbnailClick, _navigateToAlbum, startFastNavigate, stopFastNavigate } from './modal.js';
import { SwipeHandler } from './touch.js';
import { fetchBrowseResults, fetchSearchResults } from './api.js';
import { renderBrowseGrid, renderSearchGrid } from './ui.js';
import { AbortBus } from './abort-bus.js';
import { setupLazyLoading } from './lazyload.js';
import { UI, getCommonScrollConfig } from './constants.js';
import { showSettingsModal } from './settings.js';
import { createPageGroup, createComponentGroup, cleanupPage } from './event-manager.js';
import { createModuleLogger } from './logger.js';
import { safeGetElementById, safeClassList, safeSetStyle } from './dom-utils.js';

const listenersLogger = createModuleLogger('Listeners');

/**
 * 事件监听器管理模块
 * 负责处理所有用户交互事件，包括滚动、点击、键盘、触摸等
 */

// 设置变更事件监听 - 通过事件管理器处理

/**
 * 安全的动态导入loading-states模块
 */
function safeLoadSkeletonGrid() {
    import('./loading-states.js').then(m => m.showSkeletonGrid()).catch(() => {});
}

/**
 * 切换所有媒体元素的模糊状态
 * 统一处理图片、视频的模糊效果
 */
function toggleMediaBlur() {
    state.isBlurredMode = !state.isBlurredMode;
    document.querySelectorAll('.lazy-image, #modal-img, .lazy-video, #modal-video').forEach(media => {
        safeClassList(media, 'toggle', 'blurred', state.isBlurredMode);
    });
}

/**
 * 统一的document点击事件处理器
 * 合并所有document click监听器的逻辑，避免重复绑定
 */
function handleDocumentClick(e) {
    // 1. 处理移动端搜索层的关闭
    const topbar = safeGetElementById('topbar');
    if (topbar && safeClassList(topbar, 'contains', 'topbar--search-open')) {
        const isInsideSearch = e.target.closest && e.target.closest('.search-container');
        const isToggle = e.target.closest && e.target.closest('#search-toggle-btn');
        if (!isInsideSearch && !isToggle) {
            safeClassList(topbar, 'remove', 'topbar--search-open');
        }
    }

    // 2. 处理搜索历史的隐藏
    if (elements.searchInput && elements.searchInput.contains) {
        const searchHistoryContainer = safeGetElementById('search-history');
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

    // 3. 处理AI标题气泡的关闭
    if (elements.captionBubble && safeClassList(elements.captionBubble, 'contains', 'show') &&
        !elements.captionBubble.contains(e.target) &&
        (!elements.toggleCaptionBtn || !elements.toggleCaptionBtn.contains(e.target))) {
        safeClassList(elements.captionBubble, 'remove', 'show');
    }
}

/**
 * 移除滚动监听器
 * 在路由切换时清理滚动事件监听（向后兼容）
 * @deprecated 现在由事件管理器自动处理
 */
export function removeScrollListeners() {
    // 向后兼容：事件管理器会自动清理
    // 不再需要手动移除监听器
}

/**
 * 浏览页面的滚动处理
 * 触发浏览模式的无限滚动加载
 */
export function handleBrowseScroll() {
    handleScroll('browse');
}

/**
 * 搜索页面的滚动处理
 * 触发搜索模式的无限滚动加载
 */
export function handleSearchScroll() {
    handleScroll('search');
}

// 滚动处理防抖控制
let scrollTimeout = null;

/**
 * 通用滚动处理函数（带防抖优化）
 * 实现无限滚动加载功能
 * @param {string} type - 滚动类型 ('browse' 或 'search')
 */
async function handleScroll(type) {
    // 简单防抖：清除之前的定时器
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
async function handleScrollCore(type) {
    // 获取对应类型的状态
    const isLoading = type === 'browse' ? state.isBrowseLoading : state.isSearchLoading;
    const currentPage = type === 'browse' ? state.currentBrowsePage : state.currentSearchPage;
    const totalPages = type === 'browse' ? state.totalBrowsePages : state.totalSearchPages;

    // 如果当前为空态/连接态/错误态/骨架屏，则不触发无限滚动
    const grid = safeGetElementById('content-grid');
    if (grid) {
        const firstChild = grid.firstElementChild;
        const isBlockedState = firstChild && (
            safeClassList(firstChild, 'contains', 'empty-state') ||
            safeClassList(firstChild, 'contains', 'connecting-container') ||
            safeClassList(firstChild, 'contains', 'error-container') ||
            firstChild.id === 'skeleton-grid'
        );
        if (isBlockedState) {
            // 【优化】使用新的容器控制可见性，避免重排抖动
            if (elements.infiniteScrollLoader) safeClassList(elements.infiniteScrollLoader, 'remove', 'visible');
            return;
        }
    }

    // 如果正在加载或已到最后一页，则跳过
    if (isLoading || currentPage > totalPages) return;

    // 【优化】增加滚动位置检查，避免临界状态抖动 + 检查是否接近页面底部（距离底部500px时触发加载）
    if (window.scrollY > 100 && (window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight - 500) {
        // 设置加载状态
        if (type === 'browse') state.isBrowseLoading = true;
        else state.isSearchLoading = true;

        // 【优化】使用新的容器控制可见性，避免重排抖动
        if (elements.infiniteScrollLoader) safeClassList(elements.infiniteScrollLoader, 'add', 'visible');
        
        try {
            let data;
            // 为分页使用统一的 scroll 分组信号，便于路由切换时批量取消
            const signal = AbortBus.next('scroll');
            
            // 根据类型获取数据
            if (type === 'browse') {
                data = await fetchBrowseResults(state.currentBrowsePath, currentPage, signal);
            } else {
                data = await fetchSearchResults(state.currentSearchQuery, currentPage, signal);
            }
            
            if (!data) return;

            const items = type === 'browse' ? data.items : data.results;
            if (items.length === 0) {
                 if (type === 'browse') state.isBrowseLoading = false; else state.isSearchLoading = false;
                 // 【优化】使用新的容器控制可见性，避免重排抖动
                 if (elements.infiniteScrollLoader) safeClassList(elements.infiniteScrollLoader, 'remove', 'visible');
                 return;
            };

            // 更新总页数
            if (type === 'browse') state.totalBrowsePages = data.totalPages;
            else state.totalSearchPages = data.totalPages;

            // 渲染新内容 - 使用批量 DOM 操作
            const prevCount = elements.contentGrid.children.length;
            const renderResult = type === 'browse' 
                ? renderBrowseGrid(items, state.currentPhotos.length)
                : renderSearchGrid(items, state.currentPhotos.length);
            
            const { contentElements, newMediaUrls, fragment } = renderResult;
            
            // 批量插入 DOM 元素
            if (fragment && fragment.children.length > 0) {
                elements.contentGrid.appendChild(fragment);
            } else {
                elements.contentGrid.append(...contentElements);
            }
            state.currentPhotos = state.currentPhotos.concat(newMediaUrls);

            // 更新页码
            if (type === 'browse') state.currentBrowsePage++;
            else state.currentSearchPage++;
            
            // 设置懒加载和瀑布流布局
            setupLazyLoading();
            const newItems = Array.from(elements.contentGrid.children).slice(prevCount);
            applyMasonryLayoutIncremental(newItems);
        } catch (error) {
            if (error.name !== 'AbortError') {
                listenersLogger.error('获取更多项目失败', error);
            }
        } finally {
             if (type === 'browse') state.isBrowseLoading = false;
             else state.isSearchLoading = false;
            // 【优化】使用新的容器控制可见性，避免重排抖动
            if (elements.infiniteScrollLoader) safeClassList(elements.infiniteScrollLoader, 'remove', 'visible');
        }
    }
}

// 存储当前活动的页面组
let currentPageGroup = null;

/**
 * 刷新当前页面类型的事件监听配置
 * 在路由切换后重新绑定对应的滚动与尺寸事件
 */
export function refreshPageEventListeners() {
    if (currentPageGroup) {
        cleanupPage(currentPageGroup);
        currentPageGroup = null;
    }
    setupCurrentPageEvents();
}

/**
 * 设置全局事件（在所有页面都需要的）
 */
function setupGlobalEvents() {
    const globalGroup = createComponentGroup('global');

    // 设置变更事件监听
    globalGroup.add(window, 'settingsChanged', (event) => {
        const { aiEnabled, passwordEnabled, aiSettings } = event.detail;

        // 更新state
        state.update('aiEnabled', aiEnabled);
        state.update('passwordEnabled', passwordEnabled);

        // 如果AI设置变更，可能需要更新UI
        if (aiSettings) {
            // 可以在这里添加其他需要响应AI设置变更的逻辑
        }

        // 如果密码设置变更，可能需要更新认证状态
        if (passwordEnabled !== state.passwordEnabled) {
            // 可以在这里添加其他需要响应密码设置变更的逻辑
        }
    });

    // 全局键盘事件
    globalGroup.add(document, 'keydown', (e) => {
        // 模态框内的键盘操作
        if (!safeClassList(elements.modal, 'contains', 'opacity-0')) {
            if (e.key === 'Escape') {
                if (window.location.hash.endsWith('#modal')) window.history.back();
            }
            else if (e.key === 'ArrowLeft') { navigateModal('prev'); }
            else if (e.key === 'ArrowRight') { navigateModal('next'); }
        }

        // 全局快捷键（排除输入框）
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        switch (e.key.toLowerCase()) {
            case 'b':
                // B键切换模糊模式
                toggleMediaBlur();
                break;
            case 'f':
                // F键全屏模式
                if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen().catch(err => {
                        listenersLogger.debug('全屏模式失败', err);
                    });
                } else {
                    document.exitFullscreen();
                }
                break;
            case 's':
                // S键聚焦搜索框
                e.preventDefault();
                elements.searchInput.focus();
                elements.searchInput.select();
                break;
            case 'r':
                // R键刷新当前页面
                e.preventDefault();
                window.location.reload();
                break;
            case 'h':
                // H键返回首页
                e.preventDefault();
                window.location.hash = '#/';
                break;
            case 'g':
                // G键切换视图（网格/瀑布流）
                e.preventDefault();
                try {
                    const current = state.layoutMode;
                    const next = current === 'grid' ? 'masonry' : 'grid';
                    state.update('layoutMode', next);
                    try { localStorage.setItem('sg_layout_mode', next); } catch {}
                    listenersLogger.debug(`布局模式切换: ${current} → ${next}`);
                } catch (error) {
                    listenersLogger.error('切换布局模式出错', error);
                }
                break;
            case 'escape':
                // ESC键关闭模态框或返回
                if (window.location.hash.includes('search?q=')) {
                    window.location.hash = state.preSearchHash || '#/';
                }
                break;
        }

        // 数字键快速导航（1-9）
        if (/^[1-9]$/.test(e.key)) {
            const index = parseInt(e.key) - 1;
            const photoLinks = document.querySelectorAll('.photo-link');
            if (photoLinks[index]) {
                photoLinks[index].click();
            }
        }
    });

    // 三指点击快速切换模糊模式
    globalGroup.add(document, 'touchstart', (e) => {
        // 确保是三指触摸
        if (e.touches.length === 3) {
            // 阻止默认行为，例如页面缩放
            e.preventDefault();

            // 切换模糊模式状态
            toggleMediaBlur();
        }
    }, { passive: false });

    globalGroup.activate();
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

    // 创建页面特定的时间组
    const pageGroup = createPageGroup(pageType);

    // 设置页面特定的滚动事件
    if (pageType === 'browse') {
        pageGroup.add(window, 'scroll', handleBrowseScroll, { passive: true });
    } else if (pageType === 'search') {
        pageGroup.add(window, 'scroll', handleSearchScroll, { passive: true });
    }

    // 设置窗口大小变化事件（所有页面都需要）
    let resizeTimeout;
    pageGroup.add(window, 'resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const newColumnCount = getMasonryColumns();
            const containerWidth = safeGetElementById('content-grid')?.clientWidth || 0;
            const changedCols = newColumnCount !== state.currentColumnCount;
            const changedWidth = Math.abs(containerWidth - (state.currentLayoutWidth || 0)) > 1;
            if ((changedCols || changedWidth) && safeClassList(elements.contentGrid, 'contains', 'masonry-mode')) {
                state.currentColumnCount = newColumnCount;
                state.currentLayoutWidth = containerWidth;
                applyMasonryLayout();
            }
            // 尝试根据最新容器与视口尺寸，刷新骨架屏高度，消除留白
            const skeletonGrid = safeGetElementById('skeleton-grid');
            if (skeletonGrid) {
                safeLoadSkeletonGrid();
            }
        }, 60);
    });

    pageGroup.activate();
}

/**
 * 设置所有事件监听器
 * 包括点击、搜索、键盘、滚动、触摸等事件
 */
export function setupEventListeners() {
    // 清理之前的页面组
    if (currentPageGroup) {
        cleanupPage(currentPageGroup);
    }

    // 设置全局事件（在所有页面都需要的）
    setupGlobalEvents();

    // 设置当前页面的特定事件
    setupCurrentPageEvents();

    // 顶栏滚动方向显示/隐藏 + 移动端搜索开关
    (function setupTopbarInteractions() {
        const topbarGroup = createComponentGroup('topbar');
        const topbar = safeGetElementById('topbar');
        const searchToggleBtn = safeGetElementById('search-toggle-btn'); // 旧按钮可能不存在
        const commandSearchBtn = safeGetElementById('command-search-btn'); // 旧按钮已移除，如不存在不影响
        const mobileSearchBtn = safeGetElementById('mobile-search-btn');
        const mobileSearchBackBtn = safeGetElementById('mobile-search-back-btn');
        const searchSubmitBtn = safeGetElementById('search-submit-btn');
        const searchInput = safeGetElementById('search-input');
        const searchContainer = searchInput ? searchInput.closest('.search-container') : null;
        if (!topbar) return;

        let lastScrollY = window.scrollY;
        let ticking = false;

        function onScroll() {
            const currentY = window.scrollY;
            const delta = currentY - lastScrollY;
            const isScrollingDown = delta > 0;

            // 当滚动到顶部附近时，强制显示topbar
            if (currentY < 50) {
                safeClassList(topbar, 'remove', 'topbar--hidden');
                safeClassList(topbar, 'remove', 'topbar--condensed');
            } else {
                // 向下滚动且超过阈值时隐藏topbar
                if (isScrollingDown && currentY > UI.SCROLL_THRESHOLD_DOWN) {
                    safeClassList(topbar, 'add', 'topbar--hidden');
                    safeClassList(topbar, 'add', 'topbar--condensed'); // B 方案：折叠上下文层
                }
                // 向上滚动时显示topbar（移除小幅滚动阈值限制）
                else if (!isScrollingDown) {
                    safeClassList(topbar, 'remove', 'topbar--hidden');
                    safeClassList(topbar, 'remove', 'topbar--condensed');
                }
            }
            // 始终更新 lastScrollY，确保滚动检测准确
            lastScrollY = currentY;
        }

        // 根据上下文层的显隐动态调整顶部内边距，避免遮挡
        let lastTopbarOffset = 0;
        function updateBackToTopButton() {
            const backToTopBtn = safeGetElementById('back-to-top-btn');
            if (backToTopBtn) {
                if (window.scrollY > 400) {
                    safeClassList(backToTopBtn, 'add', 'visible');
                } else {
                    safeClassList(backToTopBtn, 'remove', 'visible');
                }
            }
        }

        function updateTopbarOffset() {
            const appContainer = safeGetElementById('app-container');
            if (!appContainer) return;
            // 常驻层高度 + （上下文层高度，折叠时为 0）
            const persistentHeight = topbar.querySelector('.topbar-inner')?.offsetHeight || 56;
            const contextEl = safeGetElementById('topbar-context');
            const contextHeight = (contextEl && !safeClassList(topbar, 'contains', 'topbar--condensed')) ? contextEl.offsetHeight : 0;
            const total = persistentHeight + contextHeight + 16; // 额外留白 16px
            
            // 只在值真正变化时才更新样式，避免触发不必要的重排
            if (Math.abs(total - lastTopbarOffset) >= 1) {
                lastTopbarOffset = total;
                safeSetStyle(appContainer, '--topbar-offset', `${total}px`);
            }
        }

        // 首次与每次滚动后都更新一次（更稳健：load/resize/scroll + 观察尺寸变化）
        const contextEl = safeGetElementById('topbar-context');
        updateTopbarOffset();
        // 双 rAF 与延时，确保字体与布局完成后再校准
        requestAnimationFrame(() => requestAnimationFrame(updateTopbarOffset));
        setTimeout(updateTopbarOffset, 120);
        setTimeout(updateTopbarOffset, 360);
        topbarGroup.add(window, 'load', updateTopbarOffset);
        topbarGroup.add(window, 'resize', () => { updateTopbarOffset(); });
        // 合并滚动事件监听器，避免冲突
        topbarGroup.add(window, 'scroll', () => {
            if (!ticking) {
                requestAnimationFrame(() => {
                    onScroll();
                    updateTopbarOffset();
                    updateBackToTopButton();
                    ticking = false;
                });
                ticking = true;
            }
        }, { passive: true });
        
        // 监听尺寸变化 - 添加防抖避免循环
        if (window.ResizeObserver) {
            let topbarResizeTimeout;
            const ro = new ResizeObserver(() => {
                clearTimeout(topbarResizeTimeout);
                topbarResizeTimeout = setTimeout(() => {
                    updateTopbarOffset();
                }, 16); // 一帧的时间
            });
            ro.observe(topbar);
            if (contextEl) ro.observe(contextEl);
        }


        // 移动端搜索开关
        if (searchToggleBtn) {
            topbarGroup.add(searchToggleBtn, 'click', (e) => {
                e.stopPropagation();
                safeClassList(topbar, 'toggle', 'topbar--search-open');
                // 打开时聚焦
                if (safeClassList(topbar, 'contains', 'topbar--search-open') && searchInput) {
                    setTimeout(() => { searchInput.focus(); }, 0);
                }
            });
        }

        // 命令面板式搜索
        function openCommandSearch() {
            // 若使用命令面板可替换为弹层；当前实现为直接聚焦顶部搜索框（保留历史能力）
            if (searchInput) {
                // Inline 模式下不启用悬浮覆盖态，避免样式冲突
                if (!safeClassList(topbar, 'contains', 'topbar--inline-search')) {
                    safeClassList(topbar, 'add', 'topbar--search-open');
                }
                // 仅在桌面端自动聚焦；移动端等待用户真正点入输入框时再弹键盘
                const isMobile = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
                if (!isMobile) {
                    setTimeout(() => {
                        searchInput.focus();
                        searchInput.select?.();
                    }, 0);
                }
            }
        }
        if (commandSearchBtn) topbarGroup.add(commandSearchBtn, 'click', (e) => { e.stopPropagation(); openCommandSearch(); });
        if (mobileSearchBtn) topbarGroup.add(mobileSearchBtn, 'click', (e) => {
            e.stopPropagation();
            // 使用"行内替换"方案，避免悬浮层在某些宽度下留白
            safeClassList(topbar, 'add', 'topbar--inline-search');
            openCommandSearch();
        });
        if (mobileSearchBackBtn) topbarGroup.add(mobileSearchBackBtn, 'click', () => {
            safeClassList(topbar, 'remove', 'topbar--search-open');
            safeClassList(topbar, 'remove', 'topbar--inline-search');
            if (searchContainer) searchContainer.removeAttribute('style');
            if (searchInput) searchInput.blur();
        });
        if (searchSubmitBtn) {
            topbarGroup.add(searchSubmitBtn, 'click', (e) => {
                e.preventDefault();
                // 触发与输入一致的导航逻辑
                if (!searchInput) return;
                const q = (searchInput.value || '').trim();
                if (q) {
                    window.location.hash = `/search?q=${encodeURIComponent(q)}`;
                }
            });
        }

        // 统一处理document点击事件
        topbarGroup.add(document, 'click', handleDocumentClick);

        // 激活顶栏事件组
        topbarGroup.activate();
    })();
    // 内容网格点击事件处理
    const contentGroup = createComponentGroup('content');
    contentGroup.add(elements.contentGrid, 'click', (e) => {
        const albumLink = e.target.closest('.album-link');
        const photoLink = e.target.closest('.photo-link');

        if (albumLink) {
            // 相册链接点击
            e.preventDefault();
            const path = albumLink.dataset.path;
            _navigateToAlbum(e, path);
        } else if (photoLink) {
            // 图片/视频点击
            e.preventDefault();
            const url = photoLink.dataset.url;
            const index = parseInt(photoLink.dataset.index, 10);
            _handleThumbnailClick(photoLink, url, index);
        }
    });

    // 激活内容事件组
    contentGroup.activate();
    
    // 搜索输入框事件处理
    const searchGroup = createComponentGroup('search');
    if (elements.searchInput) {
        // 搜索历史容器
        const searchHistoryContainer = safeGetElementById('search-history');
        
        // 异步加载搜索历史功能
        let searchHistoryModule = null;
        import('./search-history.js').then(module => {
            searchHistoryModule = module;
        }).catch(error => {
            listenersLogger.warn('搜索历史模块加载失败，将在需要时重试', error);
            // 搜索历史是非关键功能，失败时静默处理
        });
        
        searchGroup.add(elements.searchInput, 'input', (e) => {
            clearTimeout(state.searchDebounceTimer);
            const query = e.target.value;
            
            // 如果输入框为空，显示搜索历史
            if (!query.trim()) {
                if (searchHistoryModule) {
                    searchHistoryModule.showSearchHistory(elements.searchInput, searchHistoryContainer);
                }
                return;
            }
            
            // 隐藏搜索历史
            if (searchHistoryModule) {
                searchHistoryModule.hideSearchHistory(searchHistoryContainer);
            }
            
            // 防抖处理：800ms后执行搜索；触发时再次读取输入框当前值，避免跳到旧值
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
                    // 清空搜索时返回之前的页面
                    window.location.hash = state.preSearchHash || '#/';
                }
            }, 800);
        });
        
        // 搜索框获得焦点时显示历史
        searchGroup.add(elements.searchInput, 'focus', () => {
            if (!elements.searchInput.value.trim() && searchHistoryModule) {
                searchHistoryModule.showSearchHistory(elements.searchInput, searchHistoryContainer);
            }
        });

        // 搜索历史隐藏逻辑已移至统一的handleDocumentClick函数

        // 激活搜索事件组
        searchGroup.activate();
    }

    // 模态框相关事件处理
    const modalGroup = createComponentGroup('modal');

    // 浏览器前进后退事件处理
    modalGroup.add(window, 'popstate', (event) => {
        if (!window.location.hash.endsWith('#modal') && !safeClassList(elements.modal, 'contains', 'opacity-0')) {
            closeModal();
        }
    });

    // 模态框关闭按钮事件
    modalGroup.add(elements.modalClose, 'click', () => {
        if (window.location.hash.endsWith('#modal')) {
            window.history.back();
        }
    });

    // 模态框背景点击关闭（触控防误触）
    let touchMoved = false;
    modalGroup.add(elements.mediaPanel, 'touchstart', () => { touchMoved = false; }, { passive: true });
    modalGroup.add(elements.mediaPanel, 'touchmove', () => { touchMoved = true; }, { passive: true });
    modalGroup.add(elements.mediaPanel, 'click', (e) => {
        if (e.target === elements.mediaPanel && window.location.hash.endsWith('#modal') && !touchMoved) {
            window.history.back();
        }
    });
    
    // AI标题气泡切换
    modalGroup.add(elements.toggleCaptionBtn, 'click', (e) => {
        e.stopPropagation();
        safeClassList(elements.captionBubble, 'toggle', 'show');
    });

    // 点击外部关闭AI标题气泡
    modalGroup.add(document, 'click', (e) => {
        if (safeClassList(elements.captionBubble, 'contains', 'show') && !elements.captionBubble.contains(e.target) && !elements.toggleCaptionBtn.contains(e.target)) {
            safeClassList(elements.captionBubble, 'remove', 'show');
        }
    });

    // 模态框滚轮导航（桌面端）
    modalGroup.add(elements.modal, 'wheel', (e) => {
        if (window.innerWidth <= 768) return;  // 移动端禁用
        const now = Date.now();
        if (now - state.lastWheelTime < 300) return;  // 防抖处理
        state.lastWheelTime = now;
        if (e.deltaY < 0) navigateModal('prev'); else navigateModal('next');
    }, { passive: true });
    
    // 触摸滑动处理 - 支持"滑动后不放"快速翻页
    const swipeHandler = new SwipeHandler(elements.mediaPanel, {
        shouldAllowSwipe: () => {
            const isImage = !safeClassList(elements.modalImg, 'contains', 'hidden');
            const zoomed = elements.mediaPanel?.dataset?.isZoomed === '1';
            return !(isImage && zoomed);
        },
        onSwipe: (direction) => {
            if (safeClassList(elements.modal, 'contains', 'opacity-0')) return;
            // 向左滑动 -> 下一张
            if (direction === 'left') {
                navigateModal('next');
            } 
            // 向右滑动 -> 上一张
            else if (direction === 'right') {
                navigateModal('prev');
            }
        },
        onFastSwipe: (direction) => {
            if (safeClassList(elements.modal, 'contains', 'opacity-0')) return;
            // 快速滑动方向映射：向右滑动 -> 上一张，向左滑动 -> 下一张
            if (direction === 'right') {
                startFastNavigate('prev');
            } else if (direction === 'left') {
                startFastNavigate('next');
            }
        }
    });

    // 【新增】在 touchend 事件时，我们必须停止快速导航
    modalGroup.add(elements.mediaPanel, 'touchend', () => {
        stopFastNavigate();
        // 恢复 SwipeHandler 的内部状态，确保下次滑动正常
        if (swipeHandler) {
            swipeHandler.resetState();
            swipeHandler.resetCoordinates();
        }
    });


    // 激活模态框事件组
    modalGroup.activate();

    // 窗口大小变化处理 + 容器尺寸变化监听（避免仅滚动触发才更新的情况）
    let resizeTimeout;
    function reflowIfNeeded() {
        const newColumnCount = getMasonryColumns();
        const containerWidth = safeGetElementById('content-grid')?.clientWidth || 0;
        const changedCols = newColumnCount !== state.currentColumnCount;
        const changedWidth = Math.abs(containerWidth - (state.currentLayoutWidth || 0)) > 1;
        if ((changedCols || changedWidth) && safeClassList(elements.contentGrid, 'contains', 'masonry-mode')) {
            state.currentColumnCount = newColumnCount;
            state.currentLayoutWidth = containerWidth;
            applyMasonryLayout();
        }
    }
    // resize监听器已统一在第418行处理
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
        const grid = safeGetElementById('content-grid');
        if (grid) ro.observe(grid);
        const pageInner = safeGetElementById('page-inner');
        if (pageInner) ro.observe(pageInner);
    }

    // 其他UI组件事件
    const uiGroup = createComponentGroup('ui');

    // 回到顶部按钮
    const backToTopBtn = safeGetElementById('back-to-top-btn');
    if (backToTopBtn) {
        // 滚动处理已统一在第458行的scroll监听器中

        // 点击回到顶部
        uiGroup.add(backToTopBtn, 'click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    // 设置按钮 - 使用动态导入实现按需加载
    const settingsBtn = safeGetElementById('settings-btn');
    if(settingsBtn) {
        uiGroup.add(settingsBtn, 'click', async () => {
            try {
                showSettingsModal();
            } catch (error) {
                listenersLogger.error('加载设置模块失败', error);
                alert('加载设置页面失败，请刷新页面重试');
            }
        });
    }

    // 激活UI事件组
    uiGroup.activate();
}