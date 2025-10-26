/**
 * @file topbar-interactions.js
 * @description 顶栏交互功能 - 搜索框展开、面包屑展开等
 */

import { createModuleLogger } from '../core/logger.js';

const topbarLogger = createModuleLogger('TopbarInteractions');

/**
 * 初始化搜索框展开/收缩功能
 */
export function initializeSearchExpansion() {
    const searchContainer = document.querySelector('.search-container');
    const searchInput = document.getElementById('search-input');
    const searchButton = document.getElementById('search-expand-btn');
    
    if (!searchContainer || !searchInput) {
        topbarLogger.warn('搜索框元素未找到');
        return;
    }
    
    if (!searchButton) {
        topbarLogger.warn('搜索展开按钮未找到，跳过展开功能初始化');
        return;
    }
    
    // 点击搜索按钮展开/收缩
    searchButton.addEventListener('click', (e) => {
        e.stopPropagation();
        const isActive = searchContainer.classList.contains('search-active');
        
        if (!isActive) {
            searchContainer.classList.add('search-active');
            setTimeout(() => searchInput.focus(), 300);
        } else {
            searchContainer.classList.remove('search-active');
            searchInput.blur();
        }
    });
    
    // 点击输入框时保持展开状态
    searchInput.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    
    // 点击页面其他地方时收缩
    document.addEventListener('click', (e) => {
        if (!searchContainer.contains(e.target)) {
            searchContainer.classList.remove('search-active');
        }
    });
    
    topbarLogger.info('搜索框展开功能已初始化');
}

/**
 * 处理面包屑展开/收缩
 * @param {boolean} shouldExpand - 是否展开
 */
export function toggleBreadcrumb(shouldExpand) {
    const topbar = document.getElementById('topbar');
    const breadcrumbNav = document.getElementById('breadcrumb-nav');
    
    if (!topbar) {
        topbarLogger.warn('顶栏元素未找到');
        return;
    }
    
    if (shouldExpand) {
        topbar.classList.add('is-extended');
        topbarLogger.debug('面包屑已展开');
    } else {
        topbar.classList.remove('is-extended');
        if (breadcrumbNav) {
            breadcrumbNav.innerHTML = '';
        }
        topbarLogger.debug('面包屑已收缩');
    }
}

/**
 * 更新面包屑内容
 * @param {string} path - 当前路径
 */
export function updateBreadcrumb(path) {
    const breadcrumbNav = document.getElementById('breadcrumb-nav');
    if (!breadcrumbNav) return;
    
    // 清空首页的面包屑
    if (!path || path === '') {
        toggleBreadcrumb(false);
        return;
    }
    
    // 构建面包屑
    const parts = path.split('/').filter(p => p);
    if (parts.length === 0) {
        toggleBreadcrumb(false);
        return;
    }
    
    let currentPath = '';
    const breadcrumbHTML = ['<a href="#/">首页</a>'];
    
    parts.forEach((part, index) => {
        currentPath += (currentPath ? '/' : '') + part;
        const isLast = index === parts.length - 1;
        breadcrumbHTML.push('<span>/</span>');
        
        if (isLast) {
            breadcrumbHTML.push(`<span class="current">${decodeURIComponent(part)}</span>`);
        } else {
            breadcrumbHTML.push(`<a href="#/${encodeURIComponent(currentPath)}">${decodeURIComponent(part)}</a>`);
        }
    });
    
    breadcrumbNav.innerHTML = breadcrumbHTML.join('');
    toggleBreadcrumb(true);
    
    topbarLogger.debug('面包屑已更新', { path });
}

/**
 * 初始化顶栏交互功能
 */
export function initializeTopbarInteractions() {
    try {
        initializeSearchExpansion();
        
        // 将updateBreadcrumb暴露到全局，以便其他模块调用
        window.__updateBreadcrumb = updateBreadcrumb;
        
        topbarLogger.info('顶栏交互功能已初始化');
    } catch (error) {
        topbarLogger.error('顶栏交互初始化失败', error);
    }
}
