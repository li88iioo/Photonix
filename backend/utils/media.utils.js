/**
 * 媒体处理工具函数模块
 */
const { execFile } = require('child_process');
const logger = require('../config/logger');

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
};
