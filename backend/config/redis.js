/**
 * Redis配置模块
 * 配置Redis数据库连接和AI任务队列
 */
const Redis = require('ioredis');
const { Queue } = require('bullmq');
const { REDIS_URL, SETTINGS_QUEUE_NAME } = require('./index');
const logger = require('./logger');
// 显式开关：未设置 ENABLE_REDIS=true 时完全使用本地 No-Op，避免连接风暴
const WANT_REDIS = (process.env.ENABLE_REDIS || 'false').toLowerCase() === 'true';

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
    // 懒连接：不主动发起连接，调用方按需 connect()
    lazyConnect: true,
    reconnectOnError: (err) => {
        const msg = String(err && err.message || err || '');
        return /READONLY|ETIMEDOUT|ECONNRESET|EPIPE|ENETUNREACH|ECONNREFUSED/i.test(msg);
    }
};

/**
 * 创建Redis客户端实例
 * 使用配置的URL和连接选项
 */
// 安全Redis代理：未连接时自动降级为本地No-Op，实现开箱即用
const realRedis = WANT_REDIS ? new Redis(REDIS_URL, redisConnectionOptions) : null;
let __redisReady = false;

// 轻量No-Op实现，覆盖项目中常用的方法
function createRedisShim() {
  const shim = {
    // 标记：用于调用方判断回退逻辑
    isNoRedis: true,
    async get() { return null; },
    async set() { return null; },
    async del() { return 0; },
    async incr() { return 0; },
    async expire() { return 0; },
    async ttl() { return -2; },
    async publish() { return 0; },
    async mget() { return []; },
    async scan() { return ['0', []]; },
    scanStream() {
      // No-Op readable-like stream
      return {
        on(event, cb) { if (event === 'end') setImmediate(() => cb()); return this; },
        pause() { return this; },
        resume() { return this; },
        destroy() { return; }
      };
    },
    async sunion() { return []; },
    async sadd() { return 1; },
    async srem() { return 0; },
    pipeline() {
      return {
        del() { return this; },
        unlink() { return this; },
        sadd() { return this; },
        srem() { return this; },
        expire() { return this; },
        exec: async () => []
      };
    },
    // 供 SSE/订阅等场景使用的 duplicate：返回同样的 No-Op 客户端
    duplicate() { return createRedisShim(); },
    subscribe(channel, cb) {
      if (typeof cb === 'function') { setImmediate(() => cb(null, 0)); }
      return 0;
    },
    psubscribe(pattern, cb) {
      if (typeof cb === 'function') { setImmediate(() => cb(null, 0)); }
      return 0;
    },
    async on() { return; },
    async unlink() { return 0; },
    async call() { return null; }
  };
  return shim;
}
const __redisShim = createRedisShim();
const redis = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'isNoRedis') return !(__redisReady && !!realRedis);
    const target = (__redisReady && !!realRedis) ? realRedis : __redisShim;
    const v = target[prop];
    return typeof v === 'function' ? v.bind(target) : v;
  }
});

// 为 BullMQ 队列与 Worker 提供独立连接（避免与普通 KV 读写互相阻塞）
const bullConnection = WANT_REDIS ? new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true }) : null;

/**
 * Redis连接事件监听器
 * 处理连接成功和错误情况
 */
// 连接成功时的日志记录
let __connectionLogged = false;
if (realRedis) {
  realRedis.on('ready', () => {
    __redisReady = true;
    if (!__connectionLogged) {
      logger.info('Redis 连接就绪');
      __connectionLogged = true;
    }
  });
  realRedis.on('connect', () => {
    if (!__connectionLogged) {
      logger.info('Redis 连接已建立');
      __connectionLogged = true;
    }
  });
  // 连接错误时的错误处理和日志记录
  realRedis.on('error', err => logger.error('Redis错误:', err && err.code === 'ECONNREFUSED' ? '无法连接Redis' : err));

  // 主动建立连接（修复lazyConnect问题）
  realRedis.connect().catch(err => {
    logger.error('Redis初始连接失败:', err.message);
  });
}

/**
 * 创建任务队列Shim
 * 为未启用Redis时提供兼容性接口
 */
function createQueueShim(name) {
  return {
    // 投递返回占位 id
    add: async () => ({ id: 'noop' }),
    // 查询类 API 返回空/空值，避免调用端抛错
    getJobs: async () => [],
    getJob: async () => null,
    getJobCounts: async () => ({ active: 0, waiting: 0, delayed: 0, completed: 0, failed: 0, paused: 0 })
  };
}

// 注意：AI队列已移除，AI功能已重构为微服务架构

// 设置更新队列（持久化任务）
let settingsUpdateQueue;
if (WANT_REDIS) {
  try {
    settingsUpdateQueue = new Queue(SETTINGS_QUEUE_NAME, {
      connection: bullConnection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 500
      }
    });
    logger.debug(`Settings 任务队列 (${SETTINGS_QUEUE_NAME}) 初始化成功。`);
  } catch (e) {
    settingsUpdateQueue = createQueueShim(SETTINGS_QUEUE_NAME);
    logger.warn(`Settings 任务队列初始化失败（已降级为本地No-Op）：${e && e.message}`);
  }
} else {
  settingsUpdateQueue = createQueueShim(SETTINGS_QUEUE_NAME);
}

/**
 * 导出Redis客户端和AI任务队列
 * 供其他模块使用
 */
/**
 * 检查Redis是否可用
 * @param {boolean} requireRedis - 是否需要Redis（默认false，如果为true则在无Redis时返回false）
 * @returns {boolean} Redis是否可用
 */
function isRedisAvailable(requireRedis = false) {
    if (!WANT_REDIS) {
        return !requireRedis; // 如果不需要Redis，则返回true；否则返回false
    }
    return redis && !redis.isNoRedis && __redisReady;
}

/**
 * 检查是否应该使用Redis进行限流
 * @returns {boolean} 是否使用Redis限流
 */
function shouldUseRedisForRateLimit() {
    return isRedisAvailable() && (process.env.RATE_LIMIT_USE_REDIS || 'false').toLowerCase() === 'true';
}

module.exports = {
    redis,        // Redis客户端实例（普通 KV 用途）
    settingsUpdateQueue, // 设置更新任务队列（仍在使用）
    bullConnection, // BullMQ 专用连接（如需在其他模块/worker 共享）
    // 可观测性：'disabled' | 'connecting' | 'ready'
    getAvailability: () => (!WANT_REDIS ? 'disabled' : (__redisReady ? 'ready' : 'connecting')),
    // Worker 专用 KV 连接（或 No-Op）
    createWorkerRedis: () => WANT_REDIS ? new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true }) : createRedisShim(),
    // 工具函数
    isRedisAvailable,
    shouldUseRedisForRateLimit,
};