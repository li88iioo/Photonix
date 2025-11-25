/**
 * @file enhanced-table.js
 * @description 增强的表格渲染，支持虚拟滚动（仅在大数据集时启用）
 */

import { IncrementalList } from '../../../shared/incremental-update.js';
import { deriveTaskId } from './utils.js';

/**
 * 增强的任务表格渲染器
 * 统一使用 IncrementalList，保持实现简单可靠
 */
export class EnhancedTaskTable {
  constructor() {
    this.renderer = null;
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
    this.renderIncremental(container, tasks, createRowElement, applyEffects);
  }
  
  /**
   * 使用增量更新渲染（小数据集）
   */
  renderIncremental(container, tasks, createRowElement, applyEffects) {
    const normalized = Array.isArray(tasks) ? tasks : [];
    

    
    if (!this.renderer) {
      this.renderer = new IncrementalList({
        container: container,
        items: normalized,
        getKey: (item) => deriveTaskId(item, 0),
        renderItem: createRowElement
      });
      applyEffects(container);
    } else {
      this.renderer.update(normalized);
      applyEffects(container);
    }
  }
  
  /**
   * 清理渲染器
   */
  cleanup() {
    if (this.renderer) {
      if (typeof this.renderer.destroy === 'function') {
        this.renderer.destroy();
      }
      this.renderer = null;
    }
  }
  
}

// 创建单例实例
export const enhancedTaskTable = new EnhancedTaskTable();
