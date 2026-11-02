// 剥离自核心 skills.ts 的「节奏诊断师」——内容原样迁移
import type { SkillDef } from '../framework/types.js';

export const rhythmDoctor: SkillDef = {
  id: 'rhythm-doctor',
  /**
   * 归属智能体。
   *
   * 历史：2026-09-15 从 `writer` 重分配（此前被 ensureSeeded 统一硬编码）；
   * ★ 2026-11-01 从 `reviewer` 改为 `supervisor` —— **原归属与角色契约直接冲突**：
   *   `ROLE_REVIEWER` 的契约里明写「不做文学评价 —— 文笔、**节奏好不好不归你管**」，
   *   而本技能第 1 条就是「分析当前章节的叙事节奏」。启用后两条指令互相打架。
   *
   * 为什么落到 `supervisor`：
   *   · 它是**交付后逐章巡检**的角色，`readNarrative: true`（真读得到正文）；
   *   · 它的职责正是"读着别扭但说不清哪不对"——节奏失配是典型症状；
   *   · 与它已有的 `chapter-quality-audit` 是**深浅关系**而非重复：
   *     那边把「节奏感」作为九维之一（权重 9%、合格线 75），
   *     本技能是**专攻**节奏的五项拆解（含场景切换密度与信息释放）。
   *
   * ⚠️ 注：`reviewer` 契约里说节奏"是评审官的事"，而「评审官」是**润色门**的内部提示词
   *   （`framework/gates-prompts.ts` 的 REVIEWER_SYSTEM），**不是 12 个可注册智能体之一** ——
   *   所以那个说法在技能归属上是落不了地的，只能就近挂到读得到正文的巡检角色。
   */
  ownerAgent: 'supervisor',
  contextKeys: [],
  name: '节奏诊断师',
  description: '分析叙事节奏、场景切换与信息释放',
  color: 'hsl(190 34% 42%)',
  systemPrompt: `【已激活技能：节奏诊断师】
你现在同时兼任"节奏诊断师"。在回答中请侧重：
1. 分析当前章节的叙事节奏（快/慢/张/弛），指出节奏失衡的段落
2. 评估场景切换的密度与过渡是否自然
3. 关注信息释放的节奏——是否一次性倾倒过多设定，或过于拖沓
4. 对话/描写/动作的比例是否协调
5. 给出具体的节奏调整建议（哪里该加速、哪里该延展停顿）`,
};
