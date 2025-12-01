/**
 * @file frontend/js/modal/index.js
 * @description 管理图片/视频模态框的加载、导航与交互行为
 */

import { state, backdrops } from '../core/state.js';
import { elements } from '../shared/dom-elements.js';
import { preloadNextImages, showNotification } from '../shared/utils.js';
import { generateImageCaption, updateAIChatContext } from '../app/api.js';
import { recordHierarchyView } from '../features/history/history-service.js';
import Hls from 'hls.js';
import { enablePinchZoom } from '../features/gallery/touch.js';
import { createModuleLogger } from '../core/logger.js';
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
    Object.assign(img.style, {
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
    Object.assign(img.style, {
        transition: 'filter 420ms ease, transform 420ms ease, opacity 420ms ease',
        imageRendering: 'pixelated',
        filter: 'contrast(135%) brightness(1.05) saturate(0.9)',
        transform: 'scale(1.016)',
        opacity: '0.9'
    });
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            img.style.filter = 'none';
            img.style.transform = 'scale(1)';
            img.style.opacity = '1';
            setTimeout(() => {
                img.style.transition = '';
                img.style.imageRendering = '';
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

/**
 * 隐藏模态框控制元素，包括关闭按钮和 AI 控制容器
 * @returns {void}
 */
function hideModalControls() {
    elements.modalClose?.classList.add('opacity-0');
}

/**
 * 显示模态框控制元素，包括关闭按钮和 AI 控制容器
 * @returns {void}
 */
function showModalControls() {
    elements.modalClose?.classList.remove('opacity-0');
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
    Object.assign(spinner.style, {
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
    const { modalVideo, modalImg, navigationHint, mediaPanel } = elements;
    const shouldPixelate = !!(effects && effects.pixelate);

    // 移除旧的视频加载器
    const oldSpinner = mediaPanel.querySelector('#video-spinner');
    if (oldSpinner) oldSpinner.remove();

    // 清理之前的媒体内容
    try { modalVideo.pause(); } catch { }
    try { modalVideo.removeAttribute('src'); modalVideo.load(); } catch { }
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

    inactiveBackdropElem.style.backgroundImage = `url('${blurSource}')`;
    activeBackdropElem?.classList.remove('active-backdrop');
    inactiveBackdropElem?.classList.add('active-backdrop');
    state.activeBackdrop = inactiveBackdropKey;

    // 根据媒体类型和 AI 状态显示相应元素
    // 实时检查 AI 是否启用，而不是依赖可能过期的 state
    const localAI = JSON.parse(localStorage.getItem('ai_settings') || '{}');
    const isAIEnabled = localAI.AI_ENABLED === 'true' || state.aiEnabled;
    const showAiElements = !isVideo && isAIEnabled;
    updateAIChatContext(showAiElements ? originalPathForAI : null, { enabled: showAiElements });

    resetModalImageTransition();
    modalVideo?.classList.toggle('hidden', !isVideo);
    modalImg?.classList.toggle('hidden', isVideo);

    if (isVideo) {
        const myToken = ++activeVideoToken;
        navigationHint?.classList.remove('show-hint');
        navigationHint.style.display = 'none';

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
            try { if (_onResizeRef) window.removeEventListener('resize', _onResizeRef); } catch { }
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
        };

        /**
         * 视频数据加载事件处理
         */
        const onLoadedData = () => {
            if (myToken !== activeVideoToken) return cleanup();
            removeSpinnerAndUnbind();
        };

        /**
         * 视频时间更新事件处理
         */
        const onTimeUpdate = () => {
            if (myToken !== activeVideoToken) return cleanup();
            removeSpinnerAndUnbind();
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
            modalVideo.style.width = `${Math.round(width)}px`;
            modalVideo.style.height = `${Math.round(height)}px`;
            try { modalVideo.style.aspectRatio = `${vw}/${vh}`; } catch { }
        };

        /**
         * 视频元数据加载完成事件处理
         */
        const onLoadedMetadata = () => {
            applyStableSize();
        };

        cleanup(); // 清理前一个实例

        if (Hls.isSupported()) {
            const hls = new Hls({
                // HLS.js 配置：默认 720p,允许自适应降级
                startLevel: 1, // 默认使用索引 1 的质量(通常是 720p)
                abrEwmaDefaultEstimate: 1500000, // 1.5Mbps 初始估算,适合 720p
                // 允许自适应比特率,网络慢时会自动降级到 480p
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
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            modalLogger.error('HLS 网络错误', data);
                            // 致命网络错误时回退到直接播放
                            if (myToken === activeVideoToken) {
                                modalLogger.warn('HLS 失败，回退到直接播放');
                                // 仅销毁 HLS 实例，保留 playing/error 监听，用于移除加载圈
                                if (state.hlsInstance) {
                                    try { state.hlsInstance.destroy(); } catch { }
                                    state.hlsInstance = null;
                                }
                                modalVideo.src = mediaSrc;
                                // 重新绑定事件监听
                                try { modalVideo.removeEventListener('playing', onPlaying); } catch { }
                                try { modalVideo.removeEventListener('error', onError); } catch { }
                                try { modalVideo.removeEventListener('canplay', onCanPlay); } catch { }
                                try { modalVideo.removeEventListener('loadeddata', onLoadedData); } catch { }
                                try { modalVideo.removeEventListener('timeupdate', onTimeUpdate); } catch { }
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
                                try { state.hlsInstance.destroy(); } catch { }
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

    } else {
        // 图片处理逻辑
        navigationHint.style.display = 'flex';
        if (modalImg._pendingPixelationHandler) {
            try { modalImg.removeEventListener('load', modalImg._pendingPixelationHandler); } catch { }
            modalImg._pendingPixelationHandler = null;
        }
        /**
         * 图片加载完成事件处理
         */
        const onModalImageLoad = () => {
            modalImg._pendingPixelationHandler = null;
            if (shouldPixelate) {
                triggerPixelatedReveal();
            } else {
                resetModalImageTransition();
            }
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

            setChatStatus('她正在酝酿情绪，请稍候...', 'muted');
        }

        // 启用移动端双指缩放/拖拽（touch.js）
        try {
            if (window._imageGestureCleanup) { try { window._imageGestureCleanup(); } catch { } }
            window._imageGestureCleanup = enablePinchZoom(modalImg, mediaPanel);
        } catch { }
    }

    // 预加载下一批图片
    preloadNextImages(state.currentPhotos, index);
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
        try { activeLoader.abort(); } catch { }
    }

    const controller = new AbortController();
    const { signal } = controller;
    activeLoader = controller;

    scheduleNavigationProgressBar(navDirection);

    try {
        const response = await fetch(mediaSrc, { signal });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        let blob;

        if (!response.body || !response.body.getReader) {
            blob = await response.blob();
            setNavigationProgress(1);
            setNavigationBlurProgress(1);
        } else {
            const reader = response.body.getReader();
            streamContentLength = Number(response.headers.get('Content-Length')) || 0;
            let receivedLength = 0;
            streamFallbackChunks = 0;

            const stream = new ReadableStream({
                start(streamController) {
                    const onAbort = () => {
                        try { reader.cancel(); } catch { }
                        try { streamController.close(); } catch { }
                    };
                    if (signal && typeof signal.addEventListener === 'function') {
                        if (signal.aborted) return onAbort();
                        signal.addEventListener('abort', onAbort, { once: true });
                    }
                    const pump = () => {
                        reader.read().then(({ done, value }) => {
                            if (done) {
                                try { streamController.close(); } catch { }
                                return;
                            }
                            if (value) {
                                receivedLength += value.length;
                                if (streamContentLength) {
                                    const ratio = Math.min(0.99, receivedLength / streamContentLength);
                                    setNavigationProgress(ratio);
                                    setNavigationBlurProgress(ratio);
                                } else {
                                    streamFallbackChunks = Math.min(9, streamFallbackChunks + 1);
                                    const estimated = Math.min(0.9, streamFallbackChunks / 9);
                                    setNavigationProgress(estimated);
                                    setNavigationBlurProgress(estimated);
                                }
                                try { streamController.enqueue(value); } catch { }
                            }
                            pump();
                        }).catch(err => {
                            if (err && err.name === 'AbortError') {
                                try { streamController.close(); } catch { }
                                return;
                            }
                            modalLogger.error('流读取错误', err);
                            try { streamController.error(err); } catch { }
                        });
                    };
                    pump();
                }
            });

            blob = await new Response(stream).blob();
            if (!signal.aborted) {
                setNavigationProgress(1);
                setNavigationBlurProgress(1);
            }
        }

        const finishedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
        const elapsed = finishedAt - startedAt;
        if (!shouldPixelateReveal) {
            const durationSlow = elapsed > 420;
            const chunkSlow = streamFallbackChunks >= 4;
            const noLengthSlow = !streamContentLength && elapsed > 320;
            shouldPixelateReveal = durationSlow || chunkSlow || noLengthSlow;
        }

        if (signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        const objectURL = URL.createObjectURL(blob);
        updateModalContent(objectURL, index, originalPath, undefined, { pixelate: shouldPixelateReveal });
        state.currentObjectURL = objectURL;
    } catch (error) {
        if (error.name !== 'AbortError') {
            setNavigationProgress(1);
            setNavigationBlurProgress(1);
            try {
                updateModalContent(mediaSrc, index, originalPath, undefined, { pixelate: shouldPixelateReveal });
            } catch { }
            showNotification('图片加载或解码失败', 'error');
        }
    } finally {
        if (activeLoader === controller) {
            activeLoader = null;
        }
        state.isModalNavigating = false;
        hideNavigationProgressBar();
    }
}

/**
 * 关闭模态框，清理所有状态与 DOM 元素
 * @returns {void}
 */
export function closeModal() {
    if (elements.modal?.classList.contains('opacity-0')) return;

    // 移除模态框相关类
    // 注意：document.documentElement 和 document.body 的 classList 操作保持原样
    // 因为这些是特殊 DOM 元素，不在我们的封装范围内
    document.documentElement.classList.remove('modal-open');
    document.body.classList.remove('modal-open');
    elements.modal?.classList.add('opacity-0');
    elements.modal?.classList.add('pointer-events-none');

    // 确保停止快速导航，避免定时器泄漏
    if (typeof stopFastNavigate === 'function') {
        stopFastNavigate();
    }

    // 清理模态框资源
    cleanupModal();

    // 清理媒体内容
    elements.modalImg.src = '';
    elements.modalVideo.pause();
    elements.modalVideo.src = '';

    // 清理背景
    backdrops.one.style.backgroundImage = 'none';
    backdrops.two.style.backgroundImage = 'none';

    // 清理对象 URL
    if (state.currentObjectURL) {
        URL.revokeObjectURL(state.currentObjectURL);
        state.currentObjectURL = null;
    }

    if (document.activeElement) document.activeElement.blur();
    updateAIChatContext(null, { enabled: false });

    // 恢复滚动位置
    if (state.scrollPositionBeforeModal !== null) {
        window.scrollTo({ top: state.scrollPositionBeforeModal, behavior: 'instant' });
        state.scrollPositionBeforeModal = null;
    }

    // 恢复焦点到缩略图
    if (state.activeThumbnail) {
        state.activeThumbnail.focus({ preventScroll: true });
        state.activeThumbnail = null;
    }
}

/**
 * 模态框导航至上一项或下一项
 * @param {'prev'|'next'} direction - 导航方向
 * @returns {void}
 */
export function navigateModal(direction) {
    if (document.activeElement) document.activeElement.blur();
    if (state.isModalNavigating) return;

    // 隐藏控制元素并设置定时器重新显示
    hideModalControls();
    clearTimeout(state.uiVisibilityTimer);
    state.uiVisibilityTimer = setTimeout(showModalControls, 500);

    // 计算新的索引
    const newIndex = direction === 'prev' ? state.currentPhotoIndex - 1 : state.currentPhotoIndex + 1;
    if (newIndex >= 0 && newIndex < state.currentPhotos.length) {
        const nextMediaSrc = state.currentPhotos[newIndex];
        const navDirection = direction === 'prev' ? 'backward' : 'forward';
        handleModalNavigationLoad(nextMediaSrc, newIndex, navDirection);
    }
}

/**
 * 处理缩略图点击事件
 * @param {HTMLElement} element - 被点击的缩略图元素
 * @param {string} mediaSrc - 媒体源 URL
 * @param {number} index - 媒体索引
 * @returns {void}
 */
export function _handleThumbnailClick(element, mediaSrc, index) {
    // 保存当前状态
    state.scrollPositionBeforeModal = window.scrollY;
    state.activeThumbnail = element;

    const photoItem = element.querySelector('.photo-item');
    if (!photoItem || photoItem?.classList.contains('is-loading')) return;

    const isVideo = /\.(mp4|webm|mov)$/i.test(mediaSrc);
    const relativePath = extractRelativePathFromStaticUrl(mediaSrc);
    if (relativePath) {
        const thumbEl = element.querySelector('img[data-src]');
        const thumbUrl = thumbEl?.dataset?.src || '';
        recordHierarchyView(relativePath, {
            entryType: isVideo ? 'video' : 'photo',
            name: relativePath.split('/').pop() || '',
            thumbnailUrl: thumbUrl,
            coverUrl: thumbUrl,
            width: Number(element.dataset.width) || 0,
            height: Number(element.dataset.height) || 0
        }).catch(() => { });
    }

    if (isVideo) {
        // 视频直接打开模态框
        const thumbEl = photoItem.querySelector('img[data-src]');
        const thumbUrl = thumbEl ? thumbEl.dataset.src : null;
        _openModal(mediaSrc, index, false, mediaSrc, thumbUrl, { pixelate: false });
        return;
    }

    // 中止之前的加载器
    if (activeLoader) activeLoader.abort();

    // 初始化进度圆环
    const progressCircle = photoItem.querySelector('.progress-circle-bar');
    const loadingOverlay = photoItem.querySelector('.loading-overlay');
    let overlayShowTimer = null;
    if (progressCircle) {
        const radius = progressCircle.r.baseVal.value;
        const circumference = 2 * Math.PI * radius;
        progressCircle.style.strokeDasharray = `${circumference} ${circumference}`;
        progressCircle.style.strokeDashoffset = circumference;
    }
    if (loadingOverlay) {
        Object.assign(loadingOverlay.style, {
            display: 'none',
            opacity: '0'
        });
        overlayShowTimer = setTimeout(() => {
            Object.assign(loadingOverlay.style, {
                display: 'flex',
                opacity: '1'
            });
            overlayShowTimer = null;
        }, 180);
    }

    photoItem?.classList.add('is-loading');

    // 创建新的加载控制器
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
                            try { reader.cancel(); } catch { }
                            try { controller.close(); } catch { }
                        };
                        if (signal && typeof signal.addEventListener === 'function') {
                            if (signal.aborted) return onAbort();
                            signal.addEventListener('abort', onAbort, { once: true });
                        }

                        function push() {
                            reader.read().then(({ done, value }) => {
                                if (done) {
                                    try { controller.close(); } catch { }
                                    return;
                                }
                                receivedLength += value.length;
                                // 更新进度圆环
                                if (headerContentLength && progressCircle) {
                                    const progress = receivedLength / headerContentLength;
                                    const circumference = 2 * Math.PI * progressCircle.r.baseVal.value;
                                    const offset = circumference - progress * circumference;
                                    progressCircle.style.strokeDashoffset = offset;
                                }
                                streamedChunkCount = Math.min(12, streamedChunkCount + 1);
                                try { controller.enqueue(value); } catch { }
                                push();
                            }).catch(error => {
                                // 中止不视为错误，不再上抛，直接关闭流
                                if (error && error.name === 'AbortError') {
                                    try { controller.close(); } catch { }
                                    return;
                                }
                                modalLogger.error('流读取错误', error);
                                try { controller.error(error); } catch { }
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
            try { _openModal(mediaSrc, index, false, mediaSrc, undefined, { pixelate: slowRevealNeeded }); } catch { }
            showNotification('图片加载失败', 'error');
        })
        .finally(() => {
            if (overlayShowTimer) {
                clearTimeout(overlayShowTimer);
                overlayShowTimer = null;
            }
            photoItem?.classList.remove('is-loading');
            if (loadingOverlay) {
                Object.assign(loadingOverlay.style, {
                    display: 'none',
                    opacity: '0'
                });
            }
            if (activeLoader === controller) activeLoader = null;
        });
}

function extractRelativePathFromStaticUrl(url = '') {
    if (!url || !url.startsWith('/static/')) return '';
    const relative = url.substring(8);
    return relative
        .split('/')
        .map(segment => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        })
        .join('/');
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

    elements.modal?.classList.remove('opacity-0');
    elements.modal?.classList.remove('pointer-events-none');

    // 更新模态框内容
    const aiPath = originalPathForAI || mediaSrc;
    updateModalContent(mediaSrc, index, aiPath, thumbForBlur, effects);

    if (isObjectURL) state.currentObjectURL = mediaSrc;

    // 显示导航提示（仅首次）
    if (!state.hasShownNavigationHint && window.innerWidth > 768) {
        elements.navigationHint?.classList.add('show-hint');
        state.hasShownNavigationHint = true;
        setTimeout(() => elements.navigationHint?.classList.remove('show-hint'), 4000);
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

    const resolveSortQuery = () => {
        if (state.currentSort && state.currentSort !== 'smart') {
            return `?sort=${state.currentSort}`;
        }
        if (state.entrySort && state.entrySort !== 'smart') {
            return `?sort=${state.entrySort}`;
        }
        const hash = window.location.hash || '';
        const idx = hash.indexOf('?');
        return idx !== -1 ? hash.substring(idx) : '';
    };

    window.location.hash = `/${encodeURIComponent(albumPath)}${resolveSortQuery()}`;
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
        if (!state.isModalNavigating && !elements.modal?.classList.contains('opacity-0')) {
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
        try { activeLoader.abort(); } catch { }
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
    try { if (window._imageGestureCleanup) { window._imageGestureCleanup(); window._imageGestureCleanup = null; } } catch { }

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
