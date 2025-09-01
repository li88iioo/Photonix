// frontend/js/ui.js

import { elements, state } from './state.js';
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
	const GRID_ICON_URL = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill-rule='evenodd' d='M5.42 2.558a3.56 3.56 0 0 0-2.119 1.23c-.27.327-.541.844-.667 1.272-.091.309-.094.368-.094 1.7 0 1.338.003 1.389.094 1.68.328 1.045.95 1.773 1.898 2.222.516.245.82.299 1.828.325 1.005.025 1.766-.025 2.14-.141A3.53 3.53 0 0 0 10.846 8.5c.183-.588.205-2.699.035-3.36-.258-1.003-.989-1.89-1.896-2.3-.628-.284-.681-.292-2.085-.304-.704-.005-1.37.004-1.48.022m10.48.002a4 4 0 0 0-1 .331c-.617.311-1.189.894-1.52 1.549-.294.581-.378 1.098-.379 2.32-.001 1.408.13 1.984.612 2.7.207.307.62.72.927.927.773.521 1.407.643 3.1.6 1.008-.026 1.312-.08 1.828-.325.948-.449 1.57-1.177 1.898-2.222.091-.291.094-.342.094-1.68 0-1.332-.003-1.391-.094-1.7a3.58 3.58 0 0 0-2.406-2.422c-.28-.084-.386-.091-1.56-.101-.693-.006-1.368.005-1.5.023M7.52 4.515c.768.062 1.248.441 1.423 1.125.051.199.061.434.05 1.233-.013.986-.013.987-.126 1.231a1.7 1.7 0 0 1-.767.764l-.24.112h-1.1c-1.056 0-1.109-.004-1.328-.092a1.5 1.5 0 0 1-.757-.713c-.163-.33-.211-.823-.177-1.807.03-.842.081-1.014.408-1.368.293-.316.569-.45.993-.483a12 12 0 0 1 1.621-.002m11 .081c.391.149.734.491.881.876.093.245.143 1.374.089 2.009-.054.636-.277 1.043-.71 1.297-.34.199-.571.229-1.653.215-.985-.013-.988-.013-1.227-.125a1.7 1.7 0 0 1-.767-.764l-.113-.244v-1.1c0-1.056.004-1.109.092-1.328.129-.319.396-.601.718-.76.331-.163.62-.192 1.698-.169.656.013.822.029.992.093m-12.9 8.446a3.38 3.38 0 0 0-2.098 1.005c-.43.432-.686.868-.888 1.513-.091.291-.094.342-.094 1.68 0 1.332.003 1.391.094 1.7a3.57 3.57 0 0 0 2.426 2.426c.308.09.37.094 1.66.094 1.444 0 1.526-.009 2.079-.222.938-.362 1.681-1.16 2.028-2.178.217-.638.236-2.816.03-3.525a3.5 3.5 0 0 0-.894-1.498c-.609-.609-1.279-.921-2.139-.997a18 18 0 0 0-2.204.002m10.5 0c-.99.088-1.94.656-2.507 1.498-.521.773-.643 1.407-.6 3.1.026 1.008.08 1.312.325 1.828.449.948 1.177 1.57 2.222 1.898.291.091.342.094 1.68.094 1.332 0 1.391-.003 1.7-.094a3.57 3.57 0 0 0 2.426-2.426c.09-.308.094-.37.094-1.66 0-1.444-.009-1.526-.222-2.079-.294-.763-.912-1.434-1.678-1.821a3.1 3.1 0 0 0-1.24-.34 18 18 0 0 0-2.2.002m-8.016 2.091c.309.143.617.452.764.767l.112.24v1.1c0 1.056-.004 1.109-.092 1.328a1.5 1.5 0 0 1-.717.76c-.243.119-.311.133-.834.167-.35.023-.8.023-1.165 0-.693-.043-.9-.118-1.225-.442-.323-.324-.4-.535-.443-1.22-.053-.849.006-1.661.143-1.958.124-.269.346-.524.571-.656.329-.193.52-.217 1.622-.208l1.02.009zm10.35-.052c.443.137.771.45.95.908.085.219.09.286.089 1.271 0 1.27-.022 1.356-.449 1.784-.377.377-.526.425-1.41.456-.985.036-1.479-.012-1.809-.175a1.5 1.5 0 0 1-.713-.757c-.088-.219-.092-.272-.092-1.328v-1.1l.112-.24c.193-.414.603-.759 1.018-.857.082-.019.576-.037 1.096-.039.844-.004.974.005 1.208.077'/%3E%3C/svg%3E";
	const MASONRY_ICON_URL = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill-rule='evenodd' d='M5.073 2.562c-.729.111-1.178.33-1.667.809-.419.41-.656.832-.791 1.409-.069.296-.075.52-.075 2.98 0 2.085.012 2.712.054 2.9.233 1.036 1.006 1.887 1.97 2.166.492.142 1.217.188 2.575.161 1.516-.029 1.785-.077 2.401-.43.532-.304 1.054-.926 1.249-1.488.168-.487.18-.654.199-2.947.025-2.898-.012-3.35-.332-3.989a2.95 2.95 0 0 0-1.85-1.503c-.285-.079-.418-.085-1.906-.094-.88-.005-1.702.006-1.827.026m10.262.018c-1.166.253-2.075 1.215-2.284 2.418-.076.433-.048 1.429.048 1.776.287 1.03 1.078 1.821 2.127 2.13.333.098 3.27.132 3.782.044a2.84 2.84 0 0 0 1.593-.828c.349-.345.587-.723.744-1.18.1-.291.111-.384.127-1.044.02-.889-.031-1.194-.29-1.716-.4-.804-1.189-1.431-2.015-1.6-.398-.082-3.457-.082-3.832 0M15.8 11.042c-.508.046-.859.141-1.211.329-.547.291-.93.674-1.215 1.215-.333.632-.371 1.004-.373 3.654-.001 2.59.039 3.021.343 3.627a2.96 2.96 0 0 0 1.932 1.522c.266.062.511.071 1.964.071 1.794 0 2.009-.021 2.5-.239.712-.317 1.335-.997 1.558-1.701.175-.554.188-.815.173-3.5-.014-2.417-.018-2.532-.098-2.82a2.96 2.96 0 0 0-1.422-1.815c-.325-.182-.743-.293-1.291-.344-.498-.046-2.344-.046-2.86.001m3.1 2.051c.088.039.228.137.311.218.268.261.274.316.297 2.409.023 2.133-.015 3.019-.14 3.263-.189.37-.383.455-1.144.505-.681.045-2.276.01-2.534-.055-.217-.054-.499-.302-.595-.522-.07-.159-.076-.33-.087-2.467-.008-1.524.002-2.392.032-2.58.073-.475.323-.744.76-.82.121-.021.832-.034 1.58-.03 1.207.007 1.378.016 1.52.079M4.939 15.057c-.597.111-1.096.381-1.558.844-.372.372-.542.64-.713 1.129-.117.331-.124.39-.14 1.074-.02.889.031 1.195.29 1.716q.452.91 1.362 1.362c.588.292.707.305 2.707.29l1.733-.012.35-.125c.486-.174.752-.343 1.127-.715.694-.689.933-1.376.89-2.56-.022-.622-.074-.892-.245-1.279-.277-.626-.896-1.246-1.521-1.522-.514-.228-.553-.232-2.341-.243-1.238-.009-1.731.002-1.941.041m3.401 2.009c.253.087.507.341.594.594.078.229.089.851.021 1.124-.057.226-.334.541-.565.641-.152.066-.311.076-1.502.087-.884.009-1.405-.002-1.549-.032a1 1 0 0 1-.718-.537c-.113-.222-.121-.266-.121-.68 0-.558.065-.749.343-.998.108-.097.264-.195.347-.217.084-.022.763-.042 1.553-.044 1.208-.003 1.43.005 1.597.062'/%3E%3C/svg%3E";
	function iconHtml(kind) {
		// 使用内嵌 SVG，匹配系统图标视觉（描边2px、圆角矩形/四格）
		if (kind === 'grid') {
			return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>`;
		}
		// masonry：两大两小交错
		return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="10" height="8" rx="2"/><rect x="15" y="3" width="6" height="6" rx="2"/><rect x="3" y="13" width="6" height="8" rx="2"/><rect x="11" y="13" width="10" height="8" rx="2"/></svg>`;
	}
	function updateLabel() {
		const isGrid = state.get('layoutMode') === 'grid';
		btn.innerHTML = `${iconHtml(isGrid ? 'grid' : 'masonry')}<span class="layout-tooltip" style="margin-left:4px;">${isGrid ? '瀑布流布局' : '网格布局'}</span>`;
		btn.setAttribute('aria-pressed', isGrid ? 'true' : 'false');
	}
	btn.addEventListener('click', () => {
		const current = state.get('layoutMode');
		const next = current === 'grid' ? 'masonry' : 'grid';
		state.update('layoutMode', next);
		try { localStorage.setItem('sg_layout_mode', next); } catch {}
		applyLayoutMode();
		updateLabel();
	});
	updateLabel();
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