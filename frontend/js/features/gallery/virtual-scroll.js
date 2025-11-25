/**
 * @file virtual-scroll.js
 * @description 高性能虚拟滚动系统，采用两阶段渲染策略，完美支持瀑布流布局
 * @module virtual-scroll
 */

import { calculateMasonryLayout } from './masonry.js';
import { getVirtualScrollConfig } from '../../core/constants.js';
import { performanceLogger } from '../../core/logger.js';
import { safeSetInnerHTML, safeSetStyle, safeClassList } from '../../shared/dom-utils.js';

/**
 * 虚拟滚动器类
 */
class VirtualScroller {
    /**
     * 构造函数，创建虚拟滚动器实例
     * @param {HTMLElement} container - 容器元素
     * @param {Object} [options] - 配置选项
     * @param {number} [options.buffer] - 缓冲区大小
     * @param {number} [options.maxPoolSize] - 复用池最大容量
     * @param {number} [options.estimatedItemHeight] - 预估项目高度
     * @param {Function} [options.renderCallback] - 自定义渲染回调函数
     * @param {boolean} [options.showLoadingAnimation] - 是否显示加载动画
     * @param {boolean} [options.smoothScrolling] - 是否启用平滑滚动
     * @param {boolean} [options.enableAnimations] - 是否启用动画效果
     */
    constructor(container, options = {}) {
        this.container = container;

        this.buffer = options.buffer || getVirtualScrollConfig('DEFAULT_BUFFER_SIZE'); // 缓冲区大小
        this.maxPoolSize = options.maxPoolSize || getVirtualScrollConfig('DEFAULT_MAX_POOL_SIZE'); // 复用池最大容量
        this.items = [];
        this.visibleItems = new Map(); // 当前渲染的项目
        this.measurementCache = new Map(); // 测量缓存
        this.layoutCache = new Map(); // 布局缓存
        this.nodePool = []; // 节点复用池

        // 滚动状态
        this.scrollTop = 0;
        this.viewportHeight = 0;
        this.startIndex = 0;
        this.endIndex = 0;

        // 两阶段渲染相关
        this.measurementContainer = null;
        this.isMeasuring = false;
        this.estimatedItemHeight = options.estimatedItemHeight || getVirtualScrollConfig('DEFAULT_ESTIMATED_HEIGHT');
        this.renderCallback = options.renderCallback || this.defaultRenderCallback;

        // 可视化选项配置
        const defaultVisualOptions = getVirtualScrollConfig('VISUAL_OPTIONS');
        this.visualOptions = {
            showLoadingAnimation: options.showLoadingAnimation !== undefined ? options.showLoadingAnimation : defaultVisualOptions.showLoadingAnimation,
            smoothScrolling: options.smoothScrolling !== undefined ? options.smoothScrolling : defaultVisualOptions.smoothScrolling,
            enableAnimations: options.enableAnimations !== undefined ? options.enableAnimations : defaultVisualOptions.enableAnimations
        };
        
        // UI元素
        this.loadingIndicator = null;
        this.progressBar = null;
        this.progressBarInner = null;
        
        this.init();
    }
    
    /**
     * 初始化虚拟滚动器
     * @private
     */
    init() {
        // 创建视口容器
        this.viewport = document.createElement('div');
        safeSetStyle(this.viewport, {
            position: 'relative',
            width: '100%',
            height: '100%',
            overflow: 'hidden'
        });
        
        // 创建哨兵元素（撑开滚动条）
        this.sentinel = document.createElement('div');
        safeSetStyle(this.sentinel, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            pointerEvents: 'none'
        });
        
        // 创建测量容器（屏幕外）
        this.measurementContainer = document.createElement('div');
        safeSetStyle(this.measurementContainer, {
            position: 'absolute',
            top: '-9999px',
            left: '-9999px',
            width: this.container.offsetWidth + 'px',
            visibility: 'hidden',
            pointerEvents: 'none'
        });
        
        // 组装DOM结构
        this.container.appendChild(this.viewport);
        this.container.appendChild(this.sentinel);
        this.container.appendChild(this.measurementContainer);
        
        // 创建UI元素
        this.createVisualElements();
        
        // 绑定事件
        this.bindEvents();
        this.updateViewportHeight();
    }
    
    /**
     * 创建视觉元素
     * @private
     */
    createVisualElements() {
        // 创建加载指示器
        if (this.visualOptions.showLoadingAnimation) {
            this.loadingIndicator = document.createElement('div');
            this.loadingIndicator.className = 'virtual-scroll-loading';
            safeSetInnerHTML(this.loadingIndicator, `
                <div class="loading-spinner"></div>
                <div class="loading-text">正在加载...</div>
            `);
            safeSetStyle(this.loadingIndicator, 'display', 'none');
            this.container.appendChild(this.loadingIndicator);
        }
        
        // 创建进度条
        this.progressBar = document.createElement('div');
        this.progressBar.className = 'virtual-scroll-progress';
        safeSetInnerHTML(this.progressBar, '<div class="virtual-scroll-progress-bar"></div>');
        this.progressBarInner = this.progressBar.querySelector('.virtual-scroll-progress-bar');
        document.body.appendChild(this.progressBar);
    }
    
    /**
     * 绑定事件监听器
     * @private
     */
    bindEvents() {
        // 绑定事件时保存引用，以便正确移除
        this.boundHandleScroll = this.handleScroll.bind(this);
        this.boundHandleResize = this.handleResize.bind(this);
        
        // 将容器设为可滚动，避免监听 window 产生的多余重排
        safeSetStyle(this.container, 'overflowY', 'auto');
        this.container.addEventListener('scroll', this.boundHandleScroll, { passive: true });
        window.addEventListener('resize', this.boundHandleResize);
    }
    
    /**
     * 设置数据项
     * @param {Array} items - 要显示的数据项数组
     */
    setItems(items) {
        if (!Array.isArray(items)) {
            performanceLogger.warn('VirtualScroller: setItems 需要数组参数');
            return;
        }
        
        this.items = items;
        this.updateScrollHeight();
        this.render();
    }
    
    /**
     * 更新滚动高度
     * @private
     */
    updateScrollHeight() {
        // 计算总高度：已测量项目使用精确高度，未测量项目使用预估高度
        let totalHeight = 0;
        let measuredHeight = 0;
        let unmeasuredCount = 0;
        
        for (let i = 0; i < this.items.length; i++) {
            if (this.measurementCache.has(i)) {
                const measurement = this.measurementCache.get(i);
                totalHeight += measurement.height;
                measuredHeight += measurement.height;
            } else {
                totalHeight += this.estimatedItemHeight;
                unmeasuredCount++;
            }
        }
        
        // 动态调整预估高度
        if (measuredHeight > 0 && this.measurementCache.size > 0) {
            const averageMeasuredHeight = measuredHeight / this.measurementCache.size;
            this.estimatedItemHeight = averageMeasuredHeight;
            
            // 重新计算未测量项目的高度
            totalHeight = measuredHeight + (unmeasuredCount * this.estimatedItemHeight);
        }
        
        safeSetStyle(this.sentinel, 'height', totalHeight + 'px');
    }
    
    /**
     * 计算可见范围（优化：二分查找）
     * @private
     * @returns {Object} 返回包含 startIndex 和 endIndex 的对象
     */
    calculateVisibleRange() {
        if (!this.items || this.items.length === 0) {
            return { startIndex: 0, endIndex: 0 };
        }
        
        const scrollTop = this.container.scrollTop;
        const visibleTop = scrollTop;
        const visibleBottom = scrollTop + this.viewportHeight;
        const bufferHeight = this.buffer * this.estimatedItemHeight;
        
        // 使用二分查找优化可见范围计算
        const startIndex = this.binarySearchStartIndex(visibleTop - bufferHeight);
        const endIndex = this.binarySearchEndIndex(visibleBottom + bufferHeight, startIndex);
        
        return { startIndex, endIndex };
    }
    
    /**
     * 二分查找起始索引
     * @private
     * @param {number} targetTop - 目标顶部位置
     * @returns {number} 起始索引
     */
    binarySearchStartIndex(targetTop) {
        let left = 0;
        let right = this.items.length - 1;
        let currentTop = 0;
        
        // 如果缓存不足，回退到线性搜索
        if (this.measurementCache.size < this.items.length * getVirtualScrollConfig('CACHE_THRESHOLD_RATIO')) {
            return this.linearSearchStartIndex(targetTop);
        }
        
        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const midTop = this.getItemTop(mid);
            
            if (midTop <= targetTop) {
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }
        
        return Math.max(0, right);
    }
    
    /**
     * 二分查找结束索引
     * @private
     * @param {number} targetBottom - 目标底部位置
     * @param {number} startIndex - 起始索引
     * @returns {number} 结束索引
     */
    binarySearchEndIndex(targetBottom, startIndex) {
        let left = startIndex;
        let right = this.items.length - 1;
        
        // 如果缓存不足，回退到线性搜索
        if (this.measurementCache.size < this.items.length * getVirtualScrollConfig('CACHE_THRESHOLD_RATIO')) {
            return this.linearSearchEndIndex(targetBottom, startIndex);
        }
        
        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const midTop = this.getItemTop(mid);
            
            if (midTop <= targetBottom) {
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }
        
        return Math.min(this.items.length, left);
    }
    
    /**
     * 获取项目顶部位置
     * @private
     * @param {number} index - 项目索引
     * @returns {number} 项目顶部位置
     */
    getItemTop(index) {
        let top = 0;
        for (let i = 0; i < index; i++) {
            const itemHeight = this.measurementCache.has(i) 
                ? this.measurementCache.get(i).height 
                : this.estimatedItemHeight;
            top += itemHeight;
        }
        return top;
    }
    
    /**
     * 线性搜索起始索引（回退方案）
     * @private
     * @param {number} targetTop - 目标顶部位置
     * @returns {number} 起始索引
     */
    linearSearchStartIndex(targetTop) {
        let currentTop = 0;
        for (let i = 0; i < this.items.length; i++) {
            const itemHeight = this.measurementCache.has(i) 
                ? this.measurementCache.get(i).height 
                : this.estimatedItemHeight;
            
            if (currentTop + itemHeight > targetTop) {
                return i;
            }
            currentTop += itemHeight;
        }
        return 0;
    }
    
    /**
     * 线性搜索结束索引（回退方案）
     * @private
     * @param {number} targetBottom - 目标底部位置
     * @param {number} startIndex - 起始索引
     * @returns {number} 结束索引
     */
    linearSearchEndIndex(targetBottom, startIndex) {
        let currentTop = this.getItemTop(startIndex);
        
        for (let i = startIndex; i < this.items.length; i++) {
            const itemHeight = this.measurementCache.has(i) 
                ? this.measurementCache.get(i).height 
                : this.estimatedItemHeight;
            
            if (currentTop > targetBottom) {
                return i;
            }
            currentTop += itemHeight;
        }
        
        return this.items.length;
    }
    
    /**
     * 测量项目（两阶段渲染的第一阶段）
     * @private
     * @param {Array<number>} itemIndices - 需要测量的项目索引数组
     * @returns {Promise<void>}
     */
    async measureItems(itemIndices) {
        if (this.isMeasuring || itemIndices.length === 0) return;
        
        this.isMeasuring = true;
        const itemsToMeasure = itemIndices.filter(i => !this.measurementCache.has(i));
        
        if (itemsToMeasure.length === 0) {
            this.isMeasuring = false;
            return;
        }
        
        try {
            // 清空测量容器
            safeSetInnerHTML(this.measurementContainer, '');
            
            // 创建测量用的DOM元素
            const measurementElements = [];
            for (const index of itemsToMeasure) {
                const item = this.items[index];
                const element = document.createElement('div');
                safeSetStyle(element, {
                    position: 'absolute',
                    top: '0',
                    left: '0',
                    width: '100%'
                });
                
                // 渲染项目内容
                this.renderCallback(item, element, index);
                measurementElements.push({ index, element });
                
                this.measurementContainer.appendChild(element);
            }
            
            // 等待DOM更新
            await new Promise(resolve => requestAnimationFrame(resolve));
            
            // 应用瀑布流布局并测量
            const layoutInfo = await this.applyMasonryLayoutToElements(measurementElements);
            
            // 缓存测量结果
            for (const { index, element } of measurementElements) {
                const rect = element.getBoundingClientRect();
                this.measurementCache.set(index, {
                    height: rect.height,
                    top: layoutInfo[index]?.top || 0,
                    left: layoutInfo[index]?.left || 0,
                    width: rect.width
                });
            }
            
            // 更新滚动高度
            this.updateScrollHeight();
            
            // 轻量级二次测量：图片加载后若高度变化，微调缓存并触发一次重渲染
            const hasImg = measurementElements.some(({ element }) => element.querySelector('img'));
            if (hasImg) {
                setTimeout(() => {
                    let changed = false;
                    for (const { index, element } of measurementElements) {
                        const cached = this.measurementCache.get(index);
                        if (cached) {
                            // 避免重复调用getBoundingClientRect，使用更高效的属性访问
                            const currentHeight = element.offsetHeight;
                            const currentWidth = element.offsetWidth;

                            // 检查高度或宽度是否有显著变化（>=1px）
                            const heightChanged = Math.abs((currentHeight || 0) - (cached.height || 0)) >= 1;
                            const widthChanged = Math.abs((currentWidth || 0) - (cached.width || 0)) >= 1;

                            if (heightChanged || widthChanged) {
                                this.measurementCache.set(index, {
                                    height: currentHeight,
                                    top: cached.top,    // 位置通常不变
                                    left: cached.left,  // 位置通常不变
                                    width: currentWidth
                                });
                                changed = true;
                            }
                        }
                    }
                    if (changed) {
                        this.updateScrollHeight();
                        this.render();
                    }
                }, 200);
            }
            
        } catch (error) {
            performanceLogger.error('测量项目失败', error);
        } finally {
            this.isMeasuring = false;
        }
    }
    
    /**
     * 应用瀑布流布局到测量元素
     * @private
     * @param {Array<Object>} elements - 包含索引和元素的对象数组
     * @returns {Promise<Object>} 布局信息对象
     */
    async applyMasonryLayoutToElements(elements) {
        try {
            // 提取元素数组
            const elementArray = elements.map(e => e.element);
            
            // 调用真实的瀑布流布局计算
            const layoutInfo = calculateMasonryLayout(this.measurementContainer, elementArray);
            
            return layoutInfo;
        } catch (error) {
            performanceLogger.error('瀑布流布局计算失败', error);
            
            // 降级到简单的垂直布局
            const layoutInfo = {};
            let currentTop = 0;
            
            for (const { index, element } of elements) {
                const rect = element.getBoundingClientRect();
                layoutInfo[index] = {
                    top: currentTop,
                    left: 0,
                    width: rect.width,
                    height: rect.height
                };
                currentTop += rect.height;
            }
            
            return layoutInfo;
        }
    }
    
    /**
     * 渲染可见项目（两阶段渲染的第二阶段）
     * @private
     */
    render() {
        const { startIndex, endIndex } = this.calculateVisibleRange();

        // 检查是否需要测量新项目（先计算，后决定是否显示加载动画）
        const newItemsToMeasure = [];
        for (let i = startIndex; i < endIndex; i++) {
            if (!this.measurementCache.has(i)) {
                newItemsToMeasure.push(i);
            }
        }
        
        // 显示加载动画（仅当确实有新项目需要测量时）
        if (this.loadingIndicator && newItemsToMeasure.length > 0) {
            this.showLoadingAnimation();
        }

        if (newItemsToMeasure.length > 0) {
            this.measureItems(newItemsToMeasure);
        }
        
        // 清理视口外的元素
        for (const [index, element] of this.visibleItems) {
            if (index < startIndex || index >= endIndex) {
                if (this.visualOptions.enableAnimations) {
                    safeClassList(element, 'add', 'virtual-scroll-item-exit');
                    setTimeout(() => {
                        element.remove();
                        this.releaseNode(element);
                        this.visibleItems.delete(index);
                    }, 200);
                } else {
                    element.remove();
                    this.releaseNode(element);
                    this.visibleItems.delete(index);
                }
            }
        }
        
        // 渲染可见范围内的项目（批量插入减少重排）
        const batchFragment = document.createDocumentFragment();
        for (let i = startIndex; i < endIndex; i++) {
            if (!this.visibleItems.has(i)) {
                const item = this.items[i];
                const element = this.getPooledNode();
                element.className = 'virtual-scroll-item virtual-scroll-optimized';
                
                // 应用缓存的布局信息
                if (this.measurementCache.has(i)) {
                    const measurement = this.measurementCache.get(i);
                    safeSetStyle(element, {
                        top: measurement.top + 'px',
                        left: measurement.left + 'px',
                        width: measurement.width + 'px',
                        minHeight: ''
                    });
                } else {
                    // 使用预估位置
                    const estimatedTop = i * this.estimatedItemHeight;
                    safeSetStyle(element, {
                        top: estimatedTop + 'px',
                        minHeight: this.estimatedItemHeight + 'px'
                    });
                }
                
                // 渲染项目内容
                safeSetInnerHTML(element, '');
                this.renderCallback(item, element, i);
                batchFragment.appendChild(element);
                this.visibleItems.set(i, element);
                
                // 添加进入动画
                if (this.visualOptions.enableAnimations) {
                    safeClassList(element, 'add', 'virtual-scroll-item-enter');
                    requestAnimationFrame(() => {
                        safeClassList(element, 'add', 'virtual-scroll-item-enter-active');
                    });
                }
            }
        }
        // 一次性插入
        if (batchFragment.childNodes.length > 0) {
            this.viewport.appendChild(batchFragment);
        }
        
        // 更新进度条
        this.updateProgressBar();
        
        // 隐藏加载动画
        if (this.loadingIndicator) {
            this.hideLoadingAnimation();
        }
        
        this.startIndex = startIndex;
        this.endIndex = endIndex;
    }

    /**
     * 从复用池获取节点
     * @private
     * @returns {HTMLElement} DOM元素
     */
    getPooledNode() {
        if (this.nodePool.length > 0) {
            return this.nodePool.pop();
        }
        return document.createElement('div');
    }

    /**
     * 释放节点到复用池
     * @private
     * @param {HTMLElement} element - 要释放的DOM元素
     */
    releaseNode(element) {
        if (!element) return;
        try {
            element.removeAttribute('style');
            element.className = '';
            safeSetInnerHTML(element, '');
        } catch {}
        if (this.nodePool.length < this.maxPoolSize) {
            this.nodePool.push(element);
        }
    }
    
    /**
     * 显示加载动画
     * @private
     */
    showLoadingAnimation() {
        if (this.loadingIndicator) {
            safeSetStyle(this.loadingIndicator, 'display', 'flex');
        }
    }
    
    /**
     * 隐藏加载动画
     * @private
     */
    hideLoadingAnimation() {
        if (this.loadingIndicator) {
            safeSetStyle(this.loadingIndicator, 'display', 'none');
        }
    }
    
    /**
     * 更新进度条
     * @private
     */
    updateProgressBar() {
        if (this.progressBar && this.items.length > 0) {
            const progress = (this.scrollTop / (this.sentinel.offsetHeight - this.viewportHeight)) * 100;
            if (this.progressBarInner) {
                safeSetStyle(this.progressBarInner, 'width', `${Math.min(100, Math.max(0, progress))}%`);
            }
        }
    }
    
    /**
     * 处理滚动事件
     * @private
     */
    handleScroll() {
        if (!this.container) return;
        
        requestAnimationFrame(() => {
            this.scrollTop = this.container.scrollTop;
            this.render();
        });
    }
    
    /**
     * 处理窗口大小变化
     * @private
     */
    handleResize() {
        if (!this.container) return;
        
        this.updateViewportHeight();
        this.updateScrollHeight();
        this.render();
    }
    
    /**
     * 更新视口高度
     * @private
     */
    updateViewportHeight() {
        if (!this.container) return;
        this.viewportHeight = this.container.clientHeight;
    }
    
    /**
     * 默认渲染回调
     * @private
     * @param {Object} item - 数据项
     * @param {HTMLElement} element - DOM元素
     * @param {number} index - 索引
     */
    defaultRenderCallback(item, element, index) {
        element.className = 'virtual-item';
        safeSetStyle(element, {
            height: '300px',
            border: '1px solid #ccc'
        });
        element.textContent = `Item ${index}`;
    }
    
    /**
     * 销毁虚拟滚动器，清理所有事件监听器、DOM元素和缓存数据
     */
    destroy() {
        // 正确移除事件监听器
        if (this.boundHandleScroll) {
            this.container.removeEventListener('scroll', this.boundHandleScroll);
        }
        if (this.boundHandleResize) {
            window.removeEventListener('resize', this.boundHandleResize);
        }
        
        // 清理DOM
        if (this.viewport) {
            safeSetInnerHTML(this.viewport, '');
        }
        if (this.sentinel) {
            this.sentinel.remove();
        }
        if (this.viewport) {
            this.viewport.remove();
        }
        if (this.measurementContainer) {
            this.measurementContainer.remove();
        }
        if (this.progressBar) {
            try { this.progressBar.remove(); } catch {}
            this.progressBar = null;
            this.progressBarInner = null;
        }
        if (this.loadingIndicator) {
            try { this.loadingIndicator.remove(); } catch {}
            this.loadingIndicator = null;
        }
        
        // 清理缓存
        this.visibleItems.clear();
        this.layoutCache.clear();
        this.measurementCache.clear();
        
        // 重置状态
        this.items = [];
        this.isMeasuring = false;
    }
}

/**
 * 导出虚拟滚动器类
 * @namespace virtualScroll
 */
export { VirtualScroller };