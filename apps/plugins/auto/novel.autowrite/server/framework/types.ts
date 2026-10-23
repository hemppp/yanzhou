// ============================================================
// novel.autowrite 框架核心类型
//
// 技能 = 一等公民模块：chat 型（systemPrompt + contextKeys），框架零加工直通宿主。
//
// ★ 2026-09-28：`FlowSpec` / `GovernanceConfig` / `ChatSkillModule` / `SkillModule`
//   随旧批次流水线一并删除（`FlowSpec` 的唯一使用者是已删的 `autowrite/index.ts`）。
//   仅保留 `SkillDef` —— 8 个聊天型技能与宿主 `ctx.ai.skills.register` 的内联契约。
// ============================================================

/** 技能定义（与宿主 ctx.ai.skills.register 的内联契约对齐） */
export interface SkillDef {
  id: string;
  systemPrompt: string;
  contextKeys: string[];
  name?: string;
  description?: string;
  color?: string;
  /**
   * 归属智能体（skill-library 种子用）。
   *
   * 为什么放在技能定义里：归属是「这个技能该由谁用」的**固有属性**，与技能正文同源，
   * 不该由种子逻辑统一填。此前 `ensureSeeded()` 硬编码 `ownerAgent: 'writer'`，
   * 后果是 10 条技能全堆在写作官名下、另外 7 个 agent 的技能列表全空（2026-09-15 修正）。
   *
   * 必须是 `ai/agents/skill-targets.ts` 里声明过的 agent id，否则装了也看不见
   * （`installSkill` 会直接拒绝未知归属）。省略时回落到 'writer'。
   */
  ownerAgent?: string;
}
