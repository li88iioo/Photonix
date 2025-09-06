# Photonix 环境变量速查（简版）

适用：快速上线/最小配置。完整说明见 ENV_GUIDE.md（精注释版）。

装载方式
- Docker Compose：根目录创建 .env（可由 env.production 拷贝），docker-compose.yml 已引用 env_file: .env
- 本机/PM2：以进程环境注入（PowerShell/Bash 或 PM2 ecosystem.config.js 的 env），项目未使用 dotenv

一、90 秒上线步骤
1) cp env.production .env
2) 必改：JWT_SECRET（32+ 随机）、ADMIN_SECRET（强口令）
3) 如 Redis 不在 compose 内，改 REDIS_URL
4) docker compose up -d
健康检查：http://<host>:<port>/health 返回 200

二、最小必配清单（仅 8 项）
PORT=13001                 # 监听端口（compose 默认通过 APP_PORT 暴露为 12080）
NODE_ENV=production        # 运行模式
LOG_LEVEL=info             # 日志：error|warn|info|debug
PHOTOS_DIR=/app/photos     # 媒体库目录（容器内路径，需挂载）
DATA_DIR=/app/data         # 数据目录（DB/缩略图/HLS，需挂载）
REDIS_URL=redis://redis:6379   # 开发可用 redis://localhost:6379
JWT_SECRET=<32+随机>       # JWT 签名密钥（必须强随机）
ADMIN_SECRET=<强口令>      # 管理口令（必须修改默认）

三、推荐显式（常用 6 项）
WORKER_MEMORY_MB=512       # worker 内存上限（MB）
FFMPEG_THREADS=2           # FFmpeg 线程
SHARP_CONCURRENCY=2        # Sharp 并发
SQLITE_BUSY_TIMEOUT=20000  # SQLite 忙等待（ms）
SQLITE_QUERY_TIMEOUT=30000 # SQLite 查询超时（ms）
RATE_LIMIT_WINDOW_MINUTES=15
RATE_LIMIT_MAX_REQUESTS=100

四、生产模板（可直接复制到 .env 并修改密钥）
PORT=13001
NODE_ENV=production
LOG_LEVEL=info
PHOTOS_DIR=/app/photos
DATA_DIR=/app/data
REDIS_URL=redis://redis:6379
JWT_SECRET=PLEASE_REPLACE_WITH_32_PLUS_RANDOM_SECRET
ADMIN_SECRET=PLEASE_REPLACE_WITH_STRONG_ADMIN_PASSWORD
WORKER_MEMORY_MB=512
FFMPEG_THREADS=2
SHARP_CONCURRENCY=2
SQLITE_BUSY_TIMEOUT=20000
SQLITE_QUERY_TIMEOUT=30000
RATE_LIMIT_WINDOW_MINUTES=15
RATE_LIMIT_MAX_REQUESTS=100

五、开发模板（本机/轻量）
PORT=13001
NODE_ENV=development
LOG_LEVEL=debug
PHOTOS_DIR=/app/photos
DATA_DIR=/app/data
REDIS_URL=redis://localhost:6379
JWT_SECRET=development-jwt-secret-key-32chars
ADMIN_SECRET=admin
WORKER_MEMORY_MB=256
FFMPEG_THREADS=1
SHARP_CONCURRENCY=1
SQLITE_BUSY_TIMEOUT=10000
SQLITE_QUERY_TIMEOUT=15000
RATE_LIMIT_WINDOW_MINUTES=1
RATE_LIMIT_MAX_REQUESTS=1000

六、常见问题速排
- 401/无法登录：检查 JWT_SECRET/ADMIN_SECRET 是否已注入
- Redis 连接失败：检查 REDIS_URL 与容器网络/端口
- 访问慢/超时：增大 SQLITE_*；下调 SHARP_CONCURRENCY/FFMPEG_THREADS
- 大相册/网络盘：按需启用 WATCH_* 轮询（详见 ENV_GUIDE.md）