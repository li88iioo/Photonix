# 光影画廊 | Shadow Gallery

一个极简、AI驱动的智能图片画廊，支持 PWA、流式加载、多数据库架构与高性能缓存。

## ✨ 主要特性

### 🎭 AI 智能交互
- **AI 画中密语**：AI 扮演照片人物，沉浸式对话体验
- **自定义提示词**：支持多种AI角色设定，从温馨对话到私密互动
- **异步任务处理**：AI内容生成采用队列机制，避免阻塞
- **智能缓存**：AI生成内容持久化缓存，降低成本

### 🖼️ 图片管理
- **流式图片加载**：大相册极速响应，懒加载优化
- **智能缩略图**：自动生成多尺寸缩略图，支持失败重试机制
- **视频处理**：自动视频优化，支持多种格式转码
- **瀑布流布局**：响应式瀑布流，自适应屏幕尺寸

### 🔒 安全防护
- **一键全局模糊**：键盘单击 ***B*** && 三指触摸屏幕
- **密码保护**：可选密码访问，支持公开/私有模式切换
- **路径校验**：严格的文件路径安全检查
- **速率限制**：API访问频率控制，防止滥用

### 🚀 性能优化
- **多数据库架构**：主数据库、设置数据库、历史记录数据库、索引数据库分离
- **Redis 高性能缓存**：AI内容与搜索结果持久缓存
- **Worker 线程池**：缩略图生成、AI处理、索引重建多线程并发
- **智能索引**：SQLite FTS5全文搜索，支持模糊匹配

### 📱 用户体验
- **PWA 支持**：可安装、离线访问，移动端手势切换
- **响应式设计**：完美适配桌面端和移动端
- **触摸手势**：移动端滑动切换图片
- **键盘导航**：桌面端键盘快捷键操作
- **搜索历史**：智能搜索历史记录，快速重复搜索

### 🛠️ 运维友好
- **Docker 部署**：一键部署，环境隔离
- **健康检查**：容器健康状态监控
- **日志系统**：结构化日志，便于问题排查
- **数据迁移**：自动数据库迁移，平滑升级

## 🚀 快速开始

### 1. 环境准备
```bash
# 必需环境
- Docker & Docker Compose（推荐）
- Node.js 20+（本地开发可选）
- 至少 2GB 可用内存
```

### 2. 克隆项目
```bash

cd Shadow-Gallery
```

### 3. 配置环境变量（可选）

默认可直接启动，无需 `.env`。仅当你需要自定义端口或安全密钥时，在项目根目录（与 `docker-compose.yml` 同级）创建 `.env`：


### 4. 准备照片目录
```bash
# 创建照片目录（推荐挂载到宿主机）
mkdir -p /opt/photos
# 将你的照片放入此目录
```

### 5. 启动服务
```bash
# 构建并启动（单容器 + Redis）
docker compose up -d --build

# 查看服务状态
docker compose ps

# 查看日志
docker compose logs -f
```

### 6. 访问应用
- **应用与 API（同域）**：[http://localhost:12080](http://localhost:12080)
  - API 前缀：`/api`（例如：`http://localhost:12080/api/browse`）
- **Redis**：`localhost:6379`（可选）

## 📁 项目架构

```
Shadow-Gallery/
├── Dockerfile                          # 单容器构建（前端打包→拷贝到 backend/public，pm2 启动 server+ai-worker）
├── docker-compose.yml                   # 编排（app + redis），端口与卷映射
├── README.md                            # 项目说明
├── AIPROMPT.md                          # AI 提示词示例
├── .gitignore                           # 忽略配置
├── backend/
│   ├── app.js                           # Express 应用：中间件、/api、静态资源与 SPA 路由
│   ├── server.js                        # 启动流程：多库初始化、Workers、索引/监控、健康检查
│   ├── entrypoint.sh                    # 容器入口：权限修复、依赖自愈、定时任务、pm2-runtime 启动
│   ├── ecosystem.config.js              # pm2 配置：server 与 ai-worker 进程
│   ├── package.json                     # 后端依赖与脚本
│   ├── package-lock.json                # 锁定文件
│   ├── config/
│   │   ├── index.js                     # 全局配置（端口/目录/Redis/Workers/索引参数）
│   │   ├── logger.js                    # winston 日志
│   │   └── redis.js                     # ioredis 连接与 BullMQ 队列（AI/Settings）
│   ├── controllers/
│   │   ├── ai.controller.js             # 接收前端 aiConfig，入队生成描述
│   │   ├── auth.controller.js           # 登录/刷新 Token/状态检测
│   │   ├── browse.controller.js         # 相册/图片流式浏览
│   │   ├── event.controller.js          # SSE 事件流
│   │   ├── login.controller.js          # 登录背景等
│   │   ├── search.controller.js         # 搜索查询接口
│   │   ├── settings.controller.js       # 设置读写（过滤敏感项）
│   │   └── thumbnail.controller.js      # 缩略图获取：exists/processing/failed 占位
│   ├── db/
│   │   ├── migrate-to-multi-db.js       # 单库→多库迁移脚本
│   │   ├── migrations.js                # 多库初始化与核心表兜底
│   │   ├── multi-db.js                  # SQLite 连接管理与通用查询
│   │   └── README.md                    # 多库说明
│   ├── middleware/
│   │   ├── ai-rate-guard.js             # AI 配额/冷却/去重（Redis）
│   │   ├── auth.js                      # 认证：公开访问/Token 校验/JWT_SECRET 检查
│   │   ├── cache.js                     # 路由级 Redis 缓存与标签失效
│   │   ├── pathValidator.js             # 路径校验（防穿越）
│   │   ├── rateLimiter.js               # 全局速率限制
│   │   ├── requestId.js                 # 请求 ID 注入
│   │   └── validation.js                # Joi 参数校验与 asyncHandler
│   ├── routes/
│   │   ├── ai.routes.js                 # /api/ai：生成与任务状态
│   │   ├── auth.routes.js               # /api/auth：登录/刷新/状态
│   │   ├── browse.routes.js             # /api/browse：相册/媒体列表
│   │   ├── cache.routes.js              # /api/cache：缓存清理
│   │   ├── event.routes.js              # /api/events：SSE
│   │   ├── index.js                     # /api 聚合入口
│   │   ├── metrics.routes.js            # /api/metrics：缓存/队列指标
│   │   ├── search.routes.js             # /api/search：搜索
│   │   ├── settings.routes.js           # /api/settings：客户端可读设置
│   │   └── thumbnail.routes.js          # /api/thumbnail：缩略图获取
│   ├── scripts/
│   │   └── maintenance.js               # 周期性维护任务（清理/压缩等）
│   ├── services/
│   │   ├── cache.service.js             # 缓存标签管理/失效
│   │   ├── event.service.js             # 事件总线（SSE）
│   │   ├── file.service.js              # 文件与封面相关逻辑
│   │   ├── indexer.service.js           # 监控目录/合并变更/索引调度
│   │   ├── search.service.js            # 搜索实现（FTS5 等）
│   │   ├── settings.service.js          # 设置缓存（内存/Redis）与持久化
│   │   ├── thumbnail.service.js         # 缩略图高/低优队列与重试
│   │   └── worker.manager.js            # Worker 管理（缩略图/索引/视频）
│   ├── utils/
│   │   ├── media.utils.js               # 媒体判定/尺寸计算等
│   │   ├── path.utils.js                # 路径清理/安全校验
│   │   └── search.utils.js              # 搜索辅助
│   └── workers/
│       ├── ai-worker.js                 # 调用外部 AI 接口，写回结果
│       ├── history-worker.js            # 浏览历史相关任务
│       ├── indexing-worker.js           # 构建/增量更新搜索索引
│       ├── settings-worker.js           # 设置持久化任务
│       ├── thumbnail-worker.js          # Sharp/FFmpeg 生成缩略图
│       └── video-processor.js           # 视频处理
└── frontend/
    ├── index.html                        # 页面入口
    ├── manifest.json                     # PWA 清单
    ├── package.json                      # 前端依赖与构建脚本
    ├── package-lock.json                 # 锁定文件
    ├── style.css                         # 全站样式（含骨架/占位/动效）
    ├── sw.js                             # Service Worker
    ├── tailwind.config.js                # Tailwind 配置
    ├── assets/
    │   └── icon.svg                      # 应用图标
    └── js/
        ├── abort-bus.js                  # 统一中止控制
        ├── api.js                        # API 封装（认证/设置/搜索等）
        ├── auth.js                       # 登录/Token 本地管理
        ├── indexeddb-helper.js           # IndexedDB 搜索历史/浏览记录
        ├── lazyload.js                   # 懒加载与占位/状态处理
        ├── listeners.js                  # 滚动/交互事件
        ├── loading-states.js             # 骨架/空态/错误态渲染
        ├── main.js                       # 启动流程与状态初始化
        ├── masonry.js                    # 瀑布流布局与列数计算
        ├── modal.js                      # 媒体预览模态框
        ├── router.js                     # Hash 路由与流式加载
        ├── search-history.js             # 搜索历史 UI 逻辑
        ├── settings.js                   # 设置面板与本地 AI 配置
        ├── sse.js                        # SSE 连接与事件处理
        ├── state.js                      # 全局状态容器
        ├── touch.js                      # 触摸手势
        ├── ui.js                         # DOM 渲染与卡片组件
        ├── ui copy.js                    # UI 备份/临时文件
        ├── utils.js                      # 杂项工具
        └── virtual-scroll.js             # 虚拟滚动
```

## 🔧 配置说明

### 环境变量配置 (`.env`)

| 变量名                    | 默认值                                              | 说明                                                         |
|--------------------------|----------------------------------------------------|--------------------------------------------------------------|
| `REDIS_URL`              | `redis://redis:6379`                               | Redis 连接 URL。                                             |
| `PORT`                   | `13001`                                            | 服务监听端口。                                           |
| `NODE_ENV`               | `production`                                       | Node.js 运行环境模式。                                       |
| `LOG_LEVEL`              | `info`                                             | 日志输出级别。                                               |
| `RATE_LIMIT_WINDOW_MINUTES` | `15`                                            | API 速率限制的时间窗口（分钟）。                             |
| `RATE_LIMIT_MAX_REQUESTS`    | `100`                                          | 在一个时间窗口内，单个 IP 允许的最大请求数。                 |
| `JWT_SECRET`             | `your-own-very-long-and-random-secret-string-123450` | 用于签发和验证登录 Token 的密钥，请修改为复杂随机字符串。    |
| `ADMIN_SECRET`           | `（默认admin，请手动设置）`                          | 超级管理员密钥，启用/修改/禁用访问密码等敏感操作时必需。      |

> **注意：**
> - `ADMIN_SECRET` 必须在 `.env` 文件中手动设置，否则涉及超级管理员权限的敏感操作（如设置/修改/禁用访问密码）将无法进行。
> - 请务必将 `ADMIN_SECRET` 设置为高强度、难以猜测的字符串，并妥善保管。
>
> 更完整的环境变量说明与不同规模服务器的推荐配置，请参见 `ENV_GUIDE.md`。

### Docker 服务配置

| 服务 | 容器端口 | 主机端口 | 说明 |
|------|----------|----------|------|
| `app` | `13001` | `13001` | 单容器：前端静态资源 + 后端 API（同域） |
| `redis` | `6379` | `6379` | Redis 缓存服务端口 |

### 数据库架构

项目采用多数据库架构，提高并发性能：

- **主数据库** (`gallery.db`)：存储图片和视频索引信息
- **设置数据库** (`settings.db`)：存储应用配置设置
- **历史记录数据库** (`history.db`)：存储用户浏览历史
- **索引数据库** (`index.db`)：存储索引处理状态和队列

## 🛠️ 本地开发

### 后端开发
```bash
cd backend
npm install
npm start
```

### 反向代理与 SSE 长连接建议

若在 Nginx/Traefik/Caddy 等反向代理之后运行，为保证 Server-Sent Events (SSE) 与静态资源稳定：

- Nginx 示例（片段）：
  - 保持长连接与刷新首包
  - 调整超时，避免连接被过早回收
```
location /api/events {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1h;
    chunked_transfer_encoding off;
    proxy_pass http://backend:13001/api/events;
}

# 静态与 API 可考虑：
proxy_send_timeout 300s;
proxy_connect_timeout 60s;
```

- Traefik/Caddy：确保对 `/api/events` 关闭缓冲并提升 read timeout。

### 多实例一致限流（Redis Store）

自 v1.0.0 起，应用在以下路由上使用 Redis 作为 express-rate-limit 的共享存储，以保证多实例/多进程环境下的限流一致性：

- `/api` 全局限流：见 `backend/middleware/rateLimiter.js`
- `/api/auth/login`、`/api/auth/refresh`：见 `backend/routes/auth.routes.js`
- `/api/metrics/*`：见 `backend/routes/metrics.routes.js`

依赖：`REDIS_URL`（默认 `redis://redis:6379`）。如需调整窗口和配额，可通过以下环境变量：

- `RATE_LIMIT_WINDOW_MINUTES`（默认 15）
- `RATE_LIMIT_MAX_REQUESTS`（默认 100）

说明：Redis Store 通过现有的 ioredis 客户端进行 `sendCommand`，无需额外配置。

### 前端开发
```bash
cd frontend
npm install
npm run build
# 或使用开发服务器
npx http-server -p 8000
```

### 数据库管理
```bash
# 查看数据库状态
sqlite3 data/gallery.db ".tables"

# 手动执行数据迁移
node backend/db/migrate-to-multi-db.js
```

### 启动期回填任务（降低运行时 IO）

为减少浏览大目录时的 `fs.stat` 与动态尺寸探测开销，服务在启动后会异步触发两类后台回填任务（由 `indexing-worker` 执行）：

- 回填 mtime：`backfill_missing_mtime`
- 回填媒体尺寸（width/height）：`backfill_missing_dimensions`

相关环境变量（可选）：

- `MTIME_BACKFILL_BATCH`（默认 500）：单批更新条数
- `MTIME_BACKFILL_SLEEP_MS`（默认 200）：批次间休眠
- `DIM_BACKFILL_BATCH`（默认 500）：尺寸回填单批条数
- `DIM_BACKFILL_SLEEP_MS`（默认 200）：批次间休眠

回填任务在 `backend/server.js` 启动阶段触发，属于后台低优先级操作，不影响正常功能。

### 生产部署建议

- 反向代理
  - 为 `/api/events` 关闭缓冲、提升 read timeout（见上文 Nginx 片段）。
  - 建议统一 HTTPS，同源部署前后端，降低 CSP/COOP 噪音。
- Redis 高可用
  - 生产建议使用外部 Redis（主从或哨兵/集群）。
  - 仅需配置 `REDIS_URL`，express-rate-limit 与 BullMQ 共用连接。
- 资源与并发
  - `NUM_WORKERS` 控制缩略图并行度，内存紧张时适当下调。
  - 大相册首次索引耗时较长，建议在业务低峰进行全量重建。
- 监控与可观测
  - `/api/metrics/cache` 查看路由缓存命中；`/api/metrics/queue` 查看队列状态。
  - 结合容器日志与 `LOG_LEVEL=debug` 进行排查。
- 私有模式 SSE
  - 如反代支持 Cookie 注入，可以通过 Cookie 传递认证；或改用自定义头的 SSE polyfill（需自行启用）。

## 🎯 功能详解

### AI 画中密语
- 支持多种AI角色设定，从温馨对话到私密互动
- 异步队列处理，避免阻塞用户界面
- Redis缓存机制，相同图片不重复生成
- 自定义提示词支持，可参考 `AIPROMPT.md`

### 智能索引系统
- SQLite FTS5全文搜索，支持中文分词
- 多线程索引重建，提高处理速度
- 文件监控自动更新索引
- 支持相册和视频的智能搜索

### 缩略图系统
- 多线程并发生成，提高处理速度
- 失败重试机制，确保生成成功率
- 多尺寸缩略图支持
- 智能缓存，避免重复生成

### 视频处理
- 自动视频优化和转码
- 支持多种视频格式
- 失败重试机制
- 处理状态监控

### 键盘快捷键
项目支持丰富的键盘快捷键，提升操作效率：

| 快捷键 | 功能 | 说明 |
|--------|------|------|
| `S` | 聚焦搜索框 | 快速进入搜索模式 |
| `F` | 切换全屏模式 | 沉浸式浏览体验 |
| `R` | 刷新当前页面 | 重新加载内容 |
| `H` | 返回首页 | 快速回到主页 |
| `B` | 切换模糊模式 | 隐私保护功能 |
| `ESC` | 关闭模态框/返回 | 退出当前操作 |
| `←/→` | 模态框内导航 | 切换图片/视频 |
| `1-9` | 快速打开第N张图片 | 数字键快速导航 |

**使用提示：**
- 在输入框中时，快捷键会被禁用
- 移动端建议使用触摸手势操作
- 全屏模式下快捷键依然有效

### 搜索历史功能
- 智能搜索历史记录，最多保存10条
- 点击搜索框显示历史记录
- 支持删除单个历史项
- 一键清空所有历史
- 点击历史项快速重复搜索

## 🐛 常见问题

### 部署问题
- **项目无法启动**：核查 `.env`是否配置JWT_SECRET
- **图片不显示**：检查照片目录挂载与权限
- **AI 无响应**：核查 `.env` 配置与 OneAPI 服务
- **Redis 缓存异常**：确认 Redis 服务与端口
- **端口冲突**：检查 12080/13001/6379 是否被占用

### 性能问题
- **429错误**：调整 `.env` 中的速率限制参数
- **索引重建慢**：检查照片数量，大相册需要更多时间
- **缩略图生成慢**：调整 `NUM_WORKERS` 参数
- **内存占用高**：减少并发工作线程数量

### 功能问题
- **搜索'500'或无结果**：等待索引重建完成
- **AI功能异常**：检查API密钥和模型配置
- **PWA安装失败**：确保HTTPS或localhost环境
- **移动端手势不工作**：检查触摸事件支持

