const { parentPort } = require('worker_threads');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { constants: FS_CONST } = require('fs');
const util = require('util');
const Redis = require('ioredis');
const winston = require('winston');

// --- 日志和配置 ---
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] [VIDEO-PROCESSOR] ${info.level}: ${info.message}`)),
    transports: [new winston.transports.Console()]
});

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const execPromise = util.promisify(exec);

// --- 新增：用于处理失败重试的变量 ---
const failureCounts = new Map();
const MAX_VIDEO_RETRIES = 3; // 每个视频最多重试3次
const PERMANENT_FAILURE_TTL = 3600 * 24 * 7; // 失败标记在Redis中存留7天

async function isOptimized(filePath) {
    let fileHandle;
    try {
        fileHandle = await fs.open(filePath, 'r');
        const bufferSize = 64 * 1024;
        const buffer = Buffer.alloc(bufferSize);
        const { bytesRead } = await fileHandle.read(buffer, 0, bufferSize, 0);

        if (bytesRead < 4) {
            return true;
        }

        const moovPosition = buffer.indexOf('moov', 0, 'ascii');
        const mdatPosition = buffer.indexOf('mdat', 0, 'ascii');

        if (moovPosition !== -1 && (mdatPosition === -1 || moovPosition < mdatPosition)) {
            return true;
        }

        return false;
    } catch (e) {
        logger.error(`检查视频优化状态失败 ${filePath}:`, e);
        return false;
    } finally {
        if (fileHandle) {
            await fileHandle.close();
        }
    }
}

async function optimizeVideo(filePath) {
    const targetDir = path.dirname(filePath);
    const tempPath = path.join(targetDir, `temp_opt_${path.basename(filePath)}`);
    const command = `ffmpeg -v error -y -i "${filePath}" -c copy -movflags +faststart "${tempPath}"`;

    try {
        // 预检测：目录是否可写（挂载为只读会直接跳过优化，避免无意义重试）
        try {
            await fs.access(targetDir, FS_CONST.W_OK);
        } catch (e) {
            logger.warn(`视频目录不可写，跳过优化(只读文件系统): ${targetDir}`);
            return { success: true, path: filePath, status: 'skipped_readonly' };
        }

        await execPromise(command);
        await fs.rename(tempPath, filePath);
        return { success: true, path: filePath };
    } catch (error) {
        await fs.unlink(tempPath).catch(() => {});
        return { success: false, path: filePath, error: error.message || '未知ffmpeg错误' };
    }
}

parentPort.on('message', async (task) => {
    const { filePath } = task;
    const failureKey = `video_failed_permanently:${filePath}`;

    // --- ↓↓↓ 这是修改的核心 ↓↓↓ ---

    // 1. 检查是否已被标记为永久失败
    const isPermanentlyFailed = await redis.get(failureKey);
    if (isPermanentlyFailed) {
        logger.warn(`视频已被标记为永久失败，跳过: ${filePath}`);
        parentPort.postMessage({ success: true, path: filePath, status: 'skipped_permanent_failure' });
        return;
    }

    if (await isOptimized(filePath)) {
        logger.info(`视频已优化，跳过: ${filePath}`);
        parentPort.postMessage({ success: true, path: filePath, status: 'skipped_optimized' });
        return;
    }

    logger.info(`视频需要优化，开始处理: ${filePath}`);
    const result = await optimizeVideo(filePath);

    if (result.success) {
        logger.info(`成功优化: ${filePath}`);
        failureCounts.delete(filePath); // 成功后清除失败计数
        parentPort.postMessage(result);
    } else {
        // 2. 处理失败，增加失败计数
        const currentFailures = (failureCounts.get(filePath) || 0) + 1;
        failureCounts.set(filePath, currentFailures);

        logger.error(`优化失败 (第 ${currentFailures} 次): ${filePath}`, result.error);

        if (currentFailures >= MAX_VIDEO_RETRIES) {
            // 3. 达到最大次数，标记为永久失败
            logger.error(`视频达到最大重试次数，标记为永久失败: ${filePath}`);
            await redis.set(failureKey, '1', 'EX', PERMANENT_FAILURE_TTL);
            failureCounts.delete(filePath); // 清除内存中的计数
        }

        // 无论是否达到最大次数，都将失败结果发回主线程
        parentPort.postMessage(result);
    }
    // --- ↑↑↑ 修改结束 ↑↑↑ ---
});