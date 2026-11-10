#!/usr/bin/env node
/**
 * native-abi —— 保证安装包里的原生模块是 **Electron ABI**，并在产错时让构建**失败**。
 *
 * 用法（在 apps/desktop 下）：
 *   node scripts/native-abi.mjs stage     # 打包前：把原生模块实体铺进应用目录
 *   node scripts/native-abi.mjs verify    # 打包后：核对产物里的 .node 是不是 Electron ABI
 *
 * ── 为什么需要 stage ────────────────────────────────────────────────
 * ADR-0008 D8.2 的设计是：`better-sqlite3` 声明在 apps/desktop 的 dependencies 里，
 * 由 electron-builder 自动驱动 `@electron/rebuild` 把它重建成 Electron ABI。
 * 但本仓库 pnpm 用 `nodeLinker: hoisted`（依赖全铺在**仓库根** node_modules），
 * `apps/desktop/node_modules` **根本不存在** ⇒ @electron/rebuild 在应用目录里
 * 找不到任何可重建目标，**空转**；随后打包从根 node_modules 取走了**未重建**的
 * Node ABI 二进制。
 *
 * 后果不是崩溃而是**静默降级**：Electron 里加载不了 Node ABI 的模块，运行期回退
 * sql.js（内存库，只靠显式 saveToDisk 落盘）—— 对写作软件是掉数据的风险。
 * 而 electron-builder 照旧打印 `completed installing native dependencies`，看不出来。
 *
 * 所以：**把包实体铺进应用目录**（不碰根模块，开发环境零影响、无需事后还原），
 * 让 D8.2 那条链路真的能跑起来。铺完由 electron-builder 自己重建。
 *
 * ── 为什么还需要 verify ────────────────────────────────────────────
 * 2026-11-08 实测：上面这条链**静默失败过一次**（包内是 1919488 B = Node ABI 137）。
 * 光看构建日志无法分辨，所以打包后必须**实测**产物：
 * 用构建期的 Node 去 require 产物里的 .node ——
 *   · 加载**失败**并报 NODE_MODULE_VERSION 不匹配 ⇒ 是 Electron ABI，正确（通过）
 *   · 加载**成功**                               ⇒ 就是构建期 Node 的 ABI，错误（失败）
 * 这比"读日志"可靠：不依赖任何版本→ABI 映射表，也不依赖文件大小这种巧合。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(__dirname, '..');
const REPO = path.resolve(DESKTOP, '..', '..');
const APP_NM = path.join(DESKTOP, 'node_modules');
const UNPACKED = path.join(REPO, 'release', 'desktop', 'win-unpacked', 'resources', 'app.asar.unpacked');

/**
 * 需要铺进应用目录的包。
 *   · better-sqlite3 —— 原生模块，**必须**在这里，@electron/rebuild 才有目标可重建；
 *     排除 build/（根那份是 Node ABI 的产物，带过去会误导重建）。
 *   · bindings / file-uri-to-path —— better-sqlite3 的**运行期**依赖：前者负责定位
 *     .node（asar 内动态 require 裸说明符要靠它），后者是它的依赖。
 *     ★ 2026-11-09 实测教训：只铺 better-sqlite3 时，electron-builder 不再顺带从仓库根
 *     取这两个包（依赖遍历不再走到上层），产物里就没有它们 —— 结果运行时定位不到 .node，
 *     照样降级。本条由 verify 的 bindings 检查逮到，故一并铺。
 */
const NATIVE = 'better-sqlite3';

const STAGE = [
  { name: NATIVE, native: true },
  { name: 'bindings', native: false },
  { name: 'file-uri-to-path', native: false },
];

function fail(msg) {
  console.error(`[native-abi] ✖ ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`[native-abi] ✔ ${msg}`);
}

/** 解析包的实体位置（跳过 pnpm 的符号链接，取真实目录） */
function resolvePackageDir(name) {
  const pkgJson = require.resolve(`${name}/package.json`, { paths: [DESKTOP, REPO] });
  return path.dirname(fs.realpathSync(pkgJson));
}

// ─────────────────────────────────────────────────────────────── stage
function stage() {
  fs.mkdirSync(APP_NM, { recursive: true });
  for (const { name, native } of STAGE) {
    const src = resolvePackageDir(name);
    const dest = path.join(APP_NM, name);
    const srcPkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));

    // 幂等：同版本且已铺过就跳过
    const destPkgPath = path.join(dest, 'package.json');
    if (fs.existsSync(destPkgPath)) {
      const destPkg = JSON.parse(fs.readFileSync(destPkgPath, 'utf8'));
      if (destPkg.version === srcPkg.version) {
        ok(`${name}@${srcPkg.version} 已在应用目录（跳过复制）`);
        continue;
      }
    }

    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, {
      recursive: true,
      dereference: true,
      // 原生包排除 build/：里面的 .node 是仓库根那份 Node ABI 的产物，带过去会误导
      // electron-builder（看到现成二进制就可能不重建），也让"铺进去的必须是源码"这条干净。
      filter: (p) => {
        if (!native) return true;
        const rel = path.relative(src, p);
        return rel === '' || !/^build([\\/]|$)/.test(rel);
      },
    });
    ok(`${name}@${srcPkg.version} 已铺进应用目录${native ? '（已排除 build/，待重建）' : ''}`);
  }
  console.log('[native-abi]   原生包由 electron-builder 的 @electron/rebuild 重建成 Electron ABI；之后用 verify 实测产物。');
}

// ────────────────────────────────────────────────────────────── verify
/** 用构建期 Node 加载某个 .node，判定它是不是 Electron ABI */
function abiVerdict(nodeFile) {
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(nodeFile)})`], {
    encoding: 'utf8',
  });
  const stderr = `${r.stderr ?? ''}`;
  if (r.status === 0) {
    return { ok: false, why: '能被构建期 Node 加载 ⇒ 是 Node ABI，不是 Electron ABI' };
  }
  // Node 的原文是「…using NODE_MODULE_VERSION 149. This version of Node.js requires
  // NODE_MODULE_VERSION 137.」——**中间有换行**，所以用「抽出所有 ABI 数字再比对」，
  // 不去匹配那句措辞（措辞与换行位置随版本变）。
  const abis = [...stderr.matchAll(/NODE_MODULE_VERSION (\d+)/g)].map((m) => Number(m[1]));
  const [modAbi, nodeAbi] = abis;
  if (modAbi != null && nodeAbi != null && modAbi !== nodeAbi) {
    return { ok: true, why: `模块 ABI ${modAbi} ≠ 构建期 Node 的 ${nodeAbi} ⇒ 是 Electron ABI` };
  }
  return { ok: false, why: `加载失败但原因不是 ABI 不匹配：${stderr.trim().split('\n').slice(0, 2).join(' ')}` };
}

function verify() {
  if (!fs.existsSync(UNPACKED)) fail(`找不到解包目录：${path.relative(REPO, UNPACKED)}（先跑 electron-builder --dir？）`);

  const nodeFile = path.join(UNPACKED, 'node_modules', NATIVE, 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(nodeFile)) fail(`产物里没有 better_sqlite3.node：${path.relative(REPO, nodeFile)}`);

  const size = fs.statSync(nodeFile).size;
  const v = abiVerdict(nodeFile);
  if (!v.ok) {
    fail(
      `产物里的 better_sqlite3.node 不是 Electron ABI（${size} B）——${v.why}\n` +
        '  桌面端会静默回退 sql.js（内存库，仅显式 saveToDisk 落盘）。\n' +
        '  排查：① stage 是否真把包铺进了 apps/desktop/node_modules；\n' +
        '        ② electron-builder 的 @electron/rebuild 是否报了错（需可用的 MSVC 工具链）。',
    );
  }
  ok(`better_sqlite3.node ${size} B —— ${v.why}`);

  // 运行期要靠 bindings 定位 .node，两者都必须在 unpacked 里
  for (const dep of ['bindings', 'file-uri-to-path']) {
    const p = path.join(UNPACKED, 'node_modules', dep);
    if (!fs.existsSync(p)) fail(`产物里缺少运行期依赖 ${dep}（asarUnpack 未命中？）`);
  }
  ok('bindings / file-uri-to-path 均在 app.asar.unpacked 内');
  console.log('[native-abi] 产物原生模块校验通过。');
}

const cmd = process.argv[2];
if (cmd === 'stage') stage();
else if (cmd === 'verify') verify();
else fail(`未知子命令 ${cmd ?? '(空)'}；用法：native-abi.mjs <stage|verify>`);
