/**
 * Redis 配置模块
 * 用于配置 Redis 数据库连接与设置更新任务队列
 */
const Redis = require('ioredis');
const { REDIS_URL, SETTINGS_QUEUE_NAME } = require('./index');
const logger = require('./logger');

/**
 * 显式 Redis 启用开关。
 * 未设置 ENABLE_REDIS=true 时使用本地 No-Op，避免意外连接 Redis。
 */
const WANT_REDIS = (process.env.ENABLE_REDIS || 'false').toLowerCase() === 'true';

/**
 * Redis 连接参数选项
 * - retryStrategy: 重试间隔递增，最大不超过 5 秒
 * - maxRetriesPerRequest: 普通 KV 操作最大重试次数
 * - connectTimeout: 连接超时时间（毫秒）
 * - keepAlive: 保持连接存活时间（毫秒）
 * - lazyConnect: 懒连接模式，由调用方决定何时连接
 * - reconnectOnError: 错误重连策略
 */
const redisConnectionOptions = {
  retryStrategy: times => Math.min(times * 1000, 5000),
  maxRetriesPerRequest: 5,
  connectTimeout: 10000,
  keepAlive: 10000,
  lazyConnect: true,
  reconnectOnError: (err) => {
    const msg = String(err && err.message || err || '');
    return /READONLY|ETIMEDOUT|ECONNRESET|EPIPE|ENETUNREACH|ECONNREFUSED/i.test(msg);
  }
};

/**
 * 创建 Redis 客户端实例（如未启用则为 null）
 */
const realRedis = WANT_REDIS ? new Redis(REDIS_URL, redisConnectionOptions) : null;
let __redisReady = false;

/**
 * 构建本地 No-Op Redis 客户端，用于无 Redis 场景下兼容常用操作。
 * 返回典型方法的占位实现。
 */
function createRedisShim() {
  const shim = {
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
      // 返回只实现 end 事件的 No-Op 可读流
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
      // 返回带链式方法的 No-Op pipeline
      return {
        del() { return this; },
        unlink() { return this; },
        sadd() { return this; },
        srem() { return this; },
        expire() { return this; },
        exec: async () => []
      };
    },
    // 复制自己用于订阅场景
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

/**
 * 本地 No-Op Redis 客户端单例
 */
const __redisShim = createRedisShim();

/**
 * Redis 客户端代理
 * 若连接可用，则转发到真实 Redis，否则转发到 No-Op
 */
const redis = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'isNoRedis') return !(__redisReady && !!realRedis);
    const target = (__redisReady && !!realRedis) ? realRedis : __redisShim;
    const v = target[prop];
    return typeof v === 'function' ? v.bind(target) : v;
  }
});

/**
 * BullMQ Worker 专用独立 Redis 连接，用于避免任务队列阻塞普通 KV 查询
 * (保留此变量以维持导出兼容性，但不再用于 BullMQ)
 */
const bullConnection = WANT_REDIS ? new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true }) : null;

/**
 * Redis 连接事件监听与日志
 * - ready/connect 时标记已连接，输出日志
 * - error 时输出异常日志
 * - 主动触发连接 (解决 lazyConnect 不自动连的问题)
 */
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
  realRedis.on('error', err => logger.error('Redis错误:', err && err.code === 'ECONNREFUSED' ? '无法连接Redis' : err));

  // 主动建立连接，避免 lazyConnect 场景下永不连接
  realRedis.connect().catch(err => {
    logger.error('Redis初始连接失败:', err.message);
  });
}

/**
 * 创建任务队列的本地 No-Op 实现
 * - add: 返回占位 id
 * - getJobs/getJob/getJobCounts: 返回空结果
 * @param {string} name - 队列名
 * @returns {object}
 */
function createQueueShim(name) {
  return {
    add: async () => ({ id: 'noop' }),
    getJobs: async () => [],
    getJob: async () => null,
    getJobCounts: async () => ({
      active: 0,
      waiting: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
      paused: 0
    })
  };
}

/**
 * 设置更新队列（即使未启用 Redis 也可调用，无副作用）
 * - 使用 Queue Shim：不再使用 BullMQ，仅保留接口兼容
 */
const settingsUpdateQueue = createQueueShim(SETTINGS_QUEUE_NAME);

/**
 * 检查 Redis 是否可用
 * @param {boolean} requireRedis - 若为 true, 必须有 Redis 才返回 true（默认 false）
 * @returns {boolean} - Redis 实际可用性
 */
function isRedisAvailable(requireRedis = false) {
  if (!WANT_REDIS) {
    return !requireRedis;
  }
  return redis && !redis.isNoRedis && __redisReady;
}

/**
 * 判断是否应使用 Redis 进行限流
 * @returns {boolean} - 当前限流是否启用 Redis
 */
function shouldUseRedisForRateLimit() {
  return isRedisAvailable() && (process.env.RATE_LIMIT_USE_REDIS || 'false').toLowerCase() === 'true';
}

module.exports = {
  /**
   * Redis 客户端实例（KV 读写通用，含 No-Op 回退）
   */
  redis,
  /**
   * 设置更新任务队列（BullMQ 队列或本地 No-Op）
   */
  settingsUpdateQueue,
  /**
   * BullMQ 专用独立 Redis 连接
   */
  bullConnection,
  /**
   * 返回 Redis 当前状态：'disabled' | 'connecting' | 'ready'
   * @returns {string}
   */
  getAvailability: () => (!WANT_REDIS ? 'disabled' : (__redisReady ? 'ready' : 'connecting')),
  /**
   * 获取 Worker 专用 KV 连接（或 No-Op 实例）
   * @returns {Redis|Object}
   */
  createWorkerRedis: () =>
    WANT_REDIS ? new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true }) : createRedisShim(),
  /**
   * 检查 Redis 是否可用
   */
  isRedisAvailable,
  /**
   * 判断是否启用 Redis 限流
   */
  shouldUseRedisForRateLimit,
};