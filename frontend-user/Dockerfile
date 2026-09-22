# 构建阶段
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder

WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装依赖
RUN npm ci

# 复制源代码
COPY . .

# 构建应用，并由共享发布配置生成 nginx.conf（与本地 preview 行为一致）
RUN npm run build && npm run release:nginx

# 生产阶段 - 使用 nginx 提供静态文件服务
FROM --platform=$TARGETPLATFORM nginx:alpine

# 复制生成的 nginx 配置
COPY --from=builder /app/nginx.conf /etc/nginx/conf.d/default.conf

# 从构建阶段复制构建产物
COPY --from=builder /app/dist /usr/share/nginx/html

# 暴露端口
EXPOSE 8081

# 启动 nginx
CMD ["nginx", "-g", "daemon off;"]
