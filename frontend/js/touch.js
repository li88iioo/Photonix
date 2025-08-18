// frontend/js/touch.js
/**
 * 一个帮助类，用于管理 DOM 元素上的滑动收拾。
 * 新增了对"滑动后不放"手势的支持，以实现快速连续翻页。
 */
export class SwipeHandler {
    /**
     * @param {HTMLElement} element 要监听滑动的元素。
     * @param {object} [options]
     * @param {number} [options.threshold=50] 识别为有效滑动的最小像素距离。
     * @param {number} [options.fastSwipeSpeed=300] 快速滑动时触发翻页的间隔时间（毫秒）。
     * @param {function(string): void} [options.onSwipe] 单次滑动后的回调函数 ('left', 'right')。
     * @param {function(string): void} [options.onFastSwipe] 快速滑动状态下，周期性触发的回调。
     */
    constructor(element, options = {}) {
        this.element = element;
        this.threshold = options.threshold || 50;
        this.fastSwipeSpeed = options.fastSwipeSpeed || 300; // 默认0.3秒快速翻页间隔
        this.onSwipe = options.onSwipe;
        this.onFastSwipe = options.onFastSwipe;

        this.touchStartX = 0;
        this.touchStartY = 0;
        this.touchEndX = 0;
        this.touchEndY = 0;

        // 新增状态变量
        this.fastSwipeInterval = null;
        this.fastSwipeDirection = null;
        this.isTouchActive = false; // 标记触摸是否活跃
        this.hasSwiped = false; // 标记是否已经触发过滑动
        this.swipeDirection = null; // 记录滑动方向

        // 绑定方法以确保 'this' 指向正确
        this.handleTouchStart = this.handleTouchStart.bind(this);
        this.handleTouchMove = this.handleTouchMove.bind(this);
        this.handleTouchEnd = this.handleTouchEnd.bind(this);

        this.attach();
    }

    /**
     * 将触摸事件监听器附加到元素上。
     */
    attach() {
        this.element.addEventListener('touchstart', this.handleTouchStart, { passive: true });
        this.element.addEventListener('touchmove', this.handleTouchMove, { passive: true });
        this.element.addEventListener('touchend', this.handleTouchEnd, { passive: true });
    }

    /**
     * 从元素上移除触摸事件监听器。
     */
    detach() {
        this.element.removeEventListener('touchstart', this.handleTouchStart);
        this.element.removeEventListener('touchmove', this.handleTouchMove);
        this.element.removeEventListener('touchend', this.handleTouchEnd);
    }

    handleTouchStart(e) {
        this.resetState(); // 清理之前的状态
        this.touchStartX = e.changedTouches[0].screenX;
        this.touchStartY = e.changedTouches[0].screenY;
        this.isTouchActive = true; // 标记触摸开始
        this.hasSwiped = false; // 重置滑动标记
        this.swipeDirection = null; // 重置滑动方向
    }

    handleTouchMove(e) {
        if (!this.isTouchActive) return;
        
        this.touchEndX = e.changedTouches[0].screenX;
        this.touchEndY = e.changedTouches[0].screenY;

        const deltaX = this.touchEndX - this.touchStartX;
        const deltaY = this.touchEndY - this.touchStartY;

        // 检查是否是有效的横向滑动
        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > this.threshold) {
            const direction = deltaX > 0 ? 'right' : 'left';
            
            // 如果还没有触发过滑动，则触发第一次滑动
            if (!this.hasSwiped) {
                this.hasSwiped = true;
                this.swipeDirection = direction;
                this.onSwipe?.(direction);
            }
            
            // 如果已经滑动过且方向相同，则开始快速翻页
            if (this.hasSwiped && this.swipeDirection === direction && !this.fastSwipeInterval) {
                this.fastSwipeDirection = direction;
                
                // 启动快速翻页定时器
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

    handleTouchEnd() {
        this.isTouchActive = false; // 标记触摸结束
        
        // 如果是快速滑动，则在此处停止并清理
        if (this.fastSwipeInterval) {
            this.stopFastSwipe();
            this.resetCoordinates();
            return; // 结束处理，不触发单次滑动
        }
        
        // 如果没有进行过快速滑动，则检查是否需要触发单次滑动
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
    
    // 停止快速滑动
    stopFastSwipe() {
        clearInterval(this.fastSwipeInterval);
        this.fastSwipeInterval = null;
        this.fastSwipeDirection = null;
    }
    
    // 清理所有与滑动状态相关的计时器和标志位
    resetState() {
        this.stopFastSwipe();
        this.fastSwipeDirection = null;
        this.isTouchActive = false;
        this.hasSwiped = false;
        this.swipeDirection = null;
    }

    // 重置坐标
    resetCoordinates() {
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.touchEndX = 0;
        this.touchEndY = 0;
    }
}