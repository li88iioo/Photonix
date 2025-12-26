/**
 * @file 缓存性能监控中间件模块
 * @description 用于监控和分析缓存的命中率、响应时间以及识别低效缓存模式，并提供优化建议
 */

const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const { redis } = require('../config/redis');
const { QueryCacheOptimizer } = require('../services/queryOptimizer.service');

/**
 * 缓存性能监控器类
 * 提供缓存命中率、低效模式分析与优化建议生成
 */
class CachePerformanceMonitor {
    constructor() {
        /**
         * 查询缓存优化器实例
         * @type {QueryCacheOptimizer}
         */
        this.queryCacheOptimizer = new QueryCacheOptimizer(redis);

        /**
         * 路由模式到统计数据的映射
         * @type {Map<string, {hits:number, misses:number, total:number, avgResponseTime:number, samples:number[]}>}
         */
        this.requestPatterns = new Map();

        /**
         * 缓存效率统计数据
         * @type {{hits: number, misses: number, total: number}}
         */
        this.cacheEfficiency = {
            hits: 0,
            misses: 0,
            total: 0,
        };
    }

    /**
     * 记录一次缓存请求（命中/未命中/响应时间），并分析模式
     * @param {string} cacheKey 缓存键
     * @param {boolean} isHit 是否命中缓存
     * @param {number} responseTime 响应时间（毫秒）
     * @returns {void}
     */
    recordCacheRequest(cacheKey, isHit, responseTime) {
        this.cacheEfficiency.total++;
        if (isHit) {
            this.cacheEfficiency.hits++;
        } else {
            this.cacheEfficiency.misses++;
        }
        this.analyzeRequestPattern(cacheKey, isHit, responseTime);
    }

    /**
     * 分析当前请求的模式，将路径抽象成模板，累计相关统计数据
     * @param {string} cacheKey 缓存键
     * @param {boolean} isHit 是否命中
     * @param {number} responseTime 响应时间（毫秒）
     * @returns {void}
     */
    analyzeRequestPattern(cacheKey, isHit, responseTime) {
        try {
            // 只分析 route_cache: 前缀的缓存key（默认本项目的路由缓存结构）
            const pathMatch = cacheKey.match(/route_cache:[^:]+:(.+)/);
            if (pathMatch) {
                const path = pathMatch[1];
                const pattern = this.extractPathPattern(path);

                if (!this.requestPatterns.has(pattern)) {
                    this.requestPatterns.set(pattern, {
                        hits: 0,
                        misses: 0,
                        total: 0,
                        avgResponseTime: 0,
                        samples: [],
                    });
                }

                const patternStats = this.requestPatterns.get(pattern);
                patternStats.total++;
                patternStats.samples.push(responseTime);

                if (isHit) {
                    patternStats.hits++;
                } else {
                    patternStats.misses++;
                }

                // 仅保留最近100个响应时间样本用于计算平均
                if (patternStats.samples.length > 100) {
                    patternStats.samples.shift();
                }

                patternStats.avgResponseTime = patternStats.samples.reduce((a, b) => a + b, 0) / patternStats.samples.length;
            }
        } catch (error) {
            logger.debug('分析请求模式失败:', error.message);
        }
    }

    /**
     * 将路径中与业务相关的动态ID/UUID/文件名模式进行归一化
     * @param {string} path 原始请求路径
     * @returns {string} 抽象后的路径模式
     */
    extractPathPattern(path) {
        // 将数字ID、UUID、静态资源文件名归一化为占位符
        return path
            .replace(/\/\d+/g, '/{id}')
            .replace(/\/[a-f0-9]{8,}/g, '/{uuid}')
            .replace(/\/[^/]+\.(jpg|png|webp|mp4|webm)/g, '/{filename}.{ext}');
    }

    /**
     * 获取缓存性能的详细报告，包括总体和各模式命中率、低效模式与建议
     * @returns {object} 缓存性能报告
     */
    getPerformanceReport() {
        const hitRatio = this.cacheEfficiency.total > 0
            ? this.cacheEfficiency.hits / this.cacheEfficiency.total
            : 0;

        /** @type {Array<{pattern:string,hitRatio:number,totalRequests:number,avgResponseTime:number}>} */
        const inefficientPatterns = [];
        for (const [pattern, stats] of this.requestPatterns.entries()) {
            const patternHitRatio = stats.total > 0 ? stats.hits / stats.total : 0;
            if (patternHitRatio < 0.3 && stats.total > 10) {
                inefficientPatterns.push({
                    pattern,
                    hitRatio: patternHitRatio,
                    totalRequests: stats.total,
                    avgResponseTime: stats.avgResponseTime,
                });
            }
        }

        return {
            overall: {
                hitRatio,
                totalRequests: this.cacheEfficiency.total,
                hits: this.cacheEfficiency.hits,
                misses: this.cacheEfficiency.misses,
            },
            patterns: Array.from(this.requestPatterns.entries()).map(([pattern, stats]) => ({
                pattern,
                hitRatio: stats.total > 0 ? stats.hits / stats.total : 0,
                totalRequests: stats.total,
                avgResponseTime: Math.round(stats.avgResponseTime),
            })),
            inefficientPatterns,
            recommendations: this.generateRecommendations(hitRatio, inefficientPatterns),
        };
    }

    /**
     * 根据命中率和低效模式列表生成优化建议
     * @param {number} overallHitRatio 总体命中率
     * @param {Array<{pattern: string, hitRatio: number, totalRequests: number, avgResponseTime: number}>} inefficientPatterns 低效缓存模式
     * @returns {Array<object>} 优化建议数组
     */
    generateRecommendations(overallHitRatio, inefficientPatterns) {
        const recommendations = [];

        if (overallHitRatio < 0.5) {
            recommendations.push({
                type: 'CACHE_EFFICIENCY',
                priority: 'HIGH',
                message: `缓存命中率过低 (${Math.round(overallHitRatio * 100)}%)，建议优化缓存策略`,
                actions: [
                    '增加缓存时间',
                    '优化缓存键生成策略',
                    '启用更智能的缓存失效机制',
                ],
            });
        }

        if (inefficientPatterns.length > 0) {
            recommendations.push({
                type: 'INEFFICIENT_PATTERNS',
                priority: 'MEDIUM',
                message: `发现 ${inefficientPatterns.length} 个低效缓存模式`,
                actions: inefficientPatterns.map(pattern =>
                    `优化模式 "${pattern.pattern}" 的缓存策略 (命中率: ${Math.round(pattern.hitRatio * 100)}%)`
                ),
            });
        }

        if (this.cacheEfficiency.total > 1000 && overallHitRatio > 0.8) {
            recommendations.push({
                type: 'CACHE_OPTIMIZATION',
                priority: 'LOW',
                message: '缓存性能良好，可以考虑进一步优化',
                actions: [
                    '启用压缩缓存',
                    '实现缓存预热机制',
                    '优化内存使用',
                ],
            });
        }

        return recommendations;
    }

    /**
     * 重置监控统计数据
     * @returns {void}
     */
    reset() {
        this.cacheEfficiency = { hits: 0, misses: 0, total: 0 };
        this.requestPatterns.clear();
        this.queryCacheOptimizer.resetStats();
    }
}

/**
 * 缓存监控全局单例
 * @type {CachePerformanceMonitor}
 */
const cacheMonitor = new CachePerformanceMonitor();

/**
 * 缓存监控 Express 中间件
 * 响应结束时记录一次请求的命中情况、响应时间等
 * @param {object} [options={}] 可配置项（保留扩展）
 * @returns {(req: import('express').Request, res: import('express').Response, next: Function) => void} Express中间件函数
 */
function cacheMonitoring(options = {}) {
    return (req, res, next) => {
        const startTime = Date.now();
        const originalSend = res.send;
        const originalJson = res.json;

        /**
         * 记录本次请求的缓存相关统计
         */
        const recordResponse = () => {
            const responseTime = Date.now() - startTime;
            const isCacheHit = res.getHeader('X-Cache') === 'HIT';

            // 此处以req.originalUrl作为cacheKey，若需更细致可根据缓存中间件生成规则对齐
            const cacheKey = req.originalUrl;

            cacheMonitor.recordCacheRequest(cacheKey, isCacheHit, responseTime);
        };

        // 包裹send，使之调用时自动记录缓存统计
        res.send = function (body) {
            recordResponse();
            return originalSend.call(this, body);
        };

        // 包裹json
        res.json = function (body) {
            recordResponse();
            return originalJson.call(this, body);
        };

        next();
    };
}

module.exports = {
    CachePerformanceMonitor,
    cacheMonitor,
    cacheMonitoring,
};
