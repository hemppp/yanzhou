/**
 * 砚舟 桌面壳 preload 脚本。
 *
 * 契约来源：ADR-0008 D11.1 / D11.2（冻结）。
 *  - 只注入 `window.desktopAPI`，恰好 9 个方法，签名与
 *    `apps/web/src/types/desktop-api.d.ts` 逐字一致（该文件第 2 行逐字引用了本文件路径，
 *    因此本文件不可改名、不可移位）。
 *  - 全部经 `ipcRenderer.invoke` 走 IPC；通道名一律从 `./ipc-channels.js` 取，
 *    **本文件不硬编码任何通道字符串**。
 *  - 一律不 reject：传输层失败统一降级为 `{ ok: false, error }`（见 `failure()`）。
 *  - 浏览器 dev 态不注入任何 polyfill —— 拿不到 `contextBridge` 时直接不注入。
 *
 * 本文件被 `apps/desktop/scripts/bundle-shell.mjs` 打成 `dist/preload.cjs`，
 * 以 CommonJS 载入（`sandbox: false` + `contextIsolation: true`）。
 */
import { contextBridge, ipcRenderer } from 'electron';

import {
  DESKTOP_API_CHANNELS,
  failure,
  type DesktopApi,
  type UpdaterApplyAppResult,
  type UpdaterCheckResult,
  type UpdaterInstallPluginResult,
  type UpdaterRelaunchResult,
  type UpdaterSetBaseUrlResult,
  type UpdaterState,
} from './desktop-api.js';

/** 已注册通道白名单（D11.2：未注册的通道必须在 preload 侧被拒绝）。 */
const REGISTERED_CHANNELS: ReadonlySet<string> = new Set<string>(
  Object.values(DESKTOP_API_CHANNELS),
);

/** 结构化克隆安全的空 `UpdaterState` 兜底（`updaterGetState` 失败时用，绝不 reject）。 */
function emptyUpdaterState(): UpdaterState {
  return { appVersion: '', baseUrl: '', pluginsDir: '', plugins: [] };
}

/**
 * 白名单校验 + 调用。未注册通道直接拒绝，不落到 `ipcRenderer.invoke`。
 */
function invokeChecked(channel: string, ...args: unknown[]): Promise<unknown> {
  if (!REGISTERED_CHANNELS.has(channel)) {
    return Promise.reject(new Error(`未注册的 IPC 通道被 preload 拒绝：${channel}`));
  }
  return ipcRenderer.invoke(channel, ...args);
}

/** `{ ok }` 形状的方法：失败降级为 `{ ok: false, error }`。 */
async function invokeOrFailure<T extends { ok: boolean }>(
  channel: string,
  ...args: unknown[]
): Promise<T> {
  try {
    return (await invokeChecked(channel, ...args)) as T;
  } catch (error) {
    return failure<T>(error);
  }
}

/** `Promise<string>` 形状的方法：失败返回空串（同样不 reject）。 */
async function invokeOrEmptyString(channel: string): Promise<string> {
  try {
    const value = await invokeChecked(channel);
    return typeof value === 'string' ? value : '';
  } catch (error) {
    console.warn(`[desktopAPI] ${channel} 调用失败：${String(error)}`);
    return '';
  }
}

/** `Promise<void>` 形状的方法：失败仅记录，不 reject。 */
async function invokeOrVoid(channel: string, ...args: unknown[]): Promise<void> {
  try {
    await invokeChecked(channel, ...args);
  } catch (error) {
    console.warn(`[desktopAPI] ${channel} 调用失败：${String(error)}`);
  }
}

/**
 * `updaterGetState` 的返回形状没有 `ok` 字段（前端直接读 `.baseUrl` / `.plugins`），
 * 因此失败时必须给一个结构合法的兜底对象，否则消费方 `UpdateSection.tsx` 会崩。
 */
async function invokeOrUpdaterState(channel: string): Promise<UpdaterState> {
  try {
    const value = (await invokeChecked(channel)) as UpdaterState | null;
    if (
      value !== null &&
      typeof value === 'object' &&
      Array.isArray(value.plugins) &&
      typeof value.baseUrl === 'string' &&
      typeof value.appVersion === 'string' &&
      typeof value.pluginsDir === 'string'
    ) {
      return value;
    }
    console.warn(`[desktopAPI] ${channel} 返回结构非法，已回退为空状态。`);
    return emptyUpdaterState();
  } catch (error) {
    console.warn(`[desktopAPI] ${channel} 调用失败：${String(error)}`);
    return emptyUpdaterState();
  }
}

/**
 * 冻结的 9 个方法。键名与顺序 = `apps/desktop/src/desktop-api.ts` 的 `DesktopApi`
 * = `apps/web/src/types/desktop-api.d.ts` 的 `window.desktopAPI`。
 */
const desktopAPI: DesktopApi = {
  getVersion: () => invokeOrEmptyString(DESKTOP_API_CHANNELS.getVersion),
  getDataPath: () => invokeOrEmptyString(DESKTOP_API_CHANNELS.getDataPath),
  relaunch: () => invokeOrVoid(DESKTOP_API_CHANNELS.relaunch),
  updaterGetState: () => invokeOrUpdaterState(DESKTOP_API_CHANNELS.updaterGetState),
  updaterSetBaseUrl: (baseUrl: string) =>
    invokeOrFailure<UpdaterSetBaseUrlResult>(DESKTOP_API_CHANNELS.updaterSetBaseUrl, baseUrl),
  updaterCheck: () => invokeOrFailure<UpdaterCheckResult>(DESKTOP_API_CHANNELS.updaterCheck),
  updaterApplyApp: () =>
    invokeOrFailure<UpdaterApplyAppResult>(DESKTOP_API_CHANNELS.updaterApplyApp),
  updaterInstallPlugin: (pluginId: string) =>
    invokeOrFailure<UpdaterInstallPluginResult>(
      DESKTOP_API_CHANNELS.updaterInstallPlugin,
      pluginId,
    ),
  updaterRelaunch: () =>
    invokeOrFailure<UpdaterRelaunchResult>(DESKTOP_API_CHANNELS.updaterRelaunch),
};

if (typeof contextBridge?.exposeInMainWorld === 'function') {
  contextBridge.exposeInMainWorld('desktopAPI', desktopAPI);
} else {
  // 浏览器 dev 态（无 contextBridge）：不注入任何 polyfill，让前端走 `window.desktopAPI?`
  // 的可选链分支。
  console.warn('[desktopAPI] contextBridge 不可用，未注入 window.desktopAPI（D11.1）。');
}