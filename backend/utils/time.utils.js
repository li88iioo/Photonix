/**
 * 时间处理工具函数模块
 */

/**
 * 获取当前时间戳（毫秒）
 * @returns {number} 当前时间戳（毫秒）
 */
function getCurrentTimestampMs() {
    return Date.now();
}

/**
 * 获取SQLite当前时间戳表达式（毫秒）
 * @returns {string} SQLite时间戳表达式
 */
function getSQLiteCurrentTimestampMs() {
    return "strftime('%s','now')*1000";
}

/**
 * 时间转换工具函数
 */
const timeUtils = {
    /**
     * 秒转毫秒
     * @param {number} seconds - 秒数
     * @returns {number} 毫秒数
     */
    seconds: (seconds) => seconds * 1000,

    /**
     * 分转毫秒
     * @param {number} minutes - 分钟数
     * @returns {number} 毫秒数
     */
    minutes: (minutes) => minutes * 60 * 1000,

    /**
     * 小时转毫秒
     * @param {number} hours - 小时数
     * @returns {number} 毫秒数
     */
    hours: (hours) => hours * 60 * 60 * 1000,
};

/**
 * 常用时间常量
 */
const TIME_CONSTANTS = {
    SECOND_MS: 1000,
    MINUTE_MS: 60 * 1000,
    HOUR_MS: 60 * 60 * 1000,
    DAY_MS: 24 * 60 * 60 * 1000,

    // 常用超时时间
    SHORT_TIMEOUT_MS: 30 * 1000,      // 30秒
    MEDIUM_TIMEOUT_MS: 5 * 60 * 1000, // 5分钟
    LONG_TIMEOUT_MS: 20 * 60 * 1000,  // 20分钟

    // 常用延迟时间
    QUICK_DELAY_MS: 1000,             // 1秒
    MEDIUM_DELAY_MS: 5000,            // 5秒
    SLOW_DELAY_MS: 30000,             // 30秒
};

module.exports = {
    getCurrentTimestampMs,
    getSQLiteCurrentTimestampMs,
    timeUtils,
    TIME_CONSTANTS,
};
