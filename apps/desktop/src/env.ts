// ============================================================
// apps/desktop/src/env.ts
// 子进程环境变量装配（ADR-0008 D2 第 5 项、D6 冻结表、D12.5）。
//
// D6 开篇逐字：「下表是主进程注入子进程的**完整**环境变量集合。
// **未列出的变量一律不注入**（子进程继承 `process.env` 的其余部分，
// 但下列键必须显式设定或显式删除）。」
//
// ⇒ 本文件承担两件事：
//   ① 显式**设定** D6 冻结表中「注入」的键；
//   ② 显式**删除** D6 冻结表中「不注入」的键（防止宿主 shell 里的
//      残留变量意外改变桌面端行为）。
//
// ★ 关键（D6.1）：桌面端 NODE_ENV=production 时
//   `apps/server/src/index.ts:37-40` 缺 JWT_SECRET 会直接 `process.exit(1)`；
//   且 `apps/server/src/lib/jwt.ts:63-64` 在生产环境下**拒绝**文件回退
//   （`if (process.env.NODE_ENV === 'production') return undefined;`）
//   ⇒ 主进程**必须**生成并持久化密钥后以环境变量注入。
// ============================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Logger, ServerEnv, UserDataLayout } from './types.js';

/** D6 冻结常量。 */
const CONST_PORT = '0';
const CONST_HOST = '127.0.0.1';
const CONST_DISABLE_PROXY_DETECT = '1';
const CONST_HOST_MODE = 'all';
const CONST_ELECTRON_RUN_AS_NODE = '1';

/** D6.3 宿主代理透传时注入子进程的 `NO_PROXY` 默认值（与 server 端 `proxy-agent.ts` 兜底值一致）。 */
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1';

/**
 * D6 冻结「**不注入**」的键（大小写不敏感匹配）。
 *
 * 分组依据 D6 表：
 *   - `ADMIN_USERNAME` / `ADMIN_PASSWORD`：保留「随机初始密码 + 用户自行修改」
 *     的安全语义（D6.2 末段）。注入 ADMIN_PASSWORD 会使 server 每次启动
 *     同步密码（`index.ts:90-96`）。
 *   - `JWT_EXPIRES_IN`：server 默认 `'30d'`。
 *   - `COOKIE_SECURE`：本机 HTTP ⇒ 必须保持未设/false。
 *   - `NOVELMUSE_DB_ENGINE`：默认走 better-sqlite3，失败自动回退 sql.js（D8.3）。
 *   - AI 供应商变量：由用户在应用内配置，落 DB。
 *   - `AI_SSRF_*`：沿用代码默认。
 */
const NEVER_INJECT_EXACT = [
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'JWT_EXPIRES_IN',
  'COOKIE_SECURE',
  'NOVELMUSE_DB_ENGINE',
] as const;

/** D6 冻结「不注入」的**前缀**（AI 供应商变量与 SSRF 配置）。 */
const NEVER_INJECT_PREFIXES = [
  'AI_PROVIDER',
  'OPENAI_',
  'OLLAMA_',
  'CUSTOM_AI_',
  'AI_SSRF_',
] as const;

/**
 * 大小写不敏感地从普通对象里删除键。
 *
 * 为什么不能直接 `delete env.ADMIN_PASSWORD`：Windows 上 `process.env` 本身
 * 大小写不敏感，但 `{ ...process.env }` 得到的是**普通 JS 对象**，其键删除
 * 是大小写**敏感**的 ⇒ 宿主里若写成 `Admin_Password` 就漏删。
 * （`.gitignore` 式的跨平台纪律：显式扫描全部键。）
 */
function deleteInsensitive(target: Record<string, string>, name: string): boolean {
  const upper = name.toUpperCase();
  let removed = false;
  for (const key of Object.keys(target)) {
    if (key.toUpperCase() === upper) {
      delete target[key];
      removed = true;
    }
  }
  return removed;
}

function deletePrefixInsensitive(target: Record<string, string>, prefix: string): number {
  const upper = prefix.toUpperCase();
  let count = 0;
  for (const key of Object.keys(target)) {
    if (key.toUpperCase().startsWith(upper)) {
      delete target[key];
      count += 1;
    }
  }
  return count;
}

/**
 * 把 Chromium `session.resolveProxy()` 的返回值解析成 undici 可用的代理 URL（D6.3）。
 *
 * Chromium 返回的是 PAC 风格的**候选列表**（`;` 分隔），实测形态：
 *   - `DIRECT`                        —— 直连
 *   - `PROXY 127.0.0.1:7897`          —— 普通 HTTP 代理（Clash Verge 默认端口，最常见）
 *   - `PROXY a:1;DIRECT`              —— 首选 + 回退
 *   - `HTTPS 127.0.0.1:7897`          —— 连代理本身要走 TLS
 *   - `SOCKS5 127.0.0.1:1080`         —— undici 的 ProxyAgent **不支持** socks
 *
 * 只取第一个可用候选：`PROXY` / `HTTP` → `http://…`，`HTTPS` → `https://…`。
 * `SOCKS*` 与 `DIRECT` 一律跳过；全部不可用时返回 null（含义：**不给子进程注代理**，
 * 于是 server 走自己的自动探测/直连逻辑，见 `apps/server/src/lib/proxy-agent.ts`）。
 *
 * 纯函数、无 electron 依赖 ⇒ 可单测，也避免把 Electron API 带进环境装配模块。
 */
export function parseChromiumProxy(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  for (const candidate of raw.split(';')) {
    const entry = candidate.trim();
    if (entry.length === 0) {
      continue;
    }
    const match = /^(PROXY|HTTP|HTTPS|SOCKS5|SOCKS4|SOCKS)\s+(\S+)$/i.exec(entry);
    if (match === null) {
      continue;
    }
    const [, schemeRaw = '', hostPort = ''] = match;
    if (hostPort.length === 0) {
      continue;
    }
    const scheme = schemeRaw.toUpperCase();
    if (scheme === 'PROXY' || scheme === 'HTTP') {
      return `http://${hostPort}`;
    }
    if (scheme === 'HTTPS') {
      return `https://${hostPort}`;
    }
    // SOCKS*：undici 不支持，继续看下一个候选
  }
  return null;
}

/**
 * 读取或首启生成 `JWT_SECRET`（D6 冻结）。
 *
 * 存储：`<userData>/data/.jwt-secret`，内容为
 * `crypto.randomBytes(32).toString('hex')`（64 个十六进制字符），
 * 权限 `0o600`。
 *
 * @returns `{ secret, generated }` —— `generated` 为 true 表示本次是新生成的。
 */
export function loadOrCreateJwtSecret(
  secretPath: string,
  log: Logger,
): { secret: string; generated: boolean } {
  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    // 只接受十六进制 64 字符（防呆：空文件 / 被截断 / 手工改坏）
    if (/^[0-9a-f]{64}$/i.test(existing)) {
      return { secret: existing, generated: false };
    }
    log(
      'warn',
      `已存在的 JWT 密钥格式不合法（期望 64 位十六进制，实际 ${existing.length} 字符）⇒ 重新生成。` +
        '副作用：所有已签发 token 立即失效，用户需重新登录。',
    );
  } catch {
    // 文件不存在 ⇒ 首启生成，走下方统一分支
  }

  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  // mode 0o600：仅当前用户可读写（D6 冻结）
  fs.writeFileSync(secretPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  log('info', `已生成新的 JWT 密钥并写入 ${secretPath}（0o600）`);
  return { secret, generated: true };
}

/** `buildServerEnv()` 的入参。 */
export interface BuildServerEnvOptions {
  layout: UserDataLayout;
  /** `app.isPackaged` —— 决定 D12.5 的开发态/打包态差异 */
  isPackaged: boolean;
  /** 宿主环境（默认 `process.env`） */
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * D6.3 宿主代理：`main.ts` 从 Chromium 的**系统代理**设置解析出的代理 URL
   * （形如 `http://127.0.0.1:7897`），null / undefined 表示不注入。
   *
   * 只在宿主本来**没有** `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`
   * 时才写入子进程环境 —— 用户显式设过环境变量时以用户为准（`||` 语义）。
   */
  hostProxy?: string | null;
}

/**
 * 装配 D6 冻结表的完整子进程环境变量。
 *
 * 打包态注入（D6 + D12.5 打包列）：
 *   NODE_ENV='production'、PORT='0'、HOST='127.0.0.1'、
 *   WEB_DIST_PATH=<userData>/app-runtime/web-dist、
 *   DB_PATH=<userData>/data/novelmuse.db、
 *   PLUGINS_ROOT=<userData>/plugins、ALLOW_REGISTRATION='true'、
 *   JWT_SECRET=<持久化密钥>、DISABLE_PROXY_DETECT='1'、
 *   HOST_MODE='all'、ELECTRON_RUN_AS_NODE='1'
 *
 * D6.3 宿主代理透传（**开发态与打包态相同**，2026-10-09 新增）：
 *   宿主未设置代理环境变量时，注入 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`
 *   = 系统代理解析结果。原因：双击启动的便携版进程环境里没有 `HTTPS_PROXY`，
 *   而 server 的 undici **不会**读系统代理（只认环境变量），于是 AI 请求直连
 *   被墙服务 ⇒ 面板「测试连接」报「连接被重置」。
 *
 * 开发态差异（D12.5 开发列）：
 *   NODE_ENV='development'；DB_PATH=仓库 `data/novelmuse.db`；
 *   PLUGINS_ROOT **不注入**（走 `local-scanner.ts:77-81` 的默认
 *   `<repo>/apps/plugins`）；WEB_DIST_PATH **不注入**（distIndex 为
 *   undefined，不注册静态回退）；JWT_SECRET **不注入**（dev 下 `jwt.ts`
 *   走文件回退 `<repo>/data/.jwt-secret`）。
 *   `ELECTRON_RUN_AS_NODE` 与打包态相同（`'1'`）。
 *   开发态的 `ALLOW_REGISTRATION` **不处置**（既不注入也不剔除）⇒ 沿用宿主环境；
 *   未设置时 `NODE_ENV='development'` 已使注册默认开放。
 *
 * @param repoRoot 开发态仓库根（由 `paths.ts` 的 `findRepoRoot()` 得到）；
 *   打包态传 null。
 */
export function buildServerEnv(
  options: BuildServerEnvOptions,
  log: Logger,
): ServerEnv {
  const { layout, isPackaged, baseEnv = process.env, hostProxy = null } = options;

  // 从宿主环境起底（D6：子进程继承 process.env 的其余部分）
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }

  // ---- ① 显式删除 D6「不注入」清单（含前缀族）----
  const removed: string[] = [];
  for (const name of NEVER_INJECT_EXACT) {
    if (deleteInsensitive(env, name)) {
      removed.push(name);
    }
  }
  for (const prefix of NEVER_INJECT_PREFIXES) {
    if (deletePrefixInsensitive(env, prefix) > 0) {
      removed.push(`${prefix}*`);
    }
  }
  if (removed.length > 0) {
    log('info', `已从子进程环境剔除 D6 冻结的「不注入」变量：${removed.join(', ')}`);
  }

  // ---- ② 显式设定 D6 冻结表 ----
  env.NODE_ENV = isPackaged ? 'production' : 'development';
  env.PORT = CONST_PORT;
  env.HOST = CONST_HOST;
  env.DISABLE_PROXY_DETECT = CONST_DISABLE_PROXY_DETECT;
  env.HOST_MODE = CONST_HOST_MODE;
  env.ELECTRON_RUN_AS_NODE = CONST_ELECTRON_RUN_AS_NODE;

  let jwtSecretGenerated = false;

  if (isPackaged) {
    env.WEB_DIST_PATH = layout.webDistDir;
    env.DB_PATH = layout.dbPath;
    env.PLUGINS_ROOT = layout.pluginsRoot;
    // 打包态的 NODE_ENV 恒为 'production'，而 apps/server/src/modules/auth.ts:29-32
    // 在 ALLOW_REGISTRATION 未定义时按 `NODE_ENV !== 'production'` 判定 ⇒ 打包态
    // 注册默认关闭。这里显式打开，让桌面版与网页版行为一致（注册页在导航上无条件可见）。
    env.ALLOW_REGISTRATION = 'true';

    const { secret, generated } = loadOrCreateJwtSecret(layout.jwtSecretPath, log);
    env.JWT_SECRET = secret;
    jwtSecretGenerated = generated;
  } else {
    // 开发态：D12.5 逐字 —— PLUGINS_ROOT / WEB_DIST_PATH / JWT_SECRET 均不注入
    if (repoRootOf(options) !== null) {
      env.DB_PATH = path.join(repoRootOf(options) as string, 'data', 'novelmuse.db');
    }
    deleteInsensitive(env, 'PLUGINS_ROOT');
    deleteInsensitive(env, 'WEB_DIST_PATH');
    deleteInsensitive(env, 'JWT_SECRET');
  }

  // ---- ③ 宿主代理透传（D6.3）----
  // 宿主显式设过代理环境变量 ⇒ 上面第 ② 步已原样继承，不覆盖（用户意图优先）。
  if (hostProxy !== null && hostProxy.length > 0) {
    const fromHost = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
    if (fromHost) {
      log('info', '宿主已设置代理环境变量 ⇒ 沿用宿主值，不注入系统代理解析结果。');
    } else {
      env.HTTPS_PROXY = hostProxy;
      env.HTTP_PROXY = hostProxy;
      env.NO_PROXY = env.NO_PROXY || env.no_proxy || DEFAULT_NO_PROXY;
      log(
        'info',
        `已把系统代理解析结果注入子进程（D6.3）：HTTPS_PROXY=${hostProxy}，NO_PROXY=${env.NO_PROXY}`,
      );
    }
  }

  const injectedKeys = Object.keys(env).sort();
  log(
    'info',
    `子进程环境已装配（NODE_ENV=${env.NODE_ENV}，PORT=${env.PORT}，HOST=${env.HOST}，` +
      `HOST_MODE=${env.HOST_MODE}，共 ${injectedKeys.length} 个键）`,
  );

  return { env, jwtSecretGenerated, injectedKeys };
}

/** 从 options 中取开发态仓库根（仅在 `repoRoot` 字段存在时）。 */
function repoRootOf(options: BuildServerEnvOptions): string | null {
  const candidate = (options as { repoRoot?: string | null }).repoRoot;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}