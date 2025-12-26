/**
 * 路径工具模块
 * 提供路径安全性检查和清理功能，防止路径遍历攻击和恶意路径访问
 */
const path = require('path');
const { PHOTOS_DIR } = require('../config');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;

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

    // 统一使用正斜杠进行比较，避免 Windows 路径分隔符导致的绕过
    const normalizedSafe = safeBaseDir.replace(/\\/g, '/');
    const normalizedResolved = resolvedPath.replace(/\\/g, '/');

    // 检查解析后的路径是否在安全目录范围内
    const isSafe = normalizedResolved.startsWith(normalizedSafe + '/') ||
        normalizedResolved === normalizedSafe;

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
 * @returns {string} 清理后的安全路径，如果输入包含危险模式则返回空字符串
 */
function sanitizePath(inputPath) {
    // 第一步：类型检查
    if (typeof inputPath !== 'string') return '';

    // 第二步：早期拒绝明显的危险模式
    // 拒绝任何包含 ".." 的输入（无论位置），因为它代表向上遍历意图
    // 拒绝以 "." 开头的路径（隐藏文件/目录，如 .git, .env）
    // 注意：空字符串是合法的（代表根目录），不应被拒绝
    const rawSegments = inputPath.split(/[\\/]/).filter(Boolean);
    if (rawSegments.some(segment => segment === '..' || segment === '.')) {
        logger.warn(`路径清理：拒绝危险模式: "${inputPath}"`);
        return '';
    }
    if (rawSegments.length > 0 && rawSegments[0].startsWith('.') && rawSegments[0].length > 1) {
        logger.warn(`路径清理：拒绝隐藏路径: "${inputPath}"`);
        return '';
    }

    // 第三步：处理空字符串特殊情况
    // path.normalize('') 会返回 '.'，但空字符串在我们的场景中代表根目录
    if (inputPath === '' || inputPath === '/') {
        return '';
    }

    // 第四步：使用 path.normalize 规范化路径（处理 .、多余斜杠）
    let normalized = path.normalize(inputPath);

    // 第五步：移除危险字符和规范化斜杠
    normalized = normalized
        .replace(/[<>:"|?*\x00-\x1f]/g, '')  // 移除控制字符、Windows/Unix非法字符
        .replace(/^[\/\\]+/, '')              // 移除开头的斜杠（支持Windows反斜杠）
        .replace(/[\/\\]{2,}/g, '/')          // 将多个连续斜杠/反斜杠替换为单个正斜杠
        .replace(/[\/\\]+$/, '');             // 移除末尾的斜杠

    // 第六步：二次验证（防御性编程）
    // path.normalize 在某些边缘情况下可能产生 ".."，再次检查
    // 拒绝 ".." 和以 "." 开头的路径（但允许空字符串通过，因为它在第三步已经被处理）
    const segments = normalized.split(/[\\/]/).filter(Boolean);
    if (segments.some(segment => segment === '..' || segment === '.')) {
        logger.warn(`路径清理：规范化后仍包含危险模式: "${inputPath}" → "${normalized}"`);
        return '';
    }

    return normalized;
}

// 导出路径工具函数
module.exports = {
    isPathSafe,    // 路径安全检查函数
    sanitizePath   // 路径清理函数
};