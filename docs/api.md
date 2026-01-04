# RESTful API 接口文档

Photonix 提供完整的 RESTful API，支持前后端分离开发。所有 API 请求路径均以 `/api` 开头。

## 全局规范
- **Content-Type**: `application/json`
- **认证方式**: Bearer Token (JWT)，由于安全性考虑，部分敏感接口需要额外的 `adminSecret`。
- **速率限制**: 默认实施全局与接口级限流，超出后返回 `429 Too Many Requests`。

---

## 🔐 认证接口 (`/api/auth`)

### 1. 登录
- **路径**: `POST /api/auth/login`
- **参数**: `{ "password": "..." }`
- **描述**: 验证用户密码。支持 Redis 防爆破机制，只有密码错误会进入限流。

### 2. 刷新 Token
- **路径**: `POST /api/auth/refresh`
- **描述**: 简易滑动续期，刷新 JWT 访问令牌。

### 3. 获取认证状态
- **路径**: `GET /api/auth/status`
- **描述**: 检查当前客户端的认证状态及有效性。

---

## 📂 浏览与文件接口 (`/api/browse`)

### 1. 目录浏览
- **路径**: `GET /api/browse/*` (通配符)
- **参数**:
  - `limit`: 每页数量 (默认 200)
  - `page`: 分页页码
  - `sort`: 排序策略 (`smart`, `name_asc`, `name_desc`, `mtime_asc`, `mtime_desc`)
- **描述**: 递归浏览物理路径内容，支持通配符路径捕获。

---

## 🖼️ 缩略图接口 (`/api/thumbnail`)

### 1. 获取缩略图
- **路径**: `GET /api/thumbnail/`
- **参数**: `path` (文件相对路径)
- **描述**: 实时获取或触发生成 WebP 格式缩略图。支持 300s 服务器缓存。

### 2. 批量生成
- **路径**: `POST /api/thumbnail/batch`
- **参数**: `{ "limit": 5000, "loop": true, "mode": "loop" }`
- **描述**: 设置面板触发的后台批量补全任务。

### 3. 查看统计
- **路径**: `GET /api/thumbnail/stats`
- **描述**: 返回缩略图存储总量、成功/失败计数等统计信息。

---

## 🤖 AI 智能接口 (`/api/ai`)

### 1. 生成描述 (画中密语)
- **路径**: `POST /api/ai/generate`
- **权限**: 需要访问密码 + 管理员密钥
- **参数**:
  - `image_path`: 图像路径
  - `aiConfig`: 包含 `url`, `key`, `model`, `prompt`
- **描述**: 提交生成请求到 AI 内存微服务队列。

### 2. 模型列表探测
- **路径**: `POST /api/ai/models`
- **描述**: 根据提供的 API Key 和 Base URL，通过 Vision Probe 自动发现具备视觉能力的模型。

### 3. 任务状态查询
- **路径**: `GET /api/ai/job/:jobId`
- **描述**: 轮询特定任务的处理进度。

---

## 🔍 搜索接口 (`/api/search`)

### 1. 全文搜索
- **路径**: `GET /api/search/`
- **参数**: `q` (关键词)
- **描述**: 基于 SQLite FTS5 的高性能检索，支持拼音与中文分词。

---

## 📥 资源订阅中心 (`/api/download`)

### 1. 订阅源管理
- **路径**: `GET /api/download/feeds`, `POST /api/download/feeds`
- **描述**: 管理 RSS/Atom 订阅源。

### 2. 任务调度
- **路径**: `GET /api/download/tasks`, `POST /api/download/tasks`
- **操作**: `POST /api/download/tasks/:taskId/:action` (retry, pause, resume)
- **描述**: 控制图片批量拉取任务的生命周期。

### 3. 配置与 OPML
- **路径**: `GET/PUT /api/download/config` (全局设置)
- **路径**: `GET/POST /api/download/opml` (导出/导入订阅列表)

---

## ⚙️ 系统设置与监控 (`/api/settings` & `/api/metrics`)

### 1. 配置管理
- **接口**: `GET /api/settings` (获取), `POST /api/settings` (更新)
- **安全**: 更新敏感项需校验 `adminSecret`。

### 2. 状态表与同步
- **接口**: `GET /api/settings/status-tables` (查看进度)
- **接口**: `POST /api/settings/sync/:type` (触发索引/缩略图同步)

### 3. 实时监控 (Metrics)
- **接口**: `/api/metrics/cache` (Redis 命中率)
- **接口**: `/api/metrics/queue` (Worker 任务积压情况)

---

## 📡 实时事件流 (`/api/events`)
- **协议**: Server-Sent Events (SSE)
- **描述**: 前端订阅此端点以接收索引重建进度、下载完成通知、AI 处理结果等实时消息。要求反向代理必须禁用缓存与缓冲。
