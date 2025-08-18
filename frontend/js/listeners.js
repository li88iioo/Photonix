// frontend/js/listeners.js

import { state, elements } from './state.js';
import { applyMasonryLayout, getMasonryColumns, applyMasonryLayoutIncremental } from './masonry.js';
import { closeModal, navigateModal, _handleThumbnailClick, _navigateToAlbum, startFastNavigate, stopFastNavigate } from './modal.js';
import { SwipeHandler } from './touch.js';
import { fetchBrowseResults, fetchSearchResults } from './api.js';
import { renderBrowseGrid, renderSearchGrid } from './ui.js';
import { AbortBus } from './abort-bus.js';
import { setupLazyLoading } from './lazyload.js';

/**
 * 事件监听器管理模块
 * 负责处理所有用户交互事件，包括滚动、点击、键盘、触摸等
 */

// 在文件开头添加设置变更事件监听
window.addEventListener('settingsChanged', (event) => {
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

/**
 * 移除滚动监听器
 * 在路由切换时清理滚动事件监听
 */
export function removeScrollListeners() {
    window.removeEventListener('scroll', handleBrowseScroll);
    window.removeEventListener('scroll', handleSearchScroll);
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

/**
 * 通用滚动处理函数
 * 实现无限滚动加载功能
 * @param {string} type - 滚动类型 ('browse' 或 'search')
 */
async function handleScroll(type) {
    // 获取对应类型的状态
    const isLoading = type === 'browse' ? state.isBrowseLoading : state.isSearchLoading;
    const currentPage = type === 'browse' ? state.currentBrowsePage : state.currentSearchPage;
    const totalPages = type === 'browse' ? state.totalBrowsePages : state.totalSearchPages;

    // 如果当前为空态/连接态/错误态/骨架屏，则不触发无限滚动
    const grid = document.getElementById('content-grid');
    if (grid) {
        const firstChild = grid.firstElementChild;
        const isBlockedState = firstChild && (
            firstChild.classList.contains('empty-state') ||
            firstChild.classList.contains('connecting-container') ||
            firstChild.classList.contains('error-container') ||
            firstChild.id === 'skeleton-grid'
        );
        if (isBlockedState) {
            if (elements.infiniteScrollLoader) elements.infiniteScrollLoader.classList.add('hidden');
            return;
        }
    }

    // 如果正在加载或已到最后一页，则跳过
    if (isLoading || currentPage > totalPages) return;

    // 检查是否接近页面底部（距离底部500px时触发加载）
    if ((window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight - 500) {
        // 设置加载状态
        if (type === 'browse') state.isBrowseLoading = true;
        else state.isSearchLoading = true;

        elements.infiniteScrollLoader.classList.remove('hidden');
        
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
                 elements.infiniteScrollLoader.classList.add('hidden');
                 return;
            };

            // 更新总页数
            if (type === 'browse') state.totalBrowsePages = data.totalPages;
            else state.totalSearchPages = data.totalPages;

            // 渲染新内容
            const prevCount = elements.contentGrid.children.length;
            const { contentElements, newMediaUrls } = type === 'browse' 
                ? renderBrowseGrid(items, state.currentPhotos.length)
                : renderSearchGrid(items, state.currentPhotos.length);
            
            elements.contentGrid.append(...contentElements);
            state.currentPhotos = state.currentPhotos.concat(newMediaUrls);

            // 更新页码
            if (type === 'browse') state.currentBrowsePage++;
            else state.currentSearchPage++;
            
            // 设置懒加载和瀑布流布局
            setupLazyLoading();
            const newItems = Array.from(elements.contentGrid.children).slice(prevCount);
            applyMasonryLayoutIncremental(newItems);
        } catch (error) {
            if (error.name !== 'AbortError') console.error("Failed to fetch more items:", error);
        } finally {
             if (type === 'browse') state.isBrowseLoading = false;
             else state.isSearchLoading = false;
            elements.infiniteScrollLoader.classList.add('hidden');
        }
    }
}

/**
 * 设置所有事件监听器
 * 包括点击、搜索、键盘、滚动、触摸等事件
 */
export function setupEventListeners() {
    // 顶栏滚动方向显示/隐藏 + 移动端搜索开关
    (function setupTopbarInteractions() {
        const topbar = document.getElementById('topbar');
        const searchToggleBtn = document.getElementById('search-toggle-btn'); // 旧按钮可能不存在
        const commandSearchBtn = document.getElementById('command-search-btn'); // 旧按钮已移除，如不存在不影响
        const mobileSearchBtn = document.getElementById('mobile-search-btn');
        const mobileSearchBackBtn = document.getElementById('mobile-search-back-btn');
        const searchSubmitBtn = document.getElementById('search-submit-btn');
        const searchInput = document.getElementById('search-input');
        const searchContainer = searchInput ? searchInput.closest('.search-container') : null;
        if (!topbar) return;

        let lastScrollY = window.scrollY;
        let ticking = false;

        function onScroll() {
            const currentY = window.scrollY;
            const delta = currentY - lastScrollY;
            const isScrollingDown = delta > 0;
            const threshold = 8; // 小幅滚动不触发

            if (Math.abs(delta) > threshold) {
                if (isScrollingDown) {
                    topbar.classList.add('topbar--hidden');
                    topbar.classList.add('topbar--condensed'); // B 方案：折叠上下文层
                } else {
                    topbar.classList.remove('topbar--hidden');
                    topbar.classList.remove('topbar--condensed');
                }
                lastScrollY = currentY;
            }
            ticking = false;
        }

        // 根据上下文层的显隐动态调整顶部内边距，避免遮挡
        function updateTopbarOffset() {
            const appContainer = document.getElementById('app-container');
            if (!appContainer) return;
            // 常驻层高度 + （上下文层高度，折叠时为 0）
            const persistentHeight = topbar.querySelector('.topbar-inner')?.offsetHeight || 56;
            const contextEl = document.getElementById('topbar-context');
            const contextHeight = (contextEl && !topbar.classList.contains('topbar--condensed')) ? contextEl.offsetHeight : 0;
            const total = persistentHeight + contextHeight + 16; // 额外留白 16px
            appContainer.style.setProperty('--topbar-offset', `${total}px`);
        }

        // 首次与每次滚动后都更新一次（更稳健：load/resize/scroll + 观察尺寸变化）
        const contextEl = document.getElementById('topbar-context');
        updateTopbarOffset();
        // 双 rAF 与延时，确保字体与布局完成后再校准
        requestAnimationFrame(() => requestAnimationFrame(updateTopbarOffset));
        setTimeout(updateTopbarOffset, 120);
        setTimeout(updateTopbarOffset, 360);
        window.addEventListener('load', updateTopbarOffset);
        window.addEventListener('resize', () => { updateTopbarOffset(); });
        window.addEventListener('scroll', () => { if (!ticking) requestAnimationFrame(updateTopbarOffset); }, { passive: true });
        // 监听尺寸变化
        if (window.ResizeObserver) {
            const ro = new ResizeObserver(() => updateTopbarOffset());
            ro.observe(topbar);
            if (contextEl) ro.observe(contextEl);
        }

        window.addEventListener('scroll', () => {
            if (!ticking) {
                window.requestAnimationFrame(onScroll);
                ticking = true;
            }
        }, { passive: true });

        // 移动端搜索开关
        if (searchToggleBtn) {
            searchToggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                topbar.classList.toggle('topbar--search-open');
                // 打开时聚焦
                if (topbar.classList.contains('topbar--search-open') && searchInput) {
                    setTimeout(() => { searchInput.focus(); }, 0);
                }
            });
        }

        // 命令面板式搜索
        function openCommandSearch() {
            // 若使用命令面板可替换为弹层；当前实现为直接聚焦顶部搜索框（保留历史能力）
            if (searchInput) {
                // Inline 模式下不启用悬浮覆盖态，避免样式冲突
                if (!topbar.classList.contains('topbar--inline-search')) {
                    topbar.classList.add('topbar--search-open');
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
        if (commandSearchBtn) commandSearchBtn.addEventListener('click', (e) => { e.stopPropagation(); openCommandSearch(); });
        if (mobileSearchBtn) mobileSearchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // 使用“行内替换”方案，避免悬浮层在某些宽度下留白
            topbar.classList.add('topbar--inline-search');
            openCommandSearch();
        });
        if (mobileSearchBackBtn) mobileSearchBackBtn.addEventListener('click', () => {
            topbar.classList.remove('topbar--search-open');
            topbar.classList.remove('topbar--inline-search');
            if (searchContainer) searchContainer.removeAttribute('style');
            if (searchInput) searchInput.blur();
        });
        if (searchSubmitBtn) {
            searchSubmitBtn.addEventListener('click', (e) => {
                e.preventDefault();
                // 触发与输入一致的导航逻辑
                if (!searchInput) return;
                const q = (searchInput.value || '').trim();
                if (q) {
                    window.location.hash = `/search?q=${encodeURIComponent(q)}`;
                }
            });
        }

        // 点击外部关闭移动端搜索层
        document.addEventListener('click', (e) => {
            if (topbar.classList.contains('topbar--search-open')) {
                const isInsideSearch = e.target.closest && e.target.closest('.search-container');
                const isToggle = e.target.closest && e.target.closest('#search-toggle-btn');
                if (!isInsideSearch && !isToggle) {
                    topbar.classList.remove('topbar--search-open');
                }
            }
        });
    })();
    // 内容网格点击事件处理
    elements.contentGrid.addEventListener('click', (e) => {
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
    
    // 搜索输入框事件处理
    if (elements.searchInput) {
        // 搜索历史容器
        const searchHistoryContainer = document.getElementById('search-history');
        
        // 异步加载搜索历史功能
        let searchHistoryModule = null;
        import('./search-history.js').then(module => {
            searchHistoryModule = module;
        });
        
        elements.searchInput.addEventListener('input', (e) => {
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
        elements.searchInput.addEventListener('focus', () => {
            if (!elements.searchInput.value.trim() && searchHistoryModule) {
                searchHistoryModule.showSearchHistory(elements.searchInput, searchHistoryContainer);
            }
        });
        
        // 点击外部隐藏搜索历史
        document.addEventListener('click', (e) => {
            if (!elements.searchInput.contains(e.target) && !searchHistoryContainer.contains(e.target)) {
                if (searchHistoryModule) {
                    searchHistoryModule.hideSearchHistory(searchHistoryContainer);
                }
            }
        });
    }

    // 浏览器前进后退事件处理
    window.addEventListener('popstate', (event) => {
        if (!window.location.hash.endsWith('#modal') && !elements.modal.classList.contains('opacity-0')) {
            closeModal();
        }
    });
    
    // 模态框关闭按钮事件
    elements.modalClose.addEventListener('click', () => {
        if (window.location.hash.endsWith('#modal')) {
            window.history.back();
        }
    });
    
    // 模态框背景点击关闭（触控防误触）
    let touchMoved = false;
    elements.mediaPanel.addEventListener('touchstart', () => { touchMoved = false; }, { passive: true });
    elements.mediaPanel.addEventListener('touchmove', () => { touchMoved = true; }, { passive: true });
    elements.mediaPanel.addEventListener('click', (e) => {
        if (e.target === elements.mediaPanel && window.location.hash.endsWith('#modal') && !touchMoved) {
            window.history.back();
        }
    });
    
    // AI标题气泡切换
    elements.toggleCaptionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        elements.captionBubble.classList.toggle('show');
    });
    
    // 点击外部关闭AI标题气泡
    document.addEventListener('click', (e) => {
        if (elements.captionBubble.classList.contains('show') && !elements.captionBubble.contains(e.target) && !elements.toggleCaptionBtn.contains(e.target)) {
            elements.captionBubble.classList.remove('show');
        }
    });

    // 键盘事件处理
    document.addEventListener('keydown', (e) => {
        // 模态框内的键盘操作
        if (!elements.modal.classList.contains('opacity-0')) {
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
                state.isBlurredMode = !state.isBlurredMode;
                document.querySelectorAll('.lazy-image, #modal-img, .lazy-video, #modal-video').forEach(media => {
                    media.classList.toggle('blurred', state.isBlurredMode);
                });
                break;
            case 'f':
                // F键全屏模式
                if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen().catch(err => {
                        console.log('全屏模式失败:', err);
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

    // 模态框滚轮导航（桌面端）
    elements.modal.addEventListener('wheel', (e) => {
        if (window.innerWidth <= 768) return;  // 移动端禁用
        const now = Date.now();
        if (now - state.lastWheelTime < 300) return;  // 防抖处理
        state.lastWheelTime = now;
        if (e.deltaY < 0) navigateModal('prev'); else navigateModal('next');
    }, { passive: true });
    
    // 触摸滑动处理 - 支持"滑动后不放"快速翻页
    const swipeHandler = new SwipeHandler(elements.mediaPanel, {
        onSwipe: (direction) => {
            if (elements.modal.classList.contains('opacity-0')) return;
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
            if (elements.modal.classList.contains('opacity-0')) return;
            // 快速滑动方向映射：向右滑动 -> 上一张，向左滑动 -> 下一张
            if (direction === 'right') {
                startFastNavigate('prev');
            } else if (direction === 'left') {
                startFastNavigate('next');
            }
        }
    });

    // 【新增】在 touchend 事件时，我们必须停止快速导航
    elements.mediaPanel.addEventListener('touchend', () => {
        stopFastNavigate();
        // 恢复 SwipeHandler 的内部状态，确保下次滑动正常
        if (swipeHandler) {
            swipeHandler.resetState();
            swipeHandler.resetCoordinates();
        }
    });

    // =======================================================
    // 【新增代码】三指点击快速切换模糊模式
    // =======================================================
    document.addEventListener('touchstart', (e) => {
        // 确保是三指触摸
        if (e.touches.length === 3) {
            // 阻止默认行为，例如页面缩放
            e.preventDefault();

            // 切换模糊模式状态
            state.isBlurredMode = !state.isBlurredMode;

            // 应用或移除模糊样式
            document.querySelectorAll('.lazy-image, #modal-img, .lazy-video, #modal-video').forEach(media => {
                media.classList.toggle('blurred', state.isBlurredMode);
            });
        }
    }, { passive: false }); // 需要设置 passive: false 来调用 preventDefault

    // 窗口大小变化处理 + 容器尺寸变化监听（避免仅滚动触发才更新的情况）
    let resizeTimeout;
    function reflowIfNeeded() {
        const newColumnCount = getMasonryColumns();
        const containerWidth = document.getElementById('content-grid')?.clientWidth || 0;
        const changedCols = newColumnCount !== state.currentColumnCount;
        const changedWidth = Math.abs(containerWidth - (state.currentLayoutWidth || 0)) > 1;
        if (changedCols || changedWidth) {
            state.currentColumnCount = newColumnCount;
            state.currentLayoutWidth = containerWidth;
            applyMasonryLayout();
        }
    }
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            reflowIfNeeded();
            // 尝试根据最新容器与视口尺寸，刷新骨架屏高度，消除留白
            const skeletonGrid = document.getElementById('skeleton-grid');
            if (skeletonGrid) {
                import('./loading-states.js').then(m => m.showSkeletonGrid()).catch(() => {});
            }
        }, 60); // 更灵敏的防抖
    });
    // 监听主容器 Resize，处理浏览器 UI 缩放或滚动条出现/消失带来的布局宽度变化
    if (window.ResizeObserver) {
        let ticking = false;
        const ro = new ResizeObserver(() => {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => { reflowIfNeeded(); ticking = false; });
        });
        const grid = document.getElementById('content-grid');
        if (grid) ro.observe(grid);
        const pageInner = document.getElementById('page-inner');
        if (pageInner) ro.observe(pageInner);
    }

    // 回到顶部按钮
    const backToTopBtn = document.getElementById('back-to-top-btn');
    if (backToTopBtn) {
        // 滚动时显示/隐藏按钮
        window.addEventListener('scroll', () => {
            if (window.scrollY > 400) {
                backToTopBtn.classList.add('visible');
            } else {
                backToTopBtn.classList.remove('visible');
            }
        }, { passive: true });
        
        // 点击回到顶部
        backToTopBtn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    // 设置按钮 - 使用动态导入实现按需加载
    const settingsBtn = document.getElementById('settings-btn');
    if(settingsBtn) {
        settingsBtn.addEventListener('click', async () => {
            try {
                const settingsModule = await import('./settings.js');
                settingsModule.showSettingsModal();
            } catch (error) {
                console.error('加载设置模块失败:', error);
                // 重试一次，处理 SW 或 404 fallback 导致的瞬时问题
                try {
                    const settingsModule = await import('./settings.js?retry=1');
                    settingsModule.showSettingsModal();
                    return;
                } catch {}
                alert('加载设置页面失败，请刷新页面重试');
            }
        });
    }
}