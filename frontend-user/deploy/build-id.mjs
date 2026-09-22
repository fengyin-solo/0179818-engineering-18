/**
 * 解析构建版本号
 *
 * 优先级：环境变量 BUILD_ID（CI / docker build --build-arg 传入）
 *         > package.json version + git 短 SHA（本地）
 *         > package.json version + 'local'（拿不到 git 时，保证可重复）
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = join(__dirname, '..', 'package.json');

export function packageVersion() {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  return pkg.version;
}

export function gitShortSha() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function resolveBuildId() {
  if (process.env.BUILD_ID) return process.env.BUILD_ID;
  const sha = gitShortSha();
  return `${packageVersion()}-${sha ?? 'local'}`;
}
