import { useMemo, useState, useRef, useEffect } from 'react';
import { useTimelineStore, useChapterStore, useCharacterStore } from '@novel-plugins/data-core/stores';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import { Plus, GitBranch, Search, Loader2, LayoutGrid } from 'lucide-react';
import { nanoid } from 'nanoid';
import type { TimelineEvent } from '@novel/shared';
import { TimelineFlowChart } from './TimelineFlowChart';
import { getCapability } from '@/plugin/registry';
import type { StreamTimelineEvent } from '../hooks/aiScanCapability';

const DEFAULT_EVENT_TYPES = [
  { value: 'event', label: '事件' },
  { value: 'foreshadow', label: '伏笔' },
  { value: 'state_change', label: '状态变化' },
];

// ★ 原为 6 色高饱和板，改墨阶（与 TimelineFlowChart 同源，注释见 globals.css 的 --chapter-*）
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

/** 候选事件已移除：提取后直接静默写入时间线 */
export function TimelineView() {
  const projectId = useCurrentProjectId();
  const events = useTimelineStore((s) => s.events);
  const addEvent = useTimelineStore((s) => s.addEvent);
  const chapters = useChapterStore((s) => s.chapters);
  const currentChapterId = useChapterStore((s) => s.currentChapterId);
  const characters = useCharacterStore((s) => s.characters);
  const [newEventTitle, setNewEventTitle] = useState('');
  const [newEventType, setNewEventType] = useState<TimelineEvent['type']>('event');
  const [selectedChapter, setSelectedChapter] = useState<number | 'all'>('all');

  // 提取状态（仅用于按钮 loading，不再弹候选面板）
  const [extracting, setExtracting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // ★ 2026-10-11 实测：`ai.timelineExtract` 能力缺失时此前只做了 handleExtract 内静默
  //   return —— 按钮照常渲染，点了转圈又复原（「亮着的死按钮」）。合同要求
  //   **入口隐藏**（docs/architecture/web-workbench-split.md §5.3 / L628：
  //   「ai.timelineExtract 缺失 → 『从正文提取事件』入口隐藏；时间线手动增删改查完整」）。
  //   在组件体内求值（每次渲染现取）：模块加载可能早于插件 apply() 注册能力，
  //   模块级常量会把 null 冻死。
  const extractCap = getCapability<{ extractEventsByKeyword: (...a: unknown[]) => Promise<void> }>(
    'ai.timelineExtract',
  );

  const currentChapter = useMemo(
    () => chapters.find((c) => c.id === currentChapterId),
    [chapters, currentChapterId]
  );

  const projectChapters = useMemo(
    () => (projectId ? chapters.filter((c) => c.projectId === projectId) : []),
    [chapters, projectId]
  );

  const filtered = useMemo(
    () => events.filter((e) => e.projectId === projectId),
    [events, projectId]
  );

  const chaptersWithEventsList = useMemo(() => {
    const list: { order: number; title: string; count: number }[] = [];
    const chapterEventCounts = new Map<number, number>();
    for (const e of filtered) {
      if (e.chapter != null && e.chapter > 0) {
        chapterEventCounts.set(e.chapter, (chapterEventCounts.get(e.chapter) ?? 0) + 1);
      }
    }
    for (const ch of projectChapters.sort((a, b) => a.order - b.order)) {
      const count = chapterEventCounts.get(ch.order) ?? 0;
      if (count > 0) {
        list.push({ order: ch.order, title: ch.title, count });
      }
    }
    return list;
  }, [filtered, projectChapters]);

  const totalChapters = projectChapters.length;
  const chaptersWithEvents = useMemo(() => {
    const set = new Set<number>();
    for (const e of filtered) {
      if (e.chapter != null && e.chapter > 0) set.add(e.chapter);
    }
    return set.size;
  }, [filtered]);
  const progress = totalChapters > 0 ? Math.min(1, chaptersWithEvents / totalChapters) : 0;

  // 组件卸载时取消正在进行的提取请求
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  if (!projectId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <GitBranch
            size={48}
            className="mx-auto mb-4"
            style={{ color: 'hsl(var(--muted-foreground))' }}
          />
          <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
            请先选择项目
          </p>
        </div>
      </div>
    );
  }

  /** 直接添加事件（不经过 AI 提取） */
  const handleAddDirect = () => {
    const title = newEventTitle.trim();
    if (!title) {
      shakeInput();
      return;
    }
    addEvent({
      id: nanoid(),
      projectId,
      title,
      type: newEventType,
      chapter: currentChapter?.order,
      order: Date.now(),
      characterIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    setNewEventTitle('');
  };

  /** 按关键词从当前章节静默提取事件，直接写入时间线（无弹窗） */
  const handleExtract = async () => {
    const keyword = newEventTitle.trim();
    if (!keyword) {
      shakeInput();
      return;
    }

    if (!extractCap) return; // 能力缺失：入口已隐藏（合同 §5.3），此处仅防御
    if (!currentChapter) return;

    // 取消上一次请求
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setExtracting(true);

    let addedCount = 0;
    let baseOrder = Date.now();

    try {
      await extractCap.extractEventsByKeyword(
        currentChapter.content,
        currentChapter.title,
        currentChapter.order,
        keyword,
        (event: StreamTimelineEvent) => {
          // 直接静默写入时间线 store
          const charIds = event.characterNames
            .map((name) => characters.find((ch) => ch.name === name || ch.aliases?.includes(name))?.id)
            .filter((id): id is string => !!id);

          addEvent({
            id: nanoid(),
            projectId,
            title: event.title,
            description: event.description,
            type: event.type,
            chapter: currentChapter.order,
            timestamp: event.timestamp,
            order: baseOrder++,
            characterIds: charIds,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          addedCount++;
        },
        controller.signal,
        projectId,
      );
      if (addedCount > 0) {
        console.debug(`[TimelineView] 静默提取完成：新增 ${addedCount} 个事件`);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error('[TimelineView] 提取事件失败:', err);
    } finally {
      setExtracting(false);
    }
  };

  /** 输入框抖动反馈 */
  const shakeInput = () => {
    const input = document.getElementById('timeline-new-event-input');
    if (input) {
      input.focus();
      input.animate(
        [
          { transform: 'translateX(0)' },
          { transform: 'translateX(-6px)' },
          { transform: 'translateX(6px)' },
          { transform: 'translateX(-4px)' },
          { transform: 'translateX(0)' },
        ],
        { duration: 300, easing: 'ease-in-out' },
      );
    }
  };

  const inputGlassStyle = { background: 'rgb(var(--glass-tint) / 0.4)' };

  return (
    <div className="h-full flex flex-col">
      {/* 顶部工具栏 */}
      <div className="glass-frost p-4 space-y-3" style={{ borderRadius: 'var(--r-md)' }}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-1">
            <input
              id="timeline-new-event-input"
              type="text"
              value={newEventTitle}
              onChange={(e) => setNewEventTitle(e.target.value)}
              placeholder={
                extractCap
                  ? '输入关键词（如角色名）提取事件，或直接添加...'
                  : '输入事件标题，回车或点右侧 + 添加...'
              }
              className="glass-surface flex-1 px-3 py-1.5 text-sm rounded-[14px] outline-none"
              style={inputGlassStyle}
              onKeyDown={(e) => {
                // 无 AI 提取能力时回车回落为「直接添加」（否则又是无声死键）
                if (e.key === 'Enter') (extractCap ? handleExtract() : handleAddDirect());
              }}
            />
            <select
              value={newEventType}
              onChange={(e) => setNewEventType(e.target.value as TimelineEvent['type'])}
              className="glass-surface text-sm rounded-[14px] px-2 py-1.5 outline-none"
              style={inputGlassStyle}
            >
              {DEFAULT_EVENT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            {extractCap && (
              <button
                type="button"
                onClick={handleExtract}
                disabled={extracting}
                className="nm-btn-apple nm-btn-apple-primary text-sm shrink-0"
                title="从当前章节内容中提取相关事件"
              >
                {extracting ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                提取
              </button>
            )}
            <button
              type="button"
              onClick={handleAddDirect}
              className="nm-btn-apple nm-btn-apple-secondary text-sm shrink-0"
              title="直接添加事件（不经过 AI 提取）"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* 章节Tab切换 */}
        {chaptersWithEventsList.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
            <button
              type="button"
              onClick={() => setSelectedChapter('all')}
              className="shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 flex items-center gap-1.5"
              style={{
                background: selectedChapter === 'all'
                  ? 'hsl(var(--primary))'
                  : 'rgb(var(--glass-tint) / 0.4)',
                color: selectedChapter === 'all'
                  ? 'white'
                  : 'hsl(var(--muted-foreground))',
                boxShadow: selectedChapter === 'all'
                  ? '0 2px 8px hsl(var(--primary) / 0.3)'
                  : 'none',
              }}
            >
              <LayoutGrid size={12} />
              全部
            </button>
            {chaptersWithEventsList.map((ch) => {
              const accent = getChapterAccent(ch.order);
              const isActive = selectedChapter === ch.order;
              return (
                <button
                  key={ch.order}
                  type="button"
                  onClick={() => setSelectedChapter(ch.order)}
                  className="shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 flex items-center gap-1.5"
                  style={{
                    background: isActive ? accent : `${accent}15`,
                    color: isActive ? 'white' : accent,
                    boxShadow: isActive ? `0 2px 8px ${accent}50` : 'none',
                  }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: isActive ? 'white' : accent }}
                  />
                  第{ch.order}章
                  <span
                    className="text-[10px] opacity-70"
                    style={{ color: isActive ? 'white' : accent }}
                  >
                    {ch.count}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
            已记录 {filtered.length} 个事件
            {totalChapters > 0 ? ` · 覆盖 ${chaptersWithEvents} / ${totalChapters} 章` : ''}
            {currentChapter ? ` · 当前: 第${currentChapter.order}章` : ' · 未选择章节'}
          </span>
          {totalChapters > 0 && (
            <div
              className="flex-1 rounded-full overflow-hidden"
              style={{ height: '3px', background: 'rgb(var(--glass-tint) / 0.3)' }}
            >
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${progress * 100}%`, background: 'hsl(var(--primary))' }}
              />
            </div>
          )}
        </div>
      </div>

      {/* 流程图 */}
      <div className="flex-1 overflow-hidden">
        <TimelineFlowChart selectedChapter={selectedChapter} />
      </div>
    </div>
  );
}
