/**
 * 临时文件管理工具
 * 统一处理临时文件的创建、清理和管理
 */

const path = require('path');
const fs = require('fs').promises;
const logger = require('../config/logger');
const { THUMBS_DIR } = require('../config');

/**
 * 临时文件管理器类
 */
class TempFileManager {
    constructor() {
        this.tempDir = path.join(THUMBS_DIR, 'temp');
        this.processedFiles = new Set();
    }

    /**
     * 获取临时文件路径
     * @param {string} relativePath - 相对路径
     * @param {string} suffix - 文件后缀，如 'optimized_webp'
     * @returns {string} 临时文件完整路径
     */
    getTempFilePath(relativePath, suffix = '') {
        const dirPath = path.join(this.tempDir, path.dirname(relativePath));
        const ext = path.extname(relativePath);
        const baseName = path.basename(relativePath, ext);
        const tempName = suffix ? `${baseName}_${suffix}${ext}` : `${baseName}_temp${ext}`;
        return path.join(dirPath, tempName);
    }

    /**
     * 确保临时目录存在
     * @param {string} subDir - 子目录路径
     */
    async ensureTempDir(subDir = '') {
        const targetDir = subDir ? path.join(this.tempDir, subDir) : this.tempDir;
        try {
            await fs.mkdir(targetDir, { recursive: true });
        } catch (error) {
            logger.warn(`[TempFileManager] 创建临时目录失败: ${targetDir}`, error.message);
        }
    }

    /**
     * 清理临时文件
     * @param {string} filePath - 要清理的文件路径
     */
    async cleanupTempFile(filePath) {
        try {
            await fs.unlink(filePath);
            logger.debug(`[TempFileManager] 已清理临时文件: ${path.basename(filePath)}`);
        } catch (error) {
            // 只在非"文件不存在"错误时记录
            if (error.code !== 'ENOENT') {
                logger.debug(`[TempFileManager] 清理临时文件失败: ${path.basename(filePath)}`, error.message);
            }
        }
    }

    /**
     * 清理空的临时目录
     * @param {string} dirPath - 目录路径
     */
    async cleanupEmptyTempDir(dirPath) {
        try {
            const entries = await fs.readdir(dirPath);
            if (entries.length === 0) {
                await fs.rmdir(dirPath);
                logger.debug(`[TempFileManager] 已清理空临时目录: ${path.basename(dirPath)}`);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.debug(`[TempFileManager] 清理临时目录失败: ${path.basename(dirPath)}`, error.message);
            }
        }
    }

    /**
     * 批量清理临时文件和目录
     * @param {string} relativePath - 相对路径
     */
    async cleanupTempFiles(relativePath) {
        const tempDir = path.join(this.tempDir, relativePath);

        try {
            const entries = await fs.readdir(tempDir);
            const cleanupPromises = entries.map(async (entry) => {
                const entryPath = path.join(tempDir, entry);

                // 跳过临时文件
                if (entry.startsWith('temp_opt_') || entry.includes('.tmp')) {
                    return;
                }

                try {
                    const stat = await fs.stat(entryPath);
                    if (stat.isFile()) {
                        await this.cleanupTempFile(entryPath);
                    }
                } catch (error) {
                    // 忽略单个文件清理失败
                }
            });

            await Promise.all(cleanupPromises);

            // 检查目录是否为空，如果是则删除
            await this.cleanupEmptyTempDir(tempDir);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.debug(`[TempFileManager] 批量清理失败: ${relativePath}`, error.message);
            }
        }
    }

    /**
     * 检查文件是否为临时文件
     * @param {string} fileName - 文件名
     * @returns {boolean} 是否为临时文件
     */
    isTempFile(fileName) {
        return fileName.startsWith('temp_opt_') || fileName.includes('.tmp') || fileName.includes('_temp');
    }

    /**
     * 记录已处理的文件（用于去重）
     * @param {string} filePath - 文件路径
     */
    markAsProcessed(filePath) {
        this.processedFiles.add(filePath);
    }

    /**
     * 检查文件是否已处理
     * @param {string} filePath - 文件路径
     * @returns {boolean} 是否已处理
     */
    isProcessed(filePath) {
        return this.processedFiles.has(filePath);
    }

    /**
     * 清理处理记录（内存管理）
     * @param {number} maxSize - 最大记录数量
     */
    cleanupProcessedRecords(maxSize = 1000) {
        if (this.processedFiles.size > maxSize) {
            // 保留最近的记录
            const recentFiles = Array.from(this.processedFiles).slice(-maxSize);
            this.processedFiles = new Set(recentFiles);
        }
    }
}

// 创建单例实例
const tempFileManager = new TempFileManager();

module.exports = {
    TempFileManager,
    tempFileManager
};
