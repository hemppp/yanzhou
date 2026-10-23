/**
 * @fileoverview 已启用技能 → system prompt
 *
 * 这层的意义是"开关真的作用到模型身上"，所以测三件事：
 *   ① 没开技能时**一个字都不加**（否则每轮 prompt 里多一段空标题，白白烧 token 还干扰模型）
 *   ② 开了技能时清空标注来源（框架注入，不是用户临时说的话）
 *   ③ 一次运行内**只查一次库**（一章十几轮发言，每轮查一次主库是浪费）
 *      + 查库失败要降级成"没有技能"，绝不能把一次写作整垮
 */

import { describe, it, expect, vi } from 'vitest';
import type { ServerPluginContext } from '@novel/core';
import {
  renderEnabledSkills, withEnabledSkills, createAgentSkillResolver, skillMetaNote,
  type EnabledSkill,
} from './agent-skills.js';

const sk = (id: string, systemPrompt: string, name = id): EnabledSkill => ({ id, name, systemPrompt });

/** 只带 agentSkills.getEnabled 的假 ctx */
function fakeCtx(impl: (agentId: string, opts?: { userId?: string }) => Promise<EnabledSkill[]>) {
  const getEnabled = vi.fn(impl);
  return { ctx: { ai: { agentSkills: { getEnabled } } } as unknown as ServerPluginContext, getEnabled };
}

describe('renderEnabledSkills', () => {
  it('没有技能 → 空串（连标题都不加）', () => {
    expect(renderEnabledSkills([])).toBe('');
  });

  it('正文为空的技能被丢掉（空技能不该占 prompt）', () => {
    expect(renderEnabledSkills([sk('a', '   '), sk('b', '')])).toBe('');
  });

  it('有技能 → 带上名字与正文，并标注是框架注入 + 谁启用的', () => {
    const t = renderEnabledSkills([sk('worldbuilder', '核对地点物品设定', '世界观顾问')]);
    expect(t).toContain('世界观顾问');
    expect(t).toContain('核对地点物品设定');
    expect(t).toContain('框架注入');
    expect(t).toContain('智能体 Skills');
  });

  it('多条技能按顺序都进去', () => {
    const t = renderEnabledSkills([sk('a', 'AAA'), sk('b', 'BBB')]);
    expect(t.indexOf('AAA')).toBeLessThan(t.indexOf('BBB'));
  });
});

describe('withEnabledSkills', () => {
  it('没技能时**原样返回**（基础 system 一个字节都不动）', () => {
    const base = '你是写作官，负责落笔。';
    expect(withEnabledSkills(base, [])).toBe(base);
  });

  it('有技能时基础 system 在前、技能块在后（职责优先，技能是叠加）', () => {
    const base = '你是写作官。';
    const t = withEnabledSkills(base, [sk('x', '补一条规则', '某技能')]);
    expect(t.startsWith(base)).toBe(true);
    expect(t).toContain('补一条规则');
  });
});

describe('createAgentSkillResolver', () => {
  it('同一 agent 只查一次库（一章十几轮，不能每轮查主库）', async () => {
    const { ctx, getEnabled } = fakeCtx(async () => [sk('a', 'AAA')]);
    const r = createAgentSkillResolver(ctx, 'u1');
    await r.systemFor('writer', 'B1');
    await r.systemFor('writer', 'B2');
    await r.load('writer');
    expect(getEnabled).toHaveBeenCalledTimes(1);
    expect(getEnabled).toHaveBeenCalledWith('writer', { userId: 'u1' });
  });

  it('不同 agent 各查各的', async () => {
    const { ctx, getEnabled } = fakeCtx(async (id) => [sk(id, `${id} 的规则`)]);
    const r = createAgentSkillResolver(ctx, 'u1');
    const w = await r.systemFor('writer', 'W');
    const p = await r.systemFor('plot-designer', 'P');
    expect(w).toContain('writer 的规则');
    expect(p).toContain('plot-designer 的规则');
    expect(getEnabled).toHaveBeenCalledTimes(2);
  });

  it('★ 查库失败 → 降级成"没有技能"，system 原样返回（技能是旁路，不能把写作整垮）', async () => {
    const { ctx } = fakeCtx(async () => { throw new Error('主库不可用'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createAgentSkillResolver(ctx, 'u1');
    const base = '你是定稿官。';
    expect(await r.systemFor('convener', base)).toBe(base);
    expect(r.appliedIds('convener')).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('没配开关（返回空数组）→ 不加东西', async () => {
    const { ctx } = fakeCtx(async () => []);
    const r = createAgentSkillResolver(ctx, 'u1');
    expect(await r.systemFor('reviewer', 'BASE')).toBe('BASE');
  });

  it('appliedIds 反映真实注入的技能（给事件 meta 用）', async () => {
    const { ctx } = fakeCtx(async () => [sk('worldbuilder', 'X'), sk('rhythm-doctor', 'Y')]);
    const r = createAgentSkillResolver(ctx, 'u1');
    await r.load('writer');
    expect(r.appliedIds('writer')).toEqual(['worldbuilder', 'rhythm-doctor']);
    // 没查过的 agent 不该凭空有值
    expect(r.appliedIds('novelist')).toEqual([]);
  });
});

describe('skillMetaNote', () => {
  it('有技能时给出可读的一行（作者能看出"为什么这次行为变了"）', async () => {
    const { ctx } = fakeCtx(async () => [sk('a', 'X'), sk('b', 'Y')]);
    const r = createAgentSkillResolver(ctx, 'u1');
    await r.load('writer');
    expect(skillMetaNote(r, 'writer')).toBe('技能 a/b');
  });

  it('没有技能时不产生噪音', async () => {
    const { ctx } = fakeCtx(async () => []);
    const r = createAgentSkillResolver(ctx, 'u1');
    await r.load('writer');
    expect(skillMetaNote(r, 'writer')).toBe('');
  });
});
