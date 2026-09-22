#!/usr/bin/env node
/**
 * 发布前校验（可重复执行）：依次检查以下环节，任一失败即以非零码退出并标明环节。
 *
 *   1. build          构建产物（vite build）
 *   2. artifacts      产物完整性：index.html、版本标识、资源引用与内容哈希
 *   3. nginx-conf     容器 nginx 配置可由共享配置正确生成
 *   4. serve          本地发布服务（vite preview，与容器共用发布配置）
 *   5. page           页面可加载、安全响应头、HTML 不缓存、gzip
 *   6. assets         样式/脚本可加载、内容与产物一致、长缓存、gzip
 *   7. spa-fallback   单页路由回退到 index.html
 *   8. cache-busting  版本更新后资源哈希（缓存标识）随之变化
 *
 * 用法: npm run verify:release   （APP_VERSION 环境变量可指定版本号）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { releaseConfig } from '../deploy/release.config.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))
const appVersion = process.env.APP_VERSION || pkg.version
const distDir = path.join(root, 'dist')
const previewPort = 4181
const previewHost = '127.0.0.1'

// ---------- 工具 ----------

function check(label, cond) {
  if (!cond) throw new Error(label)
  console.log(`  ✓ ${label}`)
}

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 退出码 ${r.status}`)
}

function rawGet(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: previewHost, port: previewPort, path: urlPath, headers },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        )
      }
    )
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error(`请求超时: ${urlPath}`)))
  })
}

function extractAssetRefs(html) {
  return [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
}

function checkSecurityHeaders(headers, where) {
  for (const [key, value] of Object.entries(releaseConfig.securityHeaders)) {
    check(`${where} 安全响应头 ${key}`, headers[key.toLowerCase()] === value)
  }
}

// ---------- 校验环节 ----------

const ctx = { assetRefs: [], server: null }

async function stageBuild() {
  rmSync(distDir, { recursive: true, force: true })
  run('npx', ['vite', 'build'], { APP_VERSION: appVersion })
  check('vite build 成功', existsSync(distDir))
}

async function stageArtifacts() {
  const indexPath = path.join(distDir, 'index.html')
  check('dist/index.html 存在', existsSync(indexPath))
  const html = readFileSync(indexPath, 'utf-8')
  check(`版本标识 app-version=${appVersion} 已注入`, html.includes(`content="${appVersion}"`))

  ctx.assetRefs = extractAssetRefs(html)
  check(`index.html 引用了 ${ctx.assetRefs.length} 个静态资源`, ctx.assetRefs.length > 0)

  for (const ref of ctx.assetRefs) {
    check(`${ref} 文件名带内容哈希`, /-[A-Za-z0-9_-]{8,}\.\w+$/.test(ref))
    check(`${ref} 存在于产物目录`, existsSync(path.join(distDir, ref)))
  }
}

async function stageNginxConf() {
  const out = path.join(distDir, '.verify-nginx.conf')
  run('node', ['deploy/render-nginx-conf.mjs', out])
  const conf = readFileSync(out, 'utf-8')
  rmSync(out, { force: true })

  check(`监听端口 ${releaseConfig.port}`, conf.includes(`listen ${releaseConfig.port};`))
  check('gzip 已启用', conf.includes('gzip on;'))
  check(`gzip 最小长度 ${releaseConfig.gzip.minLength}`, conf.includes(`gzip_min_length ${releaseConfig.gzip.minLength};`))
  for (const type of releaseConfig.gzip.types) {
    check(`gzip 类型 ${type}`, conf.includes(type))
  }
  for (const [key, value] of Object.entries(releaseConfig.securityHeaders)) {
    check(`安全响应头 ${key}`, conf.includes(`add_header ${key} "${value}" always;`))
  }
  check('静态资源长缓存（immutable）', conf.includes(releaseConfig.cache.assetControl))
  check('HTML 不缓存（no-cache）', conf.includes(releaseConfig.cache.htmlControl))
  check('SPA 路由回退', conf.includes(`try_files $uri $uri/ ${releaseConfig.spaFallback};`))
}

async function stageServe() {
  const { preview } = await import('vite')
  ctx.server = await preview({
    root,
    logLevel: 'silent',
    preview: { host: previewHost, port: previewPort, strictPort: true }
  })
  const res = await rawGet('/')
  check(`preview 服务已启动（:${previewPort}）`, res.status > 0)
}

async function stagePage() {
  const res = await rawGet('/')
  check('GET / 返回 200', res.status === 200)
  check('Content-Type 为 text/html', String(res.headers['content-type']).includes('text/html'))
  check('页面包含 #app 挂载点', res.body.toString('utf-8').includes('id="app"'))
  check('HTML Cache-Control 为 no-cache', res.headers['cache-control'] === releaseConfig.cache.htmlControl)
  checkSecurityHeaders(res.headers, '页面')

  const gz = await rawGet('/', { 'accept-encoding': 'gzip' })
  check('HTML gzip 压缩生效', gz.headers['content-encoding'] === 'gzip')
  check('gzip 解压后内容完整', zlib.gunzipSync(gz.body).toString('utf-8').includes('id="app"'))
}

async function stageAssets() {
  for (const ref of ctx.assetRefs) {
    const disk = readFileSync(path.join(distDir, ref))
    const res = await rawGet(ref)
    check(`GET ${ref} 返回 200`, res.status === 200)
    check(`${ref} 响应内容与产物一致`, res.body.equals(disk))

    const isJs = ref.endsWith('.js')
    const isCss = ref.endsWith('.css')
    if (isJs) check(`${ref} Content-Type 为 JavaScript`, String(res.headers['content-type']).includes('javascript'))
    if (isCss) check(`${ref} Content-Type 为 CSS`, String(res.headers['content-type']).includes('text/css'))

    check(`${ref} Cache-Control 长缓存`, res.headers['cache-control'] === releaseConfig.cache.assetControl)
    checkSecurityHeaders(res.headers, ref)

    const type = String(res.headers['content-type'])
    const compressible = releaseConfig.gzip.types.some((t) => type.includes(t))
    if (compressible && disk.length >= releaseConfig.gzip.minLength) {
      const gz = await rawGet(ref, { 'accept-encoding': 'gzip' })
      check(`${ref} gzip 压缩生效`, gz.headers['content-encoding'] === 'gzip')
      check(`${ref} gzip 解压后与产物一致`, zlib.gunzipSync(gz.body).equals(disk))
    }
  }
}

async function stageSpaFallback() {
  const res = await rawGet('/records/some/deep/route', { accept: 'text/html' })
  check('未知路由返回 200', res.status === 200)
  check('回退到 index.html（含 #app）', res.body.toString('utf-8').includes('id="app"'))
  check('回退页面 Cache-Control 为 no-cache', res.headers['cache-control'] === releaseConfig.cache.htmlControl)
}

async function stageCacheBusting() {
  const nextVersion = `${appVersion}+verify`
  const tmpOut = path.join(root, 'node_modules', '.cache', 'verify-release-dist')
  rmSync(tmpOut, { recursive: true, force: true })
  try {
    run('npx', ['vite', 'build', '--outDir', tmpOut, '--emptyOutDir'], { APP_VERSION: nextVersion })

    const html = readFileSync(path.join(tmpOut, 'index.html'), 'utf-8')
    check(`新版本号 ${nextVersion} 已注入`, html.includes(`content="${nextVersion}"`))

    const nextRefs = extractAssetRefs(html)
    check('资源数量与当前版本一致', nextRefs.length === ctx.assetRefs.length)
    for (const ref of nextRefs) {
      check(`${ref} 存在于新产物目录`, existsSync(path.join(tmpOut, ref)))
    }
    const changed = nextRefs.filter((ref) => !ctx.assetRefs.includes(ref))
    check(`版本更新后 ${changed.length} 个资源的缓存标识（内容哈希）发生变化`, changed.length > 0)
  } finally {
    rmSync(tmpOut, { recursive: true, force: true })
  }
}

// ---------- 流水线 ----------

const stages = [
  ['build', '构建产物', stageBuild],
  ['artifacts', '产物完整性', stageArtifacts],
  ['nginx-conf', 'nginx 配置生成', stageNginxConf],
  ['serve', '启动本地发布服务', stageServe],
  ['page', '页面加载与响应头', stagePage],
  ['assets', '静态资源加载/缓存/压缩', stageAssets],
  ['spa-fallback', 'SPA 路由回退', stageSpaFallback],
  ['cache-busting', '缓存标识随版本更新', stageCacheBusting]
]

console.log(`[verify] 发布前校验开始（版本 ${appVersion}）`)

let failed = null
for (const [id, name, fn] of stages) {
  console.log(`\n[verify] ▶ 环节 ${id}: ${name}`)
  try {
    await fn()
  } catch (err) {
    failed = { id, name, err }
    break
  }
}

if (ctx.server) {
  await new Promise((resolve) => ctx.server.httpServer.close(resolve))
}

if (failed) {
  console.error(`\n[verify] ✗ 校验失败，环节: ${failed.id}（${failed.name}）`)
  console.error(`[verify] 原因: ${failed.err.message}`)
  process.exit(1)
}

console.log('\n[verify] 全部环节通过，可以发布 ✔')
