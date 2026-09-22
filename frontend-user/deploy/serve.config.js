/**
 * 发布配置 —— 单一事实来源
 *
 * 本地开发（vite dev / vite preview）与容器内 Nginx 共用这一份配置：
 * - deploy/generate-nginx.mjs 读取它生成 nginx.conf
 * - deploy/vite-shared-serve.mjs 读取它让 Vite 的 dev/preview 行为与 Nginx 一致
 *
 * 修改发布策略只改这一个文件，然后执行 `npm run generate:nginx` 更新生成产物。
 *
 * 注意：缓存规则依赖 Vite 的产物指纹 —— /assets/ 下的文件名全部带内容 hash，
 * 因此可以长缓存；index.html 必须不缓存，新版本才能被发现。
 */

export const PORT = 8081;
export const HOST = '0.0.0.0';

/** 入口文档（SPA fallback 目标），永远不缓存 */
export const INDEX_FILE = 'index.html';

/**
 * 构建版本号占位符。
 * 镜像构建时由 Dockerfile 的 sed 替换为真实 BUILD_ID（如 1.0.0-c31acca）。
 * 本地经 Vite 插件运行时替换为解析到的实际版本。
 */
export const BUILD_ID_PLACEHOLDER = '__BUILD_ID__';

/**
 * 压缩配置（gzip）
 * types: 对这些 Content-Type 的响应做压缩
 * minLength: 小于该字节数不压缩
 */
export const gzip = {
  enabled: true,
  minLength: 1000,
  types: [
    'text/plain',
    'text/css',
    'text/html',
    'text/xml',
    'application/json',
    'application/javascript',
    'text/javascript',
    'application/xml',
    'application/xml+rss',
    'image/svg+xml',
  ],
};

/**
 * 安全响应头（所有响应都带，always）
 */
export const securityHeaders = {
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/**
 * 静态资源（public/ 中按扩展名输出的文件）缓存策略
 * 与 Vite 产物不同：这些文件名不带 hash，只能短缓存 + 必须重新验证，
 * 避免 1 年长缓存把旧的 test-guqin.wav 等文件钉死在浏览器里。
 */
export const staticAssets = {
  extensions: [
    'js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'svg',
    'woff', 'woff2', 'ttf', 'eot',
    'mp3', 'wav', 'ogg',
  ],
  cacheControl: 'public, max-age=86400',
};

/**
 * Vite 指纹产物（dist/assets/，文件名带内容 hash）
 */
export const hashedAssets = {
  pathPrefix: '/assets/',
  cacheControl: 'public, max-age=31536000, immutable',
};

/**
 * 入口 HTML 的缓存策略：不缓存，确保新版本发布后立即生效
 */
export const htmlCacheControl = 'no-cache';

/**
 * SPA 路由回退：找不到文件时返回入口文档
 */
export const spaFallback = {
  enabled: true,
  target: '/index.html',
};
