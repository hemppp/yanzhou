import { useMemo, useRef, useCallback } from 'react';
import { useTimelineStore, useCharacterStore, useChapterStore } from '@novel-plugins/data-core/stores';
import { useChapterJumpStore } from '../stores/chapterJumpStore';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import { openChapterInEditor } from '../utils/openChapter';
import { CalendarClock, ArrowUpRight } from 'lucide-react';
import type { TimelineEvent } from '@novel/shared';

// ★ 原为 3 色硬编码（#4a90d9 蓝 / #d4a853 金 / #6bc4a0 绿）。
//   这些色作「文字压在自身 10% 底」时对比度仅 1.86–2.86:1，全部低于 AA(4.5)，
//   且与黑白水墨主题冲突 → 改走墨阶 token（见 globals.css 的 --chapter-* 注释）。
//   取值形式保持 `hsl(var(--x))`，因为下面的用法要拼 `${accent}40` 这类 alpha 后缀。
const typeColors: Record<string, string> = {
  event: 'hsl(var(--chapter-5))',
  foreshadow: 'hsl(var(--chapter-3))',
  state_change: 'hsl(var(--chapter-7))',
};

const chapterAccents = [
  'hsl(var(--chapter-1))',
  'hsl(var(--chapter-2))',
  'hsl(var(--chapter-3))',
  'hsl(var(--chapter-4))',
  'hsl(var(--chapter-5))',
  'hsl(var(--chapter-6))',
  'hsl(var(--chapter-7))',
  'hsl(var(--chapter-8))',
];

function getChapterAccent(chapter: number): string {
  return chapterAccents[(chapter - 1) % chapterAccents.length]!;
}

const typeLabels: Record<string, string> = {
  event: '事件',
  foreshadow: '伏笔',
  state_change: '状态变化',
};

interface ChapterGroup {
  chapter: number;
  chapterTitle: string;
  events: TimelineEvent[];
}

interface TimelineFlowChartProps {
  selectedChapter?: number | 'all';
}

export function TimelineFlowChart({ selectedChapter = 'all' }: TimelineFlowChartProps) {
  const projectId = useCurrentProjectId();
  const events = useTimelineStore((s) => s.events);
  const characters = useCharacterStore((s) => s.characters);
  const chapters = useChapterStore((s) => s.chapters);
  const triggerJumpHighlight = useChapterJumpStore((s) => s.triggerJumpHighlight);
  const containerRef = useRef<HTMLDivElement>(null);

  const projectEvents = useMemo(
    () => events.filter((e) => e.projectId === projectId).sort((a, b) => a.order - b.order),
    [events, projectId]
  );

  const projectChapters = useMemo(
    () => chapters.filter((c) => c.projectId === projectId),
    [chapters, projectId]
  );

  const grouped = useMemo<ChapterGroup[]>(() => {
    const map = new Map<number, TimelineEvent[]>();
    for (const ev of projectEvents) {
      const ch = ev.chapter ?? 0;
      if (!map.has(ch)) map.set(ch, []);
      map.get(ch)!.push(ev);
    }
    let result = Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([ch, evs]) => ({
        chapter: ch,
        chapterTitle: (() => {
          const found = projectChapters.find((c) => c.order === ch);
          return found ? found.title : '';
        })(),
        events: evs.sort((a, b) => a.order - b.order),
      }));
    if (selectedChapter !== 'all') {
      result = result.filter((g) => g.chapter === selectedChapter);
    }
    return result;
  }, [projectEvents, projectChapters, selectedChapter]);

  /** 点击事件节点跳转到对应章节，并触发编辑器段落高亮 */
  const handleJumpToChapter = useCallback((chapterOrder: number | null | undefined, title?: string, description?: string, charNames?: string[]) => {
    const order = chapterOrder ?? 1;
    const target = projectChapters.find((c) => c.order === order)
      ?? projectChapters.slice().sort((a, b) => a.order - b.order)[0];
    if (target) {
      // ★ 2026-10-26：跳章必须走 openChapterInEditor —— 时间线面板本身也占着中心区，
      //   只 setCurrentChapter 的话用户看不到编辑器（表现为"点了没反应"）。
      openChapterInEditor(target.id);
      triggerJumpHighlight(JSON.stringify({
        title: title ?? '',
        desc: description ?? '',
        chars: charNames ?? [],
      }));
    } else {
      triggerJumpHighlight(JSON.stringify({
        title: title ?? '',
        desc: description ?? '',
        chars: charNames ?? [],
      }));
    }
  }, [projectChapters, triggerJumpHighlight]);

  if (!projectId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <CalendarClock size={48} className="mx-auto mb-4" style={{ color: 'hsl(var(--muted-foreground))' }} />
          <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>请先选择项目</p>
        </div>
      </div>
    );
  }

  if (grouped.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center max-w-sm px-6">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
            <CalendarClock size={28} className="text-muted-foreground" />
          </div>
          <p className="text-sm text-foreground/85 font-medium mb-1">暂无时间线事件</p>
          <p className="text-xs text-muted-foreground">AI 识别或手动添加的事件将按章节分栏显示</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* 滚动区域 */}
      <div
        className="flex-1 overflow-auto"
        ref={containerRef}
        style={{
          overflowX: selectedChapter === 'all' ? 'auto' : 'hidden',
          overflowY: selectedChapter === 'all' ? 'hidden' : 'auto',
        }}
      >
        <div
          className="flex h-full px-4 pt-3 pb-5 gap-4"
          style={{
            minWidth: selectedChapter === 'all' ? 'min-content' : '100%',
            justifyContent: selectedChapter !== 'all' ? 'center' : 'flex-start',
          }}
        >
          {grouped.map((group) => {
            const accent = getChapterAccent(group.chapter);
            const isSingle = selectedChapter !== 'all';
            return (
              <div
                key={group.chapter}
                className="flex flex-col h-full rounded-xl"
                style={{
                  width: isSingle ? '100%' : 300,
                  flexShrink: isSingle ? 1 : 0,
                  flexGrow: isSingle ? 1 : 0,
                  background: selectedChapter === 'all'
                    ? `linear-gradient(to right, ${accent}08, transparent 40%)`
                    : 'transparent',
                  borderLeft: selectedChapter === 'all'
                    ? `3px solid ${accent}60`
                    : 'none',
                  paddingLeft: selectedChapter === 'all' ? 'var(--space-5)' : '0',
                  paddingTop: 'var(--space-3)',
                  paddingBottom: 'var(--space-3)',
                  paddingRight: 'var(--space-3)',
                }}
              >
                {/* 统一宽度容器：单章视图时居中限宽，全部视图时占满 */}
                <div
                  className="flex flex-col h-full w-full"
                  style={{
                    maxWidth: isSingle ? 520 : 'none',
                    margin: isSingle ? '0 auto' : '0',
                  }}
                >
                {/* 章节标题卡片 */}
                <button
                  type="button"
                  onClick={() => handleJumpToChapter(group.chapter, group.chapterTitle || undefined, undefined)}
                  className="nm-nav-item rounded-xl p-3 mb-3 text-left transition-all duration-200 hover:scale-[1.02] hover:shadow-lg cursor-pointer shrink-0 w-full"
                  style={{
                    background: `linear-gradient(135deg, ${accent}25, ${accent}10)`,
                    // ★ 拆长写：这是「点击跳章」的导航卡片，不是动作按钮 →
                    //   豁免由 nm-nav-item 显式承担，不依赖简写重置 border-image 的副作用
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: `${accent}40`,
                    boxShadow: `0 2px 12px ${accent}15`,
                  }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: accent, boxShadow: `0 0 8px ${accent}80` }}
                    />
                    <span
                      className="text-xs font-semibold"
                      style={{ color: accent }}
                    >
                      第 {group.chapter} 章
                    </span>
                    <ArrowUpRight
                      size={12}
                      className="ml-auto shrink-0 opacity-60"
                      style={{ color: accent }}
                    />
                  </div>
                  <div
                    className="text-sm font-semibold truncate"
                    style={{ color: 'hsl(var(--foreground))' }}
                  >
                    {group.chapterTitle || `第${group.chapter}章`}
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {group.events.length} 个事件
                  </div>
                </button>

                {/* 事件列表 */}
                <div
                  className="flex-1 overflow-y-auto space-y-2.5 flex flex-col mc-scrollbar"
                  style={{
                    scrollbarWidth: 'thin',
                  }}
                >
                  {group.events.map((ev, idx) => {
                    const color = ev.color || typeColors[ev.type] || 'hsl(var(--muted-foreground))';
                    const eventChars = characters.filter((c) => ev.characterIds?.includes(c.id));
                    const charNames = eventChars.map((c) => c.name);
                    const isFirst = idx === 0;

                    return (
                      <div key={ev.id} className="relative w-full">
                        {/* 连接线装饰 - 与圆点中心精确对齐 (border 3px + padding 10px + 圆点半径 4px = 17px) */}
                        {!isFirst && (
                          <div
                            className="absolute -top-2.5 w-px h-2.5"
                            style={{ left: '17px', background: `${accent}40` }}
                          />
                        )}

                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => handleJumpToChapter(ev.chapter, ev.title, ev.description, charNames)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              handleJumpToChapter(ev.chapter, ev.title, ev.description, charNames);
                            }
                          }}
                          className="w-full rounded-2xl border overflow-hidden backdrop-blur-md transition-all duration-200 cursor-pointer hover:shadow-md hover:-translate-y-0.5 hover:border-opacity-80 group"
                          style={{
                            borderColor: `${accent}35`,
                            background: `linear-gradient(135deg, rgb(var(--glass-tint) / 0.7), rgb(var(--glass-tint) / 0.4))`,
                            borderLeft: `3px solid ${accent}`,
                          }}
                        >
                          {/* 顶部色条 */}
                          <div
                            className="h-0.5 w-full"
                            style={{ background: `linear-gradient(to right, ${accent}, ${color}60)` }}
                          />

                          <div className="p-2.5">
                            <div className="flex items-center gap-2 mb-1.5">
                              <div
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ background: color }}
                              />
                              <span className="text-sm font-medium leading-none flex-1" style={{ color: 'hsl(var(--foreground))' }}>
                                {ev.title}
                              </span>
                              <ArrowUpRight
                                size={12}
                                className="shrink-0 opacity-30 group-hover:opacity-70 transition-opacity"
                                style={{ color: 'hsl(var(--muted-foreground))' }}
                              />
                            </div>

                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span
                                className="text-[10px] px-1.5 py-0.5 rounded-xl font-medium shrink-0"
                                style={{ background: `${accent}18`, color: accent }}
                              >
                                第{ev.chapter}章
                              </span>
                              <span
                                className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0"
                                style={{ background: `${color}18`, color }}
                              >
                                {typeLabels[ev.type] || ev.type}
                              </span>
                              {ev.timestamp && (
                                <span className="text-[10px] shrink-0" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                  {ev.timestamp}
                                </span>
                              )}
                              {eventChars.length > 0 && (
                                <div className="flex items-center gap-1 flex-wrap ml-auto">
                                  {eventChars.slice(0, 2).map((c) => (
                                    <span
                                      key={c.id}
                                      className="text-[10px] px-1.5 py-0.5 rounded-full"
                                      style={{
                                        background: `${c.color || '#8b5cf6'}15`,
                                        color: c.color || '#8b5cf6',
                                      }}
                                    >
                                      {c.name}
                                    </span>
                                  ))}
                                  {eventChars.length > 2 && (
                                    <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                      +{eventChars.length - 2}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                </div>
              </div>
            );
          })}

          {/* 右侧统计信息（仅全部视图显示） */}
          {selectedChapter === 'all' && (
            <div className="flex-shrink-0 w-44 h-full pl-2 pr-4">
              <div className="glass-frost rounded-xl p-3 h-full overflow-y-auto">
                <div className="text-xs font-semibold mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  事件类型
                </div>
                <div className="space-y-1.5 mb-4">
                  {Object.entries(typeColors).map(([type, color]) => (
                    <div key={type} className="flex items-center gap-2">
                      <div
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: color }}
                      />
                      <span className="text-xs" style={{ color: 'hsl(var(--foreground))' }}>
                        {typeLabels[type] || type}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="text-xs font-semibold mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  统计
                </div>
                <div className="space-y-1 mb-4">
                  <div className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    共 <span className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                      {projectEvents.length}
                    </span> 个事件
                  </div>
                  <div className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    覆盖 <span className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                      {grouped.length}
                    </span> 章
                  </div>
                </div>

                <div className="text-xs font-semibold mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  章节概览
                </div>
                <div className="space-y-1">
                  {grouped.map((group) => {
                    const accent = getChapterAccent(group.chapter);
                    return (
                      <button
                        key={group.chapter}
                        type="button"
                        onClick={() => handleJumpToChapter(group.chapter, group.chapterTitle || undefined, undefined)}
                        className="w-full flex items-center gap-2 p-1.5 rounded-xl transition-colors hover:opacity-80 text-left"
                        style={{ background: `${accent}08` }}
                      >
                        <div
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ background: accent }}
                        />
                        <span className="text-xs truncate flex-1" style={{ color: 'hsl(var(--foreground))' }}>
                          第{group.chapter}章
                        </span>
                        <span className="text-[10px] shrink-0" style={{ color: 'hsl(var(--muted-foreground))' }}>
                          {group.events.length}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
