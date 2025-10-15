/**
 * 搜索控制器模块
 * 处理全文搜索相关的请求
 */
const { performSearch } = require('../services/search.service');
const { getCount } = require('../repositories/stats.repo');
const logger = require('../config/logger');

/**
 * 搜索文件和相册
 * @param {Object} req - Express请求对象，包含搜索查询参数
 * @param {Object} res - Express响应对象
 */
exports.searchItems = async (req, res) => {
    const query = (req.query.q || '').trim();
    if (!query) {
        return res.status(400).json({ code: 'INVALID_QUERY', message: '搜索关键词不能为空', requestId: req.requestId });
    }

    // 检查索引是否就绪（使用优化的getCount避免全表扫描）
    try {
        const itemCount = await getCount('items', 'main');
        const ftsCount = await getCount('items_fts', 'main');
        if (itemCount === 0 || ftsCount === 0) {
            return res.status(503).json({ code: 'SEARCH_UNAVAILABLE', message: '搜索索引正在构建中，请稍后再试', requestId: req.requestId });
        }
    } catch (error) {
        // 如果检查失败，也返回服务不可用，并记录错误
        logger.error('检查搜索索引状态时出错:', error);
        return res.status(503).json({ code: 'SEARCH_UNAVAILABLE', message: '无法验证搜索索引状态，请稍后重试', requestId: req.requestId });
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;

    // 调用服务层执行搜索
    const searchResult = await performSearch(query, page, limit);
    
    // 返回服务层处理好的结果
    res.json(searchResult);
};