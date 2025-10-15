/**
 * @file incremental-update.js
 * @description 增量更新机制，减少DOM操作，提高渲染性能
 */

/**
 * 比较两个对象是否相等
 * @param {any} a 对象A
 * @param {any} b 对象B
 * @returns {boolean} 是否相等
 */
function deepEqual(a, b) {
  if (a === b) return true;
  
  if (a == null || b == null) return false;
  
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  
  if (keysA.length !== keysB.length) return false;
  
  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  
  return true;
}

/**
 * 计算列表差异
 * @param {Array} oldList 旧列表
 * @param {Array} newList 新列表
 * @param {Function} getKey 获取唯一键的函数
 * @returns {object} 差异信息
 */
export function diff(oldList, newList, getKey = (item) => item.id) {
  const oldMap = new Map();
  const newMap = new Map();
  
  // 构建映射
  oldList.forEach((item, index) => {
    const key = getKey(item);
    oldMap.set(key, { item, index });
  });
  
  newList.forEach((item, index) => {
    const key = getKey(item);
    newMap.set(key, { item, index });
  });
  
  const added = [];
  const removed = [];
  const updated = [];
  const moved = [];
  
  // 查找新增和更新的项
  newMap.forEach((newData, key) => {
    const oldData = oldMap.get(key);
    
    if (!oldData) {
      // 新增
      added.push({
        key,
        item: newData.item,
        index: newData.index
      });
    } else if (!deepEqual(oldData.item, newData.item)) {
      // 更新
      updated.push({
        key,
        oldItem: oldData.item,
        newItem: newData.item,
        oldIndex: oldData.index,
        newIndex: newData.index
      });
    } else if (oldData.index !== newData.index) {
      // 移动
      moved.push({
        key,
        item: newData.item,
        oldIndex: oldData.index,
        newIndex: newData.index
      });
    }
  });
  
  // 查找删除的项
  oldMap.forEach((oldData, key) => {
    if (!newMap.has(key)) {
      removed.push({
        key,
        item: oldData.item,
        index: oldData.index
      });
    }
  });
  
  return {
    added,
    removed,
    updated,
    moved,
    hasChanges: added.length > 0 || removed.length > 0 || updated.length > 0 || moved.length > 0
  };
}

/**
 * 增量更新DOM列表
 */
export class IncrementalList {
  constructor(options) {
    this.container = options.container;
    this.items = options.items || [];
    this.renderItem = options.renderItem;
    this.getKey = options.getKey || ((item) => item.id);
    this.itemElements = new Map();
    
    this.render();
  }
  
  /**
   * 渲染列表
   */
  render() {
    // 清空并重新渲染
    this.container.innerHTML = '';
    this.itemElements.clear();
    
    const fragment = document.createDocumentFragment();
    
    this.items.forEach((item, index) => {
      const key = this.getKey(item);
      const element = this.renderItem(item, index);
      element.dataset.key = key;
      this.itemElements.set(key, element);
      fragment.appendChild(element);
    });
    
    this.container.appendChild(fragment);
  }
  
  /**
   * 增量更新
   * @param {Array} newItems 新数据
   */
  update(newItems) {
    const changes = diff(this.items, newItems, this.getKey);
    
    if (!changes.hasChanges) {
      this.items = newItems;
      return;
    }
    
    // 处理删除
    changes.removed.forEach(({ key }) => {
      const element = this.itemElements.get(key);
      if (element && element.parentNode) {
        element.parentNode.removeChild(element);
      }
      this.itemElements.delete(key);
    });
    
    // 处理更新
    changes.updated.forEach(({ key, newItem, newIndex }) => {
      const oldElement = this.itemElements.get(key);
      if (oldElement) {
        const newElement = this.renderItem(newItem, newIndex);
        newElement.dataset.key = key;
        
        if (oldElement.parentNode) {
          oldElement.parentNode.replaceChild(newElement, oldElement);
        }
        
        this.itemElements.set(key, newElement);
      }
    });
    
    // 处理新增
    changes.added.forEach(({ key, item, index }) => {
      const element = this.renderItem(item, index);
      element.dataset.key = key;
      this.itemElements.set(key, element);
      
      // 找到插入位置
      const children = Array.from(this.container.children);
      if (index < children.length) {
        this.container.insertBefore(element, children[index]);
      } else {
        this.container.appendChild(element);
      }
    });
    
    // 处理移动
    changes.moved.forEach(({ key, newIndex }) => {
      const element = this.itemElements.get(key);
      if (element && element.parentNode) {
        const children = Array.from(this.container.children);
        const currentIndex = children.indexOf(element);
        
        if (currentIndex !== newIndex) {
          element.parentNode.removeChild(element);
          
          if (newIndex < children.length - 1) {
            this.container.insertBefore(element, children[newIndex]);
          } else {
            this.container.appendChild(element);
          }
        }
      }
    });
    
    this.items = newItems;
  }
  
  /**
   * 销毁
   */
  destroy() {
    this.container.innerHTML = '';
    this.itemElements.clear();
  }
}

/**
 * 批量更新管理器
 */
export class BatchUpdateManager {
  constructor(updateFn, delay = 16) {
    this.updateFn = updateFn;
    this.delay = delay;
    this.pending = false;
    this.updates = [];
  }
  
  /**
   * 添加更新
   * @param {any} update 更新数据
   */
  add(update) {
    this.updates.push(update);
    
    if (!this.pending) {
      this.pending = true;
      requestAnimationFrame(() => {
        setTimeout(() => {
          this.flush();
        }, this.delay);
      });
    }
  }
  
  /**
   * 立即执行所有更新
   */
  flush() {
    if (this.updates.length > 0) {
      const updates = this.updates.slice();
      this.updates = [];
      this.pending = false;
      this.updateFn(updates);
    }
  }
  
  /**
   * 清空待处理更新
   */
  clear() {
    this.updates = [];
    this.pending = false;
  }
}

/**
 * 创建防抖函数
 * @param {Function} fn 函数
 * @param {number} delay 延迟
 * @returns {Function} 防抖后的函数
 */
export function debounce(fn, delay = 300) {
  let timeout;
  
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      fn.apply(this, args);
    }, delay);
  };
}

/**
 * 创建节流函数
 * @param {Function} fn 函数
 * @param {number} limit 限制时间
 * @returns {Function} 节流后的函数
 */
export function throttle(fn, limit = 100) {
  let inThrottle;
  
  return function(...args) {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}
