// ============================================================
// 单智能体技能面板（输入栏上方的第一个入口）
//
// 「写作 Skills」用它，但**它本身与写作无关** —— 只认 agentId。
// 后续要展示别的 agent 的技能，把这个入口的 agentId 一换即可，不必另写一套界面。
//
// 用户口径（2026-09-13）：入口放在对话框输入栏上方，点击后展示该 agent 的 skills。
// ============================================================

import { AlertCircle } from 'lucide-react';
import { AgentSkillList } from './AgentSkillList';

export function EntrySkillPanel({
  agentId, title, hint,
}: {
  agentId: string;
  /** 面板标题，如「写作 Skills」 */
  title: string;
  /** 一句话说明这个智能体管什么（作者靠它确认"我配的是谁"） */
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-2 p-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-semibold">{title}</span>
        {hint && <span className="text-[11px] text-muted-foreground truncate">{hint}</span>}
      </div>
      {/* ★ 开关只是"给这个智能体开/关一条技能"，不等于本轮对话一定用它 ——
          这一句必须写出来，否则作者会以为开了就等于生效在每轮对话里 */}
      <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <AlertCircle size={11} className="shrink-0 mt-0.5" aria-hidden="true" />
        <span>这里的开关决定「这个智能体是否启用该技能」；具体某一轮用哪条，仍在对话的技能徽章里选择。</span>
      </div>
      <AgentSkillList agentId={agentId} compact />
    </div>
  );
}
