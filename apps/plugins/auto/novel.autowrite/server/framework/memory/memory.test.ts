/**
 * @fileoverview 分层记忆 · 单测
 *
 * 覆盖 docs/architecture/multi-agent-memory-architecture.md 的 6 条不变量与防污染清单里**可自动化**的部分：
 *   · 闸门：未声明 fail-closed / 白名单 / 宽权限 / 非法 reason / 叙事式单独闸门 / 放行与拒绝都记账
 *   · L2 隔离：A 写的 B 读不到；跨智能体写被拒；双式（fact_ref 与 experience）互不覆盖
 *   · 水车：斗数固定、幂等舀入、出界一斗
 *   · 沉淀：同批次同槽位两个值 → 都不写、进冲突队列（不覆盖）
 *
 * 顺带验证新表（agent_memory / memory_audit / fact_conflicts）能被 initProjectDb 建出来。
 * 运行载体：apps/server 的 vitest。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initProjectDb, deleteProjectDb, schema, eq, and, type DrizzleDb } from '@novel/db';
import type { ServerPluginContext } from '@novel/core';
import { MemoryGate } from './gate.js';
import { createAgentMemory, assertSameAgent, factRef } from './agent-memory.js';
import { matchAny, matchPattern } from './types.js';
import { pushChapter, renderWheel, renderWheelWithin, WHEEL_CAPACITY_DEFAULT, type WheelChapter } from './waterwheel.js';
import { detectBatchConflicts, recordConflicts, type FactWrite } from './ingest.js';
import { rolePolicyLookup, ORCHESTRATOR_POLICY, policyLookupWithOrchestrator, allRolePolicies } from './index.js';
import { readDigestFor, digestFieldsFor, DIGEST_KEYS } from './digest-gate.js';
import { createOwnWheel } from './wheel-store.js';
import { fingerprintOf } from './gate.js';
import { extractStoryTime } from '../context-resolver.js';

const PROJECT_ID = `memory-test-${Date.now()}`;
let db: DrizzleDb;
let ctx: ServerPluginContext;

beforeAll(async () => {
  db = await initProjectDb(PROJECT_ID);
  // 只用到 ctx.db.project()，其余字段本用例不碰
  ctx = { db: { project: () => db, global: () => db } } as unknown as ServerPluginContext;
}, 60_000);

afterAll(async () => {
  try {
    await deleteProjectDb(PROJECT_ID);
  } catch { /* 清理失败不影响结论 */ }
});

// ---------------------------------------------------------------- 纯函数

describe('键模式匹配（fail-closed 是底线）', () => {
  it('未声明 / 空集 → 什么都匹配不上', () => {
    expect(matchAny(undefined, 'entity.characters.陈默')).toBe(false);
    expect(matchAny([], 'entity.characters.陈默')).toBe(false);
  });

  it('末尾 * 是前缀通配', () => {
    expect(matchAny(['entity.characters.*'], 'entity.characters.陈默')).toBe(true);
    expect(matchAny(['entity.characters.*'], 'entity.locations.车站')).toBe(false);
  });

  it('族名（不带通配）覆盖**它自己和子树** —— 白名单写族名是最自然的写法', () => {
    expect(matchPattern('settings.brief', 'settings.brief')).toBe(true);
    expect(matchPattern('settings.brief', 'settings.brief.*')).toBe(true);
    expect(matchPattern('settings.brief', 'settings.brief.x')).toBe(true);
    // 但不许越界到兄弟键
    expect(matchPattern('settings.brief', 'settings.genre')).toBe(false);
    expect(matchPattern('settings.brief', 'entity.characters.陈默')).toBe(false);
  });
});

describe('水车：斗数固定 + 幂等舀入 + 出界一斗', () => {
  const ch = (n: number): WheelChapter => ({ chapterNo: n, text: `第${n}章正文`, ingestedAt: n, storyTime: `第${n}日` });

  it('默认 3 斗（2026-09-13 作者拍板从 1 扩到 3）', () => {
    expect(WHEEL_CAPACITY_DEFAULT).toBe(3);
    let slots: WheelChapter[] = [];
    for (const n of [1, 2, 3]) ({ slots } = pushChapter(slots, ch(n)));
    const r = pushChapter(slots, ch(4));
    expect(r.slots.map((s) => s.chapterNo)).toEqual([4, 3, 2]);
    expect(r.evicted?.chapterNo).toBe(1);
  });

  it('容量 1（显式传参时）只带最近一章 —— 旧行为仍可用', () => {
    let slots: WheelChapter[] = [];
    ({ slots } = pushChapter(slots, ch(1), 1));
    const r = pushChapter(slots, ch(2), 1);
    expect(r.slots.map((s) => s.chapterNo)).toEqual([2]);
    expect(r.evicted?.chapterNo).toBe(1);
  });

  it('容量 3：最新的永远在斗 1，第 4 章挤掉第 1 章', () => {
    let slots: WheelChapter[] = [];
    for (const n of [1, 2, 3]) ({ slots } = pushChapter(slots, ch(n), 3));
    expect(slots.map((s) => s.chapterNo)).toEqual([3, 2, 1]);
    const r = pushChapter(slots, ch(4), 3);
    expect(r.slots.map((s) => s.chapterNo)).toEqual([4, 3, 2]);
    expect(r.evicted?.chapterNo).toBe(1);
  });

  it('同一章重复舀入是幂等的（不会重复占斗位）', () => {
    let slots: WheelChapter[] = [];
    for (const n of [1, 2]) ({ slots } = pushChapter(slots, ch(n), 3));
    ({ slots } = pushChapter(slots, ch(2), 3));
    expect(slots.map((s) => s.chapterNo)).toEqual([2, 1]);
  });

  it('渲染带章号与故事内时间（斗 1 最新）', () => {
    const txt = renderWheel([ch(5), ch(4)]);
    expect(txt).toContain('斗1｜第 5 章');
    expect(txt).toContain('故事内：第5日');
    expect(txt.indexOf('斗1')).toBeLessThan(txt.indexOf('斗2'));
  });
});

describe('注入用的篇幅预算：斗 1 必留、超了要明说省略', () => {
  const big = (n: number, len: number): WheelChapter => ({ chapterNo: n, text: 'x'.repeat(len), ingestedAt: n });

  it('斗 1 无条件收（否则"没有前情"是假信息）', () => {
    const r = renderWheelWithin([big(9, 50000)], 1000);
    expect(r.included).toBe(1);
    expect(r.text).toContain('第 9 章');
  });

  it('超出预算的老斗位被省掉，并**明确标注**', () => {
    const r = renderWheelWithin([big(5, 100), big(4, 100), big(3, 100)], 260);
    expect(r.included).toBeLessThan(3);
    expect(r.omitted).toBeGreaterThan(0);
    expect(r.text).toContain('因篇幅省略');
  });

  it('装得下就全装，且斗 1 在最前', () => {
    const r = renderWheelWithin([big(5, 10), big(4, 10), big(3, 10)], 1000);
    expect(r.included).toBe(3);
    expect(r.omitted).toBe(0);
    expect(r.text.indexOf('斗1')).toBeLessThan(r.text.indexOf('斗2'));
    expect(r.text).not.toContain('省略');
  });
});

describe('沉淀：同批次同槽位矛盾 → 都不写', () => {
  it('同槽位两个不同值 → 判为冲突，两条都不放行', () => {
    const facts: FactWrite[] = [
      { slot: 'characters/陈默/state', value: '断臂', source: 'ch2' },
      { slot: 'characters/陈默/state', value: '完好', source: 'ch2' },
      { slot: 'characters/陆离/state', value: '轻伤', source: 'ch2' },
    ];
    const r = detectBatchConflicts(facts);
    expect(r.conflicts.map((c) => c.slot)).toEqual(['characters/陈默/state']);
    expect(r.written.map((w) => w.slot)).toEqual(['characters/陆离/state']);
  });

  it('同槽位同值（重复抽取）不算冲突，写一次', () => {
    const r = detectBatchConflicts([
      { slot: 'items/断刃/holder', value: '陈默', source: 'ch2' },
      { slot: 'items/断刃/holder', value: '陈默', source: 'ch2' },
    ]);
    expect(r.conflicts).toHaveLength(0);
    expect(r.written).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- 闸门（要真实库）

describe('记忆闸门：白名单 / 宽权限 / fail-closed / 记账', () => {
  const gate = () => new MemoryGate(ctx, policyLookupWithOrchestrator);

  it('角色未声明 memory → 拒绝（fail-closed）', async () => {
    const g = new MemoryGate(ctx, rolePolicyLookup);
    const d = await g.authorize({
      projectId: PROJECT_ID, agentId: '这个角色不存在', keys: ['settings.brief'], reason: 'continuity-check',
    });
    expect(d.allow).toBe(false);
    expect(d.denied).toEqual(['settings.brief']);
  });

  it('剧情设计师：可读 settings/outline/foreshadow，但读不到地点（不在白名单）', async () => {
    const d = await gate().authorize({
      projectId: PROJECT_ID, agentId: 'plot-designer',
      keys: ['settings.brief', 'entity.locations.车站'], reason: 'assemble-before-write',
    });
    expect(d.allow).toBe(false);                       // 只要有一个键越界就整次不放行
    expect(d.granted).toEqual(['settings.brief']);
    expect(d.denied).toEqual(['entity.locations.车站']);
  });

  it('设定管家有宽权限：任意事实键都放行', async () => {
    const d = await gate().authorize({
      projectId: PROJECT_ID, agentId: 'continuity-keeper',
      keys: ['entity.locations.车站', 'entity.items.断刃', 'constraint.供电时段'], reason: 'continuity-check',
    });
    expect(d.allow).toBe(true);
    expect(d.denied).toHaveLength(0);
  });

  it('编造式 reason（JS 侧绕过类型）→ 拒绝', async () => {
    const d = await gate().authorize({
      projectId: PROJECT_ID, agentId: 'continuity-keeper',
      keys: ['settings.brief'], reason: '想看看别人怎么写的' as never,
    });
    expect(d.allow).toBe(false);
  });

  it('叙事式单独闸门：写作官可读，意图复核不可读（只对契约）', async () => {
    const asWriter = await gate().authorize({
      projectId: PROJECT_ID, agentId: 'writer', keys: ['chapter.2.summary'], reason: 'assemble-before-write', narrative: true,
    });
    expect(asWriter.allow).toBe(true);

    const asReviewer = await gate().authorize({
      projectId: PROJECT_ID, agentId: 'reviewer', keys: ['chapter.2.summary'], reason: 'gate-review', narrative: true,
    });
    expect(asReviewer.allow).toBe(false);
  });

  it('编排层走宽策略（读全量 + 记账）', async () => {
    const d = await gate().authorize({
      projectId: PROJECT_ID, agentId: 'orchestrator', keys: ['entity.items.断刃'], reason: 'recall-by-need',
    });
    expect(d.allow).toBe(true);
    expect(ORCHESTRATOR_POLICY.l1Wide).toBe(true);
  });

  it('放行与拒绝**都**留在审计里（可复盘）', async () => {
    const rows = await db.select().from(schema.memoryAudit).where(eq(schema.memoryAudit.projectId, PROJECT_ID));
    expect(rows.some((r) => r.action === 'read_l1' && r.allow)).toBe(true);
    expect(rows.some((r) => r.action === 'deny_l1' && !r.allow)).toBe(true);
  });
});

describe('L2 专属记忆：互不可读 / 跨智能体写被拒 / 双式隔离', () => {
  const handleOf = (agentId: string) => createAgentMemory({ ctx, projectId: PROJECT_ID, agentId, gate: new MemoryGate(ctx, policyLookupWithOrchestrator) });

  it('A 写的，B 读不到（隔离）', async () => {
    const a = handleOf('plot-designer');
    await a.writeOwn(factRef('note.private', { factId: 'characters:陈默', why: '剧情需要' }));
    const b = handleOf('character-designer');
    expect(await a.readOwn('note.private')).not.toBeNull();
    expect(await b.readOwn('note.private')).toBeNull();
  });

  it('跨智能体写被拒（拿着别人的条目来写 → 抛）', async () => {
    const a = handleOf('plot-designer');
    expect(() => assertSameAgent('plot-designer', 'character-designer')).toThrow(/跨智能体写被拒/);
    await expect(a.writeOwn({ ...factRef('note.x', { factId: 'x', why: 'y' }), agentId: 'character-designer' }))
      .rejects.toThrow(/跨智能体写被拒/);
  });

  it('双式隔离：同 key 的 fact_ref 与 experience 互不覆盖', async () => {
    const a = handleOf('writer');
    await a.writeOwn({ form: 'fact_ref', key: 'same.key', value: { factId: 'constraint:供电', why: '契约' } });
    await a.writeOwn({ form: 'experience', key: 'same.key', value: { kind: 'said', text: '我写完了', ref: 'turn-1' } });
    const asFact = await a.readOwn('same.key', 'fact_ref');
    const asExp = await a.readOwn('same.key', 'experience');
    expect((asFact?.value as { factId: string }).factId).toBe('constraint:供电');
    expect((asExp?.value as { text: string }).text).toBe('我写完了');
  });

  it('listOwn 只返回自己的条目', async () => {
    const c = handleOf('convener');
    await c.writeOwn({ form: 'experience', key: 'e1', value: { kind: 'heard', text: '节拍太密', from: 'plot-designer', ref: 't1' } });
    const mine = await c.listOwn('experience');
    expect(mine.map((m) => m.key)).toContain('e1');
    expect(mine.every((m) => m.form === 'experience')).toBe(true);
  });
});

describe('水车：**每个智能体各自一台**（迭代方式，不是共享记忆）', () => {
  const handleOf = (agentId: string) => createAgentMemory({ ctx, projectId: PROJECT_ID, agentId, gate: new MemoryGate(ctx, policyLookupWithOrchestrator) });
  const ch = (n: number, t = `第${n}章正文`) => ({ chapterNo: n, text: t, ingestedAt: n });

  it('★ A 的水车 B 完全看不到（隔离，不是靠约定）', async () => {
    const a = createOwnWheel(handleOf('plot-designer'), 3);
    const b = createOwnWheel(handleOf('character-designer'), 3);
    await a.ingest(ch(1));
    expect((await a.slots()).map((s) => s.chapterNo)).toEqual([1]);
    expect(await b.slots()).toEqual([]);              // ★ B 一台空的
    expect(await b.render()).toBe('（水车空）');
  });

  it('容量 3：最新的在斗 1，第 4 章挤掉第 1 章', async () => {
    const w = createOwnWheel(handleOf('writer'), 3);
    for (const n of [1, 2, 3, 4]) await w.ingest(ch(n));
    expect((await w.slots()).map((s) => s.chapterNo)).toEqual([4, 3, 2]);
  });

  it('出界**不丢**：没给压缩器就把原文挂 pending', async () => {
    const w = createOwnWheel(handleOf('reviewer'), 1);
    await w.ingest(ch(1, '第一章原文'));
    const r = await w.ingest(ch(2, '第二章原文'));
    expect(r.evicted?.chapterNo).toBe(1);
    const items = await handleOf('reviewer').listOwn('experience');
    expect(items.find((i) => i.key === 'wheel.pending.1')?.value).toBe('第一章原文');
  });

  it('给了压缩器：出界压成一句话，沉进**它自己的**长期池', async () => {
    const w = createOwnWheel(handleOf('convener'), 1);
    await w.ingest(ch(1));
    const r = await w.ingest(ch(2), { compress: async (c) => `陈默在第${c.chapterNo}章丢了水壶。` });
    expect(r.summary).toBe('陈默在第1章丢了水壶。');
    expect(await w.summaries()).toEqual([{ chapterNo: 1, text: '陈默在第1章丢了水壶。' }]);
  });

  it('同一章重复舀入是幂等的（不占两个斗位）', async () => {
    const w = createOwnWheel(handleOf('continuity-keeper'), 3);
    await w.ingest(ch(1));
    await w.ingest(ch(2));
    await w.ingest(ch(2));
    expect((await w.slots()).map((s) => s.chapterNo)).toEqual([2, 1]);
  });

  it('水车渲染带斗位序号（斗 1 最新）', async () => {
    const w = createOwnWheel(handleOf('proofreader'), 2);
    await w.ingest(ch(1));
    await w.ingest(ch(2));
    const txt = await w.render();
    expect(txt.indexOf('斗1')).toBeLessThan(txt.indexOf('斗2'));
    expect(txt).toContain('第 2 章');
  });
});

describe('A4 装配指纹（I6 的可执行形式）', () => {
  it('同样输入 → 同样指纹；长度参与指纹（改一个字就不同）', () => {
    const a = fingerprintOf('【项目现状】\n角色：陈默');
    expect(fingerprintOf('【项目现状】\n角色：陈默')).toBe(a);
    expect(fingerprintOf('【项目现状】\n角色：陈默。')).not.toBe(a);
  });
  it('指纹带字数后缀（便于一眼看出"这次注入了多长"）', () => {
    expect(fingerprintOf('abc')).toMatch(/-3$/);
    expect(fingerprintOf('')).toMatch(/-0$/);
  });
});

describe('A3 故事内时间：抽不到就不猜', () => {
  it('认得「故事内时间：第 3 日」', () => {
    expect(extractStoryTime('节拍：\n一、...\n故事内时间：第 3 日\n待定：无')).toBe('第 3 日');
  });
  it('也认「故事时间/时间线：」两种写法', () => {
    expect(extractStoryTime('时间线：末日第 2 天傍晚')).toBe('末日第 2 天傍晚');
  });
  it('契约里没写 → null（不瞎猜）', () => {
    expect(extractStoryTime('禁项：不许无代价复活\n待定：无')).toBeNull();
    expect(extractStoryTime('')).toBeNull();
  });
});

describe('冲突队列：入队后可见、不带 agent 私记', () => {
  it('recordConflicts 写进 fact_conflicts 且 status=open', async () => {
    await recordConflicts(ctx, PROJECT_ID, [{ slot: 'characters/陈默/state', existing: '断臂', incoming: '完好' }], 'ch2');
    const open = await db.select().from(schema.factConflicts).where(and(
      eq(schema.factConflicts.projectId, PROJECT_ID),
      eq(schema.factConflicts.status, 'open'),
    ));
    expect(open.length).toBeGreaterThan(0);
    expect(open[0]!.slot).toBe('characters/陈默/state');
  });
});

/** 桩加载器：给"所有字段都有值"的完整 digest，用来验证"角色拿到的是裁剪后的子集" */
const stubLoad = async () => ({
  projectName: '末世拾荒者', genre: '系统流', characters: '陈默 / 陆离', foreshadows: '断刃（未回收）',
  outline: '三幕', chapters: '第1章 三小时', brief: '主角在末日前三小时醒来',
});

describe('受控装配：角色拿到的 digest 里**不该有**的东西，就是真的没有', () => {
  it('意图复核：只对契约 —— digest 里不含 characters/outline/chapters', async () => {
    const { digest, decision } = await readDigestFor(ctx, PROJECT_ID, 'reviewer', 'gate-review', { load: stubLoad });
    expect(decision.allow).toBe(true);
    expect(Object.keys(digest)).not.toContain('characters');
    expect(Object.keys(digest)).not.toContain('outline');
    expect(Object.keys(digest)).not.toContain('chapters');
    // 契约相关的东西必须在
    expect(Object.keys(digest)).toContain('brief');
  });

  it('剧情设计师：角色/大纲/前情都要给（不注入就会编），差异只在「地点/物品」这一档', async () => {
    const d = await readDigestFor(ctx, PROJECT_ID, 'plot-designer', 'assemble-before-write', { load: stubLoad });
    const families = digestFieldsFor(rolePolicyLookup('plot-designer'));
    expect(families).toContain('brief');
    expect(families).toContain('characters');    // ★ 接线时按「不注入就会编」放宽过：以前这里断言"没有"
    expect(families).toContain('chapters');
    // digest 里本来就没有 locations/items 字段 —— 那两档只有写作官/校对门需要
    expect(d.decision.allow).toBe(true);
  });

  it('未声明角色：整次拒绝，且**不降级**成"给全部"', async () => {
    const { digest, decision } = await readDigestFor(ctx, PROJECT_ID, '查无此人', 'recall-by-need', { load: stubLoad });
    expect(decision.allow).toBe(false);
    expect(Object.keys(digest)).toHaveLength(0);
  });

  it('设定管家（宽权限）：字段最全', () => {
    const wide = digestFieldsFor(rolePolicyLookup('continuity-keeper'));
    expect(wide).toContain('characters');
    expect(wide).toContain('chapters');
    expect(wide.length).toBeGreaterThan(digestFieldsFor(rolePolicyLookup('reviewer')).length);
  });
});

describe('接线后的可见范围：每个角色拿到的确实不一样（2026-09-13 接入编排器）', () => {
  const fieldsFor = async (agentId: string) => {
    const { digest } = await readDigestFor(ctx, PROJECT_ID, agentId, 'discuss-context', { narrative: true, load: stubLoad });
    return Object.keys(digest);
  };

  it('剧情设计师：**必须**拿到角色与前情（不注入就会编 —— 这是既有教训）', async () => {
    const f = await fieldsFor('plot-designer');
    expect(f).toContain('characters');
    expect(f).toContain('chapters');
    expect(f).toContain('brief');
  });

  it('角色设计师：有角色卡与伏笔；但没有地点/物品这一档', async () => {
    const f = await fieldsFor('character-designer');
    expect(f).toContain('characters');
    expect(f).toContain('foreshadows');
    expect(f).not.toContain('outline');       // 白名单里没有 outline.*
  });

  it('意图复核：**唯一刻意窄的一处** —— 没有角色/大纲/章节', async () => {
    const f = await fieldsFor('reviewer');
    expect(f).toContain('brief');
    expect(f).not.toContain('characters');
    expect(f).not.toContain('outline');
    expect(f).not.toContain('chapters');
  });

  it('校对门（proofreader）：字段最全，含地点/物品', async () => {
    const f = await fieldsFor('proofreader');
    expect(f).toContain('characters');
    expect(f).toContain('chapters');
    expect(f).toContain('outline');
  });

  it('★ projectName 必须在**所有**角色/门禁的可见集里（渲染模板里要用它，缺了会显示「未命名」）', async () => {
    // 实测踩过：白名单只写 brief 不写 projectName → 每个角色的 header 都渲染成「项目：未命名」
    const ids = ['plot-designer', 'character-designer', 'continuity-keeper', 'convener', 'writer', 'reviewer', 'proofreader'];
    for (const id of ids) {
      const f = await fieldsFor(id);
      expect(f, `${id} 拿不到 projectName`).toContain('projectName');
    }
  });

  it('为 discussion 用途新增的 reason 是合法值（否则闸门会拒）', async () => {
    const d = await readDigestFor(ctx, PROJECT_ID, 'plot-designer', 'discuss-context', { load: stubLoad });
    expect(d.decision.allow).toBe(true);
    expect(d.decision.reason).toBe('discuss-context');
  });
});

describe('权限矩阵：层级一致性（I1）', () => {  it('编排层可读集 ⊇ 每个角色的白名单键集', () => {
    const policies = allRolePolicies();
    for (const { policy } of policies) {
      const keys = policy?.l1Wide ? ['任意键'] : (policy?.readL1 ?? []);
      for (const k of keys) {
        if (k === '任意键') continue;
        // 编排层是宽权限，天然覆盖（此处断言"角色声明的每一种键族都能被编排层读到"）
        expect(ORCHESTRATOR_POLICY.l1Wide).toBe(true);
      }
    }
    // 叙事式：编排层可读；角色里只有 reviewer 被明确挡住
    expect(ORCHESTRATOR_POLICY.readNarrative).toBe(true);
    expect(policies.find((p) => p.agentId === 'reviewer')?.policy?.readNarrative).toBe(false);
  });

  it('九个角色都显式声明了 memory（新增角色漏声明会被这条逮住）', () => {
    const policies = allRolePolicies();
    // 6 个讨论角色 + 策划官（世界规则）+ 前三章审阅（跨章）+ 写作监工（长跑巡检）
    expect(policies).toHaveLength(9);
    for (const { agentId, policy } of policies) {
      expect(policy, `${agentId} 未声明 memory（fail-closed 下它会读不到任何全局记忆）`).toBeDefined();
    }
    // ★ 流水线角色也必须登记：策划官靠这份现状立世界规则，空了就会凭空造
    for (const id of ['world-architect', 'premiere-reviewer', 'supervisor']) {
      const p = policies.find((x) => x.agentId === id)?.policy;
      expect(p, `${id} 未登记`).toBeDefined();
      expect(p?.readL1 ?? []).toContain('settings.brief');
    }
  });
});
