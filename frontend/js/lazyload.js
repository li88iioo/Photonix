import { state } from './state.js';
import { AbortBus } from './abort-bus.js';
import { triggerMasonryUpdate } from './masonry.js';
import { getAuthToken } from './auth.js';

/**
 * 图片加载成功处理函数
 * @param {Event} event - 图片加载事件
 */
function handleImageLoad(event) {
    const img = event.target;
    const status = img.dataset.thumbStatus;
    // 当缩略图仍在生成中或失败时，保留占位，不标记为 loaded
    if (status === 'processing') {
        img.classList.add('processing');
        return;
    }
    if (status === 'failed') {
        img.classList.add('error');
        return;
    }
    img.classList.add('loaded');
    // 清理可能残留的处理中/错误态样式与标记，避免覆盖正常显示
    img.classList.remove('processing', 'error');
    img.dataset.thumbStatus = '';
    // 释放已用完的 blob URL，避免内存占用（加载完成后即可安全释放）
    try {
        if (img.src && img.src.startsWith('blob:')) {
            URL.revokeObjectURL(img.src);
        }
    } catch {}
    const parent = img.closest('.photo-item, .album-card');
    if (parent) parent.querySelector('.image-placeholder')?.remove();
    triggerMasonryUpdate();
}

/**
 * 图片加载失败处理函数
 * @param {Event} event - 图片错误事件
 */
function handleImageError(event) {
    const img = event.target;
    img.onerror = null; // 防止错误循环
    // 使用内联 SVG 作为兜底占位，避免对静态 /assets 的依赖
    const brokenSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
            <rect width="100" height="100" fill="#374151"/>
            <g fill="none" stroke="#C084FC" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 70 L38 50 L55 65 L70 55 L82 70"/>
                <circle cx="65" cy="35" r="7" fill="#C084FC" stroke="none"/>
            </g>
            <text x="50" y="90" text-anchor="middle" fill="#9CA3AF" font-size="10" font-family="Arial, sans-serif">BROKEN</text>
        </svg>`;
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(brokenSvg);
    img.classList.add('error');
    img.classList.remove('blurred');
    // 保留占位元素，等待后续重试或 SSE 推送
}

/**
 * 为懒加载图片发起一次性加载请求
 * 不再轮询，而是依赖 SSE 事件来处理正在生成的缩略图
 * @param {HTMLImageElement} img - 图片元素
 */
async function requestLazyImage(img) {
    const thumbnailUrl = img.dataset.src;
    if (!thumbnailUrl || thumbnailUrl.includes('undefined') || thumbnailUrl.includes('null')) {
        console.error('Lazy load failed: Invalid image URL:', thumbnailUrl);
        img.dispatchEvent(new Event('error'));
        return;
    }

    // 如果已完成加载，或已有真实 src（非 data: 与非 blob:），则不重复请求
    if (img.classList.contains('loaded')) return;
    if (img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:')) return;

    try {
        const token = getAuthToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const signal = AbortBus.get('thumb'); // 使用全局 AbortBus 来取消请求

        const response = await fetch(thumbnailUrl, { headers, signal });

        if (response.status === 200) {
            // 成功获取，直接加载
            const imageBlob = await response.blob();
            img.dataset.thumbStatus = '';
            try { if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src); } catch {}
            img.src = URL.createObjectURL(imageBlob);
        } else if (response.status === 202) {
            // 正在处理：显示占位缩略图，但不移除占位层，等待 SSE 刷新（静默）
            const imageBlob = await response.blob();
            img.dataset.thumbStatus = 'processing';
            try { if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src); } catch {}
            img.src = URL.createObjectURL(imageBlob);
        } else if (response.status === 500 && (response.headers.get('X-Thumb-Status') === 'failed')) {
            // 失败：展示后端返回的失败占位图，保留占位层
            const imageBlob = await response.blob();
            img.dataset.thumbStatus = 'failed';
            try { if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src); } catch {}
            img.src = URL.createObjectURL(imageBlob);
        } else {
            // 其他错误状态
            throw new Error(`Server responded with status: ${response.status}`);
        }
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error('Failed to fetch lazy-load image:', thumbnailUrl, error);
            img.dispatchEvent(new Event('error'));
        }
    }
}

/**
 * 设置懒加载功能
 * 使用 Intersection Observer 监听图片可见性
 */
export function setupLazyLoading() {
    const imageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const img = entry.target;

                img.onload = handleImageLoad;
                img.onerror = handleImageError;

                requestLazyImage(img);

                if (!img._noContextMenuBound) {
                    img.addEventListener('contextmenu', e => e.preventDefault());
                    img._noContextMenuBound = true;
                }
                
                if (state.isBlurredMode) img.classList.add('blurred');
                
                observer.unobserve(img);
            }
        });
    }, {
        rootMargin: '200px 0px',
        threshold: 0.01
    });

    document.querySelectorAll('.lazy-image').forEach(img => {
        if (!img._observed) {
            imageObserver.observe(img);
            img._observed = true;
        }
    });
}
