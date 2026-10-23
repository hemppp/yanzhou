// 剥离自核心 skills.ts 的「智能续写」——内容原样迁移
import type { SkillDef } from '../framework/types.js';

export const continueWriter: SkillDef = {
  id: 'continue-writer',
  // 归属智能体 —— 2026-09-15 重分配（此前被 ensureSeeded 统一硬编码为 writer）
  ownerAgent: 'writer',
  contextKeys: ['outline', 'characters', 'events'],
  name: '智能续写',
  description: '根据大纲和前文风格，自动续写当前章节内容',
  color: 'hsl(0 0% 38%)',
  systemPrompt: `【已激活技能：智能续写】
你现在同时兼任"续写助手"。你的任务是续写当前章节的正文内容。请遵循以下原则：
1. 严格遵循前文的叙事风格、语言习惯和节奏
2. 结合注入的"大纲"节点，确保续写方向符合整体故事规划
3. 结合注入的"角色库"，保持角色性格、说话风格和行为逻辑一致
4. 结合注入的"事件列表"，确保续写内容与已有事件不冲突
5. 续写内容应直接作为正文输出，无需额外解释或说明
6. 保持段落结构和叙事视角的一致性`,
};
