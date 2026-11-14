// ============================================================
// apps/desktop/src/logger.ts
// 主进程日志 + 子进程 stdout/stderr 落盘（ADR-0008 D2 第 7 项、D7.1）。
//
// 冻结落点（D7.1 逐字）：
//   <userData>/logs/main.log
//   <userData>/logs/server.out.log
//   <userData>/logs/server.err.log
//   <userData>/logs/initial-admin-password.txt   （0o600，见 D6.2）
//
// 附加能力（派工书能力 6 要求）：
//   「同时保留内存环形缓冲供错误上报用」—— 崩溃对话框要展示
//   stderr 末尾 2000 字符（D5.3）与最近日志尾部（D12.4），
//   因此除了落盘，还必须在内存里保留定长环形缓冲。
//
// 设计取舍：
//   - 用 `fs.createWriteStream(path, { flags: 'a' })` 追加写，避免
//     每次日志都 open/close；进程退出时 flush。
//   - 环形缓冲按**行**保存（不是字节），保证对话框里不会截断半行。
//   - `stderrTail(n)` 返回**字符**数而非字节数：D5.3 冻结的措辞是
//     「stderr 末 2000 字符」，中文按字符计。
//   - stdout/stderr 断管（EPIPE）后全局静默 console：管道没了就该闭嘴，
//     不能因为「观察日志」把壳自己拖崩；落盘与环形缓冲不受影响。
//   - 单文件超过 64MB 滚动为 `<file>.1`（只留一份旧档），避免长期运行
//     把 server.out.log 涨成几个 GB。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';

import type { LogLevel, Logger, ServerStream } from './types.js';

/** 环形缓冲保留的最大行数（每行按 UTF-16 字符计长度上限另行裁剪）。 */
const RING_CAPACITY = 500;

/** 单行在环形缓冲中的最大保留字符数（防止一条超长日志挤爆内存）。 */
const RING_MAX_LINE_CHARS = 8000;

/** stderr 末尾快照的默认字符数（D5.3 冻结值 2000）。 */
export const STDERR_TAIL_CHARS = 2000;

/** 单文件滚动阈值：64MB，超过后归档为 `<file>.1`，只保留一份旧档。 */
const MAX_LOG_BYTES = 64 * 1024 * 1024;

/** 滚动期间最多缓存多少行，避免断管/慢盘时内存无上限增长。 */
const MAX_PENDING_LINES = 200;

/**
 * stdout/stderr 是否已断管。
 *
 * 桌面壳常由终端（`npm run dev` / `electron .`）拉起，终端一关管道就断；
 * 之后每次 `console.*` 都会再抛一次 EPIPE，最终把主进程的
 * `uncaughtException` 处理器拖出来弹崩溃框。断管后全局静默 console，
 * **文件落盘与内存环形缓冲不受影响**。
 */
let consoleBroken = false;

/** 断管监听只装一次：ShellLogger 会建 3 个 FileLogger，不能装 3 份。 */
let pipeGuardsInstalled = false;

function installPipeGuards(): void {
  if (pipeGuardsInstalled) return;
  pipeGuardsInstalled = true;
  const onPipeError = (): void => {
    consoleBroken = true;
  };
  // 挂上 error 监听后，后续 EPIPE 不再升级为 uncaughtException。
  process.stdout.on('error', onPipeError);
  process.stderr.on('error', onPipeError);
}

interface RingBuffer {
  lines: string[];
  /** 已被覆盖的累计行数，仅用于诊断。 */
  dropped: number;
}

function createRing(): RingBuffer {
  return { lines: [], dropped: 0 };
}

function ringPush(ring: RingBuffer, line: string): void {
  const trimmed =
    line.length > RING_MAX_LINE_CHARS
      ? `${line.slice(0, RING_MAX_LINE_CHARS)}…[truncated]`
      : line;
  ring.lines.push(trimmed);
  if (ring.lines.length > RING_CAPACITY) {
    const overflow = ring.lines.length - RING_CAPACITY;
    ring.lines.splice(0, overflow);
    ring.dropped += overflow;
  }
}

/** 取环形缓冲末尾 `count` 行，拼成多行字符串。 */
function ringTail(ring: RingBuffer, count: number): string {
  return ring.lines.slice(-count).join('\n');
}

/** 取环形缓冲末尾 `chars` **字符**（不足则全给）。 */
function ringTailChars(ring: RingBuffer, chars: number): string {
  const joined = ring.lines.join('\n');
  return joined.length <= chars ? joined : joined.slice(joined.length - chars);
}

/**
 * 单文件日志器：一个追加写流 + 一个内存环形缓冲。
 */
class FileLogger {
  private stream: fs.WriteStream | null;
  private readonly ring: RingBuffer = createRing();
  private readonly filePath: string;
  private writeFailed = false;

  /** 当前落盘字节数，用于 64MB 滚动；滚动后清零。 */
  private written = 0;
  /** 正在滚动：期间的日志先入 pending，重开后再补写。 */
  private rotating = false;
  private pending: string[] = [];
  private echoToConsole: boolean;

  constructor(filePath: string, echoToConsole: boolean) {
    this.filePath = filePath;
    this.echoToConsole = echoToConsole;
    let stream: fs.WriteStream | null = null;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // 既有文件可能是上次运行留下的：接上它的体积，重启后也能按 64MB 滚动。
      try {
        this.written = fs.statSync(filePath).size;
      } catch {
        this.written = 0;
      }
      stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
      // 流错误（磁盘满 / 权限）不能让主进程崩：置标志位，后续只写内存。
      stream.on('error', () => {
        this.writeFailed = true;
      });
    } catch {
      this.writeFailed = true;
    }
    this.stream = stream;
    installPipeGuards();
  }

  /** 写一行（自动补 ISO8601 前缀与级别）。 */
  write(level: LogLevel, message: string): void {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
    ringPush(this.ring, line);
    const sink =
      level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    this.echo(sink, line);
    this.persist(line);
  }

  /**
   * 写一行**原始**子进程输出（不加时间戳前缀）。
   *
   * 为什么保留原样：D6.2 的管理员密码正则与 D5.1 的端口正则都要求
   * `^\[Server\] …` 行首锚定；若在落盘前插入时间戳前缀，日志文件将
   * 无法用同一正则复核（t5/t6 要拿 `server.err.log` 验证 D13.3 的
   * `[Server] 收到 stdin，正在优雅关闭...`）。因此子进程输出**逐字**落盘。
   */
  writeRaw(line: string): void {
    ringPush(this.ring, line);
    this.echo(console.log, line);
    this.persist(line);
  }

  /**
   * console 回声：断管或同步 EPIPE 后**永久**关掉本实例的 echo。
   *
   * 断管后 echo 本身就是再次抛错的原因之一，因此这里只做止损，
   * 不重试、不告警 —— 文件落盘仍照常进行。
   */
  private echo(sink: (line: string) => void, line: string): void {
    if (!this.echoToConsole || consoleBroken) return;
    try {
      sink(line);
    } catch {
      this.echoToConsole = false;
    }
  }

  /** 落盘一行并维护字节计数；超过阈值触发滚动。 */
  private persist(line: string): void {
    if (this.stream === null || this.writeFailed) return;
    if (this.rotating) {
      if (this.pending.length < MAX_PENDING_LINES) this.pending.push(line);
      return;
    }
    this.writeLine(line);
    if (this.written > MAX_LOG_BYTES) this.rotate();
  }

  private writeLine(line: string): void {
    if (this.stream === null || this.writeFailed) return;
    try {
      this.stream.write(`${line}\n`);
      this.written += Buffer.byteLength(line, 'utf8') + 1;
    } catch {
      this.writeFailed = true;
    }
  }

  /**
   * 滚动：`main.log` → `main.log.1`（覆盖旧档），随后重开新文件。
   *
   * 必须等旧流 `close`（文件句柄释放）再 rename —— Windows 下句柄未释放
   * 时 rename 会 EBUSY/EPERM。滚动是异步的，期间的日志先进 pending，
   * 重开后补写，保证不丢行。
   */
  private rotate(): void {
    const old = this.stream;
    if (old === null || this.rotating || this.writeFailed) return;
    this.rotating = true;
    let done = false;
    const reopen = (): void => {
      if (done) return;
      done = true;
      try {
        fs.renameSync(this.filePath, `${this.filePath}.1`);
      } catch {
        // 改名失败（被占用/无权限）：继续追加写，只重置计数避免反复触发
      }
      try {
        const stream = fs.createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' });
        stream.on('error', () => {
          this.writeFailed = true;
        });
        this.stream = stream;
        this.written = 0;
        const backlog = this.pending;
        this.pending = [];
        for (const line of backlog) this.writeLine(line);
      } catch {
        this.writeFailed = true;
        this.stream = null;
      }
      this.rotating = false;
    };
    // 已关闭/已销毁的流不会再抛 close，直接重开，避免卡死在 rotating。
    if (old.closed || old.destroyed) {
      reopen();
      return;
    }
    old.once('close', reopen);
    try {
      old.end();
    } catch {
      reopen();
    }
  }

  /** 内存环形缓冲的末尾 `count` 行。 */
  tail(count: number): string {
    return ringTail(this.ring, count);
  }

  /** 内存环形缓冲的末尾 `chars` 字符（D5.3 的 2000 字符语义）。 */
  tailChars(chars: number): string {
    return ringTailChars(this.ring, chars);
  }

  /** 落盘文件绝对路径。 */
  get path(): string {
    return this.filePath;
  }

  /** flush 并关闭写流（优雅退出时调用）。 */
  close(): void {
    if (this.stream !== null && !this.writeFailed) {
      try {
        this.stream.end();
      } catch {
        /* 关闭失败不影响退出 */
      }
    }
  }
}

/**
 * shell 日志门面：主日志 + 子进程两条流。
 *
 * `stderrTail()` 是崩溃/启动失败对话框的内容来源，**跨主日志与
 * server.err.log 合并**取末尾字符，因为启动早期的失败原因可能只出现在
 * 其中一侧（例如 spawn 失败只写主日志，tsx 报错只写 stderr）。
 */
export class ShellLogger {
  private readonly main: FileLogger;
  private readonly serverOut: FileLogger;
  private readonly serverErr: FileLogger;

  constructor(layout: { logsDir: string; mainLogPath: string; serverOutLogPath: string; serverErrLogPath: string }) {
    this.main = new FileLogger(layout.mainLogPath, true);
    // 子进程输出同时 echo 到主进程 stdout/stderr 便于真机冒烟观察。
    this.serverOut = new FileLogger(layout.serverOutLogPath, true);
    this.serverErr = new FileLogger(layout.serverErrLogPath, true);
  }

  /** 主进程日志函数（可直接注入各模块）。 */
  readonly log: Logger = (level, message) => {
    this.main.write(level, message);
  };

  /** 便捷方法。 */
  debug(message: string): void {
    this.main.write('debug', message);
  }
  info(message: string): void {
    this.main.write('info', message);
  }
  warn(message: string): void {
    this.main.write('warn', message);
  }
  error(message: string): void {
    this.main.write('error', message);
  }

  /** 子进程一行输出：`stream` 决定落哪条日志。 */
  serverLine(stream: ServerStream, line: string): void {
    if (stream === 'err') {
      this.serverErr.writeRaw(line);
    } else {
      this.serverOut.writeRaw(line);
    }
  }

  /**
   * stderr 末尾 `chars` 字符（默认 D5.3 冻结的 2000）。
   *
   * 合并顺序：先主日志、后 server stderr —— 保证真正「最后发生的事」
   * 出现在末尾。启动失败时主日志里往往有 `[shell] …` 的装配说明，
   * 而真正的报错在 server stderr 尾部。
   */
  stderrTail(chars: number = STDERR_TAIL_CHARS): string {
    const merged = `${this.main.tailChars(chars)}\n${this.serverErr.tailChars(chars)}`;
    return merged.length <= chars ? merged : merged.slice(merged.length - chars);
  }

  /** 主日志末尾 `count` 行（D12.4「最近日志尾部」）。 */
  mainTail(count: number): string {
    return this.main.tail(count);
  }

  /** server stderr 末尾 `count` 行。 */
  serverErrTail(count: number): string {
    return this.serverErr.tail(count);
  }

  /** 是否已在 stderr 中见过某标记（供 D6.2 去重与 D13.3 复核）。 */
  get errFilePath(): string {
    return this.serverErr.path;
  }

  get mainFilePath(): string {
    return this.main.path;
  }

  /** flush 全部写流（优雅退出时调用）。 */
  close(): void {
    this.main.close();
    this.serverOut.close();
    this.serverErr.close();
  }
}