/**
 * repositories/items.repo.js
 * 职责：封装 items 表的常用数据访问（小步引入，先提供 getIdByPath）
 */
const { dbGet } = require('../db/multi-db');

/**
 * 获取 items.id（通过 path）
 * @param {string} pathRel
 * @returns {Promise<number|null>}
 */
async function getIdByPath(pathRel) {
  try {
    const row = await dbGet('main', 'SELECT id FROM items WHERE path = ?', [String(pathRel || '')]);
    if (row && typeof row.id === 'number') return row.id;
    if (row && row.id != null) return Number(row.id) || null;
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  getIdByPath,
};