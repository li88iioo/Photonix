# Photonix 环境变量配置指南（性能调优版）

本指南与后端代码严格对齐，按"必需/推荐/可选"分级列出变量，并为每个变量提供：
- 作用：变量做什么
- 默认值：代码中的缺省行为
- 取值/格式：允许范围或类型
- 推荐配置方案：基于硬件规格的详细配置建议
- 风险：错误设置的影响
- 代码引用：生效位置，便于排查
- 示例：建议写法

装载方式（重要）：
- 后端未引入 dotenv
  - Docker Compose：使用 env_file: .env 注入（根目录放置 .env）
  - 本机/PM2：以进程环境注入（PowerShell/Bash；或 PM2 ecosystem.config.js 的 env 字段）

性能调优目标：支持50万张图片高效处理，提供从1核1GB到16核16GB的完整配置方案

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

4) LOG_JSON
- 作用：以 JSON 格式输出日志，便于集中式日志/可观测平台采集与分析
- 默认值：false（彩色人类可读格式）
- 取值/格式：true | false
- 推荐修改场景：生产环境接入 Loki/ELK/Datadog 等日志系统
- 风险：开启后本地阅读不友好；建议结合 `X-Trace-Id` 与 `X-Span-Id` 进行查询
- 代码引用：backend/config/logger.js
- 示例：LOG_JSON=true

5) PHOTOS_DIR
- 作用：媒体库根目录（图片/视频）
- 默认值：/app/photos
- 取值/格式：绝对路径（容器内）
- 推荐修改场景：挂载到宿主机（NAS/NFS/本地盘）
- 风险：挂载错误则扫描不到数据；网络盘需配合 WATCH_* 参数
- 代码引用：backend/config/index.js、services/file.service.js、workers/indexing-worker.js
- 示例：PHOTOS_DIR=/app/photos

6) DATA_DIR
- 作用：应用数据目录（数据库/缩略图/HLS 等）
- 默认值：/app/data
- 取值/格式：绝对路径（容器内）
- 推荐修改场景：持久化数据到宿主机卷
- 风险：未持久化会在容器重建后丢数据
- 代码引用：backend/config/index.js、db/*
- 示例：DATA_DIR=/app/data

7) REDIS_URL
- 作用：Redis 连接（缓存/限流/队列/PubSub）
- 默认值：redis://localhost:6379（开发）/ 生产推荐 redis://redis:6379
- 取值/格式：redis://[user:pass@]host:port[/db]
- 推荐修改场景：容器网络或外部 Redis，含密码/ACL
- 风险：错误地址导致限流/缓存/队列/事件全部不可用
- 代码引用：backend/config/index.js、config/redis.js、middleware/rateLimiter.js、services/*、workers/*
- 示例：REDIS_URL=redis://redis:6379

8) JWT_SECRET
- 作用：JWT 签名密钥
- 默认值：无（必须提供）
- 取值/格式：32+ 随机字符串
- 推荐修改场景：生产必须设置强随机
- 风险：弱密钥可被伪造 Token，存在严重安全隐患
- 代码引用：backend/middleware/auth.js、controllers/auth.controller.js
- 示例：JWT_SECRET=g3A4...32plusRandom

9) ADMIN_SECRET
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
- 作用：worker_threads 最大老生代内存（MB），限制单个worker进程的内存使用
- 默认值：512
- 取值/格式：64-2048的整数（MB）
- 推荐配置方案：
  - 1GB系统内存：64-128MB（极度保守，避免系统内存不足）
  - 2GB系统内存：128-256MB（平衡使用）
  - 4GB系统内存：256-512MB（充分利用内存）
  - 8GB+系统内存：512-1024MB（高性能处理）
- 风险：过低易 OOM/任务失败；过高可能超过容器限制或影响其他进程
- 代码引用：backend/services/worker.manager.js（resourceLimits）
- 示例：WORKER_MEMORY_MB=512

2) UV_THREADPOOL_SIZE
- 作用：libuv 线程池大小，影响Sharp图片处理和文件IO操作的并发能力
- 默认值：4
- 取值/格式：1-32的整数（通常不超过CPU核心数）
- 推荐配置方案：
  - 1-2核CPU：1-2（避免线程切换开销）
  - 4核CPU：4（默认值，平衡性能）
  - 8核CPU：6-8（高并发处理）
  - 16核CPU：12-16（最大化利用）
- 风险：盲目上调增加线程切换开销；过低影响Sharp/IO性能
- 代码引用：Node.js 运行时（影响Sharp和fs操作）
- 示例：UV_THREADPOOL_SIZE=4

3) FFMPEG_THREADS
- 作用：FFmpeg视频处理并行线程数，影响视频转码和处理速度
- 默认值：2（生产环境）
- 取值/格式：1-16的整数
- 推荐配置方案：
  - 1-2核CPU：1个（避免CPU过载）
  - 4核CPU：2个（平衡性能，默认值）
  - 8核CPU：4个（高性能处理）
  - 16核CPU：6-8个（最大化利用）
- 风险：过高与其他线程竞争，可能导致系统过载；视频处理对CPU要求较高
- 代码引用：backend/config/index.js、services/adaptive.service.js、workers/video-processor.js
- 示例：FFMPEG_THREADS=2

4) SHARP_CONCURRENCY
- 作用：Sharp图片处理库的并发线程数，影响图片缩略图生成速度
- 默认值：2（生产环境）
- 取值/格式：1-16的整数
- 推荐配置方案：
  - 1-2核CPU：1个（避免CPU过载）
  - 4核CPU：2个（平衡处理，默认值）
  - 8核CPU：4个（高性能处理）
  - 16核CPU：8个（最大化利用）
- 风险：过高导致CPU饱和和内存激增；过低影响图片处理速度
- 代码引用：backend/config/index.js、workers/thumbnail-worker.js、workers/indexing-worker.js
- 示例：SHARP_CONCURRENCY=2

5) SQLITE_BUSY_TIMEOUT
- 作用：SQLite数据库锁等待超时时间，影响并发访问时的等待时间
- 默认值：20000ms（生产环境）
- 取值/格式：1000-60000的整数（毫秒）
- 推荐配置方案：
  - 本地SSD盘：10000-20000ms（默认值）
  - NFS/网络盘：30000-45000ms（增加等待时间）
  - 高并发场景：20000-30000ms（平衡等待和性能）
- 风险：过低易导致数据库锁错误；过高可能导致长时间等待
- 代码引用：backend/db/multi-db.js
- 示例：SQLITE_BUSY_TIMEOUT=20000

6) SQLITE_QUERY_TIMEOUT
- 作用：SQLite查询执行超时时间，防止长时间运行的查询阻塞系统
- 默认值：30000ms（生产环境）
- 取值/格式：5000-120000的整数（毫秒）
- 推荐配置方案：
  - 小型数据库：15000-30000ms（默认值）
  - 大型数据库：45000-60000ms（处理大数据量）
  - 网络存储：60000-90000ms（网络延迟补偿）
- 风险：过低可能中断正常查询；过高可能导致系统响应慢
- 代码引用：backend/db/multi-db.js
- 示例：SQLITE_QUERY_TIMEOUT=30000

7) RATE_LIMIT_WINDOW_MINUTES
- 作用：API请求限流的时间窗口长度，影响允许的请求频率
- 默认值：1分钟
- 取值/格式：1-60的整数（分钟）
- 推荐配置方案：
  - 内部使用：15-30分钟（宽松限制）
  - 对外服务：1-5分钟（严格控制）
  - 高并发场景：1分钟（频繁检查）
- 风险：过短窗口容易误伤正常请求；过长窗口失去保护效果
- 代码引用：backend/middleware/rateLimiter.js
- 示例：RATE_LIMIT_WINDOW_MINUTES=15

8) RATE_LIMIT_MAX_REQUESTS
- 作用：限流时间窗口内允许的最大请求数量
- 默认值：800（生产环境）
- 取值/格式：10-10000的整数
- 推荐配置方案：
  - 小型服务：200-500（轻量保护）
  - 中型服务：500-1000（平衡保护）
  - 大型服务：1000-2000（高并发支持）
  - API服务：100-300（严格限制）
- 风险：过低频繁返回429错误；过高失去DDoS保护
- 代码引用：backend/middleware/rateLimiter.js
- 示例：RATE_LIMIT_MAX_REQUESTS=1000

9) REFRESH_RATE_WINDOW_MS / REFRESH_RATE_MAX
- 作用：刷新令牌限流（窗口毫秒/最大次数）
- 默认值：60000 / 60
- 取值/格式：整数
- 推荐修改场景：大规模登录/刷新
- 风险：过严导致无法刷新 Token
- 代码引用：backend/routes/auth.routes.js
- 示例：REFRESH_RATE_WINDOW_MS=60000
- 示例：REFRESH_RATE_MAX=60

10) AUTH_DEBUG_LOGS
- 作用：显式开启认证模块的详细调试日志（包括 Token/Secret 前缀，仅建议本地排障时短期使用）
- 默认值：未设置（关闭）
- 取值/格式：true | false
- 推荐配置方案：开发环境调试认证问题时临时设为 true；生产环境保持未设置
- 风险：在生产开启将把敏感信息写入日志
- 代码引用：backend/middleware/auth.js
- 示例：AUTH_DEBUG_LOGS=true

11) BROWSE_CACHE_TTL / SEARCH_CACHE_TTL
- 作用：后端 Redis 路由缓存 TTL（秒），分别用于目录浏览与全文搜索接口
- 默认值：180 / 180
- 取值/格式：>=30 的整数秒
- 推荐配置方案：
  - 与前端 Service Worker TTL 保持一致（默认即可）
  - 若需更长缓存命中，可结合前端 TTL 一同上调（例如 300 秒）
  - 若要求实时性（频繁变更内容），可临时下调至 60 秒
- 风险：过大可能在更新后短时间返回旧数据；过小则增加 Redis/后端负载
- 代码引用：backend/routes/browse.routes.js、backend/routes/search.routes.js
- 示例：BROWSE_CACHE_TTL=180
- 示例：SEARCH_CACHE_TTL=180

12) SETTINGS_REDIS_CACHE
- 作用：启用设置项的 Redis 缓存
- 默认值：false
- 取值/格式：true | false
- 推荐修改场景：生产建议开启以降 DB 压力
- 风险：关闭会增加 DB 压力；开启需保证 Redis 可用
- 代码引用：backend/services/settings.service.js
- 示例：SETTINGS_REDIS_CACHE=true

---

### C. 可选（按场景启用）

**安全增强与性能优化参数**

1) MAX_PATH_LENGTH
- 作用：请求路径的最大允许字符数，防止超长路径攻击
- 默认值：1024
- 取值/格式：512-4096的整数（字符）
- 推荐配置方案：
  - 一般场景：1024（默认值，适合大多数文件系统）
  - 深层嵌套目录：2048（处理超深目录结构）
  - 安全加固环境：512（严格限制）
- 风险：设置过小可能拒绝合法的深层路径；过大削弱防护效果
- 代码引用：backend/middleware/pathValidator.js
- 示例：MAX_PATH_LENGTH=1024

2) MAX_PATH_DEPTH
- 作用：路径的最大允许层级深度，防止目录遍历攻击
- 默认值：20
- 取值/格式：5-50的整数（层级）
- 推荐配置方案：
  - 一般场景：20（默认值，适合大多数组织结构）
  - 复杂相册：30-40（支持深层分类）
  - 安全加固环境：10（严格限制）
- 风险：设置过小可能拒绝合法的深层相册；过大削弱防护效果
- 代码引用：backend/middleware/pathValidator.js
- 示例：MAX_PATH_DEPTH=20

3) THUMB_WORKER_MEMORY_MB
- 作用：缩略图Worker的最大内存限制（MB），独立于其他Worker
- 默认值：512
- 取值/格式：256-2048的整数（MB）
- 推荐配置方案：
  - 处理≤1080p图片：256-384MB
  - 处理4K图片（3840×2160）：384-512MB（默认值）
  - 处理8K图片（7680×4320）：512-768MB
  - 处理超高分辨率/RAW：1024-2048MB
- 风险：过低导致大图片OOM失败；过高占用过多系统内存
- 代码引用：backend/services/worker.manager.js
- 示例：THUMB_WORKER_MEMORY_MB=512

4) SHARP_MAX_PIXELS
- 作用：Sharp图像处理库允许的最大像素数，防止超大图片导致OOM
- 默认值：50000000（约7000×7000，5000万像素）
- 取值/格式：10000000-200000000的整数（像素）
- 推荐配置方案：
  - 一般场景：50000000（默认，支持8K图片33M像素）
  - 专业摄影/RAW：100000000-150000000（1亿-1.5亿像素）
  - 极端高分辨率：200000000（2亿像素，需配合THUMB_WORKER_MEMORY_MB≥1024）
- 风险：设置过低拒绝合法大图；过高可能OOM导致Worker崩溃
- 内存估算：像素数 × 4字节 × 2（解码+编码） ≈ 峰值内存
- 代码引用：backend/workers/thumbnail-worker.js
- 示例：SHARP_MAX_PIXELS=50000000

5) THUMB_POOL_MAX
- 作用：缩略图线程池的最大数量，独立于NUM_WORKERS
- 默认值：NUM_WORKERS（继承全局配置）
- 取值/格式：1-32的整数
- 推荐配置方案：
  - 低配环境（≤4核）：2-4
  - 中配环境（8核）：6-8
  - 高配环境（16核）：12-16
  - 超高配环境（32核+）：16-24
- 风险：设置过低无法充分利用CPU；过高导致内存/CPU竞争激烈
- 代码引用：backend/services/adaptive.service.js
- 示例：THUMB_POOL_MAX=8

6) THUMB_TARGET_WIDTH / THUMB_QUALITY_*
- 作用：控制缩略图生成的尺寸与动态质量（基于像素量自动降质以平衡体积与画质）
- 默认值：
  - THUMB_TARGET_WIDTH=500
  - THUMB_PIXEL_THRESHOLD_HIGH=8000000 (800万像素)
  - THUMB_PIXEL_THRESHOLD_MEDIUM=2000000 (200万像素)
  - THUMB_QUALITY_LOW=65 (大图质量)
  - THUMB_QUALITY_MEDIUM=70 (中图质量)
  - THUMB_QUALITY_HIGH=80 (小图质量)
  - THUMB_SAFE_MODE_QUALITY=60 (安全模式质量)
- 取值/格式：整数
- 推荐配置方案：
  - 追求画质：调高 QUALITY_*（如 80/85/90），调大 TARGET_WIDTH（如 800）
  - 追求速度/存储：保持默认或适当降低 QUALITY
  - 移动端优化：TARGET_WIDTH=360 或 480
- 风险：质量过高显著增加缩略图体积与带宽占用；尺寸过大增加生成耗时
- 代码引用：backend/workers/thumbnail-worker.js
- 示例：
  THUMB_TARGET_WIDTH=800
  THUMB_QUALITY_HIGH=85

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

6) AI_*（AI_CACHE_MAX_BYTES / AI_DAILY_LIMIT / AI_PER_IMAGE_COOLDOWN_SEC / AI_ENABLE_VISION_PROBE）
- 作用：AI 缓存与配额/冷却
- 默认值：268435456（生产建议）/ 200 / 60（开发较小）/ false
- 取值/格式：字节数/次数/秒/true|false
- 推荐修改场景：成本/流控管理
- 风险：限制过严导致失败；过宽增加成本；开启视觉探测会额外发送一次轻量请求
- 代码引用：workers/ai-worker.js、middleware/ai-rate-guard.js
- 示例：AI_CACHE_MAX_BYTES=268435456
- 额外说明：`AI_ENABLE_VISION_PROBE=true` 时，未知模型会自动发送一张 1x1 png 进行视觉能力探测，仅在需要时额外消耗极少 token

7) PERFORMANCE_MODE
- 作用：全局性能模式（自适应提示）
- 默认值：auto
- 取值/格式：auto|low|medium|high
- 推荐修改场景：初期大批量导入设为 low
- 风险：高性能模式在低配可能过载
- 代码引用：services/adaptive.service.js
- 示例：PERFORMANCE_MODE=low

8) DETECTED_CPU_COUNT / DETECTED_MEMORY_GB
- 作用：显式指定硬件资源供配置算法参考，当系统自动检测不准确时使用
- 默认值：未设置时自动检测系统硬件
- 取值/格式：CPU_COUNT为1-64整数，MEMORY_GB为1-1024整数
- 推荐配置方案：
  - 容器环境：根据容器限制设置（如Docker --cpus --memory）
  - 虚拟机环境：根据分配的虚拟硬件设置
  - 云服务器：根据实例规格设置
  - 物理机：通常不需要设置，自动检测即可
- 风险：设置过高会高估系统能力导致过载；设置过低会浪费硬件资源
- 代码引用：backend/config/hardware.js、config/runtime.js
- 示例：
  DETECTED_CPU_COUNT=4
  DETECTED_MEMORY_GB=8

9) ENABLE_APP_CSP
- 作用：启用后端层面的 Content-Security-Policy
- 默认值：false
- 取值/格式：true|false
- 推荐修改场景：反代未统一下发 CSP 且需后端控制
- 风险：规则不全会拦截前端资源
- 代码引用：backend/app.js（helmet csp）
- 示例：ENABLE_APP_CSP=true

10) THUMB_ONDEMAND_RESERVE_SLOTS（代码中常量为 ONDEMAND_RESERVE_SLOTS）
- 作用：缩略图按需生成时始终预留的 worker 槽位，防止批量补全占满所有并发导致实时请求卡顿
- 默认值：1（至少保留一个槽位给按需任务；NUM_WORKERS<=1 时自动退化）
- 取值/格式：0-NUM_WORKERS 的整数
- 推荐配置方案：
  - 单用户/离线批处理：0（允许批量占满所有 worker 以尽快完成）
  - 常规 2-4 worker：1（默认值，保证至少 1 并发处理实时缩略图）
  - 8+ worker 高并发：2-3（约 20%-30% 预留给实时流量）
- 风险：值过大拖慢批量补全；值过小（或 0）在首轮 100w+ 扫描时可能影响用户体验
- 代码引用：services/thumbnail.service.js（ONDEMAND_RESERVE_SLOTS 常量）
- 示例：THUMB_ONDEMAND_RESERVE_SLOTS=2

11) THUMB_ONDEMAND_QUEUE_MAX
- 作用：缩略图按需生成队列最大长度
- 默认值：2000
- 取值/格式：>=1 的整数
- 推荐修改场景：内存受限时降低队列长度
- 风险：设置过小影响用户体验，设置过大占用内存
- 代码引用：services/thumbnail.service.js
- 示例：THUMB_ONDEMAND_QUEUE_MAX=2000

12) THUMB_ONDEMAND_IDLE_DESTROY_MS
- 作用：缩略图按需生成worker空闲销毁时间（毫秒）
- 默认值：30000（30秒）
- 取值/格式：毫秒整数
- 推荐修改场景：内存紧张时调小，快速响应时调大
- 风险：过小频繁创建销毁，过大占用内存
- 代码引用：services/thumbnail.service.js
- 示例：THUMB_ONDEMAND_IDLE_DESTROY_MS=30000

- THUMB_BATCH_COOLDOWN_MS
  - 作用：批量补全缩略图时每次派发后的冷却时间（毫秒），用于慢盘/高并发场景抑制数据库和 IO 峰值
  - 默认值：0（关闭冷却）
  - 取值/格式：0-60000 的整数毫秒（建议 0-5000）
  - 推荐修改场景：NFS 或低速存储批量补全时、SQLite 出现 BUSY 锁竞争时
  - 风险：设置过大会拉长补全时间；设置过小无法有效削峰
  - 代码引用：services/thumbnail.service.js
  - 示例：THUMB_BATCH_COOLDOWN_MS=500

- THUMB_TELEMETRY_LOG_INTERVAL_MS
  - 作用：缩略图批量补全的遥测日志最小间隔（毫秒），避免日志刷屏
  - 默认值：15000
  - 取值/格式：>=5000 的整数毫秒
  - 推荐修改场景：需要更频繁或更稀疏的批处理指标日志
  - 风险：过低增加日志量；过高则监控粒度下降
  - 代码引用：services/thumbnail.service.js
  - 示例：THUMB_TELEMETRY_LOG_INTERVAL_MS=20000
- THUMB_QUEUE_DEBUG_INTERVAL_MS
  - 作用：当队列达到上限时，Debug 级别“任务推迟”日志的节流间隔（毫秒），避免 5000+ 条重复日志刷屏
  - 默认值：30000
  - 取值/格式：>=5000 的整数毫秒
  - 推荐修改场景：调试阶段想观察更多样本，可临时调小；生产环境建议保持默认或调大
  - 风险：过小仍可能输出大量日志；过大则只偶尔看到示例
  - 代码引用：services/thumbnail.service.js（THUMB_QUEUE_DEBUG_INTERVAL_MS 常量）
  - 示例：THUMB_QUEUE_DEBUG_INTERVAL_MS=60000

- INDEX_PROGRESS_LOG_STEP
  - 作用：索引重建时“已处理 X 个条目”日志的步长（条目数），降低全量导入时的日志噪声
  - 默认值：5000
  - 取值/格式：>=1000 的整数
  - 推荐修改场景：需要更细/更粗的进度粒度（例如调试单目录时调小）
  - 风险：过小仍会输出大量日志；过大会导致进度反馈不及时
  - 代码引用：workers/indexing-worker.js
  - 示例：INDEX_PROGRESS_LOG_STEP=10000

- INDEX_CACHE_LOG_INTERVAL_MS
  - 作用：索引线程清理本地缓存时的日志节流间隔（毫秒）
  - 默认值：20000
  - 取值/格式：>=1000 的整数毫秒
  - 推荐修改场景：想更频繁地观察缓存命中/清理，或希望进一步降低日志噪声
  - 风险：过小会刷屏；过大会导致看不到缓存清理日志
  - 代码引用：workers/indexing-worker.js
  - 示例：INDEX_CACHE_LOG_INTERVAL_MS=60000

13) THUMB_IDLE_SHUTDOWN_MS
- 作用：缩略图worker空闲自动关闭时间（毫秒）
- 默认值：600000（10分钟）
- 取值/格式：毫秒整数
- 推荐修改场景：长期运行时适当调小节省资源
- 风险：过小频繁重启影响性能
- 代码引用：services/worker.manager.js
- 示例：THUMB_IDLE_SHUTDOWN_MS=600000

14) THUMB_CHECK_INTERVAL_MS
- 作用：缩略图worker状态检查间隔（毫秒）
- 默认值：60000（1分钟）
- 取值/格式：毫秒整数
- 推荐修改场景：调试worker状态时调小
- 风险：过小增加CPU开销
- 代码引用：services/worker.manager.js
- 示例：THUMB_CHECK_INTERVAL_MS=60000

15) API_BASE
- 作用：API 基础 URL（为空使用相对路径）
- 默认值：空字符串
- 取值/格式：URL 前缀
- 推荐修改场景：前后端分离或反代前缀
- 风险：错误前缀导致 404
- 代码引用：backend/config/index.js
- 示例：API_BASE=/api

16) ENABLE_REDIS
- 作用：是否启用Redis连接（显式开关）
- 默认值：false
- 取值/格式：true | false
- 推荐修改场景：需要Redis功能时启用
- 风险：未启用时Redis相关功能自动降级为本地No-Op
- 代码引用：backend/config/redis.js
- 示例：ENABLE_REDIS=true

17) RATE_LIMIT_USE_REDIS
- 作用：是否使用Redis进行API速率限制
- 默认值：false
- 取值/格式：true | false
- 推荐修改场景：多实例部署时启用共享限流
- 风险：启用时Redis不可用会导致限流失效
- 代码引用：backend/middleware/rateLimiter.js
- 示例：RATE_LIMIT_USE_REDIS=true
- 关联参数：
  - RATE_LIMIT_REDIS_WAIT_MS（默认5000）：限流中间件在启动时等待 Redis 就绪的最大时长（毫秒），避免因握手延迟而降级到内存模式。超时仍会自动回退。
  - RATE_LIMIT_REDIS_POLL_INTERVAL_MS（默认200）：等待窗口内的检查间隔（毫秒）。增大可降低启动期间的 Redis 压力，减小可加快检测响应。

18) METRICS_TOKEN
- 作用：访问metrics端点的认证令牌
- 默认值：空字符串（无认证）
- 取值/格式：任意字符串
- 推荐修改场景：生产环境启用metrics监控
- 风险：空值时metrics端点公开访问
- 代码引用：backend/routes/metrics.routes.js
- 示例：METRICS_TOKEN=secure_metrics_token

19) HEAVY_CACHE_TTL_MS
- 作用：重型缓存TTL时间（毫秒）
- 默认值：3000（3秒）
- 取值/格式：毫秒整数
- 推荐修改场景：调整缓存过期时间
- 风险：过小增加计算开销，过大缓存失效慢
- 代码引用：backend/services/orchestrator.js
- 示例：HEAVY_CACHE_TTL_MS=3000

20) EVENT_LOOP_SAMPLE_INTERVAL
- 作用：事件循环延迟采样间隔（毫秒）
- 默认值：1000（1秒）
- 取值/格式：毫秒整数
- 推荐修改场景：性能监控调优
- 风险：过小影响性能监控精度
- 代码引用：backend/services/orchestrator.js
- 示例：EVENT_LOOP_SAMPLE_INTERVAL=1000

21) DB_MAINT_INTERVAL_MS
- 作用：数据库维护任务执行间隔（毫秒）
- 默认值：86400000（1天）
- 取值/格式：毫秒整数
- 推荐修改场景：调整数据库维护频率
- 风险：过小增加维护开销
- 代码引用：backend/services/orchestrator.js
- 示例：DB_MAINT_INTERVAL_MS=86400000

22) DB_MAINT_RETRY_MS
- 作用：数据库维护任务重试间隔（毫秒）
- 默认值：21600000（6小时）
- 取值/格式：毫秒整数
- 推荐修改场景：维护任务失败时的重试频率
- 风险：过小频繁重试影响性能
- 代码引用：backend/services/orchestrator.js
- 示例：DB_MAINT_RETRY_MS=21600000

23) DB_MAINT_TIMEOUT_MS
- 作用：数据库维护任务超时时间（毫秒）
- 默认值：600000（10分钟）
- 取值/格式：毫秒整数
- 推荐修改场景：大型数据库的维护超时设置
- 风险：过小可能导致维护任务被取消
- 代码引用：backend/services/orchestrator.js
- 示例：DB_MAINT_TIMEOUT_MS=600000

- SQLITE_BUSY_LOG_THRESHOLD / SQLITE_TIMEOUT_LOG_THRESHOLD / SQLITE_TELEMETRY_INTERVAL_MS
  - 作用：控制 SQLite 忙重试与超时的遥测日志频率
  - 默认值：10 / 5 / 30000
  - 取值/格式：阈值为 >=1 的整数；间隔为 >=5000 的毫秒整数
  - 推荐：在排障阶段可降低阈值或缩短间隔以更快捕捉问题；生产环境保持默认即可
  - 风险：阈值过低或间隔过短可能导致日志量增加
  - 引用：backend/db/multi-db.js（telemetry & counters）

**Orchestrator 锁控制（Redis 关闭时适用）**
- LOCK_FALLBACK_STRATEGY
  - 作用：当 Redis 不可用且 `.locks` 目录无法写入时的处理策略
  - 默认值：warn（记录警告并退化为进程内锁）
  - 取值/格式：warn | error
  - 推荐：生产环境若需严格保障互斥，可设为 error 直接阻止启动
  - 影响：warn 将继续运行但只能使用进程内锁；error 会抛出异常并终止
  - 引用：backend/services/orchestrator.js
- EXPECTED_INSTANCE_COUNT & LOCK_ABORT_ON_MULTI_INSTANCE
  - 作用：在未启用 Redis 的情况下提示或阻止多实例同时运行
  - 默认值：未设置 / false
  - 推荐：多实例部署但临时关闭 Redis 时，设置 EXPECTED_INSTANCE_COUNT 并将 LOCK_ABORT_ON_MULTI_INSTANCE=true 以防任务重复
  - 引用：backend/services/orchestrator.js
- INSTANCE_TOKEN
  - 作用：自定义锁文件写入的实例标识，便于诊断
  - 默认值：HOSTNAME 或进程号
  - 推荐：多实例排障时显式设置（例如 `INSTANCE_TOKEN=node-a`）
  - 引用：backend/services/orchestrator.js

24) WATCH_CUSTOM_IGNORES
- 作用：文件监听自定义忽略模式
- 默认值：空字符串
- 取值/格式：glob模式字符串
- 推荐修改场景：排除特定文件类型或目录
- 风险：配置错误可能导致重要文件不被监听
- 代码引用：backend/services/indexer.service.js
- 示例：WATCH_CUSTOM_IGNORES=**/*.tmp,**/*.log

25) WATCH_STABILITY_THRESHOLD
- 作用：文件变更稳定性阈值（毫秒）
- 默认值：2000（2秒）
- 取值/格式：毫秒整数
- 推荐修改场景：调整文件变更检测灵敏度
- 风险：过小误报频繁变更，过大延迟变更检测
- 代码引用：backend/services/indexer.service.js
- 示例：WATCH_STABILITY_THRESHOLD=2000

26) WATCHER_IDLE_STOP_MS
- 作用：文件监听器空闲停止时间（毫秒）
- 默认值：120000（2分钟）
- 取值/格式：毫秒整数
- 推荐修改场景：调整监听器资源回收频率
- 风险：过小频繁停止重启，过大占用资源
- 代码引用：backend/services/indexer.service.js
- 示例：WATCHER_IDLE_STOP_MS=120000

27) DIMENSION_CACHE_TTL
- 作用：图片尺寸信息缓存TTL（秒）
- 默认值：2592000（30天）
- 取值/格式：秒整数
- 推荐修改场景：调整图片尺寸缓存过期时间
- 风险：过小增加重复计算，过大占用缓存空间
- 代码引用：backend/services/file.service.js
- 示例：DIMENSION_CACHE_TTL=2592000

28) FILE_CACHE_DURATION
- 作用：文件缓存持续时间（秒）
- 默认值：604800（7天）
- 取值/格式：秒整数
- 推荐修改场景：调整文件缓存过期时间
- 风险：过小增加文件读取，过大占用磁盘空间
- 代码引用：backend/services/file.service.js
- 示例：FILE_CACHE_DURATION=604800

29) CACHE_CLEANUP_DAYS
- 作用：缓存清理天数阈值
- 默认值：1（天）
- 取值/格式：天数整数
- 推荐修改场景：调整缓存清理频率
- 风险：过小频繁清理，过大占用空间
- 代码引用：backend/services/file.service.js
- 示例：CACHE_CLEANUP_DAYS=1

30) BATCH_LOG_FLUSH_INTERVAL
- 作用：批量日志刷新间隔（毫秒）
- 默认值：5000（5秒）
- 取值/格式：毫秒整数
- 推荐修改场景：调整日志批量处理频率
- 风险：过小增加I/O开销，过大日志延迟
- 代码引用：backend/services/file.service.js
- 示例：BATCH_LOG_FLUSH_INTERVAL=5000

31) FILE_BATCH_SIZE
- 作用：文件处理批量大小
- 默认值：200
- 取值/格式：>=1 的整数
- 推荐修改场景：调整批量文件处理效率
- 风险：过小处理慢，过大占用内存
- 代码引用：backend/services/file.service.js
- 示例：FILE_BATCH_SIZE=200

32) DIM_BACKFILL_BATCH
- 作用：图片尺寸回填批量大小
- 默认值：500
- 取值/格式：>=1 的整数
- 推荐修改场景：调整数据库迁移效率
- 风险：过小迁移慢，过大数据库压力大
- 代码引用：backend/workers/indexing-worker.js
- 示例：DIM_BACKFILL_BATCH=500

33) DIM_BACKFILL_SLEEP_MS
- 作用：图片尺寸回填休眠时间（毫秒）
- 默认值：200
- 取值/格式：毫秒整数
- 推荐修改场景：调整数据库迁移压力
- 风险：过小压力大，过大迁移慢
- 代码引用：backend/workers/indexing-worker.js
- 示例：DIM_BACKFILL_SLEEP_MS=200

34) MTIME_BACKFILL_BATCH
- 作用：修改时间回填批量大小
- 默认值：500
- 取值/格式：>=1 的整数
- 推荐修改场景：调整数据库迁移效率
- 风险：过小迁移慢，过大数据库压力大
- 代码引用：backend/workers/indexing-worker.js
- 示例：MTIME_BACKFILL_BATCH=500

35) MTIME_BACKFILL_SLEEP_MS
- 作用：修改时间回填休眠时间（毫秒）
- 默认值：200
- 取值/格式：毫秒整数
- 推荐修改场景：调整数据库迁移压力
- 风险：过小压力大，过大迁移慢
- 代码引用：backend/workers/indexing-worker.js
- 示例：MTIME_BACKFILL_SLEEP_MS=200

36) HLS_BATCH_TIMEOUT_MS
- 作用：HLS批量处理超时时间（毫秒）
- 默认值：600000（10分钟）
- 取值/格式：毫秒整数
- 推荐修改场景：调整视频处理超时
- 风险：过小视频处理失败，过大占用资源
- 代码引用：backend/services/video.service.js
- 示例：HLS_BATCH_TIMEOUT_MS=600000

37) DISABLE_STARTUP_INDEX
- 作用：是否禁用启动时索引
- 默认值：false
- 取值/格式：true | false
- 推荐修改场景：启动时间优化或调试
- 风险：禁用后需手动触发索引
- 代码引用：backend/server.js
- 示例：DISABLE_STARTUP_INDEX=false

38) INDEX_START_DELAY_MS
- 作用：索引启动延迟时间（毫秒）
- 默认值：5000（5秒）
- 取值/格式：毫秒整数
- 推荐修改场景：调整启动顺序
- 风险：过小可能与其他初始化冲突
- 代码引用：backend/server.js
- 示例：INDEX_START_DELAY_MS=5000

39) INDEX_RETRY_INTERVAL_MS
- 作用：索引重试间隔（毫秒）
- 默认值：60000（1分钟）
- 取值/格式：毫秒整数
- 推荐修改场景：调整索引失败重试频率
- 风险：过小频繁重试，过大恢复慢
- 代码引用：backend/server.js
- 示例：INDEX_RETRY_INTERVAL_MS=60000

40) INDEX_TIMEOUT_MS
- 作用：索引超时时间（毫秒）
- 默认值：timeUtils.minutes(20)（20分钟）
- 取值/格式：毫秒整数
- 推荐修改场景：大型相册的索引超时设置
- 风险：过小索引中断，过大占用资源
- 代码引用：backend/server.js
- 示例：INDEX_TIMEOUT_MS=1200000

41) INDEX_LOCK_TTL_SEC
- 作用：索引锁TTL时间（秒）
- 默认值：7200（2小时）
- 取值/格式：秒整数
- 推荐修改场景：调整索引并发控制
- 风险：过小锁竞争激烈，过大锁占用时间长
- 代码引用：backend/server.js
- 示例：INDEX_LOCK_TTL_SEC=7200
- 关联参数：
  - INDEX_WORKER_REDIS_WAIT_MS（默认5000）：索引工作线程在初始化尺寸缓存时等待 Redis 就绪的最大时长（毫秒），防止因握手延迟退化为本地缓存。
  - INDEX_WORKER_REDIS_POLL_INTERVAL_MS（默认200）：等待期间的轮询间隔（毫秒），根据 Redis 启动速度和资源情况调节。

12) NUM_WORKERS
- 作用：缩略图处理worker进程数量，影响并发处理能力
- 默认值：根据CPU和内存自动计算（2-12个）
- 取值/格式：1-64的整数
- 推荐配置方案：
  - 1核1GB：1个（极度保守，适合测试环境）
  - 2核2GB：2个（基础使用，平衡性能）
  - 4核4GB：3-4个（充分利用CPU，适合家庭使用）
  - 8核8GB：6-8个（高性能，适合小企业）
  - 16核16GB+：12-16个（最大化利用，适合企业）
- 风险：过少处理慢；过多占用内存和CPU
- 代码引用：backend/config/runtime.js、services/worker.manager.js、services/thumbnail.service.js
- 示例：NUM_WORKERS=4

13) INDEX_BATCH_SIZE
- 作用：索引处理时每批处理的项目数量，影响内存使用和处理效率
- 默认值：1000
- 取值/格式：100-10000的整数
- 推荐配置方案：
  - 1GB内存：100-300（极度保守，避免内存溢出）
  - 2GB内存：300-600（平衡内存和性能）
  - 4GB内存：600-1000（充分利用内存）
  - 8GB内存：1000-2000（高性能处理）
  - 16GB+内存：2000-5000（最大化效率）
- 风险：过小处理慢；过大内存溢出
- 代码引用：backend/config/runtime.js、workers/indexing-worker.js
- 示例：INDEX_BATCH_SIZE=1000

14) INDEX_CONCURRENCY
- 作用：索引处理的并发线程数，影响索引构建速度
- 默认值：8
- 取值/格式：1-32的整数
- 推荐配置方案：
  - 1-2核CPU：1-2（避免资源竞争）
  - 4核CPU：3-4（充分利用CPU）
  - 8核CPU：6-8（高并发处理）
  - 16核CPU：12-16（最大化并发）
- 风险：过高导致数据库锁竞争；过低处理慢
- 代码引用：backend/config/runtime.js、workers/indexing-worker.js
- 示例：INDEX_CONCURRENCY=8

15) SHARP_CONCURRENCY
- 作用：Sharp图片处理库的并发线程数，影响图片处理速度
- 默认值：2
- 取值/格式：1-16的整数
- 推荐配置方案：
  - 1-2核CPU：1个（避免CPU过载）
  - 4核CPU：2个（平衡处理）
  - 8核CPU：4个（高性能处理）
  - 16核CPU：8个（最大化利用）
- 风险：过高CPU使用率过高；过低处理慢
- 代码引用：backend/config/runtime.js、workers/indexing-worker.js、workers/thumbnail-worker.js
- 示例：SHARP_CONCURRENCY=2

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

# 安全限制（防止超长路径攻击）
MAX_PATH_LENGTH=1024
MAX_PATH_DEPTH=20

# 内存优化（1G环境关键）
WORKER_MEMORY_MB=256
THUMB_WORKER_MEMORY_MB=256
UV_THREADPOOL_SIZE=2
FFMPEG_THREADS=1
SHARP_CONCURRENCY=1

# Sharp像素限制（低配环境降低）
SHARP_MAX_PIXELS=30000000

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

# AI限制（可选，低配环境建议限制）
AI_DAILY_LIMIT=50
AI_PER_IMAGE_COOLDOWN_SEC=120

# 缩略图优化
THUMB_ONDEMAND_RESERVE_SLOTS=1
THUMB_POOL_MAX=1

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

```

中型生产（4C/8G）
```
#安全限制（默认值，适合大多数场景）
MAX_PATH_LENGTH=1024
MAX_PATH_DEPTH=20

# 内存与性能优化
WORKER_MEMORY_MB=512
THUMB_WORKER_MEMORY_MB=512
UV_THREADPOOL_SIZE=4
FFMPEG_THREADS=2
SHARP_CONCURRENCY=2

# Sharp像素限制（支持8K图片）
SHARP_MAX_PIXELS=50000000

# 并发优化
THUMB_POOL_MAX=6

# 限流与缓存
RATE_LIMIT_WINDOW_MINUTES=15
RATE_LIMIT_MAX_REQUESTS=100
SETTINGS_REDIS_CACHE=true
```

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
- [ ] 安全参数已配置（MAX_PATH_LENGTH=1024, MAX_PATH_DEPTH=20）
- [ ] Worker内存根据图片分辨率配置（THUMB_WORKER_MEMORY_MB，处理8K图建议≥512MB）
- [ ] Sharp像素限制符合业务需求（SHARP_MAX_PIXELS，默认50M像素支持8K）
- [ ] 限流策略符合预期（RATE_LIMIT_* / REFRESH_RATE_*）
- [ ] 首日观察 CPU/内存/IO，按需微调 SHARP_CONCURRENCY / FFMPEG_THREADS / UV_THREADPOOL_SIZE
- [ ] （可选）SETTINGS_REDIS_CACHE=true 降低 DB 压力
- [ ] （可选）根据反代策略评估 ENABLE_APP_CSP
- [ ] （可选）根据CPU核心数配置 THUMB_POOL_MAX 以充分利用资源

---

## 6) 故障排查

通用问题：
- 401/无法登录：检查 JWT_SECRET/ADMIN_SECRET 注入
- Redis 连接失败：确认 REDIS_URL 与容器网络/密码
- 访问慢/超时：增大 SQLITE_* 超时，降低 SHARP_CONCURRENCY/FFMPEG_THREADS
## 7) 性能调优配置表

基于50万张图片处理目标的推荐配置：

| 硬件规格 | NUM_WORKERS | INDEX_BATCH_SIZE | INDEX_CONCURRENCY | SHARP_CONCURRENCY | WORKER_MEMORY_MB | 预期处理时间 |
|---------|-------------|------------------|-------------------|-------------------|------------------|-------------|
| 1核1GB | 1 | 300 | 1 | 1 | 128 | ~30分钟 |
| 2核2GB | 2 | 600 | 2 | 1 | 256 | ~15分钟 |
| 4核4GB | 4 | 1000 | 3 | 2 | 384 | ~8分钟 |
| 8核8GB | 6 | 1500 | 6 | 4 | 512 | ~4分钟 |
| 16核16GB | 12 | 2000 | 12 | 8 | 768 | ~2分钟 |

**配置原则：**
- Worker数量 ≈ CPU核心数 × 0.75（留余量）
- 批次大小 ≈ 内存/并发数 × 调整因子
- 并发数 ≤ CPU核心数（避免过度竞争）
- 内存限制 ≈ 系统内存/Worker数

---

## 8) 配置优化建议

### 渐进式调优流程：
1. **基础配置**：根据硬件规格选择推荐配置
2. **启动测试**：观察系统启动和基本功能
3. **负载测试**：模拟实际使用场景
4. **性能监控**：收集 CPU/内存/IO 指标
5. **参数调整**：根据监控数据优化配置
6. **长期观察**：根据使用模式持续调整

### 监控关键指标：
- 系统 CPU 使用率（目标：50-80%）
- 系统内存使用率（目标：60-80%）
- 数据库查询响应时间（目标：<500ms）
- 图片处理队列长度（目标：<100）
- API 响应时间（目标：<200ms）

### 常见优化场景：
- **处理速度慢**：增加 NUM_WORKERS、INDEX_BATCH_SIZE、SHARP_CONCURRENCY
- **内存使用高**：降低 INDEX_BATCH_SIZE、WORKER_MEMORY_MB
- **CPU 使用高**：降低 SHARP_CONCURRENCY、UV_THREADPOOL_SIZE
- **数据库锁竞争**：增加 SQLITE_BUSY_TIMEOUT，降低 INDEX_CONCURRENCY

### 高级调优技巧：
- **内存紧张环境**：优先降低 INDEX_BATCH_SIZE，使用更保守的 WORKER_MEMORY_MB
- **CPU 密集环境**：可以适当增加 SHARP_CONCURRENCY，但要注意内存使用
- **网络存储环境**：增加所有 SQLITE_* 超时参数，避免网络延迟导致的失败
- **高并发环境**：适当增加 RATE_LIMIT_* 参数，但要注意系统资源消耗
