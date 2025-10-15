/**
 * @file virtual-scroll.js
 * @description 虚拟滚动实现，用于优化大列表渲染性能
 */

class VirtualScroll {
  constructor(options) {
    this.container = options.container;
    this.items = options.items || [];
    this.itemHeight = options.itemHeight || 60;
    this.renderItem = options.renderItem;
    this.buffer = options.buffer || 5;
    
    // 内部状态
    this.scrollTop = 0;
    this.containerHeight = 0;
    this.visibleStart = 0;
    this.visibleEnd = 0;
    
    // 创建DOM结构
    this.setupDOM();
    
    // 绑定事件
    this.bindEvents();
    
    // 初始渲染
    this.render();
  }
  
  /**
   * 设置DOM结构
   */
  setupDOM() {
    // 清空容器
    this.container.innerHTML = '';
    
    // 创建滚动容器
    this.scrollContainer = document.createElement('div');
    this.scrollContainer.className = 'virtual-scroll-container';
    this.scrollContainer.style.cssText = `
      position: relative;
      height: 100%;
      overflow-y: auto;
    `;
    
    // 创建占位元素（撑开滚动高度）
    this.spacer = document.createElement('div');
    this.spacer.style.cssText = `
      position: relative;
      width: 100%;
      height: ${this.items.length * this.itemHeight}px;
    `;
    
    // 创建内容容器
    this.content = document.createElement('div');
    this.content.className = 'virtual-scroll-content';
    this.content.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
    `;
    
    this.spacer.appendChild(this.content);
    this.scrollContainer.appendChild(this.spacer);
    this.container.appendChild(this.scrollContainer);
  }
  
  /**
   * 绑定事件
   */
  bindEvents() {
    // 滚动事件（使用节流）
    let scrollTimeout;
    this.scrollContainer.addEventListener('scroll', () => {
      if (scrollTimeout) {
        cancelAnimationFrame(scrollTimeout);
      }
      scrollTimeout = requestAnimationFrame(() => {
        this.handleScroll();
      });
    });
    
    // 容器大小变化
    const resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    resizeObserver.observe(this.scrollContainer);
  }
  
  /**
   * 处理滚动
   */
  handleScroll() {
    this.scrollTop = this.scrollContainer.scrollTop;
    this.render();
  }
  
  /**
   * 处理容器大小变化
   */
  handleResize() {
    this.containerHeight = this.scrollContainer.clientHeight;
    this.render();
  }
  
  /**
   * 计算可见范围
   */
  calculateVisibleRange() {
    const visibleStart = Math.floor(this.scrollTop / this.itemHeight);
    const visibleCount = Math.ceil(this.containerHeight / this.itemHeight);
    const visibleEnd = visibleStart + visibleCount;
    
    // 添加缓冲区
    this.visibleStart = Math.max(0, visibleStart - this.buffer);
    this.visibleEnd = Math.min(this.items.length, visibleEnd + this.buffer);
  }
  
  /**
   * 渲染可见项
   */
  render() {
    this.calculateVisibleRange();
    
    // 清空内容
    this.content.innerHTML = '';
    
    // 设置内容偏移
    this.content.style.transform = `translateY(${this.visibleStart * this.itemHeight}px)`;
    
    // 渲染可见项
    const fragment = document.createDocumentFragment();
    
    for (let i = this.visibleStart; i < this.visibleEnd; i++) {
      const item = this.items[i];
      if (item) {
        const element = this.renderItem(item, i);
        if (element) {
          // 确保元素有固定高度
          element.style.height = `${this.itemHeight}px`;
          element.style.overflow = 'hidden';
          fragment.appendChild(element);
        }
      }
    }
    
    this.content.appendChild(fragment);
  }
  
  /**
   * 更新数据
   * @param {Array} items 新数据
   */
  updateItems(items) {
    this.items = items || [];
    
    // 更新占位高度
    this.spacer.style.height = `${this.items.length * this.itemHeight}px`;
    
    // 重新渲染
    this.render();
  }
  
  /**
   * 滚动到指定索引
   * @param {number} index 索引
   * @param {string} behavior 滚动行为
   */
  scrollToIndex(index, behavior = 'smooth') {
    const scrollTop = index * this.itemHeight;
    this.scrollContainer.scrollTo({
      top: scrollTop,
      behavior
    });
  }
  
  /**
   * 获取当前滚动位置的索引
   * @returns {number} 索引
   */
  getCurrentIndex() {
    return Math.floor(this.scrollTop / this.itemHeight);
  }
  
  /**
   * 销毁
   */
  destroy() {
    this.container.innerHTML = '';
  }
}

/**
 * 创建虚拟滚动列表
 * @param {object} options 配置选项
 * @returns {VirtualScroll} 虚拟滚动实例
 */
export function createVirtualScroll(options) {
  return new VirtualScroll(options);
}

/**
 * 虚拟表格实现
 */
export class VirtualTable {
  constructor(options) {
    this.container = options.container;
    this.columns = options.columns || [];
    this.rows = options.rows || [];
    this.rowHeight = options.rowHeight || 48;
    this.headerHeight = options.headerHeight || 56;
    this.renderRow = options.renderRow;
    
    this.setupDOM();
    this.virtualScroll = null;
    this.init();
  }
  
  setupDOM() {
    this.container.innerHTML = '';
    
    // 创建表格容器
    const tableWrapper = document.createElement('div');
    tableWrapper.className = 'virtual-table-wrapper';
    tableWrapper.style.cssText = `
      display: flex;
      flex-direction: column;
      height: 100%;
    `;
    
    // 创建表头
    this.header = document.createElement('div');
    this.header.className = 'virtual-table-header';
    this.header.style.cssText = `
      display: flex;
      height: ${this.headerHeight}px;
      border-bottom: 1px solid #e0e0e0;
      background: #f5f5f5;
      font-weight: 500;
      align-items: center;
      padding: 0 16px;
      flex-shrink: 0;
    `;
    
    // 渲染表头
    this.columns.forEach(column => {
      const cell = document.createElement('div');
      cell.className = 'virtual-table-header-cell';
      cell.style.cssText = `
        flex: ${column.flex || 1};
        padding: 8px;
        ${column.width ? `width: ${column.width}; flex: none;` : ''}
        ${column.align ? `text-align: ${column.align};` : ''}
      `;
      cell.textContent = column.title || '';
      this.header.appendChild(cell);
    });
    
    // 创建内容区域
    this.body = document.createElement('div');
    this.body.className = 'virtual-table-body';
    this.body.style.cssText = `
      flex: 1;
      overflow: hidden;
      position: relative;
    `;
    
    tableWrapper.appendChild(this.header);
    tableWrapper.appendChild(this.body);
    this.container.appendChild(tableWrapper);
  }
  
  init() {
    // 创建虚拟滚动
    this.virtualScroll = new VirtualScroll({
      container: this.body,
      items: this.rows,
      itemHeight: this.rowHeight,
      renderItem: (row, index) => {
        const rowElement = document.createElement('div');
        rowElement.className = 'virtual-table-row';
        rowElement.style.cssText = `
          display: flex;
          align-items: center;
          padding: 0 16px;
          border-bottom: 1px solid #e8e8e8;
          ${index % 2 === 1 ? 'background: #fafafa;' : ''}
        `;
        
        // 渲染单元格
        if (this.renderRow) {
          const content = this.renderRow(row, index);
          if (typeof content === 'string') {
            rowElement.innerHTML = content;
          } else {
            rowElement.appendChild(content);
          }
        } else {
          // 默认渲染
          this.columns.forEach(column => {
            const cell = document.createElement('div');
            cell.className = 'virtual-table-cell';
            cell.style.cssText = `
              flex: ${column.flex || 1};
              padding: 8px;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
              ${column.width ? `width: ${column.width}; flex: none;` : ''}
              ${column.align ? `text-align: ${column.align};` : ''}
            `;
            
            const value = row[column.key];
            cell.textContent = value !== undefined && value !== null ? String(value) : '';
            rowElement.appendChild(cell);
          });
        }
        
        return rowElement;
      }
    });
  }
  
  /**
   * 更新数据
   * @param {Array} rows 新数据
   */
  updateRows(rows) {
    this.rows = rows || [];
    if (this.virtualScroll) {
      this.virtualScroll.updateItems(this.rows);
    }
  }
  
  /**
   * 销毁
   */
  destroy() {
    if (this.virtualScroll) {
      this.virtualScroll.destroy();
    }
    this.container.innerHTML = '';
  }
}

export default VirtualScroll;
