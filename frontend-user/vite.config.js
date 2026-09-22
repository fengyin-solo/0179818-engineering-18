import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import { releaseConfig } from './deploy/release.config.mjs'
import { releaseConfigPlugin } from './deploy/vite-release-plugin.mjs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

// 版本标识：优先取 APP_VERSION 环境变量（发布流水线注入），否则用 package.json 版本。
// 该值会进入 JS 产物与 index.html，版本变化会改变资源内容哈希（缓存标识）。
const appVersion = process.env.APP_VERSION || pkg.version

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: releaseConfig.port
  },
  preview: {
    host: '0.0.0.0',
    port: releaseConfig.port
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  plugins: [
    {
      name: 'app-version-meta',
      transformIndexHtml(html) {
        return html.replaceAll('%APP_VERSION%', appVersion)
      }
    },
    releaseConfigPlugin()
  ],
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  }
})
