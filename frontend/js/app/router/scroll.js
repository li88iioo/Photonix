/**
 * @file router/scroll.js
 * @description 滚动位置管理与页面内容准备
 */

import { state } from '../../core/state.js';
import { elements } from '../../shared/dom-elements.js';
import { safeSetInnerHTML } from '../../shared/dom-utils.js';
import { showMinimalLoader } from '../../features/gallery/loading-states.js';
import { setManagedTimeout } from '../../core/timer-manager.js';
import { setupLazyLoading, restorePageLazyState } from '../../features/gallery/lazyload.js';
import { applyMasonryLayout, getMasonryColumns } from '../../features/gallery/masonry.js';
import { routerLogger } from '../../core/logger.js';
import { getPathOnlyFromHash } from './utils.js';

/**
 * 准备新内容渲染，清理旧页面与状态，并处理loading效果。
 * @param {Object} [navigation] - 导航上下文对象
 * @returns {Promise<{ cancelSkeleton():void }>} 控制对象
 */
export function prepareForNewContent(navigation = null) {
    return new Promise(resolve => {

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
        if (navigation && navigation.pathOnly) {
            const targetPath = navigation.pathOnly;
            const previousPath = navigation.previousPath;
            const pathChanged = !previousPath || targetPath !== previousPath;

            if (pathChanged) {
                // 判断是否是返回上级目录
                const isGoingBack = previousPath && previousPath.startsWith(`${targetPath}/`);

                // 只有前进到新页面时才清除，返回上级时保留
                if (!isGoingBack) {
                    const newScrollPositions = new Map(state.scrollPositions);
                    newScrollPositions.delete(targetPath);
                    state.scrollPositions = newScrollPositions;
                }
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
                    const loader = document.getElementById('minimal-loader');
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
            elements.contentGrid.style.height = 'auto';
            // 隐藏加载器
            if (elements.infiniteScrollLoader) {
                elements.infiniteScrollLoader?.classList.remove('visible');
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
export function finalizeNewContent(pathKey) {
    if (!state.virtualScroller) {
        setupLazyLoading();
        const stateRestored = restorePageLazyState(pathKey);
        if (!stateRestored && elements.contentGrid?.classList.contains('masonry-mode')) {
            // 延迟执行瀑布流布局，确保图片容器已正确渲染
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    applyMasonryLayout();
                });
            });
        }
    }
    state.update('currentColumnCount', getMasonryColumns());
    preloadVisibleImages();
    elements.contentGrid.style.minHeight = '';
    state.update('isInitialLoad', false);
}

/**
 * 预加载首屏与可视区域图片，加速首屏体验与布局稳定性。
 */
export function preloadVisibleImages() {
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
        import('../../features/gallery/lazyload.js').then(lazyloadModule => {
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
export function saveCurrentScrollPosition() {
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
        } catch { }
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
