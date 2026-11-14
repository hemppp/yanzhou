// ============================================================
// apps/desktop/src/updater/index.ts
// `createUpdater()` —— updater 的编排入口（6 个方法）。
//
// 契约来源（只读，不得修改）：
//   apps/desktop/src/updater/types.ts           —— Updater / UpdaterContext / 常量
//   apps/web/src/types/desktop-api.d.ts:14-30   —— 6 个方法签名
//   docs/architecture/desktop-packaging-adr.md  D14.1–D14.5（更新流程与安全要求）
//                                               D7.3（`data` junction 关键冻结）
//                                               D11.1（返回对象必须可结构化克隆、不得 reject）
//
// 设计约束：
//  · **不 import electron** —— 必须能在纯 Node（tsx）下独立跑验证。
//  · **不 import '../paths.js'** —— types.ts 头注释已冻结该边界；junction 重建
//    由本文件用 `node:fs` 自建（见下方 `ensureJunction`），语义与 paths.ts 的
//    `ensureDirectoryJunction` 对齐，并额外保证：**绝不递归穿越 junction**。
//  · **6 个方法一律不 reject** —— 任何异常都转成 `{ ok:false, error }`（D11.1）。
//
// D7.3 红线（本文件最危险处）：
//   `applyApp()` 只替换 `APP_REPLACE_ENTRIES` 四项，**绝不触碰**
//   `APP_NEVER_TOUCH_ENTRIES`（`data` / `plugins`）。`data` 是 junction →
//   `<userData>/data`（用户全部项目库）。替换前后各校验一次该 junction。
//   所有删除走 `removeTreeSafely()`：用 `lstat` 判定，链接只摘除、绝不递归进去。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

import { backupDir } from './backup.js';
import {
  manifestUrlOf,
  normalizeBaseUrl,
  readConfig,
  resolveArtifactUrl,
  validateBaseUrl,
  writeConfig,
} from './config.js';
import { downloadToFile, fetchToBuffer } from './http.js';
import { findInstalledPluginDir, locatePluginRoot, scanInstalledPlugins } from './plugins.js';
import { compareVersions } from './semver.js';
import {
  APP_NEVER_TOUCH_ENTRIES,
  APP_REPLACE_ENTRIES,
  type InstalledPlugin,
  type ManifestPluginEntry,
  type Updater,
  type UpdaterApplyAppResult,
  type UpdaterCheckResult,
  type UpdaterContext,
  type UpdaterInstallPluginResult,
  type UpdaterLayout,
  type UpdaterLogLevel,
  type UpdaterManifest,
  type UpdaterRelaunchResult,
  type UpdaterSetBaseUrlResult,
  type UpdaterStateResult,
} from './types.js';
import { findPluginUpdate, parseManifest, selectPluginUpdates } from '../updater-manifest.js';

const fsp = fs.promises;

/** 与 `paths.ts` 的 `RES_APP_SERVER` 逐字一致（D7.1 布局）。 */
const APP_SERVER_DIRNAME = 'app-server';

/** 插件未安装时的落点模式目录（D14.5 / D7.1）。 */
const DEFAULT_PLUGIN_MODE = 'local';

// ------------------------------------------------------------------
// 小工具（全部纯函数 / 无副作用，且**绝不抛给调用方**）
// ------------------------------------------------------------------

/** 取人类可读错误文本（**只取 message**，绝不把 Error 实例放进返回值）。 */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 路径规范化：去尾随分隔符、去 Windows `\\?\` 前缀、小写（Windows 大小写不敏感）。 */
function normPath(p: string): string {
  let s = String(p).replace(/^\\\\\?\\/, '');
  s = path.resolve(s).replace(/[\\/]+$/, '');
  return s.toLowerCase();
}

/** 两个路径是否指向同一处。 */
function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

/**
 * 路径是否存在（**跟随** junction）。
 * F20 冻结：junction 的 `lstat().isDirectory()` 返回 false，
 * 因此存在性判断必须用 `statSync` / `existsSync`。
 */
function existsFollow(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** 路径自身是否为链接（Windows 目录 junction 在 lstat 下即 symbolic link）。 */
function isLinkPath(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 读链接目标（失败返回 null）。 */
function readLinkTarget(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

/** 摘除一个链接（**绝不递归**；junction 上 unlink 可能 EPERM，故多级回退）。 */
function removeLink(link: string): void {
  try {
    fs.unlinkSync(link);
    return;
  } catch {
    /* 继续尝试 */
  }
  try {
    fs.rmdirSync(link);
    return;
  } catch {
    /* 继续尝试 */
  }
  fs.rmSync(link, { force: true, recursive: false });
}

/** 目录是否为空（仅用于「非 junction 的真实空目录」判定）。 */
function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/**
 * 递归删除一棵树，**绝不穿越链接**。
 *
 * 这是本文件的安全底座：与 `fsp.rm(…, { recursive: true })` 不同，本实现
 * 对每个条目用 `lstat` 判定 —— 遇到 junction / 符号链接**只摘除链接本身**，
 * 绝不递归进入其目标目录。ADR D7.3 的红线（`data` junction → 用户全部项目数据）
 * 依赖这一点。
 */
async function removeTreeSafely(target: string): Promise<void> {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return; // 不存在 ⇒ 无事可做
  }
  if (st.isSymbolicLink()) {
    removeLink(target);
    return;
  }
  if (!st.isDirectory()) {
    await fsp.unlink(target);
    return;
  }
  const dirents = await fsp.readdir(target, { withFileTypes: true });
  for (const dirent of dirents) {
    await removeTreeSafely(path.join(target, dirent.name));
  }
  await fsp.rmdir(target);
}

/** 递归复制普通文件/目录（源来自我们自己解压出的目录，不含链接）。 */
async function copyTree(src: string, dest: string): Promise<void> {
  const st = await fsp.stat(src);
  if (st.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    const dirents = await fsp.readdir(src, { withFileTypes: true });
    for (const dirent of dirents) {
      await copyTree(path.join(src, dirent.name), path.join(dest, dirent.name));
    }
    return;
  }
  if (st.isFile()) {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }
}

/**
 * 用 `src` 整体替换 `destPath`，先落临时同级路径再 rename 换入，
 * 使「删除旧 + 写入新」之间不存在半成品窗口。
 */
async function replacePathSafely(src: string, destPath: string): Promise<void> {
  const tmp = `${destPath}.nmnew-${process.pid}-${Date.now().toString(36)}`;
  await removeTreeSafely(tmp);
  try {
    await copyTree(src, tmp);
    await removeTreeSafely(destPath);
    await fsp.rename(tmp, destPath);
  } catch (err) {
    // 复制中途失败（ENOSPC/EACCES）或被占用的 rename 失败：临时树可能已经是
    // 整份载荷，不清掉会永久留在目标目录旁，反复失败即持续增长。
    try {
      await removeTreeSafely(tmp);
    } catch {
      /* 清不掉就让下一次同名清理兜底（名字带 pid+时间戳，不会误删） */
    }
    throw err;
  }
}

/**
 * 幂等确保 `link` 是指向 `target` 的**目录 junction**（自建版，语义对齐
 * `paths.ts` 的 `ensureDirectoryJunction`）。
 *
 * 行为矩阵：
 * | 现状 | 动作 |
 * |---|---|
 * | 不存在 | 建目标目录 → `symlinkSync(target, link, 'junction')` |
 * | 已是 junction 且指向 target（目标存在） | 无操作 |
 * | 已是 junction 但指向别处 / 悬空 | 摘除链接（**不递归**）→ 重建 |
 * | 是真实**空**目录 | 删除该空目录（不递归）→ 重建 |
 * | 是真实**非空**目录 | **拒绝操作**（绝不销毁数据），返回 false |
 *
 * @returns 最终 `link` 是否为指向 `target` 的有效 junction
 */
function ensureJunction(link: string, target: string): boolean {
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    return false;
  }

  let lstat: fs.Stats | null = null;
  try {
    lstat = fs.lstatSync(link);
  } catch {
    lstat = null;
  }

  if (lstat !== null) {
    if (lstat.isSymbolicLink()) {
      const current = readLinkTarget(link);
      // 已就位且目标可达 ⇒ 无操作（F20：用 statSync 判存在，不用 lstat().isDirectory()）
      if (current !== null && samePath(current, target) && existsFollow(link)) return true;
      try {
        removeLink(link);
      } catch {
        return false;
      }
    } else if (isEmptyDir(link)) {
      try {
        fs.rmdirSync(link);
      } catch {
        return false;
      }
    } else {
      return false; // 真实非空目录占用 —— 拒绝删除以免销毁数据
    }
  }

  try {
    fs.symlinkSync(target, link, 'junction');
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
// 布局派生
// ------------------------------------------------------------------

/**
 * `UpdaterLayout`（冻结 11 字段）**不含** `appServerDir`，故此处派生。
 *
 * 若 shell-eng 传入的是 `UserDataLayout`（结构同形 + 额外字段），
 * 优先采用它自带的 `appServerDir` / `appServerDataLink`，避免任何口径分歧；
 * 否则按 D7.1 字面量 `app-runtime/app-server` 派生。
 */
function appServerDirOf(layout: UpdaterLayout): string {
  const extra = (layout as unknown as { appServerDir?: unknown }).appServerDir;
  if (typeof extra === 'string' && extra.length > 0) return extra;
  return path.join(layout.appRuntimeDir, APP_SERVER_DIRNAME);
}

function appServerDataLinkOf(layout: UpdaterLayout): string {
  const extra = (layout as unknown as { appServerDataLink?: unknown }).appServerDataLink;
  if (typeof extra === 'string' && extra.length > 0) return extra;
  return path.join(appServerDirOf(layout), 'data');
}

function pluginsNodeModulesLinkOf(layout: UpdaterLayout): string {
  const extra = (layout as unknown as { pluginsNodeModulesLink?: unknown }).pluginsNodeModulesLink;
  if (typeof extra === 'string' && extra.length > 0) return extra;
  return path.join(layout.pluginsRoot, 'node_modules');
}

// ------------------------------------------------------------------
// 载荷结构定位
// ------------------------------------------------------------------

interface PayloadRoots {
  /** 含 `apps/` `packages/` `node_modules/` `pnpm-workspace.yaml` 的 server 负载根 */
  appServerRoot: string | null;
  /** 前端产物根（含 `index.html`） */
  webDistRoot: string | null;
}

async function listChildDirs(dir: string): Promise<string[]> {
  const dirents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  return dirents.filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
}

async function hasEntry(dir: string, name: string): Promise<boolean> {
  try {
    await fsp.access(path.join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * D7.5：读更新包里的载荷指纹（`<appServerRoot>/build-stamp.json`）。
 *
 * 缺失或损坏返回 null ⇒ 调用方不写 `buildId`（维持 D14.4 的两字段结构）。
 * 名称与 `paths.ts` 的 `BUILD_STAMP_NAME` 逐字一致；本文件按冻结边界不 import paths.ts。
 */
async function readBuildStampId(
  appServerRoot: string,
  log: (level: UpdaterLogLevel, message: string) => void,
): Promise<string | null> {
  const stampPath = path.join(appServerRoot, 'build-stamp.json');
  try {
    const raw = await fsp.readFile(stampPath, 'utf8');
    const parsed = JSON.parse(raw) as { buildId?: unknown };
    if (typeof parsed.buildId === 'string' && parsed.buildId.length > 0) {
      return parsed.buildId;
    }
    log('warn', `更新包的 build-stamp.json 缺少 buildId ⇒ 本次不写：${stampPath}`);
    return null;
  } catch (err) {
    log(
      'warn',
      `未找到更新包载荷指纹（${stampPath}）⇒ version.json 不写 buildId：${errText(err)}`,
    );
    return null;
  }
}

/**
 * 定位解压产物里的 server 负载根与前端产物根。
 *
 * 容忍两种打包形态：
 *  · 扁平：`<extract>/{apps,packages,node_modules,pnpm-workspace.yaml}` + `<extract>/web-dist/`
 *  · 嵌套：`<extract>/app-server/{apps,…}` + `<extract>/web-dist/`
 *
 * 判定锚点用 `pnpm-workspace.yaml`（D7.3 里 `resolveProjectRoot()` 的同一标记），
 * 前端产物用 `index.html`。
 */
async function locatePayloadRoots(extractDir: string): Promise<PayloadRoots> {
  const candidates: string[] = [extractDir, ...(await listChildDirs(extractDir))];

  let appServerRoot: string | null = null;
  for (const candidate of candidates) {
    if (await hasEntry(candidate, 'pnpm-workspace.yaml')) {
      appServerRoot = candidate;
      break;
    }
  }
  if (appServerRoot === null) {
    for (const candidate of candidates) {
      if ((await hasEntry(candidate, 'apps')) && (await hasEntry(candidate, 'packages'))) {
        appServerRoot = candidate;
        break;
      }
    }
  }

  let webDistRoot: string | null = null;
  for (const candidate of candidates) {
    if (path.basename(candidate) === 'web-dist' && (await hasEntry(candidate, 'index.html'))) {
      webDistRoot = candidate;
      break;
    }
  }
  if (webDistRoot === null) {
    for (const candidate of candidates) {
      if (await hasEntry(candidate, 'index.html')) {
        webDistRoot = candidate;
        break;
      }
    }
  }

  return { appServerRoot, webDistRoot };
}

// ------------------------------------------------------------------
// createUpdater
// ------------------------------------------------------------------

/** `check()` 的内部结果：`manifest` 已收窄为 `UpdaterManifest`（供 `applyApp` 复用）。 */
type CheckOutcome =
  | {
      ok: true;
      baseUrl: string;
      manifest: UpdaterManifest;
      appOutdated: boolean;
      pluginUpdates: ManifestPluginEntry[];
    }
  | { ok: false; error: string };

/**
 * 创建 updater。返回的 6 个方法**都不 reject**。
 */
export function createUpdater(ctx: UpdaterContext): Updater {
  const layout = ctx.layout;

  /** 日志安全壳：`ctx.log` 抛错也不能让方法 reject。 */
  const log = (level: UpdaterLogLevel, message: string): void => {
    try {
      ctx.log(level, message);
    } catch {
      /* 日志失败不影响更新流程 */
    }
  };

  const pluginsDir = ((): string => {
    try {
      return typeof ctx.pluginsDir === 'string' && ctx.pluginsDir.length > 0
        ? ctx.pluginsDir
        : layout.pluginsRoot;
    } catch {
      return '';
    }
  })();

  /** 当前生效版本。初始取 `ctx.appVersion`（D14.4：version.json，缺失回落 app.getVersion()）。 */
  let currentVersion = ((): string => {
    try {
      return String(ctx.appVersion ?? '');
    } catch {
      return '';
    }
  })();

  // ----------------------------------------------------------------
  // 内部：检查更新（check / applyApp / installPlugin 共用）
  // ----------------------------------------------------------------
  async function doCheck(): Promise<CheckOutcome> {
    const config = await readConfig(layout.updatesConfigPath);
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    if (baseUrl === '') return { ok: false, error: '未配置更新源' };

    const validated = validateBaseUrl(baseUrl);
    if (!validated.ok) return { ok: false, error: validated.error };

    log('info', `检查更新：${manifestUrlOf(baseUrl)}`);

    let raw: Buffer;
    try {
      raw = await fetchToBuffer(manifestUrlOf(baseUrl));
    } catch (err) {
      return { ok: false, error: `获取 manifest.json 失败：${errText(err)}` };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.toString('utf8')) as unknown;
    } catch (err) {
      return { ok: false, error: `manifest.json 不是合法 JSON：${errText(err)}` };
    }

    const parsed = parseManifest(parsedJson);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const manifest = parsed.manifest;

    const appOutdated = compareVersions(manifest.version, currentVersion) > 0;

    let installed: InstalledPlugin[] = [];
    try {
      installed = await scanInstalledPlugins(layout.pluginsRoot);
    } catch (err) {
      log('warn', `扫描已安装插件失败（按「全部未安装」处理）：${errText(err)}`);
    }
    const pluginUpdates = selectPluginUpdates(manifest.plugins, installed);

    log(
      'info',
      `检查完成：远端 v${manifest.version} / 本地 v${currentVersion} ⇒ ` +
        `appOutdated=${String(appOutdated)}，插件可更新 ${pluginUpdates.length} 个`,
    );

    return { ok: true, baseUrl, manifest, appOutdated, pluginUpdates };
  }

  // ----------------------------------------------------------------
  // ① getState
  // ----------------------------------------------------------------
  async function getState(): Promise<UpdaterStateResult> {
    try {
      const config = await readConfig(layout.updatesConfigPath);
      let plugins: InstalledPlugin[] = [];
      try {
        plugins = await scanInstalledPlugins(layout.pluginsRoot);
      } catch (err) {
        log('warn', `扫描已安装插件失败：${errText(err)}`);
      }
      return {
        appVersion: currentVersion,
        baseUrl: config.baseUrl,
        pluginsDir,
        plugins: plugins.map((p) => ({ id: p.id, version: p.version, dir: p.dir })),
      };
    } catch (err) {
      log('error', `读取更新器状态失败：${errText(err)}`);
      return { appVersion: currentVersion, baseUrl: '', pluginsDir, plugins: [] };
    }
  }

  // ----------------------------------------------------------------
  // ② setBaseUrl
  // ----------------------------------------------------------------
  async function setBaseUrl(baseUrl: string): Promise<UpdaterSetBaseUrlResult> {
    const normalized = normalizeBaseUrl(baseUrl);
    try {
      const validated = validateBaseUrl(normalized);
      if (!validated.ok) {
        log('warn', `更新源地址被拒绝：${validated.error}`);
        return { ok: false, baseUrl: normalized };
      }
      await writeConfig(layout.updatesConfigPath, { baseUrl: normalized });
      log('info', `更新源已保存：${normalized === '' ? '（空，更新已关闭）' : normalized}`);
      return { ok: true, baseUrl: normalized };
    } catch (err) {
      log('error', `保存更新源失败：${errText(err)}`);
      return { ok: false, baseUrl: normalized };
    }
  }

  // ----------------------------------------------------------------
  // ③ check
  // ----------------------------------------------------------------
  async function check(): Promise<UpdaterCheckResult> {
    try {
      const outcome = await doCheck();
      if (!outcome.ok) return { ok: false, error: outcome.error };
      return {
        ok: true,
        manifest: outcome.manifest,
        appOutdated: outcome.appOutdated,
        pluginUpdates: outcome.pluginUpdates,
      };
    } catch (err) {
      log('error', `检查更新异常：${errText(err)}`);
      return { ok: false, error: `检查更新失败：${errText(err)}` };
    }
  }

  // ----------------------------------------------------------------
  // ④ applyApp —— D14.5 九步
  // ----------------------------------------------------------------
  async function applyApp(): Promise<UpdaterApplyAppResult> {
    const appServerDir = appServerDirOf(layout);
    const appServerDataLink = appServerDataLinkOf(layout);
    const pluginsNodeModulesLink = pluginsNodeModulesLinkOf(layout);
    const backupsForVersion = path.join(layout.backupsDir, currentVersion || 'unknown');
    /** 失败时用于「明确报告已备份位置」的后缀。 */
    const backupHint = `已备份位置：${backupsForVersion}`;
    /** 本次解包目录（纯临时产物，成功/失败都要清）。 */
    let extractDirToClean: string | null = null;

    try {
      // ---- 步骤 1：读 config + check，无更新直接返回 ----
      const outcome = await doCheck();
      if (!outcome.ok) return { ok: false, error: outcome.error };
      if (!outcome.appOutdated) return { ok: false, error: '已是最新版本' };

      const { baseUrl, manifest } = outcome;
      const sha256 = manifest.app.sha256;
      const targetVersion = manifest.version;

      // ---- 步骤 2：下载（含 SHA-256 校验；不一致 ⇒ downloadToFile 已删文件并抛错）----
      const downloadPath = path.join(layout.updatesDir, 'downloads', `${sha256}.zip`);
      let artifactUrl: string;
      try {
        artifactUrl = resolveArtifactUrl(baseUrl, manifest.app.url);
      } catch (err) {
        return { ok: false, error: `manifest.app.url 非法：${errText(err)}` };
      }

      log('info', `开始下载应用更新包：${artifactUrl} → ${downloadPath}`);
      try {
        const result = await downloadToFile(artifactUrl, downloadPath, { expectedSha256: sha256 });
        log('info', `下载完成：${result.bytes} 字节，sha256=${result.sha256}`);
      } catch (err) {
        // D14.3-1：**校验失败绝不进入解压**。
        log('error', `下载或 SHA-256 校验失败，已中止更新：${errText(err)}`);
        return { ok: false, error: `下载失败或 SHA-256 校验未通过：${errText(err)}` };
      }

      // ---- 步骤 3：旧版本备份（D14.3-3；备份失败 ⇒ 中止）----
      log('info', `备份当前版本 v${currentVersion} → ${backupsForVersion}`);
      try {
        // ★ D7.3 红线：`app-server/data` 是 junction → <userData>/data，
        //   必须用 excludeNames 排除，否则会把用户全部项目数据复制进备份。
        const serverBackup = await backupDir(
          layout.backupsDir,
          currentVersion,
          'app-server',
          appServerDir,
          ['data'],
        );
        const webBackup = await backupDir(layout.backupsDir, currentVersion, 'web-dist', layout.webDistDir);
        log('info', `备份完成：app-server ${serverBackup.bytes} 字节 / web-dist ${webBackup.bytes} 字节`);
      } catch (err) {
        log('error', `备份失败，已中止更新：${errText(err)}`);
        return { ok: false, error: `备份失败，已中止更新：${errText(err)}` };
      }

      // ---- 步骤 4：安全解压（防路径穿越由 zip.ts 实现）----
      const extractDir = path.join(layout.updatesDir, 'extract', sha256);
      extractDirToClean = extractDir;
      await removeTreeSafely(extractDir);
      try {
        const extracted = await extractZipSecurelyLazy(downloadPath, extractDir);
        log('info', `解压完成：${extracted.files} 个文件 / ${extracted.bytes} 字节 → ${extractDir}`);
      } catch (err) {
        // D14.3-2：整包拒绝（含路径穿越 / CRC 失败）⇒ 返回失败，不抛异常。
        log('error', `解压失败（可能含不安全条目），已中止更新：${errText(err)}`);
        return { ok: false, error: `解压失败（可能含路径穿越等不安全条目），已中止更新：${errText(err)}` };
      }

      // ---- 步骤 4.5：定位载荷结构（写盘前先确认包内容可用）----
      const roots = await locatePayloadRoots(extractDir);
      if (roots.appServerRoot === null) {
        return {
          ok: false,
          error: `更新包内未找到 server 负载根（缺少 pnpm-workspace.yaml / apps / packages）：${extractDir}；${backupHint}`,
        };
      }
      if (roots.webDistRoot === null) {
        return {
          ok: false,
          error: `更新包内未找到前端产物（缺少 index.html）：${extractDir}；${backupHint}`,
        };
      }
      log('info', `载荷定位：app-server=${roots.appServerRoot} / web-dist=${roots.webDistRoot}`);

      // ---- 步骤 7a：替换前校验 D7.3 / D7.4 junction ----
      const dataJunctionBefore = ensureJunction(appServerDataLink, layout.dataDir);
      if (!dataJunctionBefore) {
        log(
          'error',
          `D7.3 前置校验失败：${appServerDataLink} 不是指向 ${layout.dataDir} 的 junction。` +
            `更新会让项目库落在被替换目录中，已中止。`,
        );
        return {
          ok: false,
          error: `D7.3 前置校验失败：${appServerDataLink} 未能成为指向 ${layout.dataDir} 的 junction，为避免项目数据风险已中止更新；${backupHint}`,
        };
      }
      ensureJunction(pluginsNodeModulesLink, path.join(appServerDir, 'node_modules'));

      // ---- 步骤 5：只替换 APP_REPLACE_ENTRIES 四项 ----
      const neverTouch = new Set<string>(APP_NEVER_TOUCH_ENTRIES);
      const replaced: string[] = [];
      const skipped: string[] = [];
      for (const entry of APP_REPLACE_ENTRIES) {
        // 防御性双保险：绝不允许任何形态触达 APP_NEVER_TOUCH_ENTRIES。
        if (neverTouch.has(entry)) continue;
        const src = path.join(roots.appServerRoot, entry);
        const dest = path.join(appServerDir, entry);
        if (dest === appServerDir || samePath(dest, appServerDir)) continue;
        if (!existsFollow(src)) {
          skipped.push(entry);
          continue;
        }
        await replacePathSafely(src, dest);
        replaced.push(entry);
      }
      log('info', `已替换 app-server 条目：${replaced.join(', ') || '（无）'}`);
      if (skipped.length > 0) {
        log('warn', `更新包未提供以下条目，保持原样：${skipped.join(', ')}`);
      }
      if (replaced.length === 0) {
        return {
          ok: false,
          error: `更新包未提供任何可替换条目（${APP_REPLACE_ENTRIES.join(', ')}）；${backupHint}`,
        };
      }

      // ---- 步骤 6：替换 web-dist ----
      await replacePathSafely(roots.webDistRoot, layout.webDistDir);
      log('info', `已替换 web-dist：${layout.webDistDir}`);

      // ---- 步骤 7b：替换后重建并校验 junction（D14.5-g）----
      const dataJunctionAfter = ensureJunction(appServerDataLink, layout.dataDir);
      if (!dataJunctionAfter || !existsFollow(appServerDataLink)) {
        const restoreNote = await restoreFromBackup(backupsForVersion, appServerDir, layout, replaced);
        log('error', `D7.3 后置校验失败，已尝试回滚：${restoreNote}`);
        return {
          ok: false,
          error:
            `D7.3 后置校验失败：${appServerDataLink} 未指向 ${layout.dataDir}。` +
            `已尝试从备份回滚（${restoreNote}）；${backupHint}`,
        };
      }
      const pluginsJunction = ensureJunction(pluginsNodeModulesLink, path.join(appServerDir, 'node_modules'));
      if (!pluginsJunction) {
        log('warn', `D7.4 junction 未就位：${pluginsNodeModulesLink}（插件依赖可能被隔离，下次启动会重试）`);
      }

      // ---- 步骤 8：写 version.json（D14.4 冻结结构 + D7.5 buildId）----
      // D7.5：把更新包携带的载荷指纹一并记下。否则下次启动时闸门会看到
      // 「同版本号但 buildId 不同」而重新播种，把刚装好的运行时覆盖回安装包里的旧载荷。
      const stampBuildId = await readBuildStampId(roots.appServerRoot, log);
      const versionPayload: { appVersion: string; updatedAt: string; buildId?: string } = {
        appVersion: targetVersion,
        updatedAt: new Date().toISOString(),
      };
      if (stampBuildId !== null) {
        versionPayload.buildId = stampBuildId;
      }
      try {
        await fsp.mkdir(path.dirname(layout.versionJsonPath), { recursive: true });
        const tmp = `${layout.versionJsonPath}.tmp`;
        await fsp.writeFile(tmp, `${JSON.stringify(versionPayload, null, 2)}\n`, 'utf8');
        await fsp.rename(tmp, layout.versionJsonPath);
        log('info', `version.json 已更新：${JSON.stringify(versionPayload)}`);
      } catch (err) {
        const restoreNote = await restoreFromBackup(backupsForVersion, appServerDir, layout, replaced);
        return {
          ok: false,
          error: `写入 version.json 失败：${errText(err)}。已尝试从备份回滚（${restoreNote}）；${backupHint}`,
        };
      }

      // ---- 步骤 9：成功 ----
      currentVersion = targetVersion;
      // 安装包已装好，压缩包留着没有意义（每份可达数百 MB）。
      try {
        await fsp.rm(downloadPath, { force: true });
      } catch {
        /* 删不掉不影响更新结果，next 次同版本会覆盖同一路径 */
      }
      log('info', `应用本体更新完成：v${targetVersion}（重启后生效）`);

      const ok: UpdaterApplyAppResult = { ok: true, version: targetVersion };
      if (typeof manifest.notes === 'string') ok.notes = manifest.notes;
      return ok;
    } catch (err) {
      // 兜底：任何未预期异常都不得 reject（D11.1）。
      const restoreNote = await restoreFromBackup(backupsForVersion, appServerDir, layout, []).catch(
        () => '回滚尝试本身失败',
      );
      log('error', `应用更新出现未预期异常，已尝试回滚（${restoreNote}）：${errText(err)}`);
      return {
        ok: false,
        error: `应用更新失败：${errText(err)}。已尝试从备份回滚（${restoreNote}）；${backupHint}`,
      };
    } finally {
      // ★ 解包树是纯临时产物：原实现只在「下一次更新开始时」清同名目录，
      //   于是每次更新都在 <userData>/updates/extract/<sha> 留一份完整载荷
      //   （app-server + web-dist，数百 MB），只增不减。
      if (extractDirToClean !== null) {
        try {
          await removeTreeSafely(extractDirToClean);
        } catch (cleanupErr) {
          log('warn', `清理解包目录失败（${extractDirToClean}）：${errText(cleanupErr)}`);
        }
      }
    }
  }

  /**
   * 从 `<backupsDir>/<oldVersion>/` 尽力回滚 `app-server` 的已替换条目与 `web-dist`。
   * **尽力而为**：任何子步骤失败只记日志，不抛给调用方。
   * @returns 人类可读的回滚结论（用于错误信息）
   */
  async function restoreFromBackup(
    backupsForVersion: string,
    appServerDir: string,
    targetLayout: UpdaterLayout,
    replacedEntries: string[],
  ): Promise<string> {
    const notes: string[] = [];
    const entries = replacedEntries.length > 0 ? replacedEntries : [...APP_REPLACE_ENTRIES];
    const backupServerRoot = path.join(backupsForVersion, 'app-server');
    const backupWebRoot = path.join(backupsForVersion, 'web-dist');

    for (const entry of entries) {
      const src = path.join(backupServerRoot, entry);
      if (!existsFollow(src)) continue;
      try {
        await replacePathSafely(src, path.join(appServerDir, entry));
        notes.push(`已回滚 ${entry}`);
      } catch (err) {
        notes.push(`回滚 ${entry} 失败（${errText(err)}）`);
      }
    }

    if (existsFollow(backupWebRoot)) {
      try {
        await replacePathSafely(backupWebRoot, targetLayout.webDistDir);
        notes.push('已回滚 web-dist');
      } catch (err) {
        notes.push(`回滚 web-dist 失败（${errText(err)}）`);
      }
    }

    // 回滚后仍要保证 D7.3 junction 在位。
    const restored = ensureJunction(appServerDataLinkOf(targetLayout), targetLayout.dataDir);
    notes.push(restored ? 'D7.3 junction 已就位' : 'D7.3 junction 未能就位（需人工检查）');

    return notes.join('；') || '无可用备份';
  }

  // ----------------------------------------------------------------
  // ⑤ installPlugin —— D14.5：只替换插件目录，**不重启后端**
  // ----------------------------------------------------------------
  async function installPlugin(pluginId: string): Promise<UpdaterInstallPluginResult> {
    try {
      const id = String(pluginId ?? '').trim();
      if (id === '') return { ok: false, error: '插件 id 为空' };

      const outcome = await doCheck();
      if (!outcome.ok) return { ok: false, error: outcome.error };

      let installed: InstalledPlugin[] = [];
      try {
        installed = await scanInstalledPlugins(layout.pluginsRoot);
      } catch (err) {
        log('warn', `扫描已安装插件失败：${errText(err)}`);
      }

      const entry = findPluginUpdate(outcome.manifest.plugins, installed, id);
      if (entry === null) {
        return { ok: false, error: `更新源中没有可更新的插件：${id}` };
      }

      // ---- 下载 + SHA-256 校验 ----
      const downloadPath = path.join(layout.updatesDir, 'downloads', `${entry.sha256}.zip`);
      let artifactUrl: string;
      try {
        artifactUrl = resolveArtifactUrl(outcome.baseUrl, entry.url);
      } catch (err) {
        return { ok: false, error: `插件 url 非法：${errText(err)}` };
      }
      log('info', `下载插件 ${id}：${artifactUrl}`);
      try {
        await downloadToFile(artifactUrl, downloadPath, { expectedSha256: entry.sha256 });
      } catch (err) {
        return { ok: false, error: `下载失败或 SHA-256 校验未通过：${errText(err)}` };
      }

      // ---- 安全解压 ----
      const extractDir = path.join(layout.updatesDir, 'extract', entry.sha256);
      await removeTreeSafely(extractDir);
      try {
        await extractZipSecurelyLazy(downloadPath, extractDir);
      } catch (err) {
        return { ok: false, error: `解压失败（可能含路径穿越等不安全条目）：${errText(err)}` };
      }

      // ---- 定位真正的插件包根 ----
      let pluginRoot: string;
      try {
        pluginRoot = await locatePluginRoot(extractDir, id);
      } catch (err) {
        return { ok: false, error: errText(err) };
      }

      // ---- 定位已安装位置（未安装 ⇒ 默认 local/<id>）----
      const existing = await findInstalledPluginDir(layout.pluginsRoot, id);
      const destDir = existing !== null ? existing.dir : path.join(layout.pluginsRoot, DEFAULT_PLUGIN_MODE, id);

      // ---- 先备份旧目录 ----
      if (existing !== null && existsFollow(existing.dir)) {
        try {
          await backupDir(layout.backupsDir, `${currentVersion || 'unknown'}-plugins`, id, existing.dir);
          log('info', `插件 ${id} 旧目录已备份（模式 ${existing.mode}）`);
        } catch (err) {
          log('error', `插件备份失败，已中止：${errText(err)}`);
          return { ok: false, error: `插件备份失败，已中止更新：${errText(err)}` };
        }
      }

      // ---- 替换插件目录 ----
      try {
        await replacePathSafely(pluginRoot, destDir);
      } catch (err) {
        return { ok: false, error: `替换插件目录失败：${errText(err)}` };
      }

      // 插件更新**不重启后端**（D14.5）：重启后重新扫描加载即可生效。
      log('info', `插件 ${id} 已更新到 v${entry.version}（重启应用后生效）`);

      const ok: UpdaterInstallPluginResult = { ok: true, id, version: entry.version };
      if (typeof entry.notes === 'string') ok.notes = entry.notes;
      return ok;
    } catch (err) {
      log('error', `插件更新出现未预期异常：${errText(err)}`);
      return { ok: false, error: `插件更新失败：${errText(err)}` };
    }
  }

  // ----------------------------------------------------------------
  // ⑥ relaunch
  // ----------------------------------------------------------------
  async function relaunch(): Promise<UpdaterRelaunchResult> {
    try {
      log('info', '请求重启应用（由 shell 优雅关停子进程后 app.relaunch()）');
      await ctx.relaunch();
      return { ok: true };
    } catch (err) {
      // UpdaterRelaunchResult 只有 { ok }，无 error 字段（.d.ts:30 冻结）。
      log('error', `重启失败：${errText(err)}`);
      return { ok: false };
    }
  }

  return { getState, setBaseUrl, check, applyApp, installPlugin, relaunch };
}

/**
 * `extractZipSecurely` 的薄包装：把「返回统计」与「调用方需要的字段」解耦，
 * 并保证**只在本文件内部**使用（对外契约不变）。
 */
async function extractZipSecurelyLazy(
  zipPath: string,
  destRoot: string,
): Promise<{ files: number; bytes: number }> {
  const { extractZipSecurely } = await import('./zip.js');
  const result = await extractZipSecurely(zipPath, destRoot);
  return { files: result.files.length, bytes: result.bytes };
}