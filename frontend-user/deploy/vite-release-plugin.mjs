/**
 * 将 deploy/release.config.mjs 的发布行为应用到本地 Vite 服务：
 * - preview（npm run preview，对应线上产物）：安全响应头 + 缓存策略 + gzip，
 *   与容器内 nginx 行为一致，发布前校验（scripts/verify-release.mjs）即跑在这里；
 * - dev（npm run dev）：仅对齐安全响应头，缓存/压缩会让热更新失效，不施加。
 */
import zlib from 'node:zlib'
import { releaseConfig } from './release.config.mjs'

const assetRegex = new RegExp(releaseConfig.cache.assetPattern, 'i')

function setSecurityHeaders(res) {
  for (const [key, value] of Object.entries(releaseConfig.securityHeaders)) {
    res.setHeader(key, value)
  }
}

// 与生成的 nginx.conf 对应：命中资源后缀的长缓存，其余（页面/回退/其他文件）不缓存
function headersMiddleware() {
  return (req, res, next) => {
    setSecurityHeaders(res)
    const url = (req.url || '').split('?')[0]
    res.setHeader(
      'Cache-Control',
      assetRegex.test(url) ? releaseConfig.cache.assetControl : releaseConfig.cache.htmlControl
    )
    next()
  }
}

function gzipMiddleware() {
  const { minLength, types } = releaseConfig.gzip
  return (req, res, next) => {
    if (req.method === 'HEAD') return next()
    if (!String(req.headers['accept-encoding'] || '').includes('gzip')) return next()

    // 压缩行为完全由 release.config.mjs 决定：摘掉 accept-encoding，
    // 避免 Vite preview 自带的压缩中间件按另一套规则（阈值/类型不同）介入
    delete req.headers['accept-encoding']

    const write = res.write.bind(res)
    const end = res.end.bind(res)
    const writeHead = res.writeHead.bind(res)
    const chunks = []
    let pendingStatus = null
    let passthrough = false
    let flushing = false

    // 静态资源由 sirv 流式发送（显式 writeHead + pipe），
    // 这里拦截并暂存状态行，待 end 时按配置决定是否压缩后再真正发送。
    // 注意 Node 的隐式响应头（_implicitHeader）也会调用 res.writeHead，
    // 因此 flushing 期间必须放行，否则状态行永远发不出去。
    res.writeHead = (statusCode, ...args) => {
      if (flushing) return writeHead(statusCode, ...args)
      pendingStatus = statusCode
      for (const arg of args) {
        if (arg && typeof arg === 'object') {
          for (const key of Object.keys(arg)) res.setHeader(key, arg[key])
        }
      }
      return res
    }

    res.write = (chunk, encoding, cb) => {
      if (passthrough || res.headersSent) {
        passthrough = true
        return write(chunk, encoding, cb)
      }
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
      if (typeof cb === 'function') cb()
      return true
    }

    res.end = (chunk, encoding, cb) => {
      if (typeof chunk === 'function') { cb = chunk; chunk = null; encoding = undefined }
      else if (typeof encoding === 'function') { cb = encoding; encoding = undefined }
      if (passthrough || res.headersSent) return end(chunk, encoding, cb)
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))

      const body = Buffer.concat(chunks)
      const type = String(res.getHeader('content-type') || '')
      const status = pendingStatus ?? res.statusCode
      const noBody = status === 204 || status === 304
      // text/html 与 nginx 默认行为对齐，始终参与压缩
      const compressible = type.includes('text/html') || types.some((t) => type.includes(t))

      const finish = (data) => {
        flushing = true
        if (pendingStatus != null) writeHead(pendingStatus)
        end(data, cb)
      }

      if (!noBody && status < 300 && compressible && body.length >= minLength) {
        zlib.gzip(body, (err, gz) => {
          if (err) return finish(body)
          res.setHeader('Content-Encoding', 'gzip')
          res.setHeader('Vary', 'Accept-Encoding')
          res.setHeader('Content-Length', gz.length)
          finish(gz)
        })
      } else {
        if (!noBody) res.setHeader('Content-Length', body.length)
        finish(body)
      }
    }

    next()
  }
}

export function releaseConfigPlugin() {
  return {
    name: 'release-config',
    configurePreviewServer(server) {
      server.middlewares.use(headersMiddleware())
      server.middlewares.use(gzipMiddleware())
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        setSecurityHeaders(res)
        next()
      })
    }
  }
}
