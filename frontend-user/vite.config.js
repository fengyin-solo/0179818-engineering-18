import { defineConfig } from 'vite'
import { sharedServeConfig } from './deploy/vite-shared-serve.mjs'

// 发布规则（压缩 / 安全头 / 缓存 / 端口）统一来自 deploy/serve.config.js，
// dev、preview 与容器内 Nginx 共用同一套，见 deploy/vite-shared-serve.mjs
export default defineConfig({
  plugins: [sharedServeConfig()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  }
})
