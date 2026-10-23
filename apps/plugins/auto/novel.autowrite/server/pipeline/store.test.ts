// ============================================================
// 流水线状态机单测
//
// 这些用例**不调用模型** —— 状态机是纯逻辑，模型调用只在 orchestrator 里。
// 之所以单独测它：闸门语义（三态/上限/作废）一旦写歪，作者会以为"批准了"，而系统不认。
// 实测教训也有过一次：`canRun` 最初只判断"该阶段 idle"，于是**跳着跑也放行了**，
// 一次误操作直接跑掉一整段讨论（真花了模型额度）。
// ============================================================

import { describe, it, expect } from 'vitest';
import type { KvService } from '@novel/core';
import {
  PipelineStore, computeBriefHash, canRun, emptyState, nextStage, prevStage, RUNNING_STALE_MS,
} from './store.js';
import { REVISION_LIMIT, type PipelineState } from './types.js';

/** 内存版 KV：key = pluginId|key|projectId（与宿主同款签名） */
function fakeKv(): KvService {
  const m = new Map<string, unknown>();
  const k = (p: string, key: string, o?: { projectId?: string }) => `${p}|${key}|${o?.projectId ?? ''}`;
  return {
    get: <T,>(p: string, key: string, o?: { projectId?: string }) => m.get(k(p, key, o)) as T | undefined,
    set: async (p: string, key: string, v: unknown, o?: { projectId?: string }) => { m.set(k(p, key, o), v); },
    list: (p: string, prefix = '', o?: { projectId?: string }) =>
      [...m.entries()]
        .filter(([kk]) => kk.startsWith(`${p}|${prefix}`) && kk.endsWith(`|${o?.projectId ?? ''}`))
        .map(([kk, value]) => ({ key: kk.split('|')[1] ?? '', value })),
    delete: async (p: string, key: string, o?: { projectId?: string }) => { m.delete(k(p, key, o)); },
  };
}

const mkStore = () => new PipelineStore(fakeKv(), 'proj-1');
const freshState = (): PipelineState => emptyState('proj-1', 'h1', '');
/** 把某阶段推到「等确认」——测试里直接摆状态，不走模型 */
function awaiting(state: PipelineState, stage: PipelineState['stage'], artifact = '契约文本'): PipelineState {
  state.stages[stage].status = 'awaiting_user';
  state.stages[stage].artifact = artifact;
  state.stage = stage;
  return state;
}

describe('computeBriefHash', () => {
  it('键序不同但内容相同 → 同一指纹（否则会误判成"设定改了"）', () => {
    const a = computeBriefHash({ opening: 'x', style: 'y' }, '系统流', 'n1');
    const b = computeBriefHash({ style: 'y', opening: 'x' }, '系统流', 'n1');
    expect(a).toBe(b);
  });

  it('内容、流派、备注任一变化 → 指纹变化', () => {
    const base = computeBriefHash({ opening: 'x' }, '系统流', '');
    expect(computeBriefHash({ opening: 'x2' }, '系统流', '')).not.toBe(base);
    expect(computeBriefHash({ opening: 'x' }, '无系统流', '')).not.toBe(base);
    expect(computeBriefHash({ opening: 'x' }, '系统流', '冷一点')).not.toBe(base);
  });

  it('空设定也能算（不抛）', () => {
    expect(computeBriefHash(null, '', '')).toHaveLength(16);
  });
});

describe('canRun —— 守卫口径', () => {
  it('游标所在段可跑', () => {
    expect(canRun(emptyState('p', 'h'), 'brief').ok).toBe(true);
  });

  it('跳着往前的段**不许**跑（回归：曾放行，误跑掉一整段讨论）', () => {
    const s = emptyState('p', 'h');
    const r = canRun(s, 'bible');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('不能跳着跑');
  });

  it('往回重跑更早的段可以（作者改了设定要从头立）', () => {
    const s = emptyState('p', 'h');
    s.stage = 'plot';
    expect(canRun(s, 'cast').ok).toBe(true);
  });

  it('正在跑 / 等确认的段不许重复跑', () => {
    const s = awaiting(emptyState('p', 'h'), 'cast');
    expect(canRun(s, 'cast').ok).toBe(false);
    const running = emptyState('p', 'h');
    running.stages.cast.status = 'running';
    running.stages.cast.runningSince = Date.now();
    expect(canRun(running, 'cast').ok).toBe(false);
  });
});

describe('running 锁与僵死收敛', () => {
  it('beginStage 落盘 running（防两个标签页重复跑同一段）', async () => {
    const kv = fakeKv();
    const store = new PipelineStore(kv, 'p');
    const s = emptyState('p', 'h');
    await store.beginStage(s, 'cast');
    expect(s.stages.cast.status).toBe('running');
    expect(typeof s.stages.cast.runningSince).toBe('number');
    // 换一个实例读（模拟另一个标签页）：拿到的必须是 running，从而被 canRun 拦住
    const other = new PipelineStore(kv, 'p').load()!;
    expect(other.stages.cast.status).toBe('running');
    expect(canRun(other, 'cast').ok).toBe(false);
  });

  it('僵死 running（进程被杀）在读状态时收敛成「中断了，可重试」', async () => {
    const kv = fakeKv();
    const store = new PipelineStore(kv, 'p');
    const s = emptyState('p', 'h');
    await store.beginStage(s, 'bible');
    // 把开始时刻拨回到很久以前，模拟进程被杀的残留
    s.stages.bible.runningSince = Date.now() - RUNNING_STALE_MS - 1000;
    await store.save(s);

    const loaded = new PipelineStore(kv, 'p').load()!;
    expect(loaded.stages.bible.status).toBe('failed');
    expect(loaded.stages.bible.error).toContain('没有跑完');
    // 收敛之后必须能重跑，否则作者永久卡在这一段
    expect(canRun(loaded, 'bible').ok).toBe(true);
  });

  it('打回 / 退回会清掉 runningSince（不留僵尸时间戳）', () => {
    const store = mkStore();
    const s = awaiting(emptyState('p', 'h'), 'bible');
    s.stages.bible.runningSince = Date.now();
    store.applyDecision(s, 'bible', 'revise');
    expect(s.stages.bible.runningSince).toBeUndefined();
    expect(s.stages.bible.status).toBe('idle');
  });
});

describe('applyDecision —— 闸门三态', () => {
  it('approve：本段定稿，游标推进到下一段', () => {
    const store = mkStore();
    const s = awaiting(emptyState('p', 'h'), 'cast');
    const r = store.applyDecision(s, 'cast', 'approve');
    expect(s.stages.cast.status).toBe('approved');
    expect(s.stage).toBe('bible');
    expect(r.movedTo).toBe('bible');
  });

  it('revise：带批注重跑本段，游标不动，revision+1', () => {
    const store = mkStore();
    const s = awaiting(emptyState('p', 'h'), 'bible');
    store.applyDecision(s, 'bible', 'revise');
    expect(s.stages.bible.status).toBe('idle');
    expect(s.stages.bible.revision).toBe(1);
    expect(s.stage).toBe('bible');
    // 打回后 approved 标记必须撤掉，否则 UI 会显示成"已定稿"
    expect(s.stages.bible.sinked).toBe(false);
  });

  it('撞上修订上限：不硬撑，把 hitLimit 交回作者', () => {
    const store = mkStore();
    const s = awaiting(emptyState('p', 'h'), 'plot');
    for (let i = 1; i < REVISION_LIMIT; i++) {
      const r = store.applyDecision(s, 'plot', 'revise');
      expect(r.hitLimit).toBe(false);
      s.stages.plot.status = 'awaiting_user';
    }
    const last = store.applyDecision(s, 'plot', 'revise');
    expect(last.hitLimit).toBe(true);
    expect(s.stages.plot.revision).toBe(REVISION_LIMIT);
  });

  it('reject：退回上一段，且本段产出作废（状态一起重置，不留"等确认"的鬼状态）', () => {
    const store = mkStore();
    const s = emptyState('p', 'h');
    s.stages.cast.status = 'approved';
    // 世界圣经已定稿，剧情总纲等确认
    s.stages.bible.status = 'awaiting_user';
    s.stages.bible.artifact = '总纲草稿';
    s.stage = 'plot';
    const r = store.applyDecision(s, 'plot', 'reject');
    // plot 的上一段是 bible（阶段序：brief → cast → bible → plot）
    expect(s.stage).toBe('bible');
    expect(s.stages.bible.status).toBe('idle');
    expect(s.stages.bible.revision).toBe(1);
    // ★ 被退回的那一段本身也必须归零，不能停在 awaiting_user
    expect(s.stages.plot.status).toBe('idle');
    expect(s.stages.plot.sinked).toBe(false);
    expect(r.invalidated).toContain('plot');
    // 更早的已批准阶段不受影响
    expect(s.stages.cast.status).toBe('approved');
    // 退回时若上一段之后还有已批准的段，它们一并作废
    expect(s.stages.bible.artifact).toBe('总纲草稿');
  });

  it('reject 时后面已批准的段一并作废', () => {
    const store = mkStore();
    const s = emptyState('p', 'h');
    s.stages.bible.status = 'approved';
    s.stages.plot.status = 'approved';
    s.stage = 'plot';
    const r = store.applyDecision(s, 'plot', 'reject');
    expect(s.stage).toBe('bible');
    expect(s.stages.bible.status).toBe('idle');
    expect(s.stages.plot.status).toBe('idle');
    expect(r.invalidated).toEqual(expect.arrayContaining(['bible', 'plot']));
  });

  it('第一段退无可退 → 等价于重跑本段，不炸', () => {
    const store = mkStore();
    const s = awaiting(emptyState('p', 'h'), 'brief');
    const r = store.applyDecision(s, 'brief', 'reject');
    expect(s.stage).toBe('brief');
    expect(s.stages.brief.revision).toBe(1);
    expect(r.invalidated).toEqual([]);
  });
});

describe('invalidateFrom —— 基线变更的处理', () => {
  it('从指定段起作废已批准的（更早的保留）', () => {
    const store = mkStore();
    const s = emptyState('p', 'h');
    s.stages.brief.status = 'approved';
    s.stages.cast.status = 'approved';
    s.stages.bible.status = 'approved';
    const stale = store.invalidateFrom(s, 'cast');
    expect(stale).toEqual(['cast', 'bible']);
    expect(s.stages.brief.status).toBe('approved');
    expect(s.stages.cast.status).toBe('idle');
  });
});

describe('持久化与视图', () => {
  it('ensure：首次创建；指纹变了只报告不自动重置', async () => {
    const store = mkStore();
    const first = await store.ensure('h1', '备注');
    expect(first.baselineMismatch).toBe(false);
    expect(Object.keys(first.state.stages)).toHaveLength(7);

    const again = await store.ensure('h2', '备注');
    expect(again.baselineMismatch).toBe(true);
    // ★ 不自动重置：静默丢掉已批准的内容比"多按一次重跑"糟得多
    expect(again.state.briefHash).toBe('h1');
  });

  it('load：脏数据兜底（缺 stages 视为无状态；缺字段补齐）', async () => {
    const kv = fakeKv();
    const store = new PipelineStore(kv, 'p');
    await kv.set('novel.autowrite', 'pipeline', { projectId: 'p' }, { projectId: 'p' });
    expect(store.load()).toBeUndefined();

    await kv.set('novel.autowrite', 'pipeline', {
      projectId: 'p', stage: 'cast', briefHash: 'h', stages: {},
    }, { projectId: 'p' });
    const loaded = store.load();
    expect(loaded?.stages.plot.status).toBe('idle');
    expect(loaded?.cursor.reviewEvery).toBe(3);
  });

  it('view：基线变了 → 已批准的阶段全部标为过期', () => {
    const store = mkStore();
    const s = emptyState('p', 'h1');
    s.stages.brief.status = 'approved';
    s.stages.cast.status = 'approved';
    s.stage = 'bible';
    const view = store.view(s, 'h2');
    expect(view.staleStages).toEqual(['brief', 'cast']);
    expect(view.stages.find((x) => x.key === 'cast')?.gated).toBe(true);
    expect(view.stages.find((x) => x.key === 'brief')?.gated).toBe(false);
    // 全部七段均已实现（M3 补齐 production）
    for (const k of ['brief', 'cast', 'bible', 'plot', 'drift', 'pilot', 'production']) {
      expect(view.stages.find((x) => x.key === k)?.implemented, `${k} 应已实现`).toBe(true);
    }
  });

  it('决策台账：append + 倒序读 + 上限截断', async () => {
    const store = mkStore();
    await store.appendDecision({ stage: 'cast', at: 1, by: 'u', action: 'approve' });
    await store.appendDecision({ stage: 'bible', at: 2, by: 'u', action: 'revise', note: '太拖' });
    const view = store.view(emptyState('p', 'h'), 'h');
    expect(view.decisions[0]?.stage).toBe('bible');
    expect(view.decisions[0]?.note).toBe('太拖');
  });

  it('轨迹确认台账：append + 倒序读（回放用）', async () => {
    const store = mkStore();
    await store.appendTrack({ from: 1, to: 3, at: 1, by: 'u', verdict: 'on_track', note: '在轨' });
    await store.appendTrack({ from: 4, to: 6, at: 2, by: 'u', verdict: 'minor_drift', note: '略偏', patch: '补对峙' });
    const view = store.view(emptyState('p', 'h'), 'h');
    expect(view.tracks[0]?.verdict).toBe('minor_drift');
    expect(view.tracks[0]?.patch).toBe('补对峙');
    expect(store.getTracks()).toHaveLength(2);
  });

  it('view 暴露 production 专有字段（监工判定 / 是否停下）', () => {
    const store = mkStore();
    const s = emptyState('p', 'h');
    s.stages.production.status = 'awaiting_user';
    s.stages.production.supervisorVerdict = { order: 12, verdict: 'halt', issues: 3 };
    s.stages.production.supervisorHalted = true;
    const view = store.view(s, 'h');
    const p = view.stages.find((x) => x.key === 'production');
    expect(p?.supervisorVerdict?.verdict).toBe('halt');
    expect(p?.supervisorHalted).toBe(true);
  });
});

describe('阶段序工具', () => {
  it('next/prev 边界', () => {
    expect(nextStage('brief')).toBe('cast');
    expect(nextStage('production')).toBeNull();
    expect(prevStage('brief')).toBeNull();
    expect(prevStage('cast')).toBe('brief');
  });
});
