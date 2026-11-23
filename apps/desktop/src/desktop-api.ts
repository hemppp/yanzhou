// ============================================================
// apps/desktop/src/desktop-api.ts
// `window.desktopAPI` 的**共享类型契约**（9 方法）。
//
// 唯一权威来源（**只读契约，不得修改**）：
//   apps/web/src/types/desktop-api.d.ts:10-31
//
// ADR-0008 D11.1 冻结：「`apps/desktop/src/preload.ts` 通过
// `contextBridge.exposeInMainWorld('desktopAPI', { … })` 注入的对象，
// **键名与返回结构必须与 `apps/web/src/types/desktop-api.d.ts:10-31`
// 逐字一致**（9 个方法，无多余键、无缺失键）」。
//
// 为什么单独成文件：主进程（main.ts 的 ipcMain.handle 返回值）与
// preload（contextBridge 暴露面）必须引用**同一组**类型，否则两侧会
// 漂移。captain 已裁定「承载 9 方法签名与返回值形状的共享类型文件是
// 合理实现细节，不要内联进 main.ts/preload.ts」。
//
// 本文件**不 import electron**：纯类型 + 常量，供两侧共用。
// ============================================================

import { IPC } from './ipc-channels.js';

/** 更新进度快照（轮询 `updaterGetState` 获取；不新增 IPC 通道）。 */
export interface UpdaterProgress {
  phase: string;
  receivedBytes: number;
  totalBytes: number;
  percent: number;
  message: string;
}

/**
 * `updaterGetState()` 的返回。
 * 逐字对齐 `apps/web/src/types/desktop-api.d.ts:14-19`。
 */
export interface UpdaterState {
  appVersion: string;
  baseUrl: string;
  pluginsDir: string;
  plugins: Array<{ id: string; version: string | null; dir: string }>;
  progress: UpdaterProgress;
}

/** `updaterSetBaseUrl()` 的返回。逐字对齐 `desktop-api.d.ts:20`。 */
export interface UpdaterSetBaseUrlResult {
  ok: boolean;
  baseUrl: string;
}

/** `updaterCheck()` 的返回。逐字对齐 `desktop-api.d.ts:21-27`。 */
export interface UpdaterCheckResult {
  ok: boolean;
  manifest?: unknown;
  appOutdated?: boolean;
  pluginUpdates?: unknown[];
  error?: string;
}

/** `updaterApplyApp()` 的返回。逐字对齐 `desktop-api.d.ts:28`。 */
export interface UpdaterApplyAppResult {
  ok: boolean;
  version?: string;
  notes?: string;
  error?: string;
}

/** `updaterInstallPlugin()` 的返回。逐字对齐 `desktop-api.d.ts:29`。 */
export interface UpdaterInstallPluginResult {
  ok: boolean;
  id?: string;
  version?: string;
  notes?: string;
  error?: string;
}

/** `updaterRelaunch()` 的返回。逐字对齐 `desktop-api.d.ts:30`。 */
export interface UpdaterRelaunchResult {
  ok: boolean;
}

/**
 * `window.desktopAPI` 的完整形状 —— 9 个方法，逐字对齐
 * `apps/web/src/types/desktop-api.d.ts:10-31`。
 *
 * 键顺序与 `.d.ts` 一致，便于人工逐行比对。
 */
export interface DesktopApi {
  /** 1. `() => Promise<string>` —— `.d.ts:11` */
  getVersion: () => Promise<string>;
  /** 2. `() => Promise<string>` —— `.d.ts:12` */
  getDataPath: () => Promise<string>;
  /** 3. `() => Promise<void>` —— `.d.ts:13` */
  relaunch: () => Promise<void>;
  /** 4. `() => Promise<UpdaterState>` —— `.d.ts:14-19` */
  updaterGetState: () => Promise<UpdaterState>;
  /** 5. `(baseUrl: string) => Promise<UpdaterSetBaseUrlResult>` —— `.d.ts:20` */
  updaterSetBaseUrl: (baseUrl: string) => Promise<UpdaterSetBaseUrlResult>;
  /** 6. `() => Promise<UpdaterCheckResult>` —— `.d.ts:21-27` */
  updaterCheck: () => Promise<UpdaterCheckResult>;
  /** 7. `() => Promise<UpdaterApplyAppResult>` —— `.d.ts:28` */
  updaterApplyApp: () => Promise<UpdaterApplyAppResult>;
  /** 8. `(pluginId: string) => Promise<UpdaterInstallPluginResult>` —— `.d.ts:29` */
  updaterInstallPlugin: (
    pluginId: string,
  ) => Promise<UpdaterInstallPluginResult>;
  /** 9. `() => Promise<UpdaterRelaunchResult>` —— `.d.ts:30` */
  updaterRelaunch: () => Promise<UpdaterRelaunchResult>;
}

/**
 * preload 侧可用的最小 `ipcRenderer` 视图。
 * 仅声明本 shell 实际使用的两个成员，避免把完整 Electron 类型
 * 泄漏到本纯契约文件里。
 */
export interface IpcInvoker {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * 由「通道名 → 处理函数」构成的注册表。
 * 主进程 `ipcMain.handle` 与 preload 的形参校验**共用**该键集合。
 */
export const DESKTOP_API_CHANNELS = {
  getVersion: IPC.appGetVersion,
  getDataPath: IPC.appGetDataPath,
  relaunch: IPC.appRelaunch,
  updaterGetState: IPC.updaterGetState,
  updaterSetBaseUrl: IPC.updaterSetBaseUrl,
  updaterCheck: IPC.updaterCheck,
  updaterApplyApp: IPC.updaterApplyApp,
  updaterInstallPlugin: IPC.updaterInstallPlugin,
  updaterRelaunch: IPC.updaterRelaunch,
} as const satisfies Record<keyof DesktopApi, string>;

/**
 * 失败兜底构造器：D11.1 冻结「失败一律以 `{ ok: false, error: string }`
 * 形式返回，**不得 reject**」。
 */
export function failure<T extends { ok: boolean }>(
  error: unknown,
): T & { ok: false; error: string } {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : (() => {
            try {
              return JSON.stringify(error) ?? String(error);
            } catch {
              return String(error);
            }
          })();
  return { ok: false, error: message } as T & { ok: false; error: string };
}