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
        const { items, totalPages, totalResults } = await getDirectoryContents(sanitizedPath, page, limit, userId, sort);

        // 检查是否有封面缺失的相册（未索引完成时会有占位符封面）
        const hasIncompleteCover = items.some(item =>
            item.type === 'album' &&
            (!item.data?.coverUrl || item.data.coverUrl.startsWith('data:'))
        );

        // 如果有封面缺失，设置响应头阻止缓存,避免索引完成前的响应被长期缓存
        if (hasIncompleteCover) {
            res.setHeader('X-No-Cache', 'true');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
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
