// ============================================================
// apps/desktop/src/updater/types.ts
// updater 模块的内部类型与对外契约类型。
//
// 契约来源（只读，不得修改）：
//   apps/web/src/types/desktop-api.d.ts:14-30   —— 6 个 updater 方法签名
//   apps/web/src/components/settings/UpdateSection.tsx:11-32 —— UI 侧结构
//   docs/architecture/desktop-packaging-adr.md  D14.1 / D14.2 / D14.4 —— 路径与字段名
//
// 本文件**不** import electron，也**不** import '../paths.js'：
//   updater 必须能在纯 Node（tsx）下独立跑端到端验证，
//   因此布局类型在此处定义为**结构同形**的接口（structural typing），
//   shell-eng 传入的 UserDataLayout 只要含同名字段即可通过类型检查。
// ============================================================

/**
 * updater 需要的最小 userData 布局视图。
 *
 * 结构同形于 shell-eng 的 `UserDataLayout`（apps/desktop/src/paths.ts）。
 * 字段名逐字来自 ADR D7.1 / D14.4 冻结的路径表。
 */
export interface UpdaterLayout {
  /** `<userData>` = `app.getPath('userData')` */
  userData: string;
  /** `<userData>/data` */
  dataDir: string;
  /** `<userData>/data/novelmuse.db` */
  dbPath: string;
  /** `<userData>/plugins` = PLUGINS_ROOT（D7.4） */
  pluginsRoot: string;
  /** `<userData>/app-runtime`（D7.1：被 updater 替换的目标根） */
  appRuntimeDir: string;
  /** `<userData>/app-runtime/web-dist` */
  webDistDir: string;
  /** `<userData>/app-runtime/version.json`（D14.4） */
  versionJsonPath: string;
  /** `<userData>/updates`（D14.4 下载/解压暂存根） */
  updatesDir: string;
  /** `<userData>/backups`（D14.4 备份根） */
  backupsDir: string;
  /** `<userData>/logs` */
  logsDir: string;
  /** `<userData>/updates/config.json`（D14.1 baseUrl 持久化位置） */
  updatesConfigPath: string;
}

/** 主进程侧日志回调（由 shell-eng 注入，落盘到 `<userData>/logs/main.log`）。 */
export type UpdaterLogLevel = 'info' | 'warn' | 'error';
export type UpdaterLog = (level: UpdaterLogLevel, message: string) => void;

/** `createUpdater()` 的入参。 */
export interface UpdaterContext {
  layout: UpdaterLayout;
  /** 当前生效版本（version.json，缺失回落 app.getVersion()）。 */
  appVersion: string;
  /** = layout.pluginsRoot（UI 直接展示该字符串）。 */
  pluginsDir: string;
  /** 由 shell-eng 提供：先优雅关停 server 子进程（D13.4）再 app.relaunch() + app.exit(0)。 */
  relaunch: () => Promise<void>;
  log: UpdaterLog;
  /**
   * 由 shell 注入：解析宿主系统代理（Chromium `session.resolveProxy`）。
   * 返回 `http(s)://host:port`；无代理返回 null。更新器自身不 import electron。
   */
  getProxyUrl?: () => Promise<string | null>;
}

/** `updaterGetState()` 的返回（逐字对齐 desktop-api.d.ts:14-19）。 */
export interface UpdaterStateResult {
  appVersion: string;
  baseUrl: string;
  pluginsDir: string;
  plugins: Array<{ id: string; version: string | null; dir: string }>;
}

/** `updaterSetBaseUrl()` 的返回（逐字对齐 desktop-api.d.ts:20）。 */
export interface UpdaterSetBaseUrlResult {
  ok: boolean;
  baseUrl: string;
}

/** `updaterCheck()` 的返回（逐字对齐 desktop-api.d.ts:21-27）。 */
export interface UpdaterCheckResult {
  ok: boolean;
  manifest?: unknown;
  appOutdated?: boolean;
  pluginUpdates?: unknown[];
  error?: string;
}

/** `updaterApplyApp()` 的返回（逐字对齐 desktop-api.d.ts:28）。 */
export interface UpdaterApplyAppResult {
  ok: boolean;
  version?: string;
  notes?: string;
  error?: string;
}

/** `updaterInstallPlugin()` 的返回（逐字对齐 desktop-api.d.ts:29）。 */
export interface UpdaterInstallPluginResult {
  ok: boolean;
  id?: string;
  version?: string;
  notes?: string;
  error?: string;
}

/** `updaterRelaunch()` 的返回（逐字对齐 desktop-api.d.ts:30）。 */
export interface UpdaterRelaunchResult {
  ok: boolean;
}

/** `createUpdater()` 的返回面（shell-eng 的 6 条 ipcMain.handle 逐条调用）。 */
export interface Updater {
  getState(): Promise<UpdaterStateResult>;
  setBaseUrl(baseUrl: string): Promise<UpdaterSetBaseUrlResult>;
  check(): Promise<UpdaterCheckResult>;
  applyApp(): Promise<UpdaterApplyAppResult>;
  installPlugin(pluginId: string): Promise<UpdaterInstallPluginResult>;
  relaunch(): Promise<UpdaterRelaunchResult>;
}

/**
 * `manifest.json` 的插件条目。
 * 字段名逐字来自 ADR D14.2，且必须与 `UpdateSection.tsx:18-25` 的
 * `PluginUpdateInfo` 逐字一致（UI 直接读这 6 个字段）。
 */
export interface ManifestPluginEntry {
  id: string;
  name: string;
  version: string;
  url: string;
  sha256: string;
  notes?: string;
}

/** `manifest.json` 顶层结构（逐字来自 ADR D14.2）。 */
export interface UpdaterManifest {
  version: string;
  notes?: string;
  publishedAt?: string;
  app: { url: string; sha256: string };
  plugins: ManifestPluginEntry[];
}

/** 本地已安装插件（`updaterGetState().plugins[]` 的元素，ADR D14.4）。 */
export interface InstalledPlugin {
  id: string;
  version: string | null;
  dir: string;
}

/** 插件物理模式目录（ADR D7.1 / D14.4）。 */
export const PLUGIN_MODES = ['auto', 'manual', 'shared', 'local'] as const;
export type PluginMode = (typeof PLUGIN_MODES)[number];

/** 单文件下载上限（ADR D14.3 补充冻结：512 MB）。 */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/** 单文件下载超时（ADR D14.3 补充冻结：120 s）。 */
export const DOWNLOAD_TIMEOUT_MS = 120_000;

/** 应用本体更新时被替换的条目（ADR D14.5-e，逐字四项）。 */
export const APP_REPLACE_ENTRIES = ['apps', 'packages', 'node_modules', 'pnpm-workspace.yaml'] as const;

/**
 * 应用本体更新时**绝不触碰**的条目。
 * ADR D7.3 硬规则：`data` 是 junction → `<userData>/data`，删掉即毁掉所有项目数据。
 */
export const APP_NEVER_TOUCH_ENTRIES = ['data', 'plugins'] as const;