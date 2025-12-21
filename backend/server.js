/**
 * 后端服务器主入口文件
 *
 * 主要职责：
 * - 启动与初始化服务器
 * - 管理数据库连接
 * - 创建并管理工作线程池
 * - 检查文件系统权限
 * - 实现优雅关闭处理
 * - 统一错误处理与日志记录
 *
 * @module server
 * @author Photonix
 * @version 1.0.0
 */

const app = require('./app');
const logger = require('./config/logger');
const { validateCriticalConfig } = require('./config/validator');
const { handleUncaughtException, handleUnhandledRejection } = require('./middleware/errorHandler');
// 延后加载 Redis，避免无 Redis 环境下启动即触发连接
const { PORT, PHOTOS_DIR, DATA_DIR } = require('./config');
const { closeAllConnections } = require('./db/multi-db');
const { getCount } = require('./repositories/stats.repo');
const {
    initializeDirectories,
    handleDatabaseMigration,
    initializeDatabase,
    resetStuckProcessingTasks,
    healThumbnailsIfInconsistent,
    startServices,
    setupIndexingAndMonitoring
} = require('./services/startup-heal.service');

/**
 * 服务主启动流程
 * - 初始化目录与数据库
 * - 启动服务及后端进程
 * - 启动 HTTP 监听
 * @async
 */
async function startServer() {
    logger.info('后端服务正在启动...');

    try {
        // 1. 初始化目录结构
        await initializeDirectories();

        // 2. 处理数据库迁移
        await handleDatabaseMigration();

        // 3. 初始化数据库连接与结构
        await initializeDatabase();

        // 4. 校验关键参数配置
        await validateCriticalConfig();

        // 5. 缩略图一致性自愈检查与后台服务并发启动
        await Promise.allSettled([
            resetStuckProcessingTasks().catch((err) => {
                logger.debug('重置卡死任务失败（降噪）:', err && err.message);
            }),
            healThumbnailsIfInconsistent().catch((err) => {
                logger.debug('缩略图自愈检查异步失败（降噪）:', err && err.message);
            }),
            startServices().catch((err) => {
                logger.debug('后台服务启动流程捕获异常（忽略）:', err && err.message);
            })
        ])

            ;

        // 6. 启动 HTTP 服务监听
        app.listen(PORT, () => {
            logger.info(`服务已启动在 http://localhost:${PORT}`);
            logger.info(`照片目录: ${PHOTOS_DIR}`);
            logger.info(`数据目录: ${DATA_DIR}`);
        });

        // 7. 启动索引监控与监听
        await setupIndexingAndMonitoring();

        setTimeout(async () => {
            try {
                const itemCount = await getCount('items', 'main');
                const ftsCount = await getCount('items_fts', 'main');
                logger.debug(`索引状态检查 - items表: ${itemCount} 条记录, FTS表: ${ftsCount} 条记录`);
            } catch (error) {
                logger.debug('索引状态检查失败（降噪）：', error && error.message);
            }
        }, 10000);

    } catch (error) {
        logger.error('启动过程中发生致命错误:', error.message);
        process.exit(1);
    }
}

// 进程异常与信号处理
process.on('uncaughtException', handleUncaughtException);
process.on('unhandledRejection', handleUnhandledRejection);

process.on('SIGINT', async () => {
    logger.info('收到关闭信号，正在优雅关闭...');
    try {
        await closeAllConnections();
        logger.info('所有数据库连接已关闭');
        process.exit(0);
    } catch (error) {
        logger.error('关闭数据库连接时出错:', error.message);
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    logger.info('收到终止信号，正在优雅关闭...');
    try {
        await closeAllConnections();
        logger.info('所有数据库连接已关闭');
        process.exit(0);
    } catch (error) {
        logger.error('关闭数据库连接时出错:', error.message);
        process.exit(1);
    }
});

// 启动主流程
startServer();
