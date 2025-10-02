/**
 * 媒体处理工具函数模块
 */
const { execFile } = require('child_process');
const logger = require('../config/logger');

/**
 * 媒体类型常量定义
 */
const MEDIA_TYPES = {
    PHOTO: 'photo',
    VIDEO: 'video',
    ALBUM: 'album'
};

/**
 * 常用媒体类型组合
 */
const MEDIA_TYPE_GROUPS = {
    MEDIA_FILES: [MEDIA_TYPES.PHOTO, MEDIA_TYPES.VIDEO],
    ALL_ITEMS: [MEDIA_TYPES.ALBUM, MEDIA_TYPES.PHOTO, MEDIA_TYPES.VIDEO]
};

/**
 * 生成媒体类型的SQL IN条件
 * @param {string[]} types - 媒体类型数组
 * @returns {string} SQL IN条件字符串
 */
function getMediaTypesCondition(types) {
    if (!Array.isArray(types) || types.length === 0) {
        return "('photo', 'video')"; // 默认值
    }
    const escapedTypes = types.map(type => `'${type}'`);
    return `(${escapedTypes.join(', ')})`;
}

/**
 * 获取媒体文件的SQL条件
 * @returns {string} 媒体文件类型的SQL条件
 */
function getMediaFilesCondition() {
    return getMediaTypesCondition(MEDIA_TYPE_GROUPS.MEDIA_FILES);
}

/**
 * 获取所有项目类型的SQL条件
 * @returns {string} 所有项目类型的SQL条件
 */
function getAllItemsCondition() {
    return getMediaTypesCondition(MEDIA_TYPE_GROUPS.ALL_ITEMS);
}

/**
 * 获取视频文件的尺寸信息
 * 使用ffprobe工具解析视频文件的宽度和高度
 * @param {string} videoPath - 视频文件路径
 * @returns {Promise<Object>} 包含width和height的对象
 */
function getVideoDimensions(videoPath) {
    return new Promise((resolve) => {
        const args = [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'json',
            videoPath
        ];
        execFile('ffprobe', args, (error, stdout) => {
            if (error) {
                logger.error(`ffprobe 失败: ${videoPath}`, error);
                // 返回一个默认值，而不是让整个流程失败
                return resolve({ width: 1920, height: 1080 });
            }
            try {
                const parsed = JSON.parse(stdout || '{}');
                const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null;
                const width = Number(stream?.width) || 1920;
                const height = Number(stream?.height) || 1080;
                resolve({ width, height });
            } catch (e) {
                logger.warn(`解析 ffprobe 输出失败: ${videoPath}`, e);
                resolve({ width: 1920, height: 1080 });
            }
        });
    });
}

module.exports = {
    getVideoDimensions,
    // 媒体类型相关
    MEDIA_TYPES,
    MEDIA_TYPE_GROUPS,
    getMediaTypesCondition,
    getMediaFilesCondition,
    getAllItemsCondition,
};
