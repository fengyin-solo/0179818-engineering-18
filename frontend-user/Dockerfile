# 构建阶段
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder

WORKDIR /app

# 构建版本号，默认 local；CI 发布时传入：docker build --build-arg BUILD_ID=1.0.0-c31acca
ARG BUILD_ID=local
ENV BUILD_ID=${BUILD_ID}

# 复制 package 文件
COPY package*.json ./

# 安装依赖
RUN npm ci

# 复制源代码（含 deploy/ 发布配置）
COPY . .

# 构建应用（BUILD_ID 写入产物指纹与 X-App-Version 校验基准）
RUN npm run build

# 生产阶段 - 使用 nginx 提供静态文件服务
FROM --platform=$TARGETPLATFORM nginx:alpine

# 发布配置由 deploy/serve.config.js 单一来源生成，本地 Vite 与容器共用同一套
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

# 从构建阶段复制构建产物
COPY --from=builder /app/dist /usr/share/nginx/html

# 将配置中的版本占位符替换为本次构建的真实版本号
ARG BUILD_ID=local
RUN sed -i "s/__BUILD_ID__/${BUILD_ID}/g" /etc/nginx/conf.d/default.conf

# 暴露端口
EXPOSE 8081

# 启动 nginx
CMD ["nginx", "-g", "daemon off;"]
