#!/usr/bin/env node
// ============================================================
// 验证：插件层的「模式分离」在**两种宿主模式下**都真实生效
//
// 背景（本次拆分的契约）：
//   · 插件按适用模式物理分目录：apps/plugins/{manual,auto,shared,local}
//       manual → 仅手写台；auto → 仅 AI 写作；shared → 两种都挂；local → 视为 shared
//   · server 启动读 HOST_MODE 环境变量（manual/auto/all）过滤插件集合；
//       被过滤者 **status='skipped'** 仍出现在 /api/health.plugins[]（可区分，不静默消失）
//   · 项目按 project.mode（'manual' | 'auto'）在**路由层**二次门禁：
//       目标插件的 modes 不覆盖该 project.mode → 404 且 code=PLUGIN_MODE_MISMATCH
//       （门禁在 requireAuth 之后；不带 X-Project-Id 不触发）
//
// 为什么必须「真起多个 server」而不是读一个 /api/health：
//   /api/health 只能告诉你"这个进程挂了哪些插件"，证明不了"另一个模式不挂"。
//   只有分别以 HOST_MODE=manual / auto 起进程，才能同时断言
//   「集合包含该有的」与「集合不含不该有的」（后者才是分离的真正风险：泄漏）。
//
// 前置条件：
//   · 用 Node 24（better-sqlite3 编译于 ABI 137；直接 node 会 ERR_DLOPEN_FAILED）
//   · 端口用临时端口（默认 3791/3792/3793），不碰开发中的 3774
//   · 数据库写进 .workbuddy 下的临时目录，跑完删除，**不动 data/ 真库**
//
// 用法：
//   "D:/ruanjian/node.24/node.exe" scripts/verify/verify-plugin-mode-separation.mjs
// 退出码：0 = 全过；1 = 有断言失败（附具体模块定位）
// ============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
// Node 24（better-sqlite3 ABI 137）。可用 VERIFY_NODE 覆盖，找不到就回退当前 node。
const NODE24 = process.env.VERIFY_NODE || 'D:/ruanjian/node.24/node.exe';
const NODE = fs.existsSync(NODE24) ? NODE24 : process.execPath;
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SERVER_CWD = path.join(ROOT, 'apps', 'server');
const SERVER_ENTRY = 'src/index.ts'; // 相对 SERVER_CWD
const REAL_PLUGINS_ROOT = path.join(ROOT, 'apps', 'plugins');

const PORT_MANUAL = Number(process.env.VERIFY_PORT_MANUAL) || 3791;
const PORT_AUTO = Number(process.env.VERIFY_PORT_AUTO) || 3792;
const PORT_CONSTRUCT = Number(process.env.VERIFY_PORT_CONSTRUCT) || 3793;

const TMP_DIR = path.join(ROOT, '.workbuddy', 'tmp-verify-mode');
const PASSWORD = 'Probe1234!';

// ---- 契约常量（与 server-dev t2 实现口径一致）----
// 迁移后：manual={novel.bookscan, worldbuilding}、auto={novel.autowrite}、shared={novel.typography}
// ★ 2026-10-19（AI 写作模块**回仓**）：novel.autowrite 的实现（8 个聊天技能 +
//   状态/流水线路由 + 多代理流水线）已装回仓内，骨架不再 no-op，AUTO_ROUTE 前缀
//   重新注册。t10 剥离期把 (d3)/(d4) 改写为「恒 404 且非模式门禁」，其前提已失效，
//   故本轮**恢复原探针语义**（见下方 d) 段注释）。
const AUTO_ONLY_IDS = ['novel.autowrite'];                     // 仅 AI 写作
const MANUAL_ONLY_IDS = ['novel.worldbuilding', 'novel.bookscan']; // 仅手写台
const SHARED_IDS = ['novel.typography'];                       // 两种模式共享
// 跨模式门禁的探针路由（auto 专属插件 novel.autowrite 的实现路由；回仓后已注册）
const AUTO_ROUTE = '/api/plugins/autowrite/pipeline';

let failed = 0;
const results = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  results.push({ ok, label, detail });
  if (!ok) failed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 找一个空闲端口。
 * ★ 为什么不能写死端口：开发机上 3774/5174 常被占用；写死端口一旦冲突，
 *   server 会 EADDRINUSE 直接退出（不是测试失败，是环境问题），排查成本高。
 */
function findFreePort(preferred) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => {
      const any = net.createServer();
      any.unref();
      any.on('error', reject);
      any.listen(0, '127.0.0.1', () => {
        const p = any.address().port;
        any.close(() => resolve(p));
      });
    });
    srv.listen(preferred, '127.0.0.1', () => srv.close(() => resolve(preferred)));
  });
}

/** 起一个临时 server，轮询 /api/health 直到就绪；返回 { child, port, logPath, health } */
async function startServer(hostMode, preferredPort, extraEnv = {}) {
  const port = await findFreePort(preferredPort);
  const logPath = path.join(TMP_DIR, `server-${hostMode}-${port}.log`);
  const fd = fs.openSync(logPath, 'w');
  const child = spawn(NODE, [TSX, SERVER_ENTRY], {
    cwd: SERVER_CWD,
    env: {
      ...process.env,
      PORT: String(port),
      HOST_MODE: hostMode,
      // 独立临时库：不污染 data/novelmuse.db（各模式各一个，避免互相串）
      DB_PATH: path.join(TMP_DIR, `novelmuse-${hostMode}-${port}.db`),
      NODE_ENV: 'development',
      JWT_SECRET: 'verify-mode-separation-secret',
      // 覆盖仓库 .env 里的 ALLOW_REGISTRATION=false（探针要建临时账号）
      ALLOW_REGISTRATION: 'true',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      ...extraEnv,
    },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    // detached：非 Windows 上把子进程单独成组，收尾按进程树杀
    detached: process.platform !== 'win32',
  });
  fs.closeSync(fd);

  const tail = () => {
    try { return fs.readFileSync(logPath, 'utf8').split('\n').slice(-12).join('\n'); } catch { return '(日志不可读)'; }
  };
  const deadline = Date.now() + 60_000;
  let health = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server(HOST_MODE=${hostMode}) 提前退出，exitCode=${child.exitCode}\n--- 日志尾部 ---\n${tail()}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) { health = await res.json(); break; }
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  if (!health) throw new Error(`server(HOST_MODE=${hostMode}) 60s 内未就绪\n--- 日志尾部 ---\n${tail()}`);
  return { child, port, logPath, health };
}

function stopServer(s) {
  if (!s?.child || s.child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      // 杀整棵进程树：node(tsx cli) → node(loader) → 真实 server。
      // ★ 必须用绝对路径：PATH 上不一定有 taskkill（实测 ENOENT）。
      const k = spawn('C:/Windows/System32/taskkill.exe', ['/PID', String(s.child.pid), '/T', '/F'], { windowsHide: true });
      k.on('error', () => { try { s.child.kill('SIGTERM'); } catch { /* 已退出 */ } });
    } else {
      process.kill(-s.child.pid, 'SIGTERM');
    }
  } catch { /* 已退出 */ }
}

// ---- 带 cookie 的请求工具（临时 server 上注册/登录/建项目/打路由）----
function makeClient(port) {
  let cookie = '';
  return async function req(p, opts = {}) {
    const headers = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) };
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { ...opts, headers });
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, text };
  };
}

/** 在某个临时 server 上：注册→登录→建一个指定 mode 的项目；返回带 cookie 的 req + projectId */
async function provision(port, mode, label) {
  const req = makeClient(port);
  const username = `mode_${label}`;
  let r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password: PASSWORD, displayName: label }) });
  if (r.status === 409) r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password: PASSWORD }) });
  if (r.status >= 400) throw new Error(`[${label}] 注册/登录失败 HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  const proj = await req('/api/projects', { method: 'POST', body: JSON.stringify({ name: `mode-${label}`, mode }) });
  const id = proj.json?.data?.id;
  if (!id) throw new Error(`[${label}] 建项目失败 HTTP ${proj.status}: ${proj.text.slice(0, 200)}`);
  return { req, projectId: id, username };
}

// ---- health 视角：挂载(ok) vs 被过滤(skipped) 必须分开看 ----
// ★ 被 HOST_MODE 过滤掉的插件**不是消失**，而是 status='skipped' 仍可见（server-dev t2 口径）。
//   若不分状态只看 id 是否存在，会把「正确过滤」误判成「泄漏」。
const statusOf = (health, id) => (health?.plugins ?? []).find((p) => p.id === id)?.status;
const mountedIds = (health) => new Set((health?.plugins ?? []).filter((p) => p.status === 'ok').map((p) => p.id));
const skippedIds = (health) => new Set((health?.plugins ?? []).filter((p) => p.status === 'skipped').map((p) => p.id));
const missing = (set, list) => list.filter((id) => !set.has(id));
const present = (set, list) => list.filter((id) => set.has(id));

let manual = null;
let auto = null;
let construct = null;
try {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  console.log('\n===== 启动临时 server（HOST_MODE 过滤）=====');
  console.log(`· HOST_MODE=manual  PORT=${PORT_MANUAL}`);
  manual = await startServer('manual', PORT_MANUAL);
  console.log(`  就绪，插件条目数=${manual.health.plugins?.length ?? 0}`);
  console.log(`· HOST_MODE=auto    PORT=${PORT_AUTO}`);
  auto = await startServer('auto', PORT_AUTO);
  console.log(`  就绪，插件条目数=${auto.health.plugins?.length ?? 0}`);

  const mAll = new Set((manual.health.plugins ?? []).map((p) => p.id));
  const aAll = new Set((auto.health.plugins ?? []).map((p) => p.id));
  const mMounted = mountedIds(manual.health);
  const aMounted = mountedIds(auto.health);
  console.log('\nmanual 已挂载(ok):', [...mMounted].join(', '));
  console.log('manual 被过滤(skipped):', [...skippedIds(manual.health)].join(', ') || '(无)');
  console.log('auto   已挂载(ok):', [...aMounted].join(', '));
  console.log('auto   被过滤(skipped):', [...skippedIds(auto.health)].join(', ') || '(无)');

  // ---- a) manual 模式：挂全部 manual+shared，不挂任何 auto 专属 ----
  console.log('\n===== a) manual 模式 =====');
  check('manual 模式挂载全部 manual 专属插件', missing(mMounted, MANUAL_ONLY_IDS).length === 0,
    missing(mMounted, MANUAL_ONLY_IDS).length ? `未挂载: ${missing(mMounted, MANUAL_ONLY_IDS).join(',')}` : MANUAL_ONLY_IDS.join(','));
  check('manual 模式挂载全部 shared 插件', missing(mMounted, SHARED_IDS).length === 0,
    missing(mMounted, SHARED_IDS).length ? `未挂载: ${missing(mMounted, SHARED_IDS).join(',')}` : SHARED_IDS.join(','));
  check('manual 模式**不挂载**任何 auto 专属插件（如 novel.autowrite）', present(mMounted, AUTO_ONLY_IDS).length === 0,
    present(mMounted, AUTO_ONLY_IDS).length ? `泄漏(已挂载): ${present(mMounted, AUTO_ONLY_IDS).join(',')}` : '无泄漏');
  // 过滤应"可见但不挂载"，而不是静默消失
  check('manual 模式把 auto 专属插件标为 skipped（过滤可见，非消失）',
    AUTO_ONLY_IDS.every((id) => statusOf(manual.health, id) === 'skipped'),
    AUTO_ONLY_IDS.map((id) => `${id}=${statusOf(manual.health, id) ?? '(缺)'}`).join(' '));

  // ---- b) auto 模式：反之 ----
  console.log('\n===== b) auto 模式 =====');
  check('auto 模式挂载全部 auto 专属插件', missing(aMounted, AUTO_ONLY_IDS).length === 0,
    missing(aMounted, AUTO_ONLY_IDS).length ? `未挂载: ${missing(aMounted, AUTO_ONLY_IDS).join(',')}` : AUTO_ONLY_IDS.join(','));
  check('auto 模式挂载全部 shared 插件', missing(aMounted, SHARED_IDS).length === 0,
    missing(aMounted, SHARED_IDS).length ? `未挂载: ${missing(aMounted, SHARED_IDS).join(',')}` : SHARED_IDS.join(','));
  check('auto 模式**不挂载**任何 manual 专属插件（如 worldbuilding/bookscan）', present(aMounted, MANUAL_ONLY_IDS).length === 0,
    present(aMounted, MANUAL_ONLY_IDS).length ? `泄漏(已挂载): ${present(aMounted, MANUAL_ONLY_IDS).join(',')}` : '无泄漏');
  check('auto 模式把 manual 专属插件标为 skipped（过滤可见，非消失）',
    MANUAL_ONLY_IDS.every((id) => statusOf(auto.health, id) === 'skipped'),
    MANUAL_ONLY_IDS.map((id) => `${id}=${statusOf(auto.health, id) ?? '(缺)'}`).join(' '));

  // ---- c) shared 插件两种模式都在 ----
  console.log('\n===== c) shared 插件 =====');
  for (const id of SHARED_IDS) {
    check(`shared 插件 ${id} 在两种模式都挂载`,
      mMounted.has(id) && aMounted.has(id),
      `manual=${statusOf(manual.health, id) ?? '(缺)'} auto=${statusOf(auto.health, id) ?? '(缺)'}`);
  }

  // ---- d) 跨模式路由门禁 ----
  // 语义（server-dev t2）：带 X-Project-Id 时，若 project.mode 不被目标插件 modes 覆盖 → 404 + PLUGIN_MODE_MISMATCH。
  // ★ 关键区分两种「跨模式」：
  //   (d1/d2) 宿主自身 HOST_MODE=manual，根本没挂 autowrite → 该路由不可达，必然 404；
  //   (d3/d4) 宿主挂了 autowrite（auto 宿主），但项目是 manual → 命中**项目模式门禁**，必须 PLUGIN_MODE_MISMATCH。
  //   只有 (d3) 能真正证伪「门禁存在」；只测 (d1) 会把"路由没挂"当成"门禁生效"。
  console.log('\n===== d) 跨模式路由门禁 =====');
  const manualProj = await provision(manual.port, 'manual', 'm');      // manual 宿主 + manual 项目
  const autoProjOnManual = await provision(manual.port, 'auto', 'ma'); // manual 宿主 + auto 项目
  const d1 = await autoProjOnManual.req(AUTO_ROUTE, { headers: { 'x-project-id': autoProjOnManual.projectId } });
  const d2 = await manualProj.req(AUTO_ROUTE, { headers: { 'x-project-id': manualProj.projectId } });
  check('manual 宿主上请求 auto 插件路由 → 404（宿主未挂该插件，路由不可达）',
    d1.status === 404 && d2.status === 404, `auto项目 HTTP ${d1.status} / manual项目 HTTP ${d2.status}`);
  console.log(`  · manual 宿主上的错误码：auto项目=${d1.json?.error?.code ?? '(无)'} manual项目=${d2.json?.error?.code ?? '(无)'}`);

  // ★ 2026-10-19（AI 写作模块回仓）：原 (d3)/(d4) 用 AUTO_ROUTE（/api/plugins/autowrite/pipeline）
  //   证明「auto 宿主 + auto 项目 → 非 404（门禁按 project.mode 判定，非一刀切）」。
  //   t10 剥离期该前缀恒 404（骨架不注册路由），故当时改写为「恒 404 且非模式门禁」。
  //   实现回仓后前缀重新注册，(d3)/(d4) 的**原语义恢复**，且是本文件里**唯一**能用
  //   真实插件路由证伪「门禁存在」的一对（(d1)/(d2) 只能证明「宿主没挂该插件」）：
  //     (d3) auto 宿主 + manual 项目 → 404 + PLUGIN_MODE_MISMATCH（项目模式门禁生效）
  //     (d4) auto 宿主 + auto 项目   → 非 404（门禁按 project.mode 判定，非一刀切）
  const manualProjOnAuto = await provision(auto.port, 'manual', 'am'); // auto 宿主 + manual 项目
  const autoProjOnAuto = await provision(auto.port, 'auto', 'aa');     // auto 宿主 + auto 项目
  const d3 = await manualProjOnAuto.req(AUTO_ROUTE, { headers: { 'x-project-id': manualProjOnAuto.projectId } });
  const d4 = await autoProjOnAuto.req(AUTO_ROUTE, { headers: { 'x-project-id': autoProjOnAuto.projectId } });
  const d3code = d3.json?.error?.code;
  check('auto 宿主 + manual 项目 → 404 且 PLUGIN_MODE_MISMATCH（项目模式门禁生效）',
    d3.status === 404 && d3code === 'PLUGIN_MODE_MISMATCH',
    `manual项目 HTTP ${d3.status} code=${d3code ?? '(无)'}`);
  check('auto 宿主 + auto 项目 → 非 404（门禁按 project.mode 判定，非一刀切）',
    d4.status !== 404,
    `auto项目 HTTP ${d4.status} code=${d4.json?.error?.code ?? '(无)'}`);
  console.log('  · (d3) 拿到 PLUGIN_MODE_MISMATCH 本身就证明该前缀**已注册**（未注册只会是裸 404、无 error.code）。');

  // ---- c2) G2.5 模式门（构造型用例）----
  // 契约（install.ts L154，严格单元素）：declaredSet.size === 1 && declaredSet.has(dirMode)
  //   目录 manual/ + modes ['manual']            → 通过
  //   目录 manual/ + modes ['auto']              → MODE_MISMATCH
  //   目录 manual/ + modes ['manual','shared']   → MODE_MISMATCH（多元素也算不一致）
  //   目录 manual/ + modes 缺省（=['shared']）    → MODE_MISMATCH
  //   未知目录名 unknown/                         → MODE_MISMATCH
  // 为什么必须构造真目录：只有把"目录名"和"manifest.modes"摆成不一致，
  //   才能证明安装门真的在拦，而不是恰好没插件触发。
  console.log('\n===== c2) G2.5 模式门（构造型用例）=====');
  const constructRoot = path.join(TMP_DIR, 'construct');
  const probe = (modeDir, id, modes) => {
    const dir = path.join(constructRoot, modeDir, id);
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    const manifest = { id, name: id, version: '0.1.0', ...(modes ? { modes } : {}) };
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(dir, 'server', 'index.ts'),
      `export const name = ${JSON.stringify(id)};\nexport function apply() { /* 构造型探针：无路由 */ }\n`);
  };
  probe('manual', 'novel.modeprobe', ['auto']);              // 目录/声明不一致
  probe('manual', 'novel.multiprobe', ['manual', 'shared']); // 多元素声明
  probe('manual', 'novel.defprobe', undefined);              // 缺省 = ['shared']，与 manual 目录不符
  probe('manual', 'novel.okprobe', ['manual']);              // 唯一应通过者
  // 注：「未知父目录名 → MODE_MISMATCH」这条由 scanner 无法触发（scanner 只遍历已知模式目录），
  //     已由 packages/core/src/mode.test.ts 的 checkPluginModeConsistency('builtin', …) 单测覆盖，此处不重复。

  construct = await startServer('all', PORT_CONSTRUCT, { PLUGINS_ROOT: constructRoot });
  const cById = new Map((construct.health.plugins ?? []).map((p) => [p.id, p]));
  const expectReject = (id, why) => {
    const p = cById.get(id);
    const errStr = String(p?.error ?? '');
    check(`安装门拒绝 ${id}（${why}）→ status=error 且含 MODE_MISMATCH`,
      !!p && p.status === 'error' && errStr.includes('MODE_MISMATCH'),
      p ? `status=${p.status} error=${errStr.slice(0, 120)}` : '未出现在 health.plugins[]');
  };
  expectReject('novel.modeprobe', "目录 manual 但 modes=['auto']");
  expectReject('novel.multiprobe', "目录 manual 但 modes=['manual','shared']（多元素）");
  expectReject('novel.defprobe', '目录 manual 但 modes 缺省（=[shared]）');
  const okProbe = cById.get('novel.okprobe');
  check('目录 manual + modes=[manual] → 通过（status=ok）',
    okProbe?.status === 'ok', okProbe ? `status=${okProbe.status} error=${okProbe.error ?? '(无)'}` : '未挂载');
} catch (err) {
  check('验证执行未抛异常', false, err instanceof Error ? err.message : String(err));
} finally {
  stopServer(manual);
  stopServer(auto);
  stopServer(construct);
  await sleep(1500);
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* 句柄未释放时忽略 */ }
}

console.log(`\n${'='.repeat(60)}`);
if (failed === 0) {
  console.log('✅ verify-plugin-mode-separation 全过');
} else {
  console.log(`❌ verify-plugin-mode-separation：${failed} 项失败`);
  console.log('   失败项：');
  for (const r of results.filter((x) => !x.ok)) console.log(`     · ${r.label} — ${r.detail}`);
  console.log('   定位：插件集合/过滤 → apps/server/src/plugin/{local-scanner,host}.ts；'
    + '跨模式 404 → apps/server/src/plugin/host.ts 的 X-Project-Id 门禁；'
    + 'G2.5 → packages/core/src/install.ts');
}
process.exit(failed === 0 ? 0 : 1);
