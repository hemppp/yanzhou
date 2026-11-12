// ============================================================
// 插件挂载冒烟测试 —— 真实 HTTP 可达性断言
//
// 背景（2026-08-30 ctx.effect 事故的教训）：当时所有 /api/plugins/* 动态
// 插件路由启动即被熔断 404，但 type-check / lint / vitest / 启动日志 /
// 健康检查五道关卡全部通过 —— 只有真实发 HTTP 请求才暴露。
// 本文件就是那道缺失的关卡：以 PORT=0 起真 HTTP 服务，对每类插件
// （内置模块 / 管理器 / 本地插件）各挑一条真实路由断言「挂载 ≠ 404」，
// 并用 404 阴性对照证明断言本身有区分度。
//
// 装配方式与 index.ts 完全一致（仅省去代理初始化、本地用户引导、定时器）。
// ============================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initDatabase, closeDatabase } from '@novel/db';
import { createSqliteKvService } from '../plugin/kv-service.js';
import { createServerPluginHost, type ServerPluginHost } from '../plugin/host.js';
import { BUILTIN_PLUGINS } from '../plugin/builtin.js';
import { createPluginManagerEntry } from '../plugin/manager.js';
import { scanLocalPluginsDetailed } from '../plugin/local-scanner.js';

let tmpDir: string;
let host: ServerPluginHost;
let base: string;

async function get(path: string, init?: RequestInit): Promise<Response> {
  return fetch(base + path, { ...init, signal: AbortSignal.timeout(15_000) });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'novel-plugin-smoke-'));
  process.env.DB_PATH = join(tmpDir, 'smoke.db');

  // 装配顺序镜像 index.ts：DB → KV → 宿主 → 本地扫描 → mount → start
  await initDatabase(process.env.DB_PATH);
  const kv = createSqliteKvService();
  host = createServerPluginHost({ kv });
  host.setInitialDisabled(kv.get<string[]>('novel.host', 'disabled-plugins') ?? []);

  const scan = scanLocalPluginsDetailed();
  host.recordInstallRejections(
    scan.rejected.map((r) => ({ id: r.id, message: `${r.code}: ${r.message}` })),
  );
  await host.mount([
    ...BUILTIN_PLUGINS,
    createPluginManagerEntry(() => host),
    ...scan.entries,
  ]);

  const started = await host.start({ port: 0, host: '127.0.0.1' });
  base = 'http://127.0.0.1:' + started.port;
}, 180_000);

afterAll(async () => {
  try {
    await host?.dispose();
  } catch { /* 已释放 */ }
  try {
    await closeDatabase();
  } catch { /* 未初始化 */ }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('插件挂载冒烟（真实 HTTP）', () => {
  it('健康检查：公开可达、数据库连接、全部插件挂载成功', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      database: string;
      plugins: Array<{ id: string; status: string; error?: string }>;
    };

    expect(body.database).toBe('connected');

    // 21 个内置 + plugin-manager + 2 个本地插件（bookscan/typography）
    // ★ t10（AI 写作模块剥离）说明：`≥23` 在剥离态下**仍成立，故不改阈值**。
    //   剥离后实测 27 / 该隔离宿主实测 25（两者都 ≥23）。
    //   ★ 关键：「auto 模块已剥离」**不能**用本断言或 health status 证明 —— 骨架包
    //     （plugin.json + server/index.ts）仍在场，novel.autowrite / novel.auto.workbench
    //     仍会出现在 /api/health 且 status=ok（调研 B §5.1 的假阳性）。**「模块已剥离」
    //     的唯一判据是 hasModule('auto')===false**（Web 面 web/index.tsx 不在场），见
    //     scripts/verify/verify-workbench-isolation.mjs 与 scripts/e2e/e2e-core-flows.mjs
    //     的 WorkbenchMissing 断言。本条只守护「插件集合未整体崩掉」
    //     （下界 + 无 failed + 必备 id 在场）。
    expect(body.plugins.length).toBeGreaterThanOrEqual(23);
    const failed = body.plugins.filter((p) => p.status !== 'ok');
    expect(failed, '存在挂载失败/被禁用的插件: ' + JSON.stringify(failed)).toEqual([]);

    const ids = new Set(body.plugins.map((p) => p.id));
    for (const required of ['novel.worldbuilding', 'novel.bookscan', 'novel.typography', 'novel.plugin-manager']) {
      expect(ids, '缺少插件 ' + required).toContain(required);
    }
  });

  it('阴性对照：未知 /api 路由返回 404（证明可达性断言有区分度）', async () => {
    const res = await get('/api/__smoke_no_such_route__');
    expect(res.status).toBe(404);
  });

  // 本地版没有登录流程：所有接口按本地用户身份直接可达。
  it('内置业务模块：/api/projects 可达（非 404）', async () => {
    const res = await get('/api/projects');
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(404);
  });

  it('插件管理器：/api/plugin-manager 可达（非 404）', async () => {
    const res = await get('/api/plugin-manager');
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(404);
  });

  it('本地插件 bookscan：路由可达（/api/plugins/bookscan/sources 非 404）', async () => {
    const res = await get('/api/plugins/bookscan/sources');
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(404);
  });

  it('本地插件 typography：路由可达（/api/plugins/typography/settings 非 404）', async () => {
    const res = await get('/api/plugins/typography/settings');
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(404);
  });

  it('完整插件 worldbuilding：路由可达（/api/plugins/worldbuilding 非 404）', async () => {
    const res = await get('/api/plugins/worldbuilding');
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(404);
  });

});
