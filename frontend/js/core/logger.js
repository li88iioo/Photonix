/**
 * @file logger.js
 * @description Photonix 前端统一日志工具，根据环境和日志级别进行条件输出
 * @module core/logger
 */

import { isDevelopment } from './constants.js';

/**
 * Logger 日志类，根据环境条件输出日志
 */
class Logger {
    constructor() {
        /**
         * 日志级别定义
         * @type {Object}
         * @property {number} DEBUG - 调试
         * @property {number} INFO - 信息
         * @property {number} WARN - 警告
         * @property {number} ERROR - 错误
         * @property {number} NONE - 不输出
         */
        this.levels = {
            DEBUG: 0,   // 调试
            INFO: 1,    // 信息
            WARN: 2,    // 警告
            ERROR: 3,   // 错误
            NONE: 4     // 不输出
        };

        /**
         * 当前日志级别
         * @type {number}
         */
        this.currentLevel = isDevelopment() ? this.levels.DEBUG : this.levels.WARN;
    }

    /**
     * 判断当前日志级别是否允许输出
     * @param {number} level - 日志级别
     * @returns {boolean} 是否允许输出
     */
    shouldLog(level) {
        return level >= this.currentLevel;
    }

    /**
     * 格式化日志消息，包含时间戳和模块名
     * @param {string} module - 模块名
     * @param {string} message - 日志内容
     * @param {*} [data] - 附加数据
     * @returns {string} 格式化后的日志字符串
     */
    formatMessage(module, message, data) {
        const timestamp = new Date().toISOString();
        let formatted = `[${timestamp}] [${module}] ${message}`;

        if (data !== undefined) {
            formatted += ` ${typeof data === 'object' ? JSON.stringify(data) : data}`;
        }

        return formatted;
    }

    /**
     * 输出调试级别日志
     * @param {string} module - 模块名
     * @param {string} message - 日志内容
     * @param {*} [data] - 附加数据
     * @returns {void}
     */
    debug(module, message, data) {
        if (this.shouldLog(this.levels.DEBUG)) {
            console.debug(this.formatMessage(module, message, data));
        }
    }

    /**
     * 输出信息级别日志
     * @param {string} module - 模块名
     * @param {string} message - 日志内容
     * @param {*} [data] - 附加数据
     * @returns {void}
     */
    info(module, message, data) {
        if (this.shouldLog(this.levels.INFO)) {
            console.info(this.formatMessage(module, message, data));
        }
    }

    /**
     * 输出警告级别日志
     * @param {string} module - 模块名
     * @param {string} message - 日志内容
     * @param {*} [data] - 附加数据
     * @returns {void}
     */
    warn(module, message, data) {
        if (this.shouldLog(this.levels.WARN)) {
            console.warn(this.formatMessage(module, message, data));
        }
    }

    /**
     * 输出错误级别日志
     * @param {string} module - 模块名
     * @param {string} message - 日志内容
     * @param {*} [data] - 附加数据
     * @returns {void}
     */
    error(module, message, data) {
        if (this.shouldLog(this.levels.ERROR)) {
            console.error(this.formatMessage(module, message, data));
        }
    }

    /**
     * 设置日志级别
     * @param {string|number} level - 日志级别（字符串或数字）
     * @returns {void}
     */
    setLevel(level) {
        if (typeof level === 'string') {
            level = this.levels[level.toUpperCase()] || this.levels.WARN;
        }
        this.currentLevel = level;
    }

    /**
     * 获取当前日志级别
     * @returns {number} 当前日志级别
     */
    getLevel() {
        return this.currentLevel;
    }
}

/**
 * 单例日志实例
 * @type {Logger}
 */
const logger = new Logger();

/**
 * 创建指定模块的日志工具
 * @param {string} moduleName - 模块名
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}} 日志方法集合
 */
export const createModuleLogger = (moduleName) => ({
    debug: (message, data) => logger.debug(moduleName, message, data),
    info: (message, data) => logger.info(moduleName, message, data),
    warn: (message, data) => logger.warn(moduleName, message, data),
    error: (message, data) => logger.error(moduleName, message, data)
});

/**
 * 导出主日志实例
 * @type {Logger}
 */
export default logger;

/**
 * 常用模块日志工具导出
 * @type {object}
 */
export const uiLogger = createModuleLogger('UI');
export const routerLogger = createModuleLogger('Router');
export const apiLogger = createModuleLogger('API');
export const authLogger = createModuleLogger('Auth');
export const cacheLogger = createModuleLogger('Cache');
export const securityLogger = createModuleLogger('Security');
export const performanceLogger = createModuleLogger('Performance');
export const mainLogger = createModuleLogger('Main');
export const modalLogger = createModuleLogger('Modal');
export const lazyloadLogger = createModuleLogger('Lazyload');
export const settingsLogger = createModuleLogger('Settings');
export const utilsLogger = createModuleLogger('Utils');
export const aiCacheLogger = createModuleLogger('AI-Cache');
export const eventLogger = createModuleLogger('EventManager');
export const listenersLogger = createModuleLogger('Listeners');
export const errorLogger = createModuleLogger('ErrorHandler');
export const searchLogger = createModuleLogger('SearchHistory');
export const eventBufferLogger = createModuleLogger('EventBuffer');
export const masonryLogger = createModuleLogger('Masonry');
export const loadingLogger = createModuleLogger('LoadingStates');
export const stateLogger = createModuleLogger('State');
export const indexeddbLogger = createModuleLogger('IndexedDB');
export const domLogger = createModuleLogger('DOM');
