/**
 * 路径工具模块
 * 提供路径安全性检查和清理功能，防止路径遍历攻击和恶意路径访问
 */
const path = require('path');
const { PHOTOS_DIR } = require('../config');
const logger = require('../config/logger');

/**
 * 检查路径是否安全
 * 验证请求的路径是否在允许的安全目录范围内，防止路径遍历攻击
 * @param {string} requestedPath - 请求的路径
 * @returns {boolean} 如果路径安全返回true，否则返回false
 */
function isPathSafe(requestedPath) {
    // 获取安全基础目录的绝对路径
    const safeBaseDir = path.resolve(PHOTOS_DIR);
    // 解析请求路径相对于安全目录的绝对路径
    const resolvedPath = path.resolve(safeBaseDir, requestedPath);
    
    // 检查解析后的路径是否在安全目录范围内
    // 使用路径分隔符确保精确匹配，避免绕过检查
    const isSafe = resolvedPath.startsWith(safeBaseDir + path.sep) || resolvedPath === safeBaseDir;
    
    // 如果路径不安全，记录警告日志
    if (!isSafe) {
        logger.warn(`检测到不安全的路径访问尝试: 请求的路径 "${requestedPath}" 解析到了安全目录之外的 "${resolvedPath}"`);
    }
    
    return isSafe;
}

/**
 * 清理和标准化路径
 * 移除路径中的危险字符和序列，确保路径格式正确
 * @param {string} inputPath - 输入的路径字符串
 * @returns {string} 清理后的安全路径，如果输入无效则返回空字符串
 */
function sanitizePath(inputPath) {
    // 检查输入类型，如果不是字符串则返回空字符串
    if (typeof inputPath !== 'string') return '';
    
    return inputPath
        .replace(/\.\./g, '')           // 移除所有 ".." 序列，防止目录遍历
        .replace(/[<>:"|?*]/g, '')      // 移除Windows和Unix系统的非法字符
        .replace(/^\/+/, '')            // 移除开头的斜杠
        .replace(/\/{2,}/g, '/')        // 将多个连续斜杠替换为单个斜杠
        .replace(/\/$/, '');            // 移除末尾的斜杠
}

// 导出路径工具函数
module.exports = {
    isPathSafe,    // 路径安全检查函数
    sanitizePath   // 路径清理函数
};