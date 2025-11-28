/**
 * AI微服务模块
 * 整合AI功能到主应用进程，消除独立Worker依赖
 * 实现前端缓存优先的智能处理引擎
 */

const path = require('path');
const axios = require('axios');
const axiosRetry = require('axios-retry');
const sharp = require('sharp');
const { PHOTOS_DIR } = require('../config');
const logger = require('../config/logger');
const {
    getVisionModelMeta,
    isVisionModelWhitelisted,
    normalizeVisionModelId,
    VISION_MODEL_KEYWORDS
} = require('../config/vision-models');

const GEMINI_HOST_PATTERN = /generativelanguage\.googleapis\.com$/i;
const VISION_PROBE_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
const VISION_PROBE_PROMPT = '请快速确认你能看到这张图片，并返回一个词。';
const MODEL_KEYWORD_HEURISTICS = Array.from(new Set([
    'vision',
    'image',
    'omni',
    'flash',
    'gpt-4o',
    'gpt-4.1',
    'gpt-4-turbo',
    'photography',
    'multimodal',
    ...VISION_MODEL_KEYWORDS
]));

function extractTextFromStructuredContent(content, depth = 0) {
    if (!content || depth > 5) return null;
    if (typeof content === 'string') {
        return content.trim() ? content : null;
    }
    if (Array.isArray(content)) {
        for (const item of content) {
            const result = extractTextFromStructuredContent(item, depth + 1);
            if (result) return result;
        }
        return null;
    }
    if (typeof content === 'object') {
        if (typeof content.text === 'string' && content.text.trim()) {
            return content.text;
        }
        if (typeof content.content === 'string' && content.content.trim()) {
            return content.content;
        }
        if (typeof content.value === 'string' && content.value.trim()) {
            return content.value;
        }
        for (const key of Object.keys(content)) {
            const result = extractTextFromStructuredContent(content[key], depth + 1);
            if (result) return result;
        }
    }
    return null;
}

function enrichModelMetadata(id, fallbackDisplay = '', fallbackDescription = '') {
    const meta = getVisionModelMeta(id);
    return {
        id,
        displayName: meta?.label || fallbackDisplay || id,
        description: meta?.description || fallbackDescription || '',
        provider: meta?.provider || '',
        capabilities: Array.isArray(meta?.capabilities) ? [...meta.capabilities] : []
    };
}

function normalizeBaseUrl(rawUrl = '') {
    const trimmed = rawUrl.trim();
    if (!trimmed) return trimmed;
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function hasVersionSegment(pathname = '') {
    return /\/v\d+[a-z]*\/?$/i.test(pathname.trim());
}

function buildOpenAIEndpoint(baseUrl, resourcePath) {
    // 兼容前端已存完整聊天端点（如 /v1/chat/completions 或 /chat/completions）
    try {
        const urlObj = new URL(baseUrl);
        const pathname = urlObj.pathname.replace(/\/+$/, '');

        // 如果 baseUrl 已经是聊天端点，则回退到版本根用于构造其他资源（如 models）
        if (/\/chat\/completions$/i.test(pathname)) {
            // 提取版本段（如 /v1），否则为空
            const match = pathname.match(/\/(v\d+[a-z]*)\b/i);
            const versionSeg = match ? `/${match[1]}/` : '/';
            const root = new URL(versionSeg, urlObj.origin).toString();
            const normalizedRoot = normalizeBaseUrl(root);
            return new URL(resourcePath, normalizedRoot).toString();
        }

        // 常规构造：若未包含版本段，则补 v1/
        const normalized = normalizeBaseUrl(baseUrl);
        let endpointPath = resourcePath;
        const hasVer = hasVersionSegment(new URL(normalized).pathname);
        if (!hasVer) {
            endpointPath = `v1/${resourcePath}`;
        }
        return new URL(endpointPath, normalized).toString();
    } catch (openaiEndpointErr) {
        const normalized = normalizeBaseUrl(baseUrl);
        logger.debug('[AI-MICROSERVICE] 构建 OpenAI 端点失败，使用回退路径:', openaiEndpointErr && openaiEndpointErr.message);
        return `${normalized}${resourcePath}`;
    }
}

function hasGeminiVersionSegment(pathname = '') {
    return /\/v\d+[a-z]*\/?$/i.test(pathname.trim());
}

function buildGeminiEndpoint(baseUrl, resourcePath) {
    const normalized = normalizeBaseUrl(baseUrl);
    let endpointPath = resourcePath;
    try {
        const urlObj = new URL(normalized);
        if (!hasGeminiVersionSegment(urlObj.pathname)) {
            endpointPath = `v1beta/${resourcePath}`;
        }
        return new URL(endpointPath, normalized).toString();
    } catch (geminiEndpointErr) {
        logger.debug('[AI-MICROSERVICE] 构建 Gemini 端点失败，使用回退路径:', geminiEndpointErr && geminiEndpointErr.message);
        return `${normalized}${endpointPath}`;
    }
}

function normalizeGeminiModelId(modelId = '') {
    if (!modelId) return '';
    return modelId.startsWith('models/') ? modelId : `models/${modelId}`;
}

function isGeminiEndpoint(url = '') {
    try {
        const parsed = new URL(url);
        return GEMINI_HOST_PATTERN.test(parsed.hostname);
    } catch (endpointCheckErr) {
        logger.debug('[AI-MICROSERVICE] 解析 Endpoint 失败，按非 Gemini 处理:', endpointCheckErr && endpointCheckErr.message);
        return false;
    }
}

function hasMetadataVisionCapability(modelId) {
    const meta = getVisionModelMeta(modelId);
    return Array.isArray(meta?.capabilities) && meta.capabilities.includes('vision');
}

function computeVisionHeuristicScore(model) {
    if (!model) return 0;
    let score = 0;
    const normalizedId = normalizeVisionModelId(model.id || model.name);
    if (!normalizedId) return 0;

    if (model.capabilities && model.capabilities.vision === true) {
        score += 3;
    }

    const modalityFields = [model.modalities, model.supportedModalities, model.supported_input_modalities, model.supportedInputModalities];
    for (const field of modalityFields) {
        if (Array.isArray(field) && field.some(mod => typeof mod === 'string' && mod.toLowerCase().includes('image'))) {
            score += 3;
            break;
        }
    }

    const description = String(model.description || model.owned_by || '').toLowerCase();
    if (description.includes('vision') || description.includes('image')) {
        score += 1;
    }

    if (MODEL_KEYWORD_HEURISTICS.some(token => normalizedId.includes(token))) {
        score += 1;
    }

    return score;
}

function isLikelyVisionModel(model) {
    if (!model) return false;
    const rawId = model.id || model.name;
    if (!rawId) return false;
    if (hasMetadataVisionCapability(rawId)) return true;
    const score = computeVisionHeuristicScore(model);
    return score >= 2;
}

function isGeminiVisionModel(model) {
    if (!model) return false;
    const rawId = model.name || model.id;
    if (!rawId) return false;
    if (hasMetadataVisionCapability(rawId)) return true;
    const score = computeVisionHeuristicScore(model);
    return score >= 2;
}

// 微服务状态管理
class AIMicroservice {
    constructor() {
        this.activeTasks = new Map(); // 活跃任务跟踪
        this.taskQueue = []; // 任务队列
        // 🔧 平衡修复：降低队列限制，防止内存堆积（可通过环境变量调整）
        this.queueLimit = Number(process.env.AI_QUEUE_MAX || 15); // 平衡值：15
        this.queueTimeoutMs = Number(process.env.AI_QUEUE_TIMEOUT_MS || 45000); // 平衡值：45秒
        this.taskTimeoutMs = Number(process.env.AI_TASK_TIMEOUT_MS || 90000); // 平衡值：90秒
        this.maxConcurrent = this.resolveInitialConcurrency();
        this.isProcessing = false; // 处理状态
        this.initializeAxios();
        this.enableVisionProbe = process.env.AI_ENABLE_VISION_PROBE === 'true';
        this.visionProbeCache = new Map();
    }

    resolveInitialConcurrency() {
        const configured = Number(process.env.AI_MAX_CONCURRENT || process.env.AI_CONCURRENCY);
        if (Number.isFinite(configured) && configured > 0) {
            // 🔧 平衡修复：最大并发限制到3（保证安全性）
            return Math.min(3, Math.max(1, Math.floor(configured)));
        }

        try {
            const { hasResourceBudget } = require('./adaptive.service');
            const budget = hasResourceBudget();
            if (budget && budget.loadOk && budget.memOk) {
                const suggested = Math.max(1, Math.ceil(budget.cpus / 2));
                // 🔧 平衡修复：根据资源预算动态调整（最多3个）
                return Math.min(3, suggested);
            }
        } catch (budgetErr) {
            logger.debug('[AI-MICROSERVICE] 读取资源预算失败，使用默认并发:', budgetErr && budgetErr.message);
        }

        // 🔧 平衡修复：默认并发2（平衡性能和安全）
        return 2;
    }

    /**
     * 初始化HTTP客户端
     */
    initializeAxios() {
        // 复用现有连接池配置
        this.aiAxios = axios.create({
            timeout: 30000,
            maxRedirects: 5,
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

        // 配置重试机制
        axiosRetry(this.aiAxios, {
            retries: 3,
            retryDelay: (retryCount, error) => {
                return retryCount * 2000;
            },
            retryCondition: (error) => {
                const status = error && error.response ? error.response.status : undefined;
                return (
                    axiosRetry.isNetworkOrIdempotentRequestError(error) ||
                    status === 429 || status === 408 || (typeof status === 'number' && status >= 500)
                );
            },
        });
    }

    /**
     * 智能任务调度
     * @param {Object} task - 任务对象
     * @returns {Promise<Object>} 处理结果
     */
    async processTask(task) {
        const { imagePath, aiConfig } = task;

        // 生成任务唯一标识
        const taskId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const taskKey = `${taskId}::${imagePath}`;

        // 检查并发限制
        if (this.activeTasks.size >= this.maxConcurrent) {
            if (this.taskQueue.length >= this.queueLimit) {
                const error = new Error('AI服务当前繁忙，请稍后重试');
                error.code = 'AI_QUEUE_FULL';
                throw error;
            }

            return new Promise((resolve, reject) => {
                const queuedAt = Date.now();
                const entry = { task, resolve: undefined, reject: undefined, queuedAt };
                const timeoutId = setTimeout(() => {
                    const index = this.taskQueue.indexOf(entry);
                    if (index !== -1) {
                        this.taskQueue.splice(index, 1);
                    }
                    reject(new Error('AI任务排队超时，请稍后重试'));
                }, this.queueTimeoutMs);

                entry.resolve = (value) => {
                    clearTimeout(timeoutId);
                    resolve(value);
                };
                entry.reject = (reason) => {
                    clearTimeout(timeoutId);
                    reject(reason);
                };

                this.taskQueue.push(entry);
            });
        }

        // 开始处理任务
        const abortController = new AbortController();
        const timeoutTimer = setTimeout(() => {
            try { abortController.abort(); } catch (e) { logger.debug(`操作失败: ${e.message}`); }
        }, this.taskTimeoutMs);
        this.activeTasks.set(taskKey, { taskId, startTime: Date.now(), abortController, timeoutTimer });

        try {
            const result = await this.executeTask(task, abortController);
            this.activeTasks.delete(taskKey);
            clearTimeout(timeoutTimer);

            // 处理队列中的下一个任务
            this.processNextQueuedTask();

            return {
                success: true,
                taskId,
                result: result,
                processedAt: new Date().toISOString()
            };
        } catch (error) {
            this.activeTasks.delete(taskKey);
            clearTimeout(timeoutTimer);
            this.processNextQueuedTask();

            throw error;
        }
    }

    /**
     * 执行单个AI任务
     * @param {Object} task - 任务对象
     * @returns {Promise<Object>} AI处理结果
     */
    async executeTask(task, abortController) {
        const { imagePath, aiConfig } = task;
        let imageBuffer = null;

        try {
            // 图片路径验证和处理
            const fullImagePath = path.join(PHOTOS_DIR, imagePath);
            imageBuffer = await this.processImage(fullImagePath, abortController);

            // 调用AI API
            const caption = await this.callAIApi(imageBuffer, aiConfig, abortController);

            return {
                imagePath,
                caption,
                generatedAt: new Date().toISOString(),
                config: {
                    model: aiConfig.model,
                    promptLength: aiConfig.prompt.length
                }
            };
        } finally {
            // 🔧 紧急修复：立即释放buffer内存
            imageBuffer = null;
            
            // 🔧 紧急修复：每10个任务触发一次垃圾回收
            if (global.gc && this.activeTasks.size % 10 === 0) {
                try {
                    global.gc();
                } catch (gcErr) {
                    // 忽略GC错误
                }
            }
        }
    }

    /**
     * 图片预处理
     * @param {string} imagePath - 图片路径
     * @returns {Promise<Buffer>} 处理后的图片缓冲区
     */
    async processImage(imagePath, abortController) {
        try {
            // 🔧 平衡修复：限制最大像素，防止内存爆炸（可通过SHARP_MAX_PIXELS环境变量调整）
            const transformer = sharp(imagePath, {
                limitInputPixels: Number(process.env.SHARP_MAX_PIXELS || (6400 * 6400)) // 40M像素（平衡值）
            }).resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 70 });

            let abortListener;
            if (abortController) {
                const signal = abortController.signal;
                const abortError = () => {
                    try {
                        transformer.destroy(new Error('AI_TASK_ABORTED'));
                    } catch (destroyErr) {
                        logger.debug('[AI-MICROSERVICE] 取消任务时销毁转换器失败（忽略）:', destroyErr && destroyErr.message);
                    }
                };

                if (signal.aborted) {
                    abortError();
                } else {
                    abortListener = abortError;
                    signal.addEventListener('abort', abortListener, { once: true });
                }
            }

            try {
                const buffer = await transformer.toBuffer();
                return buffer;
            } finally {
                // 🔧 紧急修复：确保 Sharp 资源被释放
                if (abortController && abortListener) {
                    abortController.signal.removeEventListener('abort', abortListener);
                }
                try {
                    transformer.destroy();
                } catch (destroyErr) {
                    // 忽略销毁错误
                }
            }
        } catch (error) {
            if (error && error.message && error.message.includes('AI_TASK_ABORTED')) {
                const { BusinessLogicError } = require('../utils/errors');
                throw new BusinessLogicError('AI任务已取消', 'AI_TASK_ABORTED');
            }
            logger.error(`[AI微服务] 图片处理失败: ${imagePath}, 错误: ${error.message}`);
            const { FileSystemError } = require('../utils/errors');
            throw new FileSystemError(`图片处理失败: ${path.basename(imagePath)}`, { path: imagePath, originalError: error.message });
        }
    }

    /**
     * 调用AI API
     * @param {Buffer} imageBuffer - 图片缓冲区
     * @param {Object} aiConfig - AI配置
     * @returns {Promise<string>} 生成的描述
     */
    async callAIApi(imageBuffer, aiConfig, abortController) {
        if (isGeminiEndpoint(aiConfig.url)) {
            return this.callGeminiApi(imageBuffer, aiConfig, abortController);
        }
        return this.callOpenAIApi(imageBuffer, aiConfig, abortController);
    }

    async callOpenAIApi(imageBuffer, aiConfig, abortController) {
        const base64Image = imageBuffer.toString('base64');
        const payload = {
            model: aiConfig.model,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: aiConfig.prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                ]
            }],
            max_tokens: 300
        };

        const endpoint = buildOpenAIEndpoint(aiConfig.url, 'chat/completions');
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${aiConfig.key}`
        };

        try {
            const response = await this.aiAxios.post(endpoint, payload, {
                headers,
                timeout: this.taskTimeoutMs,
                signal: abortController.signal
            });

            const data = response.data;
            let description = null;

            if (data && Array.isArray(data.choices) && data.choices.length > 0) {
                const choice = data.choices[0];
                if (choice.message && typeof choice.message.content === 'string') {
                    description = choice.message.content;
                } else if (choice.message && Array.isArray(choice.message.content)) {
                    description = extractTextFromStructuredContent(choice.message.content);
                } else if (typeof choice.text === 'string') {
                    description = choice.text;
                } else if (choice.delta && typeof choice.delta.content === 'string') {
                    description = choice.delta.content;
                } else if (choice.message && typeof choice.message === 'object') {
                    description = extractTextFromStructuredContent(choice.message);
                }
            }

            // 兼容部分 OpenAI 接口返回 Gemini 风格结构（candidates/parts）
            if (!description && Array.isArray(data?.candidates)) {
                for (const candidate of data.candidates) {
                    const contentParts = Array.isArray(candidate?.content?.parts)
                        ? candidate.content.parts
                        : Array.isArray(candidate?.content)
                            ? candidate.content
                            : [];
                    description = extractTextFromStructuredContent(contentParts);
                    if (description) break;
                }
            }

            if (!description && data && typeof data.output_text === 'string') {
                description = data.output_text;
            }
            if (!description && data && typeof data.result === 'string') {
                description = data.result;
            }

            if (!description) {
                const errMsg = data && data.error
                    ? (data.error.message || JSON.stringify(data.error))
                    : 'AI未能生成有效内容，请检查图片质量或重试';
                const { ExternalServiceError } = require('../utils/errors');
                throw new ExternalServiceError('AI服务', { reason: errMsg, responseData: data });
            }

            return String(description).trim();

        } catch (error) {
            if (error && error.config) {
                delete error.config.headers;
                delete error.config.data;
            }

            if (error.response) {
                const status = error.response.status;
                let errorData = '无详细错误信息';

                try {
                    const body = error.response.data;
                    if (body) {
                        if (body.error && (body.error.message || body.error.code)) {
                            errorData = body.error.message || body.error.code;
                        } else if (typeof body === 'string') {
                            errorData = body.slice(0, 200);
                        } else {
                            errorData = JSON.stringify(body).slice(0, 300);
                        }
                    }
                } catch (bodyParseErr) {
                    logger.debug('[AI-MICROSERVICE] 解析 OpenAI 错误响应失败（忽略）:', bodyParseErr && bodyParseErr.message);
                }

                const { AuthenticationError, TooManyRequestsError, TimeoutError, ExternalServiceError } = require('../utils/errors');
                if (status === 401) throw new AuthenticationError('AI服务认证失败，请检查API密钥');
                if (status === 429) throw new TooManyRequestsError('AI服务请求频率过高，请稍后重试', 60);
                if (status === 408) throw new TimeoutError('AI服务请求', true);
                if (status >= 500) throw new ExternalServiceError('AI服务', { status, errorData });
                throw new ExternalServiceError('AI服务', { status, errorData });
            } else if (error.request) {
                const { ServiceUnavailableError } = require('../utils/errors');
                throw new ServiceUnavailableError('AI服务', { message: '无法连接' });
            }

            const { fromNativeError } = require('../utils/errors');
            throw fromNativeError(error, { service: 'AI' });
        }
    }

    async callGeminiApi(imageBuffer, aiConfig, abortController) {
        const base64Image = imageBuffer.toString('base64');
        const modelId = normalizeGeminiModelId(aiConfig.model);
        const endpoint = buildGeminiEndpoint(aiConfig.url, `${modelId}:generateContent`);
        const payload = {
            contents: [{
                role: 'user',
                parts: [
                    { text: aiConfig.prompt },
                    { inlineData: { mimeType: 'image/jpeg', data: base64Image } }
                ]
            }]
        };

        try {
            const response = await this.aiAxios.post(endpoint, payload, {
                params: { key: aiConfig.key },
                timeout: this.taskTimeoutMs,
                signal: abortController.signal
            });

            const data = response.data;
            let description = null;
            if (data && Array.isArray(data.candidates)) {
                for (const candidate of data.candidates) {
                    const contentParts = Array.isArray(candidate?.content?.parts)
                        ? candidate.content.parts
                        : Array.isArray(candidate?.content)
                            ? candidate.content
                            : [];
                    for (const part of contentParts) {
                        if (typeof part.text === 'string' && part.text.trim()) {
                            description = part.text;
                            break;
                        }
                    }
                    if (description) break;
                }
            }

            if (!description && data && typeof data.output_text === 'string') {
                description = data.output_text;
            }

            if (!description) {
                const { ExternalServiceError } = require('../utils/errors');
                throw new ExternalServiceError('AI服务', { reason: 'AI未能生成有效内容，请检查图片质量或重试' });
            }

            return String(description).trim();

        } catch (error) {
            if (error && error.config) {
                delete error.config.headers;
                delete error.config.data;
            }

            if (error.response) {
                const status = error.response.status;
                let errorMessage = 'AI服务返回错误';
                try {
                    const body = error.response.data;
                    if (body && body.error && body.error.message) {
                        errorMessage = body.error.message;
                    } else if (typeof body === 'string') {
                        errorMessage = body.slice(0, 200);
                    } else if (body) {
                        errorMessage = JSON.stringify(body).slice(0, 300);
                    }
                } catch (bodyParseErr) {
                    logger.debug('[AI-MICROSERVICE] 解析 Gemini 错误响应失败（忽略）:', bodyParseErr && bodyParseErr.message);
                }

                const { AuthenticationError, TooManyRequestsError, TimeoutError, ExternalServiceError } = require('../utils/errors');
                if (status === 401 || status === 403) throw new AuthenticationError('AI服务认证失败，请检查API密钥');
                if (status === 429) throw new TooManyRequestsError('AI服务请求频率过高，请稍后重试', 60);
                if (status === 408) throw new TimeoutError('AI服务请求', true);
                if (status >= 500) throw new ExternalServiceError('AI服务', { status, errorMessage });
                throw new ExternalServiceError('AI服务', { status, errorMessage });
            } else if (error.request) {
                const { ServiceUnavailableError } = require('../utils/errors');
                throw new ServiceUnavailableError('AI服务', { message: '无法连接' });
            }

            const { fromNativeError } = require('../utils/errors');
            throw fromNativeError(error, { service: 'AI' });
        }
    }

    async fetchAvailableModels(aiConfig) {
        if (isGeminiEndpoint(aiConfig.url)) {
            return this.fetchGeminiModels(aiConfig);
        }
        return this.fetchOpenAIModels(aiConfig);
    }

    async evaluateVisionModel(model, aiConfig, options = {}) {
        const id = model && (model.id || model.name);
        const capabilities = new Set();
        const meta = id ? getVisionModelMeta(id) : null;
        if (Array.isArray(meta?.capabilities)) {
            meta.capabilities.forEach(cap => capabilities.add(cap));
        }
        if (model?.capabilities && model.capabilities.vision === true) {
            capabilities.add('vision');
        }

        let include = capabilities.has('vision');
        const score = computeVisionHeuristicScore(model);
        if (!include && score >= 2) {
            capabilities.add('vision');
            include = true;
        } else if (!include && score === 1 && options.allowProbe && this.enableVisionProbe && aiConfig) {
            const probed = await this.probeVisionCapability(aiConfig, id);
            if (probed) {
                capabilities.add('vision');
                capabilities.add('probe');
                include = true;
            }
        }

        return {
            include,
            capabilities: Array.from(capabilities),
            labelOverride: meta?.label,
            descriptionOverride: meta?.description,
            provider: meta?.provider
        };
    }

    async probeVisionCapability(aiConfig, modelId) {
        if (!aiConfig || !modelId) return false;
        if (isGeminiEndpoint(aiConfig.url)) return false;
        const cacheKey = `${normalizeBaseUrl(aiConfig.url)}::${modelId}`;
        if (this.visionProbeCache.has(cacheKey)) {
            return this.visionProbeCache.get(cacheKey);
        }
        try {
            const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${aiConfig.key}`
            };
            const payload = {
                model: modelId,
                temperature: 0,
                max_tokens: 8,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: VISION_PROBE_PROMPT },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${VISION_PROBE_IMAGE_BASE64}` } }
                    ]
                }]
            };
            await this.aiAxios.post(buildOpenAIEndpoint(aiConfig.url, 'chat/completions'), payload, {
                headers,
                timeout: Math.min(this.taskTimeoutMs, 15000)
            });
            this.visionProbeCache.set(cacheKey, true);
            return true;
        } catch (error) {
            const status = error?.response?.status;
            const message = error?.response?.data?.error?.message || error?.message || '';
            if (status === 400 && typeof message === 'string' && message.toLowerCase().includes('image')) {
                this.visionProbeCache.set(cacheKey, false);
                return false;
            }
            logger.debug(`[AI-MICROSERVICE] 视觉能力探测失败 (${modelId}): ${message || status}`);
            this.visionProbeCache.set(cacheKey, false);
            return false;
        }
    }

    async fetchOpenAIModels(aiConfig) {
        const headers = { Authorization: `Bearer ${aiConfig.key}` };

        const candidates = [];
        try {
            candidates.push(buildOpenAIEndpoint(aiConfig.url, 'models'));
        } catch (e) {
            logger.debug('[AI] 构建模型端点失败，尝试回退', { error: e?.message });
        }

        try {
            const normalizedBase = normalizeBaseUrl(aiConfig.url);
            candidates.push(new URL('models', normalizedBase).toString());
        } catch (modelEndpointErr) {
            logger.debug('[AI-MICROSERVICE] 构建模型列表端点失败，使用拼接方式:', modelEndpointErr && modelEndpointErr.message);
            candidates.push(`${normalizeBaseUrl(aiConfig.url)}models`);
        }

        const tried = new Set();
        const fallbackErrors = [];

        for (const endpoint of candidates) {
            if (!endpoint || tried.has(endpoint)) continue;
            tried.add(endpoint);
            try {
                const response = await this.aiAxios.get(endpoint, { headers });
                const rawModels = Array.isArray(response.data?.data) ? response.data.data : [];
                const results = [];
                for (const model of rawModels) {
                    const id = model.id || model.name;
                    if (!id) continue;
                    const evaluation = await this.evaluateVisionModel(model, aiConfig, { allowProbe: true });
                    if (!evaluation.include) continue;
                    const enriched = enrichModelMetadata(
                        id,
                        evaluation.labelOverride || model.displayName || model.id || model.name,
                        evaluation.descriptionOverride || model.description || model.owned_by || ''
                    );
                    enriched.capabilities = evaluation.capabilities;
                    enriched.provider = evaluation.provider || enriched.provider || model.owned_by || '';
                    results.push(enriched);
                }
                return results.sort((a, b) => a.displayName.localeCompare(b.displayName));
            } catch (error) {
                const status = error?.response?.status;
                const message = error?.response?.data?.error?.message || error?.message || '获取模型列表失败';
                if (status === 404 || status === 405 || status === 400) {
                    fallbackErrors.push({ status, message, endpoint });
                    continue;
                }
                const err = new Error(message);
                err.status = status;
                throw err;
            }
        }

        const lastError = fallbackErrors.pop();
        const err = new Error(lastError?.message || '该 API 未提供模型列表，请手动填写模型名称');
        err.status = lastError?.status || 404;
        throw err;
    }

    async fetchGeminiModels(aiConfig) {
        const endpoint = buildGeminiEndpoint(aiConfig.url, 'models');
        const aggregated = [];
        let pageToken = null;
        let attempts = 0;
        const maxPages = Number(process.env.AI_MODEL_LIST_MAX_PAGES || 8);
        try {
            do {
                const params = { key: aiConfig.key, pageSize: 100 };
                if (pageToken) params.pageToken = pageToken;
                const response = await this.aiAxios.get(endpoint, { params });
                const rawModels = Array.isArray(response.data?.models) ? response.data.models : [];
                aggregated.push(...rawModels);
                pageToken = response.data?.nextPageToken;
                attempts += 1;
            } while (pageToken && attempts < maxPages);

            const results = [];
            for (const model of aggregated) {
                const id = normalizeGeminiModelId(model.name).replace(/^models\//, '');
                if (!id) continue;
                const evaluation = await this.evaluateVisionModel(model, null, { allowProbe: false });
                if (!evaluation.include) continue;
                const enriched = enrichModelMetadata(id, evaluation.labelOverride || model.displayName || id, evaluation.descriptionOverride || model.description || '');
                enriched.capabilities = evaluation.capabilities;
                enriched.provider = evaluation.provider || enriched.provider || '';
                results.push(enriched);
            }
            return results.sort((a, b) => a.displayName.localeCompare(b.displayName));
        } catch (error) {
            const status = error?.response?.status;
            const message = error?.response?.data?.error?.message || error?.message || '获取模型列表失败';
            const err = new Error(message);
            err.status = status;
            throw err;
        }
    }

    /**
     * 处理队列中的下一个任务
     */
    processNextQueuedTask() {
        if (this.taskQueue.length === 0 || this.activeTasks.size >= this.maxConcurrent) {
            return;
        }

        const nextTask = this.taskQueue.shift();
        if (!nextTask) return;
        const { task, resolve, reject } = nextTask;

        this.processTask(task).then(resolve).catch(reject);
    }

    /**
     * 获取微服务状态
     * @returns {Object} 状态信息
     */
    getStatus() {
        return {
            activeTasks: this.activeTasks.size,
            queuedTasks: this.taskQueue.length,
            maxConcurrent: this.maxConcurrent,
            isProcessing: this.isProcessing,
            uptime: process.uptime()
        };
    }

    /**
     * 动态调整并发数
     * @param {number} newLimit - 新的并发限制
     */
    setConcurrencyLimit(newLimit) {
        const oldLimit = this.maxConcurrent;
        this.maxConcurrent = Math.max(1, Math.min(10, newLimit));

        if (this.maxConcurrent > oldLimit) {
            while (this.taskQueue.length > 0 && this.activeTasks.size < this.maxConcurrent) {
                this.processNextQueuedTask();
            }
        }
    }

    /**
     * 优雅关闭
     */
    async shutdown() {

        // 等待活跃任务完成
        const activePromises = Array.from(this.activeTasks.values()).map(task =>
            new Promise(resolve => {
                // 等待任务完成或超时
                setTimeout(resolve, 5000);
            })
        );

        if (activePromises.length > 0) {
            await Promise.allSettled(activePromises);
        }

    }
}

// 创建单例实例
const aiMicroservice = new AIMicroservice();

// 优雅关闭处理
process.on('SIGINT', async () => {
    await aiMicroservice.shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await aiMicroservice.shutdown();
    process.exit(0);
});

module.exports = aiMicroservice;
