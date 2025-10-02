// 前端 API 聚合入口
// 统一导出各子模块中的 API 方法，便于按需引入
export { clearAuthHeadersCache, handleAPIError } from './api/shared.js';
// 设置相关接口
export {
    fetchSettings,
    saveSettings,
    fetchSettingsUpdateStatus,
    waitForSettingsUpdate
} from './api/settings.js';
// 浏览与搜索相关接口
export {
    fetchSearchResults,
    fetchBrowseResults,
    postViewed,
    fetchRandomThumbnail
} from './api/media.js';
// AI 相关接口
export {
    generateImageCaption,
    getAICacheStats,
    clearAICache,
    fetchAvailableModels
} from './api/ai.js';
