# Photonix 环境变量配置指南（上线精注释版）

本指南与后端代码严格对齐，按“必需/推荐/可选”分级列出变量，并为每个变量提供：
- 作用：变量做什么
- 默认值：代码中的缺省行为
- 取值/格式：允许范围或类型
- 推荐修改场景：何时需要调整
- 风险：错误设置的影响
- 代码引用：生效位置，便于排查
- 示例：建议写法

装载方式（重要）：
- 后端未引入 dotenv
  - Docker Compose：使用 env_file: .env 注入（根目录放置 .env）
  - 本机/PM2：以进程环境注入（PowerShell/Bash；或 PM2 ecosystem.config.js 的 env 字段）
更新日期：2025-09-06

---

## 1) 快速开始

生产
1) 复制 env.production 为 .env
2) 修改 JWT_SECRET（32+ 随机）与 ADMIN_SECRET（强口令），REDIS_URL 按部署网络
3) docker compose up -d

开发
- 复制 env.development 为 .env（或导出为进程环境），启动后端

---

## 2) 变量分级清单（详细注释）

以下默认值即代码默认行为；若需不同策略，请在 .env 覆盖。

### A. 必需（必须设置或确认）

1) PORT
- 作用：服务监听端口
- 默认值：13001
- 取值/格式：整数端口号
- 推荐修改场景：宿主机端口冲突或反代约定端口不同
- 风险：与反代/compose 端口映射不一致将导致访问失败
- 代码引用：backend/config/index.js（PORT）
- 示例：PORT=13001

2) NODE_ENV
- 作用：运行模式，影响日志与错误信息详略
- 默认值：development
- 取值/格式：development | production | test
- 推荐修改场景：上线必须设为 production
- 风险：production 若误设 development，可能在错误时泄露细节
- 代码引用：backend/app.js、controllers/*、workers/*（日志级别判断）
- 示例：NODE_ENV=production

3) LOG_LEVEL
- 作用：Winston 日志级别
- 默认值：info
- 取值/格式：error | warn | info | debug
- 推荐修改场景：排障期临时提升到 debug
- 风险：debug 产生日志量大，影响 IO/成本
- 代码引用：backend/config/index.js、config/logger.js、workers/*
- 示例：LOG_LEVEL=info

4) PHOTOS_DIR
- 作用：媒体库根目录（图片/视频）
- 默认值：/app/photos
- 取值/格式：绝对路径（容器内）
- 推荐修改场景：挂载到宿主机（NAS/NFS/本地盘）
- 风险：挂载错误则扫描不到数据；网络盘需配合 WATCH_* 参数
- 代码引用：backend/config/index.js、services/file.service.js、workers/indexing-worker.js
- 示例：PHOTOS_DIR=/app/photos

5) DATA_DIR
- 作用：应用数据目录（数据库/缩略图/HLS 等）
- 默认值：/app/data
- 取值/格式：绝对路径（容器内）
- 推荐修改场景：持久化数据到宿主机卷
- 风险：未持久化会在容器重建后丢数据
- 代码引用：backend/config/index.js、db/*
- 示例：DATA_DIR=/app/data

6) REDIS_URL
- 作用：Redis 连接（缓存/限流/队列/PubSub）
- 默认值：redis://localhost:6379（开发）/ 生产推荐 redis://redis:6379
- 取值/格式：redis://[user:pass@]host:port[/db]
- 推荐修改场景：容器网络或外部 Redis，含密码/ACL
- 风险：错误地址导致限流/缓存/队列/事件全部不可用
- 代码引用：backend/config/index.js、config/redis.js、middleware/rateLimiter.js、services/*、workers/*
- 示例：REDIS_URL=redis://redis:6379

7) JWT_SECRET
- 作用：JWT 签名密钥
- 默认值：无（必须提供）
- 取值/格式：32+ 随机字符串
- 推荐修改场景：生产必须设置强随机
- 风险：弱密钥可被伪造 Token，存在严重安全隐患
- 代码引用：backend/middleware/auth.js、controllers/auth.controller.js
- 示例：JWT_SECRET=g3A4...32plusRandom

8) ADMIN_SECRET
- 作用：后台敏感操作校验密钥
- 默认值：admin（必须修改）
- 取值/格式：强口令
- 推荐修改场景：生产必须自定义强口令
- 风险：默认值将导致敏感操作被滥用
- 代码引用：backend/controllers/settings.controller.js
- 示例：ADMIN_SECRET=ChangeMe_Strong_Admin

---

### B. 推荐（生产环境建议显式）

1) WORKER_MEMORY_MB
- 作用：worker_threads 最大老生代内存（MB）
- 默认值：512（建议值）
- 取值/格式：整数（如 384/512/768）
- 推荐修改场景：内存受限或批量图像处理密集
- 风险：过低易 OOM/任务失败；过高可能超过容器限制
- 代码引用：backend/services/worker.manager.js（resourceLimits）
- 示例：WORKER_MEMORY_MB=512

2) UV_THREADPOOL_SIZE
- 作用：libuv 线程池大小（影响 Sharp/IO）
- 默认值：4
- 取值/格式：1..CPU 核心数（或略少/略多）
- 推荐修改场景：CPU 充足且有大量 Sharp/IO 时可上调
- 风险：盲目上调可能增加切换开销
- 代码引用：Node.js 运行时
- 示例：UV_THREADPOOL_SIZE=4

3) FFMPEG_THREADS
- 作用：FFmpeg 并行线程数
- 默认值：2（生产）/ 1（开发建议）
- 取值/格式：>=1 的整数
- 推荐修改场景：CPU 充足且需要更高吞吐
- 风险：过高与其他线程竞争，可能过载
- 代码引用：backend/config/index.js、services/adaptive.service.js、workers/video-processor.js
- 示例：FFMPEG_THREADS=2

4) SHARP_CONCURRENCY
- 作用：Sharp 图像并发
- 默认值：2（生产）/ 1（开发）
- 取值/格式：>=1 的整数
- 推荐修改场景：大量缩略图生成、CPU 富余
- 风险：过高导致 CPU 饱和/内存激增
- 代码引用：backend/config/index.js、workers/thumbnail-worker.js、workers/indexing-worker.js
- 示例：SHARP_CONCURRENCY=2

5) SQLITE_BUSY_TIMEOUT
- 作用：SQLite 忙等待超时（ms）
- 默认值：20000（生产）/ 10000（开发）
- 取值/格式：>=1000
- 推荐修改场景：NFS/慢盘
- 风险：过低易失败；过高延迟故障显现
- 代码引用：backend/db/multi-db.js
- 示例：SQLITE_BUSY_TIMEOUT=20000

6) SQLITE_QUERY_TIMEOUT
- 作用：SQLite 查询超时（ms）
- 默认值：30000（生产）/ 15000（开发）
- 取值/格式：>=5000
- 推荐修改场景：大查询/慢盘
- 风险：过低易中断；过高延迟反馈
- 代码引用：backend/db/multi-db.js
- 示例：SQLITE_QUERY_TIMEOUT=30000

7) RATE_LIMIT_WINDOW_MINUTES
- 作用：API 限流窗口（分钟）
- 默认值：1
- 取值/格式：>=1
- 推荐修改场景：对外暴露/高并发
- 风险：过严误伤正常请求
- 代码引用：backend/middleware/rateLimiter.js
- 示例：RATE_LIMIT_WINDOW_MINUTES=15

8) RATE_LIMIT_MAX_REQUESTS
- 作用：窗口内最大请求数
- 默认值：800
- 取值/格式：>=1
- 推荐修改场景：更严格/更宽松的配额
- 风险：过低频繁 429；过高失去保护
- 代码引用：backend/middleware/rateLimiter.js
- 示例：RATE_LIMIT_MAX_REQUESTS=100

9) REFRESH_RATE_WINDOW_MS / REFRESH_RATE_MAX
- 作用：刷新令牌限流（窗口毫秒/最大次数）
- 默认值：60000 / 60
- 取值/格式：整数
- 推荐修改场景：大规模登录/刷新
- 风险：过严导致无法刷新 Token
- 代码引用：backend/routes/auth.routes.js
- 示例：REFRESH_RATE_WINDOW_MS=60000
- 示例：REFRESH_RATE_MAX=60

10) SETTINGS_REDIS_CACHE
- 作用：启用设置项的 Redis 缓存
- 默认值：false
- 取值/格式：true | false
- 推荐修改场景：生产建议开启以降 DB 压力
- 风险：关闭会增加 DB 压力；开启需保证 Redis 可用
- 代码引用：backend/services/settings.service.js
- 示例：SETTINGS_REDIS_CACHE=true

---

### C. 可选（按场景启用）

1) DISABLE_WATCH / WATCH_USE_POLLING / WATCH_POLL_INTERVAL / WATCH_POLL_BINARY_INTERVAL
- 作用：文件监听策略（网络盘/NFS 可使用轮询）
- 默认值：false / false / 1000 / 1500
- 取值/格式：布尔 / 毫秒整数
- 推荐修改场景：NFS/SMB/网络盘监听不稳时启用轮询并禁用 watch
- 风险：轮询增加 IO；禁用 watch 依赖手动/后台维护
- 代码引用：backend/services/indexer.service.js、config/index.js
- 示例：
  - DISABLE_WATCH=true
  - WATCH_USE_POLLING=true
  - WATCH_POLL_INTERVAL=2000
  - WATCH_POLL_BINARY_INTERVAL=3000

2) USE_FILE_SYSTEM_HLS_CHECK / HLS_*（TTL/批次/间隔/延迟）
- 作用：基于文件系统检查 HLS 就绪与缓存
- 默认值：true / 300000 / 10 / 1000 / 100
- 取值/格式：布尔 / 毫秒 / 数量
- 推荐修改场景：视频多或慢盘时调大间隔与延迟
- 风险：检查过频繁带来 IO 压力；过慢影响就绪感知
- 代码引用：backend/config/index.js
- 示例：HLS_CACHE_TTL_MS=300000

3) FFMPEG_PRESET
- 作用：FFmpeg 编码预设（速度/质量权衡）
- 默认值：veryfast
- 取值/范围：ultrafast|superfast|veryfast|faster|fast|medium|slow|slower|veryslow
- 推荐修改场景：需要更高质量或更快速度
- 风险：更慢预设显著增加 CPU/耗时
- 代码引用：services/adaptive.service.js、workers/video-processor.js
- 示例：FFMPEG_PRESET=fast

4) SHARP_CACHE_*（MEMORY_MB/ITEMS/FILES）/ SHARP_MAX_PIXELS
- 作用：Sharp 内存与最大像素保护
- 默认值：32 / 100 / 0 / 576000000
- 取值/格式：整数
- 推荐修改场景：内存充足增大缓存；超大图提高 MAX_PIXELS
- 风险：缓存过大占用内存；像素阈值过高风险 OOM
- 代码引用：workers/thumbnail-worker.js、workers/indexing-worker.js、services/file.service.js
- 示例：SHARP_CACHE_MEMORY_MB=64

5) DIMENSION_PROBE_CONCURRENCY
- 作用：文件尺寸探测并发（文件服务）
- 默认值：4
- 取值/格式：>=1 的整数
- 推荐修改场景：I/O 富余时上调
- 风险：并发过高增加磁盘压力
- 代码引用：services/file.service.js
- 示例：DIMENSION_PROBE_CONCURRENCY=4

6) AI_*（AI_CACHE_MAX_BYTES / AI_DAILY_LIMIT / AI_PER_IMAGE_COOLDOWN_SEC）
- 作用：AI 缓存与配额/冷却
- 默认值：268435456（生产建议）/ 200 / 60（开发较小）
- 取值/格式：字节数/次数/秒
- 推荐修改场景：成本/流控管理
- 风险：限制过严导致失败；过宽增加成本
- 代码引用：workers/ai-worker.js、middleware/ai-rate-guard.js
- 示例：AI_CACHE_MAX_BYTES=268435456

7) PERFORMANCE_MODE
- 作用：全局性能模式（自适应提示）
- 默认值：auto
- 取值/格式：auto|low|medium|high
- 推荐修改场景：初期大批量导入设为 low
- 风险：高性能模式在低配可能过载
- 代码引用：services/adaptive.service.js
- 示例：PERFORMANCE_MODE=low

8) DETECTED_CPU_COUNT / DETECTED_MEMORY_GB
- 作用：显式指定硬件资源供自适应逻辑参考（容器 cgroup 限制下可能检测不准）
- 默认值：未设置时系统探测
- 取值/格式：整数
- 推荐修改场景：容器受限/探测不准时
- 风险：填大将高估并发
- 代码引用：backend/config/index.js（detectHardwareConfig）
- 示例：DETECTED_CPU_COUNT=4

9) ENABLE_APP_CSP
- 作用：启用后端层面的 Content-Security-Policy
- 默认值：false
- 取值/格式：true|false
- 推荐修改场景：反代未统一下发 CSP 且需后端控制
- 风险：规则不全会拦截前端资源
- 代码引用：backend/app.js（helmet csp）
- 示例：ENABLE_APP_CSP=true

10) THUMB_ONDEMAND_RESERVE
- 作用：缩略图批量补全时预留按需工人数量（控制并发）
- 默认值：0（由 NUM_WORKERS 上限约束）
- 取值/格式：>=0 的整数
- 推荐修改场景：混部时保留并发给实时请求
- 风险：设置过大导致批量补全变慢
- 代码引用：services/thumbnail.service.js
- 示例：THUMB_ONDEMAND_RESERVE=0

11) API_BASE
- 作用：API 基础 URL（为空使用相对路径）
- 默认值：空字符串
- 取值/格式：URL 前缀
- 推荐修改场景：前后端分离或反代前缀
- 风险：错误前缀导致 404
- 代码引用：backend/config/index.js
- 示例：API_BASE=/api

12) VIDEO_TASK_DELAY_MS / INDEX_STABILIZE_DELAY_MS
- 作用：视频任务间延迟、索引稳定化延迟（ms）
- 默认值：1000 / 2000
- 取值/格式：毫秒整数
- 推荐修改场景：慢盘或抖动较大时调大
- 风险：过大降低吞吐；过小易过载
- 代码引用：backend/config/index.js
- 示例：INDEX_STABILIZE_DELAY_MS=3000

---

## 3) 场景化配置片段

微型配置（1H/1G）
```
PORT=13001
NODE_ENV=production
LOG_LEVEL=info
PHOTOS_DIR=/app/photos
DATA_DIR=/app/data
REDIS_URL=redis://redis:6379
JWT_SECRET=<32+ 强随机>
ADMIN_SECRET=<强口令>

# 内存优化（1G环境关键）
WORKER_MEMORY_MB=256
UV_THREADPOOL_SIZE=2
FFMPEG_THREADS=1
SHARP_CONCURRENCY=1

# 数据库优化（低配环境）
SQLITE_BUSY_TIMEOUT=30000
SQLITE_QUERY_TIMEOUT=45000
SETTINGS_REDIS_CACHE=true

# 限流收紧（保护低配环境）
RATE_LIMIT_WINDOW_MINUTES=15
RATE_LIMIT_MAX_REQUESTS=50
REFRESH_RATE_WINDOW_MS=60000
REFRESH_RATE_MAX=30

# 性能模式（低配优化）
PERFORMANCE_MODE=low
DETECTED_CPU_COUNT=1
DETECTED_MEMORY_GB=1

# Sharp内存限制（1G环境必需）
SHARP_CACHE_MEMORY_MB=16
SHARP_CACHE_ITEMS=50
SHARP_MAX_PIXELS=268435456

# AI限制（可选，低配环境建议限制）
AI_DAILY_LIMIT=50
AI_PER_IMAGE_COOLDOWN_SEC=120

# 缩略图优化
THUMB_ONDEMAND_RESERVE=1

# NFS/网络盘建议（如果使用）
# DISABLE_WATCH=true
# WATCH_USE_POLLING=true
# WATCH_POLL_INTERVAL=3000
# WATCH_POLL_BINARY_INTERVAL=5000
```

小型家庭（2C/4G，NAS/本地盘）
```
PORT=13001
NODE_ENV=production
LOG_LEVEL=info
PHOTOS_DIR=/app/photos
DATA_DIR=/app/data
REDIS_URL=redis://redis:6379
JWT_SECRET=<32+ 强随机>
ADMIN_SECRET=<强口令>

WORKER_MEMORY_MB=384
FFMPEG_THREADS=1
SHARP_CONCURRENCY=1
SQLITE_BUSY_TIMEOUT=20000
SQLITE_QUERY_TIMEOUT=30000
SETTINGS_REDIS_CACHE=true

# NFS/网络盘建议
# DISABLE_WATCH=true
# WATCH_USE_POLLING=true
# WATCH_POLL_INTERVAL=2000
# WATCH_POLL_BINARY_INTERVAL=3000
```

中型生产（4C/8G）
```
WORKER_MEMORY_MB=512
UV_THREADPOOL_SIZE=4
FFMPEG_THREADS=2
SHARP_CONCURRENCY=2
RATE_LIMIT_WINDOW_MINUTES=15
RATE_LIMIT_MAX_REQUESTS=100
SETTINGS_REDIS_CACHE=true
```

NFS/网络存储（稳定优先）
```
DISABLE_WATCH=true
WATCH_USE_POLLING=true
WATCH_POLL_INTERVAL=2000
WATCH_POLL_BINARY_INTERVAL=3000
SQLITE_BUSY_TIMEOUT=30000
SQLITE_QUERY_TIMEOUT=60000
```

---

## 4) 部署与注入方式

- Docker Compose（推荐）
  - 根目录创建 .env（由 env.production 拷贝）
  - docker-compose.yml 已引用 env_file: .env
  - 启动：docker compose up -d

- PM2（示例）
```js
module.exports = {
  apps: [{
    name: "photonix",
    script: "backend/server.js",
    env: {
      PORT: 13001,
      NODE_ENV: "production",
      LOG_LEVEL: "info",
      PHOTOS_DIR: "/app/photos",
      DATA_DIR: "/app/data",
      REDIS_URL: "redis://localhost:6379",
      JWT_SECRET: "change_me_32_chars",
      ADMIN_SECRET: "change_me_admin"
    }
  }]
}
```

- PowerShell（Windows）
```
$env:PORT="13001"; $env:NODE_ENV="production"; node backend/server.js
```

---

## 5) 上线检查清单

通用检查：
- [ ] JWT_SECRET 为强随机 32+ 字符；ADMIN_SECRET 为强口令
- [ ] REDIS_URL 指向生产 Redis；网络/权限正确
- [ ] PHOTOS_DIR / DATA_DIR 均已持久化挂载
- [ ] 限流策略符合预期（RATE_LIMIT_* / REFRESH_RATE_*）
- [ ] NFS/网络盘采用 WATCH_* 轮询并考虑 DISABLE_WATCH
- [ ] 首日观察 CPU/内存/IO，按需微调 SHARP_CONCURRENCY / FFMPEG_THREADS / UV_THREADPOOL_SIZE
- [ ] （可选）SETTINGS_REDIS_CACHE=true 降低 DB 压力
- [ ] （可选）根据反代策略评估 ENABLE_APP_CSP

---

## 6) 故障排查

通用问题：
- 401/无法登录：检查 JWT_SECRET/ADMIN_SECRET 注入
- Redis 连接失败：确认 REDIS_URL 与容器网络/密码
- 访问慢/超时：增大 SQLITE_* 超时，降低 SHARP_CONCURRENCY/FFMPEG_THREADS
- NFS 丢事件：启用 WATCH_USE_POLLING 并提高轮询间隔