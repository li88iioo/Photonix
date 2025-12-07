# Photonix | 光影画廊

[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/) [![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](https://www.docker.com/)

一个极简、AI 驱动的智能相册，专为现代 Web 设计。它集成了 PWA、流式加载、多数据库架构和高性能缓存，旨在提供极致的浏览体验和智能的交互方式。


## ✨ 主要特性

### 🎭 AI 智能交互
- **AI 画中密语**：AI 扮演照片人物，沉浸式对话体验
- **多模型支持**：兼容 OpenAI、Claude、Gemini 等主流视觉模型
- **自定义提示词**：支持多种AI角色设定，从温馨对话到私密互动
- **轻量级微服务**：内置 AI 微服务架构，采用内存队列与智能并发控制，无需额外消息队列组件
- **智能缓存**：AI生成内容 Redis 持久化缓存，降低 API 成本
- **任务去重**：相同图片自动复用已有结果，优化性能
- **提示词模板**：内置多种对话风格模板，可参考 `AIPROMPT.md`
- **会话存储**：对话历史仅保存在浏览器 IndexedDB，可导入导出，避免后端保存隐私数据

### 📥 资源订阅中心
- **RSS/Atom 订阅**：内置 Feed 解析器，支持订阅并自动同步外部图库源
- **自动抓取**：后台定时任务自动爬取新发布的媒体资源，支持断点续传
- **智能调度**：基于任务编排器 (TaskScheduler) 的下载管理，支持并发控制与错误重试
- **历史回溯**：完整的下载历史记录与状态追踪，防止重复下载

### 🖼️ 图片管理
- **流式图片加载**：大相册极速响应，懒加载优化
- **智能缩略图**：自动生成多尺寸缩略图，支持失败重试机制
- **视频处理**：自动视频优化，支持多种格式转码
- **双图片布局**：响应式瀑布流/网格模式，自适应屏幕尺寸

### 🔒 安全防护
- **一键全局模糊**：键盘单击 ***B*** && 三指触摸屏幕
- **密码保护**：可选密码访问，支持公开/私有模式切换
- **路径校验**：严格的文件路径安全检查
- **速率限制**：API访问频率控制，防止滥用

### 🚀 性能优化
- **多数据库架构**：主数据库、设置数据库、索引数据库分离
- **Redis 高性能缓存**：AI内容与搜索结果持久缓存
- **Worker 线程池**：缩略图生成、索引重建、视频转码多线程并发
- **智能索引**：SQLite FTS5全文搜索，支持模糊匹配

### 📱 用户体验
- **PWA 支持**：可安装、离线访问，移动端手势切换
- **响应式设计**：完美适配桌面端和移动端
- **触摸手势**：移动端滑动切换图片/双指缩放/三指模糊
- **键盘导航**：桌面端键盘快捷键操作
- **搜索历史**：智能搜索历史记录，快速重复搜索

### 🛠️ 运维友好
- **Docker 部署**：一键部署，环境隔离
- **健康检查**：容器健康状态监控
- **日志系统**：结构化日志，便于问题排查
- **数据迁移**：自动数据库迁移，平滑升级
- **系统维护中心**：前端设置页集成索引/缩略图/HLS 状态表、自动维护计划与手动同步，并整合下载服务入口
- **安全操作台**：相册删除、下载服务、AI 配额等敏感操作需管理员密钥，操作可审计

## 🚀 快速开始

本项目提供两种部署方式：
- **🐳 方式一：使用预构建镜像**（推荐）- 无需构建，直接拉取运行
- **🔧 方式二：本地构建** - 适合需要自定义修改的用户

### 1. 环境准备
- [Docker](https://www.docker.com/get-started) 和 [Docker Compose](https://docs.docker.com/compose/install/)
- 至少 2GB 可用内存

---

### 🐳 方式一：使用预构建镜像（推荐）

无需克隆代码，直接使用 GitHub Container Registry 预构建镜像部署。

#### 1. 创建部署目录
```bash
mkdir -p ~/photonix && cd ~/photonix
```

#### 2. 下载 docker-compose.yml
```bash
# 下载配置文件
curl -O https://raw.githubusercontent.com/li88iioo/Photonix/main/docker-compose.ghcr.yml
mv docker-compose.ghcr.yml docker-compose.yml

# 修改照片目录路径（将 /your/photos/path 替换为实际路径）
sed -i 's|/your/photos/path|/opt/photos|g' docker-compose.yml
```

#### 3. 创建环境配置
```bash
# 下载配置模板
curl -o .env https://raw.githubusercontent.com/li88iioo/Photonix/main/env.example/env.example

# 生成随机密钥（推荐）
sed -i "s/CHANGE_ME_TO_A_SECURE_32_PLUS_CHAR_STRING/$(openssl rand -base64 48 | tr -d '\n')/" .env
sed -i "s/nameadmin/$(openssl rand -base64 36 | tr -d '\n')/" .env
```

#### 4. 启动服务
```bash
docker compose up -d
```

#### 5. 更新镜像
```bash
docker compose pull
docker compose up -d
```

---

### 🔧 方式二：本地构建

适合需要自定义代码或使用国内镜像源加速构建的用户。

#### 下载项目
```bash
git clone https://github.com/li88iioo/Photonix.git
cd Photonix
```

### 3. 配置环境变量

项目提供了灵活的环境变量配置方案：

#### 快速开始
- **开发环境**：复制 `env.example/env.development` 为 `.env`，默认配置即可启动
- **生产环境**：复制 `env.example/env.production` 为 `.env`，根据需要调整
- 或使用最小模板：复制 `env.example/env.example` 为 `.env`（仅核心必配项，其余使用代码默认值）

#### 快速生成 32+ 位强随机密钥并写入 .env

- Linux/macOS（bash）：

```bash
# 生成并追加到 .env（若不存在会创建），可用于 JWT_SECRET / ADMIN_SECRET
echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')" >> .env
echo "ADMIN_SECRET=$(openssl rand -base64 36 | tr -d '\n')" >> .env

# 如需替换已存在的同名变量（谨慎）：
[ -f .env ] && sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')/" .env || true
[ -f .env ] && sed -i "s/^ADMIN_SECRET=.*/ADMIN_SECRET=$(openssl rand -base64 36 | tr -d '\n')/" .env || true
```

- Windows（PowerShell）：

```powershell
# 生成并追加到 .env（若不存在会创建）
"JWT_SECRET=$([Convert]::ToBase64String((1..48 | ForEach-Object {Get-Random -Maximum 256})))" | Out-File -FilePath .env -Append -Encoding utf8
"ADMIN_SECRET=$([Convert]::ToBase64String((1..36 | ForEach-Object {Get-Random -Maximum 256})))" | Out-File -FilePath .env -Append -Encoding utf8

# 如需替换已存在同名变量（谨慎）：
if (Test-Path .env) {
  (Get-Content .env) -replace '^JWT_SECRET=.*', "JWT_SECRET=$([Convert]::ToBase64String((1..48 | ForEach-Object {Get-Random -Maximum 256})))" |
  Set-Content .env -Encoding utf8
  (Get-Content .env) -replace '^ADMIN_SECRET=.*', "ADMIN_SECRET=$([Convert]::ToBase64String((1..36 | ForEach-Object {Get-Random -Maximum 256})))" |
  Set-Content .env -Encoding utf8
}
```

#### 详细配置
- 📖 **完整配置指南**：查看 [ENV_GUIDE.md](./env.example/ENV_GUIDE.md)（精注释版）
- 🔧 **核心配置**：`PORT`、`PHOTOS_DIR`、`DATA_DIR`、`JWT_SECRET`
- ⚡ **性能优化**：硬件自适应配置，支持 `DETECTED_CPU_COUNT` 和 `DETECTED_MEMORY_GB`
- 🔒 **安全设置**：生产环境务必修改 `JWT_SECRET` 和 `ADMIN_SECRET`
- 🤖 **AI 集成**：支持自定义 AI 服务配置和提示词模板
- 📊 **AI 调用配额**：后台可设定 `AI_DAILY_LIMIT`（1~10000），并在前端设置面板单独保存；需要管理员密钥确认


### 4. 准备照片目录
```bash
# 创建照片目录（推荐挂载到宿主机）
mkdir -p /opt/photos
# 将你的照片放入此目录
# 支持格式：jpg, jpeg, png, gif, webp, mp4, mov, avi, mkv
```

### 5. 启动服务
```bash
# 构建并启动（单容器 + Redis）
docker compose up -d --build

# 查看服务状态
docker compose ps

# 查看日志
docker compose logs -f

# 查看实时日志
docker compose logs -f app
```

### 6. 访问应用
- **应用与 API（同域）**：[http://localhost:12080](http://localhost:12080)
  - API 前缀：`/api`（例如：`http://localhost:12080/api/browse`）
- **Redis**：`localhost:6379`（可选）
- **健康检查**：`http://localhost:12080/health`


## 📁 项目架构

```
Photonix/
├── Dockerfile                          # 单容器构建（前端打包→拷贝到 backend/public，pm2 启动 server）
├── docker-compose.yml                   # 编排（app + redis），端口与卷映射
├── README.md                            # 项目说明
├── AIPROMPT.md                          # AI 提示词示例
├── .gitignore                           # 忽略配置
├── env.example/                         # 环境变量配置目录
│   ├── env.development                  # 开发环境配置
│   ├── env.example                      # 配置模板
│   ├── env.production                   # 生产环境配置
│   └── ENV_GUIDE.md                     # 环境变量详细指南
├── backend/
│   ├── app.js                           # Express 应用：中间件、/api、静态资源与 SPA 路由
│   ├── server.js                        # 启动流程：多库初始化、Workers、索引/监控、健康检查
│   ├── entrypoint.sh                    # 容器入口：权限修复、依赖自愈、定时任务、pm2-runtime 启动
│   ├── ecosystem.config.js              # pm2 配置：管理 server 进程
│   ├── package.json                     # 后端依赖与脚本
│   ├── config/
│   │   ├── index.js                     # 全局配置（端口/目录/Redis/Workers/索引参数）
│   │   ├── hardware.js                  # 硬件检测与资源配置
│   │   ├── logger.js                    # winston 日志配置
│   │   ├── redis.js                     # ioredis 连接
│   │   └── vision-models.js             # 视觉模型元数据
│   ├── controllers/
│   │   ├── ai.controller.js             # AI 控制器：对接 Microservice
│   │   ├── download.controller.js       # 下载/订阅控制器
│   │   ├── browse.controller.js         # 相册/图片流式浏览
│   │   └── ...                          # 其他业务控制器
│   ├── db/
│   │   ├── migrate-to-multi-db.js       # 单库→多库迁移脚本
│   │   ├── multi-db.js                  # SQLite 连接管理与通用查询
│   │   └── migrations.js                # 多库初始化
│   ├── services/
│   │   ├── ai-microservice.js           # [核心] AI 内存微服务：队列/并发/请求封装
│   │   ├── download/                    # [核心] 下载与订阅服务模块
│   │   │   ├── FeedProcessor.js         # RSS/Atom 解析
│   │   │   ├── TaskScheduler.js         # 任务调度器
│   │   │   └── ImageDownloader.js       # 图片下载实现
│   │   ├── worker.manager.js            # Worker 管理（缩略图/索引/视频）
│   │   ├── indexer.service.js           # 索引服务
│   │   └── ...                          # 其他服务
│   ├── utils/
│   │   ├── hls.utils.js                 # HLS 视频处理工具
│   │   ├── media.utils.js               # 媒体判定/尺寸计算等
│   │   └── ...                          # 通用工具
│   └── workers/
│       ├── indexing-worker.js           # 构建/增量更新搜索索引
│       ├── settings-worker.js           # 设置持久化任务
│       ├── thumbnail-worker.js          # Sharp/FFmpeg 生成缩略图
│       └── video-processor.js           # 视频处理

└── frontend/
    ├── index.html                        # 页面入口
    ├── manifest.json                     # PWA 清单
    ├── sw-src.js                         # Service Worker 源文件
    ├── js/
    │   ├── api/                          # API 客户端层
    │   ├── app/                          # 应用核心
    │   │   └── router.js                 # 路由管理
    │   ├── core/                         # 核心基础模块
    │   ├── features/                     # 功能模块
    │   │   ├── download/                 # 下载中心前端逻辑
    │   │   ├── gallery/                  # 画廊核心逻辑
    │   │   ├── ai/                       # AI 对话逻辑
    │   │   └── history/                  # 历史记录服务
    │   ├── modal/                        # 模态框组件
    │   ├── settings/                     # 设置面板逻辑
    │   ├── shared/                       # 共享工具
    │   └── main.js                       # 启动流程
    └── assets/                           # 静态资源
```
## 🔧 配置说明

### 🧭 请求生命周期（AI 画中密语）
1. **前端触发**：`frontend/js/features/ai/ai-conversation-store.js` 维护对话历史，通过 `frontend/js/api/ai.js` 发起 `POST /api/ai/generate`。
2. **后端入口**：`backend/app.js` 中 `/api` 路由将请求交给 `backend/controllers/ai.controller.js`，执行访问密码与管理员密钥校验。
3. **配额与排队**：控制器查询 `settings.db` 中的 `AI_DAILY_LIMIT`，并把任务交给 `services/ai-microservice.js` 内存队列，结合 Redis (`config/redis.js`) 做任务去重、并发调度与结果缓存。
4. **模型调用**：按照 `config/vision-models.js` 定义调度 OpenAI/Claude/Gemini 等模型，得到结果后写入 Redis，并更新缓存映射。
5. **状态推送**：前端通过 `/api/ai/status/:jobId` 轮询或 `/api/events` SSE 获取处理进度，workers 会把索引/缩略图状态写入 `index.db`，更新设置面板的维护表格。
6. **前端呈现**：`ai-conversation-store.js` 将结果存入 IndexedDB，UI 即时刷新，用户可在设置面板导出/导入对话历史。

### 环境变量配置 (`.env`)

| 变量名                    | 默认值                                              | 说明                                                         |
|--------------------------|----------------------------------------------------|--------------------------------------------------------------|
| `REDIS_URL`              | `redis://localhost:6379`                           | Redis 连接 URL（Compose 环境建议使用 `redis://redis:6379`）。 |
| `PORT`                   | `13001`                                            | 服务监听端口。                                           |
| `NODE_ENV`               | `production`                                       | Node.js 运行环境模式。                                       |
| `LOG_LEVEL`              | `info`                                             | 日志输出级别。                                               |
| `RATE_LIMIT_WINDOW_MINUTES` | `1`                                             | API 速率限制的时间窗口（分钟，代码默认 1 分钟）。            |
| `RATE_LIMIT_MAX_REQUESTS`    | `3000`                                          | 在一个时间窗口内的最大请求数（代码默认 800，可按需下调）。   |
| `JWT_SECRET`             | `your-own-very-long-and-random-secret-string-123450` | 用于签发和验证登录 Token 的密钥，请修改为复杂随机字符串。    |
| `ADMIN_SECRET`           | `（默认nameadmin，请手动设置）`                          | 超级管理员密钥，启用/修改/禁用访问密码等敏感操作时必需。      |
| `AI_DAILY_LIMIT`         | `1000`                                             | AI 每日调用上限，设置面板支持 1~10000，可避免超额调用。        |
| `DETECTED_CPU_COUNT`     | `auto`                                             | 覆盖硬件自检结果，控制 worker 并发；低配主机可手动下调。        |
| `DETECTED_MEMORY_GB`     | `auto`                                             | 覆盖自动内存检测，便于在容器或低配环境下定制缓存策略。        |

> **注意：**
> - `ADMIN_SECRET` 必须在 `.env` 文件中手动设置，否则涉及超级管理员权限的敏感操作（如设置/修改/禁用访问密码）将无法进行。
> - 请务必将 `ADMIN_SECRET` 设置为高强度、难以猜测的字符串，并妥善保管。
>
> 更完整的环境变量说明与不同规模服务器的推荐配置，请参见 [ENV_GUIDE.md](./env.example/ENV_GUIDE.md)。
>
> Docker Compose 部署建议：在 `.env` 中设置 `REDIS_URL=redis://redis:6379`（使用服务名 `redis` 作为主机）。

### Docker 服务配置

| 服务 | 容器端口 | 主机端口 | 说明 |
|------|----------|----------|------|
| `app` | `13001` | `12080` | 单容器：前端静态资源 + 后端 API（同域） |
| `redis` | `6379` | `6379` | Redis 缓存服务端口 |

说明：
- 可通过环境变量 `APP_PORT` 覆盖宿主机暴露端口（Compose 默认 `APP_PORT=12080`，映射为 `APP_PORT:13001`）。

### 数据库架构

项目采用多数据库架构，提高并发性能：

- **主数据库** (`gallery.db`)：存储图片和视频元数据、路径信息
- **设置数据库** (`settings.db`)：存储应用配置、AI设置、用户偏好
- **索引数据库** (`index.db`)：存储搜索索引状态、队列任务、处理进度

> 注：相册浏览/搜索历史目前完全由前端在浏览器侧记录，后端不再维护 `history.db`。

#### 数据库特性
- **并发优化**：多库设计减少锁竞争，提升并发性能
- **数据隔离**：不同类型数据分离，便于备份和维护
- **自动迁移**：启动时自动检测和执行数据库结构升级
- **连接池**：每个数据库独立连接，避免相互影响

更多细节请参考多库说明文档：[backend/db/README.md](./backend/db/README.md)。

## 📋 API 接口

Photonix 提供完整的 RESTful API，支持前后端分离开发。

### 核心接口

#### 认证接口 (`/api/auth`)
- `POST /api/auth/login` - 用户登录
- `POST /api/auth/refresh` - 刷新访问令牌
- `GET /api/auth/status` - 获取登录状态

#### 浏览接口 (`/api/browse`)
- `GET /api/browse` - 获取相册/图片列表
- `GET /api/browse/:path` - 获取指定路径的内容

#### 搜索接口 (`/api/search`)
- `GET /api/search` - 执行全文搜索
- `GET /api/search/history` - 获取搜索历史

#### AI 接口 (`/api/ai`)
- `POST /api/ai/generate` - 生成 AI 描述
- `GET /api/ai/status/:jobId` - 查询任务状态

#### 下载接口 (`/api/download`)
- `POST /api/download/feeds` - 添加或更新订阅源
- `GET /api/download/feeds` - 列出订阅源
- `POST /api/download/tasks` - 创建下载任务或触发立即抓取
- `GET /api/download/history` - 查看下载历史记录
- `GET /api/download/status` - 查看当前任务队列运行状态

#### 设置接口 (`/api/settings`)
- `GET /api/settings` - 获取应用设置
- `PUT /api/settings` - 更新应用设置
- `GET /api/settings/status` - 查询设置更新状态、AI 配额等结果
- `POST /api/settings/status` - 内部更新状态（由 worker/调度调用）

#### 缩略图接口 (`/api/thumbnail`)
- `GET /api/thumbnail/:path` - 获取缩略图

### 实时功能
- **SSE 事件流** (`/api/events`)：实时推送处理状态和通知

### 开发文档
完整的 API 文档和开发指南请参考项目源码中的路由文件：
- 后端路由：`backend/routes/`
- 前端 API 封装：`frontend/js/api/`

## 🛠️ 本地开发

### 后端开发
```bash
cd backend
npm install
npm start
```

### Nginx 反向代理配置
如果在生产环境中使用 Nginx 作为反向代理，请使用以下配置以确保 **Server-Sent Events (SSE)** 正常工作。

#### 为什么 SSE 需要特殊配置？

SSE (Server-Sent Events) 是一种长连接、流式传输技术，与普通 HTTP 请求有本质区别：

| Nginx 默认行为 | 对 SSE 的影响 | 问题 |
|---------------|--------------|------|
| `proxy_buffering on` | 缓冲响应数据 | 数据被缓冲，无法实时推送 |
| `proxy_http_version 1.0` | 使用 HTTP/1.0 | 不支持长连接，每次响应后关闭 |
| `Connection: close` | 关闭连接头 | SSE 需要保持连接打开 |
| 短超时（60秒） | 60秒后断开 | SSE 可能需要保持数小时 |

**不配置 SSE 专用规则会导致**：
- 实时更新变成"批量更新"或超时
- 连接频繁断开，前端报 `net::ERR_FAILED`
- 缩略图生成进度无法实时显示

#### HTTP 代理配置（仅用于开发/测试）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 0; # 允许上传大文件

    # ⚠️ 重要：SSE 专用配置必须放在通用 location 之前
    location /api/events {
        proxy_pass http://127.0.0.1:12080/api/events;
        
        # SSE 关键配置
        proxy_http_version 1.1;
        proxy_set_header Connection '';  # 清空连接头，保持长连接
        
        # 禁用所有缓冲，确保实时传输
        proxy_buffering off;
        proxy_cache off;
        
        # 长超时配置（24小时）
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        
        # 支持分块传输
        chunked_transfer_encoding on;
        
        # TCP 优化
        tcp_nodelay on;
        tcp_nopush on;
        
        # 标准代理头
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 通用代理配置
    location / {
        proxy_pass http://127.0.0.1:12080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

#### HTTPS 代理配置（生产环境推荐）

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL 证书配置
    ssl_certificate /path/to/your/fullchain.pem;
    ssl_certificate_key /path/to/your/private.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    client_max_body_size 0;

    # ⚠️ 重要：SSE 专用配置必须放在通用 location 之前
    location /api/events {
        proxy_pass http://127.0.0.1:12080/api/events;
        
        # SSE 关键配置
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        
        # 禁用缓冲
        proxy_buffering off;
        proxy_cache off;
        
        # 长超时（24小时）
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        
        # 流式传输优化
        chunked_transfer_encoding on;
        tcp_nodelay on;
        tcp_nopush on;
        
        # 标准代理头
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 通用代理配置
    location / {
        proxy_pass http://127.0.0.1:12080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# HTTP 自动跳转到 HTTPS
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}
```

#### 验证 SSE 配置

**方法 1：浏览器控制台测试**
```javascript
const es = new EventSource('https://your-domain.com/api/events');
es.onopen = () => console.log('✅ SSE 连接成功！');
es.onerror = (e) => console.error('❌ SSE 连接失败：', e);
es.addEventListener('connected', (e) => console.log('📨 收到connected事件：', e.data));
```

**方法 2：命令行测试**
```bash
# 测试 HTTP
curl -N -H "Accept: text/event-stream" http://your-domain.com/api/events

# 测试 HTTPS
curl -N -H "Accept: text/event-stream" https://your-domain.com/api/events
```

预期输出：
```
event: connected
data: {"message":"SSE connection established.","clientId":"..."}

: keep-alive

: keep-alive
```

**方法 3：查看 Network 标签**
1. 打开浏览器开发者工具（F12）
2. 切换到 **Network** 标签
3. 筛选 **EventStream** 类型
4. 查找 `/api/events` 请求
5. 状态应该是 **200** 且持续保持连接

#### 常见问题排查

| 现象 | 可能原因 | 解决方案 |
|------|---------|---------|
| 连接立即断开 | 缺少 `proxy_http_version 1.1` 或 `Connection ''` | 添加 SSE 专用配置 |
| 数据延迟数秒才到达 | `proxy_buffering on` 未禁用 | 设置 `proxy_buffering off` |
| 60秒后自动断开 | 超时配置过短 | 增加 `proxy_read_timeout` 到 24小时 |
| `net::ERR_FAILED` | Nginx 配置未生效 | 执行 `nginx -t && nginx -s reload` |
| HTTPS 下无法连接 | 后端使用 HTTP，需要协议转换 | 使用 `proxy_pass http://...` 即可 |



### 生产部署建议

- 反向代理
  - 为 `/api/events` 关闭缓冲、提升 read timeout（见上文 Nginx 片段）。
  - 建议统一 HTTPS，同源部署前后端，降低 CSP/COOP 噪音。
- Redis 高可用
  - 生产建议使用外部 Redis（主从或哨兵/集群）。
  - 仅需配置 `REDIS_URL`；用于速率限制、AI 结果缓存等功能。
- 资源与并发
  - `NUM_WORKERS` 控制缩略图并行度，内存紧张时适当下调。
  - 大相册首次索引耗时较长，建议在业务低峰进行全量重建。
- 监控与可观测
  - `/api/metrics/cache` 查看路由缓存命中；`/api/metrics/queue` 查看队列状态。
  - 结合容器日志与 `LOG_LEVEL=debug` 进行排查。
- 私有模式 SSE
  - 如反代支持 Cookie 注入，可以通过 Cookie 传递认证；或改用自定义头的 SSE polyfill（需自行启用）。

## 📊 监控与维护

### 健康检查
- **端点**：`/health`
- **检查项**：SQLite 可用性（查询 items 与 items_fts 的 COUNT），异常视为不健康
- **响应**：成功返回 200 和计数；异常返回 503（包含错误信息）

### 性能指标
- **缓存命中率**：`/api/metrics/cache`
- **队列状态**：`/api/metrics/queue`
- **系统资源**：通过容器日志监控 CPU、内存使用

### 日志管理
- **日志级别**：通过 `LOG_LEVEL` 环境变量控制
- **日志格式**：可选人类可读或 JSON（设置 `LOG_JSON=true` 输出 JSON，便于集中采集与检索）
- **追踪标识**：日志自动带 `[Trace:<前8位>]` 段，HTTP 响应头包含 `X-Trace-Id`、`X-Span-Id`
- **前缀规范化**：旧日志前缀会被统一到中文前缀（如 `[Orchestrator]` → `[调度器]`）
- **日志轮转**：建议使用 Docker 日志驱动或外部日志系统管理

### 数据备份
- **数据库备份**：定期备份 SQLite 数据库文件
- **照片备份**：定期备份照片目录
- **配置备份**：备份 `.env` 和 Docker 配置文件

## 🎯 功能详解

### AI 画中密语
Photonix 的核心特色功能，通过 AI 让照片中的人物"开口说话"。

#### 功能特性
- **多模型兼容**：支持 OpenAI GPT-4V、Claude-3、Gemini 等视觉模型
- **自定义角色**：可设置不同的人设和对话风格
- **内存微服务**：轻量级并发处理，无需外部队列即可完成生成
- **智能缓存**：Redis 缓存避免重复生成，降低 API 成本
- **任务去重**：相同图片自动复用已有结果
- **对话历史**：会话仅存浏览器 IndexedDB，可导入导出

#### 使用方法
1. **配置 AI 服务**：
   - 在设置面板中启用 AI 功能
   - 配置 API 地址、密钥和模型名称
   - 设置自定义提示词

2. **生成对话**：
   - 在图片预览模式下点击"画中密语"按钮
   - AI 将分析图片内容并生成角色对话
   - 支持多种对话风格，从温馨到私密

3. **提示词模板**：
   - 内置多种对话风格模板
   - 支持完全自定义提示词
   - 参考 `AIPROMPT.md` 获取更多示例

4. **历史管理**：设置面板可导出全部 AI 对话历史 JSON，或导入备份恢复。

### 运维面板与手动同步

Photonix 在前端设置的“运维”页整合了多项维护能力：

- **状态表格**：索引、缩略图、HLS 三张状态表实时显示进度、文件统计与最近同步时间。
- **手动同步**：可随时触发相册/媒体全量同步，同时联动缩略图状态增量更新，执行过程会生成摘要报告。
- **自动维护计划**：支持输入分钟间隔或 Cron 表达式，后台自动运行手动同步，并在同步结束后依次完成缩略图补全/清理与 HLS 补全/清理；输入 `off` 即可关闭。
- **相册删除开关**：启用后，前端支持右键/长按删除相册，所有操作需要管理员密钥并触发索引+缩略图清理。
- **下载服务控制台**：在管理卡片中打开 `#/download` 控制台，集中管理 RSS 订阅、任务调度、导入导出与日志。

> 所有手动/自动维护操作都会校验访问密码与管理员密钥，确保敏感操作留痕可控。

#### 技术实现
- **队列系统**：内存微服务架构，支持 Redis 缓存加速
- **缓存策略**：7天缓存期，智能过期管理
- **错误处理**：自动重试机制，确保生成成功

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

### HLS 视频流
为了提供流畅的视频播放体验，所有视频都会被处理成 HLS 格式。
- **工作流程**: 文件系统扫描到新视频 -> 任务被添加到 `video-queue` -> `video-processor.js` 使用 `ffmpeg` 将视频切片成 `.ts` 文件和 `.m3u8` 播放列表。
- **前端播放**: 前端使用 `hls.js` 库来播放 HLS 流，支持在普通 `<video>` 标签上实现无缝播放和码率切换。

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

### 🖐️ 触摸手势
项目为移动端优化了丰富的触摸手势：

| 手势 | 功能 | 说明 |
|---|---|---|
| **单指左右滑动** | 切换图片 | 在预览模式下，快速切换上一张或下一张图片。 |
| **双指捏合** | 缩放图片 | 在预览模式下，自由放大或缩小图片，查看细节。 |
| **三指轻触** | 切换模糊 | 在任意界面，快速切换全局模糊模式以保护隐私。 |

---

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

## 🔄 更新与升级

### 版本升级
```bash
# 1. 备份数据
cp -r data/ data_backup_$(date +%Y%m%d_%H%M%S)/

# 2. 拉取最新代码
git pull origin main

# 3. 重新构建并启动
docker compose down
docker compose up -d --build

# 4. 检查服务状态
docker compose ps
docker compose logs -f
```

### 数据迁移
- **自动迁移**：应用启动时自动执行数据库迁移
- **手动迁移**：可手动执行 `node backend/db/migrate-to-multi-db.js`
- **回滚支持**：迁移失败时自动回滚，保证数据安全

## 🚀 性能优化建议

### 系统级优化
- **内存配置**：建议 4GB+ 内存，大相册需要更多
- **存储优化**：使用 SSD 存储，提升 I/O 性能
- **网络优化**：千兆网络环境，避免网络瓶颈
- **CPU 配置**：建议 2核+ CPU，支持硬件自适应调整

### 应用级优化
- **工作线程**：系统自动检测 CPU 核心数，动态调整 `NUM_WORKERS`
- **缓存策略**：合理配置 Redis 内存，支持标签化缓存清理
- **索引优化**：大相册首次索引耗时较长，建议在业务低峰进行
- **任务调度**：AI 采用内存微服务排队策略，下载任务由 TaskScheduler 提供限流与重试

### Docker 优化
- **资源限制**：根据硬件配置设置容器资源限制
- **卷挂载**：使用宿主机目录提升 I/O 性能
- **网络配置**：使用 host 网络模式减少网络开销（可选）

### 监控指标
- **缓存命中率**：`/api/metrics/cache` 查看缓存效果
- **队列状态**：`/api/metrics/queue` 监控任务处理
- **系统资源**：通过容器日志监控 CPU、内存使用

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
- **搜索无结果**：等待索引重建完成，或检查搜索关键词
- **AI功能异常**：检查API密钥、模型配置和网络连接
- **PWA安装失败**：确保HTTPS环境或localhost访问
- **移动端手势不工作**：检查浏览器触摸事件支持
- **视频播放异常**：检查 FFmpeg 依赖、视频格式和 HLS 配置
- **缩略图不显示**：检查 Sharp 依赖和磁盘权限
- **缓存不生效**：检查 Redis 连接和内存配置
- **相册删除提示权限不足**：确认挂载的照片目录对容器运行用户具备写权限。
  - **普通 Linux 主机**：建议在宿主机执行 `sudo chown -R <容器UID:GID> /opt/photos`（Node 官方镜像通常为 `1000:1000`），或在 `docker-compose.yml` 的 `app` 服务中添加 `user: "1000:1000"`，让容器进程以具备写权限的用户运行。
  - **NAS/NFS（如 Synology DSM）**：在 DSM 中创建专用的“Photonix”用户/用户组，并赋予共享目录读写权限；随后在容器配置中将 `user` 指向该用户的 UID/GID，或使用 DSM 套件的“用户映射”功能保证容器用户与共享权限一致。为避免 DSM GUI 显示数字 UID，可在 DSM 上同步创建同名账号。
  - 修改属主不会影响 root 删除/管理能力；若仍提示 403，请确认 NFS 挂载选项允许写入（不要启用 `ro`、`root_squash` 等限制），并重新启动容器。
- **数据库排查**：遇到索引/缩略图/HLS 状态异常，可结合设置面板的“手动同步”与 [backend/db/README.md](backend/db/README.md) 的多库维护指南定位问题。

### 网络问题
- **SSE 连接断开**：检查反向代理配置，确保长连接支持
- **上传失败**：检查 `client_max_body_size` 配置
- **缓存不生效**：检查 Nginx 缓存配置和路径
