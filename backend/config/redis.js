/**
 * Redis配置模块
 * 配置Redis数据库连接和AI任务队列
 */
const Redis = require('ioredis');
const { Queue } = require('bullmq');
const { REDIS_URL, AI_CAPTION_QUEUE_NAME, SETTINGS_QUEUE_NAME } = require('./index');
const logger = require('./logger');

/**
 * Redis连接配置选项
 * 设置重试策略和最大重试次数
 */
const redisConnectionOptions = {
    // 重试策略：每次重试间隔递增，最大不超过5秒
    retryStrategy: times => Math.min(times * 1000, 5000),
    // 普通 KV 连接可有限次重试
    maxRetriesPerRequest: 5,
    connectTimeout: 10000,
    keepAlive: 10000,
    reconnectOnError: (err) => {
        const msg = String(err && err.message || err || '');
        return /READONLY|ETIMEDOUT|ECONNRESET|EPIPE|ENETUNREACH|ECONNREFUSED/i.test(msg);
    }
};

/**
 * 创建Redis客户端实例
 * 使用配置的URL和连接选项
 */
const redis = new Redis(REDIS_URL, redisConnectionOptions);

// 为 BullMQ 队列与 Worker 提供独立连接（避免与普通 KV 读写互相阻塞）
const bullConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Redis连接事件监听器
 * 处理连接成功和错误情况
 */
// 连接成功时的日志记录
redis.on('connect', () => logger.info('Redis 连接成功!'));
// 连接错误时的错误处理和日志记录
redis.on('error', err => logger.error('Redis错误:', err.code === 'ECONNREFUSED' ? '无法连接Redis' : err));

/**
 * 创建AI标题生成任务队列
 * 使用BullMQ队列管理AI相关的异步任务
 */
const aiCaptionQueue = new Queue(AI_CAPTION_QUEUE_NAME, {
    // 使用 BullMQ 推荐的独立连接
    connection: bullConnection,
    // 默认任务选项：重试机制和退避策略
    defaultJobOptions: {
        // 任务失败时的最大重试次数
        attempts: 3,
        // 退避策略：指数退避，初始延迟5秒
        backoff: {
            type: 'exponential',
            delay: 5000,
        },
    },
});

// 记录队列初始化成功的日志
logger.info(`AI 任务队列 (${AI_CAPTION_QUEUE_NAME}) 初始化成功。`);

// 设置更新队列（持久化任务）
const settingsUpdateQueue = new Queue(SETTINGS_QUEUE_NAME, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 500
  }
});
logger.info(`Settings 任务队列 (${SETTINGS_QUEUE_NAME}) 初始化成功。`);

/**
 * 导出Redis客户端和AI任务队列
 * 供其他模块使用
 */
module.exports = {
    redis,        // Redis客户端实例（普通 KV 用途）
    aiCaptionQueue, // AI标题生成任务队列
    settingsUpdateQueue, // 设置更新任务队列
    bullConnection // BullMQ 专用连接（如需在其他模块/worker 共享）
};