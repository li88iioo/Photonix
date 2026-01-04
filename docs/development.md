# 本地开发环境搭建

如果您希望手动运行 Photonix 而非使用 Docker，请参考以下步骤配置您的本地开发环境。

## 📋 前置需求

### 运行环境
- **Node.js**: v20.0.0 或更高版本。
- **Redis**: v6.0+ (用于服务端限流与缓存)。
- **FFmpeg**: 系统需安装 `ffmpeg` (且必须包含在系统 PATH 中)，用于视频转码与截帧。

### 外部服务 (可选)
- **OneAPI / OpenAI**: 如果需要 AI 识图功能，请准备相关的 API 密钥。

---

## 🛠️ 安装步骤

### 1. 克隆代码
```bash
git clone https://github.com/li88iioo/Photonix.git
cd Photonix
```

### 2. 安装依赖
```bash
# 安装后端依赖
cd backend && npm install

# 安装前端依赖 (Tailwind 构建)
cd ../frontend && npm install
```

### 3. 前端构建与联调 (关键步骤)
由于后端服务默认从 `backend/public` 目录读取静态资源，您需要先构建前端产生这些文件：

```bash
cd frontend
npm run build
```

**本地联调方案 (二选一)：**

- **方案 A (推荐 - 软链接)**：在 `backend` 目录下创建一个指向前端产物的符号链接，实现实时同步。
  ```bash
  cd backend
  mkdir -p public/js
  ln -s ../../frontend/index.html public/index.html
  ln -s ../../frontend/assets public/assets
  ln -s ../../frontend/js/dist public/js/dist
  ```
- **方案 B (手动拷贝)**：按照 Dockerfile 的逻辑手动拷贝。
  ```bash
  mkdir -p backend/public/js/dist
  cp frontend/index.html backend/public/
  cp -r frontend/assets backend/public/
  cp -r frontend/js/dist/* backend/public/js/dist/
  ```

### 4. 配置环境变量
将 `.env.example` 复制为 `.env` 并填写必要信息：
```bash
cp .env.example .env
# 编辑 .env，确保设置了 JWT_SECRET 和 PHOTOS_DIR
```

### 4. 启动后端服务
```bash
cd backend
npm run dev
```

### 5. 启动前端构建 (开发模式)
```bash
cd frontend
npm run dev
```

---

## 💡 开发提示

- **数据库位置**：在本地运行模式下，SQLite 数据库文件将默认创建在 `backend/data/` 目录中。
- **日志级别**：可在 `.env` 中设置 `LOG_LEVEL=debug` 以获取更详细的调试信息。
- **端口映射**：默认 Web 端口为 `12080`，如果该端口冲突，请修改配置文件。

## 🧪 建议测试工具
- **Postman / Insomnia**：用于测试 RESTful API。
- **Redis Desktop Manager**：监控缓存与频率限制状态。
