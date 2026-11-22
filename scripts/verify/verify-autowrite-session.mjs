#!/usr/bin/env node
// ============================================================
// 真机验证：AI 写作链路端到端（讨论 → 三道门 → 交付 → 实体沉淀）
//
// 为什么必须用脚本验：type-check 与单测**证明不了**这条链路能用 ——
// 模型输出也是链路的一部分。
//
// 前置条件：
//   1. server 在跑，且**必须用 Node 24**（better-sqlite3 编译于 ABI 137）：
//        cd apps/server && "D:/ruanjian/node.24/node.exe" ../../node_modules/tsx/dist/cli.mjs src/index.ts
//   2. 管理员账号（username = user）已配好 AI provider ——
//      脚本会把这份配置原样复制给临时探测账号，测完必须删。
//
// 用法：
//   node scripts/verify/verify-autowrite-session.mjs [章数，默认 2]
//
// 跑完务必清理（脚本会打印出需要的两个参数）：
//   node scripts/verify/verify-autowrite-cleanup.mjs <username> <projectId>
//
// 产出：data/verify-last-run.json（完整事件流，供事后分析）
// ============================================================

import Database from 'better-sqlite3';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:3774';
const MAIN_DB = 'F:/new1.2/data/novelmuse.db';
const OUT_JSON = 'F:/new1.2/data/verify-last-run.json';
const CHAPTERS = Math.max(1, Math.min(3, Number(process.argv[2] ?? 2)));
const PASSWORD = 'Probe1234!';
const stamp = Date.now().toString(36);
const USERNAME = `probe${stamp}`;

let cookie = '';
const t0 = Date.now();
const all = [];
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const say = (...a) => console.log(`[${ts()}]`, ...a);
const len = (s) => String(s ?? '').replace(/\s/g, '').length;

function report(e) {
  switch (e.type) {
    case 'phase': say('  · phase:', e.label); break;
    case 'turn': say(`  · turn: ${e.name} ${len(e.text)}字`); break;
    case 'conclusion': say(`  · conclusion: ${len(e.text)}字`); break;
    case 'draft': say(`  · draft: rev${e.revision} ${len(e.text)}字`); break;
    case 'review': say(`  · review: 第${e.attempt}次 passed=${e.passed}`); break;
    case 'gate': say(`  · GATE ${e.name}: passed=${e.passed}${typeof e.score === 'number' ? ` score=${e.score}` : ''} | ${String(e.detail).slice(0, 120)}`); break;
    case 'delivered': say(`  · delivered: 第${e.order}章 ${e.wordCount}字 created=${e.created}`); break;
    case 'deliver_blocked': say(`  · BLOCKED: ${e.reason}`); break;
    case 'entities': say(`  · entities: created=${e.created} updated=${e.updated} skipped=${e.skipped} notes=${JSON.stringify(e.notes)}`); break;
    case 'error': say('  · ERROR:', e.message); break;
    case 'done': say('  · done'); break;
    default: say('  · ?', JSON.stringify(e).slice(0, 160));
  }
}

async function req(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) };
  const res = await fetch(BASE + path, { ...opts, headers });
  const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return res;
}

async function runChapter(projectId, chapterOrder, message) {
  say(`———— 第 ${chapterOrder} 章 ————`);
  const res = await fetch(`${BASE}/api/plugins/autowrite/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-project-id': projectId, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ message, chapterOrder }),
  });
  say('SSE 响应:', res.status);
  if (res.status >= 400) { console.log((await res.text()).slice(0, 300)); return []; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const evs = [];
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue; // 心跳 ': keepalive' 跳过
        let o;
        try { o = JSON.parse(line.slice(5).trim()); } catch { continue; }
        o._at = ts();
        o._chapter = chapterOrder;
        evs.push(o);
        report(o);
      }
    }
  }
  return evs;
}

// ---- 1) 注册临时账号 + 复制管理员 AI 配置 + 登录 + 建 auto 项目 ----
{
  const r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: USERNAME, password: PASSWORD, displayName: '验证探针' }) });
  say('注册:', r.status);
  if (r.status >= 400) { console.log((await r.text()).slice(0, 200)); process.exit(1); }

  const db = new Database(MAIN_DB);
  const admin = db.prepare("select id from users where username='user'").get();
  const cfg = db.prepare('select ai_provider_config from user_settings where user_id=?').get(admin.id)?.ai_provider_config;
  if (!cfg) { console.log('管理员没有 AI 配置，无法验证'); process.exit(1); }
  const me = db.prepare('select id from users where username=?').get(USERNAME);
  const now = Math.floor(Date.now() / 1000);
  if (db.prepare('select user_id from user_settings where user_id=?').get(me.id)) {
    db.prepare('update user_settings set ai_provider_config=?, updated_at=? where user_id=?').run(cfg, now, me.id);
  } else {
    db.prepare('insert into user_settings (user_id, ai_features, ai_provider_config, created_at, updated_at) values (?,?,?,?,?)').run(me.id, '{}', cfg, now, now);
  }
  db.close();

  const lr = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: USERNAME, password: PASSWORD }) });
  say('登录:', lr.status);
  if (lr.status >= 400) process.exit(1);
}

const pr = await req('/api/projects', { method: 'POST', body: JSON.stringify({ name: `验证·${stamp}`, genre: '都市悬疑', mode: 'auto' }) });
const pj = await pr.json();
const projectId = pj?.data?.id ?? pj?.id ?? '';
say('建项目:', pr.status, projectId, 'mode=', pj?.data?.mode ?? pj?.mode);
if (!projectId) { console.log(JSON.stringify(pj).slice(0, 400)); process.exit(1); }

// ---- 2) 逐章跑 ----
const MESSAGES = [
  '写第1章：一个普通上班族早高峰在地铁上捡到一部还在响的手机，接起来后对方直接叫出了他的名字。',
  '写第2章：陈默出站后去华贸上班，一整天心神不宁，试着回想姐姐三年前失踪前后的细节。',
  '写第3章：他决定按照片上的线索去找那栋楼。',
];
for (let i = 1; i <= CHAPTERS; i++) {
  const evs = await runChapter(projectId, i, MESSAGES[i - 1] ?? `写第${i}章：接着上一章往下写。`);
  all.push(...evs);
}

// ---- 3) 核验落库 ----
console.log('\n===== 事件类型统计 =====');
const types = {};
for (const e of all) types[e.type] = (types[e.type] ?? 0) + 1;
console.log(JSON.stringify(types));

const last = all.filter((e) => e._chapter === CHAPTERS);
const keeper = last.find((e) => e.type === 'turn' && e.name === '设定管家');
if (keeper) {
  console.log(`\n===== 第 ${CHAPTERS} 章 设定管家发言（看是否引用了既有实体/伏笔）=====`);
  console.log(keeper.text.slice(0, 800));
}

const pdb = `F:/new1.2/data/projects/${projectId}.db`;
console.log('\n===== 落库（项目库）=====');
if (fs.existsSync(pdb)) {
  const d = new Database(pdb, { readonly: true });
  for (const t of ['chapters', 'characters', 'items', 'locations', 'foreshadows', 'story_events']) {
    try { console.log(`  ${t}: ${d.prepare(`select count(*) c from ${t}`).get().c}`); } catch (err) { console.log(`  ${t}: ${err.message}`); }
  }
  try { for (const r of d.prepare('select title, word_count from chapters order by "order"').all()) console.log('  章节:', r.title, r.word_count, '字'); } catch { /* 列名差异 */ }
  d.close();
}

fs.writeFileSync(OUT_JSON, JSON.stringify(all, null, 1), 'utf8');
console.log(`\n✅ 完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，事件流已写入 ${OUT_JSON}`);
console.log(`⚠️  记得清理：node scripts/verify/verify-autowrite-cleanup.mjs ${USERNAME} ${projectId}`);
