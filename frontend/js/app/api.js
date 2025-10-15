/**
 * @file api.js
 * @description
 * 前端 API 聚合入口，统一导出各子模块中的 API 方法，便于按需引入。
 */

/**
 * @module shared
 * @description 共享工具方法
 */
export { clearAuthHeadersCache, handleAPIError } from '../api/shared.js';

/**
 * @module settings
 * @description 设置相关接口
 */
export {
    fetchSettings,
    saveSettings,
    fetchSettingsUpdateStatus,
    waitForSettingsUpdate,
    manualAlbumSync,
    toggleAlbumDeletion,
    updateManualSyncSchedule,
    verifyAdminSecret
} from '../api/settings.js';

/**
 * @module media
 * @description 浏览与搜索相关接口
 */
export {
    fetchSearchResults,
    fetchBrowseResults,
    postViewed,
    fetchRandomThumbnail,
    deleteAlbum
} from '../api/media.js';

/**
 * @module ai
 * @description AI 相关接口
 */
export {
    generateImageCaption,
    getAICacheStats,
    clearAICache,
    fetchAvailableModels
} from '../api/ai.js';

/**
 * @module download
 * @description 下载微服务相关接口
 */
export {
    fetchDownloadStatus,
    fetchDownloadTasks,
    fetchDownloadHistory,
    createDownloadTask,
    updateDownloadTask,
    triggerDownloadTaskAction,
    deleteDownloadTask,
    fetchDownloadTaskLogs,
    fetchDownloadLogs,
    clearDownloadLogs,
    fetchDownloadConfig,
    updateDownloadConfig,
    previewDownloadFeed,
    downloadSelectedEntries,
    exportDownloadOpml,
    importDownloadOpml
} from '../api/download.js';
