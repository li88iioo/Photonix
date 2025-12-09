const { parentPort } = require('worker_threads');
const { exec } = require('child_process');
const path = require('path');
const { promises: fs, constants: FS_CONST } = require('fs');
const { TraceManager } = require('../utils/trace');
const util = require('util');
const os = require('os');
const { redis } = require('../config/redis');
const { safeRedisGet, safeRedisSet } = require('../utils/helpers');
const winston = require('winston');
const baseLogger = require('../config/logger');
const { LOG_PREFIXES, formatLog, normalizeMessagePrefix } = baseLogger;
const { initializeConnections, dbAll } = require('../db/multi-db');
const { THUMBS_DIR, PHOTOS_DIR, VIDEO_MAX_CONCURRENCY, VIDEO_TASK_DELAY_MS } = require('../config');
const { tempFileManager } = require('../utils/tempFileManager');
const { createWorkerResult, createWorkerError } = require('../utils/workerMessage');

(async () => {
    await initializeConnections();

    // --- 日志和配置 ---
    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp(),
            winston.format.printf(info => {
                const date = new Date(info.timestamp);
                const time = date.toTimeString().split(' ')[0];
                const normalized = normalizeMessagePrefix(info.message);
                return `[${time}] ${info.level}: ${LOG_PREFIXES.VIDEO_WORKER || '视频线程'} ${normalized}`;
            })
        ),
        transports: [new winston.transports.Console()]
    });

    /** 使用统一的 Redis 客户端（来自 config/redis） **/
    const execPromise = util.promisify(exec);

    // --- 失败重试配置 ---
    const failureCounts = new Map();
    const MAX_VIDEO_RETRIES = 3;
    const PERMANENT_FAILURE_TTL = 3600 * 24 * 7;

    // --- 任务队列管理 ---
    const taskQueue = [];
    let isProcessingQueue = false;
    let activeTaskCount = 0;
    let schedulerBackoffTimer = null;
    const MAX_CONCURRENT_TASKS = Math.max(1, Math.min(VIDEO_MAX_CONCURRENCY, 4)); // 视频处理最大并发，默认受限于硬件
    const TASK_TIMEOUT_MS = 30 * 60 * 1000; // 单个任务超时时间：30分钟
    const QUEUE_HEALTH_CHECK_INTERVAL = 30 * 1000; // 队列健康检查间隔：30秒（更频繁以便监控内存）

    // --- 空闲超时管理 ---
    const IDLE_TIMEOUT_MS = Math.max(5000, Number(process.env.VIDEO_WORKER_IDLE_TIMEOUT_MS || 10000)); // 默认10秒空闲超时
    let lastActivityTime = Date.now();
    let idleCheckTimer = null;
    let isShuttingDown = false;
    let idleNotified = false;
    let lastMemoryWarningTime = 0;

    // 任务超时包装器
    async function executeTaskWithTimeout(task, timeoutMs = TASK_TIMEOUT_MS) {
        return new Promise(async (resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(`任务执行超时 (${timeoutMs}ms): ${JSON.stringify(task)}`));
            }, timeoutMs);

            try {
                const result = await handleTask(task);
                clearTimeout(timeoutId);
                resolve(result);
            } catch (error) {
                clearTimeout(timeoutId);
                reject(error);
            }
        });
    }


    // 内存和队列健康检查
    function performQueueHealthCheck() {
        const queueSize = taskQueue.length;
        const memUsage = process.memoryUsage();
        const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.max(1, Math.round(memUsage.heapTotal / 1024 / 1024));
        const rssMB = Math.round(memUsage.rss / 1024 / 1024);

        // 动态计算 RSS 阈值
        // 1. 优先使用环境变量
        // 2. 其次使用 DETECTED_MEMORY_GB 的 60%
        // 3. 最后使用 os.totalmem() 的 60%
        const detectedMemGB = Number(process.env.DETECTED_MEMORY_GB || 0);
        const systemMemGB = detectedMemGB || Math.floor(os.totalmem() / (1024 * 1024 * 1024));
        const defaultRssThresholdMB = Math.floor(systemMemGB * 1024 * 0.6); // 系统内存的60%
        const rssThresholdMB = Number(process.env.VIDEO_WORKER_RSS_THRESHOLD_MB || defaultRssThresholdMB);

        // 内存压力检测
        const memoryPressure = heapUsedMB > heapTotalMB * 0.9; // 堆使用超过90%
        const highMemoryUsage = rssMB > rssThresholdMB; // RSS超过动态阈值

        // 队列积压检测
        const isStuck = queueSize > 0 && activeTaskCount === 0 && !schedulerBackoffTimer;
        const severeBacklog = queueSize > 100;
        const moderateBacklog = queueSize > 50;

        // 内存紧急情况：强制垃圾回收和暂停新任务
        if (memoryPressure || highMemoryUsage) {
            // 限流：只每分钟记录一次内存压力警告
            const now = Date.now();
            if (now - lastMemoryWarningTime > 60000) {
                logger.warn(`${LOG_PREFIXES.VIDEO_PROCESSOR} 检测到内存压力 - 堆使用: ${heapUsedMB}/${heapTotalMB}MB, RSS: ${rssMB}MB`);
                lastMemoryWarningTime = now;
            }

            // 尝试垃圾回收（如果可用）
            if (global.gc) {
                global.gc();
                logger.debug(`${LOG_PREFIXES.VIDEO_PROCESSOR} 已触发垃圾回收`);
            }

            // 如果队列严重积压，暂停队列处理
            if (severeBacklog) {
                logger.warn(`${LOG_PREFIXES.VIDEO_PROCESSOR} 内存压力+队列积压，暂停队列处理: ${queueSize} 个任务`);
                return; // 跳过本次队列处理
            }
        }

        // 队列状态处理
        if (isStuck) {
            logger.warn(`${LOG_PREFIXES.VIDEO_PROCESSOR} 检测到队列可能卡住，当前队列长度: ${queueSize}，重新调度处理`);
            isProcessingQueue = false;
            setImmediate(() => processTaskQueue());
        }

        if (severeBacklog) {
            logger.error(`${LOG_PREFIXES.VIDEO_PROCESSOR} 任务队列严重积压: ${queueSize} 个任务 - 可能需要重启服务`);
        } else if (moderateBacklog) {
            logger.warn(`${LOG_PREFIXES.VIDEO_PROCESSOR} 任务队列积压: ${queueSize} 个任务`);
        }

        // 定期内存报告
        if (heapUsedMB > 100) { // 只有在堆使用超过100MB时才报告
            logger.debug(`${LOG_PREFIXES.VIDEO_PROCESSOR} 内存状态 - 堆使用: ${heapUsedMB}/${heapTotalMB}MB, RSS: ${rssMB}MB, 队列: ${queueSize}, 活跃: ${activeTaskCount}`);
        }
    }

    // 更新活动时间
    function updateActivity() {
        if (!isShuttingDown) {
            lastActivityTime = Date.now();
            logger.debug(`${LOG_PREFIXES.VIDEO_PROCESSOR} 活动时间已更新`);
            idleNotified = false;
        }
    }

    // 检查空闲状态并决定是否退出
    function checkIdleAndExit() {
        if (isShuttingDown) return;

        const idleTime = Date.now() - lastActivityTime;
        const hasActiveTasks = taskQueue.length > 0 || isProcessingQueue || activeTaskCount > 0;

        if (!hasActiveTasks && idleTime > IDLE_TIMEOUT_MS) {
            if (!idleNotified) {
                idleNotified = true;
                logger.info(`${LOG_PREFIXES.VIDEO_PROCESSOR} 空闲超时 (${Math.round(idleTime / 1000)}秒)，通知主进程可释放线程`);
                parentPort.postMessage(createWorkerResult({
                    type: 'WORKER_IDLE',
                    idleForMs: idleTime,
                    timestamp: new Date().toISOString()
                }));
            }
            return;
        }
        // 移除活跃任务的debug日志，避免刷屏
    }

    // 优雅关闭函数
    function gracefulShutdown(reason = 'manual') {
        if (isShuttingDown) return;

        isShuttingDown = true;
        logger.info(`${LOG_PREFIXES.VIDEO_PROCESSOR} 开始优雅关闭 (原因: ${reason})`);

        // 清理定时器
        if (healthCheckTimer) {
            clearInterval(healthCheckTimer);
            healthCheckTimer = null;
        }

        if (idleCheckTimer) {
            clearInterval(idleCheckTimer);
            idleCheckTimer = null;
        }
        if (schedulerBackoffTimer) {
            clearTimeout(schedulerBackoffTimer);
            schedulerBackoffTimer = null;
        }

        // 发送退出信号给主进程
        parentPort.postMessage(createWorkerError({
            type: 'worker_shutdown',
            reason,
            message: `Video worker shutting down (${reason})`,
            timestamp: new Date().toISOString(),
            queueLength: taskQueue.length,
            isProcessing: isProcessingQueue || activeTaskCount > 0,
        }));

        // 等待当前任务完成（最多30秒）
        const shutdownTimeout = setTimeout(() => {
            logger.warn(`${LOG_PREFIXES.VIDEO_PROCESSOR} 关闭超时，强制退出`);
            process.exit(0);
        }, 30000);

        // 如果队列为空且没有处理中的任务，立即退出
        if (taskQueue.length === 0 && activeTaskCount === 0) {
            clearTimeout(shutdownTimeout);
            logger.info(`${LOG_PREFIXES.VIDEO_PROCESSOR} 队列为空，立即退出`);
            process.exit(0);
        }

        // 监听队列完成事件
        const checkShutdown = () => {
            if (taskQueue.length === 0 && activeTaskCount === 0) {
                clearTimeout(shutdownTimeout);
                logger.info(`${LOG_PREFIXES.VIDEO_PROCESSOR} 所有任务完成，退出`);
                process.exit(0);
            }
        };

        // 定期检查是否可以退出
        const shutdownCheckInterval = setInterval(checkShutdown, 1000);

        // 清理关闭检查定时器
        setTimeout(() => {
            clearInterval(shutdownCheckInterval);
        }, 30000);
    }

    // 启动定期健康检查
    const healthCheckTimer = setInterval(performQueueHealthCheck, QUEUE_HEALTH_CHECK_INTERVAL);

    // 启动空闲检查
    const idleCheckInterval = Math.max(2000, Math.floor(IDLE_TIMEOUT_MS / 2));
    idleCheckTimer = setInterval(checkIdleAndExit, idleCheckInterval);

    // 队列处理函数 - 支持有限并发与资源感知
    function processTaskQueue() {
        if (isShuttingDown) {
            return;
        }

        if (taskQueue.length === 0) {
            if (activeTaskCount === 0) {
                isProcessingQueue = false;
            }
            return;
        }

        updateActivity();

        const memUsage = process.memoryUsage();
        const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.max(1, Math.round(memUsage.heapTotal / 1024 / 1024));
        const memoryPressure = heapUsedMB > heapTotalMB * 0.8;

        const detectedCpu = Math.max(1, Number(process.env.DETECTED_CPU_COUNT) || ((os.cpus && os.cpus().length) || 1));
        const loadAvg = (os.loadavg && os.loadavg()[0]) || 0;
        const highLoad = loadAvg > detectedCpu * 0.85;

        let availableSlots = MAX_CONCURRENT_TASKS - activeTaskCount;
        if (memoryPressure || highLoad) {
            availableSlots = Math.min(availableSlots, 1);
        }
        availableSlots = Math.max(0, availableSlots);

        if (availableSlots === 0) {
            if (activeTaskCount === 0) {
                scheduleQueueRetry(memoryPressure ? 5000 : 1500);
            }
            return;
        }

        isProcessingQueue = true;
        logger.info(
            `${LOG_PREFIXES.VIDEO_PROCESSOR} 调度任务 (active:${activeTaskCount}, queued:${taskQueue.length}, max:${MAX_CONCURRENT_TASKS}${memoryPressure ? ', 内存压力' : ''}${highLoad ? ', 高负载' : ''})`
        );

        const launchCount = Math.min(availableSlots, taskQueue.length);
        for (let i = 0; i < launchCount; i++) {
            const task = taskQueue.shift();
            launchTask(task);
        }
    }

    function scheduleQueueRetry(delayMs) {
        if (schedulerBackoffTimer) {
            return;
        }
        schedulerBackoffTimer = setTimeout(() => {
            schedulerBackoffTimer = null;
            processTaskQueue();
        }, delayMs);
    }

    function computeAdaptiveDelay() {
        const detectedCpu = Math.max(1, Number(process.env.DETECTED_CPU_COUNT) || ((os.cpus && os.cpus().length) || 1));
        const loadAvg = (os.loadavg && os.loadavg()[0]) || 0;
        const highLoad = loadAvg > detectedCpu * 0.8;

        let delayMs = highLoad ? Math.max(VIDEO_TASK_DELAY_MS, 2000) : VIDEO_TASK_DELAY_MS;

        const memUsage = process.memoryUsage();
        const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.max(1, Math.round(memUsage.heapTotal / 1024 / 1024));
        if (heapUsedMB > heapTotalMB * 0.8) {
            delayMs = Math.max(delayMs, 5000);
        }

        return delayMs;
    }

    function launchTask(task) {
        if (!task) {
            return;
        }

        activeTaskCount += 1;
        isProcessingQueue = true;
        updateActivity();

        executeTaskWithTimeout(task)
            .catch((error) => {
                logger.error(`${LOG_PREFIXES.VIDEO_PROCESSOR} 队列任务处理失败:`, error);
            })
            .finally(async () => {
                try {
                    const delayMs = computeAdaptiveDelay();
                    if (delayMs > 0) {
                        await new Promise((resolve) => setTimeout(resolve, delayMs));
                    }
                } catch (delayError) {
                    logger.debug(`${LOG_PREFIXES.VIDEO_PROCESSOR} 延迟执行失败（忽略）:`, delayError && delayError.message);
                } finally {
                    activeTaskCount = Math.max(0, activeTaskCount - 1);
                    isProcessingQueue = activeTaskCount > 0;
                    if (taskQueue.length > 0) {
                        setImmediate(processTaskQueue);
                    } else if (!isProcessingQueue) {
                        logger.debug(`${LOG_PREFIXES.VIDEO_PROCESSOR} 任务队列处理完成`);
                    }
                }
            });
    }

    /**
     * 创建处理所需的目录结构
     */
    async function createProcessingDirectories(thumbsDir, relativePath) {
        const processingDir = path.join(thumbsDir, 'temp', relativePath);
        const hlsOutputDir = path.join(thumbsDir, 'hls', relativePath);

        // 创建处理目录（使用临时文件管理器）
        await tempFileManager.ensureTempDir(relativePath);
        await fs.mkdir(processingDir, { recursive: true });

        // 在处理目录中创建 .nomedia 文件，防止被索引工具读取
        const nomediaFile = path.join(processingDir, '.nomedia');
        await fs.writeFile(nomediaFile, '# 处理目录，请勿索引\n').catch(() => { });

        // 创建HLS输出目录
        await fs.mkdir(hlsOutputDir, { recursive: true });

        return { processingDir, hlsOutputDir };
    }

    /**
     * 探测视频旋转元数据，决定是否自动矫正方向
     */
    async function detectVideoRotation(filePath) {
        try {
            const { stdout } = await execPromise(`ffprobe -v error -select_streams v:0 -show_entries stream_tags=rotate:stream_side_data=displaymatrix -of json "${filePath}"`);
            const data = JSON.parse(stdout || '{}');
            let angle = 0;

            // 1) tags.rotate（常见于手机视频）
            const streams = Array.isArray(data.streams) ? data.streams : [];
            if (streams.length > 0) {
                const tags = streams[0].tags || {};
                if (tags.rotate) {
                    const v = parseInt(String(tags.rotate).trim(), 10);
                    if (!Number.isNaN(v)) angle = v;
                }
                // 2) side_data_list.rotation（新容器使用的 Display Matrix）
                const sdl = streams[0].side_data_list || [];
                for (const sd of sdl) {
                    if (sd && typeof sd.rotation !== 'undefined') {
                        const r = parseFloat(sd.rotation);
                        if (!Number.isNaN(r) && Math.abs(r) > Math.abs(angle)) angle = r;
                    }
                }
            }
            // 归一化到 [0,360)
            let norm = ((Math.round(angle) % 360) + 360) % 360;
            return norm; // 0/90/180/270
        } catch (rotationErr) {
            logger.debug(`${LOG_PREFIXES.VIDEO_PROCESSOR} 读取视频旋转信息失败，使用默认角度0:`, rotationErr && rotationErr.message);
            return 0;
        }
    }

    /**
     * 获取FFmpeg自适应配置
     */
    async function getFfmpegTuning() {
        try {
            const threadsStr = await safeRedisGet(redis, 'adaptive:ffmpeg_threads', 'FFmpeg线程配置');
            const preset = await safeRedisGet(redis, 'adaptive:ffmpeg_preset', 'FFmpeg预设配置');
            const threads = Math.max(1, parseInt(threadsStr || '1', 10));
            const presetFinal = (preset || process.env.FFMPEG_PRESET || 'veryfast');
            return { threads, preset: presetFinal };
        } catch (ffmpegCfgErr) {
            logger.debug(`${LOG_PREFIXES.VIDEO_PROCESSOR} 获取 FFmpeg 自适应配置失败，使用默认值:`, ffmpegCfgErr && ffmpegCfgErr.message);
            const cpus = Math.max(1, Number(process.env.DETECTED_CPU_COUNT) || ((os.cpus && os.cpus().length) || 1));
            const defaultThreads = Math.max(1, Math.floor(cpus / 2));
            const finalThreads = Math.max(1, parseInt(process.env.FFMPEG_THREADS || String(defaultThreads), 10));
            return { threads: finalThreads, preset: (process.env.FFMPEG_PRESET || 'veryfast') };
        }
    }

    /**
     * 生成HLS多码率流
     */
    async function generateHlsStreams(filePath, hlsOutputDir, rotation, ffCfg) {
        logger.debug(`[2/3] 开始生成 HLS 流: ${filePath}`);
        const resolutions = [
            { name: '480p', width: 854, height: 480, bandwidth: '1500000' },
            { name: '720p', width: 1280, height: 720, bandwidth: '2800000' }
        ];

        // 根据旋转角度确定滤镜
        let rotateFilter = '';
        if (rotation === 90) rotateFilter = 'transpose=1';
        else if (rotation === 270) rotateFilter = 'transpose=2';
        else if (rotation === 180) rotateFilter = 'hflip,vflip';

        const successfulResolutions = [];
        const failedResolutions = [];

        for (const res of resolutions) {
            const resDir = path.join(hlsOutputDir, res.name);
            await fs.mkdir(resDir, { recursive: true });

            try {
                // 等比放大 + 居中裁剪，保证无黑边且不变形；先做方向矫正；同时规范像素宽高比
                const baseScaleCrop = `scale=${res.width}:${res.height}:force_original_aspect_ratio=increase:eval=frame,crop=${res.width}:${res.height}`;
                const vfChain = [rotateFilter, baseScaleCrop, 'setsar=1'].filter(Boolean).join(',');
                const segmentPattern = path.join(resDir, 'segment_%05d.ts');
                const hlsCommand = `ffmpeg -v error -y -threads ${ffCfg.threads} -i "${filePath}" -vf "${vfChain}" -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.0 -preset ${ffCfg.preset} -crf 23 -c:a aac -ar 48000 -ac 2 -b:a 128k -metadata:s:v:0 rotate=0 -start_number 0 -hls_time 10 -hls_flags independent_segments -hls_segment_filename "${segmentPattern}" -hls_list_size 0 -f hls "${path.join(resDir, 'stream.m3u8')}"`;

                await execPromise(hlsCommand);
                logger.debug(`  - ${res.name} HLS 流生成成功`);
                successfulResolutions.push(res);
            } catch (error) {
                const errorMsg = `  - ${res.name} HLS 流生成失败: ${error.message || '未知 FFmpeg 错误'}`;
                logger.error(errorMsg);
                failedResolutions.push({ resolution: res, error: error.message });

                // 清理失败的分辨率目录
                try {
                    await fs.rm(resDir, { recursive: true, force: true });
                } catch (cleanupError) {
                    logger.warn(`清理失败的分辨率目录失败 ${resDir}: ${cleanupError.message}`);
                }
            }
        }

        // 如果所有分辨率都失败，抛出错误
        if (successfulResolutions.length === 0) {
            const errorDetails = failedResolutions.map(f => `${f.resolution.name}: ${f.error}`).join('; ');
            const { BusinessLogicError } = require('../utils/errors');
            throw new BusinessLogicError(`所有HLS分辨率生成失败: ${errorDetails}`, 'HLS_ALL_FAILED', {
                failedResolutions: failedResolutions.map(f => ({ resolution: f.resolution.name, error: f.error }))
            });
        }

        // 如果部分失败，记录警告但继续处理
        if (failedResolutions.length > 0) {
            logger.warn(`${failedResolutions.length} 个分辨率生成失败，继续处理成功的分辨率`);
        }

        return successfulResolutions;
    }

    /**
     * 创建HLS主播放列表
     */
    async function createMasterPlaylist(hlsOutputDir, resolutions, filePath) {
        logger.debug(`[3/3] 创建 HLS 主播放列表: ${filePath}`);
        const masterPlaylistContent = resolutions.map(res =>
            `#EXT-X-STREAM-INF:BANDWIDTH=${res.bandwidth},RESOLUTION=${res.width}x${res.height}\n${res.name}/stream.m3u8`
        ).join('\n');
        const masterPlaylist = `#EXTM3U\n${masterPlaylistContent}`;
        await fs.writeFile(path.join(hlsOutputDir, 'master.m3u8'), masterPlaylist);
        logger.debug(`[3/3] HLS 主播放列表创建成功`);
    }

    /**
     * 清理单个视频处理任务的临时文件
     * 使用统一的文件清理策略，确保资源得到正确释放
     */
    async function cleanupTempFiles(processingDir, tempPath, hlsOutputDir) {
        const cleanupTasks = [];

        try {
            // 清理临时文件管理器中的文件
            if (tempPath) {
                try {
                    const relativeTempPath = path.relative(path.join(THUMBS_DIR, 'temp'), tempPath);
                    cleanupTasks.push(
                        tempFileManager.cleanupTempFiles(path.dirname(relativeTempPath))
                            .catch(e => logger.debug(`临时文件管理器清理失败: ${e.message}`))
                    );
                } catch (e) {
                    logger.debug(`计算相对路径失败: ${e.message}`);
                }
            }

            // 清理HLS输出目录
            if (hlsOutputDir) {
                cleanupTasks.push(
                    fs.rm(hlsOutputDir, { recursive: true, force: true })
                        .catch(e => logger.debug(`HLS输出目录清理失败: ${e.message}`))
                );
            }

            // 清理处理目录（如果为空）
            if (processingDir) {
                cleanupTasks.push(
                    (async () => {
                        try {
                            const files = await fs.readdir(processingDir).catch(() => []);
                            if (files.length === 0) {
                                await fs.rmdir(processingDir).catch(() => { });
                                logger.debug(`清理空的处理目录: ${processingDir}`);
                            }
                        } catch (e) {
                            logger.debug(`处理目录清理失败: ${e.message}`);
                        }
                    })()
                );
            }

            // 并行执行所有清理任务，但不等待它们完成（避免阻塞）
            Promise.allSettled(cleanupTasks).then(results => {
                const failedCount = results.filter(r => r.status === 'rejected').length;
                if (failedCount > 0) {
                    logger.debug(`临时文件清理完成，${failedCount} 个子任务失败（已记录）`);
                }
            }).catch(() => {
                // 忽略Promise.allSettled的错误
            });

        } catch (cleanupError) {
            logger.warn(`临时文件清理初始化失败: ${cleanupError.message}`);
        }
    }

    // 核心处理函数：优化 moov 并生成 HLS
    async function processVideo(filePath, relativePath, thumbsDir) {
        const startTime = Date.now(); // 记录处理开始时间
        const optimizedPath = tempFileManager.getTempFilePath(relativePath, 'optimized');

        try {
            // 1. 创建处理目录
            const { processingDir, hlsOutputDir } = await createProcessingDirectories(thumbsDir, relativePath);

            // 跳过MOOV atom优化，保持原文件不变，直接进行HLS处理
            logger.debug(`跳过MOOV atom优化，保持原文件不变: ${filePath}`);

            // 2. 检测视频旋转
            const rotation = await detectVideoRotation(filePath);

            // 3. 获取FFmpeg配置
            const ffCfg = await getFfmpegTuning();

            // 4. 生成HLS流
            const resolutions = await generateHlsStreams(filePath, hlsOutputDir, rotation, ffCfg);

            // 5. 创建主播放列表
            await createMasterPlaylist(hlsOutputDir, resolutions, filePath);

            // 6. 创建HLS处理记录文件
            const { createHlsRecord } = require('../utils/hls.utils');
            await createHlsRecord(relativePath, {
                resolutions: resolutions.map(r => r.name),
                fileSize: await fs.stat(filePath).then(s => s.size).catch(() => 0),
                processingTime: Date.now() - startTime
            });

            // 7. 清理临时文件
            try {
                const tempFiles = await fs.readdir(processingDir);
                if (tempFiles.length === 0) {
                    await fs.rmdir(processingDir);
                }
            } catch (e) {
                logger.warn(`清理处理目录失败: ${e.message}`);
            }

            return { success: true, path: filePath };

        } catch (error) {
            logger.error(`视频处理失败: ${error.message}`);
            // 清理临时文件
            const processingDir = path.join(thumbsDir, 'temp', relativePath);
            const hlsOutputDir = path.join(thumbsDir, 'hls', relativePath);
            await cleanupTempFiles(processingDir, optimizedPath, hlsOutputDir);
            return { success: false, path: filePath, error: error.message || '未知 ffmpeg 错误' };
        }
    }

    // 将单个任务的处理逻辑封装起来，以便复用
    async function handleTask(task) {
        const { filePath, relativePath, thumbsDir } = task;
        const failureKey = `video_failed_permanently:${filePath}`;

        try {
            const isPermanentlyFailed = await safeRedisGet(redis, failureKey, '检查永久失败标记');
            if (isPermanentlyFailed) {
                logger.warn(`视频已被标记为永久失败，跳过: ${filePath}`);
                parentPort.postMessage(createWorkerResult({
                    type: 'video_task_complete',
                    success: true,
                    path: filePath,
                    status: 'skipped_permanent_failure'
                }));
                return;
            }

            // 使用文件系统检查HLS状态，避免数据库查询
            const { checkHlsExists } = require('../utils/hls.utils');
            const hlsExists = await checkHlsExists(relativePath);

            if (hlsExists) {
                logger.debug(`HLS 流已存在，跳过: ${filePath}`);
                parentPort.postMessage(createWorkerResult({
                    type: 'video_task_complete',
                    success: true,
                    path: filePath,
                    status: 'skipped_hls_exists'
                }));
                return;
            }

            logger.debug(`视频需要处理，开始任务: ${filePath}`);
            const result = await processVideo(filePath, relativePath, thumbsDir);

            if (result.success) {
                logger.info(`成功处理视频: ${filePath}`);
                failureCounts.delete(filePath);

                // 更新 items.hls_ready = 1，使后续查询无需检查文件系统
                try {
                    await runAsync('main', `UPDATE items SET hls_ready = 1 WHERE path = ?`, [relativePath]);
                } catch (dbErr) {
                    logger.debug(`更新 hls_ready 失败（已忽略）: ${dbErr && dbErr.message}`);
                }

                parentPort.postMessage(createWorkerResult({
                    type: 'video_task_complete',
                    ...result,
                    task,
                }));
            } else {
                const currentFailures = (failureCounts.get(filePath) || 0) + 1;
                failureCounts.set(filePath, currentFailures);
                logger.error(`处理失败 (第 ${currentFailures} 次): ${filePath}`, result.error);

                if (currentFailures >= MAX_VIDEO_RETRIES) {
                    logger.error(`视频达到最大重试次数，标记为永久失败: ${filePath}`);
                    await safeRedisSet(redis, failureKey, '1', 'EX', PERMANENT_FAILURE_TTL, '设置永久失败标记');
                    failureCounts.delete(filePath);
                }
                parentPort.postMessage(createWorkerError({
                    type: 'video_task_failed',
                    ...result,
                    task,
                }));
            }
        } catch (e) {
            logger.error(`${LOG_PREFIXES.VIDEO_PROCESSOR} 处理任务时发生致命错误 ${filePath}:`, e);
            parentPort.postMessage(createWorkerError({
                type: 'video_task_failed',
                path: filePath,
                error: e,
                task,
            }));
        }
    }

    // 全局临时文件清理函数 - 清理残留的孤立临时文件
    async function cleanupOrphanedTempFiles() {
        try {
            logger.info(`${LOG_PREFIXES.VIDEO_PROCESSOR} 开始清理残留的临时文件...`);
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
                    logger.debug(`${LOG_PREFIXES.VIDEO_PROCESSOR} 临时目录扫描失败（忽略）: ${dirPath} -> ${e && e.message}`);
                }
            }

            await cleanupDir(PHOTOS_DIR);
            logger.info(`${LOG_PREFIXES.VIDEO_PROCESSOR} 临时文件清理完成，共清理 ${cleanedCount} 个目录`);

        } catch (error) {
            logger.error(`${LOG_PREFIXES.VIDEO_PROCESSOR} 清理临时文件时出错:`, error);
        }
    }

    parentPort.on('message', async (message) => {
        // 提取追踪上下文
        const traceContext = TraceManager.fromWorkerMessage(message);

        // 获取实际任务数据
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
            // 更新活动时间
            updateActivity();

            if (task.type === 'backfill') {
                logger.info(`${LOG_PREFIXES.VIDEO_PROCESSOR} 收到 HLS 回填任务，开始扫描数据库...`);
                try {
                    // 先清理残留的临时文件
                    await cleanupOrphanedTempFiles();

                    const videos = await dbAll('main', `SELECT path FROM items WHERE type = 'video'`);
                    // 允许通过 Redis 自适应开关关闭回填
                    try {
                        const disableBackfill = await safeRedisGet(redis, 'adaptive:disable_hls_backfill', '禁用HLS回填标记');
                        if (disableBackfill === '1') {
                            logger.warn(`${LOG_PREFIXES.VIDEO_PROCESSOR} 自适应模式：已禁用 HLS 回填。本轮跳过。`);
                            return;
                        }
                    } catch (disableCheckErr) {
                        logger.debug(`${LOG_PREFIXES.VIDEO_PROCESSOR} 检查 HLS 回填禁用标记失败（忽略）:`, disableCheckErr && disableCheckErr.message);
                    }
                    logger.info(`发现 ${videos.length} 个视频需要检查 HLS 状态`);
                    for (const video of videos) {
                        // 更新活动时间
                        updateActivity();

                        // 动态中断：运行中若切到 low 档，立即停止后续回填，保护系统
                        try {
                            const stopNow = await safeRedisGet(redis, 'adaptive:disable_hls_backfill', '检查HLS回填停止');
                            if (stopNow === '1') {
                                logger.warn(`${LOG_PREFIXES.VIDEO_PROCESSOR} 自适应模式切换为低负载，已中断剩余回填任务。`);
                                break;
                            }
                        } catch (stopCheckErr) {
                            logger.debug(`${LOG_PREFIXES.VIDEO_PROCESSOR} 检查中止标记失败（忽略）:`, stopCheckErr && stopCheckErr.message);
                        }
                        // 依次处理，避免并发过高，增加处理间隔
                        await handleTask({
                            filePath: path.join(PHOTOS_DIR, video.path),
                            relativePath: video.path,
                            thumbsDir: THUMBS_DIR
                        });

                        // 每个视频处理完后等待，减少系统压力
                        const cpusDelay = Math.max(1, Number(process.env.DETECTED_CPU_COUNT) || ((os.cpus && os.cpus().length) || 1));
                        const la = (os.loadavg && os.loadavg()[0]) || 0;
                        const highLoad = la > cpusDelay * 0.8;
                        const delayMs = highLoad ? Math.max(VIDEO_TASK_DELAY_MS, 2000) : VIDEO_TASK_DELAY_MS;
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                    }
                    logger.info(`${LOG_PREFIXES.VIDEO_PROCESSOR} HLS 回填任务检查完成。`);
                } catch (e) {
                    logger.error(`${LOG_PREFIXES.VIDEO_PROCESSOR} HLS 回填任务失败:`, e);
                }
            } else if (task.type === 'cleanup') {
                // 手动触发清理任务
                await cleanupOrphanedTempFiles();
                parentPort.postMessage(createWorkerResult({
                    type: 'video_cleanup_complete',
                    success: true,
                    message: '临时文件清理完成'
                }));
            } else {
                // 将任务添加到队列而不是直接处理
                taskQueue.push(task);
                logger.debug(`${LOG_PREFIXES.VIDEO_PROCESSOR} 任务已添加到队列，当前队列长度: ${taskQueue.length}`);
                // 异步启动队列处理
                setImmediate(() => processTaskQueue());
            }
        };

        // 在追踪上下文中运行
        if (traceContext) {
            await TraceManager.run(traceContext, processTask);
        } else {
            await processTask();
        }
    });

    // 进程退出时的清理
    process.on('exit', () => {
        if (healthCheckTimer) {
            clearInterval(healthCheckTimer);
        }
        if (idleCheckTimer) {
            clearInterval(idleCheckTimer);
        }
        if (schedulerBackoffTimer) {
            clearTimeout(schedulerBackoffTimer);
        }
        logger.debug(`${LOG_PREFIXES.VIDEO_PROCESSOR} 工作进程退出，清理完成`);
    });

    // 处理未捕获的异常
    process.on('uncaughtException', (error) => {
        logger.error(`${LOG_PREFIXES.VIDEO_PROCESSOR} 未捕获的异常:`, error);
        gracefulShutdown('uncaught_exception');
    });

    process.on('unhandledRejection', (reason, promise) => {
        logger.error(`${LOG_PREFIXES.VIDEO_PROCESSOR} 未处理的Promise拒绝:`, reason);
        gracefulShutdown('unhandled_rejection');
    });

    // 处理系统信号
    process.on('SIGTERM', () => {
        logger.info(`${LOG_PREFIXES.VIDEO_PROCESSOR} 收到SIGTERM信号，开始优雅关闭`);
        gracefulShutdown('sigterm');
    });

    process.on('SIGINT', () => {
        logger.info(`${LOG_PREFIXES.VIDEO_PROCESSOR} 收到SIGINT信号，开始优雅关闭`);
        gracefulShutdown('sigint');
    });
})();