const sharp = require('sharp');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const { TraceManager } = require('../utils/trace');

// 限制 sharp/libvips 缓存以控制内存占用
try {
    const memMb = Number(process.env.SHARP_CACHE_MEMORY_MB || 32);
    const items = Number(process.env.SHARP_CACHE_ITEMS || 100);
    const files = Number(process.env.SHARP_CACHE_FILES || 0);
    sharp.cache({ memory: memMb, items, files });
    const conc = Number(process.env.SHARP_CONCURRENCY || 1);
    if (conc > 0) sharp.concurrency(conc);
} catch (error) {
    logger.warn('Sharp配置失败，使用默认设置', { error: error.message });
}
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { errorMessageTranslator } = require('../utils/errorMessageTranslator');

// 像素限制配置（防止OOM），默认值：2.68亿像素（约16384x16384）
const LIMIT_PIXELS = Number(process.env.SHARP_MAX_PIXELS || 268_000_000);
const THUMB_TARGET_WIDTH = Number(process.env.THUMB_TARGET_WIDTH || 500);
const PIXEL_THRESHOLD_HIGH = Number(process.env.THUMB_PIXEL_THRESHOLD_HIGH || 8_000_000);
const PIXEL_THRESHOLD_MEDIUM = Number(process.env.THUMB_PIXEL_THRESHOLD_MEDIUM || 2_000_000);
const QUALITY_LOW = Number(process.env.THUMB_QUALITY_LOW || 65);
const QUALITY_MEDIUM = Number(process.env.THUMB_QUALITY_MEDIUM || 70);
const QUALITY_HIGH = Number(process.env.THUMB_QUALITY_HIGH || 80);
const SAFE_MODE_QUALITY = Number(process.env.THUMB_SAFE_MODE_QUALITY || 60);
const VIDEO_THUMB_TIMEOUT_MS = Math.max(1000, Number(process.env.VIDEO_THUMB_TIMEOUT_MS || 60000));
const VIDEO_THUMB_MAX_BUFFER = 2 * 1024 * 1024;

// 使用统一的错误消息转换器
function translateErrorMessage(error) {
    return errorMessageTranslator.translate(error, 'sharp');
}

function determineWebpQuality(pixelCount) {
    if (pixelCount > PIXEL_THRESHOLD_HIGH) {
        return QUALITY_LOW;
    }
    if (pixelCount > PIXEL_THRESHOLD_MEDIUM) {
        return QUALITY_MEDIUM;
    }
    return QUALITY_HIGH;
}

async function validateImageDimensions(imagePath) {
    const metadata = await sharp(imagePath, {
        limitInputPixels: LIMIT_PIXELS,
        failOnError: false
    }).metadata();

    const pixelCount = (metadata.width || 1) * (metadata.height || 1);
    if (pixelCount > LIMIT_PIXELS) {
        const { ValidationError } = require('../utils/errors');
        throw new ValidationError(`图片尺寸过大: ${metadata.width}x${metadata.height} (${pixelCount.toLocaleString()} 像素)，超过安全上限 ${LIMIT_PIXELS.toLocaleString()} 像素`, {
            width: metadata.width,
            height: metadata.height,
            pixelCount,
            limit: LIMIT_PIXELS
        });
    }
    return { metadata, pixelCount };
}

async function processImageWithSafeMode(imagePath, thumbPath, originalError) {
    const zhReason = translateErrorMessage(originalError && originalError.message);
    // 降级为 debug，减少日志刷屏
    logger.debug(`${LOG_PREFIXES.THUMBNAIL_WORKER} 图片 ${path.basename(imagePath)} 首次处理失败: ${zhReason}，尝试安全模式...`);
    try {
        await sharp(imagePath, { failOn: 'none', limitInputPixels: LIMIT_PIXELS })
            .resize({ width: THUMB_TARGET_WIDTH })
            .webp({ quality: SAFE_MODE_QUALITY })
            .toFile(thumbPath);
        logger.info(`${LOG_PREFIXES.THUMBNAIL_WORKER} 图片 ${path.basename(imagePath)} 在安全模式下处理成功`);
        return { success: true };
    } catch (safeError) {
        const zhSafeReason = translateErrorMessage(safeError && safeError.message);
        // 安全模式失败降级为 warn，最终失败由 thumbnail.service.js 记录
        logger.debug(`${LOG_PREFIXES.THUMBNAIL_WORKER} 图片 ${path.basename(imagePath)} 在安全模式下处理失败: ${zhSafeReason}`);
        return { success: false, error: 'PROCESSING_FAILED_IN_SAFE_MODE', message: zhSafeReason };
    }
}

// 增加对损坏或非标准图片文件的容错处理
async function generateImageThumbnail(imagePath, thumbPath) {
    try {
        const { pixelCount } = await validateImageDimensions(imagePath);
        const dynamicQuality = determineWebpQuality(pixelCount);
        await sharp(imagePath, { limitInputPixels: LIMIT_PIXELS })
            .resize({ width: THUMB_TARGET_WIDTH })
            .webp({ quality: dynamicQuality })
            .toFile(thumbPath);
        return { success: true };
    } catch (error) {
        return processImageWithSafeMode(imagePath, thumbPath, error);
    }
}


// 基于 ffmpeg 的快速截帧，在视频 10% 位置截取一帧
// 使用 -ss 在 -i 之前实现快速 seek，避免 thumbnail 过滤器的全量扫描
async function generateVideoThumbnail(videoPath, thumbPath) {
    return new Promise((resolve) => {
        // 先用 ffprobe 获取视频时长，然后在 10% 处截帧
        const probeArgs = [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'format=duration',
            '-of', 'json',
            videoPath
        ];

        execFile('ffprobe', probeArgs, { timeout: 10000, maxBuffer: VIDEO_THUMB_MAX_BUFFER, windowsHide: true }, (probeErr, stdout) => {
            let seekTime = 3; // 默认 3 秒位置

            if (!probeErr && stdout) {
                try {
                    const data = JSON.parse(stdout);
                    const duration = parseFloat(data.format?.duration || 0);
                    if (duration > 10) {
                        seekTime = Math.min(duration * 0.1, 60); // 10% 位置，最多 60 秒
                    } else if (duration > 3) {
                        seekTime = 1; // 短视频取 1 秒处
                    }
                } catch (e) {
                    // 解析失败，使用默认值
                }
            }

            // 使用 -ss 在 -i 之前进行快速 seek（keyframe seek）
            const args = [
                '-v', 'error',
                '-y',
                '-ss', String(seekTime),
                '-i', videoPath,
                '-vf', 'scale=320:-2',
                '-frames:v', '1',
                '-q:v', '5',
                thumbPath
            ];

            execFile('ffmpeg', args, { timeout: VIDEO_THUMB_TIMEOUT_MS, maxBuffer: VIDEO_THUMB_MAX_BUFFER, windowsHide: true }, (err, stdout, stderr) => {
                if (err) {
                    const errorDetail = stderr || err.message || 'Unknown ffmpeg error';
                    return resolve({ success: false, error: errorDetail });
                }
                resolve({ success: true });
            });
        });
    });
}


module.exports = async function runThumbnailTask(payload = {}) {
    const { task, trace } = payload;

    const execute = async () => {
        if (!task || !task.relativePath) {
            return { success: false, error: { message: 'Invalid thumbnail task payload' }, task };
        }

        try {
            const { filePath, relativePath, type, thumbsDir } = task;
            const isVideo = type === 'video';
            const extension = isVideo ? '.jpg' : '.webp';
            const thumbRelPath = relativePath.replace(/\.[^.]+$/, extension);
            const thumbPath = path.join(thumbsDir, thumbRelPath);

            try {
                await fs.access(thumbPath);
                return { success: true, skipped: true, task };
            } catch (accessErr) {
                if (accessErr && accessErr.code !== 'ENOENT') {
                    logger.debug(`${LOG_PREFIXES.THUMBNAIL_WORKER} 检查缩略图是否存在失败: ${accessErr.message}`);
                }
            }

            await fs.mkdir(path.dirname(thumbPath), { recursive: true });

            const result = isVideo
                ? await generateVideoThumbnail(filePath, thumbPath)
                : await generateImageThumbnail(filePath, thumbPath);

            if (result && result.success === false) {
                const message = result.message || result.error || 'Thumbnail processing failed';
                return { success: false, error: { message }, task };
            }

            return { success: true, skipped: false, task };
        } catch (error) {
            const message = error && error.message ? error.message : 'Thumbnail worker error';
            logger.error(`${LOG_PREFIXES.THUMBNAIL_WORKER} 处理 ${task.relativePath} 失败: ${message}`);
            return { success: false, error: { message }, task };
        }
    };

    if (trace && typeof trace === 'object') {
        return TraceManager.run(trace, execute);
    }
    return execute();
};
