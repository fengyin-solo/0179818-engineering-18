#!/usr/bin/env node
/**
 * 发布前可重复校验（release gate）
 *
 * 运行：npm run release:check
 *
 * 分四个阶段，任一阶段失败立即退出并标明阶段，便于定位：
 *   1. config-drift  生成的 nginx.conf 与 serve.config.js 是否一致
 *   2. build-twice   两个版本号各构建一次 + 同版本重复构建
 *                    —— 验证缓存标识（bundle 指纹）随版本变化，且同版本可重复
 *   3. serve         用 preview 启动“与线上同规则”的服务，逐个 URL 校验
 *   4. report        汇总
 *
 * 不依赖浏览器或第三方库，仅用 Node 内置能力；校验逻辑与容器共用同一份
 * serve.config.js，因此通过此脚本即代表容器内 Nginx 的对应规则已被验证。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateNginxConf } from '../deploy/generate-nginx.mjs';
import { securityHeaders } from '../deploy/serve.config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const VERSION_A = '1.0.0-checkA';
const VERSION_B = '1.0.0-checkB';

let failures = [];
const serverLogs = [];

function stage(name) {
  console.log(`\n== ${name} ==`);
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function fail(stageName, msg, detail) {
  const line = `[${stageName}] ${msg}`;
  failures.push(line);
  console.log(`  ✗ ${msg}`);
  if (detail) console.log(`    ${String(detail).split('\n').join('\n    ')}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...opts.env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', rej);
    child.on('close', (code) =>
      code === 0 ? res({ out, err }) : rej(Object.assign(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`), { code, out, err })),
    );
  });
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 对 dist 产物做快照：index.html 及其引用、assets 文件名与内容哈希 */
function snapshotDist() {
  if (!existsSync(DIST)) return null;
  const indexHtml = readFileSync(join(DIST, 'index.html'), 'utf8');
  const assetsDir = join(DIST, 'assets');
  const assets = existsSync(assetsDir)
    ? Object.fromEntries(
        readdirSync(assetsDir).map((f) => [f, sha256(readFileSync(join(assetsDir, f)))]),
      )
    : {};
  const referenced = [...indexHtml.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
  const metaVersion = indexHtml.match(/<meta name="app-version" content="([^"]+)"/)?.[1];
  return { indexHtml, assets, referenced, metaVersion };
}

async function buildWithVersion(version) {
  await run('node', ['node_modules/vite/bin/vite.js', 'build'], { env: { BUILD_ID: version } });
  return snapshotDist();
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
    srv.on('error', rej);
  });
}

function startPreview(port, version) {
  const child = spawn(
    'node',
    ['node_modules/vite/bin/vite.js', 'preview', '--strictPort'],
    {
      cwd: ROOT,
      env: { ...process.env, BUILD_ID: version, SHARED_SERVE_PORT: String(port) },
    },
  );
  child.stdout.on('data', (d) => serverLogs.push(`[preview] ${d}`.trimEnd()));
  child.stderr.on('data', (d) => serverLogs.push(`[preview] ${d}`.trimEnd()));
  return child;
}

async function waitReady(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return;
    } catch {
      // 服务尚未起来
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('preview 服务启动超时');
}

async function main() {
  // ---------- 阶段 1：配置漂移 ----------
  stage('1/3 config-drift：发布配置与 nginx.conf 一致性');
  const nginxPath = join(ROOT, 'deploy', 'nginx.conf');
  try {
    const committed = readFileSync(nginxPath, 'utf8');
    const generated = generateNginxConf();
    if (committed !== generated) {
      fail('config-drift', 'deploy/nginx.conf 不是由当前 serve.config.js 生成', '运行 npm run generate:nginx 后提交');
    } else {
      ok('nginx.conf 与 serve.config.js 一致');
    }
  } catch (e) {
    fail('config-drift', '读取/生成 nginx.conf 失败', e.message);
  }

  // ---------- 阶段 2：双版本构建 ----------
  let snapB;
  if (!failures.some((f) => f.startsWith('[config-drift]'))) {
    stage('2/3 build-twice：缓存标识随版本更新且构建可重复');
    try {
      rmSync(DIST, { recursive: true, force: true });
      const snapA1 = await buildWithVersion(VERSION_A);
      ok(`版本 A 构建完成：${Object.keys(snapA1.assets).length} 个指纹资源`);

      snapB = await buildWithVersion(VERSION_B);
      ok(`版本 B 构建完成：${Object.keys(snapB.assets).length} 个指纹资源`);

      const jsA = Object.keys(snapA1.assets).filter((f) => f.endsWith('.js')).sort();
      const jsB = Object.keys(snapB.assets).filter((f) => f.endsWith('.js')).sort();
      if (JSON.stringify(jsA) === JSON.stringify(jsB)) {
        fail('build-twice', '版本变化后 JS 资源指纹未变，浏览器会继续命中旧缓存');
      } else {
        ok(`JS 指纹随版本变化：${jsA[0]} → ${jsB[0]}`);
      }

      if (snapB.metaVersion !== VERSION_B) {
        fail('build-twice', `index.html 版本标记应为 ${VERSION_B}，实际 ${snapB.metaVersion}`);
      } else {
        ok(`index.html 版本标记为 ${VERSION_B}`);
      }

      const refsExist = snapB.referenced.every((ref) =>
        existsSync(join(DIST, ref)));
      if (!refsExist) fail('build-twice', 'index.html 引用了不存在的资源', snapB.referenced.join(', '));
      else ok(`index.html 引用的 ${snapB.referenced.length} 个资源全部存在`);

      // 同版本重复构建必须得到相同产物（可重复校验的前提）
      const snapA2 = await buildWithVersion(VERSION_A);
      const sameNames =
        JSON.stringify(Object.keys(snapA1.assets).sort()) ===
        JSON.stringify(Object.keys(snapA2.assets).sort());
      const sameHashes = Object.keys(snapA1.assets).every(
        (f) => snapA2.assets[f] === snapA1.assets[f],
      );
      if (!sameNames || !sameHashes) {
        fail('build-twice', '同版本重复构建产物不一致，构建不可重复');
      } else {
        ok('同版本重复构建产物一致（可重复）');
      }

      // 最终留下版本 B 供 serve 阶段
      snapB = await buildWithVersion(VERSION_B);
    } catch (e) {
      fail('build-twice', '构建失败', `${e.message}\n${e.err ?? e.out ?? ''}`);
    }
  }

  // ---------- 阶段 3：启动真实服务逐项校验 ----------
  if (!failures.length && snapB) {
    stage('3/3 serve：页面 / 样式 / 脚本加载、压缩、安全头、缓存、SPA 回退');
    const port = await freePort();
    const child = startPreview(port, VERSION_B);
    try {
      await waitReady(port);
      ok(`preview 已在 http://127.0.0.1:${port} 启动（BUILD_ID=${VERSION_B}）`);
      const base = `http://127.0.0.1:${port}`;

      const expectHeaders = (label, res, expected, stageName = 'serve') => {
        for (const [k, v] of Object.entries(expected)) {
          const got = res.headers.get(k.toLowerCase());
          if (got !== v) fail(stageName, `${label}：${k} 期望 "${v}"，实际 "${got}"`);
        }
      };

      // 3.1 入口页面
      // 注意：Node 内置 fetch（undici）会保留 content-encoding 头但自动解压 body，
      // 因此 gzip 用响应头断言，body 直接按文本读取
      const resRoot = await fetch(`${base}/`, { headers: { 'Accept-Encoding': 'gzip' } });
      const rootText = await resRoot.text();
      if (resRoot.status !== 200) fail('serve', `GET / 状态码应为 200，实际 ${resRoot.status}`);
      if (!resRoot.headers.get('content-type')?.includes('text/html')) {
        fail('serve', `GET / Content-Type 异常：${resRoot.headers.get('content-type')}`);
      }
      if (!rootText.includes('<div id="app">')) fail('serve', 'GET / 内容不是入口页面（缺少 #app）');
      if (!rootText.includes(`content="${VERSION_B}"`)) fail('serve', 'GET / 缺少本版本的 app-version meta');
      if (resRoot.headers.get('content-encoding') !== 'gzip') {
        fail('serve', 'GET / 未按配置启用 gzip');
      } else {
        ok('GET / 返回入口页面（gzip + 版本标记正确）');
      }
      expectHeaders('GET /', resRoot, {
        'cache-control': 'no-cache',
        'x-app-version': VERSION_B,
        ...Object.fromEntries(Object.entries(securityHeaders).map(([k, v]) => [k.toLowerCase(), v])),
      });
      if (!failures.some((f) => f.includes('GET /'))) ok('GET / 缓存头（no-cache）与安全头齐全');

      // 3.2 index.html 引用的样式与脚本：都能加载，且长缓存
      for (const ref of snapB.referenced) {
        const res = await fetch(`${base}/${ref}`, { headers: { 'Accept-Encoding': 'gzip' } });
        if (res.status !== 200) {
          fail('serve', `GET /${ref} 加载失败：${res.status}`);
          continue;
        }
        const kind = ref.endsWith('.js')
          ? 'javascript'
          : ref.endsWith('.css')
            ? 'css'
            : '';
        if (kind && !res.headers.get('content-type')?.includes(kind)) {
          fail('serve', `GET /${ref} Content-Type 异常：${res.headers.get('content-type')}`);
        }
        expectHeaders(`GET /${ref}`, res, {
          'cache-control': 'public, max-age=31536000, immutable',
          'x-app-version': VERSION_B,
        });
      }
      if (!failures.some((f) => f.includes('GET /assets/'))) {
        ok(`样式与脚本（${snapB.referenced.length} 个指纹资源）均可加载，缓存 immutable`);
      }

      // 3.3 脚本经 gzip 传输且内容包含版本号（内容随版本变化，缓存键随之变化）
      const jsRef = snapB.referenced.find((r) => r.endsWith('.js'));
      const resJs = await fetch(`${base}/${jsRef}`, { headers: { 'Accept-Encoding': 'gzip' } });
      const jsText = await resJs.text();
      if (resJs.headers.get('content-encoding') !== 'gzip') {
        fail('serve', `GET /${jsRef} 未按配置启用 gzip`);
      } else if (!jsText.includes(VERSION_B)) {
        fail('serve', `GET /${jsRef} 解压后不含版本号 ${VERSION_B}`);
      } else {
        ok('脚本 gzip 正常，且内容包含新版本号（旧缓存键自然失效）');
      }

      // 3.4 public/ 静态资源：短缓存
      const resWav = await fetch(`${base}/test-guqin.wav`);
      if (resWav.status !== 200) {
        fail('serve', `GET /test-guqin.wav 加载失败：${resWav.status}`);
      } else {
        expectHeaders('GET /test-guqin.wav', resWav, {
          'cache-control': 'public, max-age=86400',
          'x-app-version': VERSION_B,
        });
        if (!failures.some((f) => f.includes('test-guqin'))) {
          ok('public 静态资源可加载，按短缓存规则返回');
        }
      }

      // 3.5 SPA 路由回退：深层路由返回入口页面
      const resSpa = await fetch(`${base}/records/some-id`, {
        headers: { Accept: 'text/html', 'Accept-Encoding': 'gzip' },
      });
      const spaText = await resSpa.text();
      if (resSpa.status !== 200 || !spaText.includes('<div id="app">')) {
        fail('serve', `GET /records/some-id 未回退到入口页面（status=${resSpa.status}）`);
      } else {
        expectHeaders('SPA 回退', resSpa, { 'cache-control': 'no-cache', 'x-app-version': VERSION_B });
        if (!failures.some((f) => f.includes('回退'))) ok('深层路由 SPA 回退到 index.html，头与入口一致');
      }
    } catch (e) {
      fail('serve', '服务校验阶段异常', e.stack || e.message);
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // ---------- 汇总 ----------
  console.log('\n== 结果 ==');
  if (failures.length) {
    console.log(`失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  - ${f}`);
    if (serverLogs.length) {
      console.log('\n—— preview 服务日志（最后 20 行）——');
      console.log(serverLogs.slice(-20).join('\n'));
    }
    console.log('\n发布校验未通过，已中止。');
    process.exit(1);
  }
  console.log('全部通过：页面/样式/脚本加载正常，压缩、安全头、缓存规则与 SPA 回退符合预期，缓存标识随版本更新。');
}

main().catch((e) => {
  console.error('release-check 自身异常：', e);
  process.exit(2);
});
