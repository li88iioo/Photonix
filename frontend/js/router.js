// frontend/js/router.js

import { state, elements } from './state.js';
import { applyMasonryLayout, getMasonryColumns, initializeVirtualScroll } from './masonry.js';
import { setupLazyLoading } from './lazyload.js';
import { fetchSearchResults, fetchBrowseResults, postViewed } from './api.js';
import { renderBreadcrumb, renderBrowseGrid, renderSearchGrid, sortAlbumsByViewed, renderSortDropdown, checkIfHasMediaFiles } from './ui.js';
import { saveViewed, getUnsyncedViewed, markAsSynced } from './indexeddb-helper.js';
import { AbortBus } from './abort-bus.js';
import { handleBrowseScroll, handleSearchScroll, removeScrollListeners } from './listeners.js';
import { showNetworkError, showEmptySearchResults, showEmptyAlbum, showIndexBuildingError, showSkeletonGrid } from './loading-states.js';


let currentRequestController = null;

function getPathOnlyFromHash() {
    const cleanHashString = window.location.hash.replace(/#modal$/, '');
    const newDecodedPath = decodeURIComponent(cleanHashString.substring(1).replace(/^\//, ''));
    const questionMarkIndex = newDecodedPath.indexOf('?');
    return questionMarkIndex !== -1 ? newDecodedPath.substring(0, questionMarkIndex) : newDecodedPath;
}

export function initializeRouter() {
    try {
        const raw = sessionStorage.getItem('sg_scroll_positions');
        if (raw) {
            const obj = JSON.parse(raw);
            const entries = Object.entries(obj).slice(-200);
            const map = new Map(entries);
            state.update('scrollPositions', map);
        }
        const pre = sessionStorage.getItem('sg_pre_search_hash');
        if (pre) state.update('preSearchHash', pre);
    } catch {}

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
}

export async function handleHashChange() {
    if (typeof state.currentBrowsePath === 'string') {
        const key = state.currentBrowsePath;
        state.scrollPositions.set(key, window.scrollY);
    }
    
    AbortBus.abortMany(['page','scroll']);
    const pageSignal = AbortBus.next('page');

    const cleanHashString = window.location.hash.replace(/#modal$/, '');
    const newDecodedPath = decodeURIComponent(cleanHashString.substring(1).replace(/^\//, ''));
    
    const questionMarkIndex = newDecodedPath.indexOf('?');
    const pathOnly = questionMarkIndex !== -1 ? newDecodedPath.substring(0, questionMarkIndex) : newDecodedPath;
    let newSortParam = questionMarkIndex !== -1 ? newDecodedPath.substring(questionMarkIndex) : '';
    
    if (newSortParam.startsWith('?sort=')) {
        newSortParam = newSortParam.substring(6);
    }

    const pathChanged = pathOnly !== state.currentBrowsePath;
    const currentSortValue = newSortParam || (pathChanged ? (state.currentSort || 'smart') : 'smart');
    const previousSort = state.currentSort || 'smart';
    const sortChanged = currentSortValue !== previousSort;
    
    if (!pathChanged && !sortChanged && !state.isInitialLoad) {
        const hasRealContent = !!(elements.contentGrid && elements.contentGrid.querySelector('.grid-item'));
        if (hasRealContent) {
            return;
        }
    }

    removeScrollListeners();

    if (cleanHashString.startsWith('#/search?q=')) {
        if (!state.currentBrowsePath || !state.currentBrowsePath.startsWith('search?q=')) {
            state.preSearchHash = state.currentBrowsePath ? `#/${encodeURIComponent(state.currentBrowsePath)}` : '#/';
        }
    }

    if (newDecodedPath.startsWith('search?q=')) {
        const urlParams = new URLSearchParams(newDecodedPath.substring(newDecodedPath.indexOf('?')));
        const query = urlParams.get('q');
        await executeSearch(query || '', pageSignal);
    } else {
        state.currentSort = currentSortValue;
        state.currentBrowsePath = pathOnly;
        renderBreadcrumb(pathOnly);
        
        if (pathChanged) {
            state.entrySort = currentSortValue;
        } else if (sortChanged) {
            state.entrySort = currentSortValue;
        }
        
        await streamPath(pathOnly, pageSignal);

        try {
            setTimeout(async () => {
                const stillSameRoute = getPathOnlyFromHash() === pathOnly && AbortBus.get('page') === pageSignal;
                const noRealContent = !(elements.contentGrid && elements.contentGrid.querySelector('.grid-item'));
                const notError = !(elements.contentGrid && elements.contentGrid.classList.contains('error-container'));
                if (stillSameRoute && noRealContent && notError) {
                    const retrySignal = AbortBus.next('page');
                    await streamPath(pathOnly, retrySignal);
                }
            }, 6000);
        } catch {}
    }
}

export async function streamPath(path, signal) {
    await prepareForNewContent();
    state.isBrowseLoading = true;
    state.currentBrowsePage = 1;
    state.totalBrowsePages = 1;
    
    renderBreadcrumb(path);
    
    if (path.startsWith('search?q=')) {
        console.error('搜索页面不应该调用 streamPath 函数');
        return;
    }
    
    window.addEventListener('scroll', handleBrowseScroll);
    
    try {
        const [data] = await Promise.all([
            fetchBrowseResults(path, state.currentBrowsePage, signal),
            onAlbumViewed(path)
        ]);

        if (!data || signal.aborted || AbortBus.get('page') !== signal || getPathOnlyFromHash() !== path) return;

        state.currentBrowsePath = path;
        state.totalBrowsePages = data.totalPages;
        
        if (!data.items || data.items.length === 0) {
            const sortContainer = document.getElementById('sort-container');
            if (sortContainer) sortContainer.innerHTML = '';
            state.totalBrowsePages = 0;
            state.currentBrowsePage = 1;
            elements.infiniteScrollLoader.classList.add('hidden');
            showEmptyAlbum();
            return;
        }

        const hasMediaFiles = data.items.some(item => item.type === 'photo' || item.type === 'video');
        const sortContainer = document.getElementById('sort-container');
        if (sortContainer) {
            if (hasMediaFiles) {
                sortContainer.innerHTML = '';
            } else {
                renderSortDropdown();
            }
        }

        elements.contentGrid.classList.add('masonry-mode');
        const { contentElements, newMediaUrls } = renderBrowseGrid(data.items, 0);
        const skeleton = document.getElementById('skeleton-grid');
        if (skeleton) {
            skeleton.replaceWith(...contentElements);
        } else {
            elements.contentGrid.innerHTML = ''; // 清空旧内容
            elements.contentGrid.append(...contentElements);
        }
        
        state.currentPhotos = newMediaUrls;
        state.currentBrowsePage++;
        
        if (AbortBus.get('page') !== signal || getPathOnlyFromHash() !== path) return;
        finalizeNewContent(path);

    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error("Failed to stream path:", error);
            showNetworkError();
            return;
        }
    } finally {
        state.isBrowseLoading = false;
        if (!elements.contentGrid.classList.contains('error-container')) {
            elements.contentGrid.style.minHeight = '';
        }
    }
}

async function executeSearch(query, signal) {
    await prepareForNewContent();
    state.currentPhotos = [];
    state.currentSearchQuery = query;
    state.currentSearchPage = 1;
    state.totalSearchPages = 1;
    state.isSearchLoading = true;
    
    window.addEventListener('scroll', handleSearchScroll);

    try {
        const data = await fetchSearchResults(query, state.currentSearchPage, signal);
        const searchPathKey = `search?q=${query}`;
        if (signal.aborted || AbortBus.get('page') !== signal) return;

        if (!data || !data.results) {
            console.error('搜索返回数据不完整:', data);
            showNetworkError();
            return;
        }

        state.currentBrowsePath = searchPathKey;
        
        elements.breadcrumbNav.innerHTML = `
           <div class="flex items-center">
               <a href="${state.preSearchHash}" class="flex items-center text-purple-400 hover:text-purple-300 transition-colors duration-200 group">
                   <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mr-1 group-hover:-translate-x-1 transition-transform"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                   返回
               </a>
               ${data.results.length > 0 ? `<span class="mx-3 text-gray-600">/</span><span class="text-white">搜索结果: "${data.query || query}" (${data.totalResults || 0}项)</span>` : ''}
           </div>`;

       if (data.results.length === 0) {
          state.totalSearchPages = 0;
          state.currentSearchPage = 1;
          elements.infiniteScrollLoader.classList.add('hidden');
          showEmptySearchResults(query);
          removeScrollListeners();
          elements.contentGrid.style.minHeight = '';
          return;
       }

        elements.contentGrid.classList.add('masonry-mode');
        const { contentElements, newMediaUrls } = renderSearchGrid(data.results, 0);
        const skeleton = document.getElementById('skeleton-grid');
        if (skeleton) {
            skeleton.replaceWith(...contentElements);
        } else {
            elements.contentGrid.innerHTML = ''; // 清空旧内容
            elements.contentGrid.append(...contentElements);
        }
        
        state.totalSearchPages = data.totalPages;
        state.currentPhotos = newMediaUrls;
        state.currentSearchPage++;
        
        if (AbortBus.get('page') !== signal) return;
        finalizeNewContent(searchPathKey);

    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error("Failed to execute search:", error);
            if (error.message && error.message.includes('搜索索引正在构建中')) {
                showIndexBuildingError();
            } else {
                showNetworkError();
            }
            return;
        }
    } finally {
        state.isSearchLoading = false;
        if (!elements.contentGrid.classList.contains('error-container')) {
            elements.contentGrid.style.minHeight = '';
        }
    }
}

function prepareForNewContent() {
    return new Promise(resolve => {
        const scroller = state.get('virtualScroller');
        if (scroller) {
            scroller.destroy();
            state.update('virtualScroller', null);
        }

        window.scrollTo({ top: 0, behavior: 'instant' });
        elements.contentGrid.style.minHeight = `${elements.contentGrid.offsetHeight}px`;
        
        // 添加淡出 class
        elements.contentGrid.classList.add('grid-leaving');

        // 等待动画完成
        setTimeout(() => {
            showSkeletonGrid();
            elements.contentGrid.classList.remove('masonry-mode', 'grid-leaving');
            elements.contentGrid.classList.add('grid-entering');
            elements.contentGrid.style.height = 'auto';
            elements.infiniteScrollLoader.classList.add('hidden');
            state.update('currentPhotos', []);

            // 动画结束后移除 entering class
            elements.contentGrid.addEventListener('transitionend', () => {
                elements.contentGrid.classList.remove('grid-entering');
            }, { once: true });

            resolve();
        }, 150); // 匹配 CSS 中的 transition duration
    });
}

function finalizeNewContent(pathKey) {
    if (!state.get('virtualScroller')) {
        setupLazyLoading();
        applyMasonryLayout();
    }
    
    sortAlbumsByViewed();
    state.update('currentColumnCount', getMasonryColumns());
    
    const scrollY = state.get('scrollPositions').get(pathKey);
    if (scrollY) {
        window.scrollTo({ top: scrollY, behavior: 'instant' });
        state.get('scrollPositions').delete(pathKey);
    } else if (state.get('isInitialLoad')) {
        window.scrollTo({ top: 0, behavior: 'instant' });
    }
    
    elements.contentGrid.style.minHeight = '';
    state.update('isInitialLoad', false);
}

function saveCurrentScrollPosition() {
    const key = state.currentBrowsePath;
    if (typeof key === 'string' && key.length > 0) {
        state.scrollPositions.set(key, window.scrollY);
        try {
            const obj = Object.fromEntries(state.scrollPositions);
            const entries = Object.entries(obj);
            const limited = entries.slice(-200);
            sessionStorage.setItem('sg_scroll_positions', JSON.stringify(Object.fromEntries(limited)));
            sessionStorage.setItem('sg_pre_search_hash', state.preSearchHash || '#/');
        } catch {}
    }
}

window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        saveCurrentScrollPosition();
    }
});

window.addEventListener('beforeunload', () => {
    saveCurrentScrollPosition();
});

async function onAlbumViewed(path) {
    if (!path) return;
    await saveViewed(path, Date.now(), navigator.onLine);
    if (navigator.onLine) {
        try {
            await postViewed(path);
            await markAsSynced(path);
        } catch (e) {}
    }
}

window.addEventListener('online', async () => {
    const unsynced = await getUnsyncedViewed();
    for (const record of unsynced) {
        try {
            await postViewed(record.path);
            await markAsSynced(record.path);
        } catch (e) {}
    }
});
