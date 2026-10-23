// ============================================================
// 已启用技能 → system prompt（把「智能体 Skills」的开关真正接进执行链路）
//
// 为什么必须有这一层：开关只是配置。不接进来的话，
// 作者在界面上把「世界观顾问」打开了、写作官却收不到任何东西 —— 开关就是个装饰。
//
// 口径：
//   · **开关开着** 且 **技能有正文** → 追加到该 agent 的 system prompt 末尾；
//   · 取不到 / 没配 / 正文为空 → 一个字都不加（fail-closed，
//     宁可少加，也不要凭空给模型塞一条空技能）；
//   · 一次运行内按 agent 缓存 —— 同一 agent 一跑就是十几轮，不能每轮查一次库；
//   · 明确标注是**框架注入**，并写清是谁启用的，避免模型把这当成用户临时说的话。
//
// 边界（有意不做的）：技能的 `contextKeys`（要注入地点/物品等实体）**尚未**在这条链路上生效 ——
// 插件侧的 digest 目前只带角色/伏笔/大纲/前章正文。等真用到再加，见 docs/architecture/skills-library.md §9。
// ============================================================

import type { ServerPluginContext } from '@novel/core';

export interface EnabledSkill { id: string; name: string; systemPrompt: string }

/** 拼 system 后缀（纯函数，可直接单测） */
export function renderEnabledSkills(skills: EnabledSkill[]): string {
  const usable = skills.filter((s) => s.systemPrompt.trim().length > 0);
  if (usable.length === 0) return '';
  return [
    '',
    '【本智能体已启用的技能（作者在「智能体 Skills」里配置，框架注入；与上面的职责一并遵守）】',
    ...usable.map((s) => `◆ ${s.name}\n${s.systemPrompt.trim()}`),
  ].join('\n');
}

/** 基础 system + 已启用技能 */
export function withEnabledSkills(base: string, skills: EnabledSkill[]): string {
  return base + renderEnabledSkills(skills);
}

export interface AgentSkillResolver {
  /** 该 agent 已启用的技能（带缓存） */
  load(agentId: string): Promise<EnabledSkill[]>;
  /** 装配后的 system prompt */
  systemFor(agentId: string, base: string): Promise<string>;
  /** 本轮实际注入的技能 id（给事件 meta / 日志用，便于作者看出"为什么行为变了"） */
  appliedIds(agentId: string): string[];
}

/**
 * 建一个"本次运行内"的解析器（每个会话/每段流水线各建一个）。
 * 读失败一律降级成"没有技能" —— 技能装配是旁路，不能因为它把一次写作整垮。
 */
export function createAgentSkillResolver(ctx: ServerPluginContext, userId: string): AgentSkillResolver {
  const cache = new Map<string, EnabledSkill[]>();

  const load = async (agentId: string): Promise<EnabledSkill[]> => {
    const hit = cache.get(agentId);
    if (hit) return hit;
    let list: EnabledSkill[] = [];
    try {
      list = await ctx.ai.agentSkills.getEnabled(agentId, { userId });
    } catch (e) {
      console.warn(`[skills] 读取 ${agentId} 已启用技能失败（按未启用继续）:`, e);
      list = [];
    }
    cache.set(agentId, list);
    return list;
  };

  return {
    load,
    async systemFor(agentId: string, base: string): Promise<string> {
      return withEnabledSkills(base, await load(agentId));
    },
    appliedIds(agentId: string): string[] {
      return (cache.get(agentId) ?? []).map((s) => s.id);
    },
  };
}

/** 事件 meta 用：`技能 worldbuilder/rhythm-doctor`（没有就不显示） */
export function skillMetaNote(resolver: AgentSkillResolver, agentId: string): string {
  const ids = resolver.appliedIds(agentId);
  return ids.length ? `技能 ${ids.join('/')}` : '';
}
