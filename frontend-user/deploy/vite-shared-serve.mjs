/**
 * Vite 插件：让本地 dev / preview 的行为与容器内 Nginx 完全一致
 *
 * 生效的规则全部来自 serve.config.js：
 * - 安全响应头 + X-App-Version（所有响应）
 * - gzip 压缩（同样的类型与阈值）
 * - 缓存策略：index.html 不缓存、/assets/ 指纹资源长缓存、public 静态资源短缓存
 * - SPA 路由回退由 Vite 内置（appType: 'spa'）提供，与 try_files ... /index.html 等价
 *
 * 这样在本地 `npm run dev` / `npm run preview` 看到的头与线上一致，
 * 发布配置不再是“只能在容器镜像里验证”的一次性配置。
 */
import { gzipSync } from 'node:zlib';
import {
  PORT,
  HOST,
  gzip,
  securityHeaders,
  staticAssets,
  hashedAssets,
  htmlCacheControl,
} from './serve.config.js';
import { resolveBuildId } from './build-id.mjs';

const BUILD_ID = resolveBuildId();
const VARY_HEADER = 'Accept-Encoding';

/** dev server 内部路径，不套用任何缓存规则（模块图 / HMR / 依赖预构建） */
function isDevInternal(pathname) {
  return (
    pathname.startsWith('/src/') ||
    pathname.startsWith('/@') ||
    pathname.startsWith('/node_modules/')
  );
}

/** 按与 nginx.conf 相同的规则分类请求，返回应设置的 Cache-Control */
function classify(pathname) {
  if (pathname === '/index.html' || pathname === '/') {
    return { kind: 'html', cacheControl: htmlCacheControl };
  }
  if (pathname.startsWith(hashedAssets.pathPrefix)) {
    return { kind: 'hashed', cacheControl: hashedAssets.cacheControl };
  }
  const ext = pathname.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  if (staticAssets.extensions.includes(ext)) {
    return { kind: 'static', cacheControl: staticAssets.cacheControl };
  }
  // 其它路径（如 /some/spa/route）会回退到 index.html，按 HTML 处理
  return { kind: 'html', cacheControl: htmlCacheControl };
}

function acceptsGzip(req) {
  return (req.headers['accept-encoding'] ?? '').split(',').map((s) => s.trim()).includes('gzip');
}

function isCompressibleType(contentType) {
  if (!contentType) return false;
  const mime = contentType.split(';')[0].trim().toLowerCase();
  return gzip.types.includes(mime);
}

/** 统一注入响应头与压缩的中间件 */
function sharedServeMiddleware(req, res, next) {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    next();
    return;
  }
  if (req.headers.upgrade) {
    next(); // WebSocket（HMR 等）直接放行
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const devInternal = isDevInternal(url.pathname);
  const { cacheControl } = devInternal
    ? { cacheControl: undefined }
    : classify(url.pathname);

  // 安全头与版本号：所有响应都带
  for (const [key, value] of Object.entries(securityHeaders)) {
    res.setHeader(key, value);
  }
  res.setHeader('X-App-Version', BUILD_ID);
  if (cacheControl) {
    res.setHeader('Cache-Control', cacheControl);
  }

  // 只在启用压缩且客户端支持时，接管响应体缓冲
  const wantGzip =
    gzip.enabled &&
    !devInternal &&
    acceptsGzip(req) &&
    method === 'GET';

  if (!wantGzip) {
    next();
    return;
  }

  const chunks = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  let decided = false;

  function shouldCompress() {
    const status = res.statusCode;
    if (status < 200 || status >= 300) return false;
    if (res.getHeader('Content-Encoding')) return false;
    if (res.getHeader('Transfer-Encoding') === 'chunked' && status === 206) return false;
    return isCompressibleType(res.getHeader('Content-Type'));
  }

  res.write = (chunk, encoding, callback) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    if (typeof callback === 'function') callback();
    return true;
  };

  res.end = (chunk, encoding, callback) => {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
    }
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));

    if (!decided) {
      decided = true;
      const body = Buffer.concat(chunks);
      const doGzip = shouldCompress() && body.length >= gzip.minLength;

      // 任何可能被压缩的响应都要带 Vary
      if (shouldCompress()) {
        const existing = res.getHeader('Vary');
        if (!existing || !String(existing).includes('Accept-Encoding')) {
          res.setHeader('Vary', existing ? `${existing}, ${VARY_HEADER}` : VARY_HEADER);
        }
      }

      if (doGzip) {
        res.setHeader('Content-Encoding', 'gzip');
        res.removeHeader('Content-Length');
        const compressed = gzipSync(body);
        originalWrite(compressed);
        originalEnd(callback);
        return;
      }

      if (body.length > 0) originalWrite(body);
      originalEnd(callback);
      return;
    }

    originalEnd(callback);
  };

  next();
}

export function sharedServeConfig() {
  return {
    name: 'shared-serve-config',
    apply: () => true, // dev、preview、build 都需要（define / transformIndexHtml）
    config() {
      // 默认用共享配置中的端口；发布校验等场景可用 SHARED_SERVE_PORT 选空闲端口
      const port = Number(process.env.SHARED_SERVE_PORT) || PORT;
      return {
        server: { host: HOST, port },
        preview: { host: HOST, port },
        define: {
          __APP_BUILD_ID__: JSON.stringify(BUILD_ID),
        },
      };
    },
    configureServer(server) {
      // 尽量靠前，统一包住后续中间件写出的响应
      server.middlewares.use(sharedServeMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(sharedServeMiddleware);
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { name: 'app-version', content: BUILD_ID },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export { BUILD_ID };
