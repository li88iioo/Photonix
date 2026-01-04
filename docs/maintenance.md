# 运维与更新指南

## 🔄 版本更新

### 标准升级流程 (Docker)
1. **停止服务**：`docker compose down`
2. **拉取代码**：`git pull origin main`
3. **拉取镜像**：`docker compose pull` (如果是使用 GHCR 镜像)
4. **启动服务**：`docker compose up -d`
5. **清理冗余**：`docker image prune` (释放磁盘空间)

---

## 📈 性能优化建议

### 1. 系统级优化 (System Level)
- **内存配置**：建议配置 **4GB+** 物理内存。在大规模相册（万级以上）索引与 AI 处理并发时，充足的内存可显著提升系统响应速度。
- **存储优化**：强烈建议将 `data/` 目录存放在 **SSD (固态硬盘)**上。数据库 I/O 性能是影响搜索响应和索引速度的核心瓶颈。
- **网络优化**：建议在**千兆 (Gigabit)** 网络环境下运行。在浏览原图或进行视频流传输时，网络带宽将直接影响加载体验。
- **CPU 配置**：建议 **2 核+** CPU。Photonix 支持并行处理，且具备硬件自适应调整能力，更多的核心能显著加快缩略图压制与 AI 处理。

### 2. 应用级优化 (Application Level)
- **动态工作线程**：系统默认会自动检测 CPU 核心数并动态调整 `NUM_WORKERS`。在低配机器上，可手动减小该值以换取稳定性。
- **缓存策略**：合理配置 Redis 内存上限（建议 256MB+）。Photonix 采用标签化 (Tagging) 缓存清理机制，Redis 的命中率直接决定了二次加载的速度。
- **索引调度**：对于超大相册的首次全量索引，建议在业务低峰期进行。
- **限流与重试**：AI 服务采用内存微服务排队策略；下载任务通过 `TaskScheduler` 自动实施限流与重试，无需人工干预。

### 3. Docker 级优化 (Docker Level)
- **资源限制**：可在 `docker-compose.yml` 中为 `app` 服务设置 `deploy.resources.limits`，防止极端情况下导致宿主机死机。
- **卷挂载 (Volumes)**：务必使用宿主机目录挂载而非 Docker Volume，以获得更佳的磁盘 I/O 性能。
- **网络模式**：在对延迟极度敏感的环境下，可考虑使用 `network_mode: host` 以消除 Docker 网络桥接带来的微小开销（可选）。

---

## 💾 备份策略

### 核心数据清单
必须定期备份以下目录/文件：
1. **`.env`**：包含所有密钥与核心配置。
2. **`data/` 目录**：包含所有 SQLite 数据库（`gallery.db`, `settings.db`, `index.db`）。
3. **`data/thumbs/`**：缩略图目录（可选，丢失后可重新生成，但非常耗时）。

### 自动备份建议
建议使用 Cron 定期执行以下脚本：
```bash
#!/bin/bash
BACKUP_DIR="/path/to/backups/$(date +%Y%m%d)"
mkdir -p $BACKUP_DIR
cp /opt/photonix/.env $BACKUP_DIR/
docker exec photonix_db_container sqlite3 /app/data/gallery.db ".backup '/backup/gallery.db'"
# ...以此类推
```

---

## 🛠️ 常用维护命令

### 手动数据库完整性检查
```bash
docker exec -it photonix_app node backend/db/check-integrity.js
```

### 强制清理临时文件
如果视频转码意外中断导致磁盘占用高：
- 访问：管理员面板 -> 系统维护 -> 清理临时目录。
- 功能会遍历 `PHOTOS_DIR` 下所有 `.tmp` 目录并将其清空。

### 状态导出
- **OPML 导出**：备份您的所有图库订阅源。
- **AI 对话导出**：前端设置面板支持将 IndexedDB 中的对话历史导出为 JSON。
