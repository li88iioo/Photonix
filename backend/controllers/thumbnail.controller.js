/**
 * 缩略图控制器模块
 * 处理缩略图相关的请求，包括缩略图生成、缓存控制和状态管理
 */
const path = require('path');
const { promises: fsPromises } = require('fs');
const { PHOTOS_DIR, THUMBS_DIR } = require('../config');
const { ensureThumbnailExists } = require('../services/thumbnail.service');
const { isPathSafe } = require('../utils/path.utils');

// --- 动态SVG生成函数 ---

/**
 * 生成“加载中”占位符SVG
 * @returns {string} SVG代码字符串
 */
function getLoadingPlaceholderSvg() {
    return `
    <svg width="120" height="50" viewBox="0 0 120 50" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" fill="#C084FC">
        <circle cx="25" cy="25" r="10">
            <animate attributeName="cy" dur="0.8s" values="25;15;25" begin="0s" repeatCount="indefinite" />
        </circle>
        <circle cx="60" cy="25" r="10">
            <animate attributeName="cy" dur="0.8s" values="25;15;25" begin="0.2s" repeatCount="indefinite" />
        </circle>
        <circle cx="95" cy="25" r="10">
            <animate attributeName="cy" dur="0.8s" values="25;15;25" begin="0.4s" repeatCount="indefinite" />
        </circle>
    </svg>`;
}

/**
 * 生成“图片损坏”占位符SVG
 * @returns {string} SVG代码字符串
 */
function getBrokenImageSvg() {
    return `
    <svg width="80" height="80" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <style>
            .glitch-group {
                animation: glitch-animation 0.3s infinite;
            }
            @keyframes glitch-animation {
                0% { transform: translate(0, 0); }
                20% { transform: translate(-2px, 1px); }
                40% { transform: translate(2px, -1px); }
                60% { transform: translate(-1px, 2px); }
                80% { transform: translate(1px, -2px); }
                100% { transform: translate(0, 0); }
            }
        </style>
        <g class="glitch-group">
            <path d="M 20 75 L 40 55 L 55 70 L 70 60 L 80 75" fill="none" stroke="#ccc" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
            <circle cx="65" cy="35" r="7" fill="#ccc"/>
        </g>
        <rect x="5" y="45" width="90" height="10" fill="#C084FC" opacity="0">
            <animate attributeName="opacity" values="0;1;0" dur="0.8s" repeatCount="indefinite" begin="0.2s"/>
        </rect>
        <rect x="5" y="60" width="90" height="5" fill="#C084FC" opacity="0">
            <animate attributeName="opacity" values="0;1;0" dur="1.2s" repeatCount="indefinite" />
        </rect>
    </svg>`;
}

/**
 * 获取缩略图
 * 根据源文件路径生成或获取缩略图，支持不同的处理状态和缓存控制
 * @param {Object} req - Express请求对象，包含path查询参数
 * @param {Object} res - Express响应对象
 * @returns {Object} 文件响应或错误状态码
 */
exports.getThumbnail = async (req, res) => {
        // 获取相对路径参数
        const relativePath = req.query.path;
        
        // 验证路径参数是否存在且安全
        if (!relativePath || !isPathSafe(relativePath)) {
            return res.status(400).json({ code: 'INVALID_OR_UNSAFE_PATH', message: 'Invalid or unsafe path', requestId: req.requestId });
        }

        // 构建源文件的绝对路径
        const sourceAbsPath = path.join(PHOTOS_DIR, relativePath);
        
        // 确保缩略图存在，获取处理状态
        const { status } = await ensureThumbnailExists(sourceAbsPath, relativePath);

        // 根据缩略图处理状态返回不同的响应
        switch (status) {
            case 'exists':
                // 缩略图已存在：设置长期缓存，返回缩略图文件
                res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
                // 修复：使用新的镜像路径结构
                const isVideo = /\.(mp4|webm|mov)$/i.test(relativePath);
                const extension = isVideo ? '.jpg' : '.webp';
                const thumbRelPath = relativePath.replace(/\.[^.]+$/, extension);
                const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);

                // 条件请求支持：ETag / Last-Modified
                try {
                    const stats = await fsPromises.stat(thumbAbsPath);
                    const lastModified = stats.mtime.toUTCString();
                    const etag = `W/"${stats.size}-${Number(stats.mtimeMs).toString(16)}"`;
                    res.setHeader('Last-Modified', lastModified);
                    res.setHeader('ETag', etag);
                    const ifNoneMatch = req.headers['if-none-match'];
                    const ifModifiedSince = req.headers['if-modified-since'];
                    const notModified = (ifNoneMatch && ifNoneMatch === etag) || (ifModifiedSince && new Date(ifModifiedSince).getTime() >= stats.mtime.getTime());
                    if (notModified) {
                        return res.status(304).end();
                    }
                } catch {}

                return res.sendFile(thumbAbsPath);
                
            case 'processing':
                // 缩略图正在处理中：设置不缓存，返回占位符图片
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                // 保持图像响应，但也带上 JSON 提示头方便前端判定
                res.setHeader('X-Thumb-Status', 'processing');
                res.type('image/svg+xml').status(202).send(getLoadingPlaceholderSvg());
                break;
                
            case 'failed':
                // 缩略图生成失败：设置不缓存，返回损坏图片占位符
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.setHeader('X-Thumb-Status', 'failed');
                res.type('image/svg+xml').status(500).send(getBrokenImageSvg());
                break;
            default:
                return res.status(500).json({ code: 'UNKNOWN_STATUS', message: 'Unknown thumbnail status', requestId: req.requestId });
        }
};