// frontend/js/utils.js

/**
 * 显示通知消息
 * @param {string} message - 要显示的消息内容
 * @param {string} type - 通知类型 ('info', 'success', 'warning', 'error')
 * @param {number} duration - 自动消失时间（毫秒）
 */
// 去重提示：同一 message+type 的通知在可见期内仅保留一条，并累加计数
export function showNotification(message, type = 'info', duration = 3000) {
    // 获取或创建通知容器
    let container = document.getElementById('notification-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'notification-container';
        document.body.appendChild(container);
    }
    const key = `${type}:${String(message)}`;
    // 查找是否已有相同通知
    const existing = Array.from(container.querySelectorAll('.notification'))
        .find(el => el.dataset && el.dataset.key === key);
    if (existing) {
        const count = (Number(existing.dataset.count || '1') + 1);
        existing.dataset.count = String(count);
        const spanEl = existing.querySelector('span');
        if (spanEl) spanEl.textContent = count > 1 ? `${message}（x${count}）` : String(message);
        // 重新计时：延长展示时间
        if (existing._hideTimeout) clearTimeout(existing._hideTimeout);
        existing._hideTimeout = setTimeout(() => remove(existing), duration);
        // 轻微动效反馈（可选，不影响样式不存在时的兼容）
        existing.classList.remove('show');
        // 下一帧再添加以触发过渡
        requestAnimationFrame(() => existing.classList.add('show'));
        return;
    }
    
    // 创建通知元素
    const notif = document.createElement('div');
    notif.className = `notification ${type}`;
    notif.dataset.key = key;
    notif.dataset.count = '1';
    notif.innerHTML = `
        <span>${message}</span>
        <button class="close-btn" aria-label="关闭">&times;</button>
    `;
    container.appendChild(notif);

    // 动画显示
    setTimeout(() => notif.classList.add('show'), 10);

    // 自动消失逻辑
    notif._hideTimeout = setTimeout(() => remove(notif), duration);
    notif.addEventListener('mouseenter', () => {
        if (notif._hideTimeout) clearTimeout(notif._hideTimeout);
    });
    notif.addEventListener('mouseleave', () => {
        notif._hideTimeout = setTimeout(() => remove(notif), duration);
    });

    // 手动关闭按钮
    notif.querySelector('.close-btn').onclick = () => remove(notif);

    // 移除通知的函数
    function remove(el) {
        try { if (el && el._hideTimeout) clearTimeout(el._hideTimeout); } catch {}
        const node = el || notif;
        node.classList.remove('show');
        setTimeout(() => node.remove(), 300);
    }
}

/**
 * 预加载下一批图片
 * @param {Array} currentPhotos - 当前照片数组
 * @param {number} startIndex - 当前显示的起始索引
 */
export function preloadNextImages(currentPhotos, startIndex) {
    // 获取需要预加载的图片（当前索引后的2张图片）
    const toPreload = currentPhotos.slice(startIndex + 1, startIndex + 3);
    
    // 遍历预加载列表，排除视频文件
    toPreload.forEach(url => {
        if (url && !/\.(mp4|webm|mov)$/i.test(url)) {
            const img = new Image();
            img.src = url;
        }
    });
}

/**
 * 内网穿透环境检测和优化
 * 检测是否在内网穿透环境下，并应用相应的优化策略
 */
export function detectTunnelEnvironment() {
    const hostname = window.location.hostname;
    const port = window.location.port;
    
    // 检测常见的内网穿透服务
    const tunnelIndicators = [
        'ngrok.io',
        'ngrok-free.app',
        'tunnelto.dev',
        'localtunnel.me',
        'serveo.net',
        'localhost.run',
        'ngrok.app',
        'frp.com',
        'natapp.cn',
        'sunny-ngrok.com'
    ];
    
    const isTunnel = tunnelIndicators.some(indicator => hostname.includes(indicator)) || 
                     (hostname !== 'localhost' && hostname !== '127.0.0.1' && port !== '12080');
    
    if (isTunnel) {
        console.log('检测到内网穿透环境，应用优化策略');
        
        // 调整请求超时时间
        window.TUNNEL_TIMEOUT = 10000; // 10秒
        
        // 调整重试策略
        window.TUNNEL_RETRY_DELAY = 2000; // 2秒
        
        // 标记为隧道环境
        window.IS_TUNNEL_ENVIRONMENT = true;
    }
    
    return isTunnel;
}

/**
 * 获取适合当前环境的请求配置
 * @returns {Object} 请求配置对象
 */
export function getTunnelOptimizedConfig() {
    const isTunnel = window.IS_TUNNEL_ENVIRONMENT || detectTunnelEnvironment();
    
    return {
        timeout: isTunnel ? 10000 : 5000,
        retries: isTunnel ? 3 : 2,
        retryDelay: isTunnel ? 2000 : 1000,
        keepalive: true
    };
}

/**
 * 调试内网穿透环境下的请求状态
 * @param {string} message - 调试消息
 * @param {any} data - 调试数据
 */
export function debugTunnelRequest(message, data = null) {
    if (window.IS_TUNNEL_ENVIRONMENT) {
        console.debug(`[Tunnel Debug] ${message}`, data);
    }
}

// 在页面加载时检测环境
document.addEventListener('DOMContentLoaded', () => {
    detectTunnelEnvironment();
    
    // 添加全局错误监听，减少内网穿透环境下的错误噪音
    if (window.IS_TUNNEL_ENVIRONMENT) {
        window.addEventListener('error', (event) => {
            // 过滤掉一些常见的网络错误，减少控制台噪音
            if (event.error && event.error.message) {
                const message = event.error.message;
                if (message.includes('Failed to execute \'put\' on \'Cache\'') ||
                    message.includes('net::ERR_ABORTED') ||
                    message.includes('503')) {
                    console.debug('Suppressed tunnel error:', message);
                    event.preventDefault();
                }
            }
        });
    }
});