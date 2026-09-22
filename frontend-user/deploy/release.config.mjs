/**
 * 发布配置（唯一数据源）
 *
 * 本地 preview（deploy/vite-release-plugin.mjs）、容器 nginx
 * （deploy/render-nginx-conf.mjs 生成的 nginx.conf）、发布前校验
 * （scripts/verify-release.mjs）共用此配置。
 * 修改发布行为只改这里，三处同时生效。
 */
export const releaseConfig = {
  // 服务端口（vite dev / preview / nginx 保持一致）
  port: 8081,

  // 单页应用路由回退目标
  spaFallback: '/index.html',

  // gzip 压缩
  gzip: {
    minLength: 1000,
    // 注：text/html 在 nginx 中默认始终压缩，无需列入 gzip_types；
    // 本地中间件按同样规则处理（见 vite-release-plugin.mjs）
    types: [
      'text/plain',
      'text/css',
      'application/json',
      'application/javascript',
      'text/xml',
      'application/xml',
      'application/xml+rss',
      'text/javascript'
    ]
  },

  // 安全响应头（作用于所有响应，包括静态资源）
  securityHeaders: {
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
    'X-XSS-Protection': '1; mode=block'
  },

  // 缓存策略
  cache: {
    // 构建产物文件名均带内容哈希（/assets/<name>-<hash>.<ext>），可长缓存
    assetPattern: '\\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$',
    assetControl: 'public, max-age=31536000, immutable',
    // HTML 不缓存，保证新版本发布后客户端能及时拿到新的资源引用
    htmlControl: 'no-cache'
  }
}

export default releaseConfig
