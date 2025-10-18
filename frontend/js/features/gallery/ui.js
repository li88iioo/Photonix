/**
 * @file ui.js
 * @description UI 渲染模块，负责页面 UI 元素的渲染和更新。
 */

import { state, stateManager } from '../../core/state.js';
import * as api from '../../app/api.js';
import { getAllViewed } from '../../shared/indexeddb-helper.js';
import { applyMasonryLayout, triggerMasonryUpdate } from './masonry.js';
import { MATH, UI } from '../../core/constants.js';
import { uiLogger } from '../../core/logger.js';
import { createProgressCircle, createPlayButton, createGridIcon, createMasonryIcon, createSortArrow, createDeleteIcon, createBackArrow } from '../../shared/svg-utils.js';
import { elements, reinitializeElements } from '../../shared/dom-elements.js';
import { safeSetInnerHTML, safeClassList, safeSetStyle, safeCreateElement, safeGetElementById, safeQuerySelectorAll } from '../../shared/dom-utils.js';

// 向后兼容导出 elements
export { elements };

/**
 * 安全创建 DOM 元素并设置属性和内容
 * @param {string} tag 标签名
 * @param {Object} options 选项
 * @param {Array} options.classes CSS 类名数组
 * @param {Object} options.attributes 属性对象
 * @param {string} options.textContent 文本内容
 * @param {Array} options.children 子元素数组
 * @returns {HTMLElement} 创建的元素
 */
function createElement(tag, { classes = [], attributes = {}, textContent = '', children = [] } = {}) {
    return safeCreateElement(tag, { classes, attributes, textContent, children });
}

/**
 * 格式化时间显示
 * @param {number|string} timestamp 时间戳
 * @returns {string} 格式化后的时间字符串
 */
function formatTime(timestamp) {
    if (timestamp == null || timestamp === '') return '';

    const timestampNum = typeof timestamp === 'number' ? timestamp :
                        typeof timestamp === 'string' ? parseInt(timestamp, 10) :
                        Number(timestamp);

    if (isNaN(timestampNum) || timestampNum <= 0) return '';

    const diff = Date.now() - timestampNum;
    const { SECOND, MINUTE, HOUR, DAY, MONTH, YEAR } = UI.TIME_FORMAT;

    if (diff < MINUTE) return '刚刚';
    if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分钟前`;
    if (diff < DAY) return `${Math.floor(diff / HOUR)}小时前`;
    if (diff < MONTH) return `${Math.floor(diff / DAY)}天前`;
    if (diff < YEAR) return `${Math.floor(diff / MONTH)}个月前`;
    return `${Math.floor(diff / YEAR)}年前`;
}

/**
 * 智能排序缓存（避免频繁查询IndexedDB）
 */
let sortCache = {
    viewedPaths: null,
    timestamp: 0,
    CACHE_TTL: 30000 // ✅ 优化3: 5秒 → 30秒缓存有效期
};

/**
 * 根据已查看状态对相册进行排序
 * 优化版：避免与后端排序冲突，仅在必要时执行
 * 
 * 排序逻辑说明：
 * - smart + 根目录：后端按时间排序 + 前端按查看状态分组（未查看优先）
 * - smart + 子目录：后端已按浏览时间排序，前端跳过（避免冲突）
 * - viewed_desc：后端已排序，前端辅助增强
 * - name/mtime：后端完全处理，前端跳过
 */
export async function sortAlbumsByViewed() {
    const hash = window.location.hash;
    const questionMarkIndex = hash.indexOf('?');
    const urlParams = new URLSearchParams(questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '');
    const currentSort = urlParams.get('sort') || 'smart';
    
    // ✅ 优化2: viewed_desc也启用前端增强排序
    const shouldSort = currentSort === 'smart' || currentSort === 'viewed_desc';
    if (!shouldSort) return;
    
    // ✅ 优化1: 检测是否为子目录（后端已处理浏览排序，避免冲突）
    const pathPart = hash.split('?')[0].substring(2); // 移除 '#/'
    const isSubdirectory = pathPart.length > 0;
    
    // smart模式下，子目录已由后端排序，前端跳过（避免冲突和性能浪费）
    if (currentSort === 'smart' && isSubdirectory) {
        return;
    }
    
    // 使用30秒缓存，避免频繁查询IndexedDB
    const now = Date.now();
    if (!sortCache.viewedPaths || now - sortCache.timestamp > sortCache.CACHE_TTL) {
        const viewedAlbumsData = await getAllViewed();
        sortCache.viewedPaths = viewedAlbumsData.map(item => item.path);
        sortCache.timestamp = now;
    }
    
    const viewedAlbumPaths = sortCache.viewedPaths;
    const albumElements = Array.from(safeQuerySelectorAll('.album-link'));
    
    // 如果没有相册元素，直接返回
    if (albumElements.length === 0) return;
    
    // 排序：未查看的相册排在前面
    albumElements.sort((a, b) => {
        const viewedA = viewedAlbumPaths.includes(a.dataset.path);
        const viewedB = viewedAlbumPaths.includes(b.dataset.path);
        if (viewedA && !viewedB) return 1;  // 已查看后置
        if (!viewedA && viewedB) return -1; // 未查看前置
        return 0; // 同类保持原序（后端排序）
    });
    
    const grid = elements.contentGrid;
    if (!grid) return;
    
    // 使用DocumentFragment批量插入，避免多次reflow
    const fragment = document.createDocumentFragment();
    albumElements.forEach(el => fragment.appendChild(el));
    grid.appendChild(fragment); // 单次DOM操作，触发1次reflow
}

/**
 * 渲染面包屑导航（安全 DOM 操作）
 * @param {string} path 当前路径
 */
export function renderBreadcrumb(path) {
    const breadcrumbNav = elements.breadcrumbNav;
    if (!breadcrumbNav) return;
    
    const parts = path ? path.split('/').filter(p => p) : [];
    let currentPath = '';
    let sortParam = '';
    if (state.entrySort && state.entrySort !== 'smart') sortParam = `?sort=${state.entrySort}`; else {
        const hash = window.location.hash;
        const questionMarkIndex = hash.indexOf('?');
        sortParam = questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '';
    }
    
    // 确保 breadcrumbLinks 和 sortContainer 存在
    let breadcrumbLinks = breadcrumbNav.querySelector('#breadcrumb-links');
    
    if (!breadcrumbLinks) {
        // 初始化：清空并重建结构（仅保留面包屑容器，排序容器在顶栏动作区）
        while (breadcrumbNav.firstChild) {
            breadcrumbNav.removeChild(breadcrumbNav.firstChild);
        }
        breadcrumbLinks = createElement('div', { classes: ['flex-1', 'min-w-0'], attributes: { id: 'breadcrumb-links' } });
        breadcrumbNav.append(breadcrumbLinks);
    }
    
    // 顶栏展开/收起：根据是否有路径切换 is-extended 类（不再调整页面偏移，避免页面上下跳动）
    const topbarContainer = document.getElementById('topbar');
    if (!path || path === '') {
        if (topbarContainer) topbarContainer.classList.remove('is-extended');
    } else {
        if (topbarContainer) topbarContainer.classList.add('is-extended');
    }
    
    // ✅ 首页不显示面包屑导航，只清空 breadcrumbLinks
    if (!path || path === '') {
        while (breadcrumbLinks.firstChild) {
            breadcrumbLinks.removeChild(breadcrumbLinks.firstChild);
        }
        return;
    }
    const container = createElement('div', { classes: ['flex', 'flex-wrap', 'items-center'] });
    
    // 如果来自搜索页，添加"返回搜索"链接
    if (state.fromSearchHash) {
        const searchLink = createElement('a', { 
            classes: ['text-purple-400', 'hover:text-purple-300', 'flex', 'items-center'],
            attributes: { href: state.fromSearchHash, title: '返回搜索结果' }
        });
        searchLink.appendChild(createBackArrow());
        searchLink.appendChild(document.createTextNode('搜索'));
        
        container.appendChild(searchLink);
        container.appendChild(createElement('span', { classes: ['mx-2', 'text-gray-500'], textContent: '|' }));
    }
    
    container.appendChild(createElement('a', { classes: ['text-purple-400', 'hover:text-purple-300'], attributes: { href: `#/${sortParam}` }, textContent: '首页' }));
    parts.forEach((part, index) => {
        currentPath += (currentPath ? '/' : '') + part;
        const isLast = index === parts.length - 1;
        container.appendChild(createElement('span', { classes: ['mx-2'], textContent: '/' }));
        if (isLast) {
            container.appendChild(createElement('span', { classes: ['text-white'], textContent: decodeURIComponent(part) }));
        } else {
            container.appendChild(createElement('a', { classes: ['text-purple-400', 'hover:text-purple-300'], attributes: { href: `#/${encodeURIComponent(currentPath)}${sortParam}` }, textContent: decodeURIComponent(part) }));
        }
    });
    // XSS 安全：使用 DOM 操作替代 innerHTML
    while (breadcrumbLinks.firstChild) {
        breadcrumbLinks.removeChild(breadcrumbLinks.firstChild);
    }
    breadcrumbLinks.appendChild(container);
    setTimeout(() => {
        const sortContainer = elements.sortContainer;
        if (sortContainer) {
            // 不清空容器，避免闪烁
            let toggleWrap = sortContainer.querySelector('#layout-toggle-wrap');
            if (!toggleWrap) {
                const toggle = createLayoutToggle();
                sortContainer.appendChild(toggle.container);
                toggleWrap = toggle.container;
            }
            // 分割线
            if (!sortContainer.querySelector('.layout-divider')) {
                const divider = document.createElement('div');
                divider.className = 'layout-divider';
                sortContainer.appendChild(divider);
            }
            // 排序下拉专用容器
            let sortWrapper = sortContainer.querySelector('#sort-wrapper');
            if (!sortWrapper) {
                sortWrapper = document.createElement('div');
                sortWrapper.id = 'sort-wrapper';
                safeSetStyle(sortWrapper, {
                    display: 'inline-block',
                    position: 'relative'
                });
                sortContainer.appendChild(sortWrapper);
            }
            // 没有媒体文件时才显示排序下拉
            checkIfHasMediaFiles(path)
                .then(hasMedia => {
                    if (!hasMedia) {
                        while (sortWrapper.firstChild) {
                            sortWrapper.removeChild(sortWrapper.firstChild);
                        }
                        renderSortDropdown();
                    } else {
                        while (sortWrapper.firstChild) {
                            sortWrapper.removeChild(sortWrapper.firstChild);
                        }
                    }
                })
                .catch(() => {
                    while (sortWrapper.firstChild) {
                        sortWrapper.removeChild(sortWrapper.firstChild);
                    }
                    renderSortDropdown();
                });
        }
    }, 100);
}

/**
 * 渲染相册卡片（安全 DOM 操作）
 * @param {Object} album 相册数据
 * @returns {HTMLElement} 相册卡片元素
 */
export function displayAlbum(album) {
    const aspectRatio = album.coverHeight ? album.coverWidth / album.coverHeight : 1;
    const timeText = formatTime(album.mtime);
    let sortParam = '';
    if (state.entrySort && state.entrySort !== 'smart') sortParam = `?sort=${state.entrySort}`; else {
        const hash = window.location.hash;
        const questionMarkIndex = hash.indexOf('?');
        sortParam = questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '';
    }
    const img = createElement('img', { classes: ['w-full','h-full','object-cover','absolute','inset-0','lazy-image','transition-opacity','duration-300'], attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': album.coverUrl, alt: album.name } });
    const albumTitle = createElement('div', { classes: ['album-title'], textContent: album.name });
    const albumMetaKids = [createElement('span', { classes: ['album-type'], textContent: '相册' })];
    if (timeText) albumMetaKids.push(createElement('span', { classes: ['album-time'], textContent: timeText }));
    const infoOverlay = createElement('div', { classes: ['card-info-overlay'], children: [albumTitle, createElement('div', { classes: ['album-meta'], children: albumMetaKids })] });

    const deleteTrigger = createElement('button', {
        classes: ['album-delete-trigger'],
        attributes: { type: 'button', 'aria-label': '删除相册' },
        children: [createDeleteIcon()]
    });
    const deleteConfirm = createElement('button', { classes: ['album-delete-confirm'], attributes: { type: 'button' }, textContent: '确认删除' });
    const deleteCancel = createElement('button', { classes: ['album-delete-cancel'], attributes: { type: 'button' }, textContent: '取消' });
    const confirmGroup = createElement('div', { classes: ['album-delete-confirm-group'], children: [deleteConfirm, deleteCancel] });
    const deleteStage = createElement('div', { classes: ['album-delete-stage'], children: [deleteTrigger, confirmGroup] });
    const deleteOverlay = createElement('div', { classes: ['album-delete-overlay'], attributes: { 'data-state': 'idle', 'data-path': album.path }, children: [deleteStage] });

    const relativeDiv = createElement('div', { classes: ['relative'], attributes: { style: `aspect-ratio: ${aspectRatio}` }, children: [createElement('div', { classes: ['image-placeholder','absolute','inset-0'] }), img, infoOverlay, deleteOverlay] });
    const link = createElement('a', { classes: ['album-card','group','block','bg-gray-800','rounded-lg','overflow-hidden','shadow-lg','hover:shadow-purple-500/30','transition-shadow'], attributes: { href: `#/${encodeURIComponent(album.path)}${sortParam}` }, children: [relativeDiv] });
    return createElement('div', { classes: ['grid-item','album-link'], attributes: { 'data-path': album.path, 'data-width': album.coverWidth || 1, 'data-height': album.coverHeight || 1 }, children: [link] });
}

/**
 * 渲染流式媒体项（安全 DOM 操作，增强布局稳定性）
 * @param {string} type 媒体类型
 * @param {Object} mediaData 媒体数据
 * @param {number} index 索引
 * @param {boolean} showTimestamp 是否显示时间戳
 * @returns {HTMLElement} 媒体项元素
 */
export function displayStreamedMedia(type, mediaData, index, showTimestamp) {
    const isVideo = type === 'video';
    const aspectRatio = (mediaData.height && mediaData.width)
        ? mediaData.width / mediaData.height
        : (isVideo ? UI.ASPECT_RATIO.VIDEO_DEFAULT : UI.ASPECT_RATIO.IMAGE_DEFAULT);
    const timeText = showTimestamp ? formatTime(mediaData.mtime) : '';
    
    const placeholderClasses = ['image-placeholder','absolute','inset-0'];
    if (!mediaData.height || !mediaData.width) {
        placeholderClasses.push(`min-h-[${UI.LAYOUT.UNKNOWN_ASPECT_RATIO_MIN_HEIGHT}]`);
    }
    const kids = [createElement('div', { classes: placeholderClasses })];
    const loadingOverlay = createElement('div', { classes: ['loading-overlay'] });
    const progressHolder = createElement('div');
    const svg = createProgressCircle();
    progressHolder.appendChild(svg);
    loadingOverlay.append(progressHolder);
    kids.push(loadingOverlay);
    if (isVideo) {
        kids.push(createElement('img', { classes: ['w-full','h-full','object-cover','absolute','inset-0','lazy-image','transition-opacity','duration-300'], attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': mediaData.thumbnailUrl, alt: '视频缩略图' } }));
        const overlay = createElement('div', { classes: ['video-thumbnail-overlay'] });
        const playBtn = createElement('div', { classes: ['video-play-button'] });
        const playSvg = createPlayButton();
        playBtn.appendChild(playSvg);
        overlay.append(playBtn);
        kids.push(overlay);
    } else {
        kids.push(createElement('img', { classes: ['w-full','h-full','object-cover','absolute','inset-0','lazy-image','transition-opacity','duration-300'], attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': mediaData.thumbnailUrl, alt: '图片缩略图' } }));
    }
    if (timeText) kids.push(createElement('div', { classes: ['absolute','bottom-2','right-2','bg-black/50','text-white','text-sm','px-2','py-1','rounded','shadow-lg'], textContent: timeText }));
    // ✅ 修复：移除min-height，让容器高度完全由aspect-ratio决定
    // min-height会导致瀑布流布局计算错误，引发元素重叠
    const containerStyle = `aspect-ratio: ${aspectRatio};`;
    const relativeDiv = createElement('div', { 
        classes: ['relative','w-full','h-full'], 
        attributes: {
            style: containerStyle,
            'data-aspect-ratio': aspectRatio.toFixed(MATH.ASPECT_RATIO_PRECISION),
            'data-original-width': mediaData.width || 0,
            'data-original-height': mediaData.height || 0
        }, 
        children: kids 
    });
    const photoItem = createElement('div', { classes: ['photo-item','group','block','bg-gray-800','rounded-lg','overflow-hidden','cursor-pointer'], children: [relativeDiv] });
    return createElement('div', { classes: ['grid-item','photo-link'], attributes: { 'data-url': mediaData.originalUrl, 'data-index': index, 'data-width': mediaData.width, 'data-height': mediaData.height }, children: [photoItem] });
}

/**
 * 渲染搜索结果媒体项（安全 DOM 操作）
 * @param {Object} result 搜索结果
 * @param {number} index 索引
 * @returns {HTMLElement} 媒体项元素
 */
export function displaySearchMedia(result, index) {
    const isVideo = result.type === 'video';
    const timeText = formatTime(result.mtime);
    const aspectRatio = result.height ? result.width / result.height : 1;
    const kids = [
        createElement('div', { classes: ['image-placeholder','absolute','inset-0'] }),
        createElement('div', { classes: ['loading-overlay'], children: [createElement('div', { classes: ['progress-circle'] })] })
    ];
    if (isVideo) {
        kids.push(createElement('img', { classes: ['w-full','h-full','object-cover','absolute','inset-0','lazy-image','transition-opacity','duration-300'], attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': result.thumbnailUrl, alt: `视频缩略图：${result.name}` } }));
        const overlay = createElement('div', { classes: ['video-thumbnail-overlay'] });
        const playBtn = createElement('div', { classes: ['video-play-button'] });
        const playSvg = createPlayButton();
        playBtn.appendChild(playSvg);
        overlay.append(playBtn);
        kids.push(overlay);
    } else {
        kids.push(createElement('img', { classes: ['w-full','h-full','object-cover','absolute','inset-0','lazy-image','transition-opacity','duration-300'], attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': result.thumbnailUrl, alt: result.name } }));
    }
    // 为所有媒体添加时间戳（视频和图片）
    if (timeText) kids.push(createElement('div', { classes: ['absolute','bottom-2','right-2','bg-black/50','text-white','text-sm','px-2','py-1','rounded','shadow-lg'], textContent: timeText }));
    
    // 使用动态aspect-ratio保持原始比例，确保播放按钮居中
    const containerStyle = `aspect-ratio: ${aspectRatio};`;
    const relativeDiv = createElement('div', { 
        classes: ['relative','w-full','h-full'], 
        attributes: {
            style: containerStyle,
            'data-aspect-ratio': aspectRatio.toFixed(2),
            'data-original-width': result.width || 0,
            'data-original-height': result.height || 0
        }, 
        children: kids 
    });
    
    // 视频和图片都使用photo-item类，保持一致性
    const card = createElement('div', { classes: ['photo-item','group','block','bg-gray-800','rounded-lg','overflow-hidden','cursor-pointer'], children: [relativeDiv] });
    
    // 在卡片下方显示文件名（视频和图片都显示）
    const nameDiv = createElement('div', { classes: ['mt-2'], children: [createElement('p', { classes: ['text-xs','text-gray-400','truncate'], textContent: result.name })] });
    const attrs = { 'data-url': result.originalUrl, 'data-index': index, 'data-width': result.width || 1, 'data-height': result.height || 1 };
    return createElement('div', { classes: ['grid-item','photo-link'], attributes: attrs, children: nameDiv ? [card, nameDiv] : [card] });
}

/**
 * 渲染浏览网格（批量优化，返回 DOM 元素数组）
 * @param {Array} items 项目数组
 * @param {number} currentPhotoCount 当前图片计数
 * @returns {Object} { contentElements, newMediaUrls, fragment }
 */
export function renderBrowseGrid(items, currentPhotoCount) {
    const contentElements = [];
    const newMediaUrls = [];
    const showTimestampForMedia = false;
    const fragment = document.createDocumentFragment();
    items.forEach(item => {
        const itemData = item.data;
        let element;
        if (item.type === 'album') {
            element = displayAlbum(itemData);
        } else {
            const mediaIndex = currentPhotoCount + newMediaUrls.length;
            element = displayStreamedMedia(item.type, itemData, mediaIndex, showTimestampForMedia);
            newMediaUrls.push(itemData.originalUrl);
        }
        contentElements.push(element);
        fragment.appendChild(element);
    });
    return { contentElements, newMediaUrls, fragment };
}

/**
 * 渲染搜索网格（批量优化，返回 DOM 元素数组）
 * @param {Array} results 搜索结果数组
 * @param {number} currentPhotoCount 当前图片计数
 * @returns {Object} { contentElements, newMediaUrls, fragment }
 */
export function renderSearchGrid(results, currentPhotoCount) {
    const contentElements = [];
    const newMediaUrls = [];
    const fragment = document.createDocumentFragment();
    results.forEach(result => {
        let element;
        if (result.type === 'album') {
            element = displayAlbum(result);
        } else if (result.type === 'photo' || result.type === 'video') {
            const mediaIndex = currentPhotoCount + newMediaUrls.length;
            element = displaySearchMedia(result, mediaIndex);
            newMediaUrls.push(result.originalUrl);
        }
        if (element) {
            contentElements.push(element);
            fragment.appendChild(element);
        }
    });
    return { contentElements, newMediaUrls, fragment };
}

/**
 * 渲染排序下拉菜单（安全 DOM 操作）
 */
export function renderSortDropdown() {
    const sortContainer = elements.sortContainer;
    if (!sortContainer) return;

    // ✅ 不再创建布局切换按钮，由 renderLayoutToggleOnly() 统一管理
    // 只检查按钮是否存在，如果不存在则警告
    const toggleWrap = sortContainer.querySelector('#layout-toggle-wrap');
    if (!toggleWrap) {
        console.warn('[UI] 布局切换按钮不存在，应该先调用 renderLayoutToggleOnly()');
    }
    let sortWrapper = sortContainer.querySelector('#sort-wrapper');
    if (!sortWrapper) {
        sortWrapper = document.createElement('div');
        sortWrapper.id = 'sort-wrapper';
        safeSetStyle(sortWrapper, {
            position: 'relative',
            display: 'inline-block'
        });
        sortContainer.appendChild(sortWrapper);
    }
    while (sortWrapper.firstChild) {
        sortWrapper.removeChild(sortWrapper.firstChild);
    }
    const sortOptions = { smart: '🧠 智能', name: '📝 名称', mtime: '📅 日期', viewed_desc: '👁️ 访问' };
    const hash = window.location.hash;
    const questionMarkIndex = hash.indexOf('?');
    const urlParams = new URLSearchParams(questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '');
    const currentSort = urlParams.get('sort') || 'smart';

    function getCurrentOption(sortValue) {
        if (sortValue === 'name_asc' || sortValue === 'name_desc') return 'name';
        if (sortValue === 'mtime_asc' || sortValue === 'mtime_desc') return 'mtime';
        return sortValue;
    }

    function getSortDisplayText(sortValue) {
        switch (sortValue) {
            case 'smart': return '智能';
            case 'name_asc':
            case 'name_desc': return '名称';
            case 'mtime_desc':
            case 'mtime_asc': return '日期';
            case 'viewed_desc': return '访问';
            default: return '智能';
        }
    }

    const currentOption = getCurrentOption(currentSort);

    // 创建排序触发按钮（使用提供的SVG图标，采用 action-button 风格）
    const sortIcon = (() => {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        s.setAttribute('viewBox', '0 0 24 24');
        s.setAttribute('fill', 'none');
        s.setAttribute('stroke', 'currentColor');
        s.setAttribute('stroke-width', '2');
        s.setAttribute('stroke-linecap', 'round');
        s.setAttribute('stroke-linejoin', 'round');
        const lines = [
            [4,21,4,14],[4,10,4,3],[12,21,12,12],[12,8,12,3],[20,21,20,16],[20,12,20,3]
        ];
        lines.forEach(([x1,y1,x2,y2]) => {
            const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            l.setAttribute('x1', String(x1));
            l.setAttribute('y1', String(y1));
            l.setAttribute('x2', String(x2));
            l.setAttribute('y2', String(y2));
            s.appendChild(l);
        });
        const extra = [[1,14,7,14],[9,8,15,8],[17,16,23,16]];
        extra.forEach(([x1,y1,x2,y2]) => {
            const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            l.setAttribute('x1', String(x1));
            l.setAttribute('y1', String(y1));
            l.setAttribute('x2', String(x2));
            l.setAttribute('y2', String(y2));
            s.appendChild(l);
        });
        s.style.width = '22px';
        s.style.height = '22px';
        return s;
    })();

    const sortButton = createElement('button', {
        classes: ['action-button','dropdown-toggle'],
        attributes: { id: 'sort-button', 'aria-expanded': 'false', type: 'button' },
        children: [sortIcon]
    });

    const dropdownOptions = Object.entries(sortOptions).map(([value, label]) => createElement('button', { classes: ['dropdown-item', ...(currentOption === value ? ['active'] : [])], attributes: { 'data-value': value, type: 'button' }, textContent: label }));

    const sortDropdown = createElement('div', { classes: ['dropdown-menu'], attributes: { id: 'sort-dropdown' }, children: dropdownOptions });
    const container = createElement('div', { classes: ['dropdown-wrapper','relative','inline-flex','items-center'], children: [sortButton, sortDropdown] });
    sortWrapper.appendChild(container);

    sortButton.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = container.classList.contains('is-open');
        if (isOpen) {
            container.classList.remove('is-open');
            sortButton.setAttribute('aria-expanded', 'false');
        } else {
            // 先关闭其他下拉
            document.querySelectorAll('#sort-wrapper .dropdown-wrapper.is-open').forEach(el => el.classList.remove('is-open'));
            container.classList.add('is-open');
            sortButton.setAttribute('aria-expanded', 'true');
        }
    });

    dropdownOptions.forEach(option => {
        option.addEventListener('click', (e) => {
            e.stopPropagation();
            let newSort = option.dataset.value;
            if (newSort === 'name') newSort = currentSort === 'name_asc' ? 'name_desc' : 'name_asc';
            else if (newSort === 'mtime') newSort = currentSort === 'mtime_desc' ? 'mtime_asc' : 'mtime_desc';
            
            const newHash = `${window.location.hash.split('?')[0]}?sort=${newSort}`;
            
            // 更新活动态
            dropdownOptions.forEach(opt => safeClassList(opt, 'remove', 'active'));
            safeClassList(option, 'add', 'active');
            container.classList.remove('is-open');
            sortButton.setAttribute('aria-expanded', 'false');

            if (window.location.hash !== newHash) window.location.hash = newHash;
        });
    });

    document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) {
            container.classList.remove('is-open');
            sortButton.setAttribute('aria-expanded', 'false');
        }
    });
}

/**
 * 仅渲染布局切换按钮到 sort-container（搜索页专用）
 * 避免重复创建按钮导致事件绑定失效
 * @param {boolean} withAnimation - 是否使用动画（相册页为true，首页/目录页为false）
 */
export function renderLayoutToggleOnly(withAnimation = false) {
    const sortContainer = elements.sortContainer;
    if (!sortContainer) {
        console.log('[UI] sort-container 不存在');
        return;
    }

    // ✅ 强制清理所有已存在的布局切换按钮（防止重复）
    const existingToggles = document.querySelectorAll('#layout-toggle-wrap');
    if (existingToggles.length > 0) {
        console.log(`[UI] 检测到${existingToggles.length}个布局切换按钮，全部移除`);
        existingToggles.forEach(toggle => toggle.remove());
    }
    
    // 同时清理所有分割线
    const existingDividers = sortContainer.querySelectorAll('.layout-divider');
    existingDividers.forEach(divider => divider.remove());
    
    console.log('[UI] 创建新的布局切换按钮');

    requestAnimationFrame(() => {
        try {
            const toggle = createLayoutToggle();
            if (!toggle || !toggle.container) {
                uiLogger.warn('创建布局切换按钮失败');
                return;
            }

            // ✅ 使用 prepend 确保按钮在最前面
            sortContainer.prepend(toggle.container);

            // 分割线也插入到前面（但在按钮后面）
            const divider = document.createElement('div');
            divider.className = 'layout-divider';
            // 插入到按钮后面
            if (toggle.container.nextSibling) {
                sortContainer.insertBefore(divider, toggle.container.nextSibling);
            } else {
                sortContainer.appendChild(divider);
            }

            // ✅ 根据参数决定是否使用动画
            if (withAnimation) {
                // 相册页：使用动画
                sortContainer.offsetHeight; // 强制重绘
                requestAnimationFrame(() => {
                    safeClassList(toggle.container, 'add', 'visible');
                });
            } else {
                // 首页/目录页：直接可见
                safeClassList(toggle.container, 'add', 'visible');
            }

        } catch (error) {
            uiLogger.error('渲染布局切换按钮出错', error);
        }
    });
}

/**
 * 确保布局切换按钮可见
 * 用于修复按钮显示状态
 */
export function ensureLayoutToggleVisible() {
    const sortContainer = elements.sortContainer;
    if (!sortContainer) return;

    const toggleWrap = sortContainer.querySelector('#layout-toggle-wrap');
    if (toggleWrap && !safeClassList(toggleWrap, 'contains', 'visible')) {
        // ✅ 直接设置为可见，不使用动画
        safeClassList(toggleWrap, 'add', 'visible');
    }
}

/**
 * 根据内容长度动态调整滚动优化策略
 * @param {string} path 当前路径
 */
export function adjustScrollOptimization(path) {
    requestAnimationFrame(() => {
        const contentGrid = elements.contentGrid;
        if (!contentGrid) return;

        const gridItems = contentGrid.querySelectorAll('.grid-item');
        const viewportHeight = window.innerHeight;

        // 计算内容总高度
        let totalContentHeight = 0;
        gridItems.forEach(item => {
            const rect = item.getBoundingClientRect();
            totalContentHeight = Math.max(totalContentHeight, rect.bottom);
        });

        const body = document.body;

        // 移除旧类
        safeClassList(body, 'remove', 'has-short-content');
        safeClassList(body, 'remove', 'has-long-content');

        // 根据内容高度判断并添加相应类
        if (totalContentHeight > viewportHeight * 1.2) {
            safeClassList(body, 'add', 'has-long-content');
        } else {
            safeClassList(body, 'add', 'has-short-content');
        }
    });
}

/**
 * 检查路径是否包含媒体文件
 * @param {string} path 路径
 * @returns {Promise<boolean>} 是否包含媒体文件
 */
export async function checkIfHasMediaFiles(path) {
    try {
        const data = await api.fetchBrowseResults(path, 1, new AbortController().signal);
        if (!data || !data.items) return false;
        return data.items.some(item => item.type === 'photo' || item.type === 'video');
    } catch {
        return false;
    }
}

/**
 * 创建布局图标
 * @param {string} kind 布局类型（'grid' 或 'masonry'）
 * @returns {SVGElement} SVG 图标元素
 */
function createLayoutIcon(kind) {
    return kind === 'grid' ? createGridIcon() : createMasonryIcon();
}

/**
 * 返回布局图标的 HTML 字符串（兼容旧用法）
 * @param {string} kind 布局类型（'grid' 或 'masonry'）
 * @returns {string} SVG 图标 HTML 字符串
 */
function iconHtml(kind) {
    return createLayoutIcon(kind).outerHTML;
}

/**
 * 初始化 UI 相关的状态订阅
 */
export function initializeUI() {
    stateManager.subscribe(['layoutMode'], (changedKeys, currentState) => {
        uiLogger.debug('布局模式已更改', { changedKeys, currentState: currentState.layoutMode });
        
        applyLayoutMode();

        // 确保DOM元素是最新的
        reinitializeElements();
        const btn = elements.layoutToggleBtn;
        if (btn) {
            uiLogger.debug('更新布局切换按钮', { layoutMode: currentState.layoutMode });
            updateLayoutToggleButton(btn);
        } else {
            uiLogger.warn('找不到布局切换按钮元素');
        }
    });
}

/**
 * 更新布局切换按钮的显示状态
 * @param {HTMLElement} btn 按钮元素
 */
export function updateLayoutToggleButton(btn) {
    try {
        const isGrid = state.layoutMode === 'grid';

        while (btn.firstChild) {
            btn.removeChild(btn.firstChild);
        }
        const icon = createLayoutIcon(isGrid ? 'grid' : 'masonry');
        // 统一为行动图标按钮风格
        icon.style.width = '22px';
        icon.style.height = '22px';
        btn.appendChild(icon);
        btn.setAttribute('aria-pressed', isGrid ? 'true' : 'false');
    } catch (error) {
        uiLogger.error('更新布局切换按钮出错', error);
    }
}

/**
 * 创建布局切换按钮（网格/瀑布流）
 * @returns {Object} { container, button }
 */
function createLayoutToggle() {
    const wrap = createElement('div', { attributes: { id: 'layout-toggle-wrap' }, classes: ['relative','inline-flex','items-center','mr-2'] });
    const btn = createElement('button', {
        classes: ['action-button'],
        attributes: { id: 'layout-toggle-btn', type: 'button', 'aria-pressed': state.layoutMode === 'grid' ? 'true' : 'false' }
    });
    function updateLabel() {
        const isGrid = state.layoutMode === 'grid';
        safeSetInnerHTML(btn, '');
        const icon = createLayoutIcon(isGrid ? 'grid' : 'masonry');
        icon.style.width = '22px';
        icon.style.height = '22px';
        btn.appendChild(icon);
        btn.setAttribute('aria-pressed', isGrid ? 'true' : 'false');
    }
    // 不再直接绑定事件，改用事件委托（在 listeners.js 中处理）
    // 这样可以避免按钮重新创建时事件丢失的问题
    updateLabel();
    wrap.appendChild(btn);
    return { container: wrap, button: btn };
}

/**
 * 应用当前布局模式到内容容器。
 * 
 * 此函数根据 `state.layoutMode` 的值，将内容容器（grid）切换为“网格”或“瀑布流”布局，并相应管理样式与布局逻辑。
 */
export function applyLayoutMode() {
    const grid = elements.contentGrid;
    if (!grid) return;
    const mode = state.layoutMode;

    if (mode === 'grid') {
        // 切换至网格模式

        // 1. 移除瀑布流模式的类
        safeClassList(grid, 'remove', 'masonry-mode');

        // 2. ✅ 重置子元素样式，但不移除position，避免"全屏闪过"
        Array.from(grid.children).forEach(item => {
            // 移除瀑布流的定位属性，但保持position以避免布局跳动
            item.style.removeProperty('transform');
            item.style.removeProperty('width');
            item.style.removeProperty('height');
            item.style.removeProperty('will-change');
            item.style.removeProperty('left');
            item.style.removeProperty('top');
            // position会由CSS的grid-mode规则覆盖为static
        });

        // 3. 移除容器自身的内联样式（如高度）
        grid.removeAttribute('style');

        // 4. 触发重排，确保样式变动生效
        void grid.offsetHeight;

        // 5. 添加网格模式的类
        safeClassList(grid, 'add', 'grid-mode');

        // 6. 设置网格的纵横比样式变量
        safeSetStyle(grid, '--grid-aspect', '1/1');

    } else {
        // 切换至瀑布流模式

        // 1. 移除网格模式的类
        safeClassList(grid, 'remove', 'grid-mode');

        // 2. 移除容器自身的内联样式
        grid.removeAttribute('style');

        // 3. 添加瀑布流模式的类
        safeClassList(grid, 'add', 'masonry-mode');

        // 4. 立即执行瀑布流布局与刷新
        //    不再延迟布局，防止内容闪烁，已移除 CSS 动画相关等待。
        applyMasonryLayout();
        triggerMasonryUpdate();
    }
}