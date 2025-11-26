/**
 * 批量执行器（不管理事务，仅负责批处理执行与可选重试）
 * - 约定：事务边界统一由 tx.manager 控制，禁止在此处开启事务
 */
const { runPreparedBatch } = require('../db/multi-db');

/**
 * 执行批量 SQL
 * @param {string} db - 数据库名（如 'main'）
 * @param {string} sql - SQL（带 ? 占位）
 * @param {Array<Array>} rows - 参数矩阵
 * @param {object} options - { chunkSize?: number, retry?: boolean, redis?: any, extra?: object }
 */
async function executeBatch(db, sql, rows, options = {}) {
  const chunkSize = Number(options.chunkSize || 800);
  const extra = Object.assign({ manageTransaction: false, chunkSize }, options.extra || {});

  // Native DB handling (busy_timeout) replaces application-layer retry
  return runPreparedBatch(db, sql, rows, extra);
}

module.exports = { executeBatch };