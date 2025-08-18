/**
 * 浏览控制器模块
 * 处理文件浏览相关的请求，包括目录内容获取和访问时间更新
 */
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { PHOTOS_DIR } = require('../config');
const { historyWorker } = require('../services/worker.manager');
const { getDirectoryContents } = require('../services/file.service');

/**
 * 浏览目录内容
 * 获取指定目录下的文件和子目录，支持分页和用户访问记录
 * @param {Object} req - Express请求对象，包含路径参数和查询参数
 * @param {Object} res - Express响应对象
 * @returns {Object} JSON响应，包含目录内容、分页信息和总数
 */
exports.browseDirectory = async (req, res) => {
    // 从请求头获取用户ID，用于访问记录
    const userId = req.headers['x-user-id'];
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

/**
 * 更新文件访问时间
 * 记录用户访问特定文件或目录的时间，用于历史记录功能
 * @param {Object} req - Express请求对象，包含用户ID和文件路径
 * @param {Object} res - Express响应对象
 * @returns {Object} 204状态码表示成功，或错误信息
 */
exports.updateViewTime = async (req, res) => {
    // 从请求头获取用户ID
    const userId = req.headers['x-user-id'];
    if (!userId) {
        return res.status(400).json({ code: 'MISSING_USER_ID', message: '缺少用户ID', requestId: req.requestId });
    }

    // 从中间件获取已经过验证和清理的路径
    const sanitizedPath = req.sanitizedPath;

    try {
        // 向历史记录工作线程发送更新访问时间的消息
        historyWorker.postMessage({ 
            type: 'update_view_time', 
            payload: { userId, path: sanitizedPath } 
        });

        // 返回204状态码表示成功（无内容）
        res.status(204).send();
    } catch (error) {
        // 内网穿透环境下，即使历史记录更新失败，也不应该影响用户体验
        logger.warn(`更新访问时间失败，但继续处理请求: ${error.message}`);
        // 仍然返回成功，因为这是非关键操作
        res.status(204).send();
    }
};