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

const GEMINI_HOST_PATTERN = /generativelanguage\.googleapis\.com$/i;

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

function isLikelyVisionModel(model) {
    if (!model) return false;
    const id = String(model.id || model.name || '').toLowerCase();
    if (!id) return false;
    if (model.capabilities && model.capabilities.vision === true) return true;
    const modalityFields = [model.modalities, model.supportedModalities, model.supported_input_modalities, model.supportedInputModalities];
    for (const field of modalityFields) {
        if (Array.isArray(field) && field.some(mod => typeof mod === 'string' && mod.toLowerCase().includes('image'))) {
            return true;
        }
    }
    const heuristics = ['vision', 'image', 'omni', 'gpt-4o', 'flash', 'gpt-4.1', 'photography', 'multimodal'];
    return heuristics.some(token => id.includes(token));
}

function isGeminiVisionModel(model) {
    if (!model) return false;
    const name = String(model.name || '').toLowerCase();
    const supportedInputs = model.supportedInputModalities || model.inputModalities;
    if (Array.isArray(supportedInputs) && supportedInputs.some(mod => typeof mod === 'string' && mod.toLowerCase().includes('image'))) {
        return true;
    }
    const heuristics = ['vision', '1.5', 'flash', 'pro'];
    return heuristics.some(token => name.includes(token));
}

// 微服务状态管理
class AIMicroservice {
    constructor() {
        this.activeTasks = new Map(); // 活跃任务跟踪
        this.taskQueue = []; // 任务队列
        this.queueLimit = Number(process.env.AI_QUEUE_MAX || 50);
        this.queueTimeoutMs = Number(process.env.AI_QUEUE_TIMEOUT_MS || 60000);
        this.taskTimeoutMs = Number(process.env.AI_TASK_TIMEOUT_MS || 120000);
        this.maxConcurrent = this.resolveInitialConcurrency();
        this.isProcessing = false; // 处理状态
        this.initializeAxios();
    }

    resolveInitialConcurrency() {
        const configured = Number(process.env.AI_MAX_CONCURRENT || process.env.AI_CONCURRENCY);
        if (Number.isFinite(configured) && configured > 0) {
            return Math.min(10, Math.max(1, Math.floor(configured)));
        }

        try {
            const { hasResourceBudget } = require('./adaptive.service');
            const budget = hasResourceBudget();
            if (budget && budget.loadOk && budget.memOk) {
                const suggested = Math.max(1, Math.ceil(budget.cpus / 2));
                return Math.min(4, suggested);
            }
        } catch (budgetErr) {
            logger.debug('[AI-MICROSERVICE] 读取资源预算失败，使用默认并发:', budgetErr && budgetErr.message);
        }

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

        // 图片路径验证和处理
        const fullImagePath = path.join(PHOTOS_DIR, imagePath);
        const imageBuffer = await this.processImage(fullImagePath, abortController);

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
    }

    /**
     * 图片预处理
     * @param {string} imagePath - 图片路径
     * @returns {Promise<Buffer>} 处理后的图片缓冲区
     */
    async processImage(imagePath, abortController) {
        try {
            const transformer = sharp(imagePath, {
                limitInputPixels: Number(process.env.SHARP_MAX_PIXELS || (24000 * 24000))
            }).resize({ width: 1024 }).jpeg({ quality: 70 });

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
                if (abortController && abortListener) {
                    abortController.signal.removeEventListener('abort', abortListener);
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
                } else if (typeof choice.text === 'string') {
                    description = choice.text;
                } else if (choice.delta && typeof choice.delta.content === 'string') {
                    description = choice.delta.content;
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
                return rawModels
                    .filter(isLikelyVisionModel)
                    .map(model => ({
                        id: model.id || model.name,
                        displayName: model.displayName || model.id || model.name,
                        description: model.description || model.owned_by || ''
                    }))
                    .sort((a, b) => a.displayName.localeCompare(b.displayName));
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
        try {
            const response = await this.aiAxios.get(endpoint, {
                params: { key: aiConfig.key, pageSize: 100 }
            });
            const rawModels = Array.isArray(response.data?.models) ? response.data.models : [];
            return rawModels
                .filter(isGeminiVisionModel)
                .map(model => {
                    const id = normalizeGeminiModelId(model.name).replace(/^models\//, '');
                    return {
                        id,
                        displayName: model.displayName || id,
                        description: model.description || ''
                    };
                })
                .sort((a, b) => a.displayName.localeCompare(b.displayName));
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
