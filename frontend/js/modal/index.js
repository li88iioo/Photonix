/**
 * @file frontend/js/modal/index.js
 * @description 管理图片/视频模态框的加载、导航与交互行为
 */

import { state, backdrops } from '../core/state.js';
import { elements } from '../shared/dom-elements.js';
import { preloadNextImages, showNotification } from '../shared/utils.js';
import { generateImageCaption } from '../app/api.js';
import Hls from 'hls.js';
import { enablePinchZoom } from '../features/gallery/touch.js';
import { createModuleLogger } from '../core/logger.js';
import { safeSetInnerHTML, safeSetStyle, safeClassList } from '../shared/dom-utils.js';
import {
  scheduleNavigationProgressBar,
  hideNavigationProgressBar,
  setNavigationProgress,
  setNavigationBlurProgress
} from './navigation.js';

const modalLogger = createModuleLogger('Modal');

/**
 * 重置模态图像的过渡与滤镜效果
 * @returns {void}
 */
function resetModalImageTransition() {
    const img = elements?.modalImg;
    if (!img) return;
    safeSetStyle(img, {
        transition: '',
        imageRendering: '',
        filter: '',
        transform: '',
        opacity: ''
    });
}

/**
 * 触发像素化淡入动效，用于显示高清图片
 * @returns {void}
 */
function triggerPixelatedReveal() {
    const img = elements?.modalImg;
    if (!img) return;
    safeSetStyle(img, {
        transition: 'filter 420ms ease, transform 420ms ease, opacity 420ms ease',
        imageRendering: 'pixelated',
        filter: 'contrast(135%) brightness(1.05) saturate(0.9)',
        transform: 'scale(1.016)',
        opacity: '0.9'
    });
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            safeSetStyle(img, 'filter', 'none');
            safeSetStyle(img, 'transform', 'scale(1)');
            safeSetStyle(img, 'opacity', '1');
            setTimeout(() => {
                safeSetStyle(img, 'transition', '');
                safeSetStyle(img, 'imageRendering', '');
            }, 440);
        });
    });
}

/**
 * 模态框管理模块
 * 负责处理图片/视频模态框的显示、导航、加载和交互功能
 */

let activeLoader = null;  // 当前活跃的加载器
let activeVideoToken = 0; // 当前视频加载令牌，避免并发事件冲突

// 可访问性与通用对话框管理（焦点陷阱、滚动锁定、恢复焦点）
let modalPrevFocused = null;
let modalKeydownHandler = null;
let modalClickHandler = null;
let focusTrapActive = false;
let pendingReveal = false; // 首次打开时等待媒体准备就绪后再显示，减少CLS
let scrollLockData = null;

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function lockScroll() {
    if (scrollLockData && scrollLockData.applied) return;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    scrollLockData = { scrollY, applied: true };
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
}

function unlockScroll() {
    if (!scrollLockData || !scrollLockData.applied) return;
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    document.body.style.overflow = '';
    // 滚动位置恢复在 closeModal 内部完成
    scrollLockData = null;
}

function getFocusableElements(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(el => !el.hasAttribute('disabled'));
}

function onFocusTrapKeydown(e) {
    if (!focusTrapActive || !elements || !elements.modal) return;
    if (e.key !== 'Tab') return;
    const scope = elements.modal;
    const nodes = getFocusableElements(scope);
    if (nodes.length === 0) {
        e.preventDefault();
        try { elements.modalContent?.focus({ preventScroll: true }); } catch {}
        return;
    }
    const currentIndex = nodes.indexOf(document.activeElement);
    let nextIndex = currentIndex;
    if (e.shiftKey) {
        nextIndex = currentIndex <= 0 ? nodes.length - 1 : currentIndex - 1;
    } else {
        nextIndex = currentIndex === nodes.length - 1 ? 0 : currentIndex + 1;
    }
    e.preventDefault();
    try { nodes[nextIndex].focus({ preventScroll: true }); } catch { nodes[nextIndex].focus(); }
}

function activateFocusTrap() {
    if (focusTrapActive) return;
    focusTrapActive = true;
    elements.modal.addEventListener('keydown', onFocusTrapKeydown);
}

function deactivateFocusTrap() {
    if (!focusTrapActive) return;
    focusTrapActive = false;
    try { elements.modal.removeEventListener('keydown', onFocusTrapKeydown); } catch {}
}

function prefersReducedMotion() {
    try {
        return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch { return false; }
}

function revealModalIfPending() {
    if (!pendingReveal) return;
    pendingReveal = false;
    safeClassList(elements.modal, 'remove', 'opacity-0');
    safeClassList(elements.modal, 'remove', 'pointer-events-none');
    // 初始聚焦：优先可聚焦元素，否则聚焦容器
    requestAnimationFrame(() => {
        const nodes = getFocusableElements(elements.modalContent || elements.modal);
        if (nodes.length) {
            try { nodes[0].focus({ preventScroll: true }); } catch { nodes[0].focus(); }
        } else if (elements.modalContent) {
            try { elements.modalContent.focus({ preventScroll: true }); } catch { elements.modalContent.focus(); }
        }
    });
}

/**
 * 隐藏模态框控制元素，包括关闭按钮和 AI 控制容器
 * @returns {void}
 */
function hideModalControls() {
    safeClassList(elements.modalClose, 'add', 'opacity-0');
    if (elements.aiControlsContainer) {
        safeClassList(elements.aiControlsContainer, 'add', 'opacity-0');
    }
}

/**
 * 显示模态框控制元素，包括关闭按钮和 AI 控制容器
 * @returns {void}
 */
function showModalControls() {
    safeClassList(elements.modalClose, 'remove', 'opacity-0');
    if (elements.aiControlsContainer) {
        safeClassList(elements.aiControlsContainer, 'remove', 'opacity-0');
    }
}

/**
 * 创建视频加载指示器
 * @returns {HTMLElement} 视频加载器 DOM 元素
 */
function createVideoSpinner() {
    const spinnerWrapper = document.createElement('div');
    spinnerWrapper.id = 'video-spinner';
    spinnerWrapper.className = 'absolute inset-0 flex items-center justify-center bg-black bg-opacity-30 z-10 pointer-events-none';

    // XSS 安全修复：使用 DOM 操作替代 innerHTML
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    safeSetStyle(spinner, {
        width: '3rem',
        height: '3rem'
    });
    spinnerWrapper.appendChild(spinner);

    return spinnerWrapper;
}

/**
 * 更新模态框内容
 * @param {string} mediaSrc - 媒体源 URL
 * @param {number} index - 当前媒体索引
 * @param {string} originalPathForAI - 用于 AI 的原始路径
 * @param {string} thumbForBlur - 用于模糊背景的缩略图 URL
 * @param {Object} effects - 附加视觉效果配置
 */
function updateModalContent(mediaSrc, index, originalPathForAI, thumbForBlur = null, effects = {}) {
    state.currentPhotoIndex = index;
    const { modalVideo, modalImg, navigationHint, captionContainer, captionContainerMobile, mediaPanel } = elements;
    const shouldPixelate = !!(effects && effects.pixelate);
    
    // 移除旧的视频加载器
    const oldSpinner = mediaPanel.querySelector('#video-spinner');
    if (oldSpinner) oldSpinner.remove();

    // 清理之前的媒体内容
    try { modalVideo.pause(); } catch {}
    try { modalVideo.removeAttribute('src'); modalVideo.load(); } catch {}
    modalImg.src = ''; 
    if (state.currentObjectURL) {
        URL.revokeObjectURL(state.currentObjectURL);
        state.currentObjectURL = null;
    }

    const isVideo = /\.(mp4|webm|mov)$/i.test(originalPathForAI);
    
    // 更新背景模糊效果
    const blurSource = thumbForBlur || mediaSrc;
    const inactiveBackdropKey = state.activeBackdrop === 'one' ? 'two' : 'one';
    const activeBackdropElem = backdrops[state.activeBackdrop];
    const inactiveBackdropElem = backdrops[inactiveBackdropKey];
    
    safeSetStyle(inactiveBackdropElem, 'backgroundImage', `url('${blurSource}')`);
    safeClassList(activeBackdropElem, 'remove', 'active-backdrop');
    safeClassList(inactiveBackdropElem, 'add', 'active-backdrop');
    state.activeBackdrop = inactiveBackdropKey;

    // 根据媒体类型和 AI 状态显示相应元素
    // 实时检查 AI 是否启用，而不是依赖可能过期的 state
    const localAI = JSON.parse(localStorage.getItem('ai_settings') || '{}');
    const isAIEnabled = localAI.AI_ENABLED === 'true' || state.aiEnabled;
    const showAiElements = !isVideo && isAIEnabled;
    safeClassList(elements.aiControlsContainer, 'toggle', 'hidden', !showAiElements);
    
    resetModalImageTransition();
    safeClassList(modalVideo, 'toggle', 'hidden', !isVideo);
    safeClassList(modalImg, 'toggle', 'hidden', isVideo);
    
    if (isVideo) {
        const myToken = ++activeVideoToken;
        safeClassList(navigationHint, 'remove', 'show-hint');
        safeSetStyle(navigationHint, 'display', 'none');

        const videoSpinner = createVideoSpinner();
        mediaPanel.appendChild(videoSpinner);

        // 修正：从 URL 路径中提取干净的相对路径
        const cleanRelativePath = originalPathForAI.startsWith('/static/') ? originalPathForAI.substring(8) : originalPathForAI;
        const hlsUrl = `/thumbs/hls/${cleanRelativePath}/master.m3u8`;

        let _onResizeRef = null;
        /**
         * 清理视频相关资源和事件监听
         */
        const cleanup = () => {
            if (state.hlsInstance) {
                state.hlsInstance.destroy();
                state.hlsInstance = null;
            }
            modalVideo.removeEventListener('playing', onPlaying);
            modalVideo.removeEventListener('error', onError);
            modalVideo.removeEventListener('canplay', onCanPlay);
            modalVideo.removeEventListener('loadeddata', onLoadedData);
            modalVideo.removeEventListener('timeupdate', onTimeUpdate);
            modalVideo.removeEventListener('loadedmetadata', onLoadedMetadata);
            try { if (_onResizeRef) window.removeEventListener('resize', _onResizeRef); } catch {}
        };

        /**
         * 移除加载圈和解绑部分事件
         */
        const removeSpinnerAndUnbind = () => {
            if (videoSpinner && videoSpinner.isConnected) videoSpinner.remove();
            modalVideo.removeEventListener('playing', onPlaying);
            modalVideo.removeEventListener('error', onError);
            modalVideo.removeEventListener('canplay', onCanPlay);
            modalVideo.removeEventListener('loadeddata', onLoadedData);
            modalVideo.removeEventListener('timeupdate', onTimeUpdate);
        };

        /**
         * 视频播放事件处理
         */
        const onPlaying = () => {
            if (myToken !== activeVideoToken) return cleanup();
            removeSpinnerAndUnbind();
            revealModalIfPending();
        };

        /**
         * 视频错误事件处理
         */
        const onError = () => {
            if (myToken !== activeVideoToken) return cleanup();
            removeSpinnerAndUnbind();
            modalLogger.error('HLS 或视频播放错误');
        };

        /**
         * 视频可播放事件处理
         */
        const onCanPlay = () => {
            if (myToken !== activeVideoToken) return cleanup();
            removeSpinnerAndUnbind();
            revealModalIfPending();
        };

        /**
         * 视频数据加载事件处理
         */
        const onLoadedData = () => {
            if (myToken !== activeVideoToken) return cleanup();
            removeSpinnerAndUnbind();
            revealModalIfPending();
        };

        /**
         * 视频时间更新事件处理
         */
        const onTimeUpdate = () => {
            if (myToken !== activeVideoToken) return cleanup();
            removeSpinnerAndUnbind();
            revealModalIfPending();
        };

        /**
         * 根据视口和视频比例，计算一个“适中”的尺寸并固定，避免播放中忽大忽小
         */
        const applyStableSize = () => {
            if (!modalVideo) return;
            const vw = Math.max(1, modalVideo.videoWidth || 16);
            const vh = Math.max(1, modalVideo.videoHeight || 9);
            const aspect = vw / vh;
            const maxW = Math.min(window.innerWidth * 0.86, 1280);
            const maxH = Math.min(window.innerHeight * 0.78, 820);
            let width = maxW;
            let height = width / aspect;
            if (height > maxH) { height = maxH; width = height * aspect; }
            safeSetStyle(modalVideo, 'width', `${Math.round(width)}px`);
            safeSetStyle(modalVideo, 'height', `${Math.round(height)}px`);
            try { safeSetStyle(modalVideo, 'aspectRatio', `${vw}/${vh}`); } catch {}
        };

        /**
         * 视频元数据加载完成事件处理
         */
        const onLoadedMetadata = () => {
            applyStableSize();
            revealModalIfPending();
        };

        cleanup(); // 清理前一个实例

        if (Hls.isSupported()) {
            const hls = new Hls({
                // HLS.js a/b/r 配置
                abrEwmaDefaultEstimate: 500000, // 500kbps 初始估算
            });
            state.hlsInstance = hls;
            hls.loadSource(hlsUrl);
            hls.attachMedia(modalVideo);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                if (myToken !== activeVideoToken) return cleanup();
                modalVideo.play().catch(e => modalLogger.warn('自动播放被阻止', e));
            });
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    switch(data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            modalLogger.error('HLS 网络错误', data);
                            // 致命网络错误时回退到直接播放
                            if (myToken === activeVideoToken) {
                                modalLogger.warn('HLS 失败，回退到直接播放');
                                // 仅销毁 HLS 实例，保留 playing/error 监听，用于移除加载圈
                                if (state.hlsInstance) {
                                    try { state.hlsInstance.destroy(); } catch {}
                                    state.hlsInstance = null;
                                }
                                modalVideo.src = mediaSrc;
                                // 重新绑定事件监听
                                try { modalVideo.removeEventListener('playing', onPlaying); } catch {}
                                try { modalVideo.removeEventListener('error', onError); } catch {}
                                try { modalVideo.removeEventListener('canplay', onCanPlay); } catch {}
                                try { modalVideo.removeEventListener('loadeddata', onLoadedData); } catch {}
                                try { modalVideo.removeEventListener('timeupdate', onTimeUpdate); } catch {}
                                modalVideo.addEventListener('playing', onPlaying, { once: true });
                                modalVideo.addEventListener('error', onError, { once: true });
                                modalVideo.addEventListener('canplay', onCanPlay, { once: true });
                                modalVideo.addEventListener('loadeddata', onLoadedData, { once: true });
                                modalVideo.addEventListener('timeupdate', onTimeUpdate, { once: true });
                                modalVideo.play().catch(e => modalLogger.warn('回退自动播放被阻止', e));
                            }
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            modalLogger.error('HLS 媒体错误', data);
                            hls.recoverMediaError();
                            break;
                        default:
                            modalLogger.error('HLS 致命错误，正在销毁', data);
                            // 致命且无法恢复：销毁实例并移除加载圈
                            if (state.hlsInstance) {
                                try { state.hlsInstance.destroy(); } catch {}
                                state.hlsInstance = null;
                            }
                            removeSpinnerAndUnbind();
                            break;
                    }
                }
            });
        } else if (modalVideo.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari 原生 HLS 支持
            modalVideo.src = hlsUrl;
        } else {
            // 回退到直接播放
            modalLogger.warn('HLS 不支持，回退到直接播放');
            modalVideo.src = mediaSrc;
        }

        modalVideo.addEventListener('playing', onPlaying, { once: true });
        modalVideo.addEventListener('error', onError, { once: true });
        modalVideo.addEventListener('canplay', onCanPlay, { once: true });
        modalVideo.addEventListener('loadeddata', onLoadedData, { once: true });
        modalVideo.addEventListener('timeupdate', onTimeUpdate, { once: true });
        modalVideo.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
        const onResize = () => applyStableSize();
        window.addEventListener('resize', onResize);
        _onResizeRef = onResize;
        modalVideo.play().catch(e => {
            if (myToken !== activeVideoToken) return cleanup();
            modalLogger.warn('自动播放可能被浏览器阻止', e);
        });

        if(elements.captionBubble) safeClassList(elements.captionBubble, 'remove', 'show');
    } else {
        // 图片处理逻辑
        safeSetStyle(navigationHint, 'display', 'flex');
        if (modalImg._pendingPixelationHandler) {
            try { modalImg.removeEventListener('load', modalImg._pendingPixelationHandler); } catch {}
            modalImg._pendingPixelationHandler = null;
        }
        /**
         * 图片加载完成事件处理
         */
        const onModalImageLoad = () => {
            modalImg._pendingPixelationHandler = null;
            if (shouldPixelate && !prefersReducedMotion()) {
                triggerPixelatedReveal();
            } else {
                resetModalImageTransition();
            }
            revealModalIfPending();
        };
        modalImg._pendingPixelationHandler = onModalImageLoad;
        modalImg.addEventListener('load', onModalImageLoad, { once: true });
        modalImg.src = mediaSrc; 
        
        // 禁用右键菜单
        if (!modalImg._noContextMenuBound) {
            modalImg.addEventListener('contextmenu', e => e.preventDefault());
            modalImg._noContextMenuBound = true;
        }
        
        // AI 标题生成
        if (showAiElements) {
            // 清理之前的定时器和状态
            clearTimeout(state.captionDebounceTimer);

            // 立即检查 blob URL，如果是 blob URL 立即执行
            const immediateImageSrc = modalImg.src;
            if (immediateImageSrc.startsWith('blob:')) {
                generateImageCaption(originalPathForAI);
                return;
            }

            // 延迟执行，避免快速切换时的状态混乱
            state.captionDebounceTimer = setTimeout(() => {
                // 再次检查是否还是当前图片，避免快速切换时的竞态条件
                const currentImageSrc = modalImg.src;
                const currentFileName = originalPathForAI.split('/').pop();

                // 处理 blob URL 特殊情况
                let isBlobUrl = currentImageSrc.startsWith('blob:');
                let srcFileName;
                let pathname = '';

                if (isBlobUrl) {
                    // 对于 blob URL，直接使用 originalPathForAI 进行 AI 生成
                    generateImageCaption(originalPathForAI);
                    return;
                }

                // 提取 URL 中的实际文件名，去掉查询参数
                try {
                    const url = new URL(currentImageSrc);
                    srcFileName = url.pathname.split('/').pop().split('?')[0];
                    pathname = url.pathname;
                } catch (e) {
                    // 如果不是完整的 URL，使用简单的方法
                    srcFileName = currentImageSrc.split('/').pop().split('?')[0];
                    pathname = 'N/A (relative URL)';
                }

                // 更精确的比较：比较文件名（去掉查询参数）
                if (currentImageSrc && srcFileName === currentFileName) {
                    generateImageCaption(originalPathForAI);
                } else {
                    // 如果精确匹配失败，尝试更宽松的匹配（处理 UUID 缓存文件名）
                    // 例如：001.webp 可能被缓存为 67c2c9cb-332a-461e-a2db-b50d036c53e4
                    // 我们可以通过检查 originalPathForAI 是否包含在 currentImageSrc 中来验证
                    const isSameImage = currentImageSrc.includes(originalPathForAI.split('/').pop().split('.')[0]);
                    if (isSameImage) {
                        generateImageCaption(originalPathForAI);
                    }
                }
            }, 300);

            // XSS 安全修复：使用 DOM 操作替代 innerHTML
            safeSetInnerHTML(captionContainer, ''); // 清空内容
            const loadingDiv = document.createElement('div');
            loadingDiv.className = 'flex items-center justify-center h-full';

            const spinner = document.createElement('div');
            spinner.className = 'spinner';
            loadingDiv.appendChild(spinner);

            const textP = document.createElement('p');
            textP.className = 'ml-4';
            textP.textContent = '酝酿中...';
            loadingDiv.appendChild(textP);

            captionContainer.appendChild(loadingDiv);
            captionContainerMobile.textContent = '酝酿中...';
        }

        // 启用移动端双指缩放/拖拽（touch.js）
        try {
            if (window._imageGestureCleanup) { try { window._imageGestureCleanup(); } catch {} }
            window._imageGestureCleanup = enablePinchZoom(modalImg, mediaPanel);
        } catch {}
    }
    
    // 预加载下一批图片
    preloadNextImages(state.currentPhotos, index);
}

/**
 * 关闭模态框，清理所有状态与 DOM 元素，并恢复焦点与滚动
 * @returns {void}
 */
export function closeModal() {
    if (!elements?.modal || safeClassList(elements.modal, 'contains', 'opacity-0')) return;

    pendingReveal = false;
    document.documentElement.classList.remove('modal-open');
    document.body.classList.remove('modal-open');

    safeClassList(elements.modal, 'add', 'opacity-0');
    safeClassList(elements.modal, 'add', 'pointer-events-none');

    if (modalKeydownHandler) {
        try { document.removeEventListener('keydown', modalKeydownHandler); } catch {}
        modalKeydownHandler = null;
    }
    if (modalClickHandler) {
        try { elements.modal.removeEventListener('click', modalClickHandler); } catch {}
        modalClickHandler = null;
    }
    deactivateFocusTrap();

    if (typeof stopFastNavigate === 'function') {
        try { stopFastNavigate(); } catch {}
    }

    cleanupModal();

    // 清理媒体内容
    try { elements.modalVideo.pause(); } catch {}
    elements.modalImg.src = '';
    elements.modalVideo.src = '';

    // 清理背景
    safeSetStyle(backdrops.one, 'backgroundImage', 'none');
    safeSetStyle(backdrops.two, 'backgroundImage', 'none');

    // 清理对象 URL
    if (state.currentObjectURL) {
        try { URL.revokeObjectURL(state.currentObjectURL); } catch {}
        state.currentObjectURL = null;
    }

    if (elements.captionBubble) safeClassList(elements.captionBubble, 'remove', 'show');
    if (document.activeElement) document.activeElement.blur();

    // 解除滚动锁定
    unlockScroll();

    // 恢复滚动位置
    if (state.scrollPositionBeforeModal !== null) {
        window.scrollTo({ top: state.scrollPositionBeforeModal, behavior: 'instant' });
        state.scrollPositionBeforeModal = null;
    }

    // 恢复焦点
    if (state.activeThumbnail) {
        try { state.activeThumbnail.focus({ preventScroll: true }); } catch { state.activeThumbnail.focus(); }
        state.activeThumbnail = null;
    } else if (modalPrevFocused && modalPrevFocused.isConnected) {
        try { modalPrevFocused.focus({ preventScroll: true }); } catch { try { modalPrevFocused.focus(); } catch {} }
    }
    modalPrevFocused = null;
}

/**
 * 模态框导航至上一项或下一项
 * @param {'prev'|'next'} direction - 导航方向
 * @returns {void}
 */
export function navigateModal(direction) {
    if (document.activeElement) document.activeElement.blur();
    if (state.isModalNavigating) return;

    hideModalControls();
    clearTimeout(state.uiVisibilityTimer);
    state.uiVisibilityTimer = setTimeout(showModalControls, 500);

    const newIndex = direction === 'prev' ? state.currentPhotoIndex - 1 : state.currentPhotoIndex + 1;
    if (newIndex >= 0 && newIndex < state.currentPhotos.length) {
        const nextMediaSrc = state.currentPhotos[newIndex];
        const navDirection = direction === 'prev' ? 'backward' : 'forward';
        handleModalNavigationLoad(nextMediaSrc, newIndex, navDirection);
    }
}

/**
 * 处理缩略图点击事件（简化版）
 * @param {HTMLElement} element - 被点击的缩略图元素
 * @param {string} mediaSrc - 媒体源 URL
 * @param {number} index - 媒体索引
 * @returns {void}
 */
export function _handleThumbnailClick(element, mediaSrc, index) {
    state.scrollPositionBeforeModal = window.scrollY;
    state.activeThumbnail = element;

    const photoItem = element && element.querySelector ? (element.querySelector('.photo-item') || element) : element;
    const isVideo = /\.(mp4|webm|mov)$/i.test(mediaSrc);
    if (isVideo) {
        const thumbEl = photoItem && photoItem.querySelector ? photoItem.querySelector('img[data-src]') : null;
        const thumbUrl = thumbEl ? thumbEl.dataset.src : null;
        _openModal(mediaSrc, index, false, mediaSrc, thumbUrl, { pixelate: false });
        return;
    }
    _openModal(mediaSrc, index, false, mediaSrc, undefined, { pixelate: false });
}

/**
 * 处理模态框导航时的媒体加载
 * @param {string} mediaSrc - 媒体源 URL
 * @param {number} index - 媒体索引
 * @param {'forward'|'backward'|null} [navDirection=null] - 导航方向
 * @returns {Promise<void>} 加载流程完成的 Promise
 */
async function handleModalNavigationLoad(mediaSrc, index, navDirection = null) {
    const originalPath = state.currentPhotos[index];
    const isVideo = /\.(mp4|webm|mov)$/i.test(originalPath);
    const startedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    let shouldPixelateReveal = false;
    let streamFallbackChunks = 0;
    let streamContentLength = 0;

    if (isVideo) {
        hideNavigationProgressBar(true);
        const gridItem = document.querySelector(`[data-url="${originalPath}"]`);
        const thumbEl = gridItem ? gridItem.querySelector('img[data-src]') : null;
        const thumbUrl = thumbEl ? thumbEl.dataset.src : null;
        updateModalContent(originalPath, index, originalPath, thumbUrl, { pixelate: false });
        return;
    }

    if (state.isModalNavigating) return;
    state.isModalNavigating = true;

    if (activeLoader) {
        try { activeLoader.abort(); } catch {}
    }

    const controller = new AbortController();
    const { signal } = controller;
    activeLoader = controller;
    const loadStartedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    let slowRevealNeeded = false;
    let streamedChunkCount = 0;
    let headerContentLength = 0;

    // 流式加载图片（带 Abort 友好处理与回退）
    fetch(mediaSrc, { signal })
        .then(response => {
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            headerContentLength = +response.headers.get('Content-Length');
            const reader = response.body.getReader();
            let receivedLength = 0;
            
            return new Response(
                new ReadableStream({
                    start(controller) {
                        // 当外部中止时，及时取消 reader，避免 AbortError 噪音
                        const onAbort = () => {
                            try { reader.cancel(); } catch {}
                            try { controller.close(); } catch {}
                        };
                        if (signal && typeof signal.addEventListener === 'function') {
                            if (signal.aborted) return onAbort();
                            signal.addEventListener('abort', onAbort, { once: true });
                        }

                        function push() {
                            reader.read().then(({ done, value }) => {
                                if (done) {
                                    try { controller.close(); } catch {}
                                    return;
                                }
                                receivedLength += value.length;
                                // 更新进度圆环
                                if (headerContentLength && progressCircle) {
                                    const progress = receivedLength / headerContentLength;
                                    const circumference = 2 * Math.PI * progressCircle.r.baseVal.value;
                                    const offset = circumference - progress * circumference;
                                    safeSetStyle(progressCircle, 'strokeDashoffset', offset);
                                }
                                streamedChunkCount = Math.min(12, streamedChunkCount + 1);
                                try { controller.enqueue(value); } catch {}
                                push();
                            }).catch(error => {
                                // 中止不视为错误，不再上抛，直接关闭流
                                if (error && error.name === 'AbortError') {
                                    try { controller.close(); } catch {}
                                    return;
                                }
                                modalLogger.error('流读取错误', error);
                                try { controller.error(error); } catch {}
                            })
                        }
                        push();
                    }
                })
            );
        })
        .then(response => {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            return response.blob();
        })
        .then(blob => {
            const objectURL = URL.createObjectURL(blob);
            const finishedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
            const elapsed = finishedAt - loadStartedAt;
            slowRevealNeeded = elapsed > 420 || (!headerContentLength && streamedChunkCount >= 4);
            if (activeLoader === controller) {
                _openModal(objectURL, index, true, mediaSrc, undefined, { pixelate: slowRevealNeeded });
                state.currentObjectURL = objectURL; 
            } else {
                URL.revokeObjectURL(objectURL);
            }
        })
        .catch(error => {
            if (error.name === 'AbortError') {
                // 被主动中止，静默
                return;
            }
            // 非中止错误：尝试直接使用原始地址回退加载，避免因流式读取失败而打不开
            const fallbackElapsed = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - loadStartedAt;
            slowRevealNeeded = slowRevealNeeded || fallbackElapsed > 420 || (!headerContentLength && streamedChunkCount >= 4);
            try { _openModal(mediaSrc, index, false, mediaSrc, undefined, { pixelate: slowRevealNeeded }); } catch {}
            showNotification('图片加载失败', 'error');
        })
        .finally(() => {
            if (overlayShowTimer) {
                clearTimeout(overlayShowTimer);
                overlayShowTimer = null;
            }
            safeClassList(photoItem, 'remove', 'is-loading');
            if (loadingOverlay) {
                safeSetStyle(loadingOverlay, {
                    display: 'none',
                    opacity: '0'
                });
            }
            if (activeLoader === controller) activeLoader = null;
        });
}

/**
 * 打开模态框并根据媒体源更新内容
 * @param {string} mediaSrc - 媒体源 URL
 * @param {number} [index=0] - 媒体索引
 * @param {boolean} [isObjectURL=false] - 是否为对象 URL
 * @param {string|null} [originalPathForAI=null] - 用于 AI 的原始路径
 * @param {string|null} [thumbForBlur=null] - 用于模糊背景的缩略图 URL
 * @param {Object} [effects={}] - 附加视觉效果配置
 * @returns {void}
 */
export function _openModal(mediaSrc, index = 0, isObjectURL = false, originalPathForAI = null, thumbForBlur = null, effects = {}) {
    // 添加模态框相关类
    // 注意：document.documentElement 和 document.body 的 classList 操作保持原样
    // 因为这些是特殊 DOM 元素，不在我们的封装范围内
    document.documentElement.classList.add('modal-open');
    document.body.classList.add('modal-open');
    if (document.activeElement) document.activeElement.blur();
    
    // 验证媒体源
    if (!mediaSrc || typeof mediaSrc !== 'string' || mediaSrc.trim() === '') {
        modalLogger.error('打开模态框失败: 无效的媒体源', { mediaSrc });
        return;
    }

    // 延迟显示：等待媒体解码/可播放，减少CLS
    pendingReveal = true;
    modalPrevFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // 键盘与点击外部关闭
    modalKeydownHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            if (window.location.hash.endsWith('#modal')) {
                window.history.back();
            } else {
                closeModal();
            }
        }
    };
    document.addEventListener('keydown', modalKeydownHandler);

    modalClickHandler = (e) => {
        const target = e.target;
        if (target === elements.modal || (target && target.classList && target.classList.contains('modal-backdrop'))) {
            if (window.location.hash.endsWith('#modal')) {
                window.history.back();
            } else {
                closeModal();
            }
        }
    };
    elements.modal.addEventListener('click', modalClickHandler);

    activateFocusTrap();
    lockScroll();
    
    // 更新模态框内容
    const aiPath = originalPathForAI || mediaSrc;
    updateModalContent(mediaSrc, index, aiPath, thumbForBlur, effects);
    
    if (isObjectURL) state.currentObjectURL = mediaSrc;

    // 显示导航提示（仅首次）
    if (!state.hasShownNavigationHint && window.innerWidth > 768) {
        safeClassList(elements.navigationHint, 'add', 'show-hint');
        state.hasShownNavigationHint = true;
        setTimeout(() => safeClassList(elements.navigationHint, 'remove', 'show-hint'), 4000);
    }

    // 更新 URL 哈希
    if (!window.location.hash.endsWith('#modal')) {
        window.history.pushState({ modal: true }, '', window.location.href + '#modal');
    }
}

/**
 * 导航到指定相册
 * @param {Event} event - 点击事件
 * @param {string} albumPath - 相册路径
 * @returns {void}
 */
export function _navigateToAlbum(event, albumPath) {
    event.preventDefault();
    if (document.activeElement) document.activeElement.blur();
    
    window.location.hash = `/${encodeURIComponent(albumPath)}`;
}

// =======================================================
// 快速导航功能
// =======================================================

let fastNavInterval = null;
let fastNavDirection = null;

/**
 * 启动智能快速导航
 * 以固定间隔尝试翻页，但会自动等待上一张图片切换完成后再继续
 * @param {'prev'|'next'} direction - 导航方向
 * @returns {void}
 */
export function startFastNavigate(direction) {
    // 如果已经有一个在运行且方向相同，则不重复启动
    if (fastNavInterval && fastNavDirection === direction) {
        return;
    }

    // 如果已经有一个在运行，则先停止
    if (fastNavInterval) {
        stopFastNavigate();
    }

    fastNavDirection = direction;

    // 立即执行第一次翻页
    if (!state.isModalNavigating) {
        navigateModal(direction);
    }

    // 设置一个定时器，周期性地尝试翻页
    fastNavInterval = setInterval(() => {
        // 只有当 state.isModalNavigating 为 false (即上一张图片已加载且动画完成) 时，
        // 并且模态框是可见的，才进行翻页
        if (!state.isModalNavigating && !safeClassList(elements.modal, 'contains', 'opacity-0')) {
            navigateModal(fastNavDirection);
        }
    }, 300); // 每 0.3 秒检查一次是否可以翻页
}

/**
 * 停止快速导航
 * 在用户手指离开屏幕时调用
 * @returns {void}
 */
export function stopFastNavigate() {
    clearInterval(fastNavInterval);
    fastNavInterval = null;
    fastNavDirection = null;
}

/**
 * 清理模态框资源，防止内存泄漏和事件监听器累积
 * @returns {void}
 */
export function cleanupModal() {
    // 清理快速导航定时器
    if (fastNavInterval) {
        clearInterval(fastNavInterval);
        fastNavInterval = null;
        fastNavDirection = null;
    }

    hideNavigationProgressBar(true);
    if (activeLoader) {
        try { activeLoader.abort(); } catch {}
        activeLoader = null;
    }
    
    // 清理 HLS 实例
    if (state.hlsInstance) {
        try {
            state.hlsInstance.destroy();
        } catch (e) {
            modalLogger.warn('清理 HLS 实例失败', e);
        }
        state.hlsInstance = null;
    }
    
    // 清理视频元素
    const modalVideo = elements.modal.querySelector('video');
    if (modalVideo) {
        try {
            modalVideo.pause();
            modalVideo.src = '';
            modalVideo.load();
        } catch (e) {
            modalLogger.warn('清理视频元素失败', e);
        }
    }
    
    // 清理图片手势监听
    try { if (window._imageGestureCleanup) { window._imageGestureCleanup(); window._imageGestureCleanup = null; } } catch {}

    // 清理对象 URL
    if (state.currentObjectURL) {
        try {
            URL.revokeObjectURL(state.currentObjectURL);
        } catch (e) {
            modalLogger.warn('清理对象 URL 失败', e);
        }
        state.currentObjectURL = null;
    }
    
    // 重置状态
    state.isModalNavigating = false;
    state.currentModalIndex = 0;
}

// 页面卸载时清理资源
window.addEventListener('beforeunload', cleanupModal);

// =============================================
// 通用可复用对话框（设置/确认/密码等）
// =============================================
const __sharedModalStack = [];

/**
 * 创建一个通用对话框外壳，带有可访问性、焦点陷阱与滚动锁定
 * @param {Object} options
 * @param {string} [options.title]
 * @param {string} [options.description]
 * @param {boolean} [options.asForm=false]
 * @param {Function} [options.onClose]
 * @param {string} [options.variant]
 * @param {boolean} [options.mobileFullscreen=false]
 * @param {boolean} [options.useHeader=true]
 * @returns {{overlay: HTMLElement, container: HTMLElement, body: HTMLElement, footer: HTMLElement, close: (reason?: string)=>void}}
 */
export function createModalShell(options = {}) {
    const {
        title = '',
        description = '',
        asForm = false,
        onClose = () => {},
        variant = '',
        mobileFullscreen = false,
        useHeader = true
    } = options;

    const overlay = document.createElement('div');
    overlay.className = 'download-modal-backdrop';
    overlay.setAttribute('data-modal-backdrop', 'true');

    const container = document.createElement(asForm ? 'form' : 'div');
    container.className = 'download-modal';
    if (variant) container.classList.add(variant);
    if (mobileFullscreen) container.classList.add('modal-fullscreen-mobile');
    if (asForm) container.setAttribute('novalidate', 'novalidate');
    container.setAttribute('role', 'dialog');
    container.setAttribute('aria-modal', 'true');
    container.tabIndex = -1;

    if (useHeader) {
        const header = document.createElement('header');
        const heading = document.createElement('h3');
        heading.textContent = String(title || '');
        const headingId = `app-modal-title-${Date.now().toString(16)}-${Math.random().toString(16).slice(2,8)}`;
        heading.id = headingId;
        container.setAttribute('aria-labelledby', headingId);

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'modal-close';
        closeButton.setAttribute('aria-label', '关闭');
        closeButton.innerHTML = '&times;';

        header.appendChild(heading);
        header.appendChild(closeButton);
        container.appendChild(header);

        closeButton.addEventListener('click', () => cleanup('cancel'));
    } else if (title) {
        // 无头部时仍提供无障碍名称
        container.setAttribute('aria-label', String(title));
    }

    if (description) {
        const desc = document.createElement('p');
        desc.className = 'modal-description';
        desc.textContent = description;
        container.appendChild(desc);
    }

    const body = document.createElement('div');
    body.className = 'modal-body';
    container.appendChild(body);

    const footer = document.createElement('footer');
    container.appendChild(footer);

    overlay.appendChild(container);
    document.body.appendChild(overlay);

    // 锁定滚动
    lockScroll();

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    function handleBackdrop(e) {
        if (e.target === overlay) {
            cleanup('cancel');
        }
    }

    function handleKeydown(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            cleanup('cancel');
            return;
        }
        if (e.key === 'Tab') {
            const focusables = getFocusableElements(container);
            if (!focusables.length) {
                e.preventDefault();
                try { container.focus({ preventScroll: true }); } catch { container.focus(); }
                return;
            }
            const current = focusables.indexOf(document.activeElement);
            let next = current;
            if (e.shiftKey) next = current <= 0 ? focusables.length - 1 : current - 1;
            else next = current === focusables.length - 1 ? 0 : current + 1;
            e.preventDefault();
            try { focusables[next].focus({ preventScroll: true }); } catch { focusables[next].focus(); }
        }
    }

    let closed = false;
    function cleanup(reason) {
        if (closed) return;
        closed = true;
        overlay.removeEventListener('pointerdown', handleBackdrop);
        container.removeEventListener('keydown', handleKeydown);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        // 出栈
        const idx = __sharedModalStack.indexOf(close);
        if (idx !== -1) __sharedModalStack.splice(idx, 1);
        // 解锁滚动
        unlockScroll();
        // 焦点返回
        setTimeout(() => {
            const top = __sharedModalStack[__sharedModalStack.length - 1];
            if (top && top.__container && top.__container.isConnected) {
                try { top.__container.focus({ preventScroll: true }); } catch { top.__container.focus(); }
            } else if (previouslyFocused && previouslyFocused.isConnected) {
                try { previouslyFocused.focus({ preventScroll: true }); } catch { previouslyFocused.focus(); }
            }
        }, 0);
        // 回调
        if (typeof onClose === 'function') onClose(reason);
    }

    overlay.addEventListener('pointerdown', handleBackdrop, { passive: true });
    container.addEventListener('keydown', handleKeydown);

    // 初始聚焦
    setTimeout(() => {
        const focusables = getFocusableElements(container);
        if (focusables.length) {
            try { focusables[0].focus({ preventScroll: true }); } catch { focusables[0].focus(); }
        } else {
            try { container.focus({ preventScroll: true }); } catch { container.focus(); }
        }
    }, 0);

    function close(reason) { cleanup(reason); }
    close.__container = container;
    __sharedModalStack.push(close);

    return { overlay, container, body, footer, close };
}

export function cleanupAllModals() {
    while (__sharedModalStack.length > 0) {
        const top = __sharedModalStack[__sharedModalStack.length - 1];
        if (typeof top === 'function') {
            try { top('cleanup'); } catch {}
        } else {
            __sharedModalStack.pop();
        }
    }
}
