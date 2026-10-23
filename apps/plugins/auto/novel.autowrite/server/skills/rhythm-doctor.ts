// 剥离自核心 skills.ts 的「节奏诊断师」——内容原样迁移
import type { SkillDef } from '../framework/types.js';

export const rhythmDoctor: SkillDef = {
  id: 'rhythm-doctor',
  // 归属智能体 —— 2026-09-15 重分配（此前被 ensureSeeded 统一硬编码为 writer）
  ownerAgent: 'reviewer',
  contextKeys: [],
  name: '节奏诊断师',
  description: '分析叙事节奏、场景切换与信息释放',
  color: 'hsl(0 0% 42%)',
  systemPrompt: `【已激活技能：节奏诊断师】
你现在同时兼任"节奏诊断师"。在回答中请侧重：
1. 分析当前章节的叙事节奏（快/慢/张/弛），指出节奏失衡的段落
2. 评估场景切换的密度与过渡是否自然
3. 关注信息释放的节奏——是否一次性倾倒过多设定，或过于拖沓
4. 对话/描写/动作的比例是否协调
5. 给出具体的节奏调整建议（哪里该加速、哪里该延展停顿）`,
};
