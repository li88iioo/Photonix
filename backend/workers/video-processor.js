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
        const tempPath = path.join(targetDir, `temp_opt_${path.basename(filePath)}`);
        const hlsOutputDir = path.join(thumbsDir, 'hls', relativePath);

        try {
            // 0. 预检测：目录是否可写
            await fs.access(targetDir, FS_CONST.W_OK);
            await fs.mkdir(hlsOutputDir, { recursive: true });

            // 1. 优化 moov atom (faststart)
            logger.info(`[1/3] 优化 MOOV atom: ${filePath}`);
            const faststartCommand = `ffmpeg -v error -y -i "${filePath}" -c copy -movflags +faststart "${tempPath}"`;
            await execPromise(faststartCommand);
            await fs.rename(tempPath, filePath);
            logger.info(`[1/3] MOOV atom 优化成功: ${filePath}`);

            // 2. 生成 HLS 多码率流
            logger.info(`[2/3] 开始生成 HLS 流: ${filePath}`);
            const resolutions = [
                { name: '480p', size: '854x480', bandwidth: '1500000' },
                { name: '720p', size: '1280x720', bandwidth: '2800000' }
            ];

            for (const res of resolutions) {
                const resDir = path.join(hlsOutputDir, res.name);
                await fs.mkdir(resDir, { recursive: true });
                const hlsCommand = `ffmpeg -v error -y -i "${filePath}" -profile:v baseline -level 3.0 -s ${res.size} -start_number 0 -hls_time 10 -hls_list_size 0 -f hls "${path.join(resDir, 'stream.m3u8')}"`;
                await execPromise(hlsCommand);
                logger.info(`  - ${res.name} HLS 流生成成功`);
            }

            // 3. 创建主播放列表 master.m3u8
            logger.info(`[3/3] 创建 HLS 主播放列表: ${filePath}`);
            const masterPlaylistContent = resolutions.map(res => 
                `#EXT-X-STREAM-INF:BANDWIDTH=${res.bandwidth},RESOLUTION=${res.size}\n${res.name}/stream.m3u8`
            ).join('\n');
            const masterPlaylist = `#EXTM3U\n${masterPlaylistContent}`;
            await fs.writeFile(path.join(hlsOutputDir, 'master.m3u8'), masterPlaylist);
            logger.info(`[3/3] HLS 主播放列表创建成功`);

            return { success: true, path: filePath };

        } catch (error) {
            await fs.unlink(tempPath).catch(() => {});
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

    parentPort.on('message', async (task) => {
        if (task.type === 'backfill') {
            logger.info('[VIDEO-PROCESSOR] 收到 HLS 回填任务，开始扫描数据库...');
            try {
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
        } else {
            // 处理普通单个任务
            await handleTask(task);
        }
    });
})();