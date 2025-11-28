/**
 * @file frontend/js/shared/svg-utils.js
 * @description 提供常用 SVG 元素创建与组件化构建工具
 */

/**
 * 创建SVG元素
 * @param {string} tagName - SVG元素标签名
 * @param {object} attributes - 属性对象
 * @returns {SVGElement} 创建的SVG元素
 */
export function createSVGElement(tagName, attributes = {}) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tagName);

    // 设置属性
    Object.entries(attributes).forEach(([key, value]) => {
        element.setAttribute(key, value);
    });

    return element;
}

/**
 * 创建圆形进度条SVG
 * @param {object} options - 配置选项
 * @param {string} options.className - SVG类名
 * @param {string} options.viewBox - viewBox属性
 * @param {string} options.trackClass - 轨道圆类名
 * @param {string} options.barClass - 进度条圆类名
 * @returns {SVGSVGElement} 进度条SVG元素
 */
export function createProgressCircle({
    className = 'progress-circle',
    viewBox = '0 0 36 36',
    trackClass = 'progress-circle-track',
    barClass = 'progress-circle-bar'
} = {}) {
    const svg = createSVGElement('svg', {
        class: className,
        viewBox: viewBox,
        'aria-hidden': 'true'
    });

    const trackCircle = createSVGElement('circle', {
        class: trackClass,
        cx: '18',
        cy: '18',
        r: '16',
        'stroke-width': '4'
    });

    const barCircle = createSVGElement('circle', {
        class: barClass,
        cx: '18',
        cy: '18',
        r: '16',
        'stroke-width': '4'
    });

    svg.appendChild(trackCircle);
    svg.appendChild(barCircle);

    return svg;
}

/**
 * 创建播放按钮SVG
 * @param {object} options - 配置选项
 * @param {string} options.viewBox - viewBox属性
 * @param {string} options.fill - 填充颜色
 * @param {string} options.pathData - 路径数据
 * @returns {SVGSVGElement} 播放按钮SVG元素
 */
export function createPlayButton({
    viewBox = '0 0 64 64',
    fill = 'currentColor',
    pathData = 'M24 18v28l24-14-24-14z'
} = {}) {
    const svg = createSVGElement('svg', {
        viewBox: viewBox,
        fill: fill,
        'aria-hidden': 'true'
    });

    const path = createSVGElement('path', {
        d: pathData
    });

    svg.appendChild(path);

    return svg;
}

/**
 * 创建网格布局图标SVG
 * @returns {SVGSVGElement} 网格图标SVG元素
 */
export function createGridIcon() {
    const svg = createSVGElement('svg', {
        width: '18',
        height: '18',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true'
    });

    // 创建4个矩形（网格布局）
    const rects = [
        { x: 3, y: 3, width: 7, height: 7 },
        { x: 14, y: 3, width: 7, height: 7 },
        { x: 3, y: 14, width: 7, height: 7 },
        { x: 14, y: 14, width: 7, height: 7 }
    ];

    rects.forEach(({ x, y, width, height }) => {
        const rect = createSVGElement('rect', {
            x: x.toString(),
            y: y.toString(),
            width: width.toString(),
            height: height.toString(),
            rx: '2'
        });
        svg.appendChild(rect);
    });

    return svg;
}

/**
 * 创建瀑布流布局图标SVG
 * @returns {SVGSVGElement} 瀑布流图标SVG元素
 */
export function createMasonryIcon() {
    const svg = createSVGElement('svg', {
        width: '18',
        height: '18',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true'
    });

    // 创建瀑布流布局的矩形
    const rects = [
        { x: 3, y: 3, width: 10, height: 8 },
        { x: 15, y: 3, width: 6, height: 6 },
        { x: 3, y: 13, width: 6, height: 8 },
        { x: 11, y: 13, width: 10, height: 8 }
    ];

    rects.forEach(({ x, y, width, height }) => {
        const rect = createSVGElement('rect', {
            x: x.toString(),
            y: y.toString(),
            width: width.toString(),
            height: height.toString(),
            rx: '2'
        });
        svg.appendChild(rect);
    });

    return svg;
}

/**
 * 创建布局切换图标
 * @param {string} kind - 图标类型 ('grid' | 'masonry')
 * @returns {SVGSVGElement} 布局图标SVG元素
 */
export function createLayoutIcon(kind) {
    return kind === 'grid' ? createGridIcon() : createMasonryIcon();
}

export function createDeleteIcon() {
    const svg = createSVGElement('svg', {
        width: '40',
        height: '40',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.8',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true'
    });

    const circle = createSVGElement('circle', { cx: '12', cy: '12', r: '9' });
    const lineA = createSVGElement('line', { x1: '9', y1: '9', x2: '15', y2: '15' });
    const lineB = createSVGElement('line', { x1: '15', y1: '9', x2: '9', y2: '15' });

    svg.appendChild(circle);
    svg.appendChild(lineA);
    svg.appendChild(lineB);

    return svg;
}

/**
 * 创建排序箭头SVG
 * @param {boolean} isAscending - 是否升序排序
 * @returns {SVGSVGElement} 排序箭头SVG元素
 */
export function createSortArrow(isAscending = true) {
    const arrowPath = isAscending ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7';

    const svg = createSVGElement('svg', {
        class: 'w-full h-full',
        fill: 'none',
        stroke: 'currentColor',
        viewBox: '0 0 24 24'
    });

    const path = createSVGElement('path', {
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-width': '2',
        d: arrowPath
    });

    svg.appendChild(path);
    return svg;
}

/**
 * 创建返回箭头SVG（用于面包屑导航）
 * @param {object} options - 配置选项
 * @param {string} options.width - 宽度
 * @param {string} options.height - 高度
 * @param {string} options.marginRight - 右边距
 * @returns {SVGSVGElement} 返回箭头SVG元素
 */
export function createBackArrow({
    width = '16',
    height = '16',
    marginRight = '4px'
} = {}) {
    const svg = createSVGElement('svg', {
        width,
        height,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2.5',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round'
    });

    if (marginRight) {
        svg.style.marginRight = marginRight;
    }

    const line = createSVGElement('line', {
        x1: '19',
        y1: '12',
        x2: '5',
        y2: '12'
    });

    const polyline = createSVGElement('polyline', {
        points: '12 19 5 12 12 5'
    });

    svg.appendChild(line);
    svg.appendChild(polyline);

    return svg;
}

/**
 * 创建通用SVG图标
 * @param {object} config - 图标配置
 * @param {string} config.viewBox - viewBox属性
 * @param {string} config.path - 路径数据
 * @param {object} config.attributes - 额外属性
 * @returns {SVGSVGElement} SVG图标元素
 */
export function createIcon({ viewBox, path, attributes = {} } = {}) {
    const svg = createSVGElement('svg', {
        viewBox: viewBox,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
        ...attributes
    });

    if (path) {
        const pathElement = createSVGElement('path', { d: path });
        svg.appendChild(pathElement);
    }

    return svg;
}

/**
 * 内联SVG通用属性字符串
 * 包括尺寸、颜色、描边等标准属性
 */
const INLINE_ICON_PROPS = 'xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

/**
 * 包裹SVG内容，生成带类名的SVG标签字符串
 * @param {string} content - SVG的内部内容（如path等）
 * @param {string} className - 额外的icon类名
 * @returns {string} 完整的内联SVG字符串
 */
const wrapInlineIcon = (content, className) =>
    `<svg ${INLINE_ICON_PROPS} class="icon ${className}">${content}</svg>`;

/**
 * 常用内联SVG图标工厂方法
 * 每个方法返回SVG字符串，可用于v-html等场景
 */

/** 加号图标 */
export const iconPlus = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
        'icon-plus'
    );

/** 播放图标 */
export const iconPlay = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M7 4v16l13 -8z"></path>',
        'icon-play'
    );

/** 停止图标 */
export const iconStop = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><rect x="5" y="5" width="14" height="14" rx="2"></rect>',
        'icon-stop'
    );

/** 可见/眼睛图标 */
export const iconEye = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><circle cx="12" cy="12" r="2"></circle><path d="M22 12c-2.667 4.667 -6 7 -10 7s-7.333 -2.333 -10 -7c2.667 -4.667 6 -7 10 -7s7.333 2.333 10 7"></path>',
        'icon-eye'
    );

/** 编辑图标 */
export const iconEdit = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M7 7h-1a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-1"></path><path d="M20.385 6.585a2.1 2.1 0 0 0 -2.97 -2.97l-8.415 8.385v3h3l8.385 -8.415z"></path><path d="M16 5l3 3"></path>',
        'icon-edit'
    );

/** 关闭/叉号图标 */
export const iconClose = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
        'icon-close'
    );

/** 下载图标 */
export const iconDownload = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"></path><polyline points="7 11 12 16 17 11"></polyline><line x1="12" y1="4" x2="12" y2="16"></line>',
        'icon-download'
    );

/** 圆形对勾图标 */
export const iconCircleCheck = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><circle cx="12" cy="12" r="9"></circle><path d="M9 12l2 2l4 -4"></path>',
        'icon-circle-check'
    );

/** 圆形叉图标 */
export const iconCircleX = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><circle cx="12" cy="12" r="9"></circle><path d="M10 10l4 4m0 -4l-4 4"></path>',
        'icon-circle-x'
    );

/** 刷新图标 */
export const iconRefresh = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>',
        'icon-refresh'
    );

/** 柱状图图标 */
export const iconChartBar = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><line x1="3" y1="21" x2="21" y2="21"></line><line x1="5" y1="21" x2="5" y2="10"></line><line x1="9" y1="21" x2="9" y2="14"></line><line x1="13" y1="21" x2="13" y2="7"></line><line x1="17" y1="21" x2="17" y2="12"></line>',
        'icon-chart-bar'
    );

/** 设置图标 */
export const iconSettings = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><circle cx="12" cy="12" r="3"></circle>',
        'icon-settings'
    );

/** RSS图标 */
export const iconRss = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><circle cx="5" cy="19" r="1"></circle><path d="M4 4a16 16 0 0 1 16 16"></path><path d="M4 11a9 9 0 0 1 9 9"></path>',
        'icon-rss'
    );

/** 文件文本图标 */
export const iconFileText = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M14 3v4a1 1 0 0 0 1 1h4"></path><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"></path><line x1="9" y1="9" x2="10" y2="9"></line><line x1="9" y1="13" x2="15" y2="13"></line><line x1="9" y1="17" x2="15" y2="17"></line>',
        'icon-file-text'
    );

/** 导入图标 */
export const iconImport = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M12 3v12"></path><path d="M16 11l-4 4l-4 -4"></path><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"></path>',
        'icon-import'
    );

/** 导出图标 */
export const iconExport = () =>
    wrapInlineIcon(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M12 3v12"></path><path d="M16 13l-4 -4l-4 4"></path><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"></path>',
        'icon-export'
    );

/** 对勾别名（与iconCircleCheck一致） */
export const iconCheck = iconCircleCheck;

/** 待处理别名（与iconCircleX一致） */
export const iconPending = iconCircleX;

/**
 * 创建新版网格布局图标 
 * @returns {SVGSVGElement} 网格图标SVG元素
 */
export function createGridIconNew() {
    const svg = createSVGElement('svg', {
        id: 'icon-grid',
        class: 'block transition-transform duration-300 group-active:scale-90',
        width: '20',
        height: '20',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2'
    });

    const path = createSVGElement('path', {
        d: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z'
    });

    svg.appendChild(path);
    return svg;
}

/**
 * 创建新版瀑布流布局图标 (demo.html风格)
 * @returns {SVGSVGElement} 瀑布流图标SVG元素
 */
export function createMasonryIconNew() {
    const svg = createSVGElement('svg', {
        id: 'icon-masonry',
        class: 'hidden transition-transform duration-300 group-active:scale-90',
        width: '20',
        height: '20',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2'
    });

    const path = createSVGElement('path', {
        d: 'M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v10a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h4a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6z'
    });

    svg.appendChild(path);
    return svg;
}

/**
 * 创建排序图标 - 名称升序 (A-Z)
 * @returns {string} SVG路径字符串
 */
export function getSortIconPath(sortType) {
    const icons = {
        'name_asc': '<path d="M18 15V5M18 5L22 9M18 5L14 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 10L6 4L8 10M5.1 8H6.9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 14H8L4 20H8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
        'name_desc': '<path d="M18 9V19M18 19L22 15M18 19L14 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 20L6 14L8 20M5.1 18H6.9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 4H8L4 10H8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
        'mtime_desc': '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>',
        'mtime_asc': '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>',
        'viewed_desc': '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>'
    };
    return icons[sortType] || icons['mtime_desc'];
}

/**
 * 创建搜索图标
 * @returns {SVGSVGElement} 搜索图标SVG元素
 */
export function createSearchIcon() {
    const svg = createSVGElement('svg', {
        width: '16',
        height: '16',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        viewBox: '0 0 24 24'
    });

    const path = createSVGElement('path', {
        d: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z'
    });

    svg.appendChild(path);
    return svg;
}

/**
 * 创建首页图标 (房子形状)
 * @returns {SVGSVGElement} 首页图标SVG元素
 */
export function createHomeIcon() {
    const svg = createSVGElement('svg', {
        width: '16',
        height: '16',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round'
    });

    const path1 = createSVGElement('path', {
        d: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'
    });

    const polyline = createSVGElement('polyline', {
        points: '9 22 9 12 15 12 15 22'
    });

    svg.appendChild(path1);
    svg.appendChild(polyline);
    return svg;
}

/**
 * 创建时钟图标 (用于搜索历史)
 * @returns {SVGSVGElement} 时钟图标SVG元素
 */
export function createClockIcon() {
    const svg = createSVGElement('svg', {
        class: 'w-3.5 h-3.5 text-gray-400',
        fill: 'none',
        stroke: 'currentColor',
        viewBox: '0 0 24 24'
    });

    const path = createSVGElement('path', {
        d: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z'
    });

    svg.appendChild(path);
    return svg;
}

/**
 * 通知图标 - 成功
 * @returns {string} SVG字符串
 */
export const iconNotificationSuccess = () =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;

/**
 * 通知图标 - 错误
 * @returns {string} SVG字符串
 */
export const iconNotificationError = () =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;

/**
 * 通知图标 - 警告
 * @returns {string} SVG字符串
 */
export const iconNotificationWarning = () =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;

/**
 * 通知图标 - 信息
 * @returns {string} SVG字符串
 */
export const iconNotificationInfo = () =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;

/**
 * GitHub 图标
 * @returns {string} SVG字符串
 */
export const iconGitHub = () =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>`;
