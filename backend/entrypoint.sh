#!/bin/sh
#
# 这个脚本会在容器启动时，以 root 权限运行，
# 在 Node.js 应用启动前，确保所有权和目录结构正确。

# 设置 -e 选项，如果任何命令失败，脚本将立即退出
set -e

echo "🚀 容器启动脚本开始执行..."

# 确保 /app/data 目录存在
mkdir -p /app/data/thumbnails

# 强制将 /app/data 目录的所有权递归地更改为 node 用户和 node 用户组。
# 解决权限问题的核心步骤。
echo "📁 正在配置数据目录权限..."
chown -R node:node /app/data

# 先确保后端依赖就绪（自愈：若缺失则自动安装）
if [ ! -f "/app/backend/node_modules/express/package.json" ] || [ ! -f "/app/backend/node_modules/sqlite3/package.json" ] || [ ! -f "/app/backend/node_modules/bullmq/package.json" ]; then
  echo "📦 检测到依赖缺失，正在安装后端依赖（使用国内镜像）..."
  cd /app/backend
  npm config set registry https://registry.npmmirror.com
  # 优先使用预编译二进制，避免在运行镜像内编译（缺少 build-base）
  npm ci --omit=dev || npm install --omit=dev
  cd /app
fi

echo "🗄️ 正在检查数据库迁移..."
node /app/backend/db/migrate-to-multi-db.js || echo "数据库迁移脚本执行失败或无需执行，继续启动..."
echo "✅ 环境配置完成，正在启动应用程序..."

# 使用 gosu 切换到 node 用户，并使用 pm2-runtime 启动在 ecosystem.config.js 中定义的所有应用。
exec gosu node pm2-runtime start backend/ecosystem.config.js