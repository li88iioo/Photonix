// frontend/sw-src.js (Workbox injectManifest 的源文件)

// 加载 Workbox 运行时（CDN）并启用预缓存注入点
try {
  importScripts('https://storage.googleapis.com/workbox-cdn/releases/7.0.0/workbox-sw.js');
  if (self.workbox && self.workbox.precaching) {
    // 构建时注入的预缓存清单
    // eslint-disable-next-line no-undef
    self.workbox.precaching.precacheAndRoute(self.__WB_MANIFEST || []);
  }
} catch (e) {
  // 如果 CDN 不可达，SW 仍可通过下面的运行时缓存工作
}

// 首先计算构建版本（必须在加载缓存管理器之前）
/**
 * 简单的哈希函数，用于生成构建版本标识
 * @param {string} str - 要哈希的字符串
 * @returns {string} 哈希值的十六进制字符串
 */
function hashString(str) {
  // FNV-1a 32 位哈希
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
}

const __WB_ENTRIES = (self && Array.isArray(self["__WB_MANIFEST"])) ? self["__WB_MANIFEST"] : [];
let __BUILD_REV = 'dev';
try {
  __BUILD_REV = hashString(JSON.stringify(__WB_ENTRIES));
} catch {}

// 加载缓存管理器 - 使用绝对路径确保在所有环境下都能正确加载
try {
  importScripts('/sw-cache-manager.js');

  // 检查缓存管理器是否正确加载
  if (typeof self.swCacheManager === 'object' && self.swCacheManager) {
    console.log('[SW] Cache manager loaded successfully');
    // 将构建版本传递给缓存管理器，确保缓存名称一致
    self.swCacheManager.__BUILD_REV = __BUILD_REV;
  } else {
    console.warn('[SW] Cache manager loaded but interface not found');
  }
} catch (error) {
  console.warn('[SW] Failed to load cache manager:', error);
}

// 缓存版本控制（自动随构建更新）
const STATIC_CACHE_VERSION = `static-${__BUILD_REV}`;
const API_CACHE_VERSION = `api-${__BUILD_REV}`;
const MEDIA_CACHE_VERSION = `media-${__BUILD_REV}`;
const THUMBNAIL_CACHE_VERSION = `thumb-${__BUILD_REV}`;

// 缓存管理器已统一处理LRU限制和清理

// --- 以下是您现有的自定义 Service Worker 逻辑 ---

// 缓存管理器已统一处理LRU限制和清理

// 统一的缓存清理函数
async function cleanupCache(cacheType) {
  try {
    if (self.swCacheManager && typeof self.swCacheManager.performLRUCleanup === 'function') {
      const cacheName = self.swCacheManager.getCacheNameForType ? self.swCacheManager.getCacheNameForType(cacheType) : `${cacheType}-${__BUILD_REV}`;
      const config = self.swCacheManager.getCacheConfig ? self.swCacheManager.getCacheConfig(cacheType) : {
        MAX_ENTRIES: cacheType === 'api' ? 500 : cacheType === 'media' ? 800 : cacheType === 'thumbnail' ? 2000 : 100,
        MAX_AGE_MS: cacheType === 'api' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000
      };
      await self.swCacheManager.performLRUCleanup(cacheName, config);
    }
  } catch (error) {
    console.warn(`[SW] Cache cleanup failed for ${cacheType}:`, error);
  }
}

// 仅缓存稳定核心；JS 使用 dist 入口，其他 chunk 运行时按策略缓存
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/output.css', // 更新为最终生成的 CSS 文件
  '/manifest.json',

  // --- JS 模块 ---
  '/js/dist/main.js',

  // --- 静态资源 (assets) ---


  // --- 外部资源 ---

];

// 检查响应是否适合缓存
function isCacheableResponse(response, request) {
  // 只缓存成功的响应
  if (!response.ok) return false;

  // 不缓存206 Partial Content响应（内网穿透常见问题）
  if (response.status === 206) return false;

  // 不缓存非GET请求
  if (request && request.method !== 'GET') return false;

  // 不缓存非基本或CORS响应
  if (response.type !== 'basic' && response.type !== 'cors') return false;

  return true;
}

// 1. 安装 Service Worker，缓存核心资源
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(STATIC_CACHE_VERSION);
      console.log('Service Worker: 正在缓存核心资源');
      // 柔性安装：单个失败不阻断 SW 安装
      await Promise.allSettled(CORE_ASSETS.map(u => cache.add(u)));
    } catch (e) {
      // 忽略，继续安装
      console.warn('SW 安装：某些核心资源缓存失败:', e && e.message);
    }
    await self.skipWaiting();
  })());
});

// 2. 激活 Service Worker，清理旧缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames.map(cacheName => {
          // 保留 Workbox 预缓存与当前版本缓存
          if (cacheName.startsWith('workbox-')) return Promise.resolve();
          if (
            cacheName === STATIC_CACHE_VERSION ||
            cacheName === API_CACHE_VERSION ||
            cacheName === MEDIA_CACHE_VERSION
          ) {
            return Promise.resolve();
          }

          // 仅清理我们自己命名空间下的历史缓存，避免误删其他缓存
          const isOurCache =
            cacheName.startsWith('static-') ||
            cacheName.startsWith('api-') ||
            cacheName.startsWith('media-');

          // 显式清理旧的 API 专用缓存（如 api-search-v1）与非当前版本的 api-* 缓存
          const isLegacyApiSearch = cacheName === 'api-search-v1';
          const isStaleApiCache = cacheName.startsWith('api-') && cacheName !== API_CACHE_VERSION;
          const isStaleStaticCache = cacheName.startsWith('static-') && cacheName !== STATIC_CACHE_VERSION;
          const isStaleMediaCache = cacheName.startsWith('media-') && cacheName !== MEDIA_CACHE_VERSION;

          if (isLegacyApiSearch || isStaleApiCache || isStaleStaticCache || isStaleMediaCache || isOurCache) {
            console.log('Service Worker: 删除旧缓存:', cacheName);
            return caches.delete(cacheName);
          }

          return Promise.resolve();
        })
      );

      await self.clients.claim(); // 立即接管所有页面
      // 激活后进行一次异步LRU清理
      cleanupCache('api');
      cleanupCache('media');
      cleanupCache('thumbnail');
    })()
  );
});

// 3. 拦截 fetch 请求，按类型采用不同缓存策略
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  const hasAuth = request.headers && (request.headers.get('Authorization') || request.headers.get('authorization'));

  // 优先处理页面导航：使用网络优先，失败回退缓存，避免部署后白屏
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          // 后台更新 index.html 缓存
          const copy = response.clone();
          // 使用统一缓存接口
          if (self.swCacheManager && typeof self.swCacheManager.putWithLRU === 'function') {
            self.swCacheManager.putWithLRU('static', new Request('/index.html'), copy).catch(() => {});
          } else {
            caches.open(STATIC_CACHE_VERSION).then(cache => cache.put('/index.html', copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // A. 认证与设置接口：一律网络直连并禁用缓存
  if (url.pathname.startsWith('/api/auth/')) {
    event.respondWith(fetch(new Request(request, { cache: 'no-store' })));
    return;
  }
  if (url.pathname === '/api/settings') {
    event.respondWith(fetch(new Request(request, { cache: 'no-store' })));
    return;
  }

  // 0. 前端构建产物（/js/dist/* 与 /output.css）：网络优先 + 回退缓存，减少升级不一致导致的白屏
  if (
    url.pathname.startsWith('/js/dist/') ||
    url.pathname === '/output.css'
  ) {
    event.respondWith(
      fetch(request)
        .then(resp => {
          if (isCacheableResponse(resp, request)) {
            const copy = resp.clone();
            caches.open(STATIC_CACHE_VERSION).then(cache => cache.put(request, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match(request).then(r => r || new Response('', { status: 503, statusText: '服务不可用' })))
    );
    return;
  }

  // 1. /api/search 采用网络优先
  if (url.pathname.startsWith('/api/search')) {
    // 携带 Authorization 时不参与 SW 缓存，避免将私人响应写入共享缓存
    if (hasAuth) {
      event.respondWith(fetch(request));
      return;
    }
    event.respondWith(
      fetch(request)
        .then(response => {
          if (isCacheableResponse(response, request)) {
            const responseForCache = response.clone();

            if (self.swCacheManager && typeof self.swCacheManager.putWithLRU === 'function') {
              self.swCacheManager.putWithLRU('api', request, responseForCache).catch(() => {});
            } else {
              caches.open(API_CACHE_VERSION)
                .then(cache => cache.put(request, responseForCache))
                .then(() => cleanupCache('api'))
                .catch(() => {});
            }

            return response;
          }
          return response;
        })
        .catch(() => caches.match(request).then(r => r || new Response('', { status: 503, statusText: '服务不可用' })))
    );
    return;
  }

  // 2. /api/browse/ 采用网络优先 + 短 SWR（仅缓存 200）
  if (url.pathname.startsWith('/api/browse/')) {
    // 对于非GET请求（如POST /api/browse/viewed），直接转发不缓存
    if (request.method !== 'GET') {
      event.respondWith(
        fetch(request)
          .then(response => response)
          .catch(() => new Response('', { status: 503, statusText: '服务不可用' }))
      );
      return;
    }
    if (hasAuth) {
      event.respondWith(fetch(request));
      return;
    }
    
    // 对于GET请求，采用网络优先策略，并为 200 响应写入短期缓存
    event.respondWith(
      fetch(request)
        .then(networkResponse => {
          if (networkResponse.status === 200 && isCacheableResponse(networkResponse, request)) {
            const responseForCache = networkResponse.clone();
            return caches.open(API_CACHE_VERSION)
              .then(cache => cache.put(request, responseForCache))
              .then(() => {
                cleanupCache('api');
                return networkResponse;
              });
          }
          return networkResponse;
        })
        .catch(error => {
          console.warn('浏览 API 的网络请求失败:', error);
          // SWR：返回缓存（若有），无缓存则 503
          return caches.match(request).then(r => r || new Response('', { status: 503, statusText: '服务不可用' }));
        })
    );
    return;
  }

  // 3. /api/thumbnail 采用激进缓存策略：缓存优先 + 后台更新
  if (url.pathname.startsWith('/api/thumbnail')) {
    event.respondWith(
      caches.open(THUMBNAIL_CACHE_VERSION).then(cache => {
        return cache.match(request).then(cachedResponse => {
          // 后台更新策略
          const fetchPromise = fetch(new Request(request, { cache: 'no-store' }))
            .then(networkResponse => {
              if (networkResponse.status === 200 && isCacheableResponse(networkResponse, request)) {
                const responseForCache = networkResponse.clone();
                cache.put(request, responseForCache).catch(err => {
                  console.warn('缩略图缓存失败:', err);
                });
                cleanupCache('thumbnail');
              }
              return networkResponse;
            })
            .catch(() => new Response('', { status: 503, statusText: '服务不可用' }));
          
          // 如果有缓存，立即返回缓存，同时后台更新
          if (cachedResponse) {
            fetchPromise.catch(() => {}); // 静默处理后台更新错误
            return cachedResponse;
          }
          
          // 无缓存时等待网络请求
          return fetchPromise;
        });
      })
    );
    return;
  }

  // 4. 其他 /api/ 采用缓存优先+后台更新（SWR，不包括 /api/search/thumbnail）
  if (url.pathname.startsWith('/api/')) {
    if (request.method !== 'GET') {
      event.respondWith(
        fetch(request)
          .then(response => response)
          .catch(() => new Response('', { status: 503, statusText: '服务不可用' }))
      );
      return;
    }
    if (hasAuth) {
      // 携带 Authorization 的请求完全绕过缓存
      event.respondWith(fetch(request));
      return;
    }
    event.respondWith(
      caches.open(API_CACHE_VERSION).then(cache => {
        return cache.match(request).then(response => {
          const fetchPromise = fetch(request).then(networkResponse => {
            if (networkResponse.ok && isCacheableResponse(networkResponse, request)) {
              const responseForCache = networkResponse.clone();
              cache.put(request, responseForCache).catch(err => {
                console.warn('API 响应缓存失败:', err);
              });
            }
            return networkResponse;
          }).catch(() => new Response('', { status: 503, statusText: '服务不可用' }));
          return response || fetchPromise;
        });
      })
    );
    return;
  }

  // 5. 静态媒体资源 - 激进缓存策略
  if (url.pathname.startsWith('/static/') || url.pathname.startsWith('/thumbs/')) {
    // 对 Range 请求与视频资源禁用缓存，直接走网络，避免大文件卡顿与 206 兼容问题
    const hasRange = request.headers && request.headers.has('range');
    const fetchDirect = () => fetch(new Request(request, { cache: 'no-store' }))
      .then(resp => resp)
      .catch(() => new Response('', { status: 503, statusText: '服务不可用' }));

    if (hasRange) {
      event.respondWith(fetchDirect());
      return;
    }

    // HLS 清单与分片一律不缓存，强制走网络直连
    const pathname = url.pathname.toLowerCase();
    if (pathname.endsWith('.m3u8') || pathname.endsWith('.ts') || pathname.includes('/thumbs/hls/')) {
      event.respondWith(fetchDirect());
      return;
    }

    // 激进缓存策略：缓存优先 + 后台更新
    event.respondWith(
      caches.open(MEDIA_CACHE_VERSION).then(cache => {
        return cache.match(request).then(cachedResponse => {
          // 后台更新策略
          const fetchPromise = fetch(new Request(request, { cache: 'no-store' }))
            .then(networkResponse => {
              // 对所有成功响应进行缓存（移除文件大小限制）
              if (networkResponse.ok && isCacheableResponse(networkResponse, request)) {
                const ct = (networkResponse.headers.get('Content-Type') || '').toLowerCase();
                const isVideo = ct.startsWith('video/');
                
                // 缓存图片和小于 10MB 的非视频文件
                const cl = parseInt(networkResponse.headers.get('Content-Length') || '0', 10) || 0;
                const shouldCache = !isVideo && (cl === 0 || cl <= 10 * 1024 * 1024);
                
                if (shouldCache) {
                  const copy = networkResponse.clone();
                  cache.put(request, copy).catch(err => {
                    console.warn('媒体缓存失败:', err);
                  });
                  cleanupCache('media');
                }
              }
              return networkResponse;
            })
            .catch(() => new Response('', { status: 503, statusText: '服务不可用' }));
          
          // 如果有缓存，立即返回缓存，同时后台更新
          if (cachedResponse) {
            fetchPromise.catch(() => {}); // 静默处理后台更新错误
            return cachedResponse;
          }
          
          // 无缓存时等待网络请求
          return fetchPromise;
        });
      })
    );
    return;
  }

  // 6. 核心静态资源（不含页面导航，导航已在最前处理）
  if (CORE_ASSETS.some(asset => url.pathname.endsWith(asset.replace(/^\//, '')) || url.pathname === '/')) {
    event.respondWith(
      caches.match(request).then(cachedResponse => {
        return cachedResponse || fetch(request).then(response => {
          if (response.ok && isCacheableResponse(response, request)) {
            const responseForCache = response.clone();
            return caches.open(STATIC_CACHE_VERSION)
              .then(cache => cache.put(request, responseForCache))
              .then(() => response);
          }
          return response;
        }).catch(() => new Response('', { status: 503, statusText: '服务不可用' }));
      })
    );
    return;
  }

  // 7. 离线兜底页（当页面导航失败时）
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 8. 其他请求，Stale-While-Revalidate
  event.respondWith(
    caches.open(STATIC_CACHE_VERSION).then(cache => {
      return cache.match(request).then(response => {
        let fetchPromise = fetch(request).then(networkResponse => {
          if (networkResponse.ok && isCacheableResponse(networkResponse, request)) {
            const responseForCache = networkResponse.clone();
            cache.put(request, responseForCache).catch(err => {
              console.warn('响应缓存失败:', err);
            });
          }
          return networkResponse;
        }).catch(() => new Response('', { status: 503, statusText: '服务不可用' }));
        return response || fetchPromise;
      });
    })
  );
});


// 4. 后台同步，处理离线请求
self.addEventListener('sync', event => {
    if (event.tag === 'sync-gallery-requests') {
        console.log('Service Worker: 后台同步已触发');
        event.waitUntil(syncFailedRequests());
    }
});

function syncFailedRequests() {
    return openDb().then(db => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const requests = store.getAll();
        return new Promise(resolve => {
            requests.onsuccess = () => {
                const failedRequests = requests.result;
                const promises = failedRequests.map(req => {
                    if (req.type === 'search') {
                        return fetch(`/api/search?q=${encodeURIComponent(req.query)}`);
                    } else if (req.type === 'ai-caption') {
                        return fetch('/api/ai/generate', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(req.payload)
                        });
                    }
                });
                Promise.all(promises).then(() => {
                    const writeTx = db.transaction(STORE_NAME, 'readwrite');
                    writeTx.objectStore(STORE_NAME).clear();
                    resolve();
                });
            };
        });
    });
}

const DB_NAME = 'offline-requests-db';
const STORE_NAME = 'requests';

// 打开 IndexedDB 数据库
function openDb() {
    return new Promise((resolve, reject) => {
        const request = self.indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = event => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { autoIncrement: true });
            }
        };
        request.onsuccess = event => resolve(event.target.result);
        request.onerror = event => reject(event.target.error);
    });
}

// 5. 监听手动刷新消息，清除 API 缓存
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'MANUAL_REFRESH') {
        console.log('Service Worker: 手动刷新 API 数据已触发');
        event.waitUntil(
            (async () => {
                // 清理与 API 相关的所有缓存（含搜索专用缓存）
                const keys = await caches.keys();
                await Promise.all(keys.map(k => {
                    if (k === API_CACHE_VERSION || k === THUMBNAIL_CACHE_VERSION || k.startsWith('api-') || k.startsWith('thumb-')) {
                        return caches.delete(k);
                    }
                }));
                console.log('Service Worker: API 缓存已清除');
                // 只清理被清除的缓存类型
                cleanupCache('api');
                cleanupCache('thumbnail');
            })()
        );
    }
});


