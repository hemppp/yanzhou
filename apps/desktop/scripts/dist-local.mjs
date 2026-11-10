#!/usr/bin/env node
/**
 * dist-local —— 打包入口，自动补齐**本机构建前提**（见 ADR-0008 D8.7）。
 *
 * 用法（在 apps/desktop 下）：
 *     node scripts/dist-local.mjs            # 等价于 npm run dist
 *     node scripts/dist-local.mjs dist:dir   # 转发到别的 dist 脚本
 *
 * 它**只**做两件事，都是本机特有的（换正常构建机则都不触发）：
 *
 *   ① MSVC 工具链：本机 VS BuildTools 装在盘上但**未注册**
 *      （`vswhere -all -products *` 返回 []、`_Instances/` 为空），node-gyp 因此
 *      报 `Could not find any Visual Studio installation to use`。而 node-gyp 在
 *      find-visualstudio.js:47 还有一条 `VCINSTALLDIR` 通路 —— 正是它此前抱怨的
 *      `not running in VS Command Prompt`。所以：未注册时自动 call 一次 vcvars64.bat。
 *      注意本脚本**不**替 electron-builder 重建原生模块（ADR D3.4 禁止手工补），
 *      只负责让 node-gyp 找得到工具链；重建仍由 electron-builder 驱动（D8.5）。
 *
 *   ② 下载源：本机对 GitHub 通但慢（release 资产必 600s 超时）。设
 *      ELECTRON_BUILDER_MIRROR_CN=1 时改用 npmmirror。
 *      ★ 默认**不启用** —— 第三方源属供应链选择，不做隐式默认。
 *      （electron-builder 对这几个资产带 SHA 校验，但选择权仍应显式。）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(__dirname, '..');
const TARGET = process.argv[2] ?? 'dist';

const PF86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
const PF = process.env.ProgramFiles ?? 'C:\\Program Files';

function log(msg) {
  console.log(`[dist-local] ${msg}`);
}

/** vswhere 是否认得一个带 VC 工具集的实例 */
function hasRegisteredVs() {
  const vswhere = path.join(PF86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return false;
  const r = spawnSync(vswhere, [
    '-latest', '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ], { encoding: 'utf8' });
  return r.status === 0 && `${r.stdout}`.trim() !== '';
}

/** 盘上现成的 vcvars64.bat（未注册实例时的兜底） */
function findVcvars() {
  const editions = ['BuildTools', 'Community', 'Professional', 'Enterprise'];
  for (const base of [PF86, PF]) {
    for (const ed of editions) {
      const p = path.join(base, 'Microsoft Visual Studio', '2022', ed, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const env = { ...process.env };
if (process.env.ELECTRON_BUILDER_MIRROR_CN) {
  env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';
  env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
  log('已启用 npmmirror（ELECTRON_BUILDER_MIRROR_CN=1）');
}

const toolchainOk = Boolean(process.env.VCINSTALLDIR) || hasRegisteredVs();
const vcvars = toolchainOk ? null : findVcvars();

if (toolchainOk) {
  log(`MSVC 可由 node-gyp 自行发现（${process.env.VCINSTALLDIR ? 'VCINSTALLDIR 已在环境中' : 'vswhere 有实例'}）`);
} else if (vcvars) {
  log(`MSVC 实例未注册，改用盘上工具链：${vcvars}`);
} else {
  log('⚠ 既没有已注册的 VS 实例，也没找到 vcvars64.bat —— 原生模块重建大概率会失败');
}

log(`执行 npm run ${TARGET}`);

let r;
if (vcvars) {
  // ⚠ spawnSync 传参数**数组**时会给每个参数加引号并把内层引号转义成 \"，
  //   cmd 不认这种转义（实测报：'\"C:\Program Files (x86)\...' 不是内部或外部命令）。
  //   故用 windowsVerbatimArguments 原样拼命令行；外层再包一层引号，配合 /s
  //   让 cmd 剥掉它 —— 这是 cmd 对「/c 后首字符是引号」的既定规则。
  const line = `call "${vcvars}" >nul && npm run ${TARGET}`;
  r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    cwd: DESKTOP, env, stdio: 'inherit', windowsVerbatimArguments: true,
  });
} else {
  r = spawnSync('npm', ['run', TARGET], { cwd: DESKTOP, env, stdio: 'inherit', shell: true });
}

process.exit(r.status ?? 1);
