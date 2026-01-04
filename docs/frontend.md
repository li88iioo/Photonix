# 前端技术架构

Photonix 的前端采用了一种极简且现代的设计哲学：**不使用 React/Vue 等重型框架，回归 Vanilla JS (原生 JavaScript) 的高性能与高控制感。**

---

## 🎨 核心设计理念

### 1. 无框架 SPA (Vanilla JS SPA)
- **为什么不使用框架？** 为了极致的加载速度和极低的运行时内存占用。相册应用涉及海量 DOM 操作（瀑布流），原生操作能提供更精准的性能调优空间。
- **状态管理**：采用响应式 Proxy 对象（`frontend/js/core/state.js`）。当状态变更时，通过自定义事件通知相关组件。
- **路由逻辑**：基于 `hashchange` 实现的零依赖路由器。支持视图预排版与路由拦截。

### 2. 原子化 CSS (Tailwind CSS)
- 高度定制化的 `tailwind.config.js`。
- 采用 JIT (Just-In-Time) 模式，生成的 CSS 体积极小且具备高度的一致性。

---

## ⚡ 关键技术实现

### PWA 与 缓存优化
- **Workbox**：集成了 Service Worker，实现了静态资源的预缓存与媒体内容的离线占位。
- **流式加载**：相册瀑布流由分批渲染 (Batch Rendering) 算法支撑，配合 `ResizeObserver` 实现响应式列数调整，避免在大图库下发生主线程阻塞。

### 交互与手势
- **事件总线**：由 `EventManager` 统一管理所有事件的绑定与解绑，利用 `AbortController` 防止内存泄漏。
- **手势引擎**：自研轻量级手势算法（`touch.js`），支持双指捏合缩放、长按滑动连续翻页等类原生 App 体验。

### 视觉特性
- **Glassmorphism (玻璃拟态)**：全局深度应用毛玻璃效果。
- **隐私模糊模式**：通过 CSS Filter 实时实现全局隐私控制。

---

## 🛠️ 模块分布
- `core/`：全局状态、日志、事件总线。
- `api/`：封装所有的后端交互请求。
- `features/`：功能逻辑模块（如 `gallery` 瀑布流、`ai` 聊天、`download` 订阅）。
- `shared/`：通用 UI 组件与工具函数。
