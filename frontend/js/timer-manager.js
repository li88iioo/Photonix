// frontend/js/timer-manager.js
// 轻量级定时器管理器 - 解决关键定时器泄漏问题

/**
 * 简化的定时器管理器
 * 只处理需要命名的关键定时器，避免过度抽象
 */

// 存储命名定时器的简单映射
const namedTimers = new Map();

// 页面卸载时清理所有命名定时器
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
        for (const timerId of namedTimers.values()) {
            try {
                // 安全清理：同时调用clearTimeout和clearInterval是安全的
                clearTimeout(timerId);
                clearInterval(timerId);
            } catch (error) {
                // 静默忽略清理错误
            }
        }
        namedTimers.clear();
    });
}

/**
 * 创建命名超时定时器
 * @param {Function} callback - 回调函数
 * @param {number} delay - 延迟时间(毫秒)
 * @param {string} name - 定时器名称，用于防止重复和清理
 * @returns {number} 定时器ID
 */
export function setManagedTimeout(callback, delay, name) {
    // 参数验证
    if (typeof callback !== 'function') {
        throw new Error('callback must be a function');
    }
    if (typeof delay !== 'number' || delay < 0) {
        throw new Error('delay must be a non-negative number');
    }
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('name must be a non-empty string');
    }

    // 如果已存在同名定时器，先清理
    if (namedTimers.has(name)) {
        clearTimeout(namedTimers.get(name));
    }

    const timerId = setTimeout(() => {
        namedTimers.delete(name);
        try {
            callback();
        } catch (error) {
            console.warn(`[TimerManager] 定时器回调执行出错 '${name}':`, error);
        }
    }, delay);

    namedTimers.set(name, timerId);
    return timerId;
}

/**
 * 创建命名间隔定时器
 * @param {Function} callback - 回调函数
 * @param {number} interval - 间隔时间(毫秒)
 * @param {string} name - 定时器名称，用于防止重复和清理
 * @returns {number} 定时器ID
 */
export function setManagedInterval(callback, interval, name) {
    // 参数验证
    if (typeof callback !== 'function') {
        throw new Error('callback must be a function');
    }
    if (typeof interval !== 'number' || interval <= 0) {
        throw new Error('interval must be a positive number');
    }
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('name must be a non-empty string');
    }

    // 如果已存在同名定时器，先清理
    if (namedTimers.has(name)) {
        clearInterval(namedTimers.get(name));
    }

    const wrappedCallback = () => {
        try {
            callback();
        } catch (error) {
            console.warn(`[TimerManager] 间隔定时器回调执行出错 '${name}':`, error);
        }
    };

    const timerId = setInterval(wrappedCallback, interval);
    namedTimers.set(name, timerId);
    return timerId;
}

/**
 * 清理命名定时器
 * @param {string} name - 定时器名称
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
 * 清理命名间隔定时器
 * @param {string} name - 定时器名称
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
 * 检查命名定时器是否存在
 * @param {string} name - 定时器名称
 * @returns {boolean} 是否存在
 */
export function hasManagedTimer(name) {
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('name must be a non-empty string');
    }

    return namedTimers.has(name);
}
