#!/usr/bin/env node
// ============================================================
// NovelMuse 真实 AI 链路端到端验证 —— e2e-ai-chain.mjs
//
// 与 e2e-full / e2e-mode-separation 的区别：那两个是**浏览器级**（CDP）验证 UI 渲染；
// 本脚本是**纯 HTTP** 的真实链路验证 —— 真的把请求打到模型上，验证「配置 → 连通性 →
// 真实生成 → 流式 → 业务动作 → 失败降级 → 复原」整条链，而不是只测 mock 或只测路由注册。
//
// 为什么必须真机跑（单测证明不了的部分）：
//   · 用户级配置 loader 是**惰性注册**的：库里配了模型但 loader 没注册时，链路会**静默**
//     回退到服务端环境变量配置（见 apps/server/src/ai/user-config-loader.ts 文件头踩坑记录）。
//     单测钉的是「注册表按 userId 过滤」这种纯函数，钉不住「这次请求到底用了哪套配置」。
//   · 降级行为（无可用 key 时是 5xx 白屏崩溃，还是结构化错误 + 进程存活）只有真打模型才看得见。
//
// 覆盖的 9 项交付：
//   1) Cookie 登录（HttpOnly `novelmuse_token`；用 Bearer 会 401，故全程只带 Cookie）
//   2) GET  /api/ai/config        → apiKeyConfigured=true 且 _source=user_db
//   3) POST /api/ai/config/test   → connected=true，记录 latencyMs
//   4) 建 auto 项目 → POST /api/ai/chat → data.response 非空且不是错误串，打印前 80 字
//   5) POST /api/ai/chat-stream   → SSE 收到 ≥1 数据事件后正常结束
//   6) 业务 AI 动作 ≥2 个：/check-outline、/analyze-style、/generate-character
//   7) 降级验证：故意错误 key → 结构化错误（有 error.code 或等价契约）、非 5xx 白屏、
//      /api/health 仍 200；测完**强制还原**可用配置并回读确认
//   8) 自清理测试项目（含前缀残留清扫）
//   9) 真实退出码 0/1/2 —— 绝不假绿
//
// 用法：
//   node scripts/e2e/e2e-ai-chain.mjs
//
// 退出码：
//   0 = 全部断言通过
//   1 = 有断言失败（含模型调用最终失败、降级断言不成立、配置未复原）
//   2 = 环境不可用（server 未起 / 登录失败 / 用户级 AI 配置缺失 / 拿不到还原用的 key）
//       —— 此时**不做任何写入**（不写配置、不建项目），直接退出
//
// 可覆盖的环境变量（默认值即本机已跑通的那套）：
//   E2E_API_BASE      默认 http://127.0.0.1:3774
//   E2E_USER          默认 admin
//   E2E_PASS          默认 Admin1234!
//   E2E_AI_BASE_URL   默认 https://dadfafwada.dpdns.org/v1
//   E2E_AI_MODEL      默认 hy3-x
//   E2E_AI_PROVIDER   默认 openai
//   E2E_AI_KEY        默认从仓库根 .env 的 OPENAI_API_KEY 读（日志只打印 ***+后4位）
//   E2E_TIMEOUT_MS    默认 180000（单次模型调用超时，≥120s）
//   E2E_SSE_TIMEOUT_MS 默认 180000
//   E2E_SKIP_DEGRADE=1  跳过降级用例（仅调试用；跳过会被记为**未通过**，不谎报全绿）
//   E2E_KEEP_PROJECT=1  保留测试项目（仅调试用）
//
// 副作用与还原承诺：
//   · 只写「用户自己的 AI 配置」这一处，且**仅在降级用例期间**注入错误 key；
//     无论成功 / 断言失败 / 抛异常 / Ctrl+C，finally 都会用原 baseUrl+model+provider+原 key 重写，
//     并 GET 回读确认；回读不一致 → 记失败 → EXIT=1。
//   · 只创建 1 个以 `e2e-ai-chain-` 开头的 auto 项目，结束时删除并复核无残留。
// ============================================================

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const RUN_DIR = resolve(REPO_ROOT, '.workbuddy', 'e2e-run');

const CFG = {
  apiBase: (process.env.E2E_API_BASE || 'http://127.0.0.1:3774').replace(/\/+$/, ''),
  user: process.env.E2E_USER || 'admin',
  pass: process.env.E2E_PASS || 'Admin1234!',
  aiBaseUrl: process.env.E2E_AI_BASE_URL || 'https://dadfafwada.dpdns.org/v1',
  aiModel: process.env.E2E_AI_MODEL || 'hy3-x',
  aiProvider: process.env.E2E_AI_PROVIDER || 'openai',
  timeoutMs: Number(process.env.E2E_TIMEOUT_MS || 180_000),
  sseTimeoutMs: Number(process.env.E2E_SSE_TIMEOUT_MS || 180_000),
  skipDegrade: process.env.E2E_SKIP_DEGRADE === '1',
  keepProject: process.env.E2E_KEEP_PROJECT === '1',
};

const PROJECT_PREFIX = 'e2e-ai-chain-';
const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const PROJECT_NAME = `${PROJECT_PREFIX}${STAMP}`;
const BAD_KEY = 'sk-e2e-degrade-invalid-key-0000';

// ---------- 日志（stdout + 落盘，便于事后核对证据）----------
let LOG_PATH = null;
try {
  mkdirSync(RUN_DIR, { recursive: true });
  LOG_PATH = resolve(RUN_DIR, `e2e-ai-chain-${STAMP}.log`);
  writeFileSync(LOG_PATH, `# e2e-ai-chain run ${new Date().toISOString()}\n`, 'utf8');
} catch { /* 日志落盘失败不影响断言 */ }

function log(line = '') {
  console.log(line);
  if (LOG_PATH) { try { appendFileSync(LOG_PATH, line + '\n', 'utf8'); } catch { /* ignore */ } }
}

// ---------- 断言 ----------
const results = [];
let failed = 0;

function check(label, ok, detail = '') {
  const mark = ok ? '✓' : '✗';
  log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`);
  results.push({ ok: Boolean(ok), label, detail });
  if (!ok) failed += 1;
  return Boolean(ok);
}

/** 环境不可用：明确报错并退出 2（不写任何东西、不计入断言失败） */
async function envFail(reason, hint = '') {
  log('');
  log(`❌ 环境不可用：${reason}`);
  if (hint) log(`   ${hint}`);
  log(`EXIT=2`);
  await exitNow(2);
}

/**
 * ★ Windows 上的坑：undici 的 keep-alive socket 还活着时直接 `process.exit()`
 *   会触发 libuv abort（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`），
 *   真实退出码变成 0xC0000409 / -1073740791 而**不是**我们想要的 2。
 *   已实测复现 4/4；先关掉全局 dispatcher 再退出则 4/4 干净拿到 2。
 *   故所有退出路径统一走这里，保证「退出码 == 真实退出码」。
 */
async function exitNow(code) {
  try {
    const { getGlobalDispatcher } = await import('undici');
    await getGlobalDispatcher().close();
  } catch { /* 非 undici 环境 / 已关闭 / 无依赖 —— 忽略即可 */ }
  process.exit(code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- key 读取（绝不回显完整 key）----------
function readEnvKey() {
  const explicit = (process.env.E2E_AI_KEY || '').trim();
  if (explicit) return explicit;
  try {
    const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
    return (env.match(/^OPENAI_API_KEY=(.*)$/m)?.[1] || '').trim();
  } catch {
    return '';
  }
}
/** 只用于日志：绝不打完整 key */
const hintOf = (k) => (k ? '***' + k.slice(-4) : '(空)');

// ---------- HTTP ----------
let cookie = '';
async function req(path, { method = 'GET', body, headers = {}, timeoutMs = 30_000, raw = false } = {}) {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(CFG.apiBase + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      signal: ac.signal,
    });
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    if (raw) return { status: res.status, res };
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON（SSE / HTML）*/ }
    return { status: res.status, json, text, ct: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * 消费 SSE：把 `data:` 行解析成事件数组。
 * ★ 收到 `{done:true}` / `{error:true}` 就主动收敛（避免为等连接关闭而空耗），
 *   并把「主动收敛」与「超时」区分开 —— 否则正常结束会被误判成超时。
 */
async function sse(path, body, timeoutMs) {
  const ac = new AbortController();
  let timedOut = false;
  let stoppedAfterTerminal = false;
  const tid = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const events = [];
  let status = 0, ct = '', readErr = null;
  try {
    const res = await fetch(CFG.apiBase + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    status = res.status;
    ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
      const text = await res.text();
      return { status, ct, events, text, sse: false, timedOut, readErr, stoppedAfterTerminal };
    }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue; // 注释行（: keepalive）与 event:/id: 直接跳过
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { ev = { __unparsed: payload.slice(0, 200) }; }
        events.push(ev);
        if (ev && (ev.done === true || ev.error === true)) {
          stoppedAfterTerminal = true;
          ac.abort();
        }
      }
    }
  } catch (e) {
    if (e?.name === 'AbortError') {
      // 主动收敛（正常）或超时（异常）——由 timedOut / stoppedAfterTerminal 区分
      if (!timedOut && !stoppedAfterTerminal) readErr = e;
    } else {
      readErr = e;
    }
  } finally {
    clearTimeout(tid);
  }
  return { status, ct, events, sse: true, timedOut, readErr, stoppedAfterTerminal };
}

/** 模型偶发失败允许重试；`fn` 返回 {ok, detail, ...} 时不 ok 即重试 */
async function withRetry(label, attempts, fn) {
  let last = { ok: false, detail: '未执行' };
  for (let i = 1; i <= attempts; i += 1) {
    try {
      last = await fn(i);
      if (last?.ok) return last;
      log(`   … ${label} 第 ${i}/${attempts} 次未达标：${last?.detail ?? '无细节'}`);
    } catch (e) {
      last = { ok: false, detail: `${e?.name || 'Error'}: ${e?.message || String(e)}` };
      log(`   … ${label} 第 ${i}/${attempts} 次抛错：${last.detail}`);
    }
    if (i < attempts) await sleep(2500);
  }
  return last;
}

/** 模型失败时可能把错误文本当成回复塞进 data.response —— 这些串不算「真实生成」 */
const ERROR_STRING_PATTERNS = [
  /^AI API 错误/,
  /^AI 请求超时/,
  /^AI 流式请求超时/,
  /^AI 服务暂时不可用/,
  /^请求超时/,
  /^无法解析域名/,
  /^连接被拒绝/,
  /^响应体为空/,
  /^流式对话失败/,
  /^未知错误/,
  /^请求已取消/,
];
const looksLikeErrorString = (s) =>
  !s || !s.trim() || ERROR_STRING_PATTERNS.some((re) => re.test(s.trim()));

const preview = (s, n = 80) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

// ---------- 清理登记（配置还原优先于项目删除）----------
const cleanupTasks = [];
let cleanedUp = false;
async function runCleanup(reason) {
  if (cleanedUp) return;
  cleanedUp = true;
  log('');
  log(`— 清理（${reason}）—`);
  for (const task of cleanupTasks) {
    try { await task(); } catch (e) { log(`   ⚠ 清理步骤异常：${e?.message || e}`); }
  }
}

// ★ 兜底：任何未捕获异常 / Ctrl+C 都必须先还原配置与删项目，
//   否则队友会拿到一个「AI 配置被写成坏 key」的环境（这是最坏的副作用）。
let exiting = false;
async function emergencyExit(code, why) {
  if (exiting) return;
  exiting = true;
  log('');
  log(`⚠ 异常收尾（${why}）`);
  await runCleanup(`异常：${why}`);
  log(`EXIT=${code}`);
  await exitNow(code);
}
process.on('uncaughtException', (e) => { void emergencyExit(1, `uncaughtException: ${e?.message || e}`); });
process.on('unhandledRejection', (e) => { void emergencyExit(1, `unhandledRejection: ${e?.message || e}`); });
process.on('SIGINT', () => { void emergencyExit(1, 'SIGINT（用户中断）'); });
process.on('SIGTERM', () => { void emergencyExit(1, 'SIGTERM'); });

// ============================================================
// 0) 前置：server 存活 + 登录（失败一律 EXIT=2，且不写任何东西）
// ============================================================
log('============================================================');
log('NovelMuse 真实 AI 链路端到端验证（e2e-ai-chain）');
log(`server=${CFG.apiBase} · user=${CFG.user} · 期望模型=${CFG.aiModel} · 项目=${PROJECT_NAME}`);
if (LOG_PATH) log(`日志：${LOG_PATH}`);
log('============================================================');
log('');

log('【0】前置检查');
let health = null;
try {
  health = await req('/api/health', { timeoutMs: 15_000 });
} catch (e) {
  await envFail(`/api/health 请求失败（${e?.message || e}）`, `先起 server：pnpm --filter @novel/server dev（或 start-dev.cmd），监听 ${CFG.apiBase}`);
}
if (health?.status !== 200 || health?.json?.status !== 'ok') {
  await envFail(`/api/health 非 200/ok（HTTP ${health?.status} · status=${health?.json?.status}）`);
}
check('server 存活且 /api/health 200/ok', true, `HTTP ${health.status} · status=${health.json.status} · database=${health.json.database} · 插件 ${health.json.plugins?.length ?? '?'} 个`);

const login = await req('/api/auth/login', {
  method: 'POST',
  body: { username: CFG.user, password: CFG.pass },
  timeoutMs: 20_000,
});
if (login.status !== 200 || !cookie) {
  await envFail(
    `登录失败（HTTP ${login.status}${login.json?.error?.code ? ` · ${login.json.error.code}` : ''}）`,
    `账号 ${CFG.user} 是否可用？可用 E2E_USER / E2E_PASS 覆盖。`,
  );
}
// ★ 认证走 HttpOnly Cookie：断言我们拿到的是 Cookie 而不是 Bearer
const cookieNames = cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean);
check('Cookie 登录成功（HttpOnly 会话）', cookieNames.length > 0 && cookie.includes('novelmuse_token'), `HTTP ${login.status} · cookie=[${cookieNames.join(', ')}] · user=${login.json?.data?.user?.username}`);

// ---------- 还原用的原 key（拿不到就不敢做降级注入）----------
const RESTORE_KEY = readEnvKey();
if (!RESTORE_KEY) {
  await envFail(
    '拿不到还原用的真实 key（.env 的 OPENAI_API_KEY 为空）',
    '降级用例会临时写入错误 key，没有原 key 就无法安全还原 —— 故直接退出，不做任何写入。可用 E2E_AI_KEY 覆盖。',
  );
}

// ============================================================
// 1) 配置链路：GET /api/ai/config
// ============================================================
log('');
log('【1】配置链路 GET /api/ai/config');
const cfgRes = await req('/api/ai/config', { timeoutMs: 30_000 });
check('GET /api/ai/config 返回 200 且 success=true', cfgRes.status === 200 && cfgRes.json?.success === true, `HTTP ${cfgRes.status}`);
const cfgData = cfgRes.json?.data ?? {};
check('apiKeyConfigured=true（用户级 key 已配置）', cfgData.apiKeyConfigured === true, `apiKeyConfigured=${cfgData.apiKeyConfigured} · apiKeyHint=${cfgData.apiKeyHint || '(空)'}`);
check('_source=user_db（走用户库配置，而非 env 回落）', cfgData._source === 'user_db', `_source=${cfgData._source}${cfgData.label ? ` · label=${cfgData.label}` : ''}`);
check('baseUrl / model / provider 与期望一致', cfgData.baseUrl === CFG.aiBaseUrl && cfgData.model === CFG.aiModel && cfgData.provider === CFG.aiProvider, `baseUrl=${cfgData.baseUrl} · model=${cfgData.model} · provider=${cfgData.provider}`);

// 记录原始配置，供 finally 还原与回读比对
const ORIGINAL = {
  baseUrl: cfgData.baseUrl ?? '',
  model: cfgData.model ?? '',
  provider: cfgData.provider ?? 'openai',
  apiKeyHint: cfgData.apiKeyHint ?? '',
  source: cfgData._source ?? '',
};
if (ORIGINAL.source !== 'user_db' || ORIGINAL.baseUrl !== CFG.aiBaseUrl) {
  log(`   ⚠ 原始配置与期望不同（source=${ORIGINAL.source}）——后续模型断言很可能失败，但脚本会如实报告，不会跳过。`);
}

// 还原承诺：无论如何都要跑
cleanupTasks.push(async () => {
  log('   还原 AI 配置 → 原 baseUrl + 原 key');
  const r = await req('/api/ai/config', {
    method: 'POST',
    body: { baseUrl: ORIGINAL.baseUrl || CFG.aiBaseUrl, apiKey: RESTORE_KEY, model: ORIGINAL.model || CFG.aiModel, provider: ORIGINAL.provider || CFG.aiProvider },
    timeoutMs: 60_000,
  });
  const back = await req('/api/ai/config', { timeoutMs: 30_000 });
  const d = back.json?.data ?? {};
  const ok = r.status === 200 && back.status === 200 && d.baseUrl === (ORIGINAL.baseUrl || CFG.aiBaseUrl) && d._source === 'user_db';
  log(`   回读确认：baseUrl=${d.baseUrl} · model=${d.model} · apiKeyHint=${d.apiKeyHint} · _source=${d._source} · ${ok ? '已还原' : '★ 未还原'}`);
  if (!ok) {
    // 还原失败是最严重的情况：必须让退出码变红
    check('AI 配置已还原为可用状态（回读确认）', false, `写回 HTTP ${r.status} · 回读 HTTP ${back.status} · baseUrl=${d.baseUrl} · _source=${d._source}`);
  } else {
    check('AI 配置已还原为可用状态（回读确认）', true, `baseUrl=${d.baseUrl} · model=${d.model} · apiKeyHint=${d.apiKeyHint} · _source=${d._source}`);
  }
});

// ============================================================
// 2) 连通性：POST /api/ai/config/test
// ============================================================
log('');
log('【2】连通性 POST /api/ai/config/test');
const testRes = await withRetry('config/test', 2, async () => {
  const r = await req('/api/ai/config/test', { method: 'POST', body: {}, timeoutMs: CFG.timeoutMs });
  const d = r.json?.data ?? {};
  return { ok: r.status === 200 && r.json?.success === true && d.connected === true, detail: `HTTP ${r.status} · ${JSON.stringify(r.json).slice(0, 200)}`, r, d };
});
{
  const d = testRes.d ?? {};
  const latency = d.latencyMs;
  check('POST /api/ai/config/test connected=true', testRes.ok === true, `HTTP ${testRes.r?.status} · connected=${d.connected} · latencyMs=${latency} · response="${preview(d.response, 40)}"`);
  check('连通性延迟已记录（latencyMs 为有效数字）', typeof latency === 'number' && latency > 0, `latencyMs=${latency}`);
  if (d.error) log(`   上游错误信息：${d.error}`);
}

// ============================================================
// 3) 建 auto 项目（AI 写作框架）
// ============================================================
log('');
log('【3】建测试项目（mode=auto）');
const projRes = await req('/api/projects', {
  method: 'POST',
  body: { name: PROJECT_NAME, mode: 'auto', genre: '悬疑推理' },
  timeoutMs: 30_000,
});
const projectId = projRes.json?.data?.id;
if (projRes.status !== 201 || !projectId) {
  check('创建 auto 测试项目', false, `HTTP ${projRes.status} · ${JSON.stringify(projRes.json).slice(0, 200)}`);
  await runCleanup('建项目失败，提前收尾');
  log(`EXIT=${failed > 0 ? 1 : 0}`);
  await exitNow(failed > 0 ? 1 : 0);
}
check('创建 auto 测试项目', true, `HTTP ${projRes.status} · id=${projectId} · mode=${projRes.json.data.mode} · name=${projRes.json.data.name}`);

// ★ 产品缺陷（已上报 task-5，冷调复现 3/3）：新建项目后**冷调** POST /api/ai/check-outline
//   会 500 —— 项目库（每本书一个 .db）是惰性创建的，而 check-outline 直接读 outline 表，
//   未建库时 BaseService.requireDb 抛「[OutlineNodes] 项目库未初始化」→ 路由 catch 成 500。
//   根因在 server 侧 resolveAuthorizedProject 未调 initProjectDb，**不在本脚本**。
//   ⇒ 本脚本**保持冷调语义**（不加预热回避缺陷）：下面【6】里那次 check-outline 调用
//     就是全新项目的第一次调用，它 500 就如实报失败（EXIT=1），并在输出里标注「待 task-5 修复」。
//     预热后就会变 200 —— 那种「顺序依赖」的绿是假绿，本脚本明确拒绝。
cleanupTasks.push(async () => {
  if (CFG.keepProject) { log(`   （E2E_KEEP_PROJECT=1）保留项目 ${projectId} 不删`); return; }
  log(`   删除测试项目 ${projectId}`);
  const del = await req(`/api/projects/${projectId}`, { method: 'DELETE', timeoutMs: 30_000 });
  const gone = !((await req('/api/projects', { timeoutMs: 30_000 })).json?.data ?? []).some((p) => p.id === projectId);
  log(`   DELETE HTTP ${del.status} · 该项目已消失=${gone}`);

  // ★ 兜底清扫：只清**陈旧**残留（上次被 Ctrl+C / 崩溃打断留下的），
  //   绝不碰「新鲜」的同前缀项目 —— 那可能是**另一个并发跑的队友**正在用的项目。
  //   实测教训：早先按前缀无差别清扫时，并发两次运行会互删对方的活项目，
  //   导致 chat-stream / check-outline 莫名 404（假红），并污染队友环境。
  const STALE_MS = Number(process.env.E2E_STALE_PROJECT_MS || 10 * 60_000);
  const now = Date.now();
  let swept = 0;
  const list = await req('/api/projects', { timeoutMs: 30_000 });
  for (const p of (list.json?.data ?? []).filter((x) => String(x.name || '').startsWith(PROJECT_PREFIX))) {
    if (p.id === projectId) continue; // 本次的已在上面删掉
    const age = typeof p.createdAt === 'number' ? now - p.createdAt : 0;
    if (age < STALE_MS) {
      log(`   跳过新鲜同前缀项目 ${p.name}（${Math.round(age / 1000)}s 前创建，可能是并发运行中，不动）`);
      continue;
    }
    const d = await req(`/api/projects/${p.id}`, { method: 'DELETE', timeoutMs: 30_000 });
    log(`   清扫陈旧残留 ${p.name}（${p.id}，${Math.round(age / 60_000)} 分钟前）→ HTTP ${d.status}`);
    swept += 1;
  }

  const after = await req('/api/projects', { timeoutMs: 30_000 });
  const stale = (after.json?.data ?? []).filter(
    (p) => String(p.name || '').startsWith(PROJECT_PREFIX) && (typeof p.createdAt !== 'number' || now - p.createdAt >= STALE_MS),
  );
  check('测试项目已删除且无陈旧残留', gone && stale.length === 0, `DELETE HTTP ${del.status} · 额外清扫 ${swept} 个 · 陈旧残留 ${stale.length} 个${stale.length ? `：${stale.map((p) => p.name).join(', ')}` : ''}`);
});

// ============================================================
// 4) 真实生成：POST /api/ai/chat
// ============================================================
log('');
log('【4】真实生成 POST /api/ai/chat（simple 模式，真打模型）');
const chatRes = await withRetry('ai/chat', 2, async () => {
  const t0 = Date.now();
  const r = await req('/api/ai/chat', {
    method: 'POST',
    body: { projectId, userMessage: '只回复两个字：可用', simple: true },
    timeoutMs: CFG.timeoutMs,
  });
  const resp = r.json?.data?.response;
  const ok = r.status === 200 && r.json?.success === true && typeof resp === 'string' && !looksLikeErrorString(resp);
  return { ok, detail: `HTTP ${r.status} · response="${preview(resp, 80)}"`, r, resp, ms: Date.now() - t0 };
});
{
  const resp = chatRes.resp;
  const okShape = chatRes.r?.status === 200 && chatRes.r?.json?.success === true && typeof resp === 'string' && resp.trim().length > 0;
  check('POST /api/ai/chat 返回 success=true 且 data.response 非空', okShape, `HTTP ${chatRes.r?.status} · 耗时 ${chatRes.ms}ms · response 长度 ${typeof resp === 'string' ? resp.length : 'N/A'}`);
  check('data.response 不是错误串（是模型真实回复）', typeof resp === 'string' && !looksLikeErrorString(resp), `response 前 80 字："${preview(resp, 80)}"`);
  log(`   ★ 模型真实回复（前 80 字）：${preview(resp, 80)}`);
}

// ============================================================
// 5) 流式链路：POST /api/ai/chat-stream（SSE）
// ============================================================
log('');
log('【5】流式链路 POST /api/ai/chat-stream（SSE）');
const streamRes = await withRetry('ai/chat-stream', 2, async () => {
  const r = await sse('/api/ai/chat-stream', { projectId, userMessage: '只回复两个字：可用', simple: true }, CFG.sseTimeoutMs);
  const chunks = r.events.filter((e) => typeof e?.chunk === 'string' && e.chunk.length > 0);
  const text = chunks.map((e) => e.chunk).join('');
  const errored = r.events.find((e) => e?.error === true);
  const ok = r.status === 200 && r.sse && r.events.length >= 1 && !errored && !r.timedOut && (r.stoppedAfterTerminal || r.readErr === null);
  return { ok, detail: `HTTP ${r.status} · 事件 ${r.events.length} · 正文片段 ${chunks.length} · timedOut=${r.timedOut} · error=${errored ? errored.message : '无'}`, r, chunks, text, errored };
});
{
  const r = streamRes.r ?? {};
  check('chat-stream 返回 text/event-stream', r.status === 200 && r.sse === true, `HTTP ${r.status} · content-type=${r.ct || '(无)'}`);
  check('SSE 收到 ≥1 个数据事件', (r.events?.length ?? 0) >= 1, `数据事件 ${r.events?.length ?? 0} 个`);
  check('流正常结束（未超时、无 error 事件、读到终止标记）', !r.timedOut && !streamRes.errored && (r.stoppedAfterTerminal === true || r.readErr === null), `timedOut=${r.timedOut} · 终止标记=${r.stoppedAfterTerminal === true} · 读错误=${r.readErr?.message || '无'} · error 事件=${streamRes.errored?.message || '无'}`);
  const chunks = streamRes.chunks ?? [];
  check('流式正文累计非空且不是错误串', chunks.length >= 1 && !looksLikeErrorString(streamRes.text), `正文片段 ${chunks.length} 个 · 累计 ${streamRes.text?.length ?? 0} 字 · 前 80 字："${preview(streamRes.text, 80)}"`);
  log(`   ★ 流式累计正文（前 80 字）：${preview(streamRes.text, 80)}`);
}

// ============================================================
// 6) 业务 AI 动作（≥2 个）
// ============================================================
log('');
log('【6】业务 AI 动作');

// 6a) /check-outline —— **冷调**（全新项目的第一次调用），保持缺陷可见
{
  const r = await req('/api/ai/check-outline', { method: 'POST', body: { projectId }, timeoutMs: 30_000 });
  const d = r.json?.data ?? {};
  const ok = r.status === 200 && r.json?.success === true && typeof d.hasOutline === 'boolean';
  check('[/check-outline] 冷调返回结构合法（data.hasOutline 为 boolean）', ok, `HTTP ${r.status} · data=${JSON.stringify(d).slice(0, 120)}`);
  if (!ok) {
    log('   ★ 已知产品缺陷（已上报 task-5，冷调复现 3/3）：全新项目首次调 check-outline 会 500。');
    log('     根因：项目库（每本书一个 .db）惰性创建，check-outline 直接读 outline 表 →');
    log('     BaseService.requireDb 抛「[OutlineNodes] 项目库未初始化」→ 路由 catch 成 500。');
    log('     修复点在 server 侧（resolveAuthorizedProject / checkOutlineExists 先确保建库），不在本脚本。');
    log('     ⇒ 本脚本**保持冷调语义**，此条如实记失败（EXIT=1），待 task-5 修复后自然转绿。');
    log('     （预热后再调会变 200 —— 那种顺序依赖的绿是假绿，本脚本明确拒绝。）');
  }
}

// 6b) /analyze-style（simple）—— 真打模型
{
  const styleText = '他推开门。风灌进来。灯灭了。他站在原地，没有动。走廊尽头传来脚步声，一下，两下，停住了。';
  const styleRes = await withRetry('ai/analyze-style', 2, async () => {
    const r = await req('/api/ai/analyze-style', {
      method: 'POST',
      body: { referenceText: styleText, simple: true },
      timeoutMs: CFG.timeoutMs,
    });
    const d = r.json?.data ?? {};
    const ok = r.status === 200 && r.json?.success === true && !!d.sentenceLength && !!d.perspective && !!d.dialogueStyle && !!d.paragraphLength;
    return { ok, detail: `HTTP ${r.status} · ${JSON.stringify(r.json).slice(0, 200)}`, r, d };
  });
  const d = styleRes.d ?? {};
  // 注意：这里只断言「结构齐备」（端点契约），**不断言**字段有实质内容 ——
  // 实测 hy3-x 是推理模型，其推理占满 max_tokens 后 content 为空，style-agent 会
  // 静默回落成占位默认值（average=0 / person=第三人称有限）。那是「真打模型但结果无信息」，
  // 结构合法但内容空洞，故单列一条诊断（见下），避免把它当成"通过"的假绿。
  const shapeOk =
    styleRes.r?.status === 200 &&
    styleRes.r?.json?.success === true &&
    d.sentenceLength && typeof d.sentenceLength === 'object' &&
    d.perspective && typeof d.perspective === 'object' &&
    d.dialogueStyle && typeof d.dialogueStyle === 'object' &&
    d.paragraphLength && typeof d.paragraphLength === 'object';
  check('[/analyze-style] 返回结构合法（SimplifiedStyleResult 四段齐备）', shapeOk, `HTTP ${styleRes.r?.status} · avgLen=${d.sentenceLength?.average} · complexity=${d.sentenceLength?.complexity} · person=${d.perspective?.person} · dialogue=${d.dialogueStyle?.frequency} · paragraph=${d.paragraphLength?.pattern}`);
  const looksPlaceholder =
    d.sentenceLength?.average === 0 && d.sentenceLength?.rhythm === '' &&
    d.perspective?.type === '' && d.dialogueStyle?.naturalness === '';
  if (looksPlaceholder) {
    log('   ★ 观察（已知产品缺陷，不计入断言失败）：/analyze-style 返回的是**占位默认值**，非模型真实分析。');
    log('     根因链：style-agent.ts:310 以 maxTokens:2048 调 hy3-x（推理模型）→ 推理占满预算 →');
    log('     finish_reason=length → content 为空串 → parseAgentJson("") 返回 {} → 各字段回落硬编码默认值。');
    log('     已实测对照：同一 prompt 上游 max_tokens=2048 → finish=length/contentLen=0；');
    log('                max_tokens=4096 → finish=stop/contentLen=374（JSON 正常）。');
    log('     ⇒ 同仓其余 maxTokens:2048 调用点（chat-agent.ts:775/807/1088）有同样风险，值得单独排查。');
  } else {
    log(`   ★ 风格分析真实结果：avgLen=${d.sentenceLength?.average} · rhythm="${preview(d.sentenceLength?.rhythm, 40)}"`);
  }
}

// 6c) /analyze-rhythm —— 真打模型；断言**结构契约**，内容空洞单列诊断
{
  const rhythmText = '他推开门。风灌进来。灯灭了。他站在原地，没有动。走廊尽头传来脚步声，一下，两下，停住了。';
  const rhythmRes = await withRetry('ai/analyze-rhythm', 2, async () => {
    const r = await req('/api/ai/analyze-rhythm', {
      method: 'POST',
      body: { text: rhythmText, chapterTitle: '第一章' },
      timeoutMs: CFG.timeoutMs,
    });
    const d = r.json?.data ?? {};
    const ok = r.status === 200 && r.json?.success === true && Array.isArray(d.marks) && typeof d.summary === 'string';
    return { ok, detail: `HTTP ${r.status} · ${JSON.stringify(r.json).slice(0, 200)}`, r, d };
  });
  const d = rhythmRes.d ?? {};
  check('[/analyze-rhythm] 返回结构合法（marks 为数组 + summary 为字符串）', rhythmRes.r?.status === 200 && rhythmRes.r?.json?.success === true && Array.isArray(d.marks) && typeof d.summary === 'string', `HTTP ${rhythmRes.r?.status} · marks=${d.marks?.length ?? 'N/A'} 个 · 类型=[${(d.marks ?? []).map((m) => m.type).slice(0, 6).join(', ')}]`);
  const empty = !Array.isArray(d.marks) || d.marks.length === 0;
  if (empty) {
    log('   ★ 观察（已知产品缺陷，与 /analyze-style 同根因，不计入断言失败）：/analyze-rhythm 返回空 marks。');
    log('     根因链：rhythm-agent.ts:83 以 maxTokens:4096 调 hy3-x（推理模型）→ 推理偶尔占满预算 →');
    log('     finish_reason=length → content 为空串 → parseAgentJson("") 返回 {} → marks=[] / summary=""。');
    log('     实测可靠率仅 2/4（同一输入连跑 4 次，2 次空）—— 属**间歇性**缺陷，比 /analyze-style 的稳定复现更难察觉。');
  } else {
    check('[/analyze-rhythm] 模型真实产出内容（非空占位）', d.marks.length > 0 && d.summary.trim().length > 10, `marks=${d.marks.length} 个 · summary 前 60 字="${preview(d.summary, 60)}"`);
    log(`   ★ 节奏分析真实结果（前 60 字）：${preview(d.summary, 60)}`);
  }
}

// 6d) /generate-plot —— 真打模型，断言模型真的产出了情节内容（实测可靠 2/2）
{
  const plotRes = await withRetry('ai/generate-plot', 2, async () => {
    const r = await req('/api/ai/generate-plot', {
      method: 'POST',
      body: { description: '一场在地铁末班车上的失踪案', genre: '悬疑推理', projectName: 'e2e-ai-chain' },
      timeoutMs: CFG.timeoutMs,
    });
    const d = r.json?.data ?? {};
    const ok = r.status === 200 && r.json?.success === true && !d.raw && typeof d.title === 'string' && d.title.trim().length > 0;
    return { ok, detail: `HTTP ${r.status} · ${JSON.stringify(r.json).slice(0, 200)}`, r, d };
  });
  const d = plotRes.d ?? {};
  check('[/generate-plot] 返回 success=true 且 data 为对象', plotRes.r?.status === 200 && plotRes.r?.json?.success === true && d && typeof d === 'object' && Object.keys(d).length > 0, `HTTP ${plotRes.r?.status} · 字段=[${Object.keys(d).slice(0, 10).join(', ')}]`);
  check('[/generate-plot] 模型真产出情节内容（title 非空，未落到 raw 兜底）', typeof d.title === 'string' && d.title.trim().length > 0 && !d.raw, `title="${d.title ?? '(无)'}" · summary 前 60 字="${preview(d.summary, 60)}"${d.raw ? ' · ★ 落到 raw 兜底' : ''}`);
  log(`   ★ 情节生成真实结果：title="${d.title ?? ''}" · summary 前 60 字="${preview(d.summary, 60)}"`);
}

// 6e) /generate-character —— 真打模型，断言模型确实回了 JSON（非 raw 兜底）
{
  const genRes = await withRetry('ai/generate-character', 2, async () => {
    const r = await req('/api/ai/generate-character', {
      method: 'POST',
      body: { description: '一位在雨夜地铁站丢失了记忆的年轻女记者', genre: '悬疑推理', context: '当代南方沿海城市，无超自然力量' },
      timeoutMs: CFG.timeoutMs,
    });
    const d = r.json?.data ?? {};
    const ok = r.status === 200 && r.json?.success === true && typeof d.name === 'string' && d.name.trim().length > 0;
    return { ok, detail: `HTTP ${r.status} · ${JSON.stringify(r.json).slice(0, 200)}`, r, d };
  });
  const d = genRes.d ?? {};
  check('[/generate-character] 返回 success=true 且 data 为对象', genRes.r?.status === 200 && genRes.r?.json?.success === true && d && typeof d === 'object' && Object.keys(d).length > 0, `HTTP ${genRes.r?.status} · 字段=[${Object.keys(d).slice(0, 10).join(', ')}]`);
  check('[/generate-character] 模型真返回了 JSON（data.name 非空，未落到 raw 兜底）', typeof d.name === 'string' && d.name.trim().length > 0, `name="${d.name ?? '(无)'}" · personality 前 60 字="${preview(d.personality, 60)}"${d.raw ? ' · ★ 落到 raw 兜底' : ''}`);
}

// ============================================================
// 7) 降级验证（关键）：错误 key → 结构化错误 + 进程存活 → 强制还原
// ============================================================
log('');
log('【7】降级验证（注入错误 key，测完立即还原）');
if (CFG.skipDegrade) {
  check('降级验证（E2E_SKIP_DEGRADE=1 跳过 → 视为未通过）', false, '显式跳过降级用例；跳过不等于通过，故记失败以免假绿');
} else {
  const inj = await req('/api/ai/config', {
    method: 'POST',
    body: { baseUrl: CFG.aiBaseUrl, apiKey: BAD_KEY, model: CFG.aiModel, provider: CFG.aiProvider },
    timeoutMs: 60_000,
  });
  const injOk = inj.status === 200 && inj.json?.data?.apiKeyHint === '***0000';
  check('降级前置：已注入错误 key（同一可用 baseUrl，只换 key）', injOk, `HTTP ${inj.status} · apiKeyHint=${inj.json?.data?.apiKeyHint} · baseUrl=${inj.json?.data?.baseUrl}`);

  try {
    // 7a) /config/test —— 契约：200 + {success:false, data:{connected:false, error}}（不是 5xx）
    const t = await req('/api/ai/config/test', { method: 'POST', body: {}, timeoutMs: CFG.timeoutMs });
    const td = t.json?.data ?? {};
    check('[降级 /config/test] 非 5xx 崩溃，返回结构化失败体', t.status < 500 && t.json?.success === false && td.connected === false, `HTTP ${t.status} · success=${t.json?.success} · connected=${td.connected} · error="${preview(td.error, 80)}"`);
    check('[降级 /config/test] 失败信息可读（含上游状态码，非空）', typeof td.error === 'string' && td.error.trim().length > 0, `error="${td.error}"`);

    // 7b) /chat —— 契约：全局 errorHandler 的结构化错误体 {error:{code,message}}
    const c = await req('/api/ai/chat', {
      method: 'POST',
      body: { projectId, userMessage: '只回复两个字：可用', simple: true },
      timeoutMs: CFG.timeoutMs,
    });
    const hasCode = typeof c.json?.error?.code === 'string' && c.json.error.code.length > 0;
    // ★ 必须证明「失败确实来自 AI 调用」，而不是被别的守卫拦下（例如项目不存在 → NOT_FOUND）。
    //   否则一条 NOT_FOUND 也会被当成「降级正常」，是典型的假绿。
    const fromAi = /AI API 错误|AI 请求超时|AI 流式请求超时|AI 服务暂时不可用|无法解析域名|连接被拒绝|响应体为空/.test(String(c.json?.error?.message || ''));
    check('[降级 /chat] 返回结构化错误体（有 error.code，非裸 5xx 白屏）', hasCode, `HTTP ${c.status} · error.code=${c.json?.error?.code ?? '(无)'} · message="${preview(c.json?.error?.message, 80)}"`);
    check('[降级 /chat] 错误确实源自 AI 调用（非 NOT_FOUND/鉴权等无关守卫）', hasCode && fromAi, `error.code=${c.json?.error?.code} · message="${preview(c.json?.error?.message, 80)}"`);
    check('[降级 /chat] 错误体是 JSON 且带 code+message', c.json?.error && hasCode && typeof c.json.error.message === 'string', `body=${JSON.stringify(c.json).slice(0, 200)}`);

    // 7c) /analyze-style —— 契约：200 + {success:false, degraded:true, reason}（优雅降级而非报错）
    const s = await req('/api/ai/analyze-style', {
      method: 'POST',
      body: { referenceText: '他推开门。风灌进来。灯灭了。', simple: true },
      timeoutMs: CFG.timeoutMs,
    });
    const sd = s.json ?? {};
    check('[降级 /analyze-style] 优雅降级：200 + degraded 结构化结果（非 5xx）', s.status === 200 && sd.success === false && sd.degraded === true, `HTTP ${s.status} · success=${sd.success} · degraded=${sd.degraded} · reason="${preview(sd.reason, 80)}"`);

    // 7d) 进程存活
    const h2 = await req('/api/health', { timeoutMs: 15_000 });
    check('[降级] 服务进程仍存活（/api/health 仍 200/ok）', h2.status === 200 && h2.json?.status === 'ok', `HTTP ${h2.status} · status=${h2.json?.status} · database=${h2.json?.database} · 插件 ${h2.json?.plugins?.length ?? '?'} 个`);
  } finally {
    // ★ 无论如何立刻还原（cleanupTasks[0] 是配置还原；此处就地执行一次，避免后续断言在坏配置下运行）
    const restore = await req('/api/ai/config', {
      method: 'POST',
      body: { baseUrl: ORIGINAL.baseUrl || CFG.aiBaseUrl, apiKey: RESTORE_KEY, model: ORIGINAL.model || CFG.aiModel, provider: ORIGINAL.provider || CFG.aiProvider },
      timeoutMs: 60_000,
    });
    const back = await req('/api/ai/config', { timeoutMs: 30_000 });
    const d = back.json?.data ?? {};
    const restored = restore.status === 200 && back.status === 200 && d.apiKeyHint === ORIGINAL.apiKeyHint && d.baseUrl === (ORIGINAL.baseUrl || CFG.aiBaseUrl) && d._source === 'user_db';
    check('降级后已立即还原可用 key（回读 apiKeyHint 与 baseUrl 一致）', restored, `HTTP ${restore.status} · baseUrl=${d.baseUrl} · apiKeyHint=${d.apiKeyHint} · _source=${d._source}`);

    // 7e) 还原后链路确实又活了（证明还原是真的生效，而不是只改了库）
    const alive = await req('/api/ai/config/test', { method: 'POST', body: {}, timeoutMs: CFG.timeoutMs });
    check('还原后连通性恢复（connected=true）', alive.status === 200 && alive.json?.success === true && alive.json?.data?.connected === true, `HTTP ${alive.status} · connected=${alive.json?.data?.connected} · latencyMs=${alive.json?.data?.latencyMs}`);
  }
}

// ============================================================
// 8) 收尾：还原配置 + 删项目
// ============================================================
await runCleanup('正常结束');

// ============================================================
// 9) 汇总 + 真实退出码
// ============================================================
const passed = results.filter((r) => r.ok).length;
log('');
log('============================================================');
log(`结果：${passed}/${results.length} 条断言通过${failed > 0 ? `，${failed} 条失败` : ''}`);
if (failed > 0) {
  log('失败明细：');
  for (const r of results.filter((x) => !x.ok)) log(`  ✗ ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
}
const exitCode = results.length === 0 ? 1 : failed > 0 ? 1 : 0;
if (results.length === 0) log('★ 未执行任何断言（异常状态），按失败处理');
log(`EXIT=${exitCode}`);
log('============================================================');
await exitNow(exitCode);