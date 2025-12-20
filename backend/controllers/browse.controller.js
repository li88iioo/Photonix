/**
 * 浏览控制器模块
 * 处理文件浏览相关的请求，包括目录内容获取和访问时间更新
 */
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { TraceManager } = require('../utils/trace');
const { PHOTOS_DIR } = require('../config');
const { getDirectoryContents } = require('../services/file.service');
const manualSyncScheduler = require('../services/manualSyncScheduler.service');

/**
 * 浏览目录内容
 * 获取指定目录下的文件和子目录，支持分页和用户访问记录
 * @param {Object} req - Express请求对象，包含路径参数和查询参数
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应，包含目录内容、分页信息和总数
 */
exports.browseDirectory = async (req, res) => {
    // 仅信任认证中间件注入的用户ID；未认证统一为 anonymous
    const userId = (req.user && req.user.id) ? String(req.user.id) : 'anonymous';
    // 从中间件获取已经过验证和清理的路径
    const sanitizedPath = req.sanitizedPath;

    // 获取分页限制，默认50项
    const limit = parseInt(req.query.limit, 10) || 50;
    // 获取页码，默认第1页
    const page = parseInt(req.query.page, 10) || 1;
    const sort = req.query.sort || 'smart';

    try {
        // 获取目录内容，路径验证已由中间件完成
        const { items, totalPages, totalResults, coverRecoveryCount } = await getDirectoryContents(sanitizedPath, page, limit, userId, sort);

        // 检查是否有封面缺失的相册（未索引完成时会有占位符封面）
        const hasIncompleteCover = items.some(item =>
            item.type === 'album' &&
            (!item.data?.coverUrl || item.data.coverUrl.startsWith('data:'))
        );

        // 检查结果是否为空（可能索引正在进行中）
        const isEmptyResult = !items || items.length === 0;

        // 检查索引/同步是否正在进行中
        let isSyncRunning = false;
        try {
            const syncStatus = manualSyncScheduler.getStatus();
            isSyncRunning = syncStatus && syncStatus.running === true;
        } catch (e) {
            // 如果获取状态失败，保守地不阻止缓存
            logger.debug('获取同步状态失败，忽略同步检查', e && e.message);
        }

        // 如果满足以下任一条件，使用短缓存时间（10秒）：
        // 1. 有封面缺失（未索引完成时会有占位符封面）
        // 2. 结果为空（可能索引正在进行中）
        // 3. 同步/索引正在进行中（避免缓存部分结果）
        if (hasIncompleteCover || isEmptyResult || isSyncRunning || (coverRecoveryCount || 0) > 0) {
            res.setHeader('X-Cache-TTL', '10'); // 通知缓存中间件使用短 TTL
            res.setHeader('Cache-Control', 'public, max-age=10');
        }
        if ((coverRecoveryCount || 0) > 0) {
            res.setHeader('X-No-Cache', 'true');
        }

        // 构建响应数据
        const responseData = { items, page, totalPages, totalResults };

        // 返回目录内容
        res.json(responseData);
    } catch (error) {
        // 捕获服务层抛出的路径不存在等错误
        if (error.message.includes('路径未找到')) {
            return res.status(404).json({ code: 'PATH_NOT_FOUND', message: error.message, requestId: req.requestId });
        }
        // 对于其他未知错误，传递给全局错误处理器
        throw error;
    }
};
