/**
 * 砚舟 桌面壳主进程入口。
 *
 * 契约来源：ADR-0008 D12.1 / D12.3 / D12.4 / D13.4（冻结）。
 *
 * 启动顺序严格 8 步：
 *   ① 单实例锁（`app.requestSingleInstanceLock()`）
 *   ② `await app.whenReady()`
 *   ③ 解析 userData 布局（`ensureLayout`，内部已含 D7.2 播种 + D7.3/D7.4 junction）
 *   ④ 确认 D7.3/D7.4 junction 状态（`ensureLayout` 已建立，此处只读报告）
 *   ⑤ 装配 D6 环境变量（`buildServerEnv`，含 JWT_SECRET 生成/读取）；
 *      并把系统代理解析结果（D6.3 `hostProxy`）一并透传给子进程
 *   ⑥ spawn server 子进程 → stderr 端口握手（D5.1）→ `/api/health` 就绪探针（D5.4）
 *   ⑦ 创建窗口并 `loadURL(<origin>)`
 *   ⑧ 注册优雅退出（`before-quit` / `window-all-closed`）
 *
 * 优雅退出逐字遵循 D13.4：写 stdin `novelmuse:shutdown\n` → 等 exit 上限 5000 ms →
 * 超时 `taskkill /PID <pid> /T /F` → `app.exit(0)`。**绝不使用 `child.kill('SIGTERM')`**
 * （ADR F7 实测证伪：Windows 上走 TerminateProcess，子进程信号处理器不执行）。
 */
import { app, dialog, ipcMain, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { IPC, IPC_CHANNEL_COUNT } from './ipc-channels.js';
import { buildServerEnv, parseChromiumProxy } from './env.js';
import { ShellLogger } from './logger.js';
import { ensureLayout, findRepoRoot } from './paths.js';
import { ServerProcessController } from './server-process.js';
import { createUpdater } from './updater/index.js';
import { failure } from './desktop-api.js';
import type {
  UpdaterApplyAppResult,
  UpdaterCheckResult,
  UpdaterInstallPluginResult,
  UpdaterRelaunchResult,
  UpdaterSetBaseUrlResult,
  UpdaterState,
} from './desktop-api.js';
import type { Updater } from './updater/types.js';
import type { LogLevel, UserDataLayout } from './types.js';
import { buildNavigationPolicy, createMainWindow, resolveDevOrigin } from './window.js';
import type { BrowserWindow } from 'electron';

/**
 * ★ ADR D7.1 **冻结**的 userData 目录名（Windows: `%APPDATA%\NovelMuse`）。
 *
 * ⚠️ 2026-10-27 品牌改名（听风细雨 → 砚舟）时**必须保持此值不变**：
 *   Electron 的 `app.setName()` 直接决定 `app.getPath('userData')`，
 *   改了它 ⇒ 新目录为空、老书稿全部"消失"（实际还在旧目录里，但用户看到的是丢稿）。
 *   品牌名（productName / 安装包名 / 窗口标题）可以改，**数据目录名不能改**。
 *   真要换目录，必须配一次显式迁移（把旧目录整体搬过去）——那是独立的一次改动。
 */
const APP_NAME = 'NovelMuse';

/**
 * 必须在**首次** `app.getPath('userData')` 之前设置。
 *
 * `apps/desktop/package.json` 顶层是 `"name": "@novel/desktop"`，`productName` 只在
 * `build` 段里 ⇒ 不显式改名的话 userData 会落到 `%APPDATA%\@novel\desktop`，
 * 而不是 ADR D7.1 冻结的 `%APPDATA%\NovelMuse`。
 */
app.setName(APP_NAME);

/** 打包态资源根；开发态为 `null`（`ensureLayout` 在打包态要求非空）。 */
function resourcesRootOf(isPackaged: boolean): string | null {
  return isPackaged ? process.resourcesPath : null;
}

let logger: ShellLogger | null = null;
let controller: ServerProcessController | null = null;
let updater: Updater | null = null;
let mainWindow: BrowserWindow | null = null;
let shuttingDown = false;
let serverOrigin: string | null = null;
let layout: UserDataLayout | null = null;

/** 未就绪阶段的兜底日志（logger 尚未构造时用）。 */
function earlyLog(level: LogLevel, message: string): void {
  if (logger !== null) {
    logger.log(level, message);
    return;
  }
  const line = `[main] ${message}`;
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/** 解析 server 入口与 cwd（D4.2 打包态 / D12.5 开发态）。 */
interface ServerTarget {
  entryPath: string;
  cwd: string;
  tsxCliPath: string | null;
  repoRoot: string | null;
}

function resolveServerTarget(
  isPackaged: boolean,
  layoutValue: UserDataLayout,
): ServerTarget | null {
  if (isPackaged) {
    return {
      entryPath: path.join(layoutValue.appServerDir, 'apps', 'server', 'src', 'index.ts'),
      cwd: layoutValue.appServerDir,
      tsxCliPath: path.join(layoutValue.appServerNodeModules, 'tsx', 'dist', 'cli.mjs'),
      repoRoot: null,
    };
  }
  // 开发态：从本文件所在目录（dist/）向上找 pnpm-workspace.yaml 定位仓库根。
  const repoRoot = findRepoRoot(__dirname);
  if (repoRoot === null) {
    return null;
  }
  return {
    entryPath: path.join(repoRoot, 'apps', 'server', 'src', 'index.ts'),
    cwd: repoRoot,
    tsxCliPath: path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    repoRoot,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 退出前留给日志写流落盘的有界窗口（毫秒）。
 *
 * 为什么必须等：`ShellLogger.close()` 内部是 `fs.createWriteStream(...).end()`，
 * 而 `end()` 只是把「尽快写完已排队数据」交给 libuv 线程池 —— 它**是异步的**，
 * 不会等数据真正落到磁盘。紧随其后的 `app.exit(code)` 会立即终止进程，缓冲区里
 * 尚未写出的行会一起丢失（日志文件甚至可能根本没被创建）。
 *
 * 实测复现（`D:\Temp\shell-probe\flush-nowait.mjs`）：`write×4 → end() →
 * process.exit(0)` 后文件**不存在**；把 `process.exit` 延后 150 ms 再跑，4 行完整落盘
 * （`flush-wait.log`）。这正是本轮冒烟中 `main.log` 缺失最后两行
 * （`server 子进程已按 stdin 协议自行退出…` 与 `优雅关停完成…`）的原因 ——
 * 它们已 echo 到控制台，却没能落盘，导致 D13.3 的 stdin 关停结论在主日志里不可复核。
 *
 * 取值权衡：这是**盲等**上界，不是同步屏障（`ShellLogger` 未暴露写流，无法
 * `await` 其 drain）。150 ms 远大于两条日志行的写延迟，又短到用户无感；
 * 宁可多等这一瞬，也不能让关停证据丢在主日志之外。
 */
const LOG_FLUSH_GRACE_MS = 150;

/** 优雅关停子进程并关闭日志（D13.4）。 */
async function gracefulShutdown(reason: string): Promise<void> {
  if (controller !== null) {
    try {
      await controller.stop(reason);
    } catch (error) {
      earlyLog('error', `关停 server 子进程时抛错：${String(error)}`);
    }
  }
  if (logger !== null) {
    logger.info(`优雅关停完成（reason=${reason}）⇒ 退出进程。`);
    logger.close();
    // close() 是异步落盘 ⇒ 退出前显式让出有界窗口，否则上面这行会丢。
    await delay(LOG_FLUSH_GRACE_MS);
  }
}

/** 完成关停后退出（D13.4 步骤 ④）。 */
async function shutdownAndExit(code: number, reason: string): Promise<void> {
  await gracefulShutdown(reason);
  app.exit(code);
}

/** 完成关停后重启（`relaunch` / `updaterRelaunch` 共用）。 */
async function shutdownAndRelaunch(reason: string): Promise<void> {
  await gracefulShutdown(reason);
  app.relaunch();
  app.exit(0);
}

/** 弹错误框 + 退出（启动失败 / 重启耗尽）。 */
function fatal(title: string, detail: string, code: number): void {
  earlyLog('error', `${title}：${detail}`);
  try {
    dialog.showErrorBox(title, detail);
  } catch (error) {
    earlyLog('error', `弹出错误对话框失败：${String(error)}`);
  }
  void shutdownAndExit(code, 'fatal');
}

/** 注册 9 条 IPC 通道（D11.2）。所有 handler 一律不 reject。 */
function registerIpcHandlers(): void {
  const registered = new Set<string>();

  const handle = (channel: string, listener: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, (_event, ...args) => {
      try {
        return listener(...(args as never[]));
      } catch (error) {
        // 同步抛错也必须降级成 { ok:false, error } 形状或安全值，绝不 reject。
        earlyLog('error', `IPC handler 抛错（${channel}）：${String(error)}`);
        return failure<{ ok: boolean }>(error);
      }
    });
    registered.add(channel);
  };

  handle(IPC.appGetVersion, () => app.getVersion());
  handle(IPC.appGetDataPath, () => app.getPath('userData'));
  handle(IPC.appRelaunch, async () => {
    // 与 updaterRelaunch 语义一致：先优雅关停，再 relaunch + exit。
    await shutdownAndRelaunch('ipc:app:relaunch');
  });

  const requireUpdater = (): Updater => {
    if (updater === null) {
      throw new Error('updater 尚未初始化（server 启动阶段未完成）');
    }
    return updater;
  };

  handle(IPC.updaterGetState, async (): Promise<UpdaterState> => requireUpdater().getState());
  handle(IPC.updaterSetBaseUrl, async (baseUrl: unknown): Promise<UpdaterSetBaseUrlResult> => {
    const target = requireUpdater();
    try {
      return await target.setBaseUrl(typeof baseUrl === 'string' ? baseUrl : '');
    } catch (error) {
      return failure<UpdaterSetBaseUrlResult>(error);
    }
  });
  handle(IPC.updaterCheck, async (): Promise<UpdaterCheckResult> => {
    const target = requireUpdater();
    try {
      return await target.check();
    } catch (error) {
      return failure<UpdaterCheckResult>(error);
    }
  });
  handle(IPC.updaterApplyApp, async (): Promise<UpdaterApplyAppResult> => {
    const target = requireUpdater();
    try {
      return await target.applyApp();
    } catch (error) {
      return failure<UpdaterApplyAppResult>(error);
    }
  });
  handle(
    IPC.updaterInstallPlugin,
    async (pluginId: unknown): Promise<UpdaterInstallPluginResult> => {
      const target = requireUpdater();
      try {
        return await target.installPlugin(typeof pluginId === 'string' ? pluginId : '');
      } catch (error) {
        return failure<UpdaterInstallPluginResult>(error);
      }
    },
  );
  handle(IPC.updaterRelaunch, async (): Promise<UpdaterRelaunchResult> => {
    const target = requireUpdater();
    try {
      return await target.relaunch();
    } catch (error) {
      return failure<UpdaterRelaunchResult>(error);
    }
  });

  if (registered.size !== IPC_CHANNEL_COUNT) {
    earlyLog(
      'error',
      `IPC 通道注册数量异常：已注册 ${registered.size} 条，契约要求 ${IPC_CHANNEL_COUNT} 条。`,
    );
  } else {
    earlyLog('info', `已注册 ${registered.size} 条 IPC 通道（D11.2）。`);
  }
}

/**
 * 步骤 ⑤.5：解析宿主**系统代理**，供 D6.3 透传给 server 子进程。
 *
 * 为什么需要：server 侧的 undici **只认** `HTTPS_PROXY` / `HTTP_PROXY` 环境变量，
 * 不读系统代理设置；而双击启动的便携版/安装版进程环境里本就没有这些变量
 * ⇒ AI 请求直连被墙服务（面板「测试连接」报「连接被重置」，2026-10-09 实测）。
 * Chromium 自己走系统代理，`session.resolveProxy()` 就是取那条配置的通道。
 *
 * 宿主**已显式设置**代理环境变量时直接返回 null —— 子进程默认继承 `process.env`，
 * 用户意图优先，不去覆盖（与 `buildServerEnv` 的 `||` 语义一致）。
 */
async function resolveHostProxy(): Promise<string | null> {
  const fromEnv =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (fromEnv) {
    logger?.info('宿主已有代理环境变量（HTTPS_PROXY/HTTP_PROXY）⇒ 子进程直接继承，不解析系统代理。');
    return null;
  }

  try {
    const raw = await session.defaultSession.resolveProxy('https://api.openai.com/');
    const proxyUrl = parseChromiumProxy(raw);
    if (proxyUrl === null) {
      logger?.info(
        `系统代理解析结果不适用于子进程（resolveProxy="${raw.trim()}"）⇒ 不注入，子进程自行直连。`,
      );
      return null;
    }
    logger?.info(`已从系统代理解析出可用代理：${proxyUrl}（resolveProxy="${raw.trim()}"）`);
    return proxyUrl;
  } catch (error) {
    logger?.warn(`解析系统代理失败：${String(error)} ⇒ 不注入，子进程自行直连。`);
    return null;
  }
}

/** 步骤 ⑥：spawn + 握手 + 就绪探针；首选失败时回退 tsx cli（D4.2 备选）。 */
async function startServer(
  isPackaged: boolean,
  layoutValue: UserDataLayout,
  target: ServerTarget,
): Promise<string | null> {
  const hostProxy = await resolveHostProxy();
  const envOptions = { layout: layoutValue, isPackaged, repoRoot: target.repoRoot, hostProxy };
  const serverEnv = buildServerEnv(envOptions, logger!.log);
  logger!.info(
    `D6 环境变量装配完成：注入 ${serverEnv.injectedKeys.length} 项` +
      `（JWT_SECRET ${serverEnv.jwtSecretGenerated ? '本次新生成' : '复用已有'}）。`,
  );

  const controllerOptions = {
    entryPath: target.entryPath,
    cwd: target.cwd,
    env: serverEnv.env,
    layout: layoutValue,
    logger: logger!,
    onRestarted: (info: { origin: string }): void => {
      serverOrigin = info.origin;
      logger!.info(`server 子进程重启成功 ⇒ 重新加载窗口到 ${info.origin}`);
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        void mainWindow.loadURL(`${info.origin}/`);
      }
    },
    onRestartExhausted: (info: {
      exitCode: number | null;
      signalCode: string | null;
      stderrTail: string;
      restartsInWindow: number;
    }): void => {
      fatal(
        '砚舟 后端服务反复崩溃',
        `后端服务在 60 秒窗口内已重启 ${info.restartsInWindow} 次仍未稳定，已停止重试。\n\n` +
          `最后一次退出：exitCode=${String(info.exitCode)}，signal=${String(info.signalCode)}\n\n` +
          `--- stderr 末尾 ---\n${info.stderrTail}`,
        1,
      );
    },
  };

  controller = new ServerProcessController({ ...controllerOptions, spawnMode: 'import' });
  let failureInfo = await controller.start();

  // D4.2 备选启动方式：`--import tsx` 失败且 tsx cli 存在时，回退 tsx/dist/cli.mjs。
  if (failureInfo !== null && target.tsxCliPath !== null && fs.existsSync(target.tsxCliPath)) {
    logger!.warn(
      `首选启动方式（--import tsx）失败（stage=${failureInfo.stage}）：${failureInfo.reason}` +
        ` ⇒ 按 D4.2 备选方式改用 tsx cli.mjs 重试。`,
    );
    controller = new ServerProcessController({
      ...controllerOptions,
      spawnMode: 'cli',
      tsxCliPath: target.tsxCliPath,
    });
    failureInfo = await controller.start();
  }

  if (failureInfo !== null) {
    const title =
      failureInfo.stage === 'early-exit'
        ? '砚舟 后端服务启动即退出'
        : '砚舟 后端服务启动失败';
    fatal(
      title,
      `启动阶段：${failureInfo.stage}\n原因：${failureInfo.reason}\n` +
        `exitCode=${String(failureInfo.exitCode)}，signal=${String(failureInfo.signalCode)}\n\n` +
        `--- stderr 末尾 ---\n${failureInfo.stderrTail}`,
      1,
    );
    return null;
  }

  const ready = controller.ready;
  if (ready === null) {
    fatal('砚舟 后端服务未就绪', '握手/探针返回成功但未拿到就绪信息（内部状态异常）。', 1);
    return null;
  }

  logger!.info(
    `server 就绪：origin=${ready.origin}，pid=${ready.pid}，` +
      `status=${ready.health.status}，database=${ready.health.database}，` +
      `plugins=${ready.health.plugins.length}，spawnMode=${controller.spawnMode}`,
  );

  if (ready.health.status === 'degraded' || ready.health.database !== 'connected') {
    // D5.4：degraded 仍然创建窗口，但必须落 WARN 并如实登记实际生效引擎。
    logger!.warn(
      `database unavailable —— /api/health 返回 status=${ready.health.status}，` +
        `database=${ready.health.database}（按 D5.4 仍然放行窗口创建）。` +
        `实际生效的数据库引擎见上方 [DB] 日志。`,
    );
  }

  updater = createUpdater({
    layout: layoutValue,
    appVersion: app.getVersion(),
    pluginsDir: layoutValue.pluginsRoot,
    relaunch: () => shutdownAndRelaunch('updater:relaunch'),
    log: (level, message) => {
      // UpdaterLog 只允许 info/warn/error；ShellLogger 的 log 还接受 debug。
      const sink = logger!;
      if (level === 'error') {
        sink.error(message);
      } else if (level === 'warn') {
        sink.warn(message);
      } else {
        sink.info(message);
      }
    },
  });

  return ready.origin;
}

/** 一次性管理员初始密码对话框（ADR :327-328，仅本次捕获到该行时弹）。 */
function maybeShowAdminPasswordDialog(password: string | null): void {
  if (password === null) {
    return;
  }
  const target =
    layout === null ? '<userData>/logs/initial-admin-password.txt' : layout.initialAdminPasswordPath;
  const body =
    `本次启动生成了管理员初始密码（仅本次显示）：\n\n${password}\n\n` +
    `已写入：${target}\n\n登录后请立即修改密码。`;
  logger?.warn('已捕获管理员初始密码，弹一次性提示对话框。');
  try {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '砚舟 管理员初始密码',
        message: '管理员初始密码（仅本次显示）',
        detail: body,
        buttons: ['知道了'],
      });
    } else {
      dialog.showErrorBox('砚舟 管理员初始密码', body);
    }
  } catch (error) {
    logger?.warn(`弹出管理员密码对话框失败：${String(error)}`);
  }
}

/** 步骤 ⑦：创建窗口并加载前端。 */
async function openWindow(isPackaged: boolean, origin: string): Promise<void> {
  const preloadPath = path.join(__dirname, 'preload.cjs');
  const devOrigin = resolveDevOrigin(isPackaged, process.env);
  const policy = buildNavigationPolicy(origin, isPackaged, process.env);

  mainWindow = createMainWindow({
    serverOrigin: policy.serverOrigin ?? origin,
    devOrigin: policy.devOrigin,
    preloadPath,
    logger: logger!,
    openDevTools: process.env.NOVELMUSE_OPEN_DEVTOOLS === '1',
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const url = devOrigin !== null ? devOrigin : `${origin}/`;

  if (devOrigin !== null) {
    // 仓库事实：`apps/web/vite.config.ts` 把 `/api` 代理到**固定 3774**，
    // 而桌面壳子进程用 PORT=0 随机端口 ⇒ 开发态下前端 API 调用默认打不到本进程。
    logger!.warn(
      `开发态前端地址：${devOrigin}（可用 NOVELMUSE_DEV_SERVER_URL 覆盖）。` +
        `注意 vite dev server 的 /api 代理指向固定 3774，与本进程随机端口不一致；` +
        `如需前端直连本进程，请设置 NOVELMUSE_DEV_SERVER_URL 并调整代理，或另起一个 3774 的后端。`,
    );
  }

  logger!.info(`加载前端：${url}`);
  await mainWindow.loadURL(url);
}

async function main(): Promise<void> {
  // ── 步骤 ①：单实例锁（D12.1）──────────────────────────────
  if (!app.requestSingleInstanceLock()) {
    // 未取得锁 ⇒ 立即退出，不建第二窗口、不重启子进程。
    console.log('[main] 未取得单实例锁 ⇒ 立即退出（D12.1）。');
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
    logger?.info('收到 second-instance ⇒ 已聚焦既有窗口（未创建新窗口）。');
  });

  // ── 步骤 ②：whenReady ───────────────────────────────────
  await app.whenReady();

  const isPackaged = app.isPackaged;
  const userDataPath = app.getPath('userData');
  const appVersion = app.getVersion();

  // ── 步骤 ③：解析 userData 布局（含播种 + junction）────────
  const layoutResult = ensureLayout(
    userDataPath,
    isPackaged,
    resourcesRootOf(isPackaged),
    appVersion,
    (level, message) => {
      // ensureLayout 在 logger 构造前调用，先缓冲到 console；构造后由 logger 接管。
      earlyLog(level, message);
    },
  );
  layout = layoutResult.layout;

  logger = new ShellLogger(layout);
  logger.info(
    `砚舟 桌面壳启动：version=${appVersion}，isPackaged=${String(isPackaged)}，` +
      `userData=${userDataPath}`,
  );

  // ── 步骤 ④：D7.3 / D7.4 junction 状态（ensureLayout 内已建立）──
  const junctions = layoutResult.junctions;
  logger.info(
    `运行时 junction 状态：data=${String(junctions.dataJunction)}，` +
      `plugins/node_modules=${String(junctions.pluginsNodeModulesJunction)}，` +
      `better-sqlite3=${String(junctions.betterSqlite3Junction)}` +
      `（attempted=${String(junctions.betterSqlite3Attempted)}）`,
  );
  if (!junctions.dataJunction) {
    // D7.3：这是不可逆数据风险的直接信号，必须显式告警。
    logger.error(
      'D7.3 junction 未建立：项目库将落在可被更新替换的目录中，' +
        '存在一次更新销毁全部项目数据的风险。',
    );
  }
  logger.info(
    `布局：seeded=${String(layoutResult.seeded)}，` +
      `reseeded=${String(layoutResult.reseeded)}，` +
      `appServerPresent=${String(layoutResult.appServerPresent)}，` +
      `appServerDir=${layout.appServerDir}`,
  );

  // ── 步骤 ⑥前置：定位 server 入口 ──────────────────────────
  const target = resolveServerTarget(isPackaged, layout);
  if (target === null) {
    fatal(
      '砚舟 无法定位仓库根',
      `开发态需要从 ${__dirname} 向上找到 pnpm-workspace.yaml，但未找到。`,
      1,
    );
    return;
  }
  if (!fs.existsSync(target.entryPath)) {
    fatal(
      '砚舟 后端入口缺失',
      `未找到 server 入口文件：${target.entryPath}\n` +
        (isPackaged
          ? '请确认安装包内的 resources/app-server 已正确解包（D7.2 播种）。'
          : '请确认在仓库根运行，且 apps/server/src/index.ts 存在。'),
      1,
    );
    return;
  }
  logger.info(`server 入口：${target.entryPath}（cwd=${target.cwd}）`);

  registerIpcHandlers();

  // ── 步骤 ⑥：spawn + 握手 + 探针 ─────────────────────────
  const origin = await startServer(isPackaged, layout, target);
  if (origin === null) {
    // fatal() 已负责关停与退出。
    return;
  }
  serverOrigin = origin;

  // ── 步骤 ⑦：窗口 ────────────────────────────────────────
  await openWindow(isPackaged, origin);

  // ── 步骤 ⑧：优雅退出 ────────────────────────────────────
  app.on('before-quit', (event) => {
    if (shuttingDown) {
      return;
    }
    // 阻止默认退出，先按 D13.4 关停子进程，再 app.exit(0)。
    event.preventDefault();
    shuttingDown = true;
    void shutdownAndExit(0, 'before-quit');
  });

  app.on('window-all-closed', () => {
    // 触发 before-quit ⇒ 走同一条优雅关停路径。
    app.quit();
  });

  maybeShowAdminPasswordDialog(controller?.adminPasswordCapturedThisRun ?? null);

  logger.info('砚舟 桌面壳启动完成（D12.3 全部 8 步已完成）。');
}

// D12.4：主进程自身异常 ⇒ 记日志，**不静默退出**。
process.on('uncaughtException', (error) => {
  earlyLog('error', `主进程未捕获异常：${error?.stack ?? String(error)}`);
});
process.on('unhandledRejection', (reason) => {
  earlyLog('error', `主进程未处理的 Promise 拒绝：${String(reason)}`);
});

void main().catch((error: unknown) => {
  fatal('砚舟 启动失败', `主进程启动流程抛出异常：\n${String(error)}`, 1);
});