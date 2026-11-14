// ============================================================
// 主入口 —— Cordis 基座（@deepseek-ai/cordis + dsh-host-webserver）
// 所有业务模块 = cordis 插件，由宿主 mount() 装配，start() 启动 HTTP。
// ============================================================

// ★ 必须置于首位：顶层副作用加载仓库根 .env，确保下面所有
//   `process.env.X`（PORT / HOST_MODE …）都能读到 .env。
//   ESM 按 import 顺序求值 ⇒ 本行先于任何其它模块的顶层代码执行。
//   不再依赖 `tsx --env-file=`（此前遗漏即静默丢配置）。
import './env.js';

import { existsSync } from 'fs';
import { join } from 'path';
import { createServerPluginHost, normalizeHostMode } from './plugin/host.js';
import { BUILTIN_PLUGINS } from './plugin/builtin.js';
import { createPluginManagerEntry } from './plugin/manager.js';
import { scanLocalPluginsDetailed } from './plugin/local-scanner.js';
import { setPluginHostForTools } from './ai/tools/plugin-tools.js';
import { createSqliteKvService } from './plugin/kv-service.js';
import { initDatabase, closeDatabase, closeAllProjectDbs, getDb, schema, getMainSqlite, migrateToProjectDbs } from '@novel/db';
// 代理初始化必须在所有可能发起 fetch 的模块加载前执行
import { initProxy } from './lib/proxy-agent.js';
import { ensureLocalUser } from './services/local-user-service.js';

// ------------------------------------------------------------
// stdout/stderr 断管守卫（与 apps/desktop/src/logger.ts 同款）
//
// 桌面壳用管道接本进程的 stdout/stderr；壳一退出（崩溃 / 用户强杀终端），
// 管道就断，之后每次 console.* 都抛 EPIPE。**没有 error 监听时 EPIPE 会升级成
// uncaughtException**，而下面的 handleFatal 又要 console.error ⇒ 自激循环：
// 实测（2026-11-13）1.2 s 内跑进 3544 次异常处理，CPU 空转、每次还 dispose 一遍
// 插件宿主。挂上 error 监听后 EPIPE 只被吞掉，不再升级。
// ------------------------------------------------------------
let stdioBroken = false;
const onStdioError = (): void => {
  stdioBroken = true;
};
process.stdout.on('error', onStdioError);
process.stderr.on('error', onStdioError);

// 端口：支持 PORT 环境变量覆盖（Docker/容器化场景必需），默认 3774
// PORT=0 时让操作系统自动分配可用端口（Electron 桌面端场景）
const port = process.env.PORT !== undefined ? Number(process.env.PORT) : 3774;

// 插件宿主（Cordis 基座）：mount 在下方启动流程中执行
// HOST_MODE：'manual' | 'auto' | 'all'（未设/非法 → all）。设为 manual/auto 时仅挂该模式
// + shared 的插件（见 host.ts mount()）。桌面端/部署可按机器角色固定宿主模式。
const hostMode = normalizeHostMode(process.env.HOST_MODE);
const kv = createSqliteKvService();
const serverPluginHost = createServerPluginHost({ kv, hostMode });
console.warn(`[Server] HOST_MODE=${hostMode}${process.env.HOST_MODE && hostMode === 'all' ? `（环境值 "${process.env.HOST_MODE}" 非法，回退 all）` : ''}`);

(async () => {
  // 尽早初始化代理，让后续所有 fetch 自动走代理（解决中国大陆直连 OpenAI 的 ETIMEDOUT）
  try {
    await initProxy();
  } catch (e) {
    console.warn('[Server] 代理初始化失败（继续启动）:', e);
  }

  try {
    // 初始化数据库（schema 自动迁移 / 建表）
    await initDatabase(process.env.DB_PATH);

    // 本地版：引导唯一的本地用户（无登录/管理员，仅用于数据归属）
    await ensureLocalUser();

    // 主库 → 项目库 数据迁移（首次启动时拆分已有数据到每项目独立库）
    try {
      const db = getDb();
      const mainSqlite = getMainSqlite();
      if (db && mainSqlite) {
        const projects = db.select({ id: schema.projects.id }).from(schema.projects).all() as Array<{ id: string }>;
        const projectIds = projects.map((p) => p.id);
        await migrateToProjectDbs(mainSqlite, projectIds);
      }
    } catch (migErr) {
      console.error('[Server] 主库→项目库迁移失败（非致命，继续启动）：', migErr);
    }
  } catch (e) {
    console.error('[Server] 数据库初始化失败，将以降级模式运行', e);
  }

  // ---- 装配 Cordis 插件树 ----
  // 持久化禁用清单（插件管理界面开关会写入）
  const disabled = kv.get<string[]>('novel.host', 'disabled-plugins') ?? [];
  serverPluginHost.setInitialDisabled(disabled);

  // AI 造插件工具需要访问宿主
  setPluginHostForTools(serverPluginHost);

  // 本地插件（AI 创建 / 手动放置）自动扫描 —— 安装门逐个校验（novel-plugin-standard/1.0），
  // 单个坏插件只被拒绝并上报，不影响其他插件与宿主启动
  let scanResult: ReturnType<typeof scanLocalPluginsDetailed> = { entries: [], rejected: [] };
  try {
    scanResult = scanLocalPluginsDetailed();
  } catch (err) {
    console.error('[Server] 本地插件扫描失败（跳过本地插件，不影响启动）:', err);
  }
  // 被安装门拒绝的插件登记进宿主状态：/api/health 与插件管理界面可见（而非静默消失）
  serverPluginHost.recordInstallRejections(
    scanResult.rejected.map((r) => ({ id: r.id, message: `${r.code}: ${r.message}` })),
  );
  await serverPluginHost.mount([
    ...BUILTIN_PLUGINS,
    createPluginManagerEntry(() => serverPluginHost),
    ...scanResult.entries,
  ]);

  // 端口冲突检测：tsx watch 重启时旧进程可能还没释放端口
  const waitForPort = async (portNum: number, maxWaitMs = 10000): Promise<void> => {
    const net = await import('net');
    const start = Date.now();
    for (;;) {
      const available = await new Promise<boolean>((resolve) => {
        const tester = net.createServer();
        tester.once('error', () => resolve(false));
        tester.once('listening', () => {
          tester.close();
          resolve(true);
        });
        tester.listen(portNum);
      });
      if (available) return;
      if (Date.now() - start > maxWaitMs) {
        throw new Error('端口 ' + portNum + ' 被占用超过 ' + maxWaitMs + 'ms');
      }
      console.warn('[Server] 端口 ' + portNum + ' 被占用，等待旧进程释放...');
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  let started = false;
  try {
    await waitForPort(port);
    // 生产环境：静态文件服务（dist 存在时注册 fallback）
    const distPath = process.env.WEB_DIST_PATH || join(process.cwd(), 'apps/web/dist');
    const distIndex = process.env.NODE_ENV === 'production' && existsSync(distPath)
      ? join(distPath, 'index.html')
      : undefined;
    // 绑定地址：默认仅本机；Linux 服务器部署需对外访问时设 HOST=0.0.0.0
    const bindHost = process.env.HOST === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
    await serverPluginHost.start({ port, host: bindHost, distIndex });
    started = true;
  } catch (e) {
    console.error('[Server] 启动失败（端口冲突或基座初始化失败）:', e);
    // 端口占用诊断只提示端口号，不执行外部命令（历史版本的 netstat|findstr 管道
    // 为 Windows 专属且输出未被使用，已在安全复查中移除）
    if (port !== 0) {
      console.error('[Server] 端口 ' + port + ' 可能被占用，请检查占用该端口的进程。');
    }
  }

  if (!started && port === 0) {
    // PORT=0 时不可能冲突，失败说明基座本身起不来
    process.exit(1);
  }

  // 启动章节回收站清理定时器：每小时硬删除已软删除超过 30 天的章节。
  const { cleanupExpiredChapters } = await import('./services/chapter-service.js');
  const cleanupTimer = setInterval(async () => {
    try {
      const removed = await cleanupExpiredChapters();
      if (removed > 0) {
        console.warn('[Server] 自动清理过期软删除章节: ' + removed + ' 条');
      }
    } catch (e) {
      console.error('[Server] 清理过期章节失败:', e);
    }
  }, 60 * 60 * 1000);
  cleanupTimer.unref();

  // ---- 优雅关闭 ----
  const closeGracefully = async (signal: string) => {
    console.warn('[Server] 收到 ' + signal + '，正在优雅关闭...');
    try {
      await serverPluginHost.dispose();
    } catch (e) {
      console.error('[Server] 释放 Cordis 基座失败:', e);
    }
    try {
      await Promise.race([
        closeAllProjectDbs(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('closeAllProjectDbs 超时')), 3000)),
      ]);
    } catch (e) {
      console.error('[Server] 关闭项目库失败:', e);
    }
    try {
      await Promise.race([
        closeDatabase(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('closeDatabase 超时')), 3000)),
      ]);
    } catch (e) {
      console.error('[Server] 关闭主库失败:', e);
    }
    process.exit(0);
  };

  /**
   * 异常处理中的日志：管道已断时直接丢弃。
   *
   * 桌面壳退出后 stdout/stderr 是死管道，再往里写字面意义上没有任何人能读到，
   * 只会白白占用每次异常的处理时间（这正是上面那条自激循环的燃料）。
   */
  const fatalLog = (message: string, detail: unknown): void => {
    if (stdioBroken) return;
    console.error(message, detail);
  };

  // 重入闸门：一次异常若在处理期间又抛异常，不能层层递归（每次都会 dispose 宿主）。
  let handlingFatal = false;

  const handleFatal = async (err: unknown, type: string) => {
    fatalLog('[Server] 致命错误 (' + type + '):', err);
    if (handlingFatal) return;
    handlingFatal = true;
    // 尽力释放资源，但**不退出进程**：dev 模式下 tsx watch 依赖进程存活；
    // 单独一次异步异常不应拖垮整个服务（原实现 process.exit(1) 会让端口静默消失）。
    try {
      await serverPluginHost.dispose();
    } catch {
      // 忽略释放错误
    } finally {
      handlingFatal = false;
    }
  };

  process.on('SIGINT', () => void closeGracefully('SIGINT'));
  process.on('SIGTERM', () => void closeGracefully('SIGTERM'));
  process.on('uncaughtException', (err) => void handleFatal(err, 'uncaughtException'));
  process.on('unhandledRejection', (reason) => { fatalLog('[Server] 未处理的 Promise 拒绝（已忽略，不影响服务）:', reason); });

  // ---- stdin 控制通道（桌面端优雅关闭，ADR-0008 D13.3）----
  // 背景：Windows 上 Node 的 child.kill('SIGTERM'/'SIGINT') 走 TerminateProcess，
  //   子进程的信号处理器根本不会执行 ⇒ 上面两条 SIGINT/SIGTERM 注册在 Windows 桌面端不可用。
  // 协议：父进程（Electron 主进程）向子进程 stdin 写入一行 `novelmuse:shutdown\n`，
  //   本进程按行切分匹配后调用**既有** closeGracefully（语义与实现均不改动）。
  // 为什么必须保留：sql.js 回退引擎下数据库仅在内存，只有 closeDatabase() 才落盘
  //   ⇒ 若只能强杀，sql.js 引擎下会丢数据。
  // 边界：仅在 stdin 不是 TTY（即桌面端 spawn 的 stdio[0]='pipe'）时启用，
  //   以免改变 `pnpm dev` 等终端交互场景的既有行为；匹配字面量不命中时不做任何事。
  if (process.stdin.isTTY !== true) {
    const SHUTDOWN_TOKEN = 'novelmuse:shutdown';
    let stdinBuf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      stdinBuf += chunk;
      let nl = stdinBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stdinBuf.slice(0, nl).trim();
        stdinBuf = stdinBuf.slice(nl + 1);
        if (line === SHUTDOWN_TOKEN) {
          void closeGracefully('stdin');
          return;
        }
        nl = stdinBuf.indexOf('\n');
      }
      // 防御：单行过长时丢弃缓冲，避免无界增长
      if (stdinBuf.length > 4096) stdinBuf = '';
    });
    // stdin 提前关闭（父进程退出）不影响服务运行
    process.stdin.on('error', () => { /* 忽略 */ });
    process.stdin.resume();
  }
})();

// 兼容导出：宿主实例（测试/工具可访问）
export { serverPluginHost as default };
export { createServerPluginHost } from './plugin/host.js';
