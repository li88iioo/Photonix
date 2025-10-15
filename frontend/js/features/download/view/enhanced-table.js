/**
 * @file enhanced-table.js
 * @description 增强的表格渲染，支持虚拟滚动（仅在大数据集时启用）
 */

import { VirtualTable } from '../../../shared/virtual-scroll.js';
import { IncrementalList } from '../../../shared/incremental-update.js';
import { deriveTaskId } from './utils.js';

// 虚拟滚动阈值
const VIRTUAL_SCROLL_THRESHOLD = 100; // 超过100条数据时启用虚拟滚动

/**
 * 增强的任务表格渲染器
 * - 小数据集：使用 IncrementalList（已有的增量更新）
 * - 大数据集：使用 VirtualTableScroll（虚拟滚动）
 */
export class EnhancedTaskTable {
  constructor() {
    this.renderer = null;
    this.renderMode = 'incremental'; // 'incremental' | 'virtual'
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
    const taskCount = tasks?.length || 0;
    
    // 根据数据量决定渲染模式
    const shouldUseVirtual = taskCount > VIRTUAL_SCROLL_THRESHOLD;
    
    // 如果渲染模式改变，清理旧的渲染器
    if (shouldUseVirtual && this.renderMode !== 'virtual') {
      this.cleanup();
      this.renderMode = 'virtual';
      console.log(`[EnhancedTaskTable] 切换到虚拟滚动模式 (${taskCount} 条任务)`);
    } else if (!shouldUseVirtual && this.renderMode !== 'incremental') {
      this.cleanup();
      this.renderMode = 'incremental';
      console.log(`[EnhancedTaskTable] 切换到增量更新模式 (${taskCount} 条任务)`);
    }
    
    // 根据模式渲染
    if (this.renderMode === 'virtual') {
      this.renderVirtual(container, tasks, createRowElement, applyEffects);
    } else {
      this.renderIncremental(container, tasks, createRowElement, applyEffects);
    }
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
   * 使用虚拟滚动渲染（大数据集）
   */
  renderVirtual(container, tasks, createRowElement, applyEffects) {
    const normalized = Array.isArray(tasks) ? tasks : [];
    
    // 获取表格容器的父元素（应该是有固定高度的容器）
    const scrollContainer = container.closest('.task-table-wrapper') || 
                           container.parentElement;
    
    // 如果容器没有固定高度，设置一个
    if (!scrollContainer.style.height && !scrollContainer.style.maxHeight) {
      scrollContainer.style.maxHeight = '600px';
      scrollContainer.style.overflowY = 'auto';
    }
    
    if (!this.renderer) {
      // 列配置
      const columns = [
        { key: 'title', label: '任务', width: '25%' },
        { key: 'status', label: '状态', width: '10%' },
        { key: 'stats', label: '统计', width: '15%' },
        { key: 'schedule', label: '周期', width: '15%' },
        { key: 'lastRun', label: '运行时间', width: '20%' },
        { key: 'actions', label: '操作', width: '15%' }
      ];
      
      this.renderer = new VirtualTable({
        container: scrollContainer,
        items: normalized,
        columns: columns,
        rowHeight: 80,
        renderRow: (task, index) => {
          // 创建行元素
          const row = createRowElement(task, index);
          
          // 提取单元格内容
          const cells = {};
          const tds = row.querySelectorAll('td');
          columns.forEach((col, i) => {
            if (tds[i]) {
              cells[col.key] = tds[i].innerHTML;
            }
          });
          
          return cells;
        }
      });
      
      // 应用交互效果
      applyEffects(scrollContainer);
    } else {
      this.renderer.updateItems(normalized);
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
  
  /**
   * 获取当前渲染模式
   */
  getRenderMode() {
    return this.renderMode;
  }
  
  /**
   * 获取虚拟滚动阈值
   */
  static getThreshold() {
    return VIRTUAL_SCROLL_THRESHOLD;
  }
}

// 创建单例实例
export const enhancedTaskTable = new EnhancedTaskTable();
