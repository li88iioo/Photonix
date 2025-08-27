/**
 * HLS状态检查工具
 * 基于文件系统检查HLS文件是否存在，避免数据库查询
 */
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { THUMBS_DIR } = require('../config');

// 内存缓存，避免重复文件系统检查
const hlsCache = new Map();
const { HLS_CACHE_TTL_MS, HLS_CHECK_BATCH_SIZE } = require('../config');
const CACHE_TTL = HLS_CACHE_TTL_MS; // 从配置读取缓存TTL

// 硬盘保护：限制文件系统检查频率
const lastCheckTimes = new Map();
const { HLS_MIN_CHECK_INTERVAL_MS, HLS_BATCH_DELAY_MS } = require('../config');
const MIN_CHECK_INTERVAL = HLS_MIN_CHECK_INTERVAL_MS; // 从配置读取最小检查间隔

/**
 * 清理过期的缓存项
 */
function cleanupCache() {
    const now = Date.now();
    for (const [key, value] of hlsCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            hlsCache.delete(key);
        }
    }
}

/**
 * 检查视频的HLS文件是否存在
 * @param {string} videoPath - 视频文件的相对路径
 * @returns {boolean} - 如果HLS文件存在返回true
 */
async function checkHlsExists(videoPath) {
    // 检查缓存
    const cached = hlsCache.get(videoPath);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.exists;
    }
    
    // 硬盘保护：限制检查频率
    const lastCheck = lastCheckTimes.get(videoPath);
    const now = Date.now();
    if (lastCheck && (now - lastCheck) < MIN_CHECK_INTERVAL) {
        // 如果距离上次检查时间太短，返回缓存结果或false
        return cached ? cached.exists : false;
    }
    lastCheckTimes.set(videoPath, now);
    
    try {
        // 构建HLS目录路径
        const hlsDir = path.join(THUMBS_DIR, 'hls', videoPath);
        
        // 检查主播放列表是否存在
        const masterPlaylist = path.join(hlsDir, 'master.m3u8');
        const masterExists = await fs.access(masterPlaylist).then(() => true).catch(() => false);
        
        if (!masterExists) {
            // 缓存结果
            hlsCache.set(videoPath, { exists: false, timestamp: Date.now() });
            return false;
        }
        
        // 检查至少一个分辨率目录存在
        const resolutions = ['480p', '720p'];
        for (const res of resolutions) {
            const resDir = path.join(hlsDir, res);
            const streamPlaylist = path.join(resDir, 'stream.m3u8');
            const streamExists = await fs.access(streamPlaylist).then(() => true).catch(() => false);
            
            if (streamExists) {
                // 检查是否有至少一个分片文件
                try {
                    const files = await fs.readdir(resDir);
                    const hasSegments = files.some(file => file.endsWith('.ts'));
                    if (hasSegments) {
                        // 缓存结果
                        hlsCache.set(videoPath, { exists: true, timestamp: Date.now() });
                        return true; // 找到有效的HLS流
                    }
                } catch (e) {
                    logger.debug(`无法读取HLS目录: ${resDir}`, e.message);
                }
            }
        }
        
        // 缓存结果
        hlsCache.set(videoPath, { exists: false, timestamp: Date.now() });
        return false;
    } catch (error) {
        logger.debug(`检查HLS状态失败: ${videoPath}`, error.message);
        // 缓存失败结果，但使用较短的TTL
        hlsCache.set(videoPath, { exists: false, timestamp: Date.now() - CACHE_TTL + 30000 });
        return false;
    }
}

/**
 * 批量检查多个视频的HLS状态
 * @param {Array<string>} videoPaths - 视频文件路径数组
 * @returns {Promise<Set<string>>} - 已处理视频路径的Set
 */
async function batchCheckHlsStatus(videoPaths) {
    const hlsReadySet = new Set();
    
    // 清理过期缓存
    cleanupCache();
    
    // 并行检查，但限制并发数避免系统压力
    const batchSize = HLS_CHECK_BATCH_SIZE;
    for (let i = 0; i < videoPaths.length; i += batchSize) {
        const batch = videoPaths.slice(i, i + batchSize);
        
        // 硬盘保护：串行处理批次，避免并发I/O压力
        for (const videoPath of batch) {
            const exists = await checkHlsExists(videoPath);
            if (exists) {
                hlsReadySet.add(videoPath);
            }
        }
        
        // 批次间延迟，给硬盘休息时间
        if (i + batchSize < videoPaths.length) {
            await new Promise(resolve => setTimeout(resolve, HLS_BATCH_DELAY_MS));
        }
    }
    
    return hlsReadySet;
}

/**
 * 创建HLS处理记录文件
 * @param {string} videoPath - 视频路径
 * @param {Object} metadata - 处理元数据
 */
async function createHlsRecord(videoPath, metadata = {}) {
    try {
        const recordDir = path.join(THUMBS_DIR, 'hls', '_records');
        await fs.mkdir(recordDir, { recursive: true });
        
        const recordFile = path.join(recordDir, `${videoPath.replace(/[\/\\]/g, '_')}.json`);
        const record = {
            videoPath,
            processedAt: new Date().toISOString(),
            ...metadata
        };
        
        await fs.writeFile(recordFile, JSON.stringify(record, null, 2));
        
        // 更新缓存
        hlsCache.set(videoPath, { exists: true, timestamp: Date.now() });
        
        logger.debug(`HLS处理记录已创建: ${recordFile}`);
    } catch (error) {
        logger.warn(`创建HLS处理记录失败: ${videoPath}`, error.message);
    }
}

/**
 * 检查HLS处理记录是否存在
 * @param {string} videoPath - 视频路径
 * @returns {boolean} - 如果记录存在返回true
 */
async function checkHlsRecord(videoPath) {
    try {
        const recordDir = path.join(THUMBS_DIR, 'hls', '_records');
        const recordFile = path.join(recordDir, `${videoPath.replace(/[\/\\]/g, '_')}.json`);
        
        return await fs.access(recordFile).then(() => true).catch(() => false);
    } catch (error) {
        return false;
    }
}

/**
 * 清理过期的HLS处理记录
 * @param {number} maxAge - 最大保留天数，默认30天
 */
async function cleanupHlsRecords(maxAge = 30) {
    try {
        const recordDir = path.join(THUMBS_DIR, 'hls', '_records');
        const files = await fs.readdir(recordDir).catch(() => []);
        
        const cutoffTime = Date.now() - (maxAge * 24 * 60 * 60 * 1000);
        let cleanedCount = 0;
        
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            
            const filePath = path.join(recordDir, file);
            try {
                const stats = await fs.stat(filePath);
                if (stats.mtimeMs < cutoffTime) {
                    await fs.unlink(filePath);
                    cleanedCount++;
                }
            } catch (e) {
                logger.debug(`清理HLS记录失败: ${file}`, e.message);
            }
        }
        
        if (cleanedCount > 0) {
            logger.info(`清理了 ${cleanedCount} 个过期的HLS处理记录`);
        }
    } catch (error) {
        logger.warn('清理HLS记录失败', error.message);
    }
}

/**
 * 清除指定视频的缓存
 * @param {string} videoPath - 视频路径
 */
function clearHlsCache(videoPath) {
    if (videoPath) {
        hlsCache.delete(videoPath);
    } else {
        hlsCache.clear();
    }
}

module.exports = {
    checkHlsExists,
    batchCheckHlsStatus,
    createHlsRecord,
    checkHlsRecord,
    cleanupHlsRecords,
    clearHlsCache
};
