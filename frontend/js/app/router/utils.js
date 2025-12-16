/**
 * @file router/utils.js
 * @description 路由相关工具函数
 */

import { state, clearExpiredAlbumTombstones, getAlbumTombstonesMap } from '../../core/state.js';
import { escapeHtml } from '../../shared/security.js';
import { recordHierarchyView } from '../../features/history/history-service.js';

/**
 * 过滤集合，剔除被"墓碑"标记的相册项。
 * @param {Array} collection - 原始项目集合（相册和照片）
 * @returns {Object} { items: 过滤后的集合, removed: 被移除数量 }
 */
export function applyAlbumTombstones(collection) {
    clearExpiredAlbumTombstones();
    const tombstones = getAlbumTombstonesMap();
    if (!(tombstones instanceof Map) || tombstones.size === 0) {
        return { items: collection, removed: 0 };
    }
    const filtered = [];
    let removed = 0;
    for (const item of collection || []) {
        if (item?.type === 'album') {
            const albumPath = item?.data?.path;
            if (albumPath && tombstones.has(albumPath)) {
                removed += 1;
                continue;
            }
        }
        filtered.push(item);
    }
    return { items: filtered, removed };
}

/**
 * 生成面包屑导航HTML，保证安全性。
 * @param {Object} data - 搜索结果数据
 * @param {string} query - 搜索查询词
 * @returns {string} HTML 字符串
 */
export function generateBreadcrumbHTML(data, query) {
    const preSearchHash = state.preSearchHash;
    const hasResults = data.results && data.results.length > 0;
    const searchQuery = escapeHtml(data.query || query || '');
    const totalResults = data.totalResults || 0;
    return `
       <div class="flex items-center justify-between w-full">
           <div class="flex items-center">
               <a href="${preSearchHash}" class="flex items-center text-gray-500 hover:text-black transition-colors duration-200 group breadcrumb-link">
                   <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mr-1 group-hover:-translate-x-1 transition-transform"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                   返回
               </a>
               ${hasResults ? `<span class="mx-3 text-gray-300">/</span><span class="text-black font-bold">搜索结果: "${searchQuery}" (${totalResults}项)</span>` : ''}
           </div>
           <div id="sort-container" class="flex-shrink-0 ml-4"></div>
       </div>`;
}

/**
 * 获取当前hash对应的路由路径（去除modal后缀与参数）。
 * @returns {string} 路径
 */
export function getPathOnlyFromHash() {
    const cleanHashString = window.location.hash.replace(/#modal$/, '');
    const newDecodedPath = decodeURIComponent(cleanHashString.substring(1).replace(/^\//, ''));
    const questionMarkIndex = newDecodedPath.indexOf('?');
    return questionMarkIndex !== -1 ? newDecodedPath.substring(0, questionMarkIndex) : newDecodedPath;
}

/**
 * 上传并记录某路径被浏览的行为，支持离线同步。
 * @param {string} path - 相册路径
 * @param {Object} metadata - 元数据（可选）
 * @param {string} metadata.name - 相册名称
 * @param {string} metadata.coverUrl - 封面URL
 */
export async function onAlbumViewed(path, metadata = {}) {
    if (!path) return;

    await recordHierarchyView(path, {
        timestamp: Date.now(),
        name: metadata.name || '',
        entryType: 'album',
        coverUrl: metadata.coverUrl || '',
        thumbnailUrl: metadata.thumbnailUrl || metadata.coverUrl || '',
        width: metadata.width || 0,
        height: metadata.height || 0,
        needsHydration: !metadata.coverUrl
    });
}

/**
 * 将历史记录转换为可渲染的项目对象
 * @param {Object} record - 历史记录
 * @returns {Object|null} 项目对象或null
 */
export function convertHistoryRecordToItem(record) {
    if (!record || !record.path) return null;
    const visitedAt = Number(record.viewedAt || record.timestamp || Date.now());

    if (record.entryType === 'album') {
        const coverUrl = record.coverUrl || record.thumbnailUrl || '';
        return {
            type: 'album',
            data: {
                name: record.name || record.path.split('/').pop() || '未命名相册',
                path: record.path,
                coverUrl,
                coverWidth: record.width || 1,
                coverHeight: record.height || 1,
                mtime: visitedAt
            }
        };
    }

    const originalUrl = buildStaticUrlFromPath(record.path);
    const thumbnailUrl = record.thumbnailUrl || record.coverUrl || '';

    return {
        type: record.entryType === 'video' ? 'video' : 'photo',
        data: {
            originalUrl,
            thumbnailUrl: thumbnailUrl || originalUrl,
            width: record.width || 1,
            height: record.height || 1,
            mtime: visitedAt
        }
    };
}

/**
 * 从路径构建静态资源URL
 * @param {string} path - 文件路径
 * @returns {string} 静态资源URL
 */
export function buildStaticUrlFromPath(path) {
    const normalized = (path || '').split('/').filter(Boolean).map(segment => encodeURIComponent(segment));
    return `/static/${normalized.join('/')}`;
}
