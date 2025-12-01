/**
 * @file retry.js
 * @description 分布式错误重试管理器
 *
 * 功能特性：
 * - 指数退避算法（Exponential Backoff）
 * - Redis持久化重试计数（跨进程/重启可见）
 * - 自动清理过期标记
 * - 支持自动重试和手动重试两种模式
 */

const { redis } = require('../config/redis');
const { safeRedisIncr, safeRedisDel } = require('./helpers');
const logger = require('../config/logger');

/**
 * 分布式重试管理器
 */
class RetryManager {
    /**
     * 执行带自动重试的操作（推荐用法）
     *
     * @example
     * // 自动重试示例
     * const result = await RetryManager.executeWithRetry(
     *     () => someAsyncOperation(),
     *     {
     *         context: 'operation-name',
     *         maxRetries: 3,
     *         baseDelay: 1000,
     *         maxDelay: 30000
     *     }
     * );
     *
     * @param {Function} operation - 要执行的异步操作
     * @param {Object} options - 配置选项
     * @param {string} options.context - 操作上下文（用于日志和监控）
     * @param {number} [options.maxRetries=3] - 最大重试次数
     * @param {number} [options.baseDelay=1000] - 基础延迟（毫秒）
     * @param {number} [options.maxDelay=30000] - 最大延迟（毫秒）
     * @returns {Promise<any>} - 操作结果
     * @throws {Error} - 超过最大重试次数后抛出最后一次错误
     */
    static async executeWithRetry(operation, options = {}) {
        const {
            context = 'unknown',
            maxRetries = 3,
            baseDelay = 1000,
            maxDelay = 30000
        } = options;

        let lastError;

        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;

                if (attempt > maxRetries) {
                    logger.error(`${context} 操作最终失败（已达最大重试次数 ${maxRetries}）`, {
                        error: error.message,
                        stack: error.stack
                    });
                    throw error;
                }

                // 指数退避：baseDelay * 2^(attempt-1)，上限为 maxDelay
                const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);

                logger.warn(`${context} 操作失败，将在 ${delay}ms 后重试（第 ${attempt}/${maxRetries} 次重试）`, {
                    error: error.message,
                    attempt,
                    maxRetries,
                    nextDelay: delay
                });

                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        // 理论上不会到达这里，但TypeScript需要明确返回
        throw lastError;
    }

    /**
     * 使用Redis持久化的重试检查（手动重试控制）
     *
     * 适用场景：需要跨进程/重启保持重试状态
     *
     * @example
     * // 手动重试控制示例
     * try {
     *     await someOperation();
     * } catch (error) {
     *     const canRetry = await RetryManager.canRetryWithPersistence(
     *         error,
     *         'operation-name',
     *         3
     *     );
     *     if (canRetry) {
     *         return await someOperation(); // 重新尝试
     *     }
     *     throw error; // 放弃重试
     * }
     *
     * @param {Error} error - 错误对象
     * @param {string} context - 错误上下文（用作Redis键后缀）
     * @param {number} [maxRetries=3] - 最大重试次数
     * @returns {Promise<boolean>} - true: 应该重试, false: 已达上限，放弃重试
     */
    static async canRetryWithPersistence(error, context = '', maxRetries = 3) {
        // Redis不可用时降级为允许重试（由调用方控制）
        if (!redis || redis.isNoRedis) {
            logger.debug('[RetryManager] Redis 不可用，跳过持久化重试检查');
            return true;
        }

        try {
            const errorKey = `error_retry:${context}`;
            const retryCount = await safeRedisIncr(redis, errorKey, '错误重试计数') || 0;

            if (retryCount <= maxRetries) {
                // 指数退避：1s → 2s → 4s → 8s → 16s → 30s(上限)
                const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 30000);

                logger.warn(`${context} 操作失败（第 ${retryCount} 次重试），将延迟 ${delay}ms 后重试`, {
                    error: error.message,
                    retryCount,
                    maxRetries,
                    delay
                });

                await new Promise(resolve => setTimeout(resolve, delay));
                return true; // 允许重试
            } else {
                logger.error(`${context} 操作最终失败，已达到最大重试次数 ${maxRetries}`, {
                    error: error.message
                });

                // 清理错误标记，避免Redis中留下垃圾数据
                await safeRedisDel(redis, errorKey, '清理错误标记');
                return false; // 不再重试
            }
        } catch (e) {
            logger.error(`[RetryManager] 重试管理失败: ${e.message}`);
            // 发生异常时保守策略：不允许重试（避免无限循环）
            return false;
        }
    }

    /**
     * 手动重置重试计数器（管理接口）
     *
     * 用途：运维手动干预，重置失败任务的重试状态
     *
     * @param {string} context - 要重置的上下文
     * @returns {Promise<boolean>} - 是否重置成功
     */
    static async resetRetryCount(context) {
        // 清理降级计数（如果存在）
        if (RetryManager._fallbackCounts) {
            RetryManager._fallbackCounts.delete(context);
        }

        if (!redis || redis.isNoRedis) {
            logger.debug('[RetryManager] Redis 不可用，已清理本地降级计数');
            return true; // 降级计数已清理，视为成功
        }

        try {
            const errorKey = `error_retry:${context}`;
            await safeRedisDel(redis, errorKey, '重置重试计数');
            logger.debug(`[RetryManager] 已重置重试计数: ${context}`);
            return true;
        } catch (error) {
            logger.error(`[RetryManager] 重置重试计数失败: ${error.message}`);
            return false;
        }
    }

    /**
     * 获取当前重试状态（监控接口）
     *
     * @param {string} context - 查询的上下文
     * @returns {Promise<number|null>} - 当前重试次数，null表示无记录或Redis不可用
     */
    static async getRetryCount(context) {
        if (!redis || redis.isNoRedis) {
            // Redis 不可用时返回降级计数
            if (RetryManager._fallbackCounts) {
                return RetryManager._fallbackCounts.get(context) || 0;
            }
            return 0;
        }

        try {
            const errorKey = `error_retry:${context}`;
            const count = await redis.get(errorKey);
            return count ? parseInt(count, 10) : 0;
        } catch (error) {
            logger.error(`[RetryManager] 获取重试计数失败: ${error.message}`);
            // 查询失败时尝试返回降级计数
            if (RetryManager._fallbackCounts) {
                return RetryManager._fallbackCounts.get(context) || 0;
            }
            return null;
        }
    }

    /**
     * 清理过期的降级计数（内存管理）
     *
     * 适用场景：外部服务定期调用，防止降级计数 Map 内存泄漏
     *
     * @param {Array<string>} contexts - 要清理的上下文列表
     * @returns {number} - 清理的条目数
     */
    static clearFallbackCounts(contexts = []) {
        if (!RetryManager._fallbackCounts || contexts.length === 0) {
            return 0;
        }

        let cleared = 0;
        for (const context of contexts) {
            if (RetryManager._fallbackCounts.delete(context)) {
                cleared++;
            }
        }

        logger.debug(`[RetryManager] 清理了 ${cleared} 个降级计数条目`);
        return cleared;
    }

    /**
     * 增加重试计数并返回延迟信息（异步重试场景）
     *
     * 适用场景：需要自己控制延迟执行的异步重试（如 setTimeout 派发任务）
     *
     * @example
     * // 异步重试控制示例（缩略图服务）
     * const retryInfo = await RetryManager.incrementRetryCount('thumb:path/to/file', 3);
     * if (retryInfo.shouldRetry) {
     *     setTimeout(() => {
     *         dispatchTask(...);
     *     }, retryInfo.delay);
     * } else {
     *     markAsPermanentFailure();
     * }
     *
     * @param {string} context - 操作上下文（用作Redis键后缀）
     * @param {number} [maxRetries=3] - 最大重试次数
     * @param {number} [baseDelay=1000] - 基础延迟（毫秒）
     * @param {number} [maxDelay=30000] - 最大延迟（毫秒）
     * @returns {Promise<{shouldRetry: boolean, retryCount: number, delay: number}>}
     */
    static async incrementRetryCount(context = '', maxRetries = 3, baseDelay = 1000, maxDelay = 30000) {
        // Redis不可用时降级为本地内存计数（防止无限重试）
        if (!redis || redis.isNoRedis) {
            logger.warn('[RetryManager] Redis 不可用，使用内存降级计数（进程重启后丢失）');

            // 使用静态 Map 存储降级计数（仅当前进程有效）
            if (!RetryManager._fallbackCounts) {
                RetryManager._fallbackCounts = new Map();
            }

            const currentCount = (RetryManager._fallbackCounts.get(context) || 0) + 1;
            RetryManager._fallbackCounts.set(context, currentCount);

            if (currentCount <= maxRetries) {
                const delay = Math.min(baseDelay * Math.pow(2, currentCount - 1), maxDelay);
                return {
                    shouldRetry: true,
                    retryCount: currentCount,
                    delay
                };
            } else {
                // 达到上限，清理降级计数
                RetryManager._fallbackCounts.delete(context);
                return {
                    shouldRetry: false,
                    retryCount: currentCount,
                    delay: 0
                };
            }
        }

        try {
            const errorKey = `error_retry:${context}`;
            const retryCount = await safeRedisIncr(redis, errorKey, '错误重试计数') || 0;

            // 仅在首次失败时设置 TTL，避免持续失败导致 TTL 被不断刷新
            // 注意：INCR + EXPIRE 不是原子操作，但对于重试计数场景可以接受
            if (retryCount === 1) {
                await redis.expire(errorKey, 86400).catch(() => {}); // 24小时 = 86400秒
            }

            if (retryCount <= maxRetries) {
                // 指数退避：baseDelay * 2^(retryCount-1)，上限为 maxDelay
                const delay = Math.min(baseDelay * Math.pow(2, retryCount - 1), maxDelay);

                logger.debug(`[RetryManager] ${context} 重试计数增加至 ${retryCount}/${maxRetries}，建议延迟 ${delay}ms`);

                return {
                    shouldRetry: true,
                    retryCount,
                    delay
                };
            } else {
                logger.warn(`[RetryManager] ${context} 已达到最大重试次数 ${maxRetries}，清理计数器`);

                // 清理错误标记，避免Redis中留下垃圾数据
                await safeRedisDel(redis, errorKey, '清理错误标记');

                return {
                    shouldRetry: false,
                    retryCount,
                    delay: 0
                };
            }
        } catch (e) {
            logger.error(`[RetryManager] 增加重试计数失败: ${e.message}`);
            // 发生异常时保守策略：允许重试但返回基础延迟
            return {
                shouldRetry: true,
                retryCount: 0,
                delay: baseDelay
            };
        }
    }
}

module.exports = { RetryManager };
