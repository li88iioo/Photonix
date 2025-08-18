// frontend/js/loading-states.js

/**
 * 智能加载状态管理系统
 * 提供渐进式加载、智能骨架屏和错误状态处理
 */

import { elements, state } from './state.js';

/**
 * 加载状态管理器
 */
class LoadingStateManager {
    constructor() {
        // 简化构造函数，移除不再使用的属性
    }


    /**
     * 显示错误状态
     * @param {string} title - 错误标题
     * @param {string} message - 错误消息
     * @param {Array} actions - 操作按钮数组
     */
    showErrorState(title, message, actions = []) {
        // 清理虚拟滚动器
        const scroller = state.get('virtualScroller');
        if (scroller) {
            scroller.destroy();
            state.update('virtualScroller', null);
        }

        // 隐藏无限滚动加载器
        if (elements.infiniteScrollLoader) {
            elements.infiniteScrollLoader.classList.add('hidden');
        }

        // 确保移除虚拟滚动与瀑布流模式，避免空状态被重排
        if (elements.contentGrid) {
            elements.contentGrid.classList.remove('virtual-scroll-mode');
            elements.contentGrid.classList.remove('masonry-mode');
            elements.contentGrid.style.height = 'auto';
        }

        const errorHTML = `
            <div class="error-container">
                <div class="error-illustration">
                    <div class="error-icon-container">
                        <svg class="error-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                        </svg>
                        <div class="error-icon-glow"></div>
                    </div>
                    <div class="error-pulse"></div>
                </div>
                <div class="error-content">
                    <h2 class="error-title">${title}</h2>
                    ${message ? `<p class="error-message">${message}</p>` : ''}
                    ${actions.length > 0 ? `
                        <div class="error-actions">
                            ${actions.map((action, index) => `
                                <button class="error-btn ${action.primary ? 'error-btn-primary' : 'error-btn-secondary'}" 
                                        data-action="${action.onClick}" data-index="${index}">
                                    ${action.text}
                                </button>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;

        if (elements.contentGrid) {
            elements.contentGrid.innerHTML = errorHTML;

            // 添加事件监听器
            const buttons = elements.contentGrid.querySelectorAll('.error-btn');
            buttons.forEach(button => {
                button.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // 使用 currentTarget 确保获取到按钮元素本身
                    const action = e.currentTarget.dataset.action;
                    console.log('Error button clicked:', action); // 调试日志
                    if (action === 'reload') {
                        window.location.reload();
                    } else if (action === 'home') {
                        window.location.hash = '#/';
                    }
                });
            });
        }
    }

    

    /**
     * 显示空状态
     * @param {string} title - 空状态标题
     * @param {string} message - 空状态消息
     * @param {Array} actions - 操作按钮数组
     */
    showEmptyState(title, message, actions = []) {
        // 清理虚拟滚动器
        const scroller = state.get('virtualScroller');
        if (scroller) {
            scroller.destroy();
            state.update('virtualScroller', null);
        }

        // 隐藏无限滚动加载器
        if (elements.infiniteScrollLoader) {
            elements.infiniteScrollLoader.classList.add('hidden');
        }

        // 确保移除虚拟滚动与瀑布流模式，避免空状态被重排
        if (elements.contentGrid) {
            elements.contentGrid.classList.remove('virtual-scroll-mode');
            elements.contentGrid.classList.remove('masonry-mode');
            elements.contentGrid.style.height = 'auto';
        }

        const emptyHTML = `
            <div class="empty-state">
                <div class="empty-illustration">
                    <div class="empty-icon-container">
                        <svg class="empty-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                        </svg>
                        <div class="empty-icon-glow"></div>
                    </div>
                    <div class="empty-dots">
                        <div class="empty-dot"></div>
                        <div class="empty-dot"></div>
                        <div class="empty-dot"></div>
                    </div>
                </div>
                <div class="empty-content">
                    <h2 class="empty-title">${title}</h2>
                    ${message ? `<p class="empty-message">${message}</p>` : ''}
                    ${actions.length > 0 ? `
                        <div class="empty-actions">
                            ${actions.map((action, index) => `
                                <button class="empty-btn ${action.primary ? 'empty-btn-primary' : 'empty-btn-secondary'}" 
                                        data-action="${action.onClick}" data-index="${index}">
                                    ${action.text}
                                </button>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;

        if (elements.contentGrid) {
            elements.contentGrid.innerHTML = emptyHTML;

            // 添加事件监听器
            const buttons = elements.contentGrid.querySelectorAll('.empty-btn');
            buttons.forEach(button => {
                button.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // 使用 currentTarget 确保获取到按钮元素本身
                    const action = e.currentTarget.dataset.action;
                    console.log('Empty button clicked:', action); // 调试日志
                    if (action === 'reload') {
                        window.location.reload();
                    } else if (action === 'home') {
                        window.location.hash = '#/';
                    } else if (action === 'browse') {
                        window.location.hash = '#/browse';
                    } else if (action === 'back') {
                        history.back();
                    }
                });
            });
        }
    }


}

// 创建全局加载状态管理器实例
export const loadingStateManager = new LoadingStateManager();

/**
 * 便捷的加载状态函数
 */



/**
 * 显示网络错误状态
 */
export function showNetworkError() {
    loadingStateManager.showErrorState(
        '无法连接到服务器，请检查网络连接后重试',
        '',
        [
            {
                text: '重试',
                primary: true,
                onClick: 'reload'
            },
            {
                text: '返回首页',
                primary: false,
                onClick: 'home'
            }
        ]
    );
}

/**
 * 显示首占屏骨架位网格，避免内容加载前出现空白
 * @param {number} preferredCount 可选的建议数量
 */
export function showSkeletonGrid(preferredCount) {
    try {
        const grid = elements.contentGrid;
        if (!grid) return;
        // 仅在 App 可见时渲染骨架，避免登录页布局被撑开
        const appVisible = document.getElementById('app-container')?.classList.contains('opacity-100');
        if (!appVisible) return;
        // 保持布局稳定：此处不强制添加 masonry-mode，避免样式切换时宽度测量抖动
        // grid.classList.add('masonry-mode');
        // 注入一次骨架动画样式（无需重新构建CSS）
        if (!document.getElementById('skeleton-style')) {
            const style = document.createElement('style');
            style.id = 'skeleton-style';
            style.textContent = `
                /* 骨架网格：两侧与容器齐平，随屏宽自适应列数 */
                #skeleton-grid.skeleton-grid {
                    --gap: 16px;
                    --min-col: 210px;
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(var(--min-col), 1fr));
                    gap: var(--gap);
                    justify-content: start;
                    align-content: start;
                }
                /* 小屏列宽更窄，便于移动端适配 */
                @media (max-width: 640px) {
                    #skeleton-grid.skeleton-grid { --min-col: 160px; --gap: 12px; }
                }
                #skeleton-grid .skeleton-card {
                    position: relative;
                    width: 100%;
                    aspect-ratio: 2 / 3;
                    border-radius: 0.5rem;
                    overflow: hidden;
                    background: #1f2937; /* bg-gray-800 */
                    box-shadow: 0 10px 15px -3px rgba(0,0,0,.3), 0 4px 6px -4px rgba(0,0,0,.3);
                    overflow: hidden;
                    transform: translateY(6px);
                    opacity: 0;
                    animation: skeleton-enter 260ms ease-out forwards, skeleton-pulse 1600ms ease-in-out infinite;
                }
                #skeleton-grid .skeleton-card::after {
                    content: '';
                    position: absolute; inset: 0;
                    background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0.10), rgba(255,255,255,0));
                    transform: translateX(-150%);
                    animation: skeleton-shimmer 1400ms linear infinite;
                }
                @keyframes skeleton-enter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes skeleton-pulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.08); } }
                @keyframes skeleton-shimmer { 0% { transform: translateX(-150%); } 100% { transform: translateX(150%); } }
            `;
            document.head.appendChild(style);
        }
        // 依据容器宽度与视口高度精确估算列数与行数，尽量填满首屏
        const containerRect = grid.getBoundingClientRect();
        // 更稳健的宽度测量：多重回退，避免偶发为 0 或过小
        let containerWidth = Math.max(
            0,
            containerRect.width,
            grid.clientWidth,
            grid.offsetWidth,
            grid.parentElement?.getBoundingClientRect()?.width || 0,
            window.innerWidth
        );

        // 若在桌面端测得异常小宽度（例如仅一列），在下一帧重试一次，避免早期测量抖动
        const retryKey = 'data-skeleton-retried';
        const isDesktop = window.innerWidth >= 768;
        if (isDesktop && containerWidth < 300 && !grid.hasAttribute(retryKey)) {
            grid.setAttribute(retryKey, '1');
            requestAnimationFrame(() => {
                // 二次测量后重新渲染骨架
                showSkeletonGrid(preferredCount);
            });
            return;
        }
        grid.removeAttribute(retryKey);
        const isSmall = window.innerWidth <= 640;
        const gap = isSmall ? 12 : 16;        // 与样式中的 --gap 对齐
        const minCol = isSmall ? 160 : 210;   // 与样式中的 --min-col 对齐

        // 估算列数：与 grid-template-columns: repeat(auto-fit, minmax(minCol,1fr)) 保持一致
        const columns = Math.max(1, Math.floor((containerWidth + gap) / (minCol + gap)));

        // 推算单卡尺寸（保持与 aspect-ratio: 2/3 一致）
        const columnWidth = Math.max(1, Math.floor((containerWidth - gap * (columns - 1)) / columns));
        const cardHeight = Math.floor(columnWidth * 3 / 2);

        // 计算从容器顶到视口底的可用高度，尽量填满而不过多留白
        const availableHeight = Math.max(0, window.innerHeight - (containerRect.top || 0) - 8);
        const rows = Math.max(3, Math.ceil((availableHeight + gap) / (cardHeight + gap)));

        const count = preferredCount || (columns * rows);
        const skeletons = new Array(count).fill(0).map(() => (
            '<div class="skeleton-card"></div>'
        )).join('');
        grid.innerHTML = `<div id="skeleton-grid" class="skeleton-grid">${skeletons}</div>`;

        // 计算骨架栅格的总高度，并覆盖 content-grid 的最小高度，避免出现额外留白可滚动区域
        const totalSkeletonHeight = rows * cardHeight + Math.max(0, rows - 1) * gap;
        const desiredMinHeight = Math.max(totalSkeletonHeight, availableHeight);
        grid.style.minHeight = `${desiredMinHeight}px`;

        // 再次校准：实际渲染高度可能与理论值有差异（字体/滚动条/过渡等导致）
        // 使用下一帧测量骨架容器高度，收敛 min-height，消除“可向下滚动的大段留白”
        requestAnimationFrame(() => {
            const skeletonEl = document.getElementById('skeleton-grid');
            if (!skeletonEl) return;
            const actualHeight = Math.ceil(skeletonEl.getBoundingClientRect().height);
            if (Number.isFinite(actualHeight) && actualHeight > 0) {
                const clamped = Math.max(availableHeight, actualHeight);
                grid.style.minHeight = `${clamped}px`;
            }
        });
    } catch {}
}

/**
 * 显示空搜索结果状态
 */
export function showEmptySearchResults(query) {
    // 隐藏无限滚动加载器
    if (elements.infiniteScrollLoader) {
        elements.infiniteScrollLoader.classList.add('hidden');
    }

    loadingStateManager.showEmptyState(
        `没有找到与"${query}"相关的相册或图片。请尝试其他关键词。`,
        '',
        [
            {
                text: '返回首页',
                primary: true,
                onClick: 'home'
            }
        ]
    );
}

/**
 * 显示空相册状态
 */
export function showEmptyAlbum() {
    // 隐藏无限滚动加载器
    if (elements.infiniteScrollLoader) {
        elements.infiniteScrollLoader.classList.add('hidden');
    }

    loadingStateManager.showEmptyState(
        '这个相册还没有任何图片或视频',
        '',
        [
            {
                text: '返回上级',
                primary: true,
                onClick: 'back'
            }
        ]
    );
}

/**
 * 显示现代化后端连接状态
 */
// 连接态展示已在应用层用骨架/占位统一处理，无需单独导出 API

/**
* 显示搜索索引构建中错误状态
*/
export function showIndexBuildingError() {
    // 隐藏无限滚动加载器
    if (elements.infiniteScrollLoader) {
        elements.infiniteScrollLoader.classList.add('hidden');
    }

    loadingStateManager.showErrorState(
        '搜索功能暂时不可用，索引正在后台构建中，请稍后再试',
        '',
        [
            {
                text: '重试',
                primary: true,
                onClick: 'reload'
            },
            {
                text: '返回首页',
                primary: false,
                onClick: 'home'
            }
        ]
    );
}


