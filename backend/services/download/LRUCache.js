/**
 * @file LRUCache.js
 * @description LRU (Least Recently Used) 缓存实现，用于限制内存使用
 */

class LRUCache {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  /**
   * 获取缓存项
   * @param {string} key 
   * @returns {any}
   */
  get(key) {
    if (!this.cache.has(key)) {
      return undefined;
    }
    
    // 将访问的项移到最后（最近使用）
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  /**
   * 在不更新使用顺序的情况下读取缓存项
   * @param {string} key
   * @returns {any}
   */
  peek(key) {
    return this.cache.get(key);
  }

  /**
   * 设置缓存项
   * @param {string} key 
   * @param {any} value 
   */
  set(key, value) {
    // 如果已存在，先删除（会重新添加到最后）
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // 达到最大容量，删除最老的项（第一个）
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, value);
  }

  /**
   * 检查是否存在
   * @param {string} key 
   * @returns {boolean}
   */
  has(key) {
    return this.cache.has(key);
  }

  /**
   * 删除缓存项
   * @param {string} key 
   * @returns {boolean}
   */
  delete(key) {
    return this.cache.delete(key);
  }

  /**
   * 清空缓存
   */
  clear() {
    this.cache.clear();
  }

  /**
   * 获取缓存大小
   * @returns {number}
   */
  get size() {
    return this.cache.size;
  }

  /**
   * 获取所有值
   * @returns {Array}
   */
  values() {
    return Array.from(this.cache.values());
  }

  /**
   * 获取所有键
   * @returns {Array}
   */
  keys() {
    return Array.from(this.cache.keys());
  }

  /**
   * 获取所有条目
   * @returns {Array}
   */
  entries() {
    return Array.from(this.cache.entries());
  }
}

module.exports = LRUCache;
