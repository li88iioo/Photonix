// frontend/js/virtual-scroll.js

import { elements } from './ui.js';

/**
 * 高性能虚拟滚动系统
 * 采用两阶段渲染策略，完美支持瀑布流布局
 */

class VirtualScroller {
    constructor(container, options = {}) {
        this.container = container;
        this.buffer = options.buffer || 10; // 缓冲区大小
        this.maxPoolSize = options.maxPoolSize || 60; // 复用池最大容量
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
        this.estimatedItemHeight = options.estimatedItemHeight || 300;
        this.renderCallback = options.renderCallback || this.defaultRenderCallback;
        
        // UI优化相关
        this.performanceMetrics = {
            renderTime: 0,
            frameRate: 0,
            lastFrameTime: 0
        };
        this.fpsSamples = [];
        this.performanceWindow = 30;
        this.lastBufferAdjust = 0;
        this.visualOptions = {
            showLoadingAnimation: options.showLoadingAnimation !== false,
            smoothScrolling: options.smoothScrolling !== false,
            enableAnimations: options.enableAnimations !== false
        };
        
        // UI元素
        this.loadingIndicator = null;
        this.progressBar = null;
        this.progressBarInner = null;
        
        this.init();
    }
    
    /**
     * 初始化虚拟滚动器
     */
    init() {
        // 创建视口容器
        this.viewport = document.createElement('div');
        this.viewport.style.position = 'relative';
        this.viewport.style.width = '100%';
        this.viewport.style.height = '100%';
        this.viewport.style.overflow = 'hidden';
        
        // 创建哨兵元素（撑开滚动条）
        this.sentinel = document.createElement('div');
        this.sentinel.style.position = 'absolute';
        this.sentinel.style.top = '0';
        this.sentinel.style.left = '0';
        this.sentinel.style.width = '100%';
        this.sentinel.style.pointerEvents = 'none';
        
        // 创建测量容器（屏幕外）
        this.measurementContainer = document.createElement('div');
        this.measurementContainer.style.position = 'absolute';
        this.measurementContainer.style.top = '-9999px';
        this.measurementContainer.style.left = '-9999px';
        this.measurementContainer.style.width = this.container.offsetWidth + 'px';
        this.measurementContainer.style.visibility = 'hidden';
        this.measurementContainer.style.pointerEvents = 'none';
        
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
     */
    createVisualElements() {
        // 创建加载指示器
        if (this.visualOptions.showLoadingAnimation) {
            this.loadingIndicator = document.createElement('div');
            this.loadingIndicator.className = 'virtual-scroll-loading';
            this.loadingIndicator.innerHTML = `
                <div class="loading-spinner"></div>
                <div class="loading-text">正在加载...</div>
            `;
            this.loadingIndicator.style.display = 'none';
            this.container.appendChild(this.loadingIndicator);
        }
        
        // 创建进度条
        this.progressBar = document.createElement('div');
        this.progressBar.className = 'virtual-scroll-progress';
        this.progressBar.innerHTML = '<div class="virtual-scroll-progress-bar"></div>';
        this.progressBarInner = this.progressBar.querySelector('.virtual-scroll-progress-bar');
        document.body.appendChild(this.progressBar);
    }
    
    /**
     * 绑定事件监听器
     */
    bindEvents() {
        // 绑定事件时保存引用，以便正确移除
        this.boundHandleScroll = this.handleScroll.bind(this);
        this.boundHandleResize = this.handleResize.bind(this);
        
        // 将容器设为可滚动，避免监听 window 产生的多余重排
        this.container.style.overflowY = 'auto';
        this.container.addEventListener('scroll', this.boundHandleScroll, { passive: true });
        window.addEventListener('resize', this.boundHandleResize);
    }
    
    /**
     * 设置数据项
     */
    setItems(items) {
        if (!Array.isArray(items)) {
            console.warn('VirtualScroller: setItems 需要数组参数');
            return;
        }
        
        this.items = items;
        this.updateScrollHeight();
        this.render();
    }
    
    /**
     * 更新滚动高度
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
        
        this.sentinel.style.height = totalHeight + 'px';
    }
    
    /**
     * 计算可见范围
     */
    calculateVisibleRange() {
        if (!this.items || this.items.length === 0) {
            return { startIndex: 0, endIndex: 0 };
        }
        
        const scrollTop = this.container.scrollTop;
        const visibleTop = scrollTop;
        const visibleBottom = scrollTop + this.viewportHeight;
        
        // 找到可见范围内的项目
        let startIndex = 0;
        let endIndex = 0;
        let currentTop = 0;
        
        // 计算开始索引
        for (let i = 0; i < this.items.length; i++) {
            const itemHeight = this.measurementCache.has(i) 
                ? this.measurementCache.get(i).height 
                : this.estimatedItemHeight;
            
            if (currentTop + itemHeight > visibleTop - (this.buffer * this.estimatedItemHeight)) {
                startIndex = i;
                break;
            }
            currentTop += itemHeight;
        }
        
        // 计算结束索引（从startIndex开始，避免重复计算）
        for (let i = startIndex; i < this.items.length; i++) {
            const itemHeight = this.measurementCache.has(i) 
                ? this.measurementCache.get(i).height 
                : this.estimatedItemHeight;
            
            if (currentTop > visibleBottom + (this.buffer * this.estimatedItemHeight)) {
                endIndex = i;
                break;
            }
            currentTop += itemHeight;
        }
        
        if (endIndex === 0) endIndex = this.items.length;
        
        return { startIndex, endIndex };
    }
    
    /**
     * 测量项目（两阶段渲染的第一阶段）
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
            this.measurementContainer.innerHTML = '';
            
            // 创建测量用的DOM元素
            const measurementElements = [];
            for (const index of itemsToMeasure) {
                const item = this.items[index];
                const element = document.createElement('div');
                element.style.position = 'absolute';
                element.style.top = '0';
                element.style.left = '0';
                element.style.width = '100%';
                
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
                        const rect = element.getBoundingClientRect();
                        const cached = this.measurementCache.get(index);
                        if (cached && Math.abs((rect.height || 0) - (cached.height || 0)) >= 1) {
                            this.measurementCache.set(index, {
                                height: rect.height,
                                top: cached.top,
                                left: cached.left,
                                width: rect.width
                            });
                            changed = true;
                        }
                    }
                    if (changed) {
                        this.updateScrollHeight();
                        this.render();
                    }
                }, 200);
            }
            
        } catch (error) {
            console.error('测量项目失败:', error);
        } finally {
            this.isMeasuring = false;
        }
    }
    
    /**
     * 应用瀑布流布局到测量元素
     */
    async applyMasonryLayoutToElements(elements) {
        try {
            // 导入瀑布流布局计算函数
            const { calculateMasonryLayout } = await import('./masonry.js');
            
            // 提取元素数组
            const elementArray = elements.map(e => e.element);
            
            // 调用真实的瀑布流布局计算
            const layoutInfo = calculateMasonryLayout(this.measurementContainer, elementArray);
            
            return layoutInfo;
        } catch (error) {
            console.error('瀑布流布局计算失败:', error);
            
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
     */
    render() {
        const startTime = performance.now();
        
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
                    element.classList.add('virtual-scroll-item-exit');
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
                    element.style.top = measurement.top + 'px';
                    element.style.left = measurement.left + 'px';
                    element.style.width = measurement.width + 'px';
                    element.style.minHeight = '';
                } else {
                    // 使用预估位置
                    const estimatedTop = i * this.estimatedItemHeight;
                    element.style.top = estimatedTop + 'px';
                    // 为未测量项提供占位高度，减少布局抖动
                    element.style.minHeight = this.estimatedItemHeight + 'px';
                }
                
                // 渲染项目内容
                element.innerHTML = '';
                this.renderCallback(item, element, i);
                batchFragment.appendChild(element);
                this.visibleItems.set(i, element);
                
                // 添加进入动画
                if (this.visualOptions.enableAnimations) {
                    element.classList.add('virtual-scroll-item-enter');
                    requestAnimationFrame(() => {
                        element.classList.add('virtual-scroll-item-enter-active');
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
        
        // 性能监控
        const endTime = performance.now();
        this.updatePerformanceMetrics(endTime - startTime);
        this.adjustBufferByFps();
        
        // 隐藏加载动画
        if (this.loadingIndicator) {
            this.hideLoadingAnimation();
        }
        
        this.startIndex = startIndex;
        this.endIndex = endIndex;
    }

    // 从复用池获取节点
    getPooledNode() {
        if (this.nodePool.length > 0) {
            return this.nodePool.pop();
        }
        return document.createElement('div');
    }

    // 释放节点到复用池
    releaseNode(element) {
        if (!element) return;
        try {
            element.removeAttribute('style');
            element.className = '';
            element.innerHTML = '';
        } catch {}
        if (this.nodePool.length < this.maxPoolSize) {
            this.nodePool.push(element);
        }
    }
    
    /**
     * 显示加载动画
     */
    showLoadingAnimation() {
        if (this.loadingIndicator) {
            this.loadingIndicator.style.display = 'flex';
        }
    }
    
    /**
     * 隐藏加载动画
     */
    hideLoadingAnimation() {
        if (this.loadingIndicator) {
            this.loadingIndicator.style.display = 'none';
        }
    }
    
    /**
     * 更新进度条
     */
    updateProgressBar() {
        if (this.progressBar && this.items.length > 0) {
            const progress = (this.scrollTop / (this.sentinel.offsetHeight - this.viewportHeight)) * 100;
            if (this.progressBarInner) {
                this.progressBarInner.style.width = `${Math.min(100, Math.max(0, progress))}%`;
            }
        }
    }
    
    /**
     * 更新性能指标
     */
    updatePerformanceMetrics(renderTime) {
        this.performanceMetrics.renderTime = renderTime;
        
        const now = performance.now();
        const frameTime = now - this.performanceMetrics.lastFrameTime;
        this.performanceMetrics.frameRate = frameTime > 0 ? 1000 / frameTime : 0;
        this.performanceMetrics.lastFrameTime = now;
        if (this.performanceMetrics.frameRate > 0 && this.performanceMetrics.frameRate < 120) {
            this.fpsSamples.push(this.performanceMetrics.frameRate);
            if (this.fpsSamples.length > this.performanceWindow) this.fpsSamples.shift();
        }
    }

    // 根据 FPS 平均值自适应调整缓冲区大小
    adjustBufferByFps() {
        if (this.fpsSamples.length < 5) return;
        const now = performance.now();
        if (now - this.lastBufferAdjust < 1000) return; // 每秒最多调整一次
        const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
        let newBuffer = this.buffer;
        if (avg < 45) newBuffer = Math.max(6, this.buffer - 2);
        else if (avg > 58) newBuffer = Math.min(30, this.buffer + 2);
        if (newBuffer !== this.buffer) {
            this.buffer = newBuffer;
            this.lastBufferAdjust = now;
        }
    }
    
    /**
     * 处理滚动事件
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
     */
    handleResize() {
        if (!this.container) return;
        
        this.updateViewportHeight();
        this.updateScrollHeight();
        this.render();
    }
    
    /**
     * 更新视口高度
     */
    updateViewportHeight() {
        if (!this.container) return;
        this.viewportHeight = this.container.clientHeight;
    }
    
    /**
     * 默认渲染回调
     */
    defaultRenderCallback(item, element, index) {
        element.className = 'virtual-item';
        element.style.height = '300px';
        element.style.border = '1px solid #ccc';
        element.textContent = `Item ${index}`;
    }
    
    /**
     * 销毁虚拟滚动器
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
            this.viewport.innerHTML = '';
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

// 导出虚拟滚动器
export { VirtualScroller };