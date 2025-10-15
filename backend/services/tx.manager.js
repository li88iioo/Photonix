/**
 * 事务管理器（统一事务边界，消除隐式嵌套事务）
 * 改进：使用 AsyncLocalStorage 隔离并发上下文，避免全局共享栈的交叉污染。
 *
 * - 为每个 DB 维护一个事务深度栈；depth=0 时使用 BEGIN IMMEDIATE；depth>0 时使用 SAVEPOINT
 * - withTransaction(db, fn, { mode }): 顶层事务或嵌套保存点；确保失败时回滚，成功时提交/释放
 *
 * 依赖：../db/multi-db 提供的 dbRun
 */
const { dbRun } = require('../db/multi-db');
const { AsyncLocalStorage } = require('async_hooks');
const logger = require('../config/logger');

const als = new AsyncLocalStorage(); // store: { stacks: Map<dbName, string[]|null[]> }

function ensureStore() {
  let store = als.getStore();
  if (!store) {
    store = { stacks: new Map() };
    // 将上下文注入当前异步执行链
    als.enterWith(store);
  }
  return store;
}

function ensureStack(db) {
  const store = ensureStore();
  const stacks = store.stacks;
  if (!stacks.has(db)) stacks.set(db, []);
  return stacks.get(db);
}

function makeSavepointName(db, depth) {
  const ts = Date.now();
  return `txm_${db}_${depth}_${ts}`;
}

/**
 * 开始事务或保存点
 */
async function begin(db, mode = 'IMMEDIATE') {
  const stack = ensureStack(db);
  const depth = stack.length;
  const store = als.getStore();
  if (depth === 0 && !(store && store.__txRoot === true)) {
    const { BusinessLogicError } = require('../utils/errors');
    throw new BusinessLogicError('begin() must be called within withTransaction root context', 'TX_CONTEXT_ERROR');
  }
  if (depth === 0) {
    await dbRun(db, `BEGIN ${String(mode).toUpperCase()}`);
    // 用空占位表示顶层事务开始
    stack.push(null);
  } else {
    const spName = makeSavepointName(db, depth);
    await dbRun(db, `SAVEPOINT ${spName}`);
    stack.push(spName);
  }
}

/**
 * 提交事务或释放保存点
 */
async function commit(db) {
  const stack = ensureStack(db);
  if (stack.length === 0) return; // 非事务态，忽略
  const spName = stack.pop();
  if (spName == null) {
    // 顶层事务
    await dbRun(db, 'COMMIT');
  } else {
    await dbRun(db, `RELEASE SAVEPOINT ${spName}`);
  }
}

/**
 * 回滚事务或回滚到保存点（并释放）
 */
async function rollback(db) {
  const stack = ensureStack(db);
  if (stack.length === 0) return; // 非事务态，忽略
  const spName = stack.pop();
  if (spName == null) {
    // 顶层事务
    try { await dbRun(db, 'ROLLBACK'); } catch (err) {
      logger.debug(`[TxManager] 回滚顶层事务失败: ${err.message}`);
    }
  } else {
    try { await dbRun(db, `ROLLBACK TO ${spName}`); } catch (err) {
      logger.debug(`[TxManager] 回滚保存点失败 (${spName}): ${err.message}`);
    }
    try { await dbRun(db, `RELEASE SAVEPOINT ${spName}`); } catch (err) {
      logger.debug(`[TxManager] 释放保存点失败 (${spName}): ${err.message}`);
    }
  }
}

/**
 * 事务包装器：统一处理开始/提交/回滚
 * 注意：使用 AsyncLocalStorage 确保并发隔离。
 * @param {string} db - 数据库名（如 'main'）
 * @param {Function} fn - 执行体
 * @param {object} options - { mode: 'IMMEDIATE' | 'DEFERRED' | 'EXCLUSIVE' }
 */
async function withTransaction(db, fn, options = {}) {
  const mode = options.mode || 'IMMEDIATE';
  const existingStore = als.getStore();

  const execute = async () => {
    await begin(db, mode);
    try {
      const res = await fn();
      await commit(db);
      return res;
    } catch (e) {
      await rollback(db);
      throw e;
    }
  };

  if (existingStore && existingStore.__txRoot === true) {
    return execute();
  }

  return als.run({ stacks: new Map(), __txRoot: true }, execute);
}

module.exports = {
  withTransaction,
};