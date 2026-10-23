// ============================================================
// novel.autowrite 挂载冒烟测试 —— 技能注册与路由的回归守护
//
// 验收锚点（docs/architecture/ai-writing-architecture.md）：
//   1. 插件经本地扫描真实挂载（health 中 status=ok）
//   2. 核心技能注册表无任何 builtin 来源（内置表为空）
//   3. 8 个聊天技能由插件 server 面注册（source=plugin）
//   4. 旧批次流水线的 8 个 autowrite_* 流程工具**已删除**（回归守护）
//   5. GET /api/ai/skills 路由存在（未鉴权 401 而非 404）
//
// ★ 2026-09-28：`auto-write` flow 型技能与 8 个流程工具、`/batches` 路由随旧批次
//   流水线一并删除。本测试相应改为断言它们**不存在**（防止被误加回来）。
// ★ t10（2026-10-01，AI 写作模块剥离）：novel.autowrite 的**实现**（8 个聊天技能 +
//   状态/流水线路由 + 多代理流水线）曾整体移出仓外，仓内仅剩最小 no-op 骨架。
//   当时把「8 技能 toContain」按 §14-β 拆成两条，并**反转**成「8 技能已不在注册表」
//   的回归守护、把 `/api/plugins/autowrite/*` 改为断言 404。
// ★ 2026-10-19（AI 写作模块**回仓**）：实现（含 `server/skills/`、`server/routes.ts`、
//   `server/pipeline/**`、`server/framework/**`）已装回仓内，`server/index.ts` 重新
//   注册 8 个聊天技能与 `/api/plugins/autowrite` 路由。故 t10 那两条**反转式**断言与
//   404 断言的前提已失效，本轮**恢复为正向断言**（技能在册 + 路由已注册 ⇒ 未鉴权 401）：
//     · 健康检查断言不变（契约被宿主接受）；
//     · 「无 builtin 来源」不变量不变（回仓前后都成立）；
//     · 8 技能：`not.toContain` → **`toContain`**，并断言 source='plugin'（抓「实现被
//       再次剥离/漏装」——这正是 t10 那条守护的反向对应物）；
//     · 流水线路由：404 → **401**（已注册 ⇒ 命中 `/api/plugins/*` 前缀鉴权）。
//   ⇒ 判据仍是「实现是否在场」，只是本仓当前处于**回仓态**；判别方式从
//     hasModule('auto')===false 改为「技能在册 + 路由已注册」。
// ============================================================

/** novel.autowrite 插件 server 面注册的 8 个聊天技能 */
const AUTOWRITE_SKILL_IDS = [
  'character-analyst', 'foreshadow-tracker', 'rhythm-doctor', 'worldbuilder',
  'dialogue-polisher', 'plot-architect', 'continue-writer', 'outline-architect',
];

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
import { listSkillMetas } from '../ai/agents/skills.js';
import { getAllToolDefinitions } from '../ai/tools/registry.js';

let tmpDir: string;
let host: ServerPluginHost;
let base: string;

async function get(path: string): Promise<Response> {
  return fetch(base + path, { signal: AbortSignal.timeout(15_000) });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'novel-autowrite-smoke-'));
  process.env.DB_PATH = join(tmpDir, 'smoke.db');

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

describe('novel.autowrite 挂载（真实宿主）', () => {
  it('健康检查：骨架插件挂载成功、无安装门拒绝', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      plugins: Array<{ id: string; status: string; error?: string }>;
      installRejections?: Array<{ id: string; message: string }>;
    };
    // ★ t10：骨架在场 ⇒ 本条**仍然有效**：它证明「契约（plugin.json）被宿主接受、
    //   server/index.ts 过 G1 结构门」。注意它**不能**用来证明「实现已剥离」。
    const aw = body.plugins.find((p) => p.id === 'novel.autowrite');
    expect(aw, 'novel.autowrite 骨架应出现在健康检查插件列表').toBeTruthy();
    expect(aw?.status).toBe('ok');
    for (const r of body.installRejections ?? []) {
      expect(r.id, '不应有插件被安装门拒绝').not.toBe('novel.autowrite');
    }
  });

  // ============================================================
  // 回仓后：8 技能由插件 server 面注册 —— 正向断言（补齐 t10 的反向守护）。
  //   「无 builtin 来源」不变量与 t10 剥离期一致，一字未改。
  // ============================================================
  it('技能注册表：无任何 builtin 来源（核心内置表为空）', () => {
    const metas = listSkillMetas();
    // 真正的不变量（剥离前后都成立）：注册表里不允许任何 builtin 来源。
    // 现役注册者全部来自仍/重回场内的插件（worldbuilding 的「势力顾问」+ autowrite 的 8 技能），
    // 均为 plugin 来源。
    expect(metas.every((m) => m.source === 'plugin')).toBe(true);
  });

  it('8 个 autowrite 聊天技能已注册（插件 server 面，回归守护）', () => {
    const metas = listSkillMetas();
    const ids = metas.map((m) => m.id);
    // ★ 正向守护（非恒真）：若实现被再次剥离 / 漏装 skills/，
    //   这些 id 会缺失 ⇒ 本断言立刻红。
    for (const id of AUTOWRITE_SKILL_IDS) {
      expect(ids, `技能 ${id} 应由 novel.autowrite 的 server 面注册`).toContain(id);
    }
    // 更强的守护：来源必须是 plugin（内置表被误加回来时立刻红）。
    for (const id of AUTOWRITE_SKILL_IDS) {
      expect(metas.find((m) => m.id === id)?.source, `技能 ${id} 应来自插件`).toBe('plugin');
    }
  });

  it('8 技能的展示元数据已暴露给前端（选择器可见）', () => {
    const metas = listSkillMetas();
    // 抽样断言 DTO 层面的 id 与 name —— 回仓后前端技能选择器应能列出这 8 个技能。
    expect(metas.find((m) => m.id === 'character-analyst')?.name).toBe('角色分析师');
    expect(metas.find((m) => m.id === 'foreshadow-tracker')).toBeTruthy();
    expect(metas.find((m) => m.id === 'outline-architect')).toBeTruthy();
    const names = metas.map((m) => m.name);
    for (const n of ['角色分析师', '伏笔追踪者', '大纲架构师']) {
      expect(names, `技能展示名 ${n} 应在册（前端选择器可见）`).toContain(n);
    }
  });

  it('旧批次流水线的 8 个 autowrite_* 流程工具已删除（回归守护）', () => {
    const names = getAllToolDefinitions().map((d) => d.function.name);
    for (const name of [
      'autowrite_plan_batch', 'autowrite_write_draft', 'autowrite_check_draft',
      'autowrite_polish_draft', 'autowrite_confirm_chapter', 'autowrite_resume_batch',
      'autowrite_status', 'autowrite_audit',
    ]) {
      expect(names, `工具 ${name} 不应再注册（旧批次流水线已删）`).not.toContain(name);
    }
    // flow 型技能 auto-write 也一并删除
    expect(listSkillMetas().map((m) => m.id)).not.toContain('auto-write');
  });

  it('GET /api/ai/skills 路由存在（未鉴权 401 而非 404）', async () => {
    const res = await get('/api/ai/skills');
    expect(res.status).toBe(401);
  });

  // 注（2026-10-19 回仓后恢复）：novel.autowrite 的实现路由已重新注册
  // `/api/plugins/autowrite` 前缀 ⇒ 该前缀下子路径**命中前缀鉴权**，未带凭证时是 401
  // （**不再是** 404 —— 404 是 t10 剥离期骨架不注册该前缀时的表现）。
  // 断言 401 的两层语义：
  //   · 该前缀**已注册**（未注册只会是 Hono 通用 404）；
  //   · 且不是被模式门禁挡下（此处无 X-Project-Id，不触发项目模式门禁）。
  it('流水线路由已注册（未鉴权 ⇒ 401，而非未注册的 404）', async () => {
    const res = await get('/api/plugins/autowrite/pipeline/runs');
    expect(res.status).toBe(401);
    const body = await res.json().catch(() => ({})) as { error?: { code?: string } };
    expect(body?.error?.code, '应是鉴权拦截而非项目模式门禁')
      .not.toBe('PLUGIN_MODE_MISMATCH');
  });
});
