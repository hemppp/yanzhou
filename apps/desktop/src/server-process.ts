// ============================================================
// apps/desktop/src/server-process.ts
// 内嵌 server 子进程的生命周期：spawn → stderr 端口握手 → /api/health
// 就绪探针 → 优雅退出（stdin 协议）→ 崩溃重启（D12.4）。
//
// 冻结契约（ADR-0008）：
//   D4.2  启动方式：spawn(process.execPath, ['--import','tsx','<entry>.ts'], { cwd, env })
//         备选：spawn(process.execPath, ['<app-server>/node_modules/tsx/dist/cli.mjs', '<entry>.ts'])
//   D5.1  端口只从 **stderr** 正则取（源头 host.ts:996 console.warn ⇒ stderr）：
//           ^\[Server\] Cordis 基座已就绪 → http://localhost:(\d+)$
//   D5.3  握手超时 15000 ms；健康探针 30 次 × 500 ms；总预算 30000 ms
//   D5.4  就绪判据逐字：status === 'ok' && database === 'connected'
//         status === 'degraded' ⇒ 仍然就绪（窗口照开），由调用方落 WARN
//   D6.2  管理员初始密码行捕获（0o600 落盘）
//   D12.4 就绪后意外退出 ⇒ 60 秒窗口内最多重启 3 次；超限交调用方弹框 + app.exit(1)
//   D13.4 退出时序：stdin 写 "novelmuse:shutdown\n" → 等 exit 上限 5000 ms
//         → 超时 taskkill /PID <pid> /T /F（/T 必须保留）→ 调用方 app.exit(0)
//
// ★ 红线（F7 实测证伪）：**绝不**用 child.kill('SIGTERM') / kill('SIGINT')。
//   Windows 上 Node 的 kill 走 TerminateProcess，子进程的信号处理器根本不执行；
//   sql.js 回退引擎下数据库只在内存，只有 closeDatabase() 才落盘 ⇒ 强杀丢数据。
// ============================================================

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';

import type { ShellLogger } from './logger.js';
import type {
  HealthResponse,
  Logger,
  ServerReadyInfo,
  ServerStartFailure,
  UserDataLayout,
} from './types.js';

// ------------------------------------------------------------
// 冻结常量
// ------------------------------------------------------------

/** D5.3：端口握手超时。 */
export const HANDSHAKE_TIMEOUT_MS = 15_000;
/** D5.3：健康探针次数。 */
export const HEALTH_PROBE_ATTEMPTS = 30;
/** D5.3：健康探针间隔。 */
export const HEALTH_PROBE_INTERVAL_MS = 500;
/** 单次探针的 HTTP 超时（必须 < 间隔，避免把 30 次预算拖成分钟级）。 */
export const HEALTH_PROBE_REQUEST_TIMEOUT_MS = 1_000;
/** D5.3：就绪探针阶段总预算（30 × 500）。 */
export const HEALTH_PHASE_BUDGET_MS = HEALTH_PROBE_ATTEMPTS * HEALTH_PROBE_INTERVAL_MS;
/** D5.3：总启动预算（spawn 起算）。 */
export const TOTAL_STARTUP_BUDGET_MS = 30_000;
/** D13.4：等待子进程自行退出的上限。 */
export const SHUTDOWN_TIMEOUT_MS = 5_000;
/** D12.4：重启窗口。 */
export const RESTART_WINDOW_MS = 60_000;
/** D12.4：窗口内最多重启次数。 */
export const RESTART_MAX_IN_WINDOW = 3;
/** D13.3：stdin 关闭令牌（逐字）。 */
export const SHUTDOWN_TOKEN = 'novelmuse:shutdown';

/**
 * D5.1 端口行正则（逐字来自 ADR，行首/行尾锚定）。
 * 注意 `→` 是 U+2192，与 `host.ts:996` 的源码逐字一致。
 */
const PORT_LINE_RE = /^\[Server\] Cordis 基座已就绪 → http:\/\/localhost:(\d+)$/;

/**
 * D6.2 管理员初始密码行正则（源头 `apps/server/src/index.ts:88` console.warn）。
 */
const ADMIN_PASSWORD_RE =
  /^\[Server\] 🔑 管理员初始密码（仅本次启动显示，请立即登录后修改）: (\S+)$/;

/** D6.2：密码文件权限。 */
const PASSWORD_FILE_MODE = 0o600;

// ------------------------------------------------------------
// 类型
// ------------------------------------------------------------

/** D4.2 的两种启动方式。 */
export type ServerSpawnMode = 'import' | 'cli';

interface ExitInfo {
  code: number | null;
  signal: string | null;
}

/** 握手阶段的判别式结果。 */
type HandshakeOutcome =
  | { kind: 'port'; port: number }
  | { kind: 'timeout' }
  | { kind: 'early-exit'; exitCode: number | null; signalCode: string | null }
  | { kind: 'spawn-error'; message: string }
  | { kind: 'stopped' };

/** 重启策略耗尽时上报给 main.ts 的信息（D12.4 弹框内容）。 */
export interface RestartExhaustedInfo {
  exitCode: number | null;
  signalCode: string | null;
  /** `logger.stderrTail(2000)` —— D5.3/D12.4 冻结的对话框内容。 */
  stderrTail: string;
  restartsInWindow: number;
}

/** `ServerProcessController` 的装配参数。 */
export interface ServerProcessOptions {
  /** server 入口绝对路径（打包态在 app-server 负载内；开发态在仓库内）。 */
  entryPath: string;
  /** 子进程 cwd（D4.2：打包态 = `<userData>/app-runtime/app-server`）。 */
  cwd: string;
  /** D6 冻结环境变量（由 `buildServerEnv()` 产出，含 ELECTRON_RUN_AS_NODE=1）。 */
  env: Record<string, string>;
  /** D7 布局（用于落 initial-admin-password.txt）。 */
  layout: UserDataLayout;
  /** 三路落盘日志器。 */
  logger: ShellLogger;
  /** 启动方式，默认 'import'（首选）。 */
  spawnMode?: ServerSpawnMode;
  /** 备选方式所需的 tsx CLI 入口绝对路径。 */
  tsxCliPath?: string | null;
  /** D12.4：重启额度耗尽时的回调（main.ts 弹错误对话框 + app.exit(1)）。 */
  onRestartExhausted?: (info: RestartExhaustedInfo) => void;
  /** 重启成功后的回调（端口可能变化 ⇒ main.ts 需把窗口重新加载到新 origin）。 */
  onRestarted?: (info: ServerReadyInfo) => void;
}

// ------------------------------------------------------------
// 小工具
// ------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 单次 `GET /api/health`（走 node:http，避免 Electron fetch 的系统代理干扰）。 */
function probeHealth(port: number, timeoutMs: number): Promise<HealthResponse | null> {
  return new Promise<HealthResponse | null>((resolve) => {
    let settled = false;
    const finish = (value: HealthResponse | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    let req: http.ClientRequest;
    try {
      req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/health',
          method: 'GET',
          timeout: timeoutMs,
          headers: { accept: 'application/json' },
        },
        (res) => {
          if ((res.statusCode ?? 0) !== 200) {
            res.resume();
            finish(null);
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body) as Partial<HealthResponse>;
              if (typeof parsed.status === 'string' && typeof parsed.database === 'string') {
                finish(parsed as HealthResponse);
              } else {
                finish(null);
              }
            } catch {
              finish(null);
            }
          });
          res.on('error', () => finish(null));
        },
      );
    } catch {
      finish(null);
      return;
    }

    req.on('error', () => finish(null));
    req.on('timeout', () => {
      req.destroy();
      finish(null);
    });
    req.end();
  });
}

/**
 * D13.4 步骤 ③：强杀整棵进程树。
 * `/T` **必须保留**（连同子树一起结束），否则会留孤儿 tsx 进程。
 */
async function taskkillTree(pid: number, log: Logger): Promise<void> {
  if (process.platform !== 'win32') {
    // 非 Windows 兜底（本 ADR 目标平台为 Windows x64）
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      log('warn', `强杀子进程失败（pid=${pid}）：${String(error)}`);
    }
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', (error) => {
        log('warn', `taskkill 调用失败（pid=${pid}）：${String(error)}`);
        done();
      });
      killer.once('exit', (code) => {
        log('info', `已执行 taskkill /PID ${pid} /T /F（exitCode=${String(code)}）`);
        done();
      });
    } catch (error) {
      log('warn', `taskkill 调用抛错（pid=${pid}）：${String(error)}`);
      done();
    }
    const guard = setTimeout(done, 5_000);
    guard.unref?.();
  });
}

// ------------------------------------------------------------
// 控制器
// ------------------------------------------------------------

/**
 * 内嵌 server 子进程控制器。
 *
 * 生命周期：`start()`（可重复调用，用于 D12.4 重启）→ `stop()`（D13.4）。
 * 就绪后的意外退出由本类内部按 D12.4 策略重启；额度耗尽才回调 main.ts。
 */
export class ServerProcessController {
  private readonly options: ServerProcessOptions;
  private readonly log: Logger;

  private child: ChildProcess | null = null;
  private exitInfo: ExitInfo | null = null;
  private exitWaiters: Array<(info: ExitInfo | null) => void> = [];
  private handshakeResolve: ((outcome: HandshakeOutcome) => void) | null = null;
  private pendingSpawnError: string | null = null;
  private readyInfo: ServerReadyInfo | null = null;
  private stopping = false;
  private restarting = false;
  private adminPassword: string | null = null;
  private restartTimes: number[] = [];
  private lastSpawnMode: ServerSpawnMode = 'import';

  /** 当前子进程的两条 readline 读取器（丢弃 child 时必须显式关闭）。 */
  private outReader: readline.Interface | null = null;
  private errReader: readline.Interface | null = null;
  /** `restarting` 闩锁期间被吞掉的退出，出闩后补跑一次。 */
  private pendingRestart: { code: number | null; signalCode: string | null } | null = null;

  constructor(options: ServerProcessOptions) {
    this.options = options;
    this.log = options.logger.log;
  }

  /** 就绪信息（未就绪为 null）。 */
  get ready(): ServerReadyInfo | null {
    return this.readyInfo;
  }

  /** 子进程 pid（未启动为 null）。 */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /**
   * 本次启动**真的**捕获到的管理员初始密码；未捕获为 null。
   * main.ts 只在非 null 时弹一次性对话框（D6.2）。
   */
  get adminPasswordCapturedThisRun(): string | null {
    return this.adminPassword;
  }

  /** 本次实际使用的启动方式（首选 'import' / 备选 'cli'）。 */
  get spawnMode(): ServerSpawnMode {
    return this.lastSpawnMode;
  }

  // ----------------------------------------------------------
  // 启动
  // ----------------------------------------------------------

  /**
   * 启动子进程并等待就绪。
   *
   * @returns 成功返回 null（此时 `this.ready` 非空）；失败返回 `ServerStartFailure`。
   */
  async start(): Promise<ServerStartFailure | null> {
    // ★ 粘性关停：`stop()` 之后（或关停流程进行中）绝不能再拉新子进程。
    //   `resetForStart()` 曾把 stopping 重置为 false，于是「before-quit 已开始关停、
    //   重启策略正好在一次 await 之后调 start()」会新起一个没人负责停的 child。
    if (this.stopping) {
      return this.failure('shutdown-requested', '启动请求到达时已进入关停流程。', null, null);
    }
    this.resetForStart();
    const bootStart = Date.now();

    try {
      this.child = this.spawnChild();
    } catch (error) {
      return this.failStart('spawn', `server 子进程启动失败：${String(error)}`, null, null);
    }

    const child = this.child;
    this.attachStreams(child);
    this.attachLifecycle(child);

    this.log(
      'info',
      `已启动 server 子进程（pid=${String(child.pid ?? -1)}，mode=${this.lastSpawnMode}，` +
        `cwd=${this.options.cwd}，entry=${this.options.entryPath}）`,
    );

    // ---- ① 端口握手（D5.1 / D5.3）----
    const handshake = await this.waitForHandshake();
    if (handshake.kind === 'spawn-error') {
      return this.failStart('spawn', `server 子进程启动失败：${handshake.message}`, null, null);
    }
    if (handshake.kind === 'stopped') {
      // 关停由 stop() 自己负责（它正在走优雅协议），这里不能再抢着 taskkill。
      return this.failure('shutdown-requested', '启动过程中收到关停请求。', null, null);
    }
    if (handshake.kind === 'early-exit') {
      return this.failStart(
        'early-exit',
        `server 子进程在握手完成前退出（exitCode=${String(handshake.exitCode)}，` +
          `signal=${String(handshake.signalCode)}）。`,
        handshake.exitCode,
        handshake.signalCode,
      );
    }
    if (handshake.kind === 'timeout') {
      return this.failStart(
        'handshake-timeout',
        `等待 server 端口握手超时（${HANDSHAKE_TIMEOUT_MS} ms 内未在 stderr 匹配到 ` +
          `"[Server] Cordis 基座已就绪 → http://localhost:<port>"）。`,
        null,
        null,
      );
    }

    const port = handshake.port;
    const origin = `http://127.0.0.1:${port}`;
    this.log('info', `端口握手成功：${origin}（来自子进程 stderr，D5.1）`);

    // ---- ② 就绪探针（D5.3 / D5.4）----
    const healthOutcome = await this.waitForHealth(port, bootStart);
    if (healthOutcome.kind === 'failure') {
      // 探针失败时子进程通常还活着（只是 /api/health 没达判据）：必须回收，
      // 否则重启策略下一次 start() 会再拉一个，旧的就成了孤儿。
      await this.abandonChild(healthOutcome.failure.stage);
      return healthOutcome.failure;
    }
    const health = healthOutcome.health;

    if (health.status === 'degraded' || health.database !== 'connected') {
      // D5.4 逐字：degraded 仍然创建窗口，但必须落一条 WARN。
      this.log(
        'warn',
        `database unavailable —— /api/health 返回 status=${health.status}，` +
          `database=${health.database}（按 D5.4 仍然放行窗口创建）。`,
      );
    } else {
      this.log(
        'info',
        `就绪探针通过：status=${health.status}，database=${health.database}，` +
          `hostMode=${health.hostMode}，plugins=${health.plugins.length}`,
      );
    }

    this.readyInfo = {
      port,
      origin,
      health,
      pid: child.pid ?? -1,
    };
    return null;
  }

  // ----------------------------------------------------------
  // 优雅退出（D13.4 逐字时序）
  // ----------------------------------------------------------

  /**
   * D13.4 冻结时序：
   *   ① 向 stdin 写一行 `novelmuse:shutdown\n`
   *   ② 等子进程 'exit'，上限 5000 ms
   *   ③ 超时 ⇒ `taskkill /PID <pid> /T /F`
   *   ④ 由调用方 `app.exit(0)`
   *
   * 幂等：重复调用安全。
   */
  async stop(reason: string): Promise<void> {
    const child = this.child;
    this.stopping = true;
    this.readyInfo = null;

    if (this.handshakeResolve !== null) {
      const finish = this.handshakeResolve;
      this.handshakeResolve = null;
      finish({ kind: 'stopped' });
    }

    if (child === null || this.exitInfo !== null) {
      this.log('info', `server 子进程不在运行，无需关停（reason=${reason}）`);
      return;
    }

    const pid = child.pid ?? null;
    this.log(
      'info',
      `开始优雅关停 server 子进程（pid=${String(pid)}，reason=${reason}）：` +
        `按 D13.3 向 stdin 写入 "${SHUTDOWN_TOKEN}"`,
    );

    // 退出信息从 waitForExit() 的返回值取，而不是 await 之后再读 this.exitInfo
    // —— 见 waitForExit() 的注释（TS2339 / 真实时序竞争）。
    const exitPromise = this.waitForExit();

    try {
      child.stdin?.write(`${SHUTDOWN_TOKEN}\n`);
    } catch (error) {
      this.log('warn', `向子进程 stdin 写入关闭令牌失败：${String(error)}`);
    }

    const outcome = await Promise.race([
      exitPromise.then((info) => ({ timedOut: false as const, info })),
      delay(SHUTDOWN_TIMEOUT_MS).then(() => ({ timedOut: true as const, info: null })),
    ]);

    if (!outcome.timedOut) {
      const code: number | null = outcome.info === null ? null : outcome.info.code;
      this.log(
        'info',
        `server 子进程已按 stdin 协议自行退出（exitCode=${String(code)}）` +
          `—— 数据库已在 closeGracefully() 中落盘。`,
      );
    } else {
      this.log(
        'warn',
        `server 子进程 ${SHUTDOWN_TIMEOUT_MS} ms 内未响应 stdin ⇒ 按 D13.4 步骤 ③ 强杀。`,
      );
      if (pid !== null) {
        await taskkillTree(pid, this.log);
      }
      await Promise.race([exitPromise, delay(2_000)]);
    }

    try {
      child.stdin?.destroy();
    } catch {
      /* 已关闭 */
    }
  }

  // ----------------------------------------------------------
  // 内部：spawn
  // ----------------------------------------------------------

  private resetForStart(): void {
    this.exitInfo = null;
    this.exitWaiters = [];
    this.handshakeResolve = null;
    this.pendingSpawnError = null;
    this.readyInfo = null;
    // ★ 不在这里清 `stopping`：关停是粘性的（start() 入口会据此拒绝再拉起）。
    this.adminPassword = null;
    this.child = null;
    this.closeReaders();
  }

  /** 关闭当前子进程的两条读流（丢弃 child / 子进程退出时调用）。 */
  private closeReaders(): void {
    for (const reader of [this.outReader, this.errReader]) {
      try {
        reader?.close();
      } catch {
        /* 已关闭 */
      }
    }
    this.outReader = null;
    this.errReader = null;
  }

  /**
   * 启动失败后的统一收尾：**先结束仍存活的子进程**，再返回结构化失败。
   *
   * 为什么必须在 start() 内部做：`handshake-timeout` 与 `health-timeout` 这两种
   * 失败发生时子进程还活着（它只是没握手成功 / 探针没通过）。若直接返回失败，
   * 调用方（D12.4 重启策略）会在下一轮 `start()` 里 `resetForStart()` 覆盖 child
   * 引用 —— 旧进程从此无人认领：占着端口与项目库句柄，它的 stderr 读流还继续
   * 往共享的握手/密码状态里写，重启满 3 次就能攒出 3 个孤儿。
   *
   * 这里不走 `stop()` 的优雅协议：启动都失败了，不能指望它对 stdin 有响应。
   */
  private async failStart(
    stage: ServerStartFailure['stage'],
    reason: string,
    exitCode: number | null,
    signalCode: string | null,
  ): Promise<ServerStartFailure> {
    await this.abandonChild(stage);
    return this.failure(stage, reason, exitCode, signalCode);
  }

  /** 无条件结束当前子进程（并丢弃它的读流），不做优雅等待。 */
  private async abandonChild(stage: string): Promise<void> {
    const child = this.child;
    if (child === null) return;
    if (this.exitInfo !== null) {
      // 已自行退出：只需清引用与读流。
      this.child = null;
      this.closeReaders();
      return;
    }
    const pid = child.pid ?? null;
    this.log(
      'warn',
      `启动失败（stage=${stage}）⇒ 结束遗留子进程（pid=${String(pid)}），` +
        `避免它继续占用端口与项目库句柄。`,
    );
    this.closeReaders();
    try {
      child.stdin?.destroy();
    } catch {
      /* 已关闭 */
    }
    if (pid !== null) {
      await taskkillTree(pid, this.log);
    }
    if (this.child === child) {
      this.child = null;
    }
  }

  private spawnChild(): ChildProcess {
    const mode = this.options.spawnMode ?? 'import';
    this.lastSpawnMode = mode;

    let args: string[];
    if (mode === 'cli') {
      const cli = this.options.tsxCliPath;
      if (typeof cli !== 'string' || cli.length === 0) {
        throw new Error('备选启动方式（tsx cli.mjs）需要提供 tsxCliPath');
      }
      args = [cli, this.options.entryPath];
    } else {
      // D4.2 首选：--import tsx（tsx 从 cwd 起解析 node_modules）
      args = ['--import', 'tsx', this.options.entryPath];
    }

    return spawn(process.execPath, args, {
      cwd: this.options.cwd,
      env: this.options.env,
      // D13.3 冻结：stdin 必须是管道（优雅关闭通道），不能是 'ignore'
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  private attachStreams(child: ChildProcess): void {
    this.closeReaders();
    if (child.stdout !== null) {
      const outReader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      outReader.on('line', (line: string) => {
        // 被丢弃的旧子进程即使还在跑，也不能再往日志/握手状态里写。
        if (this.child !== child) return;
        // 逐字落盘（logger.writeRaw 保证不加时间戳前缀）
        this.options.logger.serverLine('out', line);
      });
      this.outReader = outReader;
    }

    if (child.stderr !== null) {
      const errReader = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
      errReader.on('line', (line: string) => {
        if (this.child !== child) return;
        this.handleStderrLine(line);
      });
      this.errReader = errReader;
    }
  }

  /**
   * 一行子进程 stderr：原样落盘 → 端口握手 → D6.2 密码捕获。
   *
   * 落盘必须在解析之前，且**不加任何前缀**：端口正则与密码正则都要求
   * 行首锚定，日志文件必须能用同一正则复核。
   */
  private handleStderrLine(line: string): void {
    this.options.logger.serverLine('err', line);

    const probe = line.endsWith('\r') ? line.slice(0, -1) : line;

    const portMatch = PORT_LINE_RE.exec(probe);
    if (portMatch !== null && this.handshakeResolve !== null) {
      const port = Number(portMatch[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        const finish = this.handshakeResolve;
        this.handshakeResolve = null;
        finish({ kind: 'port', port });
      }
    }

    const passwordMatch = ADMIN_PASSWORD_RE.exec(probe);
    if (passwordMatch !== null) {
      this.captureAdminPassword(passwordMatch[1]);
    }
  }

  /** D6.2：把管理员初始密码落到 `<userData>/logs/initial-admin-password.txt`（0o600）。 */
  private captureAdminPassword(password: string): void {
    this.adminPassword = password;
    const target = this.options.layout.initialAdminPasswordPath;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${password}\n`, {
        encoding: 'utf8',
        mode: PASSWORD_FILE_MODE,
      });
      this.log('info', `已捕获管理员初始密码并写入 ${target}（0o600，仅本次启动有效）`);
    } catch (error) {
      this.log('warn', `管理员初始密码落盘失败（${target}）：${String(error)}`);
    }
  }

  private attachLifecycle(child: ChildProcess): void {
    child.once('error', (error: Error) => {
      // 已被丢弃的旧子进程：不许再改共享状态（否则会把新 child 的握手搞乱）。
      if (this.child !== child) return;
      const message = `${error.name}: ${error.message}`;
      this.pendingSpawnError = message;
      this.log('error', `server 子进程 spawn/运行错误：${message}`);
      if (this.handshakeResolve !== null) {
        const finish = this.handshakeResolve;
        this.handshakeResolve = null;
        finish({ kind: 'spawn-error', message });
      }
    });

    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // 旧子进程的退出不得覆盖当前 child 的退出信息（会让 stop() 误判「不在运行」）。
      if (this.child !== child) return;
      this.exitInfo = { code, signal: signal === null ? null : String(signal) };
      this.child = null;
      this.closeReaders();
      this.notifyExitWaiters();

      if (this.stopping) {
        this.log('info', `server 子进程已退出（exitCode=${String(code)}，signal=${String(signal)}）`);
        return;
      }

      if (this.handshakeResolve !== null) {
        const finish = this.handshakeResolve;
        this.handshakeResolve = null;
        finish({
          kind: 'early-exit',
          exitCode: code,
          signalCode: signal === null ? null : String(signal),
        });
        return;
      }

      if (this.readyInfo === null) {
        // 启动失败路径已由 start() 返回结构化失败，此处不重复处理。
        return;
      }

      // D12.4：就绪后意外退出 ⇒ 走重启策略
      this.readyInfo = null;
      void this.runRestartPolicy(code, signal === null ? null : String(signal));
    });
  }

  // ----------------------------------------------------------
  // 内部：握手 / 探针
  // ----------------------------------------------------------

  private waitForHandshake(): Promise<HandshakeOutcome> {
    return new Promise<HandshakeOutcome>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (outcome: HandshakeOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
        }
        if (this.handshakeResolve === finish) {
          this.handshakeResolve = null;
        }
        resolve(outcome);
      };

      // 先登记，再检查「已经发生」的两种情形，避免丢事件。
      this.handshakeResolve = finish;
      timer = setTimeout(() => finish({ kind: 'timeout' }), HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();

      if (this.pendingSpawnError !== null) {
        finish({ kind: 'spawn-error', message: this.pendingSpawnError });
        return;
      }
      if (this.exitInfo !== null) {
        finish({
          kind: 'early-exit',
          exitCode: this.exitInfo.code,
          signalCode: this.exitInfo.signal,
        });
      }
    });
  }

  private async waitForHealth(
    port: number,
    bootStart: number,
  ): Promise<{ kind: 'ok'; health: HealthResponse } | { kind: 'failure'; failure: ServerStartFailure }> {
    const healthStart = Date.now();
    let lastProbeSucceeded = false;

    for (let attempt = 1; attempt <= HEALTH_PROBE_ATTEMPTS; attempt += 1) {
      if (this.exitInfo !== null) {
        return {
          kind: 'failure',
          failure: this.failure(
            'early-exit',
            `就绪探针期间 server 子进程退出（exitCode=${String(this.exitInfo.code)}）。`,
            this.exitInfo.code,
            this.exitInfo.signal,
          ),
        };
      }
      if (this.stopping) {
        return {
          kind: 'failure',
          failure: this.failure('shutdown-requested', '就绪探针期间收到关停请求。', null, null),
        };
      }
      if (Date.now() - bootStart > TOTAL_STARTUP_BUDGET_MS) {
        return {
          kind: 'failure',
          failure: this.failure(
            'total-budget-exceeded',
            `启动总预算 ${TOTAL_STARTUP_BUDGET_MS} ms 已耗尽（第 ${attempt} 次健康探针前）。`,
            null,
            null,
          ),
        };
      }

      const health = await probeHealth(port, HEALTH_PROBE_REQUEST_TIMEOUT_MS);
      if (health !== null) {
        lastProbeSucceeded = true;
        // D5.4 逐字：ok+connected ⇒ 就绪；degraded ⇒ 仍然就绪（调用方落 WARN）。
        if (health.status === 'ok' && health.database === 'connected') {
          return { kind: 'ok', health };
        }
        if (health.status === 'degraded') {
          return { kind: 'ok', health };
        }
      }

      if (Date.now() - healthStart >= HEALTH_PHASE_BUDGET_MS) {
        break;
      }
      await delay(HEALTH_PROBE_INTERVAL_MS);
    }

    return {
      kind: 'failure',
      failure: this.failure(
        'health-timeout',
        `就绪探针超时（${HEALTH_PROBE_ATTEMPTS} 次 × ${HEALTH_PROBE_INTERVAL_MS} ms）。` +
          `${lastProbeSucceeded ? '/api/health 有响应但未达就绪判据。' : '/api/health 始终无有效响应。'}`,
        null,
        null,
      ),
    };
  }

  // ----------------------------------------------------------
  // 内部：D12.4 重启策略
  // ----------------------------------------------------------

  private async runRestartPolicy(exitCode: number | null, signalCode: string | null): Promise<void> {
    if (this.restarting) {
      // 重启进行中又收到一次退出：不能直接丢掉，否则这个孩子死了也没人管，
      // 界面上就是「窗口还在、后端没了」。出闩后补跑一次。
      this.pendingRestart = { code: exitCode, signalCode };
      return;
    }
    this.restarting = true;
    try {
      for (let attempt = 0; attempt < RESTART_MAX_IN_WINDOW; attempt += 1) {
        const now = Date.now();
        this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);

        if (this.restartTimes.length >= RESTART_MAX_IN_WINDOW) {
          break;
        }
        this.restartTimes.push(now);
        const ordinal = this.restartTimes.length;

        this.log(
          'warn',
          `server 子进程意外退出（exitCode=${String(exitCode)}，signal=${String(signalCode)}）` +
            `⇒ 按 D12.4 第 ${ordinal} 次重启（${RESTART_WINDOW_MS / 1000} s 窗口内上限 ` +
            `${RESTART_MAX_IN_WINDOW} 次）。`,
        );

        const failure = await this.start();
        if (failure === null) {
          this.log('info', `重启成功：${this.readyInfo?.origin ?? '(未知 origin)'}`);
          if (this.readyInfo !== null) {
            this.options.onRestarted?.(this.readyInfo);
          }
          return;
        }

        this.log('error', `第 ${ordinal} 次重启失败（stage=${failure.stage}）：${failure.reason}`);
        await delay(500);
      }

      const restartsInWindow = this.restartTimes.length;
      this.log(
        'error',
        `重启额度已耗尽（${RESTART_WINDOW_MS / 1000} s 窗口内 ${restartsInWindow} 次）⇒ 交主进程弹错误对话框并退出。`,
      );
      this.options.onRestartExhausted?.({
        exitCode,
        signalCode,
        stderrTail: this.options.logger.stderrTail(2000),
        restartsInWindow,
      });
    } finally {
      this.restarting = false;
      const pending = this.pendingRestart;
      this.pendingRestart = null;
      if (pending !== null && !this.stopping) {
        void this.runRestartPolicy(pending.code, pending.signalCode);
      }
    }
  }

  // ----------------------------------------------------------
  // 内部：退出等待
  // ----------------------------------------------------------

  private notifyExitWaiters(): void {
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    // 显式标注类型：this.exitInfo 在 stop() 里被窄化过，此处不能依赖它的静态类型。
    const info: ExitInfo | null = this.exitInfo;
    for (const resolve of waiters) {
      resolve(info);
    }
  }

  /**
   * 等待子进程退出，并把退出信息作为**返回值**交给调用方。
   *
   * 为什么不读 `this.exitInfo`：`stop()` 里的早退守卫 `if (this.exitInfo !== null) return;`
   * 会把该字段窄化成 `null`，而 TS 的窄化在 `await` 之后**不会重置** —— 可 `await` 期间
   * `attachLifecycle` 的 exit 回调确实会写 `this.exitInfo`。这是真实时序竞争
   * （captain 用最小复现证实 TS2339），因此退出信息必须经 Promise 传出，
   * 而不是 await 之后再摸字段。
   */
  private waitForExit(): Promise<ExitInfo | null> {
    const current: ExitInfo | null = this.exitInfo;
    if (current !== null) {
      return Promise.resolve(current);
    }
    return new Promise<ExitInfo | null>((resolve) => {
      this.exitWaiters.push(resolve);
    });
  }

  // ----------------------------------------------------------
  // 内部：失败构造
  // ----------------------------------------------------------

  private failure(
    stage: ServerStartFailure['stage'],
    reason: string,
    exitCode: number | null,
    signalCode: string | null,
  ): ServerStartFailure {
    const failure: ServerStartFailure = {
      stage,
      reason,
      stderrTail: this.options.logger.stderrTail(2000),
      exitCode,
      signalCode,
    };
    this.log('error', `server 启动失败（stage=${stage}）：${reason}`);
    return failure;
  }
}