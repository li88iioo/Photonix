const Database = require('better-sqlite3');
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
 * 数据迁移主函数：执行从单一数据库到多数据库架构的迁移流程
 */
async function migrateToMultiDB() {
    logger.info('开始数据迁移：从单一数据库到多数据库架构...');

    let sourceDB = null;
    try {
        // 步骤1：检查并打开源数据库（只读模式）
        sourceDB = new Database(DB_FILE, { readonly: true });
        logger.info('源数据库已打开（只读模式）');

        // 步骤2：初始化目标多数据库连接并迁移结构
        await initializeConnections();
        await initializeAllDBs();

        // 步骤3：迁移设置数据
        await migrateSettings(sourceDB);

        // 步骤4：迁移历史记录数据
        await migrateHistory(sourceDB);

        // 步骤5：迁移索引状态数据（如有需要）
        await migrateIndexData(sourceDB);

        // 步骤6：关闭源数据库连接
        sourceDB.close();
        logger.info('源数据库连接已关闭');

        logger.info('数据迁移完成！');
        logger.info('新的数据库文件如下所示：');
        logger.info(`- 主数据库（图片/视频索引）: ${DB_FILE}`);
        logger.info(`- 设置数据库: ${SETTINGS_DB_FILE}`);
        logger.info(`- 历史记录数据库: ${HISTORY_DB_FILE}`);
        logger.info(`- 索引数据库: ${INDEX_DB_FILE}`);

    } catch (error) {
        logger.error('数据迁移失败:', error.message);
        if (sourceDB) {
            try {
                sourceDB.close();
            } catch (closeErr) {
                logger.debug('关闭源数据库失败:', closeErr.message);
            }
        }
        throw error;
    }
}

/**
 * 迁移设置表(settings)的数据
 * @param {Database} sourceDB - 源数据库连接（better-sqlite3）
 */
async function migrateSettings(sourceDB) {
    logger.info('开始迁移设置数据...');

    try {
        // 使用 better-sqlite3 同步读取
        const rows = sourceDB.prepare("SELECT key, value FROM settings").all();

        if (rows.length === 0) {
            logger.info('没有设置数据需要迁移');
            return;
        }

        const { dbRun } = require('./multi-db');

        // 启动事务进行批量插入
        await dbRun('settings', 'BEGIN TRANSACTION');

        try {
            for (const row of rows) {
                await dbRun(
                    'settings',
                    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
                    [row.key, row.value]
                );
            }

            await dbRun('settings', 'COMMIT');
            logger.info(`成功迁移 ${rows.length} 条设置数据`);
        } catch (error) {
            await dbRun('settings', 'ROLLBACK').catch(() => { });
            logger.error('迁移设置数据失败:', error.message);
            throw error;
        }
    } catch (error) {
        // 如果表不存在，记录警告但不中断迁移
        if (error.message.includes('no such table')) {
            logger.warn('源数据库中没有 settings 表，跳过设置数据迁移');
            return;
        }
        throw error;
    }
}

/**
 * 迁移历史记录表(view_history)的数据
 * @param {Database} sourceDB - 源数据库连接（better-sqlite3）
 */
async function migrateHistory(sourceDB) {
    logger.info('开始迁移历史记录数据...');

    try {
        // 使用 better-sqlite3 同步读取
        const rows = sourceDB.prepare("SELECT user_id, item_path, viewed_at FROM view_history").all();

        if (rows.length === 0) {
            logger.info('没有历史记录数据需要迁移');
            return;
        }

        const { dbRun } = require('./multi-db');

        // 启动事务进行批量插入
        await dbRun('history', 'BEGIN TRANSACTION');

        try {
            for (const row of rows) {
                await dbRun(
                    'history',
                    'INSERT OR REPLACE INTO view_history (user_id, item_path, viewed_at) VALUES (?, ?, ?)',
                    [row.user_id, row.item_path, row.viewed_at]
                );
            }

            await dbRun('history', 'COMMIT');
            logger.info(`成功迁移 ${rows.length} 条历史记录数据`);
        } catch (error) {
            await dbRun('history', 'ROLLBACK').catch(() => { });
            logger.error('迁移历史记录数据失败:', error.message);
            throw error;
        }
    } catch (error) {
        // 如果表不存在，记录警告但不中断迁移
        if (error.message.includes('no such table')) {
            logger.warn('源数据库中没有 view_history 表，跳过历史记录迁移');
            return;
        }
        throw error;
    }
}

/**
 * 迁移索引相关表的数据（如有）（当前实现仅检测，无数据复制）
 * @param {Database} sourceDB - 源数据库连接（better-sqlite3）
 */
async function migrateIndexData(sourceDB) {
    logger.info('检查是否有索引状态数据需要迁移...');

    try {
        // 检测是否存在索引相关表
        const tables = sourceDB.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%index%'"
        ).all();

        if (tables.length === 0) {
            logger.info('没有索引状态数据需要迁移');
            return;
        }

        logger.info(`发现 ${tables.length} 个索引相关表，但当前版本不需要迁移索引数据`);
    } catch (error) {
        logger.error('检查索引表失败:', error.message);
        // 不中断迁移，仅记录错误
    }
}

/**
 * 备份原数据库文件，名称中包含时间戳
 * @returns {Promise<string>} 备份文件的路径
 */
async function backupOriginalDB() {
    try {
        const backupPath =
            DB_FILE.replace('.db', '_backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.db');
        await fs.promises.copyFile(DB_FILE, backupPath);
        logger.info(`原数据库已备份到: ${backupPath}`);
        return backupPath;
    } catch (error) {
        logger.error('备份原数据库失败:', error.message);
        throw error;
    }
}

/**
 * 判断当前是否为"老结构"数据库
 * 仅有主库文件，无多库结构时返回 true
 * @returns {boolean}
 */
function isOldStructure() {
    return (
        fs.existsSync(DB_FILE) &&
        (!fs.existsSync(SETTINGS_DB_FILE) || !fs.existsSync(HISTORY_DB_FILE) || !fs.existsSync(INDEX_DB_FILE))
    );
}

// 脚本入口：若直接运行本文件则执行迁移
if (require.main === module) {
    (async () => {
        try {
            if (isOldStructure()) {
                // 先备份原数据库
                await backupOriginalDB();
                // 执行数据库迁移
                await migrateToMultiDB();
                // 记录迁移标志文件
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

// 导出主迁移函数和备份函数，便于外部调用或测试
module.exports = {
    migrateToMultiDB,
    backupOriginalDB
};