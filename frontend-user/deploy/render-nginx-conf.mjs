#!/usr/bin/env node
/**
 * 由 deploy/release.config.mjs 生成 nginx.conf（容器镜像使用的发布配置）。
 *
 * 用法: node deploy/render-nginx-conf.mjs [输出路径，默认 ./nginx.conf]
 *
 * nginx.conf 是生成物，请勿手动修改；改发布配置请编辑 release.config.mjs。
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { releaseConfig } from './release.config.mjs'

const { port, spaFallback, gzip, securityHeaders, cache } = releaseConfig

// 注意：nginx 中 location 块一旦有自己的 add_header，就不会继承 server 级的
// add_header，因此安全响应头需要在每个 location 内重复声明。
const securityLines = Object.entries(securityHeaders)
  .map(([key, value]) => `        add_header ${key} "${value}" always;`)
  .join('\n')

const conf = `# 此文件由 deploy/render-nginx-conf.mjs 自动生成，请勿手动修改。
# 发布配置的唯一数据源是 deploy/release.config.mjs。

server {
    listen ${port};
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    # gzip 压缩（text/html 由 nginx 默认压缩）
    gzip on;
    gzip_types ${gzip.types.join(' ')};
    gzip_min_length ${gzip.minLength};

    # 带内容哈希的静态资源：长缓存
    location ~* ${cache.assetPattern} {
        expires 1y;
        add_header Cache-Control "${cache.assetControl}";
${securityLines}
    }

    # 页面与单页路由回退：不缓存，保证版本更新后资源引用及时生效
    location / {
        try_files $uri $uri/ ${spaFallback};
        add_header Cache-Control "${cache.htmlControl}";
${securityLines}
    }
}
`

const out = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'nginx.conf')

writeFileSync(out, conf)
console.log(`[release:nginx] 已生成 ${out}`)
