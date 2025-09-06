// frontend/js/masonry.js

import { elements } from './ui.js';

// 动态导入懒加载模块以避免循环依赖
let lazyloadModule = null;
const getLazyloadModule = async () => {
    if (!lazyloadModule) {
        lazyloadModule = await import('./lazyload.js');
    }
    return lazyloadModule;
};

// 引用懒加载模块中的全局观察器
let globalImageObserverRef = null;

/**
 * 瀑布流布局管理模块
 * 负责处理图片网格的瀑布流布局、响应式列数和动态布局更新
 * 集成虚拟滚动以提升大量图片时的性能
 */

/**
 * 根据窗口宽度获取瀑布流列数
 * - 增强大屏体验：在 1080p/2K/4K 下提高列数，缩小单卡片尺寸
 * @returns {number} 列数
 */
export function getMasonryColumns() {
    const width = window.innerWidth;

    // 超大屏优先（从大到小判断）
    if (width >= 3840) return 12; // 4K+：12列
    if (width >= 2560) return 10; // 2.5K/2K 宽（2560/3440 等）：10列
    if (width >= 1920) return 8;  // 1080p 及以上：8列

    // 常规断点
    if (width >= 1536) return 6;  // 2xl：6列
    if (width >= 1280) return 5;  // xl：5列
    if (width >= 1024) return 4;  // lg：4列
    if (width >= 768) return 3;   // md：3列
    if (width >= 640) return 2;   // sm：2列
    return 2;                     // 默认（移动端）：2列
}

// 全局记录每列高度，用于瀑布流布局计算
let masonryColumnHeights = [];
// 简单互斥锁，防止并发布局导致的竞态
let isLayingOut = false;
// 合并频繁的布局请求，避免大量图片 onload 触发多次重排
let layoutScheduled = false;
let layoutScheduleTimer = null;

// 虚拟滚动器实例
let virtualScroller = null;

// 虚拟滚动阈值（当项目数量超过此值时启用虚拟滚动）
const VIRTUAL_SCROLL_THRESHOLD = 100;

/**
 * 增量瀑布流布局
 * 只布局新添加的项目，提高性能
 * @param {Array|NodeList} newItems - 新添加的项目数组
 */
export function applyMasonryLayoutIncremental(newItems) {
    const { contentGrid } = elements;
    if (!contentGrid.classList.contains('masonry-mode')) return;
    if (!newItems || newItems.length === 0) return;
    if (isLayingOut) return; // 正在布局时丢弃本次请求，避免重入

    isLayingOut = true;
    try {

        const numColumns = getMasonryColumns();
        const columnGap = 16;  // 列间距

        // 如果是首次加载或列数变化，重置所有列高度并重新布局
        if (!masonryColumnHeights.length || contentGrid.children.length === newItems.length) {
            masonryColumnHeights = Array(numColumns).fill(0);
            
            // 重新布局所有项目
            Array.from(contentGrid.children).forEach(item => {
                const itemWidth = (contentGrid.offsetWidth - (numColumns - 1) * columnGap) / numColumns;
                const minColumnIndex = masonryColumnHeights.indexOf(Math.min(...masonryColumnHeights));
                
                // 设置项目位置和尺寸
                item.style.position = 'absolute';
                item.style.width = `${itemWidth}px`;
                item.style.left = `${minColumnIndex * (itemWidth + columnGap)}px`;
                item.style.top = `${masonryColumnHeights[minColumnIndex]}px`;
                
                // 更新列高度
                const actualItemHeight = getExpectedItemHeight(item, itemWidth);
                item.style.height = `${actualItemHeight}px`;
                masonryColumnHeights[minColumnIndex] += actualItemHeight + columnGap;
            });
        } else {
            // 增量布局：只布局新项目
            newItems.forEach(item => {
                const itemWidth = (contentGrid.offsetWidth - (numColumns - 1) * columnGap) / numColumns;
                const minColumnIndex = masonryColumnHeights.indexOf(Math.min(...masonryColumnHeights));

                // 设置项目位置和尺寸
                item.style.position = 'absolute';
                item.style.width = `${itemWidth}px`;
                item.style.left = `${minColumnIndex * (itemWidth + columnGap)}px`;
                item.style.top = `${masonryColumnHeights[minColumnIndex]}px`;

                // 更新列高度
                const actualItemHeight = getExpectedItemHeight(item, itemWidth);
                item.style.height = `${actualItemHeight}px`;
                masonryColumnHeights[minColumnIndex] += actualItemHeight + columnGap;
            });

            // 在增量布局时也触发可见图片的懒加载（减少频率）
            // 只有在IntersectionObserver可能失效的情况下才使用
            setTimeout(() => {
                if (!document.querySelector('.lazy-image[style*="opacity"]')) {
                    triggerVisibleImagesLazyLoad();
                }
            }, 200);
        }
        
        // 设置容器高度为最高列的高度
        contentGrid.style.height = `${Math.max(...masonryColumnHeights)}px`;
    } finally {
        isLayingOut = false;
    }
}

/**
 * 全量瀑布流布局
 * 用于窗口变化或首次加载时重新布局所有项目
 */
export function applyMasonryLayout() {
    const { contentGrid } = elements;
    if (!contentGrid.classList.contains('masonry-mode')) return;
    if (isLayingOut) return; // 避免重入

    const items = Array.from(contentGrid.children);
    if (items.length === 0) return;

    isLayingOut = true;
    try {
        const numColumns = getMasonryColumns();
        const columnGap = 16;

        // 重置列高度并全量布局
        masonryColumnHeights = Array(numColumns).fill(0);
        items.forEach(item => {
            const itemWidth = (contentGrid.offsetWidth - (numColumns - 1) * columnGap) / numColumns;
            const minColumnIndex = masonryColumnHeights.indexOf(Math.min(...masonryColumnHeights));

            item.style.position = 'absolute';
            item.style.width = `${itemWidth}px`;
            item.style.left = `${minColumnIndex * (itemWidth + columnGap)}px`;
            item.style.top = `${masonryColumnHeights[minColumnIndex]}px`;

            const actualItemHeight = getExpectedItemHeight(item, itemWidth);
            item.style.height = `${actualItemHeight}px`;
            masonryColumnHeights[minColumnIndex] += actualItemHeight + columnGap;
        });

        contentGrid.style.height = `${Math.max(...masonryColumnHeights)}px`;

        // 重要修复：在虚拟滚动模式下触发可见图片的懒加载（优化调用）
        // 延迟执行，避免和IntersectionObserver冲突
        setTimeout(() => {
            const hasVirtualScrollMode = contentGrid.classList.contains('virtual-scroll-mode');
            const hasUnloadedImages = contentGrid.querySelector('.lazy-image:not(.loaded)');

            if (hasVirtualScrollMode && hasUnloadedImages) {
                triggerVisibleImagesLazyLoad();
            }
        }, 300);
    } finally {
        isLayingOut = false;
    }
}

// 合并触发布局，利用 requestAnimationFrame + 最多每80ms一次（进一步节流）
function scheduleApplyMasonryLayout() {
    if (layoutScheduled) return;
    layoutScheduled = true;
    if (layoutScheduleTimer) clearTimeout(layoutScheduleTimer);
    requestAnimationFrame(() => {
        layoutScheduleTimer = setTimeout(() => {
            layoutScheduled = false;
            applyMasonryLayout();
        }, 80);
    });
}

/**
 * 获取元素的准确高度
 * @param {HTMLElement} element - 元素
 * @returns {number} 元素高度
 */
function getElementHeight(element) {
    // 首先尝试获取offsetHeight
    let height = element.offsetHeight;
    
    if (height === 0) {
        // 如果offsetHeight为0，尝试获取计算样式
        const computedStyle = window.getComputedStyle(element);
        height = parseInt(computedStyle.height);
        
        if (isNaN(height) || height === 0) {
            // 如果还是无法获取，使用预估高度
            height = 300;
        }
    }
    
    return height;
}

// 依据 data-width/height 预估高度，避免图片加载前后高度跳动
function getExpectedItemHeight(item, itemWidth) {
    const dw = parseFloat(item.getAttribute('data-width'));
    const dh = parseFloat(item.getAttribute('data-height'));
    if (!Number.isNaN(dw) && !Number.isNaN(dh) && dw > 0 && dh > 0 && itemWidth > 0) {
        return itemWidth * (dh / dw);
    }
    return getElementHeight(item);
}

/**
 * 计算瀑布流布局信息（不修改DOM）
 * 为虚拟滚动提供精确的布局计算
 * @param {HTMLElement} container - 容器元素
 * @param {Array} elements - 要布局的元素数组
 * @returns {Object} 布局信息对象，键为元素索引，值为 { top, left, width, height }
 */
export function calculateMasonryLayout(container, elements) {
    if (!container || !elements || elements.length === 0) {
        return {};
    }
    
    const numColumns = getMasonryColumns();
    const columnGap = 16;  // 列间距
    const containerWidth = container.offsetWidth;
    const itemWidth = (containerWidth - (numColumns - 1) * columnGap) / numColumns;
    
    // 初始化列高度
    const columnHeights = Array(numColumns).fill(0);
    const layoutInfo = {};
    
    // 为每个元素计算位置
    elements.forEach((element, index) => {
        // 找到最短的列
        const minColumnIndex = columnHeights.indexOf(Math.min(...columnHeights));
        
        // 计算位置
        const left = minColumnIndex * (itemWidth + columnGap);
        const top = columnHeights[minColumnIndex];
        
        // 获取元素的准确高度
        const height = getElementHeight(element);
        
        // 存储布局信息
        layoutInfo[index] = {
            top: top,
            left: left,
            width: itemWidth,
            height: height
        };
        
        // 更新列高度
        columnHeights[minColumnIndex] += height + columnGap;
    });
    
    return layoutInfo;
}

/**
 * 初始化虚拟滚动
 * @param {Array} items - 数据项数组
 * @param {Function} renderCallback - 渲染回调函数
 */
export function initializeVirtualScroll(items, renderCallback) {
    // 重置虚拟滚动懒加载器状态
    virtualScrollLazyLoader.reset();
    const { contentGrid } = elements;
    if (!contentGrid) return;

    // 如果项目数量超过阈值，启用虚拟滚动
    if (items.length > VIRTUAL_SCROLL_THRESHOLD) {
        if (!virtualScroller) {
            // 动态导入VirtualScroller以避免循环依赖
            import('./virtual-scroll.js').then(({ VirtualScroller }) => {
                // 使用自定义渲染回调，支持缩略图懒加载
                const enhancedRenderCallback = renderCallback || createVirtualScrollRenderCallback;
                virtualScroller = new VirtualScroller(contentGrid, {
                    buffer: 15,
                    renderCallback: enhancedRenderCallback
                });
                virtualScroller.setItems(items);
                contentGrid.classList.add('virtual-scroll-mode');

                // 为虚拟滚动器添加滚动事件监听，触发可见图片的懒加载
                setupVirtualScrollLazyLoading();

                // 确保懒加载系统也被初始化
                setTimeout(() => {
                    if (!globalImageObserverRef) {
                        getLazyloadModule().then(lazyload => {
                            if (!lazyload.globalImageObserver) {
                                lazyload.setupLazyLoading();
                            }
                            globalImageObserverRef = lazyload.globalImageObserver;
                        });
                    }
                }, 100);
            });
        } else {
            virtualScroller.setItems(items);
            contentGrid.classList.add('virtual-scroll-mode');

            // 重新设置项目时也确保懒加载系统被初始化
            setTimeout(() => {
                if (!globalImageObserverRef) {
                    getLazyloadModule().then(lazyload => {
                        if (!lazyload.globalImageObserver) {
                            lazyload.setupLazyLoading();
                        }
                        globalImageObserverRef = lazyload.globalImageObserver;
                    });
                }
            }, 100);
        }
        return true;
    } else {
        // 项目数量较少，使用传统瀑布流
        if (virtualScroller) {
            // 清理懒加载事件监听器
            if (virtualScroller._lazyLoadHandler && virtualScroller.container) {
                virtualScroller.container.removeEventListener('scroll', virtualScroller._lazyLoadHandler);
            }
            virtualScroller.destroy();
            virtualScroller = null;
        }
        contentGrid.classList.remove('virtual-scroll-mode');
        return false;
    }
}

/**
 * 为虚拟滚动器设置懒加载机制
 */
function setupVirtualScrollLazyLoading() {
    if (!virtualScroller) return;

    // 清理之前的监听器
    if (virtualScroller._lazyLoadHandler && virtualScroller.container) {
        virtualScroller.container.removeEventListener('scroll', virtualScroller._lazyLoadHandler);
    }

    // 监听虚拟滚动器的滚动事件（优化调用频率）
    let scrollTriggerTimeout;
    const handleScroll = () => {
        // 清除之前的延迟调用
        if (scrollTriggerTimeout) {
            clearTimeout(scrollTriggerTimeout);
        }

        // 延迟触发，避免频繁调用
        scrollTriggerTimeout = setTimeout(() => {
            // 检查是否真的有需要加载的图片
            const { contentGrid } = elements;
            if (!contentGrid) return;

            const unloadedImages = contentGrid.querySelectorAll('.lazy-image:not(.loaded)');
            if (unloadedImages.length > 0) {
                triggerVisibleImagesLazyLoad();
            }
        }, 150);
    };

    // 为虚拟滚动器容器添加滚动事件监听
    const scrollContainer = virtualScroller.container;
    if (scrollContainer) {
        scrollContainer.addEventListener('scroll', handleScroll, { passive: true });

        // 存储引用以便后续清理
        virtualScroller._lazyLoadHandler = handleScroll;
    }
}

/**
 * 触发瀑布流更新事件
 * 用于通知其他模块瀑布流需要重新布局
 */
export function triggerMasonryUpdate() {
    const event = new CustomEvent('masonry-update');
    document.dispatchEvent(event);
}

/**
 * 监听瀑布流更新事件
 * 在窗口resize、模式切换等情况下重新布局
 */
document.addEventListener('masonry-update', () => {
    scheduleApplyMasonryLayout();
});

// 虚拟滚动懒加载优化器 - 智能预测版本
const virtualScrollLazyLoader = {
    lastTriggerTime: 0, // 上次触发时间
    triggerThrottle: 100, // 减少节流时间，提升响应性
    isProcessing: false, // 是否正在处理中
    processedImages: new Set(), // 已处理的图片集合，避免重复处理
    scrollDirection: 0, // 滚动方向：1向下，-1向上，0静止
    lastScrollTop: 0, // 上次滚动位置
    scrollSamples: [], // 滚动方向采样

    /**
     * 更新滚动方向
     */
    updateScrollDirection(currentScrollTop) {
        const direction = currentScrollTop > this.lastScrollTop ? 1 :
                         currentScrollTop < this.lastScrollTop ? -1 : 0;

        this.scrollSamples.push(direction);
        if (this.scrollSamples.length > 5) {
            this.scrollSamples.shift();
        }

        // 计算主要滚动方向（最近5次滚动中的主要方向）
        const downCount = this.scrollSamples.filter(d => d === 1).length;
        const upCount = this.scrollSamples.filter(d => d === -1).length;

        this.scrollDirection = downCount > upCount ? 1 : upCount > downCount ? -1 : 0;
        this.lastScrollTop = currentScrollTop;
    },

    /**
     * 智能预测加载区域
     */
    getPredictedLoadArea(viewportHeight, scrollTop) {
        const baseBuffer = 200; // 基础缓冲区
        const scrollVelocity = Math.abs(window.scrollVelocity || 0);

        // 根据滚动速度调整缓冲区大小
        let dynamicBuffer = baseBuffer;
        if (scrollVelocity > 100) {
            dynamicBuffer = baseBuffer * 2; // 快速滚动时增加缓冲区
        } else if (scrollVelocity > 50) {
            dynamicBuffer = baseBuffer * 1.5; // 中等速度时适度增加
        }

        // 根据滚动方向调整预测区域
        let predictedTop = scrollTop - dynamicBuffer;
        let predictedBottom = scrollTop + viewportHeight + dynamicBuffer;

        if (this.scrollDirection === 1) {
            // 向下滚动，增加下方预测区域
            predictedBottom += dynamicBuffer * 0.5;
        } else if (this.scrollDirection === -1) {
            // 向上滚动，增加上方预测区域
            predictedTop -= dynamicBuffer * 0.5;
        }

        return { predictedTop, predictedBottom };
    },

    /**
     * 触发可见图片的懒加载（备用机制）
     * 仅在IntersectionObserver可能失效时使用，避免双重处理
     */
    async trigger() {
        // 大幅降低触发频率，避免和IntersectionObserver冲突
        const now = Date.now();
        if (now - this.lastTriggerTime < 1000) { // 1秒节流
            return;
        }
        this.lastTriggerTime = now;

        // 如果正在处理中，跳过
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            const { contentGrid } = elements;
            if (!contentGrid) return;

            // 检查是否处于虚拟滚动模式
            const isVirtualScroll = contentGrid.classList.contains('virtual-scroll-mode');
            if (!isVirtualScroll) return;

            // 获取懒加载模块
            const { requestLazyImage } = await getLazyloadModule();

            // 计算当前可见区域（简单版本）
            const viewportHeight = window.innerHeight;
            const currentScrollTop = window.scrollY;
            const visibleTop = currentScrollTop;
            const visibleBottom = currentScrollTop + viewportHeight;

            // 只处理当前可见区域内的图片，避免过度加载
            const images = Array.from(contentGrid.querySelectorAll('img.lazy-image'));
            let processedCount = 0;
            const maxProcessCount = 5; // 大幅降低处理数量

            for (const img of images) {
                if (processedCount >= maxProcessCount) break;

                // 检查是否已经处理过
                const imgId = img.dataset.src;
                if (this.processedImages.has(imgId)) continue;

                // 检查图片是否在当前可见区域内
                const rect = img.getBoundingClientRect();
                const imgTop = currentScrollTop + rect.top;
                const imgBottom = currentScrollTop + rect.bottom;

                // 只处理完全可见的图片
                if (imgTop >= visibleTop && imgBottom <= visibleBottom) {
                    if (img.dataset.src && !img.classList.contains('loaded') && img.dataset.thumbStatus !== 'processing') {
                        // 减少虚拟滚动备用日志输出，只在开发模式下输出
                        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                            console.debug('虚拟滚动备用：触发图片懒加载', img.dataset.src);
                        }
                        requestLazyImage(img);
                        this.processedImages.add(imgId);
                        processedCount++;
                    }
                }
            }

            // 定期清理已处理的图片集合
            if (this.processedImages.size > 50) {
                // 保留最近处理的20张，清理其他
                const recentProcessed = Array.from(this.processedImages).slice(-20);
                this.processedImages.clear();
                recentProcessed.forEach(id => this.processedImages.add(id));
            }

        } catch (error) {
            console.error('虚拟滚动懒加载触发失败:', error);
        } finally {
            this.isProcessing = false;
        }
    },

    /**
     * 重置处理状态（用于页面切换等场景）
     */
    reset() {
        this.processedImages.clear();
        this.lastTriggerTime = 0;
        this.isProcessing = false;
    },

    /**
     * 清理资源
     */
    cleanup() {
        this.reset();
    }
};

/**
 * 触发可见图片的懒加载（对外接口）
 */
async function triggerVisibleImagesLazyLoad() {
    await virtualScrollLazyLoader.trigger();
}

/**
 * 创建虚拟滚动器的渲染回调函数
 * 为虚拟滚动器渲染的项目自动设置懒加载
 * @param {Object} item - 数据项
 * @param {HTMLElement} element - 渲染的DOM元素
 * @param {number} index - 项目索引
 */
export function createVirtualScrollRenderCallback(item, element, index) {
    // 根据项目类型调用相应的渲染函数
    if (item.type === 'album') {
        // 相册渲染（这里需要导入displayAlbum函数）
        return renderAlbumForVirtualScroll(item.data, element, index);
    } else {
        // 媒体文件渲染（图片或视频）
        return renderMediaForVirtualScroll(item.type, item.data, element, index);
    }
}

/**
 * 为虚拟滚动器渲染相册项目
 * @param {Object} albumData - 相册数据
 * @param {HTMLElement} element - 渲染的DOM元素
 * @param {number} index - 项目索引
 */
function renderAlbumForVirtualScroll(albumData, element, index) {
    // 这里应该实现相册的渲染逻辑
    // 暂时使用简单的占位符
    element.className = 'album-card virtual-item';
    element.textContent = albumData.name || `相册 ${index}`;
    return element;
}

/**
 * 为虚拟滚动器渲染媒体项目
 * @param {string} type - 媒体类型 ('photo' 或 'video')
 * @param {Object} mediaData - 媒体数据
 * @param {HTMLElement} element - 渲染的DOM元素
 * @param {number} index - 项目索引
 */
function renderMediaForVirtualScroll(type, mediaData, element, index) {
    const isVideo = type === 'video';

    // 使用精确的宽高比
    const aspectRatio = (mediaData.height && mediaData.width)
        ? mediaData.width / mediaData.height
        : (isVideo ? 16/9 : 1);

    // 设置基本的项目样式
    element.className = 'photo-item virtual-item group block bg-gray-800 rounded-lg overflow-hidden cursor-pointer';
    element.style.position = 'absolute';
    element.style.aspectRatio = aspectRatio;

    // 设置尺寸数据
    element.setAttribute('data-width', mediaData.width || 0);
    element.setAttribute('data-height', mediaData.height || 0);
    element.setAttribute('data-aspect-ratio', aspectRatio.toFixed(3));

    // 创建相对定位的容器
    const relativeDiv = document.createElement('div');
    relativeDiv.className = 'relative w-full h-full';
    relativeDiv.style.aspectRatio = aspectRatio;

    // 创建占位层
    const placeholder = document.createElement('div');
    placeholder.className = 'image-placeholder absolute inset-0';
    if (!mediaData.height || !mediaData.width) {
        placeholder.classList.add('min-h-[200px]');
    }
    relativeDiv.appendChild(placeholder);

    // 创建加载覆盖层
    const loadingOverlay = document.createElement('div');
    loadingOverlay.className = 'loading-overlay';
    const progressHolder = document.createElement('div');
    progressHolder.innerHTML = `
        <svg class="progress-circle" viewBox="0 0 36 36" aria-hidden="true">
            <circle class="progress-circle-track" cx="18" cy="18" r="16" stroke-width="4"></circle>
            <circle class="progress-circle-bar" cx="18" cy="18" r="16" stroke-width="4"></circle>
        </svg>
    `;
    loadingOverlay.appendChild(progressHolder);
    relativeDiv.appendChild(loadingOverlay);

    // 创建图片元素
    const img = document.createElement('img');
    img.className = 'w-full h-full object-cover absolute inset-0 lazy-image transition-opacity duration-300';
    img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E";
    img.alt = isVideo ? '视频缩略图' : '图片缩略图';
    img.dataset.src = mediaData.thumbnailUrl;

    // 设置图片事件监听器
    img.onload = () => {
        img.classList.add('loaded');
        triggerMasonryUpdate();
    };

    img.onerror = () => {
        img.classList.add('error');
        triggerMasonryUpdate();
    };

    relativeDiv.appendChild(img);

    // 重要：将新渲染的图片添加到 Intersection Observer 中
    // 延迟一点时间确保DOM已经渲染完成
    setTimeout(async () => {
        if (!img._observed && img.classList.contains('lazy-image')) {
            try {
                // 获取懒加载模块中的全局观察器
                if (!globalImageObserverRef) {
                    const lazyload = await getLazyloadModule();
                    globalImageObserverRef = lazyload.globalImageObserver || lazyload.setupLazyLoading();
                }
                globalImageObserverRef.observe(img);
                img._observed = true;
            } catch (error) {
                console.warn('添加图片到Intersection Observer失败:', error);
            }
        }
    }, 10);

    // 如果是视频，添加播放按钮覆盖层
    if (isVideo) {
        const overlay = document.createElement('div');
        overlay.className = 'video-thumbnail-overlay';
        const playBtn = document.createElement('div');
        playBtn.className = 'video-play-button';
        playBtn.innerHTML = `
            <svg viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
                <path d="M24 18v28l24-14-24-14z"></path>
            </svg>
        `;
        overlay.appendChild(playBtn);
        relativeDiv.appendChild(overlay);
    }

    element.appendChild(relativeDiv);

    // 创建外层容器
    const gridItem = document.createElement('div');
    gridItem.className = 'grid-item photo-link';
    gridItem.setAttribute('data-url', mediaData.originalUrl);
    gridItem.setAttribute('data-index', index);
    gridItem.setAttribute('data-width', mediaData.width || 0);
    gridItem.setAttribute('data-height', mediaData.height || 0);
    gridItem.appendChild(element);

    return gridItem;
}

// 将虚拟滚动懒加载器暴露到全局（用于清理）
if (typeof window !== 'undefined') {
    window.virtualScrollLazyLoader = virtualScrollLazyLoader;
}