/**
 * repositories/index.js
 * Repository层统一导出
 * 使用方法：
 * const { ItemsRepository, ThumbStatusRepository, AlbumCoversRepository } = require('../repositories');
 */

const ItemsRepository = require('./items.repo');
const ThumbStatusRepository = require('./thumbStatus.repo');
const AlbumCoversRepository = require('./albumCovers.repo');
const { getCount, getStatsByField, getGroupStats, getMediaStats, getThumbProcessingStats } = require('./stats.repo');

// 创建单例实例用于快捷方法
const itemsRepoInstance = new ItemsRepository();

module.exports = {
    // Repository类
    ItemsRepository,
    ThumbStatusRepository,
    AlbumCoversRepository,
    
    // 统计相关函数（向后兼容）
    getCount,
    getStatsByField,
    getGroupStats,
    getMediaStats,
    getThumbProcessingStats,
    
    // 快捷方法（向后兼容）- 使用单例实例
    getIdByPath: (path) => itemsRepoInstance.getIdByPath(path)
};
