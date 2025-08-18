const { Worker } = require('bullmq');
const Redis = require('ioredis');
const axios = require('axios');
const path = require('path');
const winston = require('winston');
const axiosRetry = require('axios-retry');
const fs = require('fs');
const sharp = require('sharp');

// --- 日志配置 ---
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.printf(info => `[${info.timestamp}] [AI-WORKER] ${info.level}: ${info.message}`)),
    transports: [new winston.transports.Console()]
});

// --- Redis 连接配置 ---
const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null // BullMQ 推荐配置
});

// --- 内部回环地址（单容器合并部署） ---
const { PORT, PHOTOS_DIR } = require('../config');
const BACKEND_INTERNAL_URL = `http://localhost:${PORT}`;

// --- AI 调用逻辑 ---
const aiAxios = axios.create({
    timeout: 30000,
    maxRedirects: 5,
    // 连接池优化
    httpAgent: new (require('http').Agent)({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 10,
        maxFreeSockets: 5
    }),
    httpsAgent: new (require('https').Agent)({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 10,
        maxFreeSockets: 5
    })
});

axiosRetry(aiAxios, {
    retries: 3,
    retryDelay: (retryCount, error) => {
        logger.warn(`AI服务请求失败 (状态: ${error.response?.status})，第 ${retryCount} 次重试...`);
        return retryCount * 2000;
    },
    retryCondition: (error) => {
    const status = error && error.response ? error.response.status : undefined;
    return (
      axiosRetry.isNetworkOrIdempotentRequestError(error) ||
      status === 429 ||
      status === 408 ||
      (typeof status === 'number' && status >= 500)
    );
    },
});

// 图片处理缓存 - 修复内存泄漏问题
class LRUCache {
    constructor(maxSize = 50, maxBytes = 268435456) { // 默认 256MB 上限
        this.maxSize = maxSize;
        this.maxBytes = Number.isFinite(maxBytes) ? maxBytes : 268435456;
        this.cache = new Map();
        this.accessOrder = []; // 记录访问顺序
        this.totalBytes = 0;   // 当前缓存的总字节数
    }

    has(key) {
        return this.cache.has(key);
    }

    get(key) {
        if (this.cache.has(key)) {
            // 更新访问顺序
            this.updateAccessOrder(key);
            return this.cache.get(key);
        }
        return null;
    }

    set(key, value) {
        // 如果已存在，先删除旧的
        if (this.cache.has(key)) {
            const old = this.cache.get(key);
            const oldBytes = Buffer.isBuffer(old) ? old.byteLength : 0;
            this.cache.delete(key);
            this.totalBytes = Math.max(0, this.totalBytes - oldBytes);
            this.removeFromAccessOrder(key);
        }

        // 如果达到最大大小，删除最久未使用的项
        while (this.cache.size >= this.maxSize) this.evictOldest();

        // 添加新项
        this.cache.set(key, value);
        this.accessOrder.push(key);
        const bytes = Buffer.isBuffer(value) ? value.byteLength : 0;
        this.totalBytes += bytes;

        // 若超出总字节上限，持续淘汰最久未使用项
        while (this.totalBytes > this.maxBytes && this.accessOrder.length > 0) {
            this.evictOldest();
        }
    }

    delete(key) {
        if (this.cache.has(key)) {
            const val = this.cache.get(key);
            const bytes = Buffer.isBuffer(val) ? val.byteLength : 0;
            this.cache.delete(key);
            this.totalBytes = Math.max(0, this.totalBytes - bytes);
            this.removeFromAccessOrder(key);
        }
    }

    clear() {
        this.cache.clear();
        this.accessOrder = [];
        this.totalBytes = 0;
    }

    size() {
        return this.cache.size;
    }

    // 更新访问顺序
    updateAccessOrder(key) {
        this.removeFromAccessOrder(key);
        this.accessOrder.push(key);
    }

    // 从访问顺序中移除
    removeFromAccessOrder(key) {
        const index = this.accessOrder.indexOf(key);
        if (index > -1) {
            this.accessOrder.splice(index, 1);
        }
    }

    // 删除最久未使用的项
    evictOldest() {
        if (this.accessOrder.length > 0) {
            const oldestKey = this.accessOrder.shift();
            const val = this.cache.get(oldestKey);
            const bytes = Buffer.isBuffer(val) ? val.byteLength : 0;
            this.cache.delete(oldestKey);
            this.totalBytes = Math.max(0, this.totalBytes - bytes);
            logger.debug(`LRU缓存清理: 删除最久未使用的缓存项: ${oldestKey}`);
        }
    }

    // 获取缓存统计信息
    getStats() {
        return {
            entries: this.cache.size,
            maxEntries: this.maxSize,
            bytes: this.totalBytes,
            maxBytes: this.maxBytes,
            usageByEntries: Math.round((this.cache.size / this.maxSize) * 100),
            usageByBytes: Math.round((this.totalBytes / this.maxBytes) * 100)
        };
    }
}

// 创建LRU缓存实例
const imageCache = new LRUCache(50, parseInt(process.env.AI_CACHE_MAX_BYTES || '268435456', 10));

// 定期清理缓存（每10分钟检查一次）
const CACHE_CLEANUP_INTERVAL = 10 * 60 * 1000; // 10分钟
setInterval(() => {
    const stats = imageCache.getStats();
    if (stats.usageByBytes > 80 || stats.usageByEntries > 80) {
        logger.info(`缓存使用率较高 (entries: ${stats.usageByEntries}%, bytes: ${stats.usageByBytes}%)，执行清理...`);
        // 目标：将字节占用降至 60%
        const targetBytes = Math.floor(stats.maxBytes * 0.6);
        while (imageCache.totalBytes > targetBytes && imageCache.accessOrder.length > 0) {
            imageCache.evictOldest();
        }
        logger.info(`缓存清理完成，当前占用: ${(imageCache.totalBytes / stats.maxBytes * 100).toFixed(0)}%`);
    }
}, CACHE_CLEANUP_INTERVAL);

// 进程退出/异常时清理缓存，避免驻留的大 Buffer 延迟回收
const safeClearCache = () => {
    try { imageCache.clear(); } catch {}
};
process.on('beforeExit', safeClearCache);
process.on('SIGTERM', safeClearCache);
process.on('SIGINT', safeClearCache);
process.on('uncaughtException', () => { try { safeClearCache(); } catch {} });

/**
 * 核心处理函数：接收一个任务，调用AI，并返回结果
 * @param {string} relativeImagePath - 图片相对于照片根目录的路径
 * @param {object} aiConfig - 从数据库读取的AI配置
 * @returns {Promise<string>} - 返回AI生成的描述
 */
async function generateCaptionForImage(relativeImagePath, aiConfig) {
    if (!aiConfig || !aiConfig.url || !aiConfig.key) {
        throw new Error('AI 服务配置不完整或未提供');
    }

    const imageAbsPath = path.join(PHOTOS_DIR, relativeImagePath);
    
    // 检查图片处理缓存
    const cacheKey = `${imageAbsPath}_1024_70`;
    let imageBuffer;
    
    if (imageCache.has(cacheKey)) {
        imageBuffer = imageCache.get(cacheKey);
        logger.debug(`使用缓存的图片处理结果: ${relativeImagePath}`);
    } else {
        // 所有模型都压缩图片并转 base64
        try {
            imageBuffer = await sharp(imageAbsPath, { limitInputPixels: Number(process.env.SHARP_MAX_PIXELS || (24000 * 24000)) })
                .resize({ width: 1024 }) // 最大宽度 1024px
                .jpeg({ quality: 70 })   // JPEG 质量 70
                .toBuffer();
            
            // 使用LRU缓存存储处理结果
            imageCache.set(cacheKey, imageBuffer);
        const stats = imageCache.getStats();
        logger.debug(`图片处理结果已缓存: ${relativeImagePath} (entries: ${stats.entries}, bytes: ${stats.bytes})`);
        } catch (e) {
            throw new Error('图片压缩失败: ' + imageAbsPath);
        }
    }
    
    const base64Image = imageBuffer.toString('base64');

    // --- FIX: 使用标准的 OpenAI 兼容格式 ---
    const payload = {
        model: aiConfig.model,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: aiConfig.prompt },
                { 
                    type: 'image_url', 
                    image_url: {
                        "url": `data:image/jpeg;base64,${base64Image}`
                    }
                }
            ]
        }],
        max_tokens: 300
    };

    const fullApiUrl = new URL('/v1/chat/completions', aiConfig.url).toString();
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiConfig.key}` };

    try {
        const aiResponse = await aiAxios.post(fullApiUrl, payload, { headers, timeout: 30000 });
        const description = aiResponse.data.choices?.[0]?.message?.content;

        if (!description) {
            throw new Error('AI 未能生成有效内容');
        }
        return description.trim();
    } catch (error) {
        // 清理缓存中的失败项
        if (imageCache.has(cacheKey)) {
            imageCache.delete(cacheKey);
            logger.debug(`清理失败的缓存项: ${cacheKey}`);
        }
        // 日志脱敏：不打 key，不打印完整 URL
        if (error && error.config) {
            delete error.config.headers;
            delete error.config.data;
            delete error.config.params;
        }
        
        if (error.response) {
            const status = error.response.status;
            const errorData = error.response.data?.error?.message || '无详细错误信息';
            
            // 根据错误类型提供更具体的错误信息
            if (status === 401) {
                throw new Error('AI服务认证失败，请检查API密钥');
            } else if (status === 429) {
                throw new Error('AI服务请求频率过高，请稍后重试');
            } else if (status >= 500) {
                throw new Error(`AI服务内部错误 (${status}): ${errorData}`);
            } else {
                throw new Error(`AI服务返回错误 (状态码: ${status}): ${errorData}`);
            }
        } else if (error.request) {
            throw new Error('无法连接到AI服务，请检查网络或AI URL配置');
        } else {
            throw new Error(`调用AI服务时发生未知错误: ${error.message}`);
        }
    }
}

const worker = new Worker('ai-caption-queue', async job => {
    // 从 job.data 中获取图片路径和 AI 配置
    const { imagePath, aiConfig } = job.data;
    logger.info(`开始处理AI任务 #${job.id}，图片: ${imagePath}`);

    try {
        const caption = await generateCaptionForImage(imagePath, aiConfig);
        logger.info(`成功处理AI任务 #${job.id}，图片: ${imagePath}`);
        return { success: true, caption: caption };
    } catch (error) {
        logger.error(`AI任务 #${job.id} 处理失败: ${error.message}`);
        throw error;
    }
}, { connection: redisConnection });

logger.info('AI Worker 已启动，正在等待任务...');

// 定期输出缓存统计信息（每30分钟，且仅在有缓存内容时）
setInterval(() => {
    const stats = imageCache.getStats();
    if (stats.size > 0) {
        logger.info(`AI Worker 缓存统计: ${stats.size}/${stats.maxSize} (${stats.usage}% 使用率)`);
    }
}, 30 * 60 * 1000);

worker.on('completed', (job, result) => {
    logger.info(`任务 #${job.id} 已完成。结果: ${result.caption.substring(0, 30)}...`);
});

worker.on('failed', (job, err) => {
    logger.error(`任务 #${job.id} 最终失败。错误: ${err.message}`);
});