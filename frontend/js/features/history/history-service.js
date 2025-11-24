import { createModuleLogger } from '../../core/logger.js';
import { fetchBrowseResults } from '../../app/api.js';
import {
    saveViewed,
    getRecentEntriesByParent,
    hasHistoryForParent,
    normalizeHistoryPath,
    getParentHistoryPath,
    deriveNameFromPath
} from '../../shared/indexeddb-helper.js';

const historyLogger = createModuleLogger('RecentHistory');
const CACHE_TTL_MS = 30 * 1000;
const MAX_HISTORY_LIMIT = 1000;
const MAX_HYDRATION_PAGES = 5;

const historyCache = new Map();

function getCacheKey(path = '') {
    return path || '__root__';
}

function invalidateCacheForParent(path = '') {
    historyCache.delete(getCacheKey(path));
}

function invalidateCacheChain(path = '') {
    let currentParent = getParentHistoryPath(path);
    const visited = new Set();
    while (currentParent !== undefined) {
        const key = getCacheKey(currentParent);
        if (visited.has(key)) break;
        historyCache.delete(key);
        visited.add(key);
        if (!currentParent) break;
        currentParent = getParentHistoryPath(currentParent);
    }
}

function normalizeSegments(path) {
    const normalized = normalizeHistoryPath(path);
    return normalized ? normalized.split('/') : [];
}

function shouldHydrateRecord(record) {
    if (!record) return false;
    if (record.entryType === 'album') {
        return !record.coverUrl;
    }
    return !record.thumbnailUrl || !record.width || !record.height;
}

function extractItemPath(item) {
    if (!item) return '';
    if (item.type === 'album') {
        return normalizeHistoryPath(item?.data?.path || '');
    }
    const originalUrl = item?.data?.originalUrl || '';
    if (!originalUrl.startsWith('/static/')) return '';
    const relative = originalUrl.substring(8).split('/').map(segment => {
        try {
            return decodeURIComponent(segment);
        } catch {
            return segment;
        }
    }).join('/');
    return normalizeHistoryPath(relative);
}

function applyItemMetadata(record, item) {
    if (!record || !item) return;
    if (item.type === 'album') {
        record.entryType = 'album';
        record.coverUrl = item.data?.coverUrl || record.coverUrl || '';
        record.thumbnailUrl = record.coverUrl;
        record.width = item.data?.coverWidth || item.data?.width || record.width || 0;
        record.height = item.data?.coverHeight || item.data?.height || record.height || 0;
        record.name = item.data?.name || record.name || deriveNameFromPath(record.path);
    } else {
        record.entryType = item.type;
        record.thumbnailUrl = item.data?.thumbnailUrl || record.thumbnailUrl || '';
        record.coverUrl = record.thumbnailUrl || record.coverUrl || '';
        record.width = item.data?.width || record.width || 0;
        record.height = item.data?.height || record.height || 0;
        record.name = item.data?.name || record.name || deriveNameFromPath(record.path);
    }
    record.needsHydration = false;
}

async function hydrateHistoryRecords(parentPath, records, signal) {
    const pending = new Map();
    const hydratedEntries = new Set();
    records.forEach(rec => {
        if (shouldHydrateRecord(rec) || rec.needsHydration) {
            pending.set(rec.path, rec);
        }
    });
    if (!pending.size) return records;

    try {
        for (let page = 1; page <= MAX_HYDRATION_PAGES && pending.size; page++) {
            if (signal?.aborted) break;
            const data = await fetchBrowseResults(parentPath, page, signal, { sortOverride: 'mtime_desc' });
            if (!data || !Array.isArray(data.items)) break;
            for (const item of data.items) {
                const itemPath = extractItemPath(item);
                if (!itemPath) continue;
                const target = pending.get(itemPath);
                if (!target) continue;
                applyItemMetadata(target, item);
                hydratedEntries.add(target);
                pending.delete(itemPath);
            }
            if (!data.totalPages || page >= data.totalPages) break;
        }
        if (pending.size) {
            pending.forEach(entry => {
                entry.needsHydration = true;
            });
        }
    } catch (error) {
        historyLogger.warn('补全浏览历史元数据失败', error);
    }
    if (hydratedEntries.size) {
        const persistTasks = [];
        hydratedEntries.forEach(entry => {
            persistTasks.push(saveViewed(entry.path, {
                ...entry,
                timestamp: entry.viewedAt,
                parentPath: entry.parentPath,
                preserveViewCount: true,
                needsHydration: false
            }));
        });
        try {
            await Promise.all(persistTasks);
        } catch (error) {
            historyLogger.debug('刷新本地历史缓存失败', error);
        }
    }
    return records;
}

export async function recordHierarchyView(path, metadata = {}) {
    const normalizedPath = normalizeHistoryPath(path);
    if (!normalizedPath) return;

    const segments = normalizeSegments(normalizedPath);
    if (!segments.length) return;

    const visitedAt = Number(metadata.timestamp || Date.now());
    const tasks = [];
    const parentsToInvalidate = new Set();

    for (let i = 0; i < segments.length; i++) {
        const partialPath = segments.slice(0, i + 1).join('/');
        const parentPath = i === 0 ? '' : segments.slice(0, i).join('/');
        const isLeaf = i === segments.length - 1;
        const payload = isLeaf
            ? metadata
            : {
                name: segments[i],
                entryType: 'album',
                needsHydration: metadata.needsHydration ?? true
            };

        tasks.push(saveViewed(partialPath, {
            ...payload,
            timestamp: visitedAt,
            parentPath
        }));
        parentsToInvalidate.add(parentPath);
    }

    try {
        await Promise.all(tasks);
    } catch (error) {
        historyLogger.warn('记录浏览历史失败', error);
    }

    parentsToInvalidate.forEach(parent => invalidateCacheForParent(parent));
    invalidateCacheChain(normalizedPath);
}

export async function loadRecentHistoryRecords(parentPath = '', { limit = MAX_HISTORY_LIMIT, signal } = {}) {
    const normalizedParent = normalizeHistoryPath(parentPath);
    const key = getCacheKey(normalizedParent);
    const cached = historyCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.records.slice(0, limit);
    }

    const records = await getRecentEntriesByParent(normalizedParent, Math.min(limit, MAX_HISTORY_LIMIT));
    if (signal?.aborted) return [];
    await hydrateHistoryRecords(normalizedParent, records, signal);
    historyCache.set(key, {
        records,
        expiresAt: Date.now() + CACHE_TTL_MS
    });
    return records;
}

export async function hasRecentHistoryForParent(parentPath = '') {
    return hasHistoryForParent(parentPath);
}

export function invalidateHistoryCache(parentPath = '') {
    invalidateCacheForParent(normalizeHistoryPath(parentPath));
}
