// ============================================================
// SkillLibraryPanel —— 技能库（工作台分页面板）
//
// 2026-09-17 新增。起因：作者要求把「写作 agent skills」按钮从 AI 对话输入栏上方撤掉，
// 统一收进技能库，让用户在一个地方开技能。
//
// 结构：技能库 / 写作agent / 智能体 三块（Tab 在 AgentSkillsPanel 里）——
//   技能库   库里全部技能 + 安装 / 删除
//   写作agent 写作官这一个 agent 的技能开关
//   智能体   全部 agent 清单 → 下钻看各自的开关
//
// ★ 为什么不直接复用 AgentSkillsPanel 而要多包一层：
//   AgentSkillsPanel 原本挂在**三百来像素宽的 AI 交流栏上方**，内边距与外层滚动
//   都是按那个宽度调的。这里要的是「点气泡后占满分页区」，需要自己的标题栏与
//   滚动容器；把布局职责留在这一层，AgentSkillsPanel 就能同时服务两种容器。
// ============================================================

import { Wand2 } from 'lucide-react';
import { AgentSkillsPanel } from './AgentSkillsPanel';

export function SkillLibraryPanel() {
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 标题栏：与其它面板保持同一套视觉语言（图标 + 标题 + 一句说明） */}
      <div
        className="shrink-0 flex items-center gap-2 px-3.5 py-2.5"
        style={{ borderBottom: '0.5px solid hsl(var(--border) / 0.6)' }}
      >
        <Wand2 size={14} style={{ color: 'hsl(var(--mountain-cyan))' }} aria-hidden="true" />
        <span className="text-[12.5px] font-medium" style={{ color: 'hsl(var(--foreground))' }}>
          技能库
        </span>
        <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
          安装 / 删除技能，并在这里给智能体开启
        </span>
      </div>

      {/* 内容区独立滚动：面板占满分页区，列表可能很长 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <AgentSkillsPanel />
      </div>
    </div>
  );
}

export default SkillLibraryPanel;
