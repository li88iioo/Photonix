const { 
    runAsync, 
    dbAll, 
    hasColumn, 
    hasTable 
} = require('./multi-db');
const logger = require('../config/logger');

// 主数据库迁移（图片/视频索引）
const initializeMainDB = async () => {
    try {
        // 创建 migrations 记录表
        await runAsync('main', `CREATE TABLE IF NOT EXISTS migrations (key TEXT PRIMARY KEY, applied_at DATETIME NOT NULL)`);

        const mainMigrations = [
            {
                key: 'create_items_table',
                sql: `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, type TEXT NOT NULL, cover_path TEXT, last_viewed_at DATETIME)`
            },
            {
                key: 'create_thumb_status_table',
                sql: `CREATE TABLE IF NOT EXISTS thumb_status (
                    path TEXT PRIMARY KEY,
                    mtime INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'pending',
                    last_checked INTEGER DEFAULT 0
                )`
            },
            {
                // 旧版本可能缺少 last_checked 列，这里补齐
                key: 'add_last_checked_column_thumb_status',
                sql: `ALTER TABLE thumb_status ADD COLUMN last_checked INTEGER DEFAULT 0`,
                check: async () => !(await hasColumn('main', 'thumb_status', 'last_checked'))
            },
            {
                key: 'create_idx_thumb_status_status',
                sql: `CREATE INDEX IF NOT EXISTS idx_thumb_status_status ON thumb_status(status)`
            },
            {
                key: 'create_idx_thumb_status_mtime',
                sql: `CREATE INDEX IF NOT EXISTS idx_thumb_status_mtime ON thumb_status(mtime)`
            },
            {
                key: 'create_album_covers_table',
                sql: `CREATE TABLE IF NOT EXISTS album_covers (
                    album_path TEXT PRIMARY KEY,
                    cover_path TEXT NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL,
                    mtime INTEGER NOT NULL
                );` ,
                check: async () => !(await hasTable('main', 'album_covers'))
            },
            {
                key: 'create_idx_album_covers_album_path',
                sql: `CREATE INDEX IF NOT EXISTS idx_album_covers_album_path ON album_covers(album_path)`,
                check: async () => (await hasTable('main', 'album_covers'))
            },
            {
                key: 'add_cover_path_column',
                sql: `ALTER TABLE items ADD COLUMN cover_path TEXT`,
                check: async () => !(await hasColumn('main', 'items', 'cover_path'))
            },
            {
                key: 'add_last_viewed_at_column',
                sql: `ALTER TABLE items ADD COLUMN last_viewed_at DATETIME`,
                check: async () => !(await hasColumn('main', 'items', 'last_viewed_at'))
            },
            {
                key: 'add_mtime_column',
                sql: `ALTER TABLE items ADD COLUMN mtime INTEGER`,
                check: async () => !(await hasColumn('main', 'items', 'mtime'))
            },
            {
                key: 'add_width_column',
                sql: `ALTER TABLE items ADD COLUMN width INTEGER`,
                check: async () => !(await hasColumn('main', 'items', 'width'))
            },
            {
                key: 'add_height_column',
                sql: `ALTER TABLE items ADD COLUMN height INTEGER`,
                check: async () => !(await hasColumn('main', 'items', 'height'))
            },
            {
                key: 'create_items_fts',
                sql: `CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(name, content='items', content_rowid='id', tokenize = "unicode61")`
            },
            // 统一由应用层维护 FTS，移除触发器避免重复写与噪声
            { key: 'drop_trigger_items_ai', sql: `DROP TRIGGER IF EXISTS items_ai` },
            { key: 'drop_trigger_items_ad', sql: `DROP TRIGGER IF EXISTS items_ad` },
            { key: 'drop_trigger_items_au', sql: `DROP TRIGGER IF EXISTS items_au` },
            {
                key: 'drop_idx_items_type',
                sql: `DROP INDEX IF EXISTS idx_items_type`
            },
            {
                key: 'create_idx_items_type_id',
                sql: `CREATE INDEX IF NOT EXISTS idx_items_type_id ON items(type, id)`
            },
            {
                key: 'create_idx_items_mtime',
                sql: `CREATE INDEX IF NOT EXISTS idx_items_mtime ON items(mtime)`
            },
            {
                key: 'create_idx_items_filename',
                sql: `CREATE INDEX IF NOT EXISTS idx_items_filename ON items(name)`
            },
            {
                key: 'create_idx_items_path_type',
                sql: `CREATE INDEX IF NOT EXISTS idx_items_path_type ON items(path, type)`
            },
            {
                key: 'create_idx_items_type_mtime',
                sql: `CREATE INDEX IF NOT EXISTS idx_items_type_mtime ON items(type, mtime)`
            },
            {
                key: 'create_idx_items_path',
                sql: `CREATE INDEX IF NOT EXISTS idx_items_path ON items(path)`
            },
            {
                key: 'create_idx_items_type_path',
                sql: `CREATE INDEX IF NOT EXISTS idx_items_type_path ON items(type, path)`
            }
        ];

        await executeMigrations('main', mainMigrations);
        logger.info('主数据库迁移完成');
    } catch (error) {
        logger.error('主数据库迁移失败:', error && (error.stack || error.message));
        throw error;
    }
};

// 设置数据库迁移
const initializeSettingsDB = async () => {
    try {
        await runAsync('settings', `CREATE TABLE IF NOT EXISTS migrations (key TEXT PRIMARY KEY, applied_at DATETIME NOT NULL)`);
        const settingsMigrations = [
            {
                key: 'create_settings_table',
                sql: `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT)`
            },
            {
                key: 'initialize_default_settings',
                sql: `
                    INSERT OR IGNORE INTO settings (key, value) VALUES
                    ('AI_ENABLED', 'false'),
                    ('PASSWORD_ENABLED', 'false'),
                    ('PASSWORD_HASH', ''),
                    ('ALLOW_PUBLIC_ACCESS', 'true');
                `
            }
        ];
        await executeMigrations('settings', settingsMigrations);
        logger.info('设置数据库迁移完成');
    } catch (error) {
        logger.error('设置数据库迁移失败:', error.message);
        throw error;
    }
};

// 历史记录数据库迁移
const initializeHistoryDB = async () => {
    try {
        await runAsync('history', `CREATE TABLE IF NOT EXISTS migrations (key TEXT PRIMARY KEY, applied_at DATETIME NOT NULL)`);

        const historyMigrations = [
            {
                key: 'create_view_history_table',
                sql: `CREATE TABLE IF NOT EXISTS view_history (user_id TEXT NOT NULL, item_path TEXT NOT NULL, viewed_at DATETIME NOT NULL, PRIMARY KEY (user_id, item_path))`
            },
            {
                key: 'create_idx_view_history_user_id',
                sql: `CREATE INDEX IF NOT EXISTS idx_view_history_user_id ON view_history(user_id)`
            },
            {
                key: 'create_idx_view_history_viewed_at',
                sql: `CREATE INDEX IF NOT EXISTS idx_view_history_viewed_at ON view_history(viewed_at)`
            }
        ];

        await executeMigrations('history', historyMigrations);
        logger.info('历史记录数据库迁移完成');
    } catch (error) {
        logger.error('历史记录数据库迁移失败:', error.message);
        throw error;
    }
};

// 索引数据库迁移
const initializeIndexDB = async () => {
    try {
        await runAsync('index', `CREATE TABLE IF NOT EXISTS migrations (key TEXT PRIMARY KEY, applied_at DATETIME NOT NULL)`);

        const indexMigrations = [
            {
                key: 'create_index_status_table',
                sql: `CREATE TABLE IF NOT EXISTS index_status (id INTEGER PRIMARY KEY, status TEXT NOT NULL, progress REAL DEFAULT 0, total_files INTEGER DEFAULT 0, processed_files INTEGER DEFAULT 0, last_updated DATETIME DEFAULT CURRENT_TIMESTAMP)`
            },
            {
                key: 'create_index_queue_table',
                sql: `CREATE TABLE IF NOT EXISTS index_queue (id INTEGER PRIMARY KEY, file_path TEXT NOT NULL UNIQUE, priority INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, processed_at DATETIME)`
            },
            {
                key: 'create_idx_index_queue_priority',
                sql: `CREATE INDEX IF NOT EXISTS idx_index_queue_priority ON index_queue(priority DESC, created_at)`
            }
        ];

        await executeMigrations('index', indexMigrations);
        logger.info('索引数据库迁移完成');
    } catch (error) {
        logger.error('索引数据库迁移失败:', error.message);
        throw error;
    }
};

// 执行迁移的通用函数
const executeMigrations = async (dbType, migrations) => {
    for (const migration of migrations) {
        const done = await dbAll(dbType, "SELECT 1 FROM migrations WHERE key = ?", [migration.key]);
        const needRun = migration.check ? await migration.check() : true;
        
        if (!done.length && needRun) {
            await runAsync(dbType, migration.sql);
            await runAsync(dbType, "INSERT INTO migrations (key, applied_at) VALUES (?, ?)", [migration.key, new Date().toISOString()]);
            logger.info(`[${dbType.toUpperCase()} MIGRATION] 执行迁移: ${migration.key}`);
        }
    }
};

// 初始化所有数据库
const initializeAllDBs = async () => {
    try {
        logger.info('开始初始化所有数据库...');
        // 顺序初始化以避免原生库在高并发下的潜在竞态
        await initializeMainDB();
        await initializeSettingsDB();
        await initializeHistoryDB();
        await initializeIndexDB();
        logger.info('所有数据库初始化完成');
    } catch (error) {
        logger.error('数据库初始化失败:', error && (error.stack || error.message));
        throw error;
    }
};

module.exports = {
    initializeAllDBs,
    initializeMainDB,
    initializeSettingsDB,
    initializeHistoryDB,
    initializeIndexDB,
    // 额外导出：核心表兜底确保（可在服务启动序列中调用，幂等）
    ensureCoreTables: async () => {
        try {
            // 主表兜底创建（幂等）
            await runAsync('main', `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, type TEXT NOT NULL, cover_path TEXT, last_viewed_at DATETIME)`);
            await runAsync('main', `CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(name, content='items', content_rowid='id', tokenize = "unicode61")`);
            await runAsync('main', `CREATE TABLE IF NOT EXISTS album_covers (
                album_path TEXT PRIMARY KEY,
                cover_path TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                mtime INTEGER NOT NULL
            );`);
            await runAsync('main', `CREATE INDEX IF NOT EXISTS idx_album_covers_album_path ON album_covers(album_path)`);
        } catch (e) {
            logger.warn('[MIGRATIONS] ensureCoreTables 兜底创建失败（可忽略，迁移已处理）：', e && e.message);
        }
    }
}; 