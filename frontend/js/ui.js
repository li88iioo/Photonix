// frontend/js/ui.js

import { elements, state } from './state.js';
import { getAllViewed } from './indexeddb-helper.js';

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
			checkIfHasMediaFiles(path).then(hasMedia => { if (!hasMedia) renderSortDropdown(); }).catch(() => renderSortDropdown());
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
	const img = createElement('img', { classes: ['w-full','h-full','object-cover','absolute','inset-0','lazy-image','opacity-0','transition-opacity','duration-300'], attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': album.coverUrl, alt: album.name } });
	const albumTitle = createElement('div', { classes: ['album-title'], textContent: album.name });
	const albumMetaKids = [createElement('span', { classes: ['album-type'], textContent: '相册' })];
	if (timeText) albumMetaKids.push(createElement('span', { classes: ['album-time'], textContent: timeText }));
	const infoOverlay = createElement('div', { classes: ['card-info-overlay'], children: [albumTitle, createElement('div', { classes: ['album-meta'], children: albumMetaKids })] });
	const relativeDiv = createElement('div', { classes: ['relative'], attributes: { style: `aspect-ratio: ${aspectRatio}` }, children: [createElement('div', { classes: ['image-placeholder','absolute','inset-0'] }), img, infoOverlay] });
	const link = createElement('a', { classes: ['album-card','group','block','bg-gray-800','rounded-lg','overflow-hidden','shadow-lg','hover:shadow-purple-500/30','transition-shadow'], attributes: { href: `#/${encodeURIComponent(album.path)}${sortParam}` }, children: [relativeDiv] });
	return createElement('div', { classes: ['grid-item','album-link'], attributes: { 'data-path': album.path, 'data-width': album.coverWidth || 1, 'data-height': album.coverHeight || 1 }, children: [link] });
}

/**
 * 渲染流式媒体项（安全 DOM）
 */
export function displayStreamedMedia(type, mediaData, index, showTimestamp) {
	const isVideo = type === 'video';
	const aspectRatio = mediaData.height ? mediaData.width / mediaData.height : 1;
	const timeText = showTimestamp ? formatTime(mediaData.mtime) : '';
	// 占位层
	const kids = [createElement('div', { classes: ['image-placeholder','absolute','inset-0'] })];
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
		kids.push(createElement('img', { classes: ['w-full','h-full','object-cover','absolute','inset-0','lazy-image','opacity-0','transition-opacity','duration-300'], attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': mediaData.thumbnailUrl, alt: '视频预览' } }));
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
		kids.push(createElement('img', { classes: ['w-full','h-full','object-cover','absolute','inset-0','lazy-image','opacity-0','transition-opacity','duration-300'], attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': mediaData.thumbnailUrl, alt: '图片' } }));
	}
	if (timeText) kids.push(createElement('div', { classes: ['absolute','bottom-2','right-2','bg-black/50','text-white','text-sm','px-2','py-1','rounded','shadow-lg'], textContent: timeText }));
	const relativeDiv = createElement('div', { classes: ['relative','w-full','h-full'], attributes: { style: `aspect-ratio: ${aspectRatio}` }, children: kids });
	const photoItem = createElement('div', { classes: ['photo-item','group','block','bg-gray-800','rounded-lg','overflow-hidden','cursor-pointer'], children: [relativeDiv] });
	return createElement('div', { classes: ['grid-item','photo-link'], attributes: { 'data-url': mediaData.originalUrl, 'data-index': index, 'data-width': mediaData.width, 'data-height': mediaData.height }, children: [photoItem] });
}

/**
 * 渲染搜索结果媒体项（安全 DOM）
 */
export function displaySearchMedia(result, index) {
	const isVideo = result.type === 'video';
	const timeText = formatTime(result.mtime);
	const kids = [createElement('div', { classes: ['image-placeholder','absolute','inset-0'] }), createElement('div', { classes: ['loading-overlay'], children: [createElement('div', { classes: ['progress-circle'] })] })];
	if (isVideo) {
		kids.push(createElement('img', { classes: ['w-full','h-full','object-cover','absolute','inset-0','lazy-image','opacity-0','transition-opacity','duration-300'], attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': result.thumbnailUrl, alt: `视频预览：${result.name}` } }));
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
		kids.push(createElement('img', { classes: ['w-full','h-full','object-cover','absolute','inset-0','lazy-image','opacity-0','transition-opacity','duration-300'], attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': result.thumbnailUrl, alt: result.name } }));
	}
	if (timeText) kids.push(createElement('div', { classes: ['absolute','bottom-2','right-2','bg-black/50','text-white','text-sm','px-2','py-1','rounded','shadow-lg'], textContent: timeText }));
	const relativeDiv = createElement('div', { classes: ['aspect-w-1','aspect-h-1','relative'], children: kids });
	const photoItem = createElement('div', { classes: ['photo-item','group','block','bg-gray-800','rounded-lg','overflow-hidden','cursor-pointer'], children: [relativeDiv] });
	const nameDiv = createElement('div', { classes: ['mt-2'], children: [createElement('p', { classes: ['text-xs','text-gray-400','truncate'], textContent: result.name })] });
	return createElement('div', { classes: ['grid-item','photo-link'], attributes: { 'data-url': result.originalUrl, 'data-index': index }, children: [photoItem, nameDiv] });
}

/**
 * 渲染浏览网格（返回 DOM 元素数组）
 */
export function renderBrowseGrid(items, currentPhotoCount) {
	const contentElements = [];
	const newMediaUrls = [];
	// 规则：浏览页中，媒体项（图片/视频）不显示日期角标；仅相册卡片显示
	const showTimestampForMedia = false;
	items.forEach(item => {
		const itemData = item.data;
		if (item.type === 'album') {
			contentElements.push(displayAlbum(itemData));
		} else {
			const mediaIndex = currentPhotoCount + newMediaUrls.length;
			contentElements.push(displayStreamedMedia(item.type, itemData, mediaIndex, showTimestampForMedia));
			newMediaUrls.push(itemData.originalUrl);
		}
	});
	return { contentElements, newMediaUrls };
}

/**
 * 渲染搜索网格（返回 DOM 元素数组）
 */
export function renderSearchGrid(results, currentPhotoCount) {
	const contentElements = [];
	const newMediaUrls = [];
	results.forEach(result => {
		if (result.type === 'album') {
			contentElements.push(displayAlbum(result));
		} else if (result.type === 'photo' || result.type === 'video') {
			const mediaIndex = currentPhotoCount + newMediaUrls.length;
			contentElements.push(displaySearchMedia(result, mediaIndex));
			newMediaUrls.push(result.originalUrl);
		}
	});
	return { contentElements, newMediaUrls };
}

/**
 * 渲染排序下拉菜单（安全 DOM）
 */
export function renderSortDropdown() {
	const sortContainer = document.getElementById('sort-container');
	if (!sortContainer) return;
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
	sortContainer.innerHTML = '';

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
	sortContainer.appendChild(container);

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
 * 检查路径是否包含媒体文件
 */
export async function checkIfHasMediaFiles(path) {
	try {
		const api = await import('./api.js');
		const data = await api.fetchBrowseResults(path, 1, new AbortController().signal);
		if (!data || !data.items) return false;
		return data.items.some(item => item.type === 'photo' || item.type === 'video');
	} catch {
		return false;
	}
}