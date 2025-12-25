/**
 * 智能排序：已查看的相册自动后置（已废弃，仅保留结构，不予特殊处理）
 */

import { state } from '../../core/state.js';
import * as api from '../../app/api.js';
import { applyMasonryLayout, triggerMasonryUpdate } from './masonry.js';
import { setupLazyLoading } from './lazyload.js';
import { MATH, UI } from '../../core/constants.js';
import { uiLogger } from '../../core/logger.js';
import { createProgressCircle, createPlayButton, createGridIcon, createMasonryIcon, createSortArrow, createDeleteIcon, createBackArrow, createGridIconNew, createMasonryIconNew, createHomeIcon } from '../../shared/svg-templates.js';
import { elements, reinitializeElements } from '../../shared/dom-elements.js';
import { safeSetInnerHTML} from '../../shared/dom-utils.js';

// 向后兼容，导出 elements
export { elements };

/**
 * 从 URL hash 中提取纯路径部分，去除 # 和查询参数
 * @returns {string} 路径字符串
 */
function getPathOnlyFromHash() {
	const hash = window.location.hash;
	const cleanHash = hash.replace(/^#/, '').replace(/\?.*$/, '');
	return decodeURIComponent(cleanHash.replace(/^\//, ''));
}

/**
 * 安全创建 DOM 元素并设置属性与内容
 * @param {string} tag 元素标签名
 * @param {Object} options 创建选项
 * @param {Array} options.classes CSS 类名数组
 * @param {Object} options.attributes 属性对象
 * @param {string} options.textContent 文本内容
 * @param {Array} options.children 子节点元素数组
 * @returns {HTMLElement}
 */
function createElement(tag, { classes = [], attributes = {}, textContent = '', children = [] } = {}) {
	const element = document.createElement(tag);

	if (classes.length > 0) {
		element.classList.add(...classes);
	}

	if (Object.keys(attributes).length > 0) {
		Object.entries(attributes).forEach(([key, value]) => {
			element.setAttribute(key, value);
		});
	}

	if (textContent) {
		element.textContent = textContent;
	}

	if (children.length > 0) {
		children.forEach(child => {
			if (child instanceof Element) {
				element.appendChild(child);
			}
		});
	}

	return element;
}

/**
 * 请求下一帧刷新布局
 */
function scheduleLayoutRefresh() {
	requestAnimationFrame(() => {
		try {
			applyLayoutMode();
			triggerMasonryUpdate();
			setupLazyLoading();
		} catch (error) {
			uiLogger.warn('刷新布局模式失败', error);
		}
	});
}

/**
 * 格式化时间显示
 * @param {number|string} timestamp 时间戳
 * @returns {string} 格式化后的时间
 */
function formatTime(timestamp) {
	if (timestamp == null || timestamp === '') return '';

	const timestampNum = typeof timestamp === 'number'
		? timestamp
		: (typeof timestamp === 'string' ? parseInt(timestamp, 10) : Number(timestamp));

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
 * 解析当前的排序查询参数
 * @returns {string} 排序参数字符串，如 ?sort=name_asc
 */
function resolveActiveSortQuery() {
	const currentSort = state.currentSort && state.currentSort !== 'smart' ? state.currentSort : null;
	const entrySort = state.entrySort && state.entrySort !== 'smart' ? state.entrySort : null;
	const activeSort = currentSort || entrySort;
	if (activeSort) return `?sort=${activeSort}`;
	const hash = window.location.hash || '';
	const questionMarkIndex = hash.indexOf('?');
	return questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '';
}

/**
 * 路径字符串按分隔符逐级编码，适用于 hash URL
 * @param {string} path
 * @returns {string} 编码后的路径
 */
function encodePathForHash(path) {
	return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * 清除排序缓存（保留 API 但无实际操作，兼容调用）
 */
export function clearSortCache() { }

/**
 * 确保排序按钮容器节点位于设置按钮之前
 * @param {HTMLElement} sortContainer 排序按钮父容器
 * @returns {HTMLElement} 已创建或复用的排序容器
 */
function ensureSortWrapperElement(sortContainer) {
	const settingsBtn = sortContainer.querySelector('#settings-btn');
	let sortWrapper = sortContainer.querySelector('#sort-wrapper');
	if (!sortWrapper) {
		sortWrapper = document.createElement('div');
		sortWrapper.id = 'sort-wrapper';
		sortWrapper.className = 'relative';
		Object.assign(sortWrapper.style, {
			display: 'inline-block',
			position: 'relative'
		});
	}
	if (settingsBtn) {
		sortContainer.insertBefore(sortWrapper, settingsBtn);
	} else if (!sortWrapper.parentNode) {
		sortContainer.appendChild(sortWrapper);
	}
	return sortWrapper;
}

/**
 * 确保排序分隔线节点紧邻排序按钮
 * @param {HTMLElement} sortContainer
 */
function ensureLayoutDividerElement(sortContainer) {
	const sortWrapper = sortContainer.querySelector('#sort-wrapper');
	let divider = sortContainer.querySelector('.layout-divider');
	if (!divider) {
		divider = document.createElement('div');
		divider.className = 'layout-divider';
	}
	const referenceNode = sortWrapper || sortContainer.querySelector('#settings-btn');
	if (referenceNode) {
		sortContainer.insertBefore(divider, referenceNode);
	} else if (!divider.parentNode) {
		sortContainer.appendChild(divider);
	}
}

/**
 * 移除排序相关 DOM 节点，清除冗余空白
 * @param {HTMLElement} sortContainer
 */
export function removeSortControls(sortContainer) {
	const container =
		sortContainer
		|| elements.sortContainer
		|| document.querySelector('#topbar .flex.items-center.space-x-1')
		|| document.getElementById('sort-container');
	if (!container) return;

	const sortWrapper = container.querySelector('#sort-wrapper') || document.getElementById('sort-wrapper');
	if (sortWrapper) sortWrapper.remove();

	const divider = container.querySelector('.layout-divider');
	if (divider) divider.remove();
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
	const sortParam = resolveActiveSortQuery();

	// 确保必要节点存在
	let breadcrumbLinks = breadcrumbNav.querySelector('#breadcrumb-links');
	let sortContainer = breadcrumbNav.querySelector('#sort-container');

	if (!breadcrumbLinks || !sortContainer) {
		// 初始化：清空并重建结构
		while (breadcrumbNav.firstChild) {
			breadcrumbNav.removeChild(breadcrumbNav.firstChild);
		}
		breadcrumbLinks = createElement('div', { classes: ['flex-1', 'min-w-0'], attributes: { id: 'breadcrumb-links' } });
		sortContainer = createElement('div', { classes: ['flex-shrink-0', 'ml-4'], attributes: { id: 'sort-container' } });
		breadcrumbNav.append(breadcrumbLinks, sortContainer);
	}

	// 首页显示 icon.svg 图标，点击返回主页
	if (!path || path === '') {
		while (breadcrumbLinks.firstChild) {
			breadcrumbLinks.removeChild(breadcrumbLinks.firstChild);
		}
		const homeLink = createElement('a', {
			classes: ['flex', 'items-center', 'transition-opacity', 'hover:opacity-70'],
			attributes: { href: '#/', title: '首页' }
		});
		const iconImg = createElement('img', {
			classes: ['w-6', 'h-6'],
			attributes: { src: 'assets/icon.svg', alt: 'Photonix' }
		});
		const brandText = createElement('span', {
			classes: ['ml-2', 'font-bold', 'text-lg', 'tracking-tight', 'text-gray-900'],
			textContent: 'Photonix'
		});
		homeLink.appendChild(iconImg);
		homeLink.appendChild(brandText);
		breadcrumbLinks.appendChild(homeLink);
		return;
	}
	const container = createElement('div', { classes: ['flex', 'items-center', 'whitespace-nowrap'] });

	// 若来源自搜索页，添加返回搜索链接
	if (state.fromSearchHash) {
		const searchLink = createElement('a', {
			classes: ['breadcrumb-link', 'text-gray-500', 'hover:text-black', 'flex', 'items-center', 'transition-colors'],
			attributes: { href: state.fromSearchHash, title: '返回搜索结果' }
		});
		searchLink.appendChild(createBackArrow());
		searchLink.appendChild(document.createTextNode('返回'));
		container.appendChild(searchLink);
		container.appendChild(createElement('span', { classes: ['mx-2', 'text-gray-300'], textContent: '|' }));
	}

	// 添加“首页”
	container.appendChild(createElement('a', {
		classes: ['text-gray-500', 'hover:text-black', 'transition-colors'],
		attributes: { href: `#/${sortParam}` },
		textContent: '首页'
	}));
	parts.forEach((part, index) => {
		currentPath += (currentPath ? '/' : '') + part;
		const isLast = index === parts.length - 1;
		container.appendChild(createElement('span', { classes: ['mx-2', 'text-gray-300'], textContent: '/' }));
		if (isLast) {
			container.appendChild(createElement('span', { classes: ['text-black', 'font-bold'], textContent: decodeURIComponent(part) }));
		} else {
			container.appendChild(createElement('a', {
				classes: ['text-gray-500', 'hover:text-black', 'transition-colors'],
				attributes: { href: `#/${encodeURIComponent(currentPath)}${sortParam}` },
				textContent: decodeURIComponent(part)
			}));
		}
	});
	// DOM 安全清空插入
	while (breadcrumbLinks.firstChild) breadcrumbLinks.removeChild(breadcrumbLinks.firstChild);
	breadcrumbLinks.appendChild(container);

	setTimeout(() => {
		const sortContainer = elements.sortContainer;
		if (!sortContainer) return;

		// 确保布局切换按钮存在
		let toggleWrap = sortContainer.querySelector('#layout-toggle-wrap');
		if (!toggleWrap) {
			const toggle = createLayoutToggle();
			if (toggle?.button) {
				toggleWrap = document.createElement('div');
				toggleWrap.id = 'layout-toggle-wrap';
				toggleWrap.className = 'relative';
				const settingsBtn = sortContainer.querySelector('#settings-btn');
				if (settingsBtn) {
					sortContainer.insertBefore(toggleWrap, settingsBtn);
				} else {
					sortContainer.appendChild(toggleWrap);
				}
				toggleWrap.appendChild(toggle.button);
			}
		}

		const shouldRemoveSort = Boolean(state.fromSearchHash || window.location.hash.includes('/search'));
		if (shouldRemoveSort) {
			removeSortControls(sortContainer);
			return;
		}

		const displaySortDropdown = () => {
			ensureSortWrapperElement(sortContainer);
			ensureLayoutDividerElement(sortContainer);
			renderSortDropdown();
		};

		checkIfHasMediaFiles(path)
			.then(hasMedia => {
				if (hasMedia) {
					removeSortControls(sortContainer);
				} else {
					displaySortDropdown();
				}
			})
			.catch(() => {
				displaySortDropdown();
			});
	}, 100);
}

/**
 * 渲染相册卡片
 * @param {Object} album 相册数据
 * @returns {HTMLElement}
 */
export function displayAlbum(album) {
	const aspectRatio = album.coverHeight ? album.coverWidth / album.coverHeight : 1;
	const timeText = formatTime(album.mtime);
	const sortParam = resolveActiveSortQuery();
	const img = createElement('img', {
		classes: ['w-full', 'h-full', 'object-cover', 'absolute', 'inset-0', 'lazy-image', 'transition-opacity', 'duration-300'],
		attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': album.coverUrl, alt: album.name }
	});
	const albumTitle = createElement('div', { classes: ['album-title'], textContent: album.name });
	const albumMetaKids = [createElement('span', { classes: ['album-type'], textContent: '相册' })];
	if (timeText) albumMetaKids.push(createElement('span', { classes: ['album-time'], textContent: timeText }));
	const infoOverlay = createElement('div', {
		classes: ['card-info-overlay'],
		children: [albumTitle, createElement('div', { classes: ['album-meta'], children: albumMetaKids })]
	});

	const deleteTrigger = createElement('button', {
		classes: ['album-delete-trigger'],
		attributes: { type: 'button', 'aria-label': '删除相册' },
		children: [createDeleteIcon()]
	});
	const deleteConfirm = createElement('button', { classes: ['album-delete-confirm'], attributes: { type: 'button' }, textContent: '确认删除' });
	const deleteCancel = createElement('button', { classes: ['album-delete-cancel'], attributes: { type: 'button' }, textContent: '取消' });
	const confirmGroup = createElement('div', { classes: ['album-delete-confirm-group'], children: [deleteConfirm, deleteCancel] });
	const deleteStage = createElement('div', { classes: ['album-delete-stage'], children: [deleteTrigger, confirmGroup] });
	const deleteOverlay = createElement('div', {
		classes: ['album-delete-overlay'],
		attributes: { 'data-state': 'idle', 'data-path': album.path },
		children: [deleteStage]
	});

	const relativeDiv = createElement('div', {
		classes: ['relative'],
		attributes: { style: `aspect-ratio: ${aspectRatio}` },
		children: [
			createElement('div', { classes: ['image-placeholder', 'absolute', 'inset-0'] }),
			img,
			infoOverlay,
			deleteOverlay
		]
	});
	const link = createElement('a', {
		classes: ['album-card', 'group', 'block', 'bg-white', 'border', 'border-gray-200', 'rounded-lg', 'overflow-hidden', 'shadow-sm', 'hover:shadow-md', 'transition-shadow'],
		attributes: { href: `#/${encodeURIComponent(album.path)}${sortParam}` },
		children: [relativeDiv]
	});
	return createElement('div', {
		classes: ['grid-item', 'album-link'],
		attributes: { 'data-path': album.path, 'data-width': album.coverWidth || 1, 'data-height': album.coverHeight || 1 },
		children: [link]
	});
}

/**
 * 渲染流式媒体项（图片或视频）
 * @param {string} type 媒体类型
 * @param {Object} mediaData 媒体数据
 * @param {number} index 索引
 * @param {boolean} showTimestamp 是否显示时间戳
 * @returns {HTMLElement}
 */
export function displayStreamedMedia(type, mediaData, index, showTimestamp) {
	const isVideo = type === 'video';
	const aspectRatio = (mediaData.height && mediaData.width)
		? mediaData.width / mediaData.height
		: (isVideo ? UI.ASPECT_RATIO.VIDEO_DEFAULT : UI.ASPECT_RATIO.IMAGE_DEFAULT);
	const timeText = showTimestamp ? formatTime(mediaData.mtime) : '';

	const placeholderClasses = ['image-placeholder', 'absolute', 'inset-0'];
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
		kids.push(createElement('img', {
			classes: ['w-full', 'h-full', 'object-cover', 'absolute', 'inset-0', 'lazy-image', 'transition-opacity', 'duration-300'],
			attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': mediaData.thumbnailUrl, alt: '视频缩略图' }
		}));
		const overlay = createElement('div', { classes: ['video-thumbnail-overlay'] });
		const playBtn = createElement('div', { classes: ['video-play-button'] });
		const playSvg = createPlayButton();
		playBtn.appendChild(playSvg);
		overlay.append(playBtn);
		kids.push(overlay);
	} else {
		kids.push(createElement('img', {
			classes: ['w-full', 'h-full', 'object-cover', 'absolute', 'inset-0', 'lazy-image', 'transition-opacity', 'duration-300'],
			attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': mediaData.thumbnailUrl, alt: '图片缩略图' }
		}));
	}
	// 时间浮层
	if (timeText) {
		kids.push(createElement('div', {
			classes: ['absolute', 'bottom-2', 'right-2', 'bg-black/50', 'text-white', 'text-sm', 'px-2', 'py-1', 'rounded', 'shadow-lg'],
			textContent: timeText
		}));
	}
	// 容器 aspect-ratio 保持原始比例
	const containerStyle = `aspect-ratio: ${aspectRatio};`;
	const relativeDiv = createElement('div', {
		classes: ['relative', 'w-full', 'h-full'],
		attributes: {
			style: containerStyle,
			'data-aspect-ratio': aspectRatio.toFixed(MATH.ASPECT_RATIO_PRECISION),
			'data-original-width': mediaData.width || 0,
			'data-original-height': mediaData.height || 0
		},
		children: kids
	});
	const photoItem = createElement('div', {
		classes: ['photo-item', 'group', 'block', 'bg-white', 'border', 'border-gray-200', 'rounded-lg', 'overflow-hidden', 'cursor-pointer'],
		children: [relativeDiv]
	});
	return createElement('div', {
		classes: ['grid-item', 'photo-link'],
		attributes: { 'data-url': mediaData.originalUrl, 'data-index': index, 'data-width': mediaData.width, 'data-height': mediaData.height },
		children: [photoItem]
	});
}

/**
 * 渲染搜索结果媒体项
 * @param {Object} result 搜索结果
 * @param {number} index 索引
 * @returns {HTMLElement}
 */
export function displaySearchMedia(result, index) {
	const isVideo = result.type === 'video';
	const timeText = formatTime(result.mtime);
	const aspectRatio = result.height ? result.width / result.height : 1;
	const kids = [
		createElement('div', { classes: ['image-placeholder', 'absolute', 'inset-0'] }),
		createElement('div', {
			classes: ['loading-overlay'],
			children: [createElement('div', { classes: ['progress-circle'] })]
		})
	];
	if (isVideo) {
		kids.push(createElement('img', {
			classes: ['w-full', 'h-full', 'object-cover', 'absolute', 'inset-0', 'lazy-image', 'transition-opacity', 'duration-300'],
			attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': result.thumbnailUrl, alt: `视频缩略图：${result.name}` }
		}));
		const overlay = createElement('div', { classes: ['video-thumbnail-overlay'] });
		const playBtn = createElement('div', { classes: ['video-play-button'] });
		const playSvg = createPlayButton();
		playBtn.appendChild(playSvg);
		overlay.append(playBtn);
		kids.push(overlay);
	} else {
		kids.push(createElement('img', {
			classes: ['w-full', 'h-full', 'object-cover', 'absolute', 'inset-0', 'lazy-image', 'transition-opacity', 'duration-300'],
			attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E", 'data-src': result.thumbnailUrl, alt: result.name }
		}));
	}
	// 时间浮层（视频和图片都显示）
	if (timeText) {
		kids.push(createElement('div', {
			classes: ['absolute', 'bottom-2', 'right-2', 'bg-black/50', 'text-white', 'text-sm', 'px-2', 'py-1', 'rounded', 'shadow-lg'],
			textContent: timeText
		}));
	}

	const containerStyle = `aspect-ratio: ${aspectRatio};`;
	const relativeDiv = createElement('div', {
		classes: ['relative', 'w-full', 'h-full'],
		attributes: {
			style: containerStyle,
			'data-aspect-ratio': aspectRatio.toFixed(2),
			'data-original-width': result.width || 0,
			'data-original-height': result.height || 0
		},
		children: kids
	});

	const card = createElement('div', {
		classes: ['photo-item', 'group', 'block', 'bg-white', 'border', 'border-gray-200', 'rounded-lg', 'overflow-hidden', 'cursor-pointer'],
		children: [relativeDiv]
	});
	const nameDiv = createElement('div', {
		classes: ['mt-2'],
		children: [createElement('p', { classes: ['text-xs', 'text-gray-400', 'truncate'], textContent: result.name })]
	});
	const attrs = {
		'data-url': result.originalUrl,
		'data-index': index,
		'data-width': result.width || 1,
		'data-height': result.height || 1
	};
	return createElement('div', {
		classes: ['grid-item', 'photo-link'],
		attributes: attrs,
		children: nameDiv ? [card, nameDiv] : [card]
	});
}

/**
 * 渲染浏览网格（返回 DOM 元素集合）
 * @param {Array} items 项目数组
 * @param {number} currentPhotoCount 当前照片计数
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
 * 渲染搜索网格（返回 DOM 元素集合）
 * @param {Array} results 搜索结果数组
 * @param {number} currentPhotoCount 当前照片计数
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

	const sortWrapper = ensureSortWrapperElement(sortContainer);
	ensureLayoutDividerElement(sortContainer);

	// 清空 sortWrapper
	while (sortWrapper.firstChild) {
		sortWrapper.removeChild(sortWrapper.firstChild);
	}

	// 当前排序参数
	const hash = window.location.hash;
	const questionMarkIndex = hash.indexOf('?');
	const urlParams = new URLSearchParams(questionMarkIndex !== -1 ? hash.substring(questionMarkIndex) : '');
	const currentSort = urlParams.get('sort') || 'mtime_desc';

	// 排序选项定义
	const sortOptions = {
		'name_asc': {
			label: '名称 (A-Z)',
			icon: '<svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M18 15V5M18 5L22 9M18 5L14 9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 10L6 4L8 10M5.1 8H6.9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 14H8L4 20H8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
		},
		'name_desc': {
			label: '名称 (Z-A)',
			icon: '<svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M18 9V19M18 19L22 15M18 19L14 15" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 20L6 14L8 20M5.1 18H6.9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 4H8L4 10H8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
		},
		'mtime_desc': {
			label: '日期 (最新)',
			icon: '<svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>'
		},
		'mtime_asc': {
			label: '日期 (最早)',
			icon: '<svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>'
		},
		'viewed_desc': {
			label: '最近浏览',
			icon: '<svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>'
		}
	};

	// 排序按钮
	const sortButton = document.createElement('button');
	sortButton.id = 'sort-btn';
	sortButton.className = 'p-2 rounded-lg text-gray-600 hover:text-black hover:bg-gray-100 transition-all group relative flex items-center justify-center';
	sortButton.setAttribute('aria-expanded', 'false');

	// 设置当前选中图标
	const currentOption = sortOptions[currentSort] || sortOptions['mtime_desc'];
	const isSortDisabled = currentSort === 'smart';
	sortButton.innerHTML = `<svg id="current-sort-icon" class="w-5 h-5 transition-transform duration-300 group-hover:scale-110" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">${currentOption.icon.replace(/<svg[^>]*>|<\/svg>/g, '')}</svg>`;
	if (isSortDisabled) {
		sortButton.classList.add('opacity-40', 'cursor-not-allowed');
		sortButton.title = '智能排序时无法切换';
	}

	// 排序下拉菜单
	const sortMenu = document.createElement('div');
	sortMenu.id = 'sort-menu';
	sortMenu.className = 'hidden absolute right-0 mt-2 w-48 bg-white border border-gray-100 rounded-xl shadow-soft-lg py-2 z-50 origin-top-right opacity-0 scale-95 transition-all';

	// 菜单标题
	const menuTitle = document.createElement('div');
	menuTitle.className = 'px-4 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-widest';
	menuTitle.textContent = '排序方式';
	sortMenu.appendChild(menuTitle);

	// 排序选项
	Object.entries(sortOptions).forEach(([value, config]) => {
		const option = document.createElement('button');
		option.className = 'w-full text-left px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 hover:text-black transition-colors flex items-center gap-3';
		option.setAttribute('data-sort', value);
		if (value === currentSort) {
			option.classList.add('bg-gray-100', 'text-black');
		}

		option.innerHTML = config.icon + `<span>${config.label}</span>`;

		option.addEventListener('click', (e) => {
			e.stopPropagation();
			sortMenu.querySelectorAll('button[data-sort]').forEach(btn => {
				btn.classList.remove('bg-gray-100', 'text-black');
			});
			option.classList.add('bg-gray-100', 'text-black');

			// 更新 URL 到新排序值
			const currentHash = window.location.hash;
			const newHash = `${currentHash.split('?')[0]}?sort=${value}`;

			// 更新按钮的当前图标
			const iconContainer = sortButton.querySelector('#current-sort-icon');
			if (iconContainer) {
				iconContainer.innerHTML = config.icon.replace(/<svg[^>]*>|<\/svg>/g, '');
			}

			// 关闭菜单
			sortMenu.classList.add('hidden', 'opacity-0', 'scale-95');
			sortMenu.classList.remove('opacity-100', 'scale-100');
			sortButton.setAttribute('aria-expanded', 'false');

			// 跳转到新 URL
			if (window.location.hash !== newHash) {
				window.location.hash = newHash;
			}
		});

		sortMenu.appendChild(option);

		// 日期类选项后补分隔线
		if (value === 'mtime_asc') {
			const divider = document.createElement('div');
			divider.className = 'h-px bg-gray-100 my-1 mx-2';
			sortMenu.appendChild(divider);
		}
	});

	// 添加按钮与菜单至容器
	sortWrapper.appendChild(sortButton);
	sortWrapper.appendChild(sortMenu);

	// 按钮点击展开菜单
	sortButton.addEventListener('click', (e) => {
		if (isSortDisabled) {
			e.preventDefault();
			return;
		}
		e.stopPropagation();
		const isHidden = sortMenu.classList.contains('hidden');
		if (isHidden) {
			sortMenu.classList.remove('hidden');
			requestAnimationFrame(() => {
				sortMenu.classList.remove('opacity-0', 'scale-95');
				sortMenu.classList.add('opacity-100', 'scale-100');
			});
		} else {
			sortMenu.classList.remove('opacity-100', 'scale-100');
			sortMenu.classList.add('opacity-0', 'scale-95');
			setTimeout(() => sortMenu.classList.add('hidden'), 200);
		}
		sortButton.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
	});

	// 全局点击关闭菜单
	document.addEventListener('click', (e) => {
		if (!sortButton.contains(e.target) && !sortMenu.contains(e.target)) {
			sortMenu.classList.remove('opacity-100', 'scale-100');
			sortMenu.classList.add('opacity-0', 'scale-95', 'hidden');
			sortButton.setAttribute('aria-expanded', 'false');
		}
	});
}

/**
 * 仅渲染布局切换按钮到 sort-container（仅适用于搜索页，避免绑定丢失）
 * @param {boolean} withAnimation 是否带入场动画（目录/首页无动画，内容页有动画）
 */
export function renderLayoutToggleOnly(withAnimation = false) {
	const layoutToggleWrap = document.getElementById('layout-toggle-wrap');
	if (!layoutToggleWrap) {
		uiLogger.debug('layout-toggle-wrap 不存在');
		return;
	}

	layoutToggleWrap.innerHTML = '';
	uiLogger.debug('创建新的布局切换按钮');

	requestAnimationFrame(() => {
		try {
			const toggle = createLayoutToggle();
			if (!toggle || !toggle.button) {
				uiLogger.warn('创建布局切换按钮失败');
				return;
			}

			// 插入按钮
			layoutToggleWrap.appendChild(toggle.button);

			// 判断动画
			if (withAnimation) {
				layoutToggleWrap.offsetHeight; // 强制重绘
				requestAnimationFrame(() => {
					layoutToggleWrap?.classList.add('visible');
				});
			} else {
				layoutToggleWrap?.classList.add('visible');
			}
		} catch (error) {
			uiLogger.error('渲染布局切换按钮出错', error);
		}
	});
}

/**
 * 确保布局切换按钮显示可见
 */
export function ensureLayoutToggleVisible() {
	const sortContainer = elements.sortContainer;
	if (!sortContainer) return;

	const toggleWrap = sortContainer.querySelector('#layout-toggle-wrap');
	if (toggleWrap && !toggleWrap?.classList.contains('visible')) {
		// 直接强制可见
		toggleWrap?.classList.add('visible');
	}
}

/**
 * 根据内容长度动态更新页面滚动优化样式类
 * @param {string} path 路径
 */
export function adjustScrollOptimization(path) {
	requestAnimationFrame(() => {
		const contentGrid = elements.contentGrid;
		if (!contentGrid) return;

		const gridItems = contentGrid.querySelectorAll('.grid-item');
		const viewportHeight = window.innerHeight;

		let totalContentHeight = 0;
		gridItems.forEach(item => {
			const rect = item.getBoundingClientRect();
			totalContentHeight = Math.max(totalContentHeight, rect.bottom);
		});

		const body = document.body;
		body?.classList.remove('has-short-content');
		body?.classList.remove('has-long-content');

		// 高度判定
		if (totalContentHeight > viewportHeight * 1.2) {
			body?.classList.add('has-long-content');
		} else {
			body?.classList.add('has-short-content');
		}
	});
}

/**
 * 检查指定路径下是否存在媒体文件（图片或视频）
 * @param {string} path 路径
 * @returns {Promise<boolean>} 是否含有媒体文件
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
 * 创建布局图标 SVG 元素
 * @param {string} kind 布局类型（'grid' | 'masonry'）
 * @returns {SVGElement}
 */
function createLayoutIcon(kind) {
	return kind === 'grid' ? createGridIcon() : createMasonryIcon();
}

/**
 * 返回布局图标的 HTML 字符串
 * @param {string} kind 布局类型（'grid' | 'masonry'）
 * @returns {string}
 */
function iconHtml(kind) {
	return createLayoutIcon(kind).outerHTML;
}

/**
 * 初始化 UI 状态订阅相关逻辑
 */
export function initializeUI() {
	state.subscribe(['layoutMode'], (changedKeys, currentState) => {
		uiLogger.debug('布局模式已更改', { changedKeys, currentState: currentState.layoutMode });

		applyLayoutMode();

		// 确保 elements 最新
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
 * 动态更新布局切换按钮的显示状态
 * @param {HTMLElement} btn
 */
export function updateLayoutToggleButton(btn) {
	try {
		const isGrid = state.layoutMode === 'grid';
		while (btn.firstChild) btn.removeChild(btn.firstChild);

		const gridIcon = createGridIconNew();
		const masonryIcon = createMasonryIconNew();

		if (isGrid) {
			gridIcon.classList.remove('hidden');
			gridIcon.classList.add('block');
			masonryIcon.classList.add('hidden');
			masonryIcon.classList.remove('block');
		} else {
			gridIcon.classList.add('hidden');
			gridIcon.classList.remove('block');
			masonryIcon.classList.remove('hidden');
			masonryIcon.classList.add('block');
		}

		btn.appendChild(gridIcon);
		btn.appendChild(masonryIcon);
		btn.setAttribute('aria-pressed', isGrid ? 'true' : 'false');
	} catch (error) {
		uiLogger.error('更新布局切换按钮出错', error);
	}
}

/**
 * 创建布局切换按钮（网格/瀑布流）
 * @returns {Object} { button: HTMLElement }
 */
function createLayoutToggle() {
	const btn = createElement('button', {
		classes: ['p-2', 'rounded-lg', 'text-gray-600', 'hover:text-black', 'hover:bg-gray-100', 'transition-all', 'relative', 'group', 'flex', 'items-center', 'justify-center'],
		attributes: { id: 'layout-toggle-btn', type: 'button', 'aria-pressed': state.layoutMode === 'grid' ? 'true' : 'false' }
	});
	function updateLabel() {
		const isGrid = state.layoutMode === 'grid';
		safeSetInnerHTML(btn, '');
		const gridIcon = createGridIconNew();
		const masonryIcon = createMasonryIconNew();

		if (isGrid) {
			gridIcon.classList.remove('hidden');
			gridIcon.classList.add('block');
			masonryIcon.classList.add('hidden');
			masonryIcon.classList.remove('block');
		} else {
			gridIcon.classList.add('hidden');
			gridIcon.classList.remove('block');
			masonryIcon.classList.remove('hidden');
			masonryIcon.classList.add('block');
		}

		btn.appendChild(gridIcon);
		btn.appendChild(masonryIcon);
		btn.setAttribute('aria-pressed', isGrid ? 'true' : 'false');
	}
	// 不直接绑定事件，采用委托监听（见 listeners.js）
	updateLabel();
	return { button: btn };
}

/**
 * 应用当前布局模式到内容容器
 * 根据 state.layoutMode，切换网格或瀑布流布局，并同步样式与布局流程
 */
export function applyLayoutMode() {
	const grid = elements.contentGrid;
	if (!grid) return;
	const mode = state.layoutMode;

	// 空、加载、错误状态不应用任何布局类
	const hasStandaloneState = grid.querySelector('.empty-state, .error-container, #minimal-loader');
	if (hasStandaloneState) {
		grid?.classList.remove('grid-mode');
		grid?.classList.remove('masonry-mode');
		grid.removeAttribute('style');
		return;
	}

	if (mode === 'grid') {
		// 切换为网格模式

		grid?.classList.remove('masonry-mode');

		Array.from(grid.children).forEach(item => {
			// 清除瀑布流定位属性但不移除 position，避免布局跳动
			item.style.removeProperty('transform');
			item.style.removeProperty('width');
			item.style.removeProperty('height');
			item.style.removeProperty('will-change');
			item.style.removeProperty('left');
			item.style.removeProperty('top');
			// position 由 grid-mode CSS 规则覆盖
		});
		grid.removeAttribute('style');
		void grid.offsetHeight; // 触发重排
		grid?.classList.add('grid-mode');
		grid.style.setProperty('--grid-aspect', '1/1');

	} else {
		// 切换为瀑布流模式

		grid?.classList.remove('grid-mode');
		grid.removeAttribute('style');
		grid?.classList.add('masonry-mode');
		// 立即刷新瀑布流布局
		applyMasonryLayout();
		triggerMasonryUpdate();
	}
}
