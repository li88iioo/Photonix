/**
 * @file enhanced-table.js
 * @description 增强的表格渲染器（简化版）
 *
 * 移除了 IncrementalList 依赖（经 Benchmark 验证，innerHTML 方式更快）
 */

/**
 * 增强的任务表格渲染器
 * 使用直接 DOM 操作，性能优于复杂的 diff/patch 算法
 */
export class EnhancedTaskTable {
  constructor() {
    this.container = null;
  }

  /**
   * 渲染任务表格
   * @param {HTMLElement} container - 表格容器（tbody）
   * @param {Array} tasks - 任务列表
   * @param {Function} createRowElement - 创建行元素的函数
   * @param {Function} applyEffects - 应用交互效果的函数
   */
  render(container, tasks, createRowElement, applyEffects) {
    if (!container) return;

    this.container = container;
    const normalized = Array.isArray(tasks) ? tasks : [];

    // 直接渲染（innerHTML 方式，经 Benchmark 验证比 IncrementalList 更快）
    container.innerHTML = '';
    normalized.forEach((task, index) => {
      const row = createRowElement(task, index);
      container.appendChild(row);
    });

    applyEffects(container);
  }

  /**
   * 清理渲染器
   */
  cleanup() {
    this.container = null;
  }
}

// 创建单例实例
export const enhancedTaskTable = new EnhancedTaskTable();
