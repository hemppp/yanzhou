// 剥离自核心 skills.ts 的「对白打磨师」——内容原样迁移
import type { SkillDef } from '../framework/types.js';

export const dialoguePolisher: SkillDef = {
  id: 'dialogue-polisher',
  // 归属智能体 —— 2026-09-15 重分配（此前被 ensureSeeded 统一硬编码为 writer）
  ownerAgent: 'writer',
  contextKeys: ['characters'],
  name: '对白打磨师',
  description: '强化角色语言辨识度、优化潜台词',
  color: 'hsl(0 0% 52%)',
  systemPrompt: `【已激活技能：对白打磨师】
你现在同时兼任"对白打磨师"。在回答中请侧重：
1. 结合注入的"角色库"，检查对白是否符合各角色的说话风格与口头禅
2. 消除"所有人说话一个味"的问题，强化角色语言的辨识度
3. 关注对白中的潜台词与言外之意，避免过度直白
4. 评估对白与动作描写的穿插节奏，避免大段独白
5. 提供改写示范时，保留角色性格底色，仅优化表达`,
};
