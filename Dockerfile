# --- 阶段 1: 构建前端静态资源 ---
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

# 复制前端的 package 文件并安装依赖（包含 devDependencies 以便构建）
COPY frontend/package*.json ./
# 国内 npm 镜像（可加速国内构建）
RUN npm config set registry https://registry.npmmirror.com
RUN npm install

# 复制前端源码并构建
COPY frontend/ .
RUN npm run build


# --- 阶段 2: 构建后端生产依赖 ---
FROM node:20-alpine AS backend-builder

WORKDIR /app/backend

# 构建原生模块所需依赖（切换为国内 Alpine 源以加速）
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories && \
    apk add --no-cache build-base python3 py3-setuptools vips-dev

# 复制后端 package 文件并安装生产依赖
COPY backend/package*.json ./
# 国内 npm 镜像（可加速国内构建）
RUN npm config set registry https://registry.npmmirror.com
# 优先使用 npm ci（锁定安装），若锁文件未同步则回退到 npm install
RUN npm ci --omit=dev --build-from-source || npm install --omit=dev --build-from-source


# --- 阶段 3: 最终生产镜像（All-in-One） ---
FROM node:20-alpine

WORKDIR /app

# 安装 pm2 以及运行时依赖（切换为国内 Alpine 源以加速）
# 清华大学: mirrors.tuna.tsinghua.edu.cn
# 阿里云: mirrors.aliyun.com
RUN npm config set registry https://registry.npmmirror.com && \
    npm install -g pm2 && \
    sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories && \
    apk add --no-cache gosu ffmpeg vips dcron

# 拷贝后端依赖
COPY --from=backend-builder /app/backend/node_modules ./backend/node_modules

# 拷贝后端源码
COPY backend/ ./backend/

# 拷贝前端构建产物到后端可服务的 public 目录
COPY --from=frontend-builder /app/frontend/index.html ./backend/public/
COPY --from=frontend-builder /app/frontend/output.css ./backend/public/
COPY --from=frontend-builder /app/frontend/manifest.json ./backend/public/
COPY --from=frontend-builder /app/frontend/sw.js ./backend/public/

COPY --from=frontend-builder /app/frontend/js/dist/ ./backend/public/js/dist/
COPY --from=frontend-builder /app/frontend/assets/ ./backend/public/assets/

# 复制并设置入口点脚本
COPY backend/entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && \
    chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# 暴露应用端口
EXPOSE 13001

# 由 entrypoint.sh 使用 pm2-runtime 启动，一般无需 CMD
# CMD [ "node", "backend/server.js" ]


