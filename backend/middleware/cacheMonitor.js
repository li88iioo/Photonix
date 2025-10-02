/**
 * 缓存性能监控中间件模块
 * 监控和分析缓存性能，提供优化建议
 */

const logger = require('../config/logger');
const { redis } = require('../config/redis');
const { QueryCacheOptimizer } = require('../services/queryOptimizer.service');

/**
 * 缓存性能监控器
 */
class CachePerformanceMonitor {
    constructor() {
        this.queryCacheOptimizer = new QueryCacheOptimizer(redis);
        this.requestPatterns = new Map();
        this.cacheEfficiency = {
            hits: 0,
            misses: 0,
            total: 0
        };
    }

    /**
     * 记录缓存请求
     * @param {string} cacheKey - 缓存键
     * @param {boolean} isHit - 是否命中
     * @param {number} responseTime - 响应时间（毫秒）
     */
    recordCacheRequest(cacheKey, isHit, responseTime) {
        this.cacheEfficiency.total++;

        if (isHit) {
            this.cacheEfficiency.hits++;
        } else {
            this.cacheEfficiency.misses++;
        }

        // 分析请求模式
        this.analyzeRequestPattern(cacheKey, isHit, responseTime);
    }

    /**
     * 分析请求模式
     * @param {string} cacheKey - 缓存键
     * @param {boolean} isHit - 是否命中
     * @param {number} responseTime - 响应时间
     */
    analyzeRequestPattern(cacheKey, isHit, responseTime) {
        try {
            // 提取路径模式
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
                        samples: []
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

                // 保持最近100个样本
                if (patternStats.samples.length > 100) {
                    patternStats.samples.shift();
                }

                // 计算平均响应时间
                patternStats.avgResponseTime = patternStats.samples.reduce((a, b) => a + b, 0) / patternStats.samples.length;
            }
        } catch (error) {
            logger.debug('分析请求模式失败:', error.message);
        }
    }

    /**
     * 提取路径模式
     * @param {string} path - 请求路径
     * @returns {string} 路径模式
     */
    extractPathPattern(path) {
        // 将具体ID替换为占位符
        return path
            .replace(/\/\d+/g, '/{id}')
            .replace(/\/[a-f0-9]{8,}/g, '/{uuid}')
            .replace(/\/[^/]+\.(jpg|png|webp|mp4|webm)/g, '/{filename}.{ext}');
    }

    /**
     * 获取缓存性能报告
     * @returns {Object} 性能报告
     */
    getPerformanceReport() {
        const hitRatio = this.cacheEfficiency.total > 0
            ? this.cacheEfficiency.hits / this.cacheEfficiency.total
            : 0;

        // 识别低效模式
        const inefficientPatterns = [];
        for (const [pattern, stats] of this.requestPatterns.entries()) {
            const patternHitRatio = stats.total > 0 ? stats.hits / stats.total : 0;
            if (patternHitRatio < 0.3 && stats.total > 10) {
                inefficientPatterns.push({
                    pattern,
                    hitRatio: patternHitRatio,
                    totalRequests: stats.total,
                    avgResponseTime: stats.avgResponseTime
                });
            }
        }

        return {
            overall: {
                hitRatio,
                totalRequests: this.cacheEfficiency.total,
                hits: this.cacheEfficiency.hits,
                misses: this.cacheEfficiency.misses
            },
            patterns: Array.from(this.requestPatterns.entries()).map(([pattern, stats]) => ({
                pattern,
                hitRatio: stats.total > 0 ? stats.hits / stats.total : 0,
                totalRequests: stats.total,
                avgResponseTime: Math.round(stats.avgResponseTime)
            })),
            inefficientPatterns,
            recommendations: this.generateRecommendations(hitRatio, inefficientPatterns)
        };
    }

    /**
     * 生成优化建议
     * @param {number} overallHitRatio - 整体命中率
     * @param {Array} inefficientPatterns - 低效模式
     * @returns {Array} 建议列表
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
                    '启用更智能的缓存失效机制'
                ]
            });
        }

        if (inefficientPatterns.length > 0) {
            recommendations.push({
                type: 'INEFFICIENT_PATTERNS',
                priority: 'MEDIUM',
                message: `发现 ${inefficientPatterns.length} 个低效缓存模式`,
                actions: inefficientPatterns.map(pattern =>
                    `优化模式 "${pattern.pattern}" 的缓存策略 (命中率: ${Math.round(pattern.hitRatio * 100)}%)`
                )
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
                    '优化内存使用'
                ]
            });
        }

        return recommendations;
    }

    /**
     * 重置监控数据
     */
    reset() {
        this.cacheEfficiency = { hits: 0, misses: 0, total: 0 };
        this.requestPatterns.clear();
        this.queryCacheOptimizer.resetStats();
    }
}

// 创建全局监控实例
const cacheMonitor = new CachePerformanceMonitor();

/**
 * 缓存监控中间件
 * @param {Object} options - 配置选项
 * @returns {Function} Express中间件函数
 */
function cacheMonitoring(options = {}) {
    return (req, res, next) => {
        const startTime = Date.now();
        const originalSend = res.send;
        const originalJson = res.json;

        // 记录响应
        const recordResponse = () => {
            const responseTime = Date.now() - startTime;
            const isCacheHit = res.getHeader('X-Cache') === 'HIT';

            // 构造缓存键用于分析
            const cacheKey = req.originalUrl;

            cacheMonitor.recordCacheRequest(cacheKey, isCacheHit, responseTime);
        };

        // 重写响应方法
        res.send = function(body) {
            recordResponse();
            return originalSend.call(this, body);
        };

        res.json = function(body) {
            recordResponse();
            return originalJson.call(this, body);
        };

        next();
    };
}

module.exports = {
    CachePerformanceMonitor,
    cacheMonitor,
    cacheMonitoring
};
