const { parentPort } = require('worker_threads');
const { exec } = require('child_process');
const path = require('path');
const { promises: fs, constants: FS_CONST } = require('fs');
const util = require('util');
const Redis = require('ioredis');
const winston = require('winston');
const { initializeConnections, dbAll } = require('../db/multi-db');
const { THUMBS_DIR, PHOTOS_DIR } = require('../config');

(async () => {
    await initializeConnections();

    // --- 日志和配置 ---
    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] [VIDEO-PROCESSOR] ${info.level}: ${info.message}`)),
        transports: [new winston.transports.Console()]
    });

    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    const execPromise = util.promisify(exec);

    // --- 失败重试配置 ---
    const failureCounts = new Map();
    const MAX_VIDEO_RETRIES = 3;
    const PERMANENT_FAILURE_TTL = 3600 * 24 * 7;

    // 核心处理函数：优化 moov 并生成 HLS
    async function processVideo(filePath, relativePath, thumbsDir) {
        const targetDir = path.dirname(filePath);
        // 在源文件目录内创建 .tmp 子目录，避免跨设备链接问题
        const tempDir = path.join(targetDir, '.tmp');
        const tempPath = path.join(tempDir, `temp_opt_${path.basename(filePath)}`);
        const hlsOutputDir = path.join(thumbsDir, 'hls', relativePath);

        try {
            // 0. 预检测：目录是否可写，并创建临时目录
            await fs.access(targetDir, FS_CONST.W_OK);
            await fs.mkdir(tempDir, { recursive: true });
            
            // 在 .tmp 目录中创建 .nomedia 文件，防止被索引工具读取
            const nomediaFile = path.join(tempDir, '.nomedia');
            await fs.writeFile(nomediaFile, '# 临时目录，请勿索引\n').catch(() => {});
            
            await fs.mkdir(hlsOutputDir, { recursive: true });

            // 1. 优化 moov atom (faststart)
            logger.info(`[1/3] 优化 MOOV atom: ${filePath}`);
            const faststartCommand = `ffmpeg -v error -y -i "${filePath}" -c copy -movflags +faststart "${tempPath}"`;
            await execPromise(faststartCommand);
            
            // 使用复制替代重命名，避免跨设备问题
            await fs.copyFile(tempPath, filePath);
            await fs.unlink(tempPath); // 删除临时文件
            logger.info(`[1/3] MOOV atom 优化成功: ${filePath}`);

            // 2. 生成 HLS 多码率流
            logger.info(`[2/3] 开始生成 HLS 流: ${filePath}`);
            const resolutions = [
                { name: '480p', width: 854, height: 480, bandwidth: '1500000' },
                { name: '720p', width: 1280, height: 720, bandwidth: '2800000' }
            ];

            for (const res of resolutions) {
                const resDir = path.join(hlsOutputDir, res.name);
                await fs.mkdir(resDir, { recursive: true });
                // 等比缩放并填充至目标分辨率，避免拉伸变形；同时规范像素宽高比
                const vf = `scale=${res.width}:${res.height}:force_original_aspect_ratio=decrease:eval=frame,pad=${res.width}:${res.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
                const hlsCommand = `ffmpeg -v error -y -i "${filePath}" -vf "${vf}" -c:v libx264 -profile:v baseline -level 3.0 -preset veryfast -crf 23 -c:a aac -ar 48000 -ac 2 -b:a 128k -start_number 0 -hls_time 10 -hls_flags independent_segments -hls_list_size 0 -f hls "${path.join(resDir, 'stream.m3u8')}"`;
                await execPromise(hlsCommand);
                logger.info(`  - ${res.name} HLS 流生成成功`);
            }

            // 3. 创建主播放列表 master.m3u8
            logger.info(`[3/3] 创建 HLS 主播放列表: ${filePath}`);
            const masterPlaylistContent = resolutions.map(res => 
                `#EXT-X-STREAM-INF:BANDWIDTH=${res.bandwidth},RESOLUTION=${res.width}x${res.height}\n${res.name}/stream.m3u8`
            ).join('\n');
            const masterPlaylist = `#EXTM3U\n${masterPlaylistContent}`;
            await fs.writeFile(path.join(hlsOutputDir, 'master.m3u8'), masterPlaylist);
            logger.info(`[3/3] HLS 主播放列表创建成功`);

            // 清理临时目录（如果为空）
            try {
                const tempFiles = await fs.readdir(tempDir);
                if (tempFiles.length === 0) {
                    await fs.rmdir(tempDir);
                }
            } catch (e) {
                // 忽略清理错误
            }

            return { success: true, path: filePath };

        } catch (error) {
            // 清理临时文件和目录
            try {
                if (await fs.access(tempPath).then(() => true).catch(() => false)) {
                    await fs.unlink(tempPath);
                }
                if (await fs.access(tempDir).then(() => true).catch(() => false)) {
                    const tempFiles = await fs.readdir(tempDir);
                    if (tempFiles.length === 0) {
                        await fs.rmdir(tempDir);
                    }
                }
            } catch (cleanupError) {
                // 忽略清理错误
            }
            
            await fs.rm(hlsOutputDir, { recursive: true, force: true }).catch(() => {});
            return { success: false, path: filePath, error: error.message || '未知 ffmpeg 错误' };
        }
    }

    // 将单个任务的处理逻辑封装起来，以便复用
    async function handleTask(task) {
        const { filePath, relativePath, thumbsDir } = task;
        const failureKey = `video_failed_permanently:${filePath}`;

        try {
            const isPermanentlyFailed = await redis.get(failureKey);
            if (isPermanentlyFailed) {
                logger.warn(`视频已被标记为永久失败，跳过: ${filePath}`);
                parentPort.postMessage({ success: true, path: filePath, status: 'skipped_permanent_failure' });
                return;
            }

            const hlsMasterPlaylist = path.join(thumbsDir, 'hls', relativePath, 'master.m3u8');
            const hlsExists = await fs.access(hlsMasterPlaylist).then(() => true).catch(() => false);

            if (hlsExists) {
                logger.info(`HLS 流已存在，跳过: ${filePath}`);
                parentPort.postMessage({ success: true, path: filePath, status: 'skipped_hls_exists' });
                return;
            }

            logger.info(`视频需要处理，开始任务: ${filePath}`);
            const result = await processVideo(filePath, relativePath, thumbsDir);

            if (result.success) {
                logger.info(`成功处理视频: ${filePath}`);
                failureCounts.delete(filePath);
                parentPort.postMessage(result);
            } else {
                const currentFailures = (failureCounts.get(filePath) || 0) + 1;
                failureCounts.set(filePath, currentFailures);
                logger.error(`处理失败 (第 ${currentFailures} 次): ${filePath}`, result.error);

                if (currentFailures >= MAX_VIDEO_RETRIES) {
                    logger.error(`视频达到最大重试次数，标记为永久失败: ${filePath}`);
                    await redis.set(failureKey, '1', 'EX', PERMANENT_FAILURE_TTL);
                    failureCounts.delete(filePath);
                }
                parentPort.postMessage(result);
            }
        } catch (e) {
            logger.error(`[VIDEO-PROCESSOR] 处理任务时发生致命错误 ${filePath}:`, e);
            parentPort.postMessage({ success: false, path: filePath, error: e.message });
        }
    }

    // 全局临时文件清理函数
    async function cleanupTempFiles() {
        try {
            logger.info('[VIDEO-PROCESSOR] 开始清理残留的临时文件...');
            let cleanedCount = 0;
            
            // 递归查找并清理 .tmp 目录
            async function cleanupDir(dirPath) {
                try {
                    const entries = await fs.readdir(dirPath, { withFileTypes: true });
                    
                    for (const entry of entries) {
                        const fullPath = path.join(dirPath, entry.name);
                        
                        if (entry.isDirectory()) {
                            if (entry.name === '.tmp') {
                                // 清理 .tmp 目录
                                try {
                                    const tempFiles = await fs.readdir(fullPath);
                                    if (tempFiles.length === 0) {
                                        await fs.rmdir(fullPath);
                                        cleanedCount++;
                                        logger.debug(`清理空临时目录: ${fullPath}`);
                                    } else {
                                        // 删除 .tmp 目录中的所有文件
                                        for (const tempFile of tempFiles) {
                                            await fs.unlink(path.join(fullPath, tempFile));
                                        }
                                        await fs.rmdir(fullPath);
                                        cleanedCount++;
                                        logger.debug(`清理临时目录: ${fullPath}`);
                                    }
                                } catch (e) {
                                    logger.warn(`清理临时目录失败: ${fullPath}`, e.message);
                                }
                            } else {
                                // 递归处理子目录
                                await cleanupDir(fullPath);
                            }
                        }
                    }
                } catch (e) {
                    // 忽略无法访问的目录
                }
            }
            
            await cleanupDir(PHOTOS_DIR);
            logger.info(`[VIDEO-PROCESSOR] 临时文件清理完成，共清理 ${cleanedCount} 个目录`);
            
        } catch (error) {
            logger.error('[VIDEO-PROCESSOR] 清理临时文件时出错:', error);
        }
    }

    parentPort.on('message', async (task) => {
        if (task.type === 'backfill') {
            logger.info('[VIDEO-PROCESSOR] 收到 HLS 回填任务，开始扫描数据库...');
            try {
                // 先清理残留的临时文件
                await cleanupTempFiles();
                
                const videos = await dbAll('main', `SELECT path FROM items WHERE type = 'video'`);
                logger.info(`发现 ${videos.length} 个视频需要检查 HLS 状态。`);
                for (const video of videos) {
                    // 依次处理，避免并发过高
                    await handleTask({
                        filePath: path.join(PHOTOS_DIR, video.path),
                        relativePath: video.path,
                        thumbsDir: THUMBS_DIR
                    });
                }
                logger.info('[VIDEO-PROCESSOR] HLS 回填任务检查完成。');
            } catch (e) {
                logger.error('[VIDEO-PROCESSOR] HLS 回填任务失败:', e);
            }
        } else if (task.type === 'cleanup') {
            // 手动触发清理任务
            await cleanupTempFiles();
            parentPort.postMessage({ success: true, message: '临时文件清理完成' });
        } else {
            // 处理普通单个任务
            await handleTask(task);
        }
    });
})();