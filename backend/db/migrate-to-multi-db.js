const sqlite3 = require('sqlite3').verbose();
const { 
    DB_FILE, 
    SETTINGS_DB_FILE, 
    HISTORY_DB_FILE, 
    INDEX_DB_FILE 
} = require('../config');
const logger = require('../config/logger');
const { initializeConnections } = require('./multi-db');
const { initializeAllDBs } = require('./migrations');
const fs = require('fs');
const path = require('path');
const MIGRATION_MARK = path.join(path.dirname(DB_FILE), '.migration_done');

/**
 * 数据迁移脚本：将单一数据库迁移到多数据库架构
 */
async function migrateToMultiDB() {
    logger.info('开始数据迁移：从单一数据库到多数据库架构...');
    
    try {
        // 1. 检查源数据库是否存在
        const sourceDB = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READONLY, (err) => {
            if (err) {
                logger.error('源数据库不存在或无法访问:', err.message);
                return;
            }
        });
        
        // 2. 初始化新的多数据库连接
        await initializeConnections();
        await initializeAllDBs();
        
        // 3. 迁移设置数据
        await migrateSettings(sourceDB);
        
        // 4. 迁移历史记录数据
        await migrateHistory(sourceDB);
        
        // 5. 迁移索引状态数据（如果有）
        await migrateIndexData(sourceDB);
        
        // 6. 关闭源数据库连接
        sourceDB.close((err) => {
            if (err) {
                logger.error('关闭源数据库连接失败:', err.message);
            } else {
                logger.info('源数据库连接已关闭');
            }
        });
        
        logger.info('数据迁移完成！');
        logger.info('新的数据库文件：');
        logger.info(`- 主数据库（图片/视频索引）: ${DB_FILE}`);
        logger.info(`- 设置数据库: ${SETTINGS_DB_FILE}`);
        logger.info(`- 历史记录数据库: ${HISTORY_DB_FILE}`);
        logger.info(`- 索引数据库: ${INDEX_DB_FILE}`);
        
    } catch (error) {
        logger.error('数据迁移失败:', error.message);
        throw error;
    }
}

/**
 * 迁移设置数据
 */
async function migrateSettings(sourceDB) {
    return new Promise((resolve, reject) => {
        logger.info('开始迁移设置数据...');
        
        sourceDB.all("SELECT key, value FROM settings", [], async (err, rows) => {
            if (err) {
                logger.error('读取设置数据失败:', err.message);
                return reject(err);
            }
            
            if (rows.length === 0) {
                logger.info('没有设置数据需要迁移');
                return resolve();
            }
            
            try {
                const { dbRun } = require('./multi-db');
                
                // 批量插入设置数据
                await dbRun('settings', 'BEGIN TRANSACTION');
                
                for (const row of rows) {
                    await dbRun('settings', 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [row.key, row.value]);
                }
                
                await dbRun('settings', 'COMMIT');
                
                logger.info(`成功迁移 ${rows.length} 条设置数据`);
                resolve();
            } catch (error) {
                await dbRun('settings', 'ROLLBACK').catch(() => {});
                logger.error('迁移设置数据失败:', error.message);
                reject(error);
            }
        });
    });
}

/**
 * 迁移历史记录数据
 */
async function migrateHistory(sourceDB) {
    return new Promise((resolve, reject) => {
        logger.info('开始迁移历史记录数据...');
        
        sourceDB.all("SELECT user_id, item_path, viewed_at FROM view_history", [], async (err, rows) => {
            if (err) {
                logger.error('读取历史记录数据失败:', err.message);
                return reject(err);
            }
            
            if (rows.length === 0) {
                logger.info('没有历史记录数据需要迁移');
                return resolve();
            }
            
            try {
                const { dbRun } = require('./multi-db');
                
                // 批量插入历史记录数据
                await dbRun('history', 'BEGIN TRANSACTION');
                
                for (const row of rows) {
                    await dbRun('history', 'INSERT OR REPLACE INTO view_history (user_id, item_path, viewed_at) VALUES (?, ?, ?)', 
                        [row.user_id, row.item_path, row.viewed_at]);
                }
                
                await dbRun('history', 'COMMIT');
                
                logger.info(`成功迁移 ${rows.length} 条历史记录数据`);
                resolve();
            } catch (error) {
                await dbRun('history', 'ROLLBACK').catch(() => {});
                logger.error('迁移历史记录数据失败:', error.message);
                reject(error);
            }
        });
    });
}

/**
 * 迁移索引状态数据（如果有）
 */
async function migrateIndexData(sourceDB) {
    return new Promise((resolve, reject) => {
        logger.info('检查是否有索引状态数据需要迁移...');
        
        // 检查是否有索引相关的表
        sourceDB.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%index%'", [], async (err, tables) => {
            if (err) {
                logger.error('检查索引表失败:', err.message);
                return reject(err);
            }
            
            if (tables.length === 0) {
                logger.info('没有索引状态数据需要迁移');
                return resolve();
            }
            
            logger.info(`发现 ${tables.length} 个索引相关表，但当前版本不需要迁移索引数据`);
            resolve();
        });
    });
}

/**
 * 备份原数据库
 */
async function backupOriginalDB() {
    try {
        const backupPath = DB_FILE.replace('.db', '_backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.db');
        await fs.promises.copyFile(DB_FILE, backupPath);
        logger.info(`原数据库已备份到: ${backupPath}`);
        return backupPath;
    } catch (error) {
        logger.error('备份原数据库失败:', error.message);
        throw error;
    }
}

// 检查是否为老结构（如只有 gallery.db，没有 settings/history/index db）
function isOldStructure() {
    return fs.existsSync(DB_FILE) && 
        (!fs.existsSync(SETTINGS_DB_FILE) || !fs.existsSync(HISTORY_DB_FILE) || !fs.existsSync(INDEX_DB_FILE));
}

// 如果直接运行此脚本
if (require.main === module) {
    (async () => {
        try {
            if (isOldStructure()) {
                // 先备份原数据库
                await backupOriginalDB();
                // 执行迁移
                await migrateToMultiDB();
                // 写入迁移标记
                fs.writeFileSync(MIGRATION_MARK, new Date().toISOString());
                logger.info('数据迁移脚本执行完成');
            } else {
                logger.info('数据库结构已是多库架构，无需迁移，无需备份。');
            }
            process.exit(0);
        } catch (error) {
            logger.error('数据迁移脚本执行失败:', error.message);
            process.exit(1);
        }
    })();
}

module.exports = {
    migrateToMultiDB,
    backupOriginalDB
}; 