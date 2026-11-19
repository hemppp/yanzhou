#!/usr/bin/env node
/**
 * ============================================================
 * apps/desktop/scripts/check-updater.mjs
 *
 * 更新器自检：发布前跑一次，确认「装了就能检查更新」这条链是通的。
 *
 * 为什么需要它：更新器有三处曾经同时坏掉，且都不报错、只是「点了没反应」：
 *   ① User-Agent 写了中文 ⇒ Node 直接抛 Invalid character in header content，
 *      请求根本发不出去；
 *   ② 没有默认更新源 ⇒ baseUrl 空串 ⇒「检查更新」按钮禁用；
 *   ③ 发布页缺 manifest.json ⇒ 404。
 * 三处都在 Electron 外壳里，应用内更新**修不了自己**，只能靠重装安装包。
 * 所以宁可发布前多跑一条命令，也不要再让用户点一次没反应的按钮。
 *
 * 用法：
 *     node apps/desktop/scripts/check-updater.mjs
 *     node apps/desktop/scripts/check-updater.mjs --offline   # 只做静态检查
 *
 * 退出码 0 = 通过；1 = 有硬错误（阻止发布）。
 * ============================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(__dirname, '..');

const OFFLINE = process.argv.includes('--offline');
const problems = [];
const notes = [];

const fail = (msg) => problems.push(msg);
const note = (msg) => notes.push(msg);

// ---------------------------------------------------------------- 静态检查

/** ① User-Agent 必须是纯 ASCII —— Node 会拒绝含非 ASCII 的 header 值。 */
function checkUserAgent() {
  const file = path.join(DESKTOP, 'src', 'updater', 'http.ts');
  const src = fs.readFileSync(file, 'utf8');

  const m = src.match(/export const USER_AGENT\s*=\s*(['"])(.*?)\1/);
  if (!m) {
    fail('http.ts 未找到 USER_AGENT 常量（header 值应集中定义，避免再次写死中文）');
    return;
  }
  const ua = m[2];
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(ua)) {
    fail(`USER_AGENT 含非 ASCII 字符：${JSON.stringify(ua)} —— Node 会抛 Invalid character in header content`);
  } else {
    note(`USER_AGENT = ${ua}（纯 ASCII ✓）`);
  }

  // 兜底：不允许再有字面量 user-agent 直接写进 request options
  const literals = src.match(/['"]user-agent['"]\s*:\s*(['"])(.*?)\1/g) ?? [];
  for (const lit of literals) {
    const v = lit.match(/:\s*(['"])(.*?)\1/)?.[2] ?? '';
    // eslint-disable-next-line no-control-regex
    if (/[^\x20-\x7e]/.test(v)) fail(`http.ts 里仍有非 ASCII 的 user-agent 字面量：${JSON.stringify(v)}`);
  }
}

/** ② 必须有内置默认更新源，且是 http(s)。 */
function checkDefaultBaseUrl() {
  const file = path.join(DESKTOP, 'src', 'updater', 'config.ts');
  const src = fs.readFileSync(file, 'utf8');

  const m = src.match(/export const DEFAULT_UPDATE_BASE_URL\s*=\s*([\s\S]*?);/);
  if (!m) {
    fail('config.ts 缺少 DEFAULT_UPDATE_BASE_URL —— 首启 baseUrl 会是空串，「检查更新」按钮禁用');
    return null;
  }
  const url = m[1].replace(/['"\s+]/g, '');
  if (!/^https?:\/\//.test(url)) {
    fail(`DEFAULT_UPDATE_BASE_URL 不是 http(s) 地址：${url}`);
    return null;
  }
  note(`默认更新源 = ${url}`);
  return url;
}

/** ③ readConfig 在配置为空时必须回落默认源（而不是返回空串）。 */
function checkReadConfigFallback() {
  const file = path.join(DESKTOP, 'src', 'updater', 'config.ts');
  const src = fs.readFileSync(file, 'utf8');

  // readConfig 函数体
  const start = src.indexOf('export async function readConfig');
  if (start < 0) {
    fail('config.ts 未找到 readConfig');
    return;
  }
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);

  if (!body.includes('DEFAULT_UPDATE_BASE_URL')) {
    fail('readConfig 未回落 DEFAULT_UPDATE_BASE_URL —— 配置为空时仍会得到空串');
    return;
  }
  // 仍然返回空串字面量 ⇒ 回落没覆盖到
  if (/return\s*\{\s*baseUrl:\s*['"]{2}\s*\}/.test(body)) {
    fail("readConfig 里仍有 return { baseUrl: '' } —— 该分支会让「检查更新」失效");
    return;
  }
  note('readConfig 空配置回落内置源 ✓');
}

/** ④ 版本号一致性：desktop / server / web / 根 四处必须相同。 */
function checkVersions() {
  const read = (p) => JSON.parse(fs.readFileSync(path.join(DESKTOP, '..', '..', p), 'utf8')).version;
  const root = read('package.json');
  const desktop = read('apps/desktop/package.json');
  const server = read('apps/server/package.json');
  const web = read('apps/web/package.json');
  const all = { root, desktop, server, web };
  const uniq = new Set(Object.values(all));
  if (uniq.size !== 1) {
    fail(`四处版本号不一致：${Object.entries(all).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  } else {
    note(`版本号一致：${root}`);
  }
  return desktop;
}

/** ⑤ 本地产物：release/updates/ 里的 manifest 与 zip 是否齐（发布前应已生成）。 */
function checkLocalArtifacts(version) {
  const outDir = path.join(DESKTOP, '..', '..', 'release', 'updates');
  const manifestPath = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    note('release/updates/manifest.json 不存在（尚未跑 build-update.mjs；若本次要发布，需先跑）');
    return null;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== version) {
    fail(`release/updates/manifest.json 版本是 ${manifest.version}，与 package.json 的 ${version} 不符`);
  }
  const files = [manifest.app.url, ...manifest.plugins.map((p) => p.url)];
  const missing = files.filter((f) => !fs.existsSync(path.join(outDir, f)));
  if (missing.length) fail(`release/updates/ 缺少产物：${missing.join(', ')}`);
  else note(`本地产物齐全：${files.length} 个文件`);
  return manifest;
}

// ---------------------------------------------------------------- 联网检查

function request(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(
      parsed,
      // 故意用与产品一致的值：这条命令要能复现「UA 不合法」这类问题
      { method: 'HEAD', headers: { 'user-agent': 'Yanzhou-Updater/1.0', accept: '*/*' } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('重定向过多'));
          return request(new URL(res.headers.location, parsed).toString(), redirectsLeft - 1).then(resolve, reject);
        }
        res.resume();
        resolve({ status, url });
      },
    );
    req.setTimeout(20_000, () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.end();
  });
}

/** ⑥ 线上 manifest 是否可达、版本是否比本地新、产物是否都在。 */
async function checkRemote(baseUrl, localVersion) {
  const manifestUrl = `${baseUrl.replace(/\/+$/, '')}/manifest.json`;
  let raw;
  try {
    raw = await new Promise((resolve, reject) => {
      const parsed = new URL(manifestUrl);
      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.request(
        parsed,
        { method: 'GET', headers: { 'user-agent': 'Yanzhou-Updater/1.0', accept: '*/*' } },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            return checkRemote(new URL(res.headers.location, parsed).toString().replace(/\/manifest\.json$/, ''), localVersion)
              .then(() => resolve(null), reject);
          }
          if (status < 200 || status >= 300) {
            res.resume();
            return reject(new Error(`HTTP ${status}`));
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        },
      );
      req.setTimeout(20_000, () => req.destroy(new Error('超时')));
      req.on('error', reject);
      req.end();
    });
  } catch (e) {
    fail(`线上 manifest 拉取失败：${manifestUrl} — ${e.message}（发布页缺 manifest.json？）`);
    return;
  }
  if (raw === null) return; // 重定向分支已递归检查

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    fail(`线上 manifest 不是合法 JSON：${e.message}`);
    return;
  }
  note(`线上版本 = ${manifest.version}（本地 ${localVersion}）`);

  // 产物可达性（HEAD，不下载）
  const base = baseUrl.replace(/\/+$/, '');
  const targets = [manifest.app.url, ...(manifest.plugins ?? []).map((p) => p.url)];
  for (const t of targets) {
    const abs = /^https?:\/\//.test(t) ? t : `${base}/${t.replace(/^\/+/, '')}`;
    try {
      const r = await request(abs);
      if (r.status >= 400) fail(`线上产物不可达：${t} → HTTP ${r.status}`);
    } catch (e) {
      fail(`线上产物不可达：${t} — ${e.message}`);
    }
  }
  note(`线上产物 ${targets.length} 个全部可达 ✓`);
}

// ---------------------------------------------------------------- main

async function main() {
  console.log('[check-updater] 更新器自检');
  console.log(`  目录：${DESKTOP}`);
  console.log(`  模式：${OFFLINE ? '离线（只做静态检查）' : '联网（含线上 manifest 与产物可达性）'}`);
  console.log('');

  checkUserAgent();
  const baseUrl = checkDefaultBaseUrl();
  checkReadConfigFallback();
  const version = checkVersions();
  checkLocalArtifacts(version);

  if (!OFFLINE && baseUrl) {
    console.log('[check-updater] 联网检查中…');
    await checkRemote(baseUrl, version);
  }

  console.log('');
  for (const n of notes) console.log(`  ✓ ${n}`);
  if (problems.length) {
    console.log('');
    for (const p of problems) console.log(`  ✘ ${p}`);
    console.log('');
    console.log(`[check-updater] 失败 ${problems.length} 项`);
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log('[check-updater] 全部通过 ✔');
}

void main();
