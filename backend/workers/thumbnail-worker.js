const { parentPort, workerData } = require('worker_threads');
const sharp = require('sharp');
const logger = require('../config/logger');
const { TraceManager } = require('../utils/trace');
const {
    createWorkerResult,
    createWorkerError,
    createWorkerLog,
} = require('../utils/workerMessage');

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

// 像素限制配置（防止OOM），默认值：5000万像素
const LIMIT_PIXELS = Number(process.env.SHARP_MAX_PIXELS || 50_000_000);

// 使用统一的错误消息转换器
function translateErrorMessage(error) {
    return errorMessageTranslator.translate(error, 'sharp');
}

// 增加对损坏或非标准图片文件的容错处理
async function generateImageThumbnail(imagePath, thumbPath) {
    const mainProcessing = async () => {
        // 首先读取元数据，检查图片尺寸
        const metadata = await sharp(imagePath, { 
            limitInputPixels: LIMIT_PIXELS,
            failOnError: false  // 容错模式，避免元数据读取失败导致任务终止
        }).metadata();
        
        const pixelCount = (metadata.width || 1) * (metadata.height || 1);
        
        // 如果图片超过限制，拒绝处理（避免Worker OOM）
        if (pixelCount > LIMIT_PIXELS) {
            const { ValidationError } = require('../utils/errors');
            throw new ValidationError(`图片尺寸过大: ${metadata.width}x${metadata.height} (${pixelCount.toLocaleString()} 像素)，超过安全上限 ${LIMIT_PIXELS.toLocaleString()} 像素`, {
                width: metadata.width,
                height: metadata.height,
                pixelCount,
                limit: LIMIT_PIXELS
            });
        }
        
        let dynamicQuality;

        if (pixelCount > 8000000) {
            dynamicQuality = 65;
        } else if (pixelCount > 2000000) {
            dynamicQuality = 70;
        } else {
            dynamicQuality = 80;
        }

        await sharp(imagePath, { limitInputPixels: LIMIT_PIXELS })
            .resize({ width: 500 })
            .webp({ quality: dynamicQuality })
            .toFile(thumbPath);
    };

    try {
        await mainProcessing();
        return { success: true };
    } catch (error) {
        const zhReason = translateErrorMessage(error && error.message);
        parentPort.postMessage(createWorkerLog('warn', `[WORKER] 图片: ${path.basename(imagePath)} 首次处理失败，原因: ${zhReason}。尝试进入安全模式...`, { workerId: workerData.workerId }));
        
        try {
            // 使用 failOn: 'none' 模式，让 sharp 尽可能忽略错误，完成转换
            await sharp(imagePath, { failOn: 'none', limitInputPixels: LIMIT_PIXELS })
                .resize({ width: 500 })
                .webp({ quality: 60 }) // 在安全模式下使用稍低的质量
                .toFile(thumbPath);
            
            parentPort.postMessage(createWorkerLog('info', `[WORKER] 图片: ${path.basename(imagePath)} 在安全模式下处理成功。`, { workerId: workerData.workerId }));
            return { success: true };
        } catch (safeError) {
            // 如果连安全模式都失败了，那这个文件确实有问题
            const zhSafeReason = translateErrorMessage(safeError && safeError.message);
            parentPort.postMessage(createWorkerLog('error', `[WORKER] 图片: ${path.basename(imagePath)} 在安全模式下处理失败: ${zhSafeReason}`, { workerId: workerData.workerId }));
            return { success: false, error: 'PROCESSING_FAILED_IN_SAFE_MODE', message: zhSafeReason };
        }
    }
}


// 基于 ffmpeg 的 thumbnail 过滤器快速截帧，避免多帧计算造成阻塞
async function generateVideoThumbnail(videoPath, thumbPath) {
    return new Promise((resolve) => {
        const args = [
            '-v', 'error',
            '-y',
            '-i', videoPath,
            // thumbnail=N 选取代表帧，这里给出较大的采样窗口，提高代表性
            '-vf', 'thumbnail=300,scale=320:-2',
            '-frames:v', '1',
            thumbPath
        ];
        execFile('ffmpeg', args, (err) => {
            if (err) return resolve({ success: false, error: err.message });
            resolve({ success: true });
        });
    });
}


parentPort.on('message', async (message) => {
    // 提取追踪上下文
    const traceContext = TraceManager.fromWorkerMessage(message);
    
    // 获取实际的task数据
    // 修复消息处理逻辑，确保能正确提取任务类型
    const task = message && message.type ? 
        message : 
        (message && message.payload && message.payload.type) ? 
        message.payload : 
        (message && message.task && message.task.type) ? 
        message.task : 
        message;
    
    // 定义处理函数
    const processTask = async () => {
        try {
            const { filePath, relativePath, type, thumbsDir } = task;
            const isVideo = type === 'video';
            const extension = isVideo ? '.jpg' : '.webp';
            const thumbRelPath = relativePath.replace(/\.[^.]+$/, extension);
            const thumbPath = path.join(thumbsDir, thumbRelPath);

        // 如果缩略图已存在，直接跳过（状态写回由主线程统一负责，避免重复写库）
        try {
            await fs.access(thumbPath);
            parentPort.postMessage(createWorkerResult({ success: true, skipped: true, task, workerId: workerData.workerId }));
            return;
        } catch (accessErr) {
            if (accessErr && accessErr.code !== 'ENOENT') {
                parentPort.postMessage(createWorkerLog('debug', `[WORKER] 检查缩略图是否存在失败: ${accessErr.message}`, { workerId: workerData.workerId }));
            }
        }

        // 创建目录
        await fs.mkdir(path.dirname(thumbPath), { recursive: true });
        
        let result;
        if (isVideo) {
            result = await generateVideoThumbnail(filePath, thumbPath);
        } else {
            result = await generateImageThumbnail(filePath, thumbPath);
        }

            parentPort.postMessage(createWorkerResult({ ...result, task, workerId: workerData.workerId }));
        } catch (error) {
            // 捕获到任何未处理的异常
            parentPort.postMessage(createWorkerLog('error', `[THUMBNAIL-WORKER] Fatal error processing ${task.relativePath}: ${error.message}`, { workerId: workerData.workerId }));
            // 向主线程报告失败，以便更新数据库状态并继续处理下一个任务
            parentPort.postMessage(createWorkerError({
                success: false,
                error: { message: `Processing failed: ${error.message}` },
                task,
                workerId: workerData.workerId
            }));
        }
    };
    
    // 在追踪上下文中运行（如果有的话）
    if (traceContext) {
        await TraceManager.run(traceContext, processTask);
    } else {
        await processTask();
    }
});
