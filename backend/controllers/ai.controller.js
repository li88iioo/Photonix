/**
 * @file ai.controller.js
 * @description
 *   AI 控制器模块（微服务架构版）。
 *   负责处理 AI 相关 HTTP 请求，将 AI 服务整合到主应用进程，
 *   移除独立 Worker、队列及 Redis 强依赖，采用现代微服务和前端缓存优先策略。
 */

const logger = require('../config/logger');
const { isPathSafe, sanitizePath } = require('../utils/path.utils');
const aiMicroservice = require('../services/ai-microservice');

/**
 * @class AiConfigValidator
 * @classdesc 负责统一验证 AI 配置的完整性、有效性，用于控制器各用例。
 */
class AiConfigValidator {
    /**
     * 校验 AI 配置是否字段齐全且字符串有效。
     * @param {object} aiConfig - AI 配置对象
     * @returns {boolean}
     */
    static isValid(aiConfig) {
        return aiConfig &&
            typeof aiConfig.url === 'string' &&
            aiConfig.url.trim() &&
            typeof aiConfig.key === 'string' &&
            aiConfig.key.trim() &&
            typeof aiConfig.model === 'string' &&
            aiConfig.model.trim() &&
            typeof aiConfig.prompt === 'string' &&
            aiConfig.prompt.trim();
    }

    /**
     * 校验 AI 配置有效性，并返回错误原因。
     * @param {object} aiConfig - AI 配置对象
     * @returns {{isValid: boolean, error?: string}}
     */
    static validate(aiConfig) {
        if (!aiConfig) {
            return { isValid: false, error: 'AI配置为空' };
        }

        const requiredFields = ['url', 'key', 'model', 'prompt'];
        for (const field of requiredFields) {
            if (!aiConfig[field] || typeof aiConfig[field] !== 'string' || !aiConfig[field].trim()) {
                return { isValid: false, error: `AI配置缺少或无效: ${field}` };
            }
        }
        return { isValid: true };
    }

    /**
     * 校验 AI 配置并在失败时以 HTTP 400 立即返回错误响应。
     * @param {object} aiConfig - AI 配置对象
     * @param {object} res - Express 响应对象
     * @param {string} requestId - 请求标识
     * @returns {boolean} 通过返回 true，否则返回 false 且已响应
     */
    static validateAndRespond(aiConfig, res, requestId) {
        const validation = this.validate(aiConfig);
        if (!validation.isValid) {
            res.status(400).json({
                code: 'AI_CONFIG_INCOMPLETE',
                message: validation.error,
                requestId: requestId
            });
            return false;
        }
        return true;
    }
}

/**
 * 兼容旧用法的 AI 配置校验导出：validateAiConfig(aiConfig, res, requestId)
 * @param {object} aiConfig
 * @param {object} res
 * @param {string} requestId
 */
function validateAiConfig(aiConfig, res, requestId) {
    return AiConfigValidator.validateAndRespond(aiConfig, res, requestId);
}

/**
 * @function generateCaption
 * @desc
 *   生成图片 AI 标题。直接调用微服务处理 AI 任  务，
 *   彻底消除 Redis 和队列依赖，采用前端缓存优先策略。
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 * @returns {Promise<void>} JSON 响应
 */
exports.generateCaption = async (req, res) => {
    // 步骤1: 参数解析与校验
    const { image_path, aiConfig } = req.body || {};

    if (!aiConfig || !aiConfig.url || !aiConfig.key || !aiConfig.model || !aiConfig.prompt) {
        return res.status(400).json({
            code: 'AI_CONFIG_INCOMPLETE',
            message: 'AI 配置信息不完整',
            requestId: req.requestId
        });
    }
    if (!image_path) {
        return res.status(400).json({
            code: 'MISSING_IMAGE_PATH',
            message: '缺少必要的参数: image_path',
            requestId: req.requestId
        });
    }

    // 步骤2: 路径清理与安全检测
    let cleanPath = image_path.startsWith('/static/') ? image_path.substring(7) : image_path;
    const sanitizedPath = sanitizePath(cleanPath);
    if (!isPathSafe(sanitizedPath)) {
        return res.status(403).json({
            code: 'UNSAFE_IMAGE_PATH',
            message: '不安全的图片路径',
            requestId: req.requestId
        });
    }

    // 步骤3: 提交任务到微服务处理
    try {
        // 构建任务参数
        const task = {
            imagePath: sanitizedPath,
            aiConfig: {
                url: aiConfig.url,
                key: aiConfig.key,
                model: aiConfig.model,
                prompt: aiConfig.prompt
            },
            requestId: req.requestId
        };

        // 使用微服务执行 AI 任务
        const result = await aiMicroservice.processTask(task);

        // 任务成功: 尝试在 Redis 加入冷却锁（如可用）
        try {
            const { redis } = require('../config/redis');
            if (redis && redis.isNoRedis !== true) {
                const crypto = require('crypto');
                const hash = (input) => crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 16);

                const headerUserId = req.headers['x-user-id'] || req.headers['x-userid'] || req.headers['x-user'];
                const userIdRaw = (req.user && req.user.id) || headerUserId || req.ip || 'anonymous';
                const userId = String(userIdRaw);

                const imageSig = hash(sanitizedPath);
                const dedupeKey = `ai_cooldown:${userId}:${imageSig}`;
                // 加冷却锁
                const { safeRedisSet } = require('../utils/helpers');
                const PER_IMAGE_COOLDOWN_SEC = parseInt(process.env.AI_PER_IMAGE_COOLDOWN_SEC || '30', 10);
                await safeRedisSet(redis, dedupeKey, 'success', 'EX', PER_IMAGE_COOLDOWN_SEC, 'AI成功冷却');
            }
        } catch (redisError) {
            logger.debug(`[AI] 成功处理后更新冷却锁失败（忽略）: ${redisError && redisError.message}`);
        }

        // 生成成功响应
        return res.status(200).json({
            description: result.result.caption,
            source: 'generated',
            taskId: result.taskId,
            processedAt: result.processedAt,
            requestId: req.requestId
        });
    } catch (error) {
        // 错误时: 清理 Redis 冷却锁（如有）
        try {
            const { redis } = require('../config/redis');
            if (redis && redis.isNoRedis !== true) {
                const crypto = require('crypto');
                const hash = (input) => crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 16);

                const headerUserId = req.headers['x-user-id'] || req.headers['x-userid'] || req.headers['x-user'];
                const userIdRaw = (req.user && req.user.id) || headerUserId || req.ip || 'anonymous';
                const userId = String(userIdRaw);

                const imageSig = hash(sanitizedPath);
                const dedupeKey = `ai_cooldown:${userId}:${imageSig}`;
                // 删除失败锁
                const { safeRedisDel } = require('../utils/helpers');
                await safeRedisDel(redis, dedupeKey, 'AI失败清锁');
            }
        } catch (redisError) {
            logger.debug(`[AI] 清理冷却锁失败（忽略）: ${redisError && redisError.message}`);
        }

        // 错误响应（根据具体错误赋予合适 HTTP 状态码）
        const errorResponse = {
            code: 'AI_PROCESSING_ERROR',
            message: error.message || 'AI 处理失败',
            requestId: req.requestId,
            timestamp: new Date().toISOString()
        };
        const detailMsg = error?.details?.reason ||
            error?.details?.errorMessage ||
            error?.details?.errorData ||
            error?.details?.message ||
            error?.details?.responseData;
        if (detailMsg && typeof detailMsg === 'string') {
            errorResponse.detail = detailMsg;
            if (!errorResponse.message || !errorResponse.message.includes(detailMsg)) {
                errorResponse.message = `${errorResponse.message}（${detailMsg}）`;
            }
        }

        let statusCode = 502; // 默认：Bad Gateway
        if (error.message && error.message.includes('认证失败')) {
            statusCode = 401;
        } else if (error.message && error.message.includes('请求过于频繁')) {
            statusCode = 429;
        } else if (error.message && error.message.includes('超时')) {
            statusCode = 408;
        } else if (error.message && error.message.includes('图片处理失败')) {
            statusCode = 400;
        }
        return res.status(statusCode).json(errorResponse);
    }
};

/**
 * @function listAvailableModels
 * @desc 获取可用视觉模型列表
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 * @returns {Promise<void>} JSON 响应
 */
exports.listAvailableModels = async (req, res) => {
    const { url, key } = req.body || {};
    if (!url || !key) {
        return res.status(400).json({
            code: 'AI_CONFIG_INCOMPLETE',
            message: '缺少 API URL 或 API Key',
            requestId: req.requestId
        });
    }
    try {
        const models = await aiMicroservice.fetchAvailableModels({ url, key });
        return res.json({ models });
    } catch (error) {
        const status = Number(error?.status || error?.statusCode);
        return res.status(Number.isFinite(status) ? status : 502).json({
            code: 'AI_MODEL_FETCH_FAILED',
            message: error?.message || '获取模型列表失败',
            requestId: req.requestId
        });
    }
};

/**
 * @function getMicroserviceStatus
 * @desc 获取 AI 微服务运行状态和相关统计
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
exports.getMicroserviceStatus = async (req, res) => {
    try {
        const status = aiMicroservice.getStatus();
        res.json({
            status: 'active',
            timestamp: new Date().toISOString(),
            microservice: status,
            version: '2.0.0-microservice',
            requestId: req.requestId
        });
    } catch (error) {
        res.status(500).json({
            error: '获取微服务状态失败',
            message: error.message,
            requestId: req.requestId
        });
    }
};

/**
 * @function getJobStatus
 * @desc 兼容旧版任务状态接口，始终返回完成（前端应缓存优先）
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
exports.getJobStatus = async (req, res) => {
    const { jobId } = req.params;
    // 该接口兼容旧调用，实际不再有队列任务逻辑，仅保证前端兼容与提示
    res.json({
        jobId,
        state: 'completed',
        result: {
            success: true,
            caption: '任务已通过新的微服务架构处理完成'
        },
        failedReason: null,
        message: 'AI微服务架构已重构，请使用前端缓存功能'
    });
};
