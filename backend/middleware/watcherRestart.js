/**
 * @fileoverview 文件监听器自动重启中间件
 *
 * 该中间件用于检测用户活动，在监听器意外停止后自动重启，防止文件变化未被及时捕获。
 * 通过节流机制（throttle）避免监听器频繁重启。
 *
 * 功能说明：
 * - 侦测用户的相关 API 活动或主页访问，判断是否需要检查监听器状态
 * - 如监听器停止且冷却时间已过，则自动触发重启
 * - 重启操作不阻塞原有请求流程
 *
 * @module middleware/watcherRestart
 */

const logger = require('../config/logger');
const state = require('../services/state.manager');

/**
 * 监听器重启函数实例，在应用初始化时设置
 * @type {Function|null}
 */
let watcherRestartFn = null;

/** 
 * 监听器重启的节流时长（单位：毫秒），30秒内不重复重启 
 * @type {number}
 */
const RESTART_THROTTLE_MS = 30000;

/**
 * 设置监听器重启函数
 * @param {Function} restartFn 重启监听器的函数
 */
function setWatcherRestartFunction(restartFn) {
    watcherRestartFn = restartFn;
}

/**
 * 监听器自动重启中间件
 *
 * 若检测到用户活动且监听器未运行，并满足节流条件，则自动重启监听器。
 * 仅在如下路径下触发检查：
 * - /api/photos* （照片相关 API）
 * - /api/albums* （相册相关 API）
 * - /            （首页）
 * - /api/stats   （统计信息 API）
 *
 * @param {import('express').Request} req  请求对象
 * @param {import('express').Response} res 响应对象
 * @param {import('express').NextFunction} next 下一步中间件
 * @returns {void}
 */
function watcherRestartMiddleware(req, res, next) {
    // 判断当前请求路径，决定是否需要进行监听器状态检查
    const shouldCheck =
        req.path.startsWith('/api/photos') ||  // 照片相关API
        req.path.startsWith('/api/albums') ||  // 相册相关API
        req.path === '/' ||                    // 首页
        req.path === '/api/stats';             // 统计信息

    if (!shouldCheck) {
        return next();
    }

    // 调用状态管理器，使用节流策略检查是否可尝试重启
    if (!state.watcher.shouldAttemptRestart(RESTART_THROTTLE_MS)) {
        return next();
    }

    // 若设置了监听器重启函数，异步尝试重启（不阻塞现有请求）
    if (watcherRestartFn) {
        setImmediate(() => {
            try {
                watcherRestartFn();
            } catch (err) {
                logger.debug('[监听器中间件] 重启监听器失败:', err.message);
            }
        });
    }

    next();
}

module.exports = {
    watcherRestartMiddleware,
    setWatcherRestartFunction
};
