/**
 * 分布式追踪工具
 * 
 * 提供请求追踪能力，支持跨线程、跨服务的请求链路追踪
 * 
 * @version 1.0.0
 */

const { v4: uuidv4 } = require('uuid');
const { AsyncLocalStorage } = require('async_hooks');

// 使用 AsyncLocalStorage 存储追踪上下文
const traceStorage = new AsyncLocalStorage();

/**
 * Trace Context 类
 * 表示一个追踪上下文
 */
class TraceContext {
  constructor(options = {}) {
    this.traceId = options.traceId || uuidv4();
    this.spanId = options.spanId || uuidv4();
    this.parentSpanId = options.parentSpanId || null;
    this.startTime = options.startTime || Date.now();
    this.metadata = options.metadata || {};
  }

  /**
   * 创建子 span
   */
  createChildSpan(name) {
    return new TraceContext({
      traceId: this.traceId,
      spanId: uuidv4(),
      parentSpanId: this.spanId,
      metadata: {
        ...this.metadata,
        spanName: name
      }
    });
  }

  /**
   * 转换为简单对象（用于序列化）
   */
  toObject() {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      startTime: this.startTime,
      metadata: this.metadata
    };
  }

  /**
   * 从对象创建 TraceContext
   */
  static fromObject(obj) {
    if (!obj || !obj.traceId) {
      return null;
    }
    return new TraceContext(obj);
  }

  /**
   * 获取持续时间（毫秒）
   */
  getDuration() {
    return Date.now() - this.startTime;
  }
}

/**
 * Trace 管理器
 */
class TraceManager {
  /**
   * 在追踪上下文中运行函数
   * 
   * @param {TraceContext|object} context - 追踪上下文
   * @param {Function} fn - 要运行的函数
   * @returns {*} 函数返回值
   */
  static run(context, fn) {
    const traceContext = context instanceof TraceContext 
      ? context 
      : TraceContext.fromObject(context) || new TraceContext();
    
    return traceStorage.run(traceContext, fn);
  }

  /**
   * 获取当前追踪上下文
   * 
   * @returns {TraceContext|null}
   */
  static getCurrentContext() {
    return traceStorage.getStore() || null;
  }

  /**
   * 获取当前 traceId
   * 
   * @returns {string|null}
   */
  static getCurrentTraceId() {
    const context = this.getCurrentContext();
    return context ? context.traceId : null;
  }

  /**
   * 获取当前 spanId
   * 
   * @returns {string|null}
   */
  static getCurrentSpanId() {
    const context = this.getCurrentContext();
    return context ? context.spanId : null;
  }

  /**
   * 创建新的追踪上下文
   * 
   * @param {object} options - 选项
   * @returns {TraceContext}
   */
  static createContext(options = {}) {
    return new TraceContext(options);
  }

  /**
   * 创建子 span 并运行函数
   * 
   * @param {string} name - span 名称
   * @param {Function} fn - 要运行的函数
   * @returns {*} 函数返回值
   */
  static async runInChildSpan(name, fn) {
    const parentContext = this.getCurrentContext();
    
    if (!parentContext) {
      // 如果没有父上下文，创建新的根上下文
      const context = new TraceContext({
        metadata: { spanName: name }
      });
      return this.run(context, fn);
    }

    // 创建子 span
    const childContext = parentContext.createChildSpan(name);
    return this.run(childContext, fn);
  }

  /**
   * 添加元数据到当前上下文
   * 
   * @param {string} key - 键
   * @param {*} value - 值
   */
  static addMetadata(key, value) {
    const context = this.getCurrentContext();
    if (context) {
      context.metadata[key] = value;
    }
  }

  /**
   * 获取元数据
   * 
   * @param {string} key - 键
   * @returns {*}
   */
  static getMetadata(key) {
    const context = this.getCurrentContext();
    return context ? context.metadata[key] : null;
  }

  /**
   * 从 HTTP 请求提取追踪上下文
   * 
   * @param {object} req - Express 请求对象
   * @returns {TraceContext}
   */
  static fromRequest(req) {
    // 尝试从多个来源提取 traceId
    const traceId = req.headers['x-trace-id'] 
      || req.headers['x-request-id']
      || req.requestId
      || req.id
      || uuidv4();

    const parentSpanId = req.headers['x-span-id'] || null;

    return new TraceContext({
      traceId,
      spanId: uuidv4(),
      parentSpanId,
      metadata: {
        method: req.method,
        path: req.path,
        ip: req.ip,
        userAgent: req.headers['user-agent']
      }
    });
  }

  /**
   * 将追踪上下文注入到 HTTP 响应头
   * 
   * @param {object} res - Express 响应对象
   * @param {TraceContext} context - 追踪上下文
   */
  static injectToResponse(res, context) {
    if (context) {
      res.setHeader('X-Trace-Id', context.traceId);
      res.setHeader('X-Span-Id', context.spanId);
    }
  }

  /**
   * 为 Worker 消息添加追踪上下文
   * 
   * @param {object} message - Worker 消息
   * @returns {object} 带追踪信息的消息
   */
  static injectToWorkerMessage(message) {
    const context = this.getCurrentContext();
    
    if (!context) {
      return message;
    }

    return {
      ...message,
      _trace: context.toObject()
    };
  }

  /**
   * 从 Worker 消息提取追踪上下文
   * 
   * @param {object} message - Worker 消息
   * @returns {TraceContext|null}
   */
  static fromWorkerMessage(message) {
    if (!message) {
      return null;
    }
    const tracePayload = message._trace
      || (message.trace && typeof message.trace === 'object' ? message.trace : null)
      || (message.meta && typeof message.meta._trace === 'object' ? message.meta._trace : null);
    if (!tracePayload) {
      return null;
    }
    return TraceContext.fromObject(tracePayload);
  }
}

/**
 * Logger 装饰器 - 自动添加追踪信息
 */
class TracedLogger {
  constructor(logger) {
    this.logger = logger;
  }

  _extractMetaFromArgs(args = []) {
    const meta = {};
    let stack;
    const extras = [];

    for (const arg of args) {
      if (arg == null) continue;
      if (arg instanceof Error) {
        meta.error = arg.message;
        if (arg.stack) {
          stack = arg.stack;
        }
      } else if (typeof arg === 'object') {
        Object.assign(meta, arg);
      } else {
        extras.push(typeof arg === 'string' ? arg : String(arg));
      }
    }

    if (extras.length > 0) {
      meta.extra = extras;
    }

    return { meta, stack };
  }

  _prepareEntry(level, message, args = []) {
    const entry = { level };
    const context = TraceManager.getCurrentContext();
    if (context) {
      entry.traceId = context.traceId;
      entry.spanId = context.spanId;
    }

    if (message instanceof Error) {
      entry.message = message.message;
      if (message.stack) {
        entry.stack = message.stack;
      }
    } else if (typeof message === 'object' && message !== null) {
      const { message: nestedMessage, ...rest } = message;
      if (typeof nestedMessage === 'string') {
        entry.message = nestedMessage;
      } else {
        entry.message = JSON.stringify(message);
      }
      if (Object.keys(rest).length > 0) {
        entry.meta = Object.assign(entry.meta || {}, rest);
      }
    } else if (message !== undefined) {
      entry.message = String(message);
    } else {
      entry.message = '';
    }

    if (args.length > 0) {
      const { meta, stack } = this._extractMetaFromArgs(args);
      if (Object.keys(meta).length > 0) {
        entry.meta = Object.assign(entry.meta || {}, meta);
      }
      if (stack && !entry.stack) {
        entry.stack = stack;
      }
    }

    if (!entry.message && entry.meta && entry.meta.message) {
      entry.message = entry.meta.message;
      delete entry.meta.message;
    }

    if (entry.meta && Object.keys(entry.meta).length === 0) {
      delete entry.meta;
    }

    return entry;
  }

  _log(level, message, args) {
    const entry = this._prepareEntry(level, message, args);
    this.logger.log(entry);
  }

  error(message, ...args) {
    this._log('error', message, args);
  }

  warn(message, ...args) {
    this._log('warn', message, args);
  }

  info(message, ...args) {
    this._log('info', message, args);
  }

  debug(message, ...args) {
    this._log('debug', message, args);
  }

  silly(message, ...args) {
    this._log('silly', message, args);
  }

  log(levelOrEntry, ...args) {
    if (typeof levelOrEntry === 'object' && levelOrEntry && levelOrEntry.level) {
      const { level, message, ...rest } = levelOrEntry;
      const entry = Object.assign({}, this._prepareEntry(level, message, args), rest);
      entry.level = level;
      this.logger.log(entry);
      return;
    }

    const level = levelOrEntry;
    const [message, ...rest] = args;
    this._log(level, message, rest);
  }
}

/**
 * Express 中间件 - 自动创建追踪上下文
 */
function traceMiddleware(req, res, next) {
  const context = TraceManager.fromRequest(req);
  
  // 将 traceId 和 spanId 添加到 req 对象
  req.traceId = context.traceId;
  req.spanId = context.spanId;
  req.traceContext = context;
  
  // 注入到响应头
  TraceManager.injectToResponse(res, context);
  
  // 在追踪上下文中运行后续中间件
  TraceManager.run(context, () => {
    next();
  });
}

/**
 * 创建带追踪的 logger
 * 
 * @param {object} logger - 原始 logger
 * @returns {TracedLogger}
 */
function createTracedLogger(logger) {
  return new TracedLogger(logger);
}

module.exports = {
  TraceContext,
  TraceManager,
  TracedLogger,
  traceMiddleware,
  createTracedLogger
};
