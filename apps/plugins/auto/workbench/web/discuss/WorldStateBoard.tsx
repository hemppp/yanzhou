// ============================================================
// ⚠️ 已停用（2026-09-15）—— 不要再往这里加功能
//
// AI 写作工作台的「本章计划」看板已换成图谱版：`ChapterPlanGraphPanel.tsx`。
// 本文件不再被任何组件挂载。它的**变动流水口径**（三类实体状态拉平、按章号倒序）
// 被图谱版整段沿用 —— 改口径时务必两处对齐。
//
// 是否物理删除**待拍板**（先标注、不擅自删）。
// ============================================================
//
// WorldStateBoard — AI 写作工作台**中下侧的数据面板**
//
// 布局角色（2026-09-11 三列改版）：
//   左  AI 对话讨论（贯通全高）
//   中  上＝正文方块 ／ 下＝**本组件**（本章计划 + 最近变动）
//   右  实体栏（EntityRail）
//
// 与 EntityRail 的分工：这里放**需要宽度**的流式信息（计划的阶段与结论、实体变动流水），
// 那边放并列的存量信息（知识库 / 地点 / 物品 / 伏笔）。
//
// 数据全部来自项目 store 与讨论会话，配色走语义变量。
// 「最近变动」是**三类**实体状态的拉平流水：角色（characters.states，实体沉淀写入）、
// 物品（items.states / holders，含持有流转）、伏笔（payoffChapter = 回收）。
// ============================================================

import { useMemo, type ReactNode } from 'react';
import { Clock } from 'lucide-react';
import type { Character, Foreshadow, Item } from '@novel/shared';
import { useCharacterStore, useForeshadowStore, useItemStore } from '@novel-plugins/data-core/stores';
import { WorkbenchPlan, type StageKey, type StageState } from '../pipeline/WorkbenchPlan';

const COLORS = {
  character: 'hsl(var(--entity-character))',
  item: 'hsl(var(--entity-item))',
  foreshadow: 'hsl(var(--entity-foreshadow))',
} as const;

interface ChangeRow {
  key: string;
  chapter: number;
  entity: string;
  color: string;
  label: string;
  from?: string;
  to?: string;
}

/** 通用卡片：固定表头 + 可滚动主体 */
function Panel({ title, icon: Icon, iconColor, count, hint, children }: {
  title: string;
  icon: typeof Clock;
  iconColor: string;
  count?: number;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className="flex flex-col min-h-0 rounded-xl h-full w-full"
      style={{ background: 'hsl(var(--card) / 0.5)', border: '0.5px solid hsl(var(--border) / 0.55)' }}
    >
      <header
        className="shrink-0 flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: '0.5px solid hsl(var(--border) / 0.45)' }}
      >
        <Icon size={12} style={{ color: iconColor }} aria-hidden="true" />
        <span className="text-[11px] font-medium" style={{ color: 'hsl(var(--ink))' }}>
          {title}
        </span>
        {typeof count === 'number' && (
          <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
            {count}
          </span>
        )}
        {hint && (
          <span className="ml-auto text-[10px] truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>
            {hint}
          </span>
        )}
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5">{children}</div>
    </section>
  );
}

interface WorldStateBoardProps {
  projectId: string;
  /** 讨论收敛出的本章结论（透传给计划卡） */
  conclusion?: string | null;
  /** 会话进行中（透传给计划卡） */
  running?: boolean;
  /** 各阶段状态（由工作台按收到的事件累积，透传给计划卡） */
  stages?: Partial<Record<StageKey, StageState>>;
}

export function WorldStateBoard({ projectId, conclusion, running, stages }: WorldStateBoardProps) {
  const items = useItemStore((s) => s.items);
  const foreshadows = useForeshadowStore((s) => s.foreshadows);
  const characters = useCharacterStore((s) => s.characters);

  const pItems = useMemo(() => items.filter((i) => i.projectId === projectId) as Item[], [items, projectId]);
  const pFsh = useMemo(
    () => foreshadows.filter((f) => f.projectId === projectId) as Foreshadow[],
    [foreshadows, projectId],
  );
  const pChars = useMemo(
    () => characters.filter((c) => c.projectId === projectId) as Character[],
    [characters, projectId],
  );

  /** 全书最大章号：用来表达「距今多少章」 */
  const latestChapter = useMemo(() => {
    let max = 0;
    for (const ch of pChars) {
      for (const st of ch.states ?? []) if (st.chapter > max) max = st.chapter;
    }
    for (const it of pItems) {
      for (const st of it.states ?? []) if (st.chapter > max) max = st.chapter;
      for (const h of it.holders ?? []) if (h.chapter > max) max = h.chapter;
      for (const c of it.chapters ?? []) if (c > max) max = c;
    }
    for (const f of pFsh) {
      if (f.seedChapter > max) max = f.seedChapter;
      if (f.payoffChapter && f.payoffChapter > max) max = f.payoffChapter;
    }
    return max;
  }, [pChars, pItems, pFsh]);

  /** 变动流水：所有 EntityState 拉平后按章号倒序 —— 这就是「随小说内容更变」 */
  const changes = useMemo(() => {
    const rows: ChangeRow[] = [];
    // 角色：实体沉淀写 characters.states（此前前端不读，角色的变化看不见）
    for (const ch of pChars) {
      for (const st of ch.states ?? []) {
        rows.push({
          key: `${ch.id}:${st.chapter}:${st.field}:${st.newValue}`,
          chapter: st.chapter,
          entity: ch.name,
          color: COLORS.character,
          label: st.field === '状态' ? '角色变化' : st.field,
          from: st.oldValue,
          to: st.newValue,
        });
      }
    }
    for (const it of pItems) {
      for (const st of it.states ?? []) {
        rows.push({
          key: `${it.id}:${st.chapter}:${st.field}:${st.newValue}`,
          chapter: st.chapter,
          entity: it.name,
          color: COLORS.item,
          label: st.description || st.field,
          from: st.oldValue,
          to: st.newValue,
        });
      }
    }
    for (const f of pFsh) {
      if (f.payoffChapter) {
        rows.push({
          key: `${f.id}:payoff`,
          chapter: f.payoffChapter,
          entity: f.description.slice(0, 10),
          color: COLORS.foreshadow,
          label: '伏笔回收',
          to: '已回收',
        });
      }
    }
    return rows.sort((a, b) => b.chapter - a.chapter);
  }, [pChars, pItems, pFsh]);

  return (
    <div className="h-full grid grid-cols-1 lg:grid-cols-2 gap-3 min-h-0">
      {/* 左：本章计划（阶段推进 + 本章结论） */}
      <div className="min-h-0 flex">
        <WorkbenchPlan conclusion={conclusion} running={running} stages={stages} />
      </div>

      {/* 右：最近变动 */}
      <Panel
        title="最近变动"
        icon={Clock}
        iconColor="hsl(var(--entity-event))"
        count={changes.length}
        hint={latestChapter > 0 ? `推进至第 ${latestChapter} 章` : undefined}
      >
        {changes.length === 0 ? (
          <div className="text-[10px] leading-[1.7] py-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
            还没有状态变化 —— 实体在章节里发生变动时会自动沉淀到这里。
          </div>
        ) : (
          <ul className="space-y-1.5">
            {changes.map((c) => (
              <li key={c.key} className="flex items-baseline gap-2 text-[11px]">
                <span
                  className="shrink-0 tabular-nums"
                  style={{ color: 'hsl(var(--muted-foreground))', fontSize: 10, minWidth: 26 }}
                >
                  Ch{c.chapter}
                </span>
                <span className="shrink-0 font-medium truncate max-w-[130px]" style={{ color: c.color }}>
                  {c.entity}
                </span>
                <span className="shrink-0" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  {c.label}
                </span>
                <span className="truncate" style={{ color: 'hsl(var(--ink-light))' }}>
                  {c.from ? `${c.from} → ` : ''}
                  {c.to}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
