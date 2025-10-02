/**
 * AI控制器模块 - 微服务架构重构版
 * 处理AI相关的请求，整合到主应用进程，消除独立Worker依赖
 */
const logger = require('../config/logger');
const { isPathSafe, sanitizePath } = require('../utils/path.utils');
const aiMicroservice = require('../services/ai-microservice');

/**
 * AI配置验证器
 * 统一验证AI配置的完整性
 */
class AiConfigValidator {
    /**
     * 验证AI配置是否完整
     * @param {Object} aiConfig - AI配置对象
     * @returns {boolean} 配置是否有效
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
     * 验证AI配置并返回错误信息
     * @param {Object} aiConfig - AI配置对象
     * @returns {Object} 验证结果 {isValid: boolean, error?: string}
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
     * 验证AI配置并抛出异常（用于需要立即返回错误响应的场景）
     * @param {Object} aiConfig - AI配置对象
     * @param {Object} res - Express响应对象
     * @param {string} requestId - 请求ID
     * @returns {boolean} 验证通过返回true，否则发送错误响应并返回false
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

// 兼容旧用法
function validateAiConfig(aiConfig, res, requestId) {
    return AiConfigValidator.validateAndRespond(aiConfig, res, requestId);
}

/**
 * 生成图片AI标题 - 微服务架构重构版
 * 直接使用微服务模块处理AI任务，消除Redis和队列依赖
 * 实现前端缓存优先的处理策略
 * @param {Object} req - Express请求对象
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应
 */
exports.generateCaption = async (req, res) => {
  // 1) 解析与校验
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

  // 2) 路径清理与安全检查
  let cleanPath = image_path.startsWith('/static/') ? image_path.substring(7) : image_path;
  const sanitizedPath = sanitizePath(cleanPath);
  if (!isPathSafe(sanitizedPath)) {
    return res.status(403).json({
      code: 'UNSAFE_IMAGE_PATH',
      message: '不安全的图片路径',
      requestId: req.requestId
    });
  }

  // 3) 提交任务到微服务处理
  try {

    // 创建任务对象
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

    // 提交到微服务处理（异步）
    const result = await aiMicroservice.processTask(task);


    // 🎯 成功生成后，更新Redis锁状态为'success'
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

        // 将锁状态更新为'success'，设置较长的冷却时间
        const PER_IMAGE_COOLDOWN_SEC = parseInt(process.env.AI_PER_IMAGE_COOLDOWN_SEC || '30', 10);
        await redis.set(dedupeKey, 'success', 'EX', PER_IMAGE_COOLDOWN_SEC);

      }
    } catch (redisError) {
      // Redis错误不影响主要功能
    }

    // 返回处理结果
    return res.status(200).json({
      description: result.result.caption,
      source: 'generated',
      taskId: result.taskId,
      processedAt: result.processedAt,
      requestId: req.requestId
    });

  } catch (error) {

    // 🎯 处理失败时，清除Redis锁（如果存在）
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

        // 清除失败的锁
        await redis.del(dedupeKey);
      }
    } catch (redisError) {
      // Redis错误不影响错误响应
    }

    // 错误响应 - 确保返回有效的JSON格式
    const errorResponse = {
      code: 'AI_PROCESSING_ERROR',
      message: error.message || 'AI 处理失败',
      requestId: req.requestId,
      timestamp: new Date().toISOString()
    };

    // 根据错误类型返回适当的HTTP状态码
    let statusCode = 502; // 默认502 Bad Gateway
    if (error.message && error.message.includes('认证失败')) {
      statusCode = 401;
    } else if (error.message && error.message.includes('请求过于频繁')) {
      statusCode = 429;
    } else if (error.message && error.message.includes('超时')) {
      statusCode = 408;
    } else if (error.message && error.message.includes('图片处理失败')) {
      statusCode = 400; // Bad Request for image processing errors
    }

    return res.status(statusCode).json(errorResponse);
  }
};

/**
 * 获取可用的视觉模型列表
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
 * 获取AI微服务状态 - 新的状态查询接口
 * 提供微服务运行状态和统计信息
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
 * 兼容性接口 - 保留旧的job状态查询
 * 返回模拟的任务完成状态以保持前端兼容性
 */
exports.getJobStatus = async (req, res) => {
  const { jobId } = req.params;

  // 对于旧的jobId，统一返回完成状态以保持兼容性
  // 前端现在应该使用缓存优先策略，不再依赖轮询
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