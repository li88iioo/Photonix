// frontend/js/masonry.js

import { elements } from './ui.js';

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
                const actualItemHeight = item.offsetHeight;
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
                const actualItemHeight = item.offsetHeight;
                masonryColumnHeights[minColumnIndex] += actualItemHeight + columnGap;
            });
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
            masonryColumnHeights[minColumnIndex] += actualItemHeight + columnGap;
        });

        contentGrid.style.height = `${Math.max(...masonryColumnHeights)}px`;
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
    const { contentGrid } = elements;
    if (!contentGrid) return;
    
    // 如果项目数量超过阈值，启用虚拟滚动
    if (items.length > VIRTUAL_SCROLL_THRESHOLD) {
        if (!virtualScroller) {
            // 动态导入VirtualScroller以避免循环依赖
            import('./virtual-scroll.js').then(({ VirtualScroller }) => {
                virtualScroller = new VirtualScroller(contentGrid, {
                    buffer: 15,
                    renderCallback: renderCallback
                });
                virtualScroller.setItems(items);
                contentGrid.classList.add('virtual-scroll-mode');
            });
        } else {
            virtualScroller.setItems(items);
            contentGrid.classList.add('virtual-scroll-mode');
        }
        return true;
    } else {
        // 项目数量较少，使用传统瀑布流
        if (virtualScroller) {
            virtualScroller.destroy();
            virtualScroller = null;
        }
        contentGrid.classList.remove('virtual-scroll-mode');
        return false;
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