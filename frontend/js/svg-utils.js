/**
 * SVG工具函数 - 统一管理SVG元素的创建
 * 解决重复的SVG DOM创建代码问题
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
