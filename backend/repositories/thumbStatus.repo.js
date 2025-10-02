/**
 * repositories/thumbStatus.repo.js
 * 职责：封装 thumb_status 的批量写入与单条回退写入逻辑
 * - 统一 SQL/重试/事务与分块策略
 * - 供业务层调用，避免在 service 内部拼接 SQL
 */
const { runPreparedBatch, dbRun } = require('../db/multi-db');
const { runPreparedBatchWithRetry } = require('../db/sqlite-retry');
const { writeThumbStatusWithRetry: writeThumbStatusWithRetryNew } = require('../db/sqlite-retry');

const UPSERT_SQL = `INSERT INTO thumb_status(path, mtime, status, last_checked)
                    VALUES(?, ?, ?, strftime('%s','now')*1000)
                    ON CONFLICT(path) DO UPDATE SET
                      mtime=excluded.mtime,
                      status=excluded.status,
                      last_checked=excluded.last_checked`;

/**
 * 批量 upsert 缩略图状态
 * @param {Array<[string, number, string]>} rows - [path, mtime, status]
 * @param {{manageTransaction?: boolean, chunkSize?: number}} options
 * @param {import('ioredis')} redis
 */
async function upsertThumbStatusBatch(rows, options = {}, redis) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const opts = {
    manageTransaction: Boolean(options.manageTransaction),
    chunkSize: Math.max(1, Number(options.chunkSize || 400)),
  };
  await runPreparedBatchWithRetry(runPreparedBatch, 'main', UPSERT_SQL, rows, opts, redis);
}

/**
 * 单条 upsert（用于批量失败时的回退路径）
 * @param {string} path
 * @param {number} mtime
 * @param {string} status
 * @param {import('ioredis')} redis
 */
async function upsertThumbStatusSingle(path, mtime, status, redis) {
  await writeThumbStatusWithRetryNew(dbRun, {
    path: String(path || '').trim(),
    mtime: Number(mtime) || Date.now(),
    status: String(status || 'pending'),
  }, redis);
}

module.exports = {
  upsertThumbStatusBatch,
  upsertThumbStatusSingle,
};