/**
 * @file timer-manager.js
 * @module core/timer-manager
 * @description
 * 轻量级定时器管理器，专注于命名关键定时器的统一注册、清理与防泄漏，避免定时器重复和遗留。
 */

/**
 * 命名定时器映射表
 * @type {Map<string, number>}
 * @private
 * @description
 * 存储所有已注册的命名定时器（timeout/interval），以便统一管理和清理。
 */
const namedTimers = new Map();

/**
 * 在页面卸载前自动清理所有命名定时器，防止内存泄漏。
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event
 */
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
        for (const timerId of namedTimers.values()) {
            try {
                // 同时调用 clearTimeout 和 clearInterval 是安全的
                clearTimeout(timerId);
                clearInterval(timerId);
            } catch (error) {
                // 忽略清理异常
            }
        }
        namedTimers.clear();
    });
}

/**
 * 注册一个命名的超时定时器（setTimeout），同名定时器会被覆盖。
 * @function setManagedTimeout
 * @param {Function} callback - 定时器到期时执行的回调函数
 * @param {number} delay - 延迟时间（毫秒）
 * @param {string} name - 定时器名称（唯一标识）
 * @returns {number} 定时器ID
 * @throws {Error} 参数不合法时抛出异常
 */
export function setManagedTimeout(callback, delay, name) {
    if (typeof callback !== 'function') {
        throw new Error('callback must be a function');
    }
    if (typeof delay !== 'number' || delay < 0) {
        throw new Error('delay must be a non-negative number');
    }
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('name must be a non-empty string');
    }

    // 清理同名旧定时器
    if (namedTimers.has(name)) {
        clearTimeout(namedTimers.get(name));
    }

    const timerId = setTimeout(() => {
        namedTimers.delete(name);
        try {
            callback();
        } catch (error) {
            // eslint-disable-next-line no-console
            console.warn(`[TimerManager] 定时器回调执行出错 '${name}':`, error);
        }
    }, delay);

    namedTimers.set(name, timerId);
    return timerId;
}

/**
 * 注册一个命名的间隔定时器（setInterval），同名定时器会被覆盖。
 * @function setManagedInterval
 * @param {Function} callback - 每次间隔时执行的回调函数
 * @param {number} interval - 间隔时间（毫秒）
 * @param {string} name - 定时器名称（唯一标识）
 * @returns {number} 定时器ID
 * @throws {Error} 参数不合法时抛出异常
 */
export function setManagedInterval(callback, interval, name) {
    if (typeof callback !== 'function') {
        throw new Error('callback must be a function');
    }
    if (typeof interval !== 'number' || interval <= 0) {
        throw new Error('interval must be a positive number');
    }
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('name must be a non-empty string');
    }

    // 清理同名旧定时器
    if (namedTimers.has(name)) {
        clearInterval(namedTimers.get(name));
    }

    const wrappedCallback = () => {
        try {
            callback();
        } catch (error) {
            // eslint-disable-next-line no-console
            console.warn(`[TimerManager] 间隔定时器回调执行出错 '${name}':`, error);
        }
    };

    const timerId = setInterval(wrappedCallback, interval);
    namedTimers.set(name, timerId);
    return timerId;
}

/**
 * 清理指定名称的超时定时器（setTimeout）。
 * @function clearManagedTimeout
 * @param {string} name - 定时器名称
 * @throws {Error} 参数不合法时抛出异常
 */
export function clearManagedTimeout(name) {
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('name must be a non-empty string');
    }

    if (namedTimers.has(name)) {
        clearTimeout(namedTimers.get(name));
        namedTimers.delete(name);
    }
}

/**
 * 清理指定名称的间隔定时器（setInterval）。
 * @function clearManagedInterval
 * @param {string} name - 定时器名称
 * @throws {Error} 参数不合法时抛出异常
 */
export function clearManagedInterval(name) {
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('name must be a non-empty string');
    }

    if (namedTimers.has(name)) {
        clearInterval(namedTimers.get(name));
        namedTimers.delete(name);
    }
}

/**
 * 检查指定名称的定时器（timeout/interval）是否已注册。
 * @function hasManagedTimer
 * @param {string} name - 定时器名称
 * @returns {boolean} 是否存在该命名定时器
 * @throws {Error} 参数不合法时抛出异常
 */
export function hasManagedTimer(name) {
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('name must be a non-empty string');
    }

    return namedTimers.has(name);
}
