/**
 * repositories/indexStatus.repo.js
 * 职责：封装 index_status 与 index_progress 的数据访问
 * - 统一 SQL / 错误处理，供业务与编排层复用
 */
const { dbGet, dbRun } = require('../db/multi-db');

async function getIndexStatus() {
  // 返回 index_status.status 或 null
  try {
    const row = await dbGet('index', "SELECT status FROM index_status WHERE id = 1");
    return row ? row.status : null;
  } catch {
    return null;
  }
}

async function setIndexStatus(status) {
  try {
    await dbRun('index', "INSERT INTO index_status(id, status) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status", [String(status || '')]);
  } catch {}
}

async function getProcessedFiles() {
  // 返回 index_status.processed_files 或 0
  try {
    const row = await dbGet('index', "SELECT processed_files FROM index_status WHERE id = 1");
    return row ? Number(row.processed_files || 0) : 0;
  } catch {
    return 0;
  }
}

async function setProcessedFiles(count) {
  try {
    const n = Math.max(0, parseInt(count || 0, 10));
    await dbRun('index', "INSERT INTO index_status(id, processed_files) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET processed_files=excluded.processed_files", [n]);
  } catch {}
}

async function getResumeValue(key) {
  try {
    const row = await dbGet('index', "SELECT value FROM index_progress WHERE key = ?", [String(key || '')]);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

async function setResumeValue(key, value) {
  try {
    await dbRun('index', "INSERT INTO index_progress(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(key || ''), String(value || '')]);
  } catch {}
}

async function deleteResumeKey(key) {
  try {
    await dbRun('index', "DELETE FROM index_progress WHERE key = ?", [String(key || '')]);
  } catch {}
}

async function getIndexStatusRow() {
  try {
    const row = await dbGet('index', "SELECT status, processed_files, total_files, last_updated FROM index_status WHERE id = 1");
    return row || null;
  } catch {
    return null;
  }
}

module.exports = {
  getIndexStatus,
  setIndexStatus,
  getProcessedFiles,
  setProcessedFiles,
  getResumeValue,
  setResumeValue,
  deleteResumeKey,
  getIndexStatusRow,
};