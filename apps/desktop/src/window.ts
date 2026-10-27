/**
 * 砚舟 桌面壳窗口装配。
 *
 * 契约来源：ADR-0008 D12.2（冻结）。
 *  - 初始尺寸 1440×900，最小 1024×640。
 *  - `show: false` + `once('ready-to-show')` 再 `show()`，避免白屏闪烁。
 *  - `autoHideMenuBar: true`。
 *  - `webPreferences` 逐字冻结：`contextIsolation: true` / `nodeIntegration: false` /
 *    `sandbox: false` / `webSecurity: true` / `preload: <abs dist/preload.cjs>`。
 *  - `backgroundColor: '#121212'`（与 `apps/web/index.html` 固定的 `<html class="dark">`
 *    及 `.dark { --background: 0 0% 7% }` 一致）。
 *  - 外链：`setWindowOpenHandler` 一律 `{ action: 'deny' }`，http/https 改用 `shell.openExternal`。
 *  - 导航：同源白名单只放行 `http://127.0.0.1:<port>`（子进程 origin）与开发态前端 origin；
 *    其余一律 `preventDefault()` 拦截。
 */
import {
  BrowserWindow,
  shell,
  type BrowserWindowConstructorOptions,
} from 'electron';

import type { ShellLogger } from './logger.js';
import type { WindowNavigationPolicy } from './types.js';

/** 仓库事实：`apps/web/vite.config.ts` 的 `server.port = 5174`（`strictPort: true`）。 */
export const DEFAULT_DEV_ORIGIN = 'http://localhost:5174';

/**
 * 兼容放行的开发态 origin。
 *
 * ADR D12.2 写的是 5173，仓库事实是 5174（`apps/web/vite.config.ts:95-96`）。
 * 两个都放行，避免文档与仓库不一致时把开发态导航误拦。
 */
export const DEV_ORIGINS: readonly string[] = ['http://localhost:5174', 'http://localhost:5173'];

/** 可用 `NOVELMUSE_DEV_SERVER_URL` 覆盖开发态前端地址。 */
export const DEV_SERVER_URL_ENV = 'NOVELMUSE_DEV_SERVER_URL';

/** 窗口冻结尺寸（D12.2）。 */
export const WINDOW_WIDTH = 1440;
export const WINDOW_HEIGHT = 900;
export const WINDOW_MIN_WIDTH = 1024;
export const WINDOW_MIN_HEIGHT = 640;

/** 与前端 `<html class="dark">` 一致的背景色（D12.2 / captain 批准）。 */
export const WINDOW_BACKGROUND_COLOR = '#121212';

/**
 * 解析开发态前端 origin。
 *
 * @param isPackaged 打包态恒返回 `null`（打包态没有 vite dev server）。
 */
export function resolveDevOrigin(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (isPackaged) {
    return null;
  }
  const override = env[DEV_SERVER_URL_ENV]?.trim();
  if (override !== undefined && override !== '') {
    const normalized = normalizeOrigin(override);
    if (normalized !== null) {
      return normalized;
    }
  }
  return DEFAULT_DEV_ORIGIN;
}

/** 把任意 URL 规整成 `origin`；非法输入返回 `null`。 */
export function normalizeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** 装配 `WindowNavigationPolicy`（D12.2）。 */
export function buildNavigationPolicy(
  serverOrigin: string,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
): WindowNavigationPolicy {
  return {
    serverOrigin: normalizeOrigin(serverOrigin) ?? serverOrigin,
    devOrigin: resolveDevOrigin(isPackaged, env),
  };
}

/**
 * 允许导航的 origin 集合。
 *
 * 打包态：只有子进程 origin。开发态：子进程 origin + 开发态前端 origin（含 5174/5173 两个
 * 默认值，以及 `NOVELMUSE_DEV_SERVER_URL` 覆盖值）。
 */
export function allowedOrigins(
  policy: WindowNavigationPolicy,
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const allowed = new Set<string>();
  if (policy.serverOrigin !== null) {
    allowed.add(policy.serverOrigin);
  }
  if (policy.devOrigin !== null) {
    for (const origin of DEV_ORIGINS) {
      allowed.add(origin);
    }
    allowed.add(policy.devOrigin);
    const override = env[DEV_SERVER_URL_ENV]?.trim();
    if (override !== undefined && override !== '') {
      const normalized = normalizeOrigin(override);
      if (normalized !== null) {
        allowed.add(normalized);
      }
    }
  }
  return allowed;
}

/** 判断某个 URL 是否落在同源白名单内。 */
export function isAllowedNavigation(
  url: string,
  policy: WindowNavigationPolicy,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const origin = normalizeOrigin(url);
  if (origin === null) {
    return false;
  }
  return allowedOrigins(policy, env).has(origin);
}

/** 仅 http/https 允许交给系统浏览器打开。 */
export function isExternalOpenable(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export interface CreateMainWindowOptions {
  /** 子进程 origin，例如 `http://127.0.0.1:50598`。 */
  serverOrigin: string;
  /** 开发态前端 origin；打包态为 `null`。 */
  devOrigin: string | null;
  /** `dist/preload.cjs` 的绝对路径。 */
  preloadPath: string;
  logger: ShellLogger;
  /** 开发态可传 `true` 自动打开 DevTools。 */
  openDevTools?: boolean;
}

/**
 * 创建主窗口（D12.2）。**不**在此处 `loadURL`，由调用方决定加载哪个 origin。
 */
export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  const { serverOrigin, devOrigin, preloadPath, logger } = options;
  const policy: WindowNavigationPolicy = { serverOrigin, devOrigin };

  const webPreferences: BrowserWindowConstructorOptions['webPreferences'] = {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    webSecurity: true,
  };

  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    title: '砚舟',
    webPreferences,
  });

  window.once('ready-to-show', () => {
    logger.info('主窗口 ready-to-show ⇒ 显示窗口（D12.2）。');
    window.show();
  });

  // 外链一律 deny，改交系统浏览器（仅 http/https）。
  window.webContents.setWindowOpenHandler((details) => {
    if (isExternalOpenable(details.url)) {
      logger.info(`外链交给系统浏览器打开：${details.url}`);
      void shell.openExternal(details.url).catch((error: unknown) => {
        logger.warn(`shell.openExternal 失败（${details.url}）：${String(error)}`);
      });
    } else {
      logger.warn(`拒绝打开非 http/https 的外链：${details.url}`);
    }
    return { action: 'deny' };
  });

  // 导航白名单：只放行子进程 origin 与开发态前端 origin。
  window.webContents.on('will-navigate', (details) => {
    if (isAllowedNavigation(details.url, policy)) {
      return;
    }
    logger.warn(`拦截越界导航（同源白名单之外）：${details.url}`);
    details.preventDefault();
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    // -3 = ERR_ABORTED，通常是导航被主动打断，不算失败。
    if (errorCode === -3) {
      return;
    }
    logger.error(
      `页面加载失败（${String(errorCode)} ${errorDescription}）：${validatedURL}`,
    );
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`渲染进程异常退出：reason=${details.reason} exitCode=${details.exitCode}`);
  });

  if (options.openDevTools === true) {
    window.webContents.openDevTools({ mode: 'detach' });
  }

  logger.info(
    `主窗口已创建：${WINDOW_WIDTH}×${WINDOW_HEIGHT}（min ${WINDOW_MIN_WIDTH}×${WINDOW_MIN_HEIGHT}），` +
      `preload=${preloadPath}，serverOrigin=${serverOrigin}，devOrigin=${devOrigin ?? '(打包态)'}`,
  );

  return window;
}