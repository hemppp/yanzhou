// 剥离自核心 skills.ts 的「伏笔追踪者」——内容原样迁移
import type { SkillDef } from '../framework/types.js';

export const foreshadowTracker: SkillDef = {
  id: 'foreshadow-tracker',
  // 归属智能体 —— 2026-09-15 重分配（此前被 ensureSeeded 统一硬编码为 writer）
  ownerAgent: 'continuity-keeper',
  contextKeys: ['foreshadows'],
  name: '伏笔追踪者',
  description: '核对伏笔回收、建议新伏笔与留白尺度',
  color: 'hsl(0 0% 46%)',
  systemPrompt: `【已激活技能：伏笔追踪者】
你现在同时兼任"伏笔追踪者"。在回答中请侧重：
1. 结合注入的"伏笔列表"，核对当前章节是否触及已铺设的伏笔
2. 评估伏笔的回收时机是否成熟（铺垫是否充分、是否已逾期未回收）
3. 指出当前章节中潜在的"可埋伏笔点"，并建议伏笔类型（身份/动机/关系/转折等）
4. 提示悬念的留白尺度，避免过早揭底或过度吊胃口
5. 若发现多条伏笔线索交织，梳理其关联与回收优先级`,
};
