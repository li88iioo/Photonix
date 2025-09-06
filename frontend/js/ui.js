// frontend/js/ui.js

import { elements, state, stateManager } from './state.js';
import { importWithRetry } from './utils.js';
import * as api from './api.js';
import { getAllViewed } from './indexeddb-helper.js';
import { applyMasonryLayout, triggerMasonryUpdate } from './masonry.js';

// 重新导出 elements 以供其他模块使用
export { elements };

/**
 * 安全地创建DOM元素并设置其属性和内容
 */
function createElement(tag, { classes = [], attributes = {}, textContent = '', children = [] } = {}) {
	const el = document.createElement(tag);
	if (classes.length) el.classList.add(...classes);
	for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
	if (textContent) el.textContent = textContent;
	if (children.length) el.append(...children);
	return el;
}

/**
 * 格式化时间显示
 */
function formatTime(timestamp) {
	if (!timestamp) return '';
	const diff = Date.now() - Number(timestamp);
	if (diff < 60 * 1000) return '刚刚';
	if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))}分钟前`;
	if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))}小时前`;
	if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / (24 * 60 * 60 * 1000))}天前`;
	if (diff < 12 * 30 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / (30 * 24 * 60 * 60 * 1000))}个月前`;
	return `${Math.floor(diff / (12 * 30 * 24 * 60 * 60 * 1000))}年前`;
}

/**
 * 根据已查看状态对相册进行排序
 */
export async function sortAlbumsByViewed() {
	const hash = window.location.hash;
	const questionMarkIndex = hash.indexOf('?');
	const urlParams = new URLSearchParams(questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '');
	const currentSort = urlParams.get('sort') || 'smart';
	if (currentSort !== 'smart') return;
	const viewedAlbumsData = await getAllViewed();
	const viewedAlbumPaths = viewedAlbumsData.map(item => item.path);
	const albumElements = Array.from(document.querySelectorAll('.album-link'));
	albumElements.sort((a, b) => {
		const viewedA = viewedAlbumPaths.includes(a.dataset.path);
		const viewedB = viewedAlbumPaths.includes(b.dataset.path);
		if (viewedA && !viewedB) return 1;
		if (!viewedA && viewedB) return -1;
		return 0;
	});
	const grid = elements.contentGrid; if (!grid) return;
	albumElements.forEach(el => grid.appendChild(el));
}

/**
 * 渲染面包屑导航（安全 DOM）
 */
export function renderBreadcrumb(path) {
	const parts = path ? path.split('/').filter(p => p) : [];
	let currentPath = '';
	let sortParam = '';
	if (state.entrySort && state.entrySort !== 'smart') sortParam = `?sort=${state.entrySort}`; else {
		const hash = window.location.hash;
		const questionMarkIndex = hash.indexOf('?');
		sortParam = questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '';
	}
	const breadcrumbNav = document.getElementById('breadcrumb-nav');
	if (!breadcrumbNav) return;
	let breadcrumbLinks = breadcrumbNav.querySelector('#breadcrumb-links');
	if (!breadcrumbLinks) {
		breadcrumbNav.innerHTML = '';
		breadcrumbLinks = createElement('div', { classes: ['flex-1', 'min-w-0'], attributes: { id: 'breadcrumb-links' } });
		const sortContainer = createElement('div', { classes: ['flex-shrink-0', 'ml-4'], attributes: { id: 'sort-container' } });
		breadcrumbNav.append(breadcrumbLinks, sortContainer);
	}
	const container = createElement('div', { classes: ['flex', 'flex-wrap', 'items-center'] });
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
	breadcrumbLinks.innerHTML = '';
	breadcrumbLinks.appendChild(container);
	setTimeout(() => {
		const sortContainer = document.getElementById('sort-container');
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
				sortWrapper.style.display = 'inline-block';
				sortWrapper.style.position = 'relative';
				sortContainer.appendChild(sortWrapper);
			}
			// 没有媒体文件时才显示排序下拉
			checkIfHasMediaFiles(path)
				.then(hasMedia => {
					if (!hasMedia) {
						sortWrapper.innerHTML = '';
						renderSortDropdown();
					} else {
						sortWrapper.innerHTML = '';
					}
				})
				.catch(() => {
					sortWrapper.innerHTML = '';
					renderSortDropdown();
				});
		}
	}, 100);
}

/**
 * 渲染相册卡片（安全 DOM）
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
	
	const relativeDiv = createElement('div', { classes: ['relative'], attributes: { style: `aspect-ratio: ${aspectRatio}` }, children: [createElement('div', { classes: ['image-placeholder','absolute','inset-0'] }), img, infoOverlay] });
	const link = createElement('a', { classes: ['album-card','group','block','bg-gray-800','rounded-lg','overflow-hidden','shadow-lg','hover:shadow-purple-500/30','transition-shadow'], attributes: { href: `#/${encodeURIComponent(album.path)}${sortParam}` }, children: [relativeDiv] });
	return createElement('div', { classes: ['grid-item','album-link'], attributes: { 'data-path': album.path, 'data-width': album.coverWidth || 1, 'data-height': album.coverHeight || 1 }, children: [link] });
}

/**
 * 渲染流式媒体项（安全 DOM）- 增强布局稳定性
 */
export function displayStreamedMedia(type, mediaData, index, showTimestamp) {
	const isVideo = type === 'video';
	// 使用精确的宽高比，避免布局偏移
	const aspectRatio = (mediaData.height && mediaData.width) 
		? mediaData.width / mediaData.height 
		: (isVideo ? 16/9 : 1); // 视频默认 16:9，图片默认 1:1
	const timeText = showTimestamp ? formatTime(mediaData.mtime) : '';
	
	// 占位层 - 添加最小高度确保布局稳定性
	const placeholderClasses = ['image-placeholder','absolute','inset-0'];
	if (!mediaData.height || !mediaData.width) {
		placeholderClasses.push('min-h-[200px]'); // 未知尺寸时的最小高度
	}
	const kids = [createElement('div', { classes: placeholderClasses })];
	// 加载覆盖层（含SVG进度环，慢网速下更可见）
	const loadingOverlay = createElement('div', { classes: ['loading-overlay'] });
	const progressHolder = createElement('div');
	progressHolder.innerHTML = `
		<svg class="progress-circle" viewBox="0 0 36 36" aria-hidden="true">
			<circle class="progress-circle-track" cx="18" cy="18" r="16" stroke-width="4"></circle>
			<circle class="progress-circle-bar" cx="18" cy="18" r="16" stroke-width="4"></circle>
		</svg>
	`;
	loadingOverlay.append(progressHolder);
	kids.push(loadingOverlay);
	if (isVideo) {
		kids.push(createElement('img', { classes: ['w-full','h-full','object-cover','absolute','inset-0','lazy-image','transition-opacity','duration-300'], attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': mediaData.thumbnailUrl, alt: '视频缩略图' } }));
		const overlay = createElement('div', { classes: ['video-thumbnail-overlay'] });
		const playBtn = createElement('div', { classes: ['video-play-button'] });
		playBtn.innerHTML = `
			<svg viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
				<path d="M24 18v28l24-14-24-14z"></path>
			</svg>
		`;
		overlay.append(playBtn);
		kids.push(overlay);
	} else {
		kids.push(createElement('img', { classes: ['w-full','h-full','object-cover','absolute','inset-0','lazy-image','transition-opacity','duration-300'], attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': mediaData.thumbnailUrl, alt: '图片缩略图' } }));
	}
	if (timeText) kids.push(createElement('div', { classes: ['absolute','bottom-2','right-2','bg-black/50','text-white','text-sm','px-2','py-1','rounded','shadow-lg'], textContent: timeText }));
	// 使用更精确的容器样式，确保布局稳定性
	const containerStyle = `aspect-ratio: ${aspectRatio}; min-height: 150px;`;
	const relativeDiv = createElement('div', { 
		classes: ['relative','w-full','h-full'], 
		attributes: { 
			style: containerStyle,
			'data-aspect-ratio': aspectRatio.toFixed(3),
			'data-original-width': mediaData.width || 0,
			'data-original-height': mediaData.height || 0
		}, 
		children: kids 
	});
	const photoItem = createElement('div', { classes: ['photo-item','group','block','bg-gray-800','rounded-lg','overflow-hidden','cursor-pointer'], children: [relativeDiv] });
	return createElement('div', { classes: ['grid-item','photo-link'], attributes: { 'data-url': mediaData.originalUrl, 'data-index': index, 'data-width': mediaData.width, 'data-height': mediaData.height }, children: [photoItem] });
}

/**
 * 渲染搜索结果媒体项（安全 DOM）
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
		playBtn.innerHTML = `
			<svg viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
				<path d="M24 18v28l24-14-24-14z"></path>
			</svg>
		`;
		overlay.append(playBtn);
		kids.push(overlay);
		// 信息覆盖层：与相册一致，置于封面内部
		const title = createElement('div', { classes: ['album-title'], textContent: result.name });
		const metaKids = [createElement('span', { classes: ['album-type'], textContent: '视频' })];
		if (timeText) metaKids.push(createElement('span', { classes: ['album-time'], textContent: timeText }));
		const infoOverlay = createElement('div', { classes: ['card-info-overlay'], children: [title, createElement('div', { classes: ['album-meta'], children: metaKids })] });
		kids.push(infoOverlay);
	} else {
		kids.push(createElement('img', { classes: ['w-full','h-full','object-cover','absolute','inset-0','lazy-image','transition-opacity','duration-300'], attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': result.thumbnailUrl, alt: result.name } }));
	}
	// 非视频保留角标时间；视频信息已在覆盖层中
	if (!isVideo && timeText) kids.push(createElement('div', { classes: ['absolute','bottom-2','right-2','bg-black/50','text-white','text-sm','px-2','py-1','rounded','shadow-lg'], textContent: timeText }));
	const relativeDiv = isVideo
		? createElement('div', { classes: ['relative'], attributes: { style: `aspect-ratio: ${aspectRatio}` }, children: kids })
		: createElement('div', { classes: ['aspect-w-1','aspect-h-1','relative'], children: kids });
	const containerClasses = isVideo
		? ['album-card','group','block','bg-gray-800','rounded-lg','overflow-hidden','shadow-lg','hover:shadow-purple-500/30','transition-shadow']
		: ['photo-item','group','block','bg-gray-800','rounded-lg','overflow-hidden','cursor-pointer'];
	const card = createElement('div', { classes: containerClasses, children: [relativeDiv] });
	const nameDiv = isVideo ? null : createElement('div', { classes: ['mt-2'], children: [createElement('p', { classes: ['text-xs','text-gray-400','truncate'], textContent: result.name })] });
	const attrs = { 'data-url': result.originalUrl, 'data-index': index, 'data-width': result.width || 1, 'data-height': result.height || 1 };
	return createElement('div', { classes: ['grid-item','photo-link'], attributes: attrs, children: nameDiv ? [card, nameDiv] : [card] });
}

/**
 * 渲染浏览网格（返回 DOM 元素数组）- 批量优化版本
 */
export function renderBrowseGrid(items, currentPhotoCount) {
	const contentElements = [];
	const newMediaUrls = [];
	// 规则：浏览页中，媒体项（图片/视频）不显示日期角标；仅相册卡片显示
	const showTimestampForMedia = false;
	
	// 使用 DocumentFragment 进行批量 DOM 操作
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
 * 渲染搜索网格（返回 DOM 元素数组）- 批量优化版本
 */
export function renderSearchGrid(results, currentPhotoCount) {
	const contentElements = [];
	const newMediaUrls = [];
	
	// 使用 DocumentFragment 进行批量 DOM 操作
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
 * 渲染排序下拉菜单（安全 DOM）
 */
export function renderSortDropdown() {
	const sortContainer = document.getElementById('sort-container');
	if (!sortContainer) return;

	// 确保稳定结构：布局切换器 + 分割线 + 排序 wrapper
	let toggleWrap = sortContainer.querySelector('#layout-toggle-wrap');
	if (!toggleWrap) {
		const toggle = createLayoutToggle();
		sortContainer.appendChild(toggle.container);
		toggleWrap = toggle.container;
	}

	// 无论按钮是新建的还是已存在的，都要确保可见
	if (toggleWrap && !toggleWrap.classList.contains('visible')) {
		requestAnimationFrame(() => {
			toggleWrap.classList.add('visible');
		});
	}
	if (!sortContainer.querySelector('.layout-divider')) {
		const divider = document.createElement('div');
		divider.className = 'layout-divider';
		sortContainer.appendChild(divider);
	}
	let sortWrapper = sortContainer.querySelector('#sort-wrapper');
	if (!sortWrapper) {
		sortWrapper = document.createElement('div');
		sortWrapper.id = 'sort-wrapper';
		sortWrapper.style.position = 'relative';
		sortWrapper.style.display = 'inline-block';
		sortContainer.appendChild(sortWrapper);
	}
	// 清空并在 wrapper 中渲染
	sortWrapper.innerHTML = '';
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

	const sortDisplay = createElement('span', { attributes: { id: 'sort-display' }, textContent: getSortDisplayText(currentSort) });
    const iconContainer = createElement('div', { classes: ['w-3','h-3','sm:w-4','sm:h-4','text-gray-400', 'transition-transform', 'duration-200'] });
    const isAscending = currentSort.endsWith('_asc');
    const arrowPath = isAscending ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7';
    iconContainer.innerHTML = `<svg class="w-full h-full" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${arrowPath}"></path></svg>`;

	const sortButton = createElement('button', { 
        classes: ['bg-gray-800','border','border-gray-700','text-white','text-sm','rounded-lg','focus:ring-purple-500','focus:border-purple-500','block','w-20','p-1.5','sm:p-2.5','transition-colors','hover:border-purple-500','cursor-pointer','flex','items-center','justify-between'], 
        attributes: { id: 'sort-button', 'aria-expanded': 'false' }, 
        children: [sortDisplay, iconContainer] 
    });

	const dropdownOptions = Object.entries(sortOptions).map(([value, label]) => createElement('button', { classes: ['sort-option','w-full','text-left','px-3','py-2','text-sm','text-white','hover:bg-gray-700','transition-colors',...(currentOption === value ? ['bg-purple-600'] : [])], attributes: { 'data-value': value }, textContent: label }));
	const sortDropdown = createElement('div', { classes: ['absolute','top-full','right-0','mt-1','bg-gray-800','border','border-gray-700','rounded-lg','shadow-lg','z-50','hidden','w-full'], attributes: { id: 'sort-dropdown' }, children: dropdownOptions });
	const container = createElement('div', { classes: ['relative','inline-flex','items-center'], children: [sortButton, sortDropdown] });
	sortWrapper.appendChild(container);

	sortButton.addEventListener('click', (e) => { 
        e.stopPropagation(); 
        const isHidden = sortDropdown.classList.toggle('hidden');
        sortButton.setAttribute('aria-expanded', !isHidden);
        iconContainer.classList.toggle('rotate-180', !isHidden);
    });

	dropdownOptions.forEach(option => {
		option.addEventListener('click', (e) => {
			e.stopPropagation();
			let newSort = option.dataset.value;
			if (newSort === 'name') newSort = currentSort === 'name_asc' ? 'name_desc' : 'name_asc';
			else if (newSort === 'mtime') newSort = currentSort === 'mtime_desc' ? 'mtime_asc' : 'mtime_desc';
			
            const newHash = `${window.location.hash.split('?')[0]}?sort=${newSort}`;
			
            sortDisplay.textContent = getSortDisplayText(newSort);
//*            iconContainer.classList.toggle('rotate-180', newSort.endsWith('_asc'));*/

			dropdownOptions.forEach(opt => opt.classList.remove('bg-purple-600'));
			option.classList.add('bg-purple-600');
			sortDropdown.classList.add('hidden');
            sortButton.setAttribute('aria-expanded', 'false');
            iconContainer.classList.remove('rotate-180');

			if (window.location.hash !== newHash) window.location.hash = newHash;
		});
	});

	document.addEventListener('click', (e) => {
		if (!sortButton.contains(e.target) && !sortDropdown.contains(e.target)) {
            sortDropdown.classList.add('hidden');
            sortButton.setAttribute('aria-expanded', 'false');
            iconContainer.classList.remove('rotate-180');
        }
	});
}

/**
 * 仅渲染布局切换按钮到现有的 sort-container（搜索页用）
 */
export function renderLayoutToggleOnly() {
    const sortContainer = document.getElementById('sort-container');
    if (!sortContainer) return;

    // 使用requestAnimationFrame确保时序正确
    requestAnimationFrame(() => {
        sortContainer.innerHTML = '';
        const toggle = createLayoutToggle();
        sortContainer.appendChild(toggle.container);

        // 分割线
        const divider = document.createElement('div');
        divider.className = 'layout-divider';
        sortContainer.appendChild(divider);

        // 强制重新计算布局
        sortContainer.offsetHeight;

        // 在下一帧触发动画，确保按钮可见
        requestAnimationFrame(() => {
            if (toggle.container && !toggle.container.classList.contains('visible')) {
                toggle.container.classList.add('visible');
            }
        });
    });
}

/**
 * 确保布局切换按钮可见
 * 用于修复按钮显示状态的问题
 */
export function ensureLayoutToggleVisible() {
    const sortContainer = document.getElementById('sort-container');
    if (!sortContainer) return;

    const toggleWrap = sortContainer.querySelector('#layout-toggle-wrap');
    if (toggleWrap && !toggleWrap.classList.contains('visible')) {
        requestAnimationFrame(() => {
            toggleWrap.classList.add('visible');
        });
    }
}

/**
 * 根据内容长度动态调整滚动优化策略
 * @param {string} path - 当前路径
 */
export function adjustScrollOptimization(path) {
    // 使用requestAnimationFrame确保在DOM更新后执行
    requestAnimationFrame(() => {
        const contentGrid = document.getElementById('content-grid');
        if (!contentGrid) return;

        const gridItems = contentGrid.querySelectorAll('.grid-item');
        const viewportHeight = window.innerHeight;

        // 计算内容的总高度
        let totalContentHeight = 0;
        gridItems.forEach(item => {
            const rect = item.getBoundingClientRect();
            totalContentHeight = Math.max(totalContentHeight, rect.bottom);
        });

        // 获取body元素
        const body = document.body;

        // 移除之前的类
        body.classList.remove('has-short-content', 'has-long-content');

        // 根据内容高度判断并添加相应类
        if (totalContentHeight > viewportHeight * 1.2) {
            // 内容高度超过视口高度的120%，认为是长内容
            body.classList.add('has-long-content');
        } else {
            // 内容较少，一页能显示完
            body.classList.add('has-short-content');
        }
    });
}

/**
 * 检查路径是否包含媒体文件
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

// Moved from createLayoutToggle to be accessible by subscriber
function iconHtml(kind) {
	// 使用内嵌 SVG，匹配系统图标视觉（描边2px、圆角矩形/四格）
	if (kind === 'grid') {
		return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>`;
	}
	// masonry：两大两小交错
	return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="10" height="8" rx="2"/><rect x="15" y="3" width="6" height="6" rx="2"/><rect x="3" y="13" width="6" height="8" rx="2"/><rect x="11" y="13" width="10" height="8" rx="2"/></svg>`;
}

/**
 * Initializes UI-related state subscriptions.
 */
export function initializeUI() {
    stateManager.subscribe(['layoutMode'], () => {
        applyLayoutMode();
        
        const btn = document.getElementById('layout-toggle-btn');
        if (btn) {
            const isGrid = state.get('layoutMode') === 'grid';
            btn.innerHTML = `${iconHtml(isGrid ? 'grid' : 'masonry')}<span class="layout-tooltip" style="margin-left:4px;">${isGrid ? '瀑布流布局' : '网格布局'}</span>`;
            btn.setAttribute('aria-pressed', isGrid ? 'true' : 'false');
        }
    });
}

/**
 * 创建布局切换按钮（网格/瀑布）
 */
function createLayoutToggle() {
	const wrap = createElement('div', { attributes: { id: 'layout-toggle-wrap' }, classes: ['relative','inline-flex','items-center','mr-2'] });
	const btn = createElement('button', {
		classes: ['bg-gray-800','border','border-gray-700','text-white','text-sm','rounded-lg','focus:ring-purple-500','focus:border-purple-500','px-2.5','py-1.5','transition-colors','hover:border-purple-500','cursor-pointer','flex','items-center','gap-1'],
		attributes: { id: 'layout-toggle-btn', type: 'button', 'aria-pressed': state.get('layoutMode') === 'grid' ? 'true' : 'false' }
	});
	// 提供的图标 (数据URL)
	// The long data URLs for icons were removed as they are no longer used.
	// The new `iconHtml` function provides the SVG content directly.
	function iconHtml(kind) {
		// 使用内嵌 SVG，匹配系统图标视觉（描边2px、圆角矩形/四格）
		if (kind === 'grid') {
			return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>`;
		}
		// masonry：两大两小交错
		return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="10" height="8" rx="2"/><rect x="15" y="3" width="6" height="6" rx="2"/><rect x="3" y="13" width="6" height="8" rx="2"/><rect x="11" y="13" width="10" height="8" rx="2"/></svg>`;
	}
	function updateLabel() { // This is now only for initial setup
		const isGrid = state.get('layoutMode') === 'grid';
		btn.innerHTML = `${iconHtml(isGrid ? 'grid' : 'masonry')}<span class="layout-tooltip" style="margin-left:4px;">${isGrid ? '瀑布流布局' : '网格布局'}</span>`;
		btn.setAttribute('aria-pressed', isGrid ? 'true' : 'false');
	}
	btn.addEventListener('click', () => {
		const current = state.get('layoutMode');
		const next = current === 'grid' ? 'masonry' : 'grid';
		state.update('layoutMode', next); // This now triggers the subscription
		try { localStorage.setItem('sg_layout_mode', next); } catch {}
	});
	updateLabel(); // Set initial state
	wrap.appendChild(btn);
	return { container: wrap, button: btn };
}

/**
 * 应用当前布局模式到内容容器
 */
export function applyLayoutMode() {
	const grid = elements.contentGrid;
	if (!grid) return;
	const mode = state.get('layoutMode');
	if (mode === 'grid') {
		grid.classList.remove('masonry-mode');
		grid.classList.add('grid-mode');
		// 清除瀑布流产生的内联样式
		Array.from(grid.children).forEach(item => {
			item.style.position = '';
			item.style.width = '';
			item.style.left = '';
			item.style.top = '';
		});
		grid.style.height = '';
		// 清理瀑布流写入的高度，避免影响网格模式布局
		Array.from(grid.children).forEach(item => { item.style.height = ''; });
		// 统一网格卡片纵横比（可按需改为 1/1 或 16/9）
		grid.style.setProperty('--grid-aspect', '1/1');
	} else {
		grid.classList.remove('grid-mode');
		grid.classList.add('masonry-mode');
		requestAnimationFrame(() => {
			applyMasonryLayout();
			triggerMasonryUpdate();
		});
	}
}