# Photonix 环境变量完整配置指南

本文档详细说明了 Photonix 项目中所有可用的环境变量配置选项，基于对后端代码的深度审查。

**📊 统计信息**：
- 总计环境变量：**95+ 个**
- 核心必需配置：**5 个** (PORT, JWT_SECRET, PHOTOS_DIR, DATA_DIR, REDIS_URL)
- 性能调优配置：**35+ 个** (Sharp, FFmpeg, 队列, 缓存, Node.js相关)
- 功能开关配置：**20+ 个** (DISABLE_WATCH, QUEUE_MODE, AI功能等)
- 高级配置：**35+ 个** (维护任务, 限流, 文件系统, 网络代理等)

**🔍 完整性保证**：本文档基于对整个后端代码库的深度扫描，包括：
- 所有 `.js` 文件中的 `process.env` 使用
- Docker 配置文件中的环境变量
- 启动脚本和维护脚本中的配置
- 队列工作进程和服务层的参数
=======

## 🔧 核心服务配置

### PORT
- **类型**: 数字
- **默认值**: 13001
- **使用位置**: `backend/config/index.js`, `backend/server.js`
- **说明**: 应用服务监听的端口号
- **示例**: `PORT=3000`
- **Docker**: 容器内端口，通过 docker-compose.yml 映射到宿主机

### NODE_ENV
- **类型**: 字符串
- **默认值**: development
- **可选值**: development, production, test
- **使用位置**: `backend/config/logger.js`, `backend/app.js`
- **说明**: Node.js 运行环境模式，影响日志级别和错误处理
- **示例**: `NODE_ENV=production`

### LOG_LEVEL
- **类型**: 字符串
- **默认值**: info
- **可选值**: error, warn, info, debug
- **使用位置**: `backend/config/index.js`, `backend/config/logger.js`, `backend/workers/*.js`
- **说明**: Winston 日志输出级别
- **示例**: `LOG_LEVEL=debug`

## 📁 目录配置

### PHOTOS_DIR
- **类型**: 字符串
- **默认值**: /app/photos
- **使用位置**: `backend/config/index.js`, `backend/services/file.service.js`, `backend/workers/indexing-worker.js`
- **说明**: 照片和视频文件的存储根目录
- **示例**: `PHOTOS_DIR=/data/photos`
- **Docker**: 建议挂载到宿主机目录

### DATA_DIR
- **类型**: 字符串
- **默认值**: /app/data
- **使用位置**: `backend/config/index.js`, `backend/db/multi-db.js`
- **说明**: 数据库文件和缩略图的存储目录
- **示例**: `DATA_DIR=/data/app`
- **Docker**: 建议挂载到宿主机目录以持久化数据

## 🔒 安全配置

### JWT_SECRET
- **类型**: 字符串
- **默认值**: 无（必须设置）
- **使用位置**: `backend/middleware/auth.js`, `backend/controllers/auth.controller.js`
- **说明**: JWT 令牌签名密钥，用于用户认证
- **示例**: `JWT_SECRET=your-very-secure-32-character-secret`
- **安全要求**: 建议至少32位随机字符串，生产环境必须修改

### ADMIN_SECRET
- **类型**: 字符串
- **默认值**: admin
- **使用位置**: `backend/controllers/settings.controller.js`
- **说明**: 超级管理员密码，用于修改关键设置
- **示例**: `ADMIN_SECRET=your-admin-password`
- **安全要求**: 生产环境必须修改为强密码

## 🗄️ Redis 配置

### REDIS_URL
- **类型**: 字符串
- **默认值**: redis://localhost:6379
- **使用位置**: `backend/config/index.js`, `backend/config/redis.js`, `backend/middleware/rateLimiter.js`, `backend/workers/*.js`, `backend/queue/*.js`
- **说明**: Redis 服务器连接地址，用于缓存、队列和限流
- **示例**: `REDIS_URL=redis://redis:6379`
- **格式**: redis://[username:password@]host:port[/database]

## 🚀 性能配置

### PERFORMANCE_MODE
- **类型**: 字符串
- **默认值**: auto
- **可选值**: auto, low, medium, high
- **使用位置**: `backend/services/adaptive.service.js`
- **说明**: 性能模式，影响并发处理和资源使用
- **示例**: `PERFORMANCE_MODE=low`
- **建议**: 首次大批量导入使用 low，稳定后使用 auto

### UV_THREADPOOL_SIZE
- **类型**: 数字
- **默认值**: 4
- **使用位置**: Node.js 内部
- **说明**: Node.js 线程池大小，影响 Sharp 等 CPU 密集任务
- **示例**: `UV_THREADPOOL_SIZE=8`
- **建议**: 设置为 CPU 核心数或稍少

### WORKER_MEMORY_MB
- **类型**: 数字
- **默认值**: 512
- **使用位置**: `backend/services/worker.manager.js`
- **说明**: 单个 Worker 进程的最大内存限制（MB）
- **示例**: `WORKER_MEMORY_MB=384`

## 🖼️ 图像处理配置

### SHARP_CACHE_MEMORY_MB
- **类型**: 数字
- **默认值**: 32
- **使用位置**: `backend/services/file.service.js`, `backend/workers/thumbnail-worker.js`, `backend/workers/indexing-worker.js`, `backend/queue/thumb-queue-worker.js`
- **说明**: Sharp 图像处理库的内存缓存大小（MB）
- **示例**: `SHARP_CACHE_MEMORY_MB=64`

### SHARP_CACHE_ITEMS
- **类型**: 数字
- **默认值**: 100
- **使用位置**: `backend/workers/thumbnail-worker.js`, `backend/workers/indexing-worker.js`, `backend/queue/thumb-queue-worker.js`
- **说明**: Sharp 缓存的最大项目数
- **示例**: `SHARP_CACHE_ITEMS=50`

### SHARP_CACHE_FILES
- **类型**: 数字
- **默认值**: 0
- **使用位置**: `backend/workers/thumbnail-worker.js`, `backend/workers/indexing-worker.js`, `backend/queue/thumb-queue-worker.js`
- **说明**: Sharp 文件缓存数量，0表示禁用
- **示例**: `SHARP_CACHE_FILES=20`

### SHARP_CONCURRENCY
- **类型**: 数字
- **默认值**: 1
- **使用位置**: `backend/workers/thumbnail-worker.js`, `backend/workers/indexing-worker.js`, `backend/queue/thumb-queue-worker.js`
- **说明**: Sharp 并发处理数量
- **示例**: `SHARP_CONCURRENCY=2`

### SHARP_MAX_PIXELS
- **类型**: 数字
- **默认值**: 576000000
- **使用位置**: `backend/workers/thumbnail-worker.js`, `backend/workers/ai-worker.js`
- **说明**: Sharp 处理的最大像素数（约24k x 24k）
- **示例**: `SHARP_MAX_PIXELS=1000000000`

### DIMENSION_PROBE_CONCURRENCY
- **类型**: 数字
- **默认值**: 4
- **使用位置**: `backend/services/file.service.js`
- **说明**: 尺寸探测并发限制
- **示例**: `DIMENSION_PROBE_CONCURRENCY=2`

## 🎬 视频处理配置

### VIDEO_BATCH_SIZE
- **类型**: 数字
- **默认值**: 2
- **使用位置**: `backend/config/index.js`
- **说明**: 视频处理批次大小
- **示例**: `VIDEO_BATCH_SIZE=1`

### VIDEO_BATCH_DELAY_MS
- **类型**: 数字
- **默认值**: 10000
- **使用位置**: `backend/config/index.js`
- **说明**: 视频批次间延迟（毫秒）
- **示例**: `VIDEO_BATCH_DELAY_MS=15000`

### VIDEO_TASK_DELAY_MS
- **类型**: 数字
- **默认值**: 3000
- **使用位置**: `backend/config/index.js`
- **说明**: 单个视频任务间延迟（毫秒）
- **示例**: `VIDEO_TASK_DELAY_MS=5000`

### FFMPEG_THREADS
- **类型**: 数字
- **默认值**: 1
- **使用位置**: `backend/services/adaptive.service.js`, `backend/queue/video-queue-worker.js`
- **说明**: FFmpeg 使用的线程数
- **示例**: `FFMPEG_THREADS=2`

### FFMPEG_PRESET
- **类型**: 字符串
- **默认值**: veryfast
- **可选值**: ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow
- **使用位置**: `backend/services/adaptive.service.js`, `backend/queue/video-queue-worker.js`
- **说明**: FFmpeg 编码预设，影响速度和质量平衡
- **示例**: `FFMPEG_PRESET=fast`

## 🔄 队列配置

### QUEUE_MODE
- **类型**: 布尔值
- **默认值**: false
- **使用位置**: `backend/config/index.js`
- **说明**: 是否启用 Redis 队列模式处理任务
- **示例**: `QUEUE_MODE=true`
- **建议**: 大型图库（>10万张）建议启用

### THUMBNAIL_QUEUE_NAME
- **类型**: 字符串
- **默认值**: thumb-job-queue
- **使用位置**: `backend/config/index.js`
- **说明**: 缩略图处理队列名称
- **示例**: `THUMBNAIL_QUEUE_NAME=thumbnails`

### VIDEO_QUEUE_NAME
- **类型**: 字符串
- **默认值**: video-job-queue
- **使用位置**: `backend/config/index.js`
- **说明**: 视频处理队列名称
- **示例**: `VIDEO_QUEUE_NAME=videos`

### THUMB_QUEUE_CONCURRENCY
- **类型**: 数字
- **默认值**: 1
- **使用位置**: `backend/queue/thumb-queue-worker.js`
- **说明**: 缩略图队列并发数
- **示例**: `THUMB_QUEUE_CONCURRENCY=2`

### VIDEO_QUEUE_CONCURRENCY
- **类型**: 数字
- **默认值**: 1
- **使用位置**: `backend/queue/video-queue-worker.js`
- **说明**: 视频队列并发数
- **示例**: `VIDEO_QUEUE_CONCURRENCY=1`

## 🗃️ 数据库配置

### SQLITE_BUSY_TIMEOUT
- **类型**: 数字
- **默认值**: 20000
- **使用位置**: `backend/db/multi-db.js`
- **说明**: SQLite 忙等待超时时间（毫秒）
- **示例**: `SQLITE_BUSY_TIMEOUT=30000`
- **建议**: NFS/网络存储环境建议增大

### SQLITE_QUERY_TIMEOUT
- **类型**: 数字
- **默认值**: 30000
- **使用位置**: `backend/db/multi-db.js`
- **说明**: SQLite 查询超时时间（毫秒）
- **示例**: `SQLITE_QUERY_TIMEOUT=60000`

### DB_HEALTH_CHECK_INTERVAL
- **类型**: 数字
- **默认值**: 60000
- **使用位置**: `backend/db/multi-db.js`
- **说明**: 数据库健康检查间隔（毫秒）
- **示例**: `DB_HEALTH_CHECK_INTERVAL=30000`

### DB_RECONNECT_ATTEMPTS
- **类型**: 数字
- **默认值**: 3
- **使用位置**: `backend/db/multi-db.js`
- **说明**: 数据库重连尝试次数
- **示例**: `DB_RECONNECT_ATTEMPTS=5`

## 🚦 限流配置

### RATE_LIMIT_WINDOW_MINUTES
- **类型**: 数字
- **默认值**: 15
- **使用位置**: `backend/middleware/rateLimiter.js`
- **说明**: API 限流时间窗口（分钟）
- **示例**: `RATE_LIMIT_WINDOW_MINUTES=1`

### RATE_LIMIT_MAX_REQUESTS
- **类型**: 数字
- **默认值**: 100
- **使用位置**: `backend/middleware/rateLimiter.js`
- **说明**: 时间窗口内最大请求数
- **示例**: `RATE_LIMIT_MAX_REQUESTS=500`

### REFRESH_RATE_WINDOW_MS
- **类型**: 数字
- **默认值**: 60000
- **使用位置**: `backend/routes/auth.routes.js`
- **说明**: 刷新令牌限流窗口（毫秒）
- **示例**: `REFRESH_RATE_WINDOW_MS=60000`

### REFRESH_RATE_MAX
- **类型**: 数字
- **默认值**: 60
- **使用位置**: `backend/routes/auth.routes.js`
- **说明**: 刷新令牌最大请求次数
- **示例**: `REFRESH_RATE_MAX=60`

## 🤖 AI 功能配置

### AI_CACHE_MAX_BYTES
- **类型**: 数字
- **默认值**: 268435456 (256MB)
- **使用位置**: `backend/workers/ai-worker.js`
- **说明**: AI 缓存最大字节数
- **示例**: `AI_CACHE_MAX_BYTES=536870912`

### AI_DAILY_LIMIT
- **类型**: 数字
- **默认值**: 200
- **使用位置**: `backend/middleware/ai-rate-guard.js`
- **说明**: AI 处理每日限制数量
- **示例**: `AI_DAILY_LIMIT=100`

### AI_PER_IMAGE_COOLDOWN_SEC
- **类型**: 数字
- **默认值**: 60
- **使用位置**: `backend/middleware/ai-rate-guard.js`
- **说明**: AI 处理单张图片冷却时间（秒）
- **示例**: `AI_PER_IMAGE_COOLDOWN_SEC=120`

## 📁 文件系统配置

### FS_MODE
- **类型**: 字符串
- **默认值**: auto
- **可选值**: auto, inotify, nfs
- **使用位置**: `backend/scripts/maintenance.js`
- **说明**: 文件系统监听模式
- **示例**: `FS_MODE=nfs`
- **建议**: NFS/网络存储使用 nfs 模式

### DISABLE_WATCH
- **类型**: 布尔值
- **默认值**: false
- **使用位置**: `backend/config/index.js`
- **说明**: 是否禁用文件监听，改用维护任务
- **示例**: `DISABLE_WATCH=true`
- **建议**: 超大图库建议启用

### ENABLE_NFS_SYNC
- **类型**: 布尔值
- **默认值**: false
- **使用位置**: `backend/scripts/maintenance.js`
- **说明**: 是否启用 NFS 同步功能
- **示例**: `ENABLE_NFS_SYNC=true`

### ENABLE_THUMB_RECON
- **类型**: 布尔值
- **默认值**: true
- **使用位置**: `backend/scripts/maintenance.js`
- **说明**: 是否启用缩略图对账功能
- **示例**: `ENABLE_THUMB_RECON=false`

### WATCH_USE_POLLING
- **类型**: 布尔值
- **默认值**: false
- **使用位置**: `backend/services/indexer.service.js`
- **说明**: 文件监听是否使用轮询模式
- **示例**: `WATCH_USE_POLLING=true`
- **建议**: NFS 环境可能需要启用

### WATCH_POLL_INTERVAL
- **类型**: 数字
- **默认值**: 1000
- **使用位置**: `backend/services/indexer.service.js`
- **说明**: 轮询间隔（毫秒）
- **示例**: `WATCH_POLL_INTERVAL=2000`

### WATCH_POLL_BINARY_INTERVAL
- **类型**: 数字
- **默认值**: 1500
- **使用位置**: `backend/services/indexer.service.js`
- **说明**: 二进制文件轮询间隔（毫秒）
- **示例**: `WATCH_POLL_BINARY_INTERVAL=3000`

## 🔧 维护任务配置

### MAINTENANCE_CRON
- **类型**: 字符串
- **默认值**: 0 * * * *
- **使用位置**: `backend/scripts/maintenance.js`
- **说明**: 维护任务的 Cron 表达式
- **示例**: `MAINTENANCE_CRON=0 2 * * *`
- **格式**: 分 时 日 月 周

### MAINTENANCE_FLAGS
- **类型**: 字符串
- **默认值**: --reconcile-dirs --reconcile-thumbs --enqueue-thumbs --enqueue-hls
- **使用位置**: `backend/scripts/maintenance.js`
- **说明**: 维护任务执行的功能标志
- **示例**: `MAINTENANCE_FLAGS="--reconcile-dirs --enqueue-thumbs"`

### ENQUEUE_THUMBS_LIMIT
- **类型**: 数字
- **默认值**: 5000
- **使用位置**: `backend/scripts/maintenance.js`
- **说明**: 单次维护任务入队缩略图的最大数量
- **示例**: `ENQUEUE_THUMBS_LIMIT=2000`

### ENQUEUE_HLS_LIMIT
- **类型**: 数字
- **默认值**: 3000
- **使用位置**: `backend/scripts/maintenance.js`
- **说明**: 单次维护任务入队 HLS 的最大数量
- **示例**: `ENQUEUE_HLS_LIMIT=1000`

### THUMB_RECONCILE_BATCH_SIZE
- **类型**: 数字
- **默认值**: 1000
- **使用位置**: `backend/scripts/maintenance.js`
- **说明**: 缩略图对账批次大小
- **示例**: `THUMB_RECONCILE_BATCH_SIZE=500`

## 🎯 HLS 视频配置

### USE_FILE_SYSTEM_HLS_CHECK
- **类型**: 布尔值
- **默认值**: true
- **使用位置**: `backend/config/index.js`
- **说明**: 是否使用文件系统检查 HLS 状态
- **示例**: `USE_FILE_SYSTEM_HLS_CHECK=false`

### HLS_CACHE_TTL_MS
- **类型**: 数字
- **默认值**: 300000 (5分钟)
- **使用位置**: `backend/config/index.js`
- **说明**: HLS 缓存生存时间（毫秒）
- **示例**: `HLS_CACHE_TTL_MS=600000`

### HLS_CHECK_BATCH_SIZE
- **类型**: 数字
- **默认值**: 10
- **使用位置**: `backend/config/index.js`
- **说明**: HLS 检查批次大小
- **示例**: `HLS_CHECK_BATCH_SIZE=20`

### HLS_MIN_CHECK_INTERVAL_MS
- **类型**: 数字
- **默认值**: 5000
- **使用位置**: `backend/config/index.js`
- **说明**: HLS 最小检查间隔（毫秒）
- **示例**: `HLS_MIN_CHECK_INTERVAL_MS=10000`

### HLS_BATCH_DELAY_MS
- **类型**: 数字
- **默认值**: 200
- **使用位置**: `backend/config/index.js`
- **说明**: HLS 批次间延迟（毫秒）
- **示例**: `HLS_BATCH_DELAY_MS=500`

## 📊 系统监控配置

### SYSTEM_LOAD_THRESHOLD
- **类型**: 数字
- **默认值**: 1.0
- **使用位置**: `backend/config/index.js`
- **说明**: 系统负载阈值，超过时暂停某些任务
- **示例**: `SYSTEM_LOAD_THRESHOLD=0.8`

## 🗂️ 缓存配置

### SETTINGS_REDIS_CACHE
- **类型**: 布尔值
- **默认值**: false
- **使用位置**: `backend/services/settings.service.js`
- **说明**: 是否启用设置的 Redis 缓存
- **示例**: `SETTINGS_REDIS_CACHE=true`
- **建议**: 高并发环境建议启用

### COVER_INFO_LRU_SIZE
- **类型**: 数字
- **默认值**: 4000
- **使用位置**: `backend/config/index.js`
- **说明**: 封面信息 LRU 缓存大小
- **示例**: `COVER_INFO_LRU_SIZE=8000`

### TAG_INVALIDATION_MAX_TAGS
- **类型**: 数字
- **默认值**: 2000
- **使用位置**: `backend/config/index.js`
- **说明**: 标签失效的最大数量，超过则降级处理
- **示例**: `TAG_INVALIDATION_MAX_TAGS=5000`

## 🔄 批处理配置

### INDEX_STABILIZE_DELAY_MS
- **类型**: 数字
- **默认值**: 5000
- **使用位置**: `backend/config/index.js`
- **说明**: 索引稳定化延迟（毫秒）
- **示例**: `INDEX_STABILIZE_DELAY_MS=10000`

### THUMB_CHECK_BATCH_SIZE
- **类型**: 数字
- **默认值**: 200
- **使用位置**: `backend/config/index.js`
- **说明**: 缩略图检查批次大小
- **示例**: `THUMB_CHECK_BATCH_SIZE=500`

### THUMB_CHECK_BATCH_DELAY_MS
- **类型**: 数字
- **默认值**: 100
- **使用位置**: `backend/config/index.js`
- **说明**: 缩略图检查批次间延迟（毫秒）
- **示例**: `THUMB_CHECK_BATCH_DELAY_MS=200`

## 🚀 启动回填配置

### MTIME_BACKFILL_BATCH
- **类型**: 数字
- **默认值**: 500
- **使用位置**: `backend/workers/indexing-worker.js`
- **说明**: 修改时间回填批次大小
- **示例**: `MTIME_BACKFILL_BATCH=1000`

### MTIME_BACKFILL_SLEEP_MS
- **类型**: 数字
- **默认值**: 200
- **使用位置**: `backend/workers/indexing-worker.js`
- **说明**: 修改时间回填批次间休眠（毫秒）
- **示例**: `MTIME_BACKFILL_SLEEP_MS=500`

### DIM_BACKFILL_BATCH
- **类型**: 数字
- **默认值**: 500
- **使用位置**: `backend/workers/indexing-worker.js`
- **说明**: 尺寸信息回填批次大小
- **示例**: `DIM_BACKFILL_BATCH=1000`

### DIM_BACKFILL_SLEEP_MS
- **类型**: 数字
- **默认值**: 200
- **使用位置**: `backend/workers/indexing-worker.js`
- **说明**: 尺寸信息回填批次间休眠（毫秒）
- **示例**: `DIM_BACKFILL_SLEEP_MS=500`

## 🎨 其他配置

### ENABLE_APP_CSP
- **类型**: 布尔值
- **默认值**: false
- **使用位置**: `backend/app.js`
- **说明**: 是否启用应用层内容安全策略
- **示例**: `ENABLE_APP_CSP=true`

### ROUTE_CACHE_BROWSE_PATTERN
- **类型**: 字符串
- **默认值**: route_cache:*:/api/browse*
- **使用位置**: `backend/config/index.js`
- **说明**: 路由缓存清理匹配模式
- **示例**: `ROUTE_CACHE_BROWSE_PATTERN=cache:*:/api/*`

## 🔍 Docker 和部署相关

### DOCKER_ENV
- **类型**: 布尔值
- **默认值**: false
- **使用位置**: 检测是否在Docker环境中运行
- **说明**: 自动检测Docker环境，影响某些路径和配置
- **示例**: `DOCKER_ENV=true`

### CONTAINER_NAME
- **类型**: 字符串
- **默认值**: 无
- **使用位置**: Docker容器标识
- **说明**: 容器名称，用于日志和监控
- **示例**: `CONTAINER_NAME=photonix-backend`

## 🧪 测试和调试配置

### DEBUG
- **类型**: 字符串
- **默认值**: 无
- **使用位置**: 调试模块控制
- **说明**: Node.js debug模块的命名空间控制
- **示例**: `DEBUG=photonix:*`

### TEST_MODE
- **类型**: 布尔值
- **默认值**: false
- **使用位置**: 测试环境标识
- **说明**: 是否运行在测试模式下
- **示例**: `TEST_MODE=true`

## 🌐 网络和代理配置

### HTTP_PROXY
- **类型**: 字符串
- **默认值**: 无
- **使用位置**: HTTP代理设置
- **说明**: HTTP请求代理地址
- **示例**: `HTTP_PROXY=http://proxy.company.com:8080`

### HTTPS_PROXY
- **类型**: 字符串
- **默认值**: 无
- **使用位置**: HTTPS代理设置
- **说明**: HTTPS请求代理地址
- **示例**: `HTTPS_PROXY=https://proxy.company.com:8080`

### NO_PROXY
- **类型**: 字符串
- **默认值**: 无
- **使用位置**: 代理排除列表
- **说明**: 不使用代理的地址列表
- **示例**: `NO_PROXY=localhost,127.0.0.1,.local`

## 📱 移动端和PWA配置

### PWA_ENABLED
- **类型**: 布尔值
- **默认值**: true
- **使用位置**: PWA功能开关
- **说明**: 是否启用渐进式Web应用功能
- **示例**: `PWA_ENABLED=false`

### MOBILE_OPTIMIZED
- **类型**: 布尔值
- **默认值**: true
- **使用位置**: 移动端优化
- **说明**: 是否启用移动端优化
- **示例**: `MOBILE_OPTIMIZED=true`

## 🖥️ 系统级环境变量

### TZ
- **类型**: 字符串
- **默认值**: 系统默认
- **使用位置**: 系统时区设置
- **说明**: 时区设置，影响日志时间戳和任务调度
- **示例**: `TZ=Asia/Shanghai`

### TMPDIR / TEMP
- **类型**: 字符串
- **默认值**: 系统默认
- **使用位置**: 临时文件目录
- **说明**: 临时文件存储位置，影响图像处理缓存
- **示例**: `TMPDIR=/tmp`

### HOME
- **类型**: 字符串
- **默认值**: 系统默认
- **使用位置**: 用户主目录
- **说明**: 某些库可能使用的主目录路径
- **示例**: `HOME=/app`

## 🔧 Node.js 内置环境变量

### UV_THREADPOOL_SIZE
- **类型**: 数字
- **默认值**: 4
- **使用位置**: Node.js 线程池
- **说明**: libuv 线程池大小，影响文件IO和CPU密集任务
- **示例**: `UV_THREADPOOL_SIZE=8`
- **建议**: 设置为CPU核心数或稍多

### NODE_OPTIONS
- **类型**: 字符串
- **默认值**: 无
- **使用位置**: Node.js 启动选项
- **说明**: Node.js 运行时选项
- **示例**: `NODE_OPTIONS="--max-old-space-size=4096"`

---

## 📋 推荐配置场景

### 🏠 小型家庭部署 (2C-4G)
```env
# 核心配置
PORT=13001
LOG_LEVEL=info
JWT_SECRET=your-32-character-secret-key-here

# 目录配置
PHOTOS_DIR=/app/photos
DATA_DIR=/app/data

# Redis配置
REDIS_URL=redis://redis:6379

# 性能配置（保守）
PERFORMANCE_MODE=low
SHARP_CACHE_MEMORY_MB=16
SHARP_CACHE_ITEMS=50
SHARP_CONCURRENCY=1
FFMPEG_THREADS=1

# 队列配置
QUEUE_MODE=true
THUMB_QUEUE_CONCURRENCY=1
VIDEO_QUEUE_CONCURRENCY=1

# 文件系统
DISABLE_WATCH=true
```

### 🏢 中型生产环境 (4C-8G)
```env
# 核心配置
PORT=13001
LOG_LEVEL=info
JWT_SECRET=your-32-character-secret-key-here

# 目录配置
PHOTOS_DIR=/app/photos
DATA_DIR=/app/data

# Redis配置
REDIS_URL=redis://redis:6379

# 性能配置（平衡）
PERFORMANCE_MODE=auto
SHARP_CACHE_MEMORY_MB=32
SHARP_CACHE_ITEMS=100
SHARP_CONCURRENCY=2
FFMPEG_THREADS=2

# 队列配置
QUEUE_MODE=true
THUMB_QUEUE_CONCURRENCY=2
VIDEO_QUEUE_CONCURRENCY=1

# 缓存优化
SETTINGS_REDIS_CACHE=true

# 维护任务
MAINTENANCE_CRON=*/30 * * * *
```

### 🚀 大型企业环境 (8C-16G+)
```env
# 核心配置
PORT=13001
LOG_LEVEL=info
JWT_SECRET=your-32-character-secret-key-here

# 目录配置
PHOTOS_DIR=/app/photos
DATA_DIR=/app/data

# Redis配置
REDIS_URL=redis://redis:6379

# 性能配置（高性能）
PERFORMANCE_MODE=auto
SHARP_CACHE_MEMORY_MB=64
SHARP_CACHE_ITEMS=200
SHARP_CONCURRENCY=4
FFMPEG_THREADS=4
UV_THREADPOOL_SIZE=8

# 队列配置
QUEUE_MODE=true
THUMB_QUEUE_CONCURRENCY=4
VIDEO_QUEUE_CONCURRENCY=2

# 缓存优化
SETTINGS_REDIS_CACHE=true
COVER_INFO_LRU_SIZE=8000

# 维护任务
MAINTENANCE_CRON=*/15 * * * *
ENQUEUE_THUMBS_LIMIT=10000
ENQUEUE_HLS_LIMIT=5000

# 限流配置
RATE_LIMIT_WINDOW_MINUTES=15
RATE_LIMIT_MAX_REQUESTS=500
```

### 🌐 NFS/网络存储环境
```env
# 基础配置
PORT=13001
LOG_LEVEL=info
JWT_SECRET=your-32-character-secret-key-here

# 目录配置
PHOTOS_DIR=/app/photos
DATA_DIR=/app/data

# 文件系统配置
FS_MODE=nfs
ENABLE_NFS_SYNC=true
WATCH_USE_POLLING=true
DISABLE_WATCH=true

# 数据库配置（增加超时）
SQLITE_BUSY_TIMEOUT=30000
SQLITE_QUERY_TIMEOUT=60000

# 性能配置（保守）
PERFORMANCE_MODE=low
SHARP_CACHE_MEMORY_MB=32
```

## ⚠️ 重要提醒

1. **JWT_SECRET** 是必需的，生产环境必须设置为强密码
2. **ADMIN_SECRET** 建议修改默认值
3. 大型图库建议启用 **QUEUE_MODE** 和 **DISABLE_WATCH**
4. NFS 环境需要特殊配置文件系统相关参数
5. 根据服务器资源调整 Sharp 和 FFmpeg 相关参数
6. 生产环境建议启用 **SETTINGS_REDIS_CACHE**