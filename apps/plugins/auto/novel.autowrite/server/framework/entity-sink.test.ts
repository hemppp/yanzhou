// ============================================================
// 实体沉淀单测 —— P1（记忆只落正文、没落实体）的回归关卡
//
// 覆盖：
//   · 名称校验与枚举归一化（纯函数）
//   · 五张表的落库：角色 / 物品 / 地点 / 伏笔 / 事件
//   · 精确匹配去重（子串匹配会把「林墨」和「林墨白」并成一个 —— 前端踩过的坑）
//   · 幂等（同一章重复沉淀，chapters 与 states 都不许翻倍）
//   · 伏笔 plant / advance / payoff 三分支 + 找不到既有条目时如实跳过
//
// 运行载体：apps/server 的 vitest（vitest.config.ts include 已收录本目录）
// ============================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initProjectDb, deleteProjectDb, schema, eq, type DrizzleDb } from '@novel/db';
import type { ServerPluginContext } from '@novel/core';
import {
  screenBatchConflicts,
  usableName,
  mapForeshadowAction,
  mapForeshadowType,
  mapHolderAction,
  toState,
  writeEntities,
  type SinkResult,
} from './entity-sink.js';

const PROJECT_ID = `entity-sink-test-${Date.now()}`;
let db: DrizzleDb;
/** screenBatchConflicts 只用 ctx.db.project()，其余字段本用例不碰 */
let ctx: ServerPluginContext;

function newResult(): SinkResult {
  return { created: 0, updated: 0, skipped: 0, notes: [] };
}

const input = (order: number) => ({ projectId: PROJECT_ID, order, draft: '（单测不经过模型，直接喂抽取结果）' });

async function characters() {
  return db.select().from(schema.characters).where(eq(schema.characters.projectId, PROJECT_ID));
}

beforeAll(async () => {
  db = await initProjectDb(PROJECT_ID);
  ctx = { db: { project: () => db, global: () => db } } as unknown as ServerPluginContext;
}, 60_000);

afterAll(async () => {
  try {
    await deleteProjectDb(PROJECT_ID);
  } catch { /* 已清理 */ }
});

// ---- 纯函数 ----

describe('实体沉淀 · 名称与枚举归一化', () => {
  it('usableName：拦泛指词与单字名，放行正常人名', () => {
    expect(usableName('陈默')).toBe('陈默');
    expect(usableName(' 林晚 ')).toBe('林晚');
    // 单字名一律拦（AI 输出的单字名几乎都是误识别）
    expect(usableName('周')).toBeNull();
    // 泛指词
    expect(usableName('警察')).toBeNull();
    expect(usableName('主角')).toBeNull();
    // 过长 / 空
    expect(usableName('这是一个很长的句子片段')).toBeNull();
    expect(usableName('')).toBeNull();
    expect(usableName(undefined)).toBeNull();
  });

  it('mapForeshadowAction：中英文都能认，未识别返回 null', () => {
    expect(mapForeshadowAction('plant')).toBe('plant');
    expect(mapForeshadowAction('埋')).toBe('plant');
    expect(mapForeshadowAction('advance')).toBe('advance');
    expect(mapForeshadowAction('推进')).toBe('advance');
    expect(mapForeshadowAction('payoff')).toBe('payoff');
    expect(mapForeshadowAction('回收')).toBe('payoff');
    // 「不动」不处理
    expect(mapForeshadowAction('不动')).toBeNull();
    expect(mapForeshadowAction(undefined)).toBeNull();
  });

  it('mapForeshadowType：中文映射到英文枚举，未识别回退 identity', () => {
    expect(mapForeshadowType('身份')).toBe('identity');
    expect(mapForeshadowType('turning')).toBe('turning');
    expect(mapForeshadowType('转折')).toBe('turning');
    expect(mapForeshadowType('乱七八糟')).toBe('identity');
  });

  it('mapHolderAction：默认 held，不误判为持有', () => {
    expect(mapHolderAction('获得')).toBe('gained');
    expect(mapHolderAction('lost')).toBe('lost');
    expect(mapHolderAction('')).toBe('held');
  });

  it('toState：没有 newValue 就不产生状态流水', () => {
    expect(toState({ field: '认知', newValue: '知情' }, 3)?.chapter).toBe(3);
    expect(toState({ field: '认知' }, 3)).toBeNull();
    expect(toState(undefined, 3)).toBeNull();
  });
});

// ---- 落库 ----

describe('实体沉淀 · 五表落库', () => {
  it('新建角色/物品/地点/伏笔/事件，并写入章号与状态流水', async () => {
    const r = newResult();
    await writeEntities(db, input(3), {
      characters: [{
        name: '陈默', role: 'protagonist',
        change: { field: '认知', oldValue: '不知情', newValue: '知道对方认识自己', description: '第二通电话后' },
      }],
      items: [{
        name: '那部手机', type: '信物',
        holders: [{ name: '陈默', action: 'gained' }],
        change: { field: '归属', newValue: '陈默' },
      }],
      locations: [{ name: '地铁车厢', description: '早高峰的地铁' }],
      foreshadows: [{ description: '来电者直呼其名', type: '身份', action: 'plant', hint: '第二通电话' }],
      events: [{ title: '地铁上捡到手机', consequences: ['被卷入不知名的联系'] }],
    }, r);

    expect(r.created).toBe(5);
    expect(r.skipped).toBe(0);

    const chars = await characters();
    const chen = chars.find((c) => c.name === '陈默');
    expect(chen).toBeTruthy();
    expect(chen?.role).toBe('protagonist');
    expect(JSON.parse(chen!.chapters!)).toEqual([3]);
    const states = JSON.parse(chen!.states!);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ chapter: 3, field: '认知', newValue: '知道对方认识自己' });

    // 物品：持有者名称解析成角色 id，currentHolders 由流转史派生
    const items = await db.select().from(schema.items).where(eq(schema.items.projectId, PROJECT_ID));
    const phone = items.find((i) => i.name === '那部手机');
    expect(phone).toBeTruthy();
    expect(JSON.parse(phone!.currentHolders!)).toEqual([chen!.id]);
    expect(JSON.parse(phone!.holders!)[0]).toMatchObject({ characterId: chen!.id, chapter: 3, action: 'gained' });

    // 伏笔：中文类型映射成英文枚举，seedChapter 记本章
    const fsh = await db.select().from(schema.foreshadows).where(eq(schema.foreshadows.projectId, PROJECT_ID));
    const seed = fsh.find((f) => f.description === '来电者直呼其名');
    expect(seed).toMatchObject({ type: 'identity', status: 'planted', seedChapter: 3 });

    const events = await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.projectId, PROJECT_ID));
    expect(events.find((e) => e.title === '地铁上捡到手机')?.chapter).toBe(3);

    const locs = await db.select().from(schema.locations).where(eq(schema.locations.projectId, PROJECT_ID));
    expect(locs.find((l) => l.name === '地铁车厢')).toBeTruthy();
  });
});

describe('实体沉淀 · 精确匹配（绝不子串）', () => {
  it('「林墨白」是新角色，不会并进已有的「林墨」', async () => {
    const r1 = newResult();
    await writeEntities(db, input(4), { characters: [{ name: '林墨' }] }, r1);
    const r2 = newResult();
    await writeEntities(db, input(5), { characters: [{ name: '林墨白' }] }, r2);

    expect(r2.created).toBe(1);
    const names = (await characters()).map((c) => c.name);
    expect(names).toContain('林墨');
    expect(names).toContain('林墨白');
  });

  it('同名角色只补章号与状态，不新建第二行', async () => {
    const before = (await characters()).filter((c) => c.name === '陈默').length;
    const r = newResult();
    await writeEntities(db, input(4), {
      characters: [{ name: '陈默', change: { field: '状态', newValue: '决定追查' } }],
    }, r);
    expect(r.created).toBe(0);
    expect(r.updated).toBe(1);
    expect((await characters()).filter((c) => c.name === '陈默').length).toBe(before);

    const chen = (await characters()).find((c) => c.name === '陈默')!;
    expect(JSON.parse(chen.chapters!)).toEqual([3, 4]);
    expect(JSON.parse(chen.states!)).toHaveLength(2);
  });
});

describe('实体沉淀 · 幂等', () => {
  it('同一章重复沉淀：第二次什么都不动，chapters 与 states 都不翻倍', async () => {
    const payload = {
      characters: [{ name: '陈默', change: { field: '处境', newValue: '开始追查' } }],
    };
    const r1 = newResult();
    await writeEntities(db, input(11), payload, r1);
    expect(r1.updated).toBe(1);

    const r2 = newResult();
    await writeEntities(db, input(11), payload, r2);
    expect(r2.created).toBe(0);
    expect(r2.updated).toBe(0);
    expect(r2.skipped).toBe(1);

    const chen = (await characters()).find((c) => c.name === '陈默')!;
    expect(JSON.parse(chen.chapters!)).toEqual([3, 4, 11]);
    expect(JSON.parse(chen.states!)).toHaveLength(3);
  });
});

describe('实体沉淀 · 伏笔三分支', () => {
  it('advance：推进既有伏笔，追加 hint 并把状态提到 hinted', async () => {
    const r = newResult();
    await writeEntities(db, input(6), {
      foreshadows: [{ description: '来电者直呼其名', type: '身份', action: 'advance', hint: '第三次来电提到工位' }],
    }, r);
    expect(r.updated).toBe(1);

    const f = (await db.select().from(schema.foreshadows)
      .where(eq(schema.foreshadows.projectId, PROJECT_ID)))
      .find((x) => x.description === '来电者直呼其名')!;
    expect(f.status).toBe('hinted');
    expect(JSON.parse(f.hints!)).toHaveLength(1);
  });

  it('payoff：回收既有伏笔，写 payoffChapter 并置为已回收', async () => {
    const r = newResult();
    await writeEntities(db, input(7), {
      foreshadows: [{ description: '来电者直呼其名', action: 'payoff', hint: '确认是旧识' }],
    }, r);
    expect(r.updated).toBe(1);

    const f = (await db.select().from(schema.foreshadows)
      .where(eq(schema.foreshadows.projectId, PROJECT_ID)))
      .find((x) => x.description === '来电者直呼其名')!;
    expect(f).toMatchObject({ status: 'payed_off', payoffChapter: 7 });
  });

  it('找不到既有条目时不猜、不新建，如实记一笔', async () => {
    const before = (await db.select().from(schema.foreshadows)
      .where(eq(schema.foreshadows.projectId, PROJECT_ID))).length;
    const r = newResult();
    await writeEntities(db, input(8), {
      foreshadows: [{ description: '库里根本没有的伏笔', action: 'payoff' }],
    }, r);

    expect(r.updated).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.notes.join()).toContain('未在库中找到同条');
    const after = (await db.select().from(schema.foreshadows)
      .where(eq(schema.foreshadows.projectId, PROJECT_ID))).length;
    expect(after).toBe(before);
  });

  it('plant 已存在同描述伏笔时不重复播种', async () => {
    const r = newResult();
    await writeEntities(db, input(9), {
      foreshadows: [{ description: '来电者直呼其名', action: 'plant' }],
    }, r);
    expect(r.created).toBe(0);
    expect(r.skipped).toBe(1);
  });

  // ============================================================
  // ★ 2026-10-23 回归：模型「抄个开头」/ 改两个标点也要能连上
  //
  // 真机跑第 3–5 章时：advance 的 description 被模型改写成既有条目的**前缀**
  // （或只差标点），精确匹配落空 → 一条真实存在的推进被丢成「未在库中找到同条」。
  // 下面两条锁住补救行为（归一化命中 / 包含命中），第三条锁住**歧义时仍拒绝**。
  // ============================================================
  it('advance：描述只差标点时，归一化后仍能连上既有伏笔', async () => {
    const r = newResult();
    await writeEntities(db, input(10), {
      // 既有条目的标点被换成另一种（逗号→顿号、句号→句号后加了空格）
      foreshadows: [{ description: '来电者直呼其名，', action: 'advance', hint: '第四次来电' }],
    }, r);
    expect(r.updated).toBe(1);
    expect(r.notes.join()).toContain('去标点');

    const f = (await db.select().from(schema.foreshadows)
      .where(eq(schema.foreshadows.projectId, PROJECT_ID)))
      .find((x) => x.description === '来电者直呼其名')!;
    expect(JSON.parse(f.hints!)).toHaveLength(2);
  });

  it('advance：描述是既有条目的片段（「抄开头」）时，唯一候选可连上', async () => {
    // 先种一条够长的伏笔
    const seed = newResult();
    await writeEntities(db, input(11), {
      foreshadows: [{
        description: '发件箱，一条。收件人那一栏不是号码，是一个名字。两个字。陈默。内容三个字：三小时。',
        type: '身份',
        action: 'plant',
      }],
    }, seed);
    expect(seed.created).toBe(1);

    const r = newResult();
    await writeEntities(db, input(12), {
      foreshadows: [{
        // 模型只抄了开头一段（真实第 5 章就是这么写的）
        description: '发件箱，一条。收件人那一栏不是号码，是一个名字',
        action: 'advance',
        hint: '第 5 章再次出现',
      }],
    }, r);
    expect(r.updated).toBe(1);
    expect(r.notes.join()).toContain('包含关系');
  });

  it('歧义时仍然拒绝：两条既有条目都包含该片段则不落库', async () => {
    const seed = newResult();
    await writeEntities(db, input(13), {
      foreshadows: [
        { description: '广播自己念出明天的值班名单，第一个是陈默', type: '设定', action: 'plant' },
        { description: '广播自己念出明天的值班名单，第二个是苏晚', type: '设定', action: 'plant' },
      ],
    }, seed);
    expect(seed.created).toBe(2);

    const r = newResult();
    await writeEntities(db, input(14), {
      foreshadows: [{ description: '广播自己念出明天的值班名单', action: 'advance' }],
    }, r);
    expect(r.updated).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.notes.join()).toContain('未在库中找到同条');
  });
});

describe('实体沉淀 · 脏数据不入库', () => {
  it('泛指词与单字名被跳过，且不影响同批正常条目', async () => {
    const r = newResult();
    await writeEntities(db, input(10), {
      characters: [{ name: '主角' }, { name: '周' }, { name: '苏梨' }],
      locations: [{ name: '' }],
      events: [{ title: '' }],
    }, r);

    expect(r.created).toBe(1);
    expect(r.skipped).toBe(4);
    const names = (await characters()).map((c) => c.name);
    expect(names).toContain('苏梨');
    expect(names).not.toContain('主角');
  });
});

describe('沉淀前的批次矛盾筛查（同批次同槽位两个值 → 一条都不落库）', () => {
  it('矛盾条目被摘掉、其余照常落库，并写进冲突队列', async () => {
    const raw = {
      characters: [
        { name: '甲', role: 'supporting', change: { field: 'state', newValue: '断臂' } },
        { name: '甲', change: { field: 'state', newValue: '完好' } },   // ★ 同一章里自相矛盾
        { name: '乙', role: 'supporting', change: { field: 'state', newValue: '轻伤' } },
      ],
    } as never;
    const blocked = await screenBatchConflicts(ctx, PROJECT_ID, raw, 9);
    expect(blocked).toBe(1);
    // 冲突的那个角色整条被摘掉，另一个留下
    const names = (raw as { characters: Array<{ name: string }> }).characters.map((c) => c.name);
    expect(names).toEqual(['乙']);
    // 进了冲突队列
    const open = await db.select().from(schema.factConflicts).where(eq(schema.factConflicts.projectId, PROJECT_ID));
    expect(open.some((c) => c.slot === 'characters/甲/state')).toBe(true);
  });

  it('没有矛盾时原样返回（不动抽取结果）', async () => {
    const raw = { characters: [{ name: '丙', change: { field: 'state', newValue: '好着' } }] } as never;
    expect(await screenBatchConflicts(ctx, PROJECT_ID, raw, 10)).toBe(0);
    expect((raw as { characters: unknown[] }).characters).toHaveLength(1);
  });
});
