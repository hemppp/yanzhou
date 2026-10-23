// ============================================================
// 一键验证：两侧单测 + 记忆抽查
//
// 为什么单列一个脚本而不是写进 package.json 的一行：
//   ① server 套件**必须用 Node 24**（better-sqlite3 编译于 ABI 137）—— 直接 `vitest` 会 ERR_DLOPEN_FAILED
//   ② 记忆抽查要读真实项目库，跑完真机后才有内容（空库不报错，只提示）
//   ③ 顺序跑、别并发（实测两个 vitest 套件并发会偶发文件级加载失败）
//
// 用法：node scripts/verify/verify-all.mjs
// 退出码：0 = 全过；非 0 = 有失败（可直接接 CI / 提交前钩子）
// ============================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'F:/new1.2';
/**
 * 步骤日志目录。
 * ★ 2026-10-17 修复：原先直接写 `<ROOT>/.workbuddy/`，但该目录是 WorkBuddy 工具时代
 *   的遗留约定 —— 全新 clone（或该目录被清掉）时不存在，`fs.openSync` 第一步就
 *   ENOENT 抛错，整个一键验证**在跑第一条单测之前**就死了（实测：屏幕上只剩一段
 *   栈回溯）。目录名沿用 `.workbuddy` 只为不改变已有使用者的路径习惯；
 *   它是**可重建的临时日志目录**，缺失即自建（已被 .gitignore 覆盖，不进版本库）。
 */
const LOG_DIR = path.join(ROOT, '.workbuddy');
fs.mkdirSync(LOG_DIR, { recursive: true });
/** server 套件必须用这个 Node（ABI 137），没有就回退到 PATH 上的 node */
const NODE24 = 'D:/ruanjian/node.24/node.exe';
const NODE = fs.existsSync(NODE24) ? NODE24 : process.execPath;
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

const steps = [
  { name: 'server 单测', cwd: 'apps/server', args: [VITEST, 'run'] },
  { name: 'web 单测', cwd: 'apps/web', args: [VITEST, 'run'] },
  { name: '记忆抽查（不变量）', cwd: '.', args: ['scripts/tools/memory-sample-check.mjs'], allowEmpty: true },
  // ★ 模式分离：脚本自己起两个临时 server（HOST_MODE=manual/auto，临时端口 + 临时库），
  //   跑完自行清理。需要 Node 24（better-sqlite3 ABI 137）—— 与上面两步同源。
  { name: '模式分离（插件层 manual/auto/shared）', cwd: '.', args: ['scripts/verify/verify-plugin-mode-separation.mjs'] },
  // ★ manifest 合法性（真实 @novel/core 契约）：用真实 `validateManifest` + G1 入口文件存在
  //   + G2 id 尾段==目录名 + Web 入口 `export const name`==id，校验全部**真实存在**的 plugin.json。
  //
  //   ★ D51 教训（为什么必须放进一键入口）：这类缺陷曾**逃过全部门禁** ——
  //     隔离门禁只做静态 import 扫描（全文不含 plugin.json）、模块移除门禁不读 manifest、
  //     模式分离门禁**自己合成** manifest（`writeFileSync`）故永远看不见真实 manifest 的非法性。
  //     ⇒ 两模块 `plugin.json` 非法而无人发现，auto 模块**从未挂载**、真实浏览器里永久卡在 Loading…。
  //     故必须纳入 verify-all，否则本类缺陷仍会静默通过。
  //
  //   位置：放最后一条。它只读文件、不启 server、不碰 DB、无网络，与前后步骤无耦合（实测瞬时返回）。
  //   退出码 0/1/2：0 走 classify 的 `r.status === 0` 分支判通过；非 0 且不打印「Tests N passed」
  //   故不会误入 allPassed 分支 —— `classify()` 无需改动。
  //   注：脚本自身会 tsx 重入（为加载 TS 源码形态的 @novel/core），不依赖 Node 24。
  { name: 'manifest 合法性（真实 @novel/core 契约）', cwd: '.', args: ['scripts/verify/verify-manifest-validity.mjs'] },
];

let failed = 0;
/**
 * 单步超时（可用 `VERIFY_STEP_TIMEOUT_MS` 覆盖）。
 * ★ 为什么必须有：
 * vitest 跑完会**打印结果但不退出**（实测 apps/server 套件 11.18s 出结果，进程却一直活着）。
 * 没有超时的话 `spawnSync` 会**永远等下去**，整个校验挂死在第一步，
 * 而屏幕上什么都看不到（输出还被管道缓冲着）—— 实测挂过一次 10 分钟没声。
 * 这不是"测试失败"，所以不能简单判失败 —— 见 classify()。
 * 默认 3 分钟：两个套件实测都在 30 秒内出结果，超过 3 分钟还没退就是卡住了。
 */
const STEP_TIMEOUT_MS = Number(process.env.VERIFY_STEP_TIMEOUT_MS) || 3 * 60 * 1000;

/**
 * 判定一个步骤的结果。
 * 「进程被杀（超时）但输出显示全过」= **通过但警告** —— 把它判成失败会让人去修一个不存在的 bug；
 * 判成静默通过又会掩盖"套件其实卡住了"。所以显式说出来。
 */
function classify(step, r, out) {
  /**
   * ★ 必须先剥掉 ANSI 颜色码再匹配。
   * vitest 会输出 `\x1b[2m      Tests \x1b[22m \x1b[32m159 passed\x1b[39m` ——
   * 「Tests」和数字之间隔着转义序列，`/Tests\s+\d+ passed/` 匹配不到，
   * 会把**全过的套件判成失败**（实测踩过一次：日志里明明有 159 passed，判定说"看不到"）。
   */
  const clean = out.replace(/\u001b\[[0-9;]*m/g, '');
  const allPassed = /Tests\s+\d+ passed/.test(clean) && !/\b\d+ failed\b/.test(clean);
  /** 诊断行：判定结果必须自带证据，否则下次又要靠猜（这次就吃过亏） */
  const diag = `status=${r.status} signal=${r.signal ?? '-'} error=${r.error?.code ?? '-'}`
    + ` | 输出里 ${/Tests\s+\d+ passed/.test(clean) ? '有' : '无'}「passed」、`
    + `${/\b\d+ failed\b/.test(clean) ? '有' : '无'}「failed」`;
  if (r.status === 0) return { ok: true, note: '' };
  if (r.error?.code === 'ETIMEDOUT' || r.signal) {
    // 打印了"全部通过"但进程不肯退 → 判通过，但要把这件事说出来
    if (allPassed) {
      return { ok: true, note: `⚠ 子进程**未自行退出**（超时 ${STEP_TIMEOUT_MS / 60000} 分钟被杀），但输出显示全部通过（${diag}）` };
    }
    return { ok: false, note: `被超时杀掉，且输出里看不到「全部通过」（${diag}）` };
  }
  // 全过但退出码非 0：多半是收尾报错/被外部杀掉 —— 不能静默当通过，也不能让人去查不存在的用例失败
  if (allPassed) {
    return { ok: false, note: `用例全过，但退出码 ${r.status}（收尾阶段出了问题）（${diag}）` };
  }
  if (step.allowEmpty) return { ok: true, note: `退出码 ${r.status}（若只是"库里还没有记忆数据"，可忽略）` };
  return { ok: false, note: `退出码 ${r.status}（${diag}）` };
}

for (let i = 0; i < steps.length; i += 1) {
  const s = steps[i];
  process.stdout.write(`\n${'='.repeat(60)}\n▶ ${s.name}\n${'='.repeat(60)}\n`);

  /**
   * ★ 子进程的 stdout/stderr **直接写文件**，不从 `spawnSync` 的返回值里读。
   *
   * 为什么：被超时杀掉时，`spawnSync` 返回的 `stdout` 会与日志里真实打出来的内容**对不上**
   *   （实测：日志里明明有 `Tests 159 passed (159)`，`r.stdout` 里却搜不到 → 判定成了假失败）。
   *   写文件就没有这个不确定性：被杀掉的那一刻，已经写出去的东西一定还在文件里。
   */
  const logPath = path.join(LOG_DIR, `verify-step${i + 1}.log`);
  const fd = fs.openSync(logPath, 'w');
  let r;
  try {
    r = spawnSync(NODE, s.args, {
      cwd: path.join(ROOT, s.cwd),
      stdio: ['ignore', fd, fd],
      timeout: STEP_TIMEOUT_MS,
      // 日志落文件时不带颜色：ANSI 转义会污染正则与肉眼阅读（判定侧仍会剥一遍兜底）
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
  } finally {
    fs.closeSync(fd);
  }

  let out = '';
  try { out = fs.readFileSync(logPath, 'utf8'); } catch { /* 读不到就按空处理 */ }
  process.stdout.write(out);

  const v = classify(s, r, out);
  if (!v.ok) failed += 1;
  if (v.note) console.log(`\n${v.ok ? '' : '✗ '}${v.note}`);
}

console.log(`\n${'='.repeat(60)}`);
if (failed === 0) {
  console.log('✅ verify-all 全过');
} else {
  console.log(`❌ verify-all：${failed} 步失败`);
}
process.exit(failed === 0 ? 0 : 1);
