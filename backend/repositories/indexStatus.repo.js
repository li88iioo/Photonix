/**
 * repositories/indexStatus.repo.js
 * 职责：封装 index_status 与 index_progress 的数据访问
 * - 统一 SQL / 错误处理，供业务与编排层复用
 */
const { dbGet, dbRun } = require('../db/multi-db');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;

async function getIndexStatus() {
  // 返回 index_status.status 或 null
  try {
    const row = await dbGet('index', "SELECT status FROM index_status WHERE id = 1");
    return row ? row.status : null;
  } catch (error) {
    logger.debug(`${LOG_PREFIXES.INDEX_STATUS_REPO} 读取索引状态失败: ${error && error.message}`);
    return null;
  }
}

async function setIndexStatus(status) {
  try {
    await dbRun('index', "INSERT INTO index_status(id, status, last_updated) VALUES(1, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET status=excluded.status, last_updated=CURRENT_TIMESTAMP", [String(status || '')]);
  } catch (err) {
    logger.debug(`${LOG_PREFIXES.INDEX_STATUS_REPO} 设置索引状态失败 (status=${status}): ${err.message}`);
  }
}

async function getProcessedFiles() {
  // 返回 index_status.processed_files 或 0
  try {
    const row = await dbGet('index', "SELECT processed_files FROM index_status WHERE id = 1");
    return row ? Number(row.processed_files || 0) : 0;
  } catch (error) {
    logger.debug(`${LOG_PREFIXES.INDEX_STATUS_REPO} 读取已处理文件数失败: ${error && error.message}`);
    return 0;
  }
}

async function setProcessedFiles(count) {
  try {
    const n = Math.max(0, parseInt(count || 0, 10));
    // 先尝试UPDATE，如果记录不存在则INSERT（避免覆盖已有的status）
    const result = await dbRun('index',
      "UPDATE index_status SET processed_files = ?, last_updated = CURRENT_TIMESTAMP WHERE id = 1",
      [n]
    );

    // 如果UPDATE没有影响任何行（记录不存在），则INSERT新记录
    if (!result || result.changes === 0) {
      await dbRun('index',
        "INSERT OR IGNORE INTO index_status(id, status, processed_files, last_updated) VALUES(1, 'idle', ?, CURRENT_TIMESTAMP)",
        [n]
      );
    }
  } catch (err) {
    logger.debug(`${LOG_PREFIXES.INDEX_STATUS_REPO} 设置已处理文件数失败 (count=${count}): ${err.message}`);
  }
}

async function setTotalFiles(count) {
  try {
    const n = Math.max(0, parseInt(count || 0, 10));
    const result = await dbRun('index',
      "UPDATE index_status SET total_files = ?, last_updated = CURRENT_TIMESTAMP WHERE id = 1",
      [n]
    );

    if (!result || result.changes === 0) {
      await dbRun('index',
        "INSERT OR IGNORE INTO index_status(id, status, total_files, last_updated) VALUES(1, 'idle', ?, CURRENT_TIMESTAMP)",
        [n]
      );
    }
  } catch (err) {
    logger.debug(`${LOG_PREFIXES.INDEX_STATUS_REPO} 设置总文件数失败 (count=${count}): ${err.message}`);
  }
}

async function getResumeValue(key) {
  try {
    const row = await dbGet('index', "SELECT value FROM index_progress WHERE key = ?", [String(key || '')]);
    return row ? row.value : null;
  } catch (error) {
    logger.debug(`${LOG_PREFIXES.INDEX_STATUS_REPO} 读取断点续传值失败 (key=${key}): ${error && error.message}`);
    return null;
  }
}

async function setResumeValue(key, value) {
  try {
    await dbRun('index', "INSERT INTO index_progress(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(key || ''), String(value || '')]);
  } catch (err) {
    logger.debug(`${LOG_PREFIXES.INDEX_STATUS_REPO} 设置断点续传值失败 (key=${key}): ${err.message}`);
  }
}

async function deleteResumeKey(key) {
  try {
    await dbRun('index', "DELETE FROM index_progress WHERE key = ?", [String(key || '')]);
  } catch (err) {
    logger.debug(`${LOG_PREFIXES.INDEX_STATUS_REPO} 删除断点续传键失败 (key=${key}): ${err.message}`);
  }
}

async function getIndexStatusRow() {
  try {
    const row = await dbGet('index', "SELECT status, processed_files, total_files, last_updated FROM index_status WHERE id = 1");
    return row || null;
  } catch (error) {
    logger.debug(`${LOG_PREFIXES.INDEX_STATUS_REPO} 读取索引状态行失败: ${error && error.message}`);
    return null;
  }
}

module.exports = {
  getIndexStatus,
  setIndexStatus,
  getProcessedFiles,
  setProcessedFiles,
  setTotalFiles,
  getResumeValue,
  setResumeValue,
  deleteResumeKey,
  getIndexStatusRow,
};
