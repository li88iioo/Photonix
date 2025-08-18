/**
 * AI控制器模块
 * 处理AI相关的请求，包括图片标题生成和任务状态查询
 */
const logger = require('../config/logger');
const { aiCaptionQueue, redis } = require('../config/redis');
const { isPathSafe, sanitizePath } = require('../utils/path.utils');
const settingsService = require('../services/settings.service'); // <-- 新增：引入设置服务

/**
 * 生成图片AI标题
 * 接收前端AI配置，验证参数，检查缓存，创建或查找任务队列
 * @param {Object} req - Express请求对象
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应，包含任务ID或错误信息
 */
exports.generateCaption = async (req, res) => {
        // 1. 从前端获取 AI 配置（已由 Joi 校验保证完整性与基本合法性）
        const { image_path, aiConfig } = req.body;
        
        // 验证AI配置的完整性（再次防御，避免日志中出现敏感信息）
        if (!aiConfig || !aiConfig.url || !aiConfig.key || !aiConfig.model || !aiConfig.prompt) {
            return res.status(400).json({ code: 'AI_CONFIG_INCOMPLETE', message: 'AI 配置信息不完整', requestId: req.requestId });
        }
        
        // 2. 检查 AI 功能开关（可选：如需强制开关可加）
        // if (aiConfig.enabled !== 'true') {
        //     return res.status(503).json({ error: 'AI 功能已被禁用' });
        // }
        
        // 验证图片路径参数
        if (!image_path) {
            return res.status(400).json({ code: 'MISSING_IMAGE_PATH', message: '缺少必要的参数: image_path', requestId: req.requestId });
        }
        
        // 清理和验证图片路径
        let cleanPath = image_path.startsWith('/static/') ? image_path.substring(7) : image_path;
        const sanitizedPath = sanitizePath(cleanPath);
        if (!isPathSafe(sanitizedPath)) {
            return res.status(403).json({ code: 'UNSAFE_IMAGE_PATH', message: '不安全的图片路径', requestId: req.requestId });
        }
        
        // 检查Redis缓存中是否已有该图片的描述
        const cacheKey = `ai_description:${sanitizedPath}`;
        const cachedDescription = await redis.get(cacheKey);
        if (cachedDescription) {
            logger.info(`从 Redis 缓存获取图片描述: ${sanitizedPath}`);
            return res.json({ description: cachedDescription, source: 'cache' });
        }
        
        // 检查是否已有相同图片的AI任务正在处理中
        const jobTypes = ['active', 'waiting', 'delayed'];
        let existingJob = null;
        for (const type of jobTypes) {
            const jobs = await aiCaptionQueue.getJobs([type]);
            existingJob = jobs.find(j => j.data && j.data.imagePath === sanitizedPath);
            if (existingJob) break;
        }
        
        // 如果发现已有任务，直接返回任务ID
        if (existingJob) {
            logger.info(`发现已有未完成的AI任务，直接返回 jobId`);
            return res.status(202).json({
                message: 'AI caption generation already in progress.',
                jobId: existingJob.id,
                requestId: req.requestId
            });
        }
        
        // 3. 传递前端传来的 AI 配置，创建新的AI任务
        const job = await aiCaptionQueue.add('generate-caption', {
            imagePath: sanitizedPath,
            aiConfig: {
                url: aiConfig.url,
                key: aiConfig.key,
                model: aiConfig.model,
                prompt: aiConfig.prompt
            }
        });
        
        // 返回任务已加入队列的响应
        res.status(202).json({
            message: 'AI caption generation has been queued.',
            jobId: job.id,
        });
};

/**
 * 获取AI任务状态
 * 查询指定任务ID的状态，如果任务完成则将结果缓存到Redis
 * @param {Object} req - Express请求对象，包含jobId参数
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应，包含任务状态、结果或错误信息
 */
exports.getJobStatus = async (req, res) => {
        const { jobId } = req.params;
        
        // 根据任务ID获取任务对象
        const job = await aiCaptionQueue.getJob(jobId);

        // 检查任务是否存在
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        // 获取任务状态和相关信息
        const state = await job.getState();
        const result = job.returnvalue;
        const failedReason = job.failedReason;

        // 如果任务完成且成功，将结果缓存到Redis
        if (state === 'completed' && result?.success) {
            const imagePath = job.data.imagePath;
            const cacheKey = `ai_description:${imagePath}`;
            // 缓存结果，过期时间设置为7天
            await redis.set(cacheKey, result.caption, 'EX', 3600 * 24 * 7);
            logger.info(`任务 #${jobId} 结果已写入缓存。`);
        }

        // 返回任务状态信息
        res.json({ jobId, state, result, failedReason });
};