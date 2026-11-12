// ============================================================
// 阶段落库单测 —— 角色档案补全（2026-11-07）
//
// 背景：作者反馈「自动写作的角色详细内容不够详细」。cast 段原先只把宪章里的一句话骨架
// 抽进库，appearance / belief / weakness 三列从来没被写过。补全这一步把骨架扩写成详细档案。
//
// 这里只测**补全的合并语义**（不碰 DB）：补全失败必须降级成骨架，且绝不覆盖已有值。
// ============================================================

import { describe, expect, it } from 'vitest';
import type { ServerPluginContext } from '@novel/core';
import { enrichCastProfiles, type RawChar } from './sink.js';

const OPTS = { artifact: '《角色与节奏宪章》\n主角弧光：…', briefText: '主角：陈默' };

function ctxReturning(content: string): ServerPluginContext {
  return { ai: { complete: async () => content } } as unknown as ServerPluginContext;
}

function skeleton(): RawChar[] {
  return [
    { name: '陈默', role: 'protagonist', desire: '找到姐姐', personality: '克制' },
    { name: '苏晚', role: 'femaleLead' },
  ];
}

describe('角色档案补全', () => {
  it('把骨架扩写成八列档案，并挂上关系', async () => {
    const rows = skeleton();
    const answer = JSON.stringify({
      characters: [
        {
          name: '陈默',
          appearance: '常年一件洗到发白的深灰外套，左手小指伸不直。',
          personality: '表面克制，内里偏执；紧张时会反复按亮手机屏幕。',
          desire: '找到失踪三年的姐姐，哪怕只剩一个说法。',
          fear: '怕自己其实早就知道答案，只是不敢承认。',
          belief: '只要把每个细节都对上，真相就藏不住。',
          weakness: '一旦有人提起姐姐，判断力会明显下降。',
          speechStyle: '短句，很少用反问；口头禅是「先记下来」。',
          backstory: '三年前姐姐失踪那晚，他值夜班，错过了最后一通电话。',
          relations: [{ target: '苏晚', type: '互相试探', description: '两人都在对方身上找线索，谁也不敢先交底。' }],
        },
        {
          name: '苏晚',
          appearance: '总是把头发扎得很紧，右腕有一道旧伤。',
          personality: '对陌生人热络，对亲近的人防备。',
          desire: '拿回被拿走的东西。',
          fear: '被当成弃子。',
          belief: '先下手的人才有活路。',
          weakness: '受不了别人替她做决定。',
          speechStyle: '句子短，常把问题原样抛回去。',
          backstory: '在旧城区长大，靠替人跑腿换消息。',
        },
        // 名单外的人名 —— 必须被丢弃（模型不得凭空造角色）
        { name: '路人甲', appearance: '不该进库' },
      ],
    });

    const out = await enrichCastProfiles(ctxReturning(answer), { ...OPTS, rows });

    expect(out.note).toBeUndefined();
    const chen = out.rows.find((r) => r.name === '陈默')!;
    expect(chen.appearance).toContain('外套');
    expect(chen.belief).toContain('细节');
    expect(chen.weakness).toContain('姐姐');
    // 原有骨架字段被更详细的版本替换
    expect(String(chen.personality)).toContain('偏执');
    expect((chen.relations ?? []).length).toBe(1);

    // 名单外角色不会凭空出现
    expect(out.rows.map((r) => r.name)).toEqual(['陈默', '苏晚']);
  });

  it('补全留空的字段不覆盖骨架里的已有值', async () => {
    const rows = skeleton();
    const answer = JSON.stringify({
      characters: [{ name: '陈默', appearance: '深灰外套。', desire: '' }],
    });

    const out = await enrichCastProfiles(ctxReturning(answer), { ...OPTS, rows });

    const chen = out.rows.find((r) => r.name === '陈默')!;
    expect(chen.appearance).toBe('深灰外套。');
    // 补全给了空串 → 保留抽取阶段的欲望，不被清空
    expect(chen.desire).toBe('找到姐姐');
  });

  it('模型调用失败 → 原样返回骨架并给出降级说明（不抛错）', async () => {
    const rows = skeleton();
    const ctx = {
      ai: { complete: async () => { throw new Error('upstream 502'); } },
    } as unknown as ServerPluginContext;

    const out = await enrichCastProfiles(ctx, { ...OPTS, rows });

    expect(out.rows).toBe(rows);
    expect(out.note).toContain('补全失败');
    expect(out.note).toContain('502');
  });

  it('返回的不是合法 JSON → 原样返回骨架并给出说明', async () => {
    const rows = skeleton();
    const out = await enrichCastProfiles(ctxReturning('抱歉，我无法完成。'), { ...OPTS, rows });

    expect(out.rows).toBe(rows);
    expect(out.note).toContain('JSON');
  });

  it('空角色名单 → 不发模型调用', async () => {
    let called = false;
    const ctx = {
      ai: { complete: async () => { called = true; return '{}'; } },
    } as unknown as ServerPluginContext;

    const out = await enrichCastProfiles(ctx, { ...OPTS, rows: [] });

    expect(called).toBe(false);
    expect(out.rows).toEqual([]);
    expect(out.note).toBeUndefined();
  });
});
