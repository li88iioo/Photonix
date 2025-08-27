# 环境变量配置说明（ENV Guide)

本文档详细解释项目支持的环境变量、作用、默认值，以及在不同规模与资源配置服务器上的推荐组合。

## 基础类

- REDIS_URL (默认: redis://redis:6379)
  - 用途：express-rate-limit 共享存储、BullMQ 队列、轻量状态缓存
  - 建议：生产开启 AOF，必要时独立实例或独立 DB index

- PORT (默认: 13001)
  - 后端监听端口

- NODE_ENV (默认: production)
  - 生产固定 production

- LOG_LEVEL (默认: info)
  - 可选: debug|info|warn|error
  - 大量首扫/排障时可临时设置 debug

- JWT_SECRET (必填)
  - 登录 Token 签发密钥，务必使用高强度随机串

- ADMIN_SECRET (建议设置)
  - 执行敏感设置调整时使用

## 性能与自适应

- PERFORMANCE_MODE (默认: auto)
  - 可选: auto|low|medium|high
  - auto: 依据 1 分钟负载与 CPU 核自动切换
  - low: 最保守（降缩略图并发/暂停 HLS 回填），适合超大库首扫或低配机器

- WORKER_MEMORY_MB (默认: 512)
  - 单个 Worker 的老生代上限，低内存主机可调小

## sharp/libvips 控制（内存关键）

- SHARP_MAX_PIXELS (默认: 24k×24k ≈ 576e6)
  - 保护异常超大图的解码

- SHARP_CACHE_MEMORY_MB (默认: 32)
- SHARP_CACHE_ITEMS (默认: 100)
- SHARP_CACHE_FILES (默认: 0)
- SHARP_CONCURRENCY (默认: 1)
  - 建议超大库从低配开始，稳定后再调大

## 队列模式与监听

- DISABLE_WATCH (默认: false)
  - true 时禁用 chokidar 实时监听，减少常驻内存与 CPU；依赖定时维护与批量入队

- QUEUE_MODE (默认: false)
  - true 时缩略图/视频处理通过 BullMQ 队列；便于限流、背压、横向扩容

- THUMB_QUEUE_CONCURRENCY (默认: 1)
- VIDEO_QUEUE_CONCURRENCY (默认: 1)
  - 队列 Worker 并发；按机器资源与磁盘 IO 逐步提升

## 速率限制（express-rate-limit）

- RATE_LIMIT_WINDOW_MINUTES (默认: 15)
- RATE_LIMIT_MAX_REQUESTS (默认: 100)
  - 命中 429 时返回 JSON（含 Retry-After）

## 维护与批处理

- MAINTENANCE_CRON (默认: 0 * * * *)
  - 定时任务表达式；默认每小时跑一次维护

- MAINTENANCE_FLAGS (默认: "--reconcile-dirs --reconcile-thumbs --enqueue-thumbs --enqueue-hls")
  - --reconcile-dirs: 目录对账（NFS/网络盘推荐）
  - --reconcile-thumbs: 缩略图存在性对账（丢失标记为 pending）
  - --enqueue-thumbs: 扫描 DB 的 pending/failed/mtime 变更媒体并入队缩略图
  - --enqueue-hls: 扫描 DB 的视频并入队缺失 HLS

- ENQUEUE_THUMBS_LIMIT (默认: 5000)
- ENQUEUE_HLS_LIMIT (默认: 3000)
  - 批量入队阈值，避免瞬时排队过多

- FS_MODE (默认: auto)
  - 可选: auto|nfs|inotify
  - nfs 时不启用 chokidar，仅靠维护任务

- ENABLE_NFS_SYNC (默认: false)
  - true 时目录对账默认启用

- ENABLE_THUMB_RECON (默认: true)
  - 缩略图对账默认开启

## HLS/视频处理

- FFMPEG_THREADS (默认: 1)
- FFMPEG_PRESET (默认: veryfast)
  - 线程与预设；弱机保持 conservatively

- VIDEO_BATCH_SIZE (默认: 2)
- VIDEO_BATCH_DELAY_MS (默认: 10000)
- VIDEO_TASK_DELAY_MS (默认: 3000)
- SYSTEM_LOAD_THRESHOLD (默认: 1.0)
  - 主线程批量派发/回填时的节奏和负载保护

- USE_FILE_SYSTEM_HLS_CHECK (默认: true)
- HLS_CACHE_TTL_MS (默认: 300000)
- HLS_CHECK_BATCH_SIZE (默认: 10)
- HLS_MIN_CHECK_INTERVAL_MS (默认: 5000)
- HLS_BATCH_DELAY_MS (默认: 200)

## 推荐配置方案

### A) 2C-4G（入门/边缘/家庭 NAS）
- PERFORMANCE_MODE=low
- DISABLE_WATCH=true
- QUEUE_MODE=true
- THUMB_QUEUE_CONCURRENCY=1
- VIDEO_QUEUE_CONCURRENCY=1
- SHARP_CACHE_MEMORY_MB=16
- SHARP_CACHE_ITEMS=50
- SHARP_CONCURRENCY=1
- FFMPEG_THREADS=1, FFMPEG_PRESET=veryfast
- ENQUEUE_THUMBS_LIMIT=2000
- ENQUEUE_HLS_LIMIT=1000
- MAINTENANCE_CRON=0 * * * *（稳定后可改 */30 分钟）

适用：百万级图库初期或低配；先稳运行，观察后再调大。

### B) 4C-8G（中小规模生产）
- PERFORMANCE_MODE=auto
- DISABLE_WATCH=true
- QUEUE_MODE=true
- THUMB_QUEUE_CONCURRENCY=2
- VIDEO_QUEUE_CONCURRENCY=1~2
- SHARP_CACHE_MEMORY_MB=32~64
- SHARP_CACHE_ITEMS=100~200
- FFMPEG_THREADS=1~2
- ENQUEUE_THUMBS_LIMIT=5000
- ENQUEUE_HLS_LIMIT=3000
- MAINTENANCE_CRON=*/30 * * * *

适用：几十万~百万库，处理速度与稳定性平衡。

### C) 8C-16G（中大型生产/独立节点）
- PERFORMANCE_MODE=auto
- DISABLE_WATCH=true
- QUEUE_MODE=true
- THUMB_QUEUE_CONCURRENCY=3~4
- VIDEO_QUEUE_CONCURRENCY=2~3
- SHARP_CACHE_MEMORY_MB=64~128
- SHARP_CACHE_ITEMS=200~400
- FFMPEG_THREADS=2
- ENQUEUE_THUMBS_LIMIT=10000
- ENQUEUE_HLS_LIMIT=5000
- MAINTENANCE_CRON=*/15 * * * *

适用：高并发/高吞吐；按磁盘/网络带宽调整并发，避免 IO 饱和。

### D) 超大库（分布式/多 Worker）
- Web/API 节点：QUEUE_MODE=true、DISABLE_WATCH=true、THUMB/VIDEO 并发较低（仅入队）
- Worker 节点：仅运行队列 Worker（thumb-queue-worker/video-queue-worker），按节点资源水平扩容
- 独立 Redis 集群（队列）与独立 Redis 实例（限流）
- 监控队列长度、入队速率、处理时延；按需横向扩容 Worker 实例

## 调参建议
- 首扫阶段从低配开始：保证稳定与低内存；完成后逐步提升队列并发与 sharp 缓存
- 观察指标：容器内存、CPU、IO 利用率、队列长度、处理速率、失败率
- 出现 OOM/飙高：立刻降低并发与 sharp 缓存，拉长批量限额与维护频率
