#!/usr/bin/env node
/**
 * 根据 deploy/serve.config.js 生成 deploy/nginx.conf
 *
 *   node deploy/generate-nginx.mjs          # 生成
 *   node deploy/generate-nginx.mjs --check  # 不写文件，只检查是否与已提交的产物一致（CI / 发布前校验）
 *
 * 版本号以占位符形式写进 X-App-Version，由 Dockerfile 在镜像构建时替换，
 * 这样配置本身不随每次提交漂移，只有修改发布策略时 nginx.conf 才会变化。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PORT,
  gzip,
  securityHeaders,
  staticAssets,
  hashedAssets,
  htmlCacheControl,
  spaFallback,
  BUILD_ID_PLACEHOLDER,
} from './serve.config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, 'nginx.conf');

const extensionRegex = `\\.(?:${staticAssets.extensions.join('|')})$`;

function headerLines(headers, indent = '        ') {
  return Object.entries(headers)
    .map(([key, value]) => `${indent}add_header ${key} "${value}" always;`)
    .join('\n');
}

export function generateNginxConf() {
  const gzipTypes = gzip.types.join(' ');

  const conf = `# 由 deploy/generate-nginx.mjs 依据 deploy/serve.config.js 生成，请勿手改
server {
    listen ${PORT};
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    # gzip 压缩
    gzip ${gzip.enabled ? 'on' : 'off'};
    gzip_types ${gzipTypes};
    gzip_min_length ${gzip.minLength};
    gzip_vary on;

    # Vite 指纹产物（文件名带内容 hash）：长缓存
    # X-App-Version 随镜像构建注入，发布后响应头随之变化，可据此确认版本生效
    location ^~ ${hashedAssets.pathPrefix} {
        expires 1y;
        add_header Cache-Control "${hashedAssets.cacheControl}" always;
        add_header X-App-Version "${BUILD_ID_PLACEHOLDER}" always;
${headerLines(securityHeaders)}
    }

    # public/ 中的静态资源（文件名不带 hash）：短缓存，需重新验证
    location ~* ${extensionRegex} {
        expires 1d;
        add_header Cache-Control "${staticAssets.cacheControl}" always;
        add_header X-App-Version "${BUILD_ID_PLACEHOLDER}" always;
${headerLines(securityHeaders)}
    }

    # SPA 路由回退 + 入口 HTML 不缓存
    location / {
        add_header Cache-Control "${htmlCacheControl}" always;
        add_header X-App-Version "${BUILD_ID_PLACEHOLDER}" always;
${headerLines(securityHeaders)}
        try_files $uri $uri/ ${spaFallback.target};
    }
}
`;
  return conf;
}

function main() {
  const check = process.argv.includes('--check');
  const rendered = generateNginxConf();

  if (check) {
    let committed;
    try {
      committed = readFileSync(OUT_FILE, 'utf8');
    } catch {
      console.error(`[generate-nginx] ${OUT_FILE} 不存在，请先运行 npm run generate:nginx`);
      process.exit(1);
    }
    if (committed !== rendered) {
      console.error('[generate-nginx] nginx.conf 与 serve.config.js 不一致，请运行 npm run generate:nginx 并提交产物');
      process.exit(1);
    }
    console.log('[generate-nginx] nginx.conf 与 serve.config.js 一致');
    return;
  }

  writeFileSync(OUT_FILE, rendered);
  console.log(`[generate-nginx] 已生成 ${OUT_FILE}`);
  console.log(`[generate-nginx] 覆盖类型: 压缩 ${gzip.types.length} 种, 静态资源 ${staticAssets.extensions.length} 种扩展名`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
