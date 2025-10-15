/**
 * @file touch.js
 * @description 触摸手势处理模块。提供滑动手势（含长按滑动连续翻页）和图片双指缩放/拖拽的支持。
 */

import { safeSetStyle } from '../../shared/dom-utils.js';

/**
 * 滑动处理器类 SwipeHandler
 * 用于监听元素上的滑动手势，支持单次滑动和长按连续滑动。
 */
export class SwipeHandler {
    /**
     * 构造 SwipeHandler 实例
     * @param {HTMLElement} element - 要监听滑动的元素
     * @param {object} [options] - 配置项
     * @param {number} [options.threshold=50] - 识别为有效滑动的最小像素距离
     * @param {number} [options.fastSwipeSpeed=300] - 快速滑动时触发翻页的间隔时间（毫秒）
     * @param {function(string): void} [options.onSwipe] - 单次滑动后的回调函数，参数为 'left' 或 'right'
     * @param {function(string): void} [options.onFastSwipe] - 快速滑动状态下周期性触发的回调，参数为 'left' 或 'right'
     * @param {function(): boolean} [options.shouldAllowSwipe] - 判断当前是否允许滑动的函数
     */
    constructor(element, options = {}) {
        this.element = element;
        this.threshold = options.threshold || 50;
        this.fastSwipeSpeed = options.fastSwipeSpeed || 300;
        this.onSwipe = options.onSwipe;
        this.onFastSwipe = options.onFastSwipe;
        this.shouldAllowSwipe = typeof options.shouldAllowSwipe === 'function' ? options.shouldAllowSwipe : (() => true);

        this.touchStartX = 0;
        this.touchStartY = 0;
        this.touchEndX = 0;
        this.touchEndY = 0;

        // 状态变量
        this.fastSwipeInterval = null;
        this.fastSwipeDirection = null;
        this.isTouchActive = false; // 当前是否处于触摸中
        this.hasSwiped = false;     // 是否已触发过滑动
        this.swipeDirection = null; // 当前滑动方向

        // 绑定事件处理方法
        this.handleTouchStart = this.handleTouchStart.bind(this);
        this.handleTouchMove = this.handleTouchMove.bind(this);
        this.handleTouchEnd = this.handleTouchEnd.bind(this);

        this.attach();
    }

    /**
     * 添加触摸事件监听器
     */
    attach() {
        this.element.addEventListener('touchstart', this.handleTouchStart, { passive: true });
        this.element.addEventListener('touchmove', this.handleTouchMove, { passive: true });
        this.element.addEventListener('touchend', this.handleTouchEnd, { passive: true });
    }

    /**
     * 移除触摸事件监听器
     */
    detach() {
        this.element.removeEventListener('touchstart', this.handleTouchStart);
        this.element.removeEventListener('touchmove', this.handleTouchMove);
        this.element.removeEventListener('touchend', this.handleTouchEnd);
    }

    /**
     * 触摸开始事件处理
     * @param {TouchEvent} e
     */
    handleTouchStart(e) {
        this.resetState();
        this.touchStartX = e.changedTouches[0].screenX;
        this.touchStartY = e.changedTouches[0].screenY;
        this.isTouchActive = true;
        this.hasSwiped = false;
        this.swipeDirection = null;
    }

    /**
     * 触摸移动事件处理
     * @param {TouchEvent} e
     */
    handleTouchMove(e) {
        if (!this.isTouchActive) return;

        this.touchEndX = e.changedTouches[0].screenX;
        this.touchEndY = e.changedTouches[0].screenY;

        const deltaX = this.touchEndX - this.touchStartX;
        const deltaY = this.touchEndY - this.touchStartY;

        // 外部不允许滑动时，停止快速滑动
        if (typeof this.shouldAllowSwipe === 'function' && !this.shouldAllowSwipe()) {
            if (this.fastSwipeInterval) this.stopFastSwipe();
            return;
        }

        // 判断为有效横向滑动
        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > this.threshold) {
            const direction = deltaX > 0 ? 'right' : 'left';

            // 首次滑动
            if (!this.hasSwiped) {
                this.hasSwiped = true;
                this.swipeDirection = direction;
                this.onSwipe?.(direction);
            }

            // 长按同方向，启动快速滑动
            if (this.hasSwiped && this.swipeDirection === direction && !this.fastSwipeInterval) {
                this.fastSwipeDirection = direction;
                this.fastSwipeInterval = setInterval(() => {
                    if (this.isTouchActive) {
                        this.onFastSwipe?.(this.fastSwipeDirection);
                    } else {
                        this.stopFastSwipe();
                    }
                }, this.fastSwipeSpeed);
            }
        }
    }

    /**
     * 触摸结束事件处理
     */
    handleTouchEnd() {
        this.isTouchActive = false;

        // 快速滑动时，结束并清理
        if (this.fastSwipeInterval) {
            this.stopFastSwipe();
            this.resetCoordinates();
            return;
        }

        // 未触发快速滑动时，判断是否需要触发单次滑动
        if (!this.hasSwiped) {
            const deltaX = this.touchEndX - this.touchStartX;
            const deltaY = this.touchEndY - this.touchStartY;

            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > this.threshold) {
                if (deltaX > 0) {
                    this.onSwipe?.('right');
                } else {
                    this.onSwipe?.('left');
                }
            }
        }

        this.resetCoordinates();
    }

    /**
     * 停止快速滑动
     */
    stopFastSwipe() {
        clearInterval(this.fastSwipeInterval);
        this.fastSwipeInterval = null;
        this.fastSwipeDirection = null;
    }

    /**
     * 重置滑动相关状态
     */
    resetState() {
        this.stopFastSwipe();
        this.fastSwipeDirection = null;
        this.isTouchActive = false;
        this.hasSwiped = false;
        this.swipeDirection = null;
    }

    /**
     * 重置触摸坐标
     */
    resetCoordinates() {
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.touchEndX = 0;
        this.touchEndY = 0;
    }
}

/**
 * 启用图片的双指缩放与拖拽
 * @param {HTMLImageElement} img - 目标图片元素
 * @param {HTMLElement} container - 承载手势事件的容器（建议为媒体面板）
 * @returns {Function} 清理函数，调用后移除相关监听
 */
export function enablePinchZoom(img, container) {
    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let startScale = 1;
    let lastDistance = 0;
    let isPanning = false;
    let lastX = 0, lastY = 0;
    const MIN_SCALE = 1;
    const MAX_SCALE = 4;

    if (!img || !container) return () => {};

    // 初始化样式
    safeSetStyle(img, {
        transformOrigin: 'center center',
        touchAction: 'none'
    });
    try { container.dataset.isZoomed = '0'; } catch {}

    /**
     * 计算两指间距离
     * @param {TouchList|Array<Touch>} touches
     * @returns {number}
     */
    function getDistance(touches) {
        const [a, b] = touches;
        return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }

    /**
     * 应用当前缩放和平移变换
     */
    function applyTransform() {
        safeSetStyle(img, 'transform', `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`);
    }

    /**
     * 限制平移范围，防止图片移出边界
     */
    function clampPan() {
        const rect = img.getBoundingClientRect();
        const maxX = (rect.width * (scale - 1)) / 2;
        const maxY = (rect.height * (scale - 1)) / 2;
        translateX = Math.max(-maxX, Math.min(maxX, translateX));
        translateY = Math.max(-maxY, Math.min(maxY, translateY));
    }

    let lastTapTime = 0;
    let lastTapX = 0;
    let lastTapY = 0;

    /**
     * 触摸开始事件处理
     * @param {TouchEvent} e
     */
    function onTouchStart(e) {
        if (e.touches.length === 2) {
            lastDistance = getDistance(e.touches);
            startScale = scale;
            e.preventDefault();
            return;
        }
        if (e.touches.length === 1) {
            isPanning = scale > 1;
            lastX = e.touches[0].clientX;
            lastY = e.touches[0].clientY;
        }
    }

    /**
     * 触摸移动事件处理
     * @param {TouchEvent} e
     */
    function onTouchMove(e) {
        if (e.touches.length === 2) {
            const d = getDistance(e.touches);
            const factor = d / (lastDistance || d);
            scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, startScale * factor));
            clampPan();
            applyTransform();
            try { container.dataset.isZoomed = scale > 1.02 ? '1' : '0'; } catch {}
            e.preventDefault();
            return;
        }
        if (e.touches.length === 1 && isPanning) {
            const x = e.touches[0].clientX;
            const y = e.touches[0].clientY;
            translateX += x - lastX;
            translateY += y - lastY;
            lastX = x;
            lastY = y;
            clampPan();
            applyTransform();
            e.preventDefault();
        }
    }

    /**
     * 触摸结束事件处理
     * @param {TouchEvent} e
     */
    function onTouchEnd(e) {
        // 双击还原/放大
        if (e.touches.length === 0 && e.changedTouches && e.changedTouches.length === 1) {
            const now = Date.now();
            const cx = e.changedTouches[0].clientX;
            const cy = e.changedTouches[0].clientY;
            const dt = now - lastTapTime;
            const dist = Math.hypot(cx - lastTapX, cy - lastTapY);
            if (dt < 280 && dist < 24) {
                scale = scale > 1 ? 1 : 2;
                translateX = 0;
                translateY = 0;
                try { container.dataset.isZoomed = scale > 1.02 ? '1' : '0'; } catch {}
                applyTransform();
            }
            lastTapTime = now;
            lastTapX = cx;
            lastTapY = cy;
        }
    }

    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: true });

    /**
     * 清理函数，移除事件监听并还原样式
     * @returns {void}
     */
    return function cleanup() {
        container.removeEventListener('touchstart', onTouchStart, { passive: false });
        container.removeEventListener('touchmove', onTouchMove, { passive: false });
        container.removeEventListener('touchend', onTouchEnd, { passive: true });
        safeSetStyle(img, {
            transform: '',
            touchAction: ''
        });
        try { delete container.dataset.isZoomed; } catch {}
    };
}