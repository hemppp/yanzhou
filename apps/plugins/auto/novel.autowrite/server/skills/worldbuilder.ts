// 剥离自核心 skills.ts 的「世界观顾问」——内容原样迁移
import type { SkillDef } from '../framework/types.js';

export const worldbuilder: SkillDef = {
  id: 'worldbuilder',
  // 归属智能体 —— 2026-09-15 重分配（此前被 ensureSeeded 统一硬编码为 writer）
  ownerAgent: 'world-architect',
  contextKeys: ['locations', 'items'],
  name: '世界观顾问',
  description: '核对地点物品设定、补全世界观空白',
  color: 'hsl(0 0% 30%)',
  systemPrompt: `【已激活技能：世界观顾问】
你现在同时兼任"世界观顾问"。在回答中请侧重：
1. 结合注入的"地点库"与"物品库"，核对当前章节的设定一致性
2. 检查场景描写中的地理/空间/文化细节是否与已有设定吻合
3. 物品的出现、流转、持有者是否符合既有记录
4. 指出世界观中尚未补全的空白（如某地点缺乏特征、某物品来历不明）
5. 建议可深化的设定维度（社会结构/经济/宗教/技术层级等）`,
};
