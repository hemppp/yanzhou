// ============================================================
// 讨论回看（Discussion Timeline）
//
// 动机（2026-10-25，用户提问「剧情经过团队讨论了吗」逼出来的）：
//   流水线每一段（cast / bible / plot / beats / pilot）都是**多智能体讨论**产出的 ——
//   主笔先发言 → 其余角色依次质疑/补充 → 主笔正面回应一轮 → 定稿官收敛。
//   但这个过程**只在实时 SSE 里出现过**：脚本（run-novel.mjs）跑的书从头到尾没人看见，
//   GUI 跑完也就没了。用户能拿到的只有 872 字的闸门摘要，看不到"谁说了什么、怎么被反驳"。
//
//   发言其实**早就落库**（agent_memory 的 `exp.stage.<段>.turn<N>` / `exp.ch<N>.turn<M>`），
//   缺的只是一个读的出口。本面板就是那个出口：选一段（或一章），按时间顺序读全部发言。
//
// 与交流流（AutoWriteWorkbench 左栏）的区别：那个是**实时**看，本面板是**事后**回看；
//   两者同源（后端 turn 事件与这里的落库是同一次发言）。
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { Loader2, MessagesSquare, RefreshCw } from 'lucide-react';
import { apiClient } from '@novel-plugins/data-core/api/apiClient';
import { fetchDiscussion, type DiscussionTurn } from './services/discussionSession';

interface StageRow { key: string; label: string; status: string }

const INK_MUTED = 'hsl(var(--muted-foreground))';

export function DiscussionTimelinePanel({ projectId }: { projectId?: string | null }) {
  const [stages, setStages] = useState<StageRow[]>([]);
  /** 选中的来源：段 或 章（二选一） */
  const [stage, setStage] = useState<string | null>(null);
  const [chapter, setChapter] = useState<number | null>(null);
  const [turns, setTurns] = useState<DiscussionTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 拉段列表（顺带拿到服务端的段中文名 —— 不在前端另抄一份，避免段列表漂移） */
  const loadStages = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await apiClient.get<unknown>('plugins/autowrite/pipeline');
      const data = (res as { data?: unknown })?.data ?? res;
      const view = (data as { view?: { stages?: StageRow[] } })?.view ?? (data as { stages?: StageRow[] });
      const list = (view?.stages ?? []).filter((s) => s?.key);
      setStages(list);
      // 默认停在「剧情总纲」——用户问"剧情讨论了吗"，这是最常要看的那一段
      setStage((cur) => cur ?? (list.find((s) => s.key === 'plot')?.key ?? list[0]?.key ?? null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  const load = useCallback(async (sel: { stage?: string | null; chapter?: number | null }) => {
    if (!projectId) return;
    const q = sel.chapter != null ? { chapter: sel.chapter } : sel.stage ? { stage: sel.stage } : null;
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const v = await fetchDiscussion(q);
      setTurns(v.turns ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTurns([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadStages(); }, [loadStages]);
  useEffect(() => {
    if (stage || chapter != null) void load({ stage, chapter });
  }, [stage, chapter, load]);

  if (!projectId) {
    return (
      <div className="p-6 text-[12px]" style={{ color: INK_MUTED }}>
        未加载项目 —— 讨论回看需要一个项目上下文。
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col gap-3">
      {/* 顶部条：说明 + 来源选择 + 刷新 */}
      <div
        className="shrink-0 rounded-lg px-3 py-2 flex items-center gap-2 flex-wrap"
        style={{ background: 'hsl(var(--card) / 0.6)', border: '0.5px solid hsl(var(--border) / 0.6)' }}
      >
        <MessagesSquare size={14} style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />
        <span className="text-[11.5px]" style={{ color: 'hsl(var(--foreground))' }}>讨论回看</span>
        <span className="text-[10.5px]" style={{ color: INK_MUTED }}>
          这段剧情是谁、怎么讨论出来的 · 按发生顺序
        </span>
        <button
          type="button"
          onClick={() => void load({ stage, chapter })}
          aria-label="刷新"
          className="ml-auto flex items-center gap-1 text-[10.5px] px-2 py-0.5 rounded"
          style={{ background: 'transparent', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'hsl(var(--border))', color: INK_MUTED, cursor: 'pointer' }}
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          刷新
        </button>
      </div>

      {/* 来源选择：段（服务端给的列表） + 章（手输） */}
      <div className="shrink-0 flex items-center gap-1.5 flex-wrap">
        {stages.map((s) => {
          const on = chapter == null && stage === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => { setChapter(null); setStage(s.key); }}
              className="text-[10.5px] px-2 py-0.5 rounded"
              style={{
                background: on ? 'hsl(var(--primary) / 0.14)' : 'transparent',
                borderWidth: '0.5px', borderStyle: 'solid',
                borderColor: on ? 'hsl(var(--primary) / 0.5)' : 'hsl(var(--border) / 0.7)',
                color: on ? 'hsl(var(--foreground))' : INK_MUTED,
                cursor: 'pointer',
              }}
            >
              {s.label || s.key}
            </button>
          );
        })}
        <span className="text-[10.5px] ml-1" style={{ color: INK_MUTED }}>或章号</span>
        <input
          type="number" min={1}
          value={chapter ?? ''}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (!v) { setChapter(null); return; }
            setChapter(Math.max(1, Number(v) || 1));
          }}
          className="text-[10.5px] px-1.5 py-0.5 rounded"
          style={{ width: 52, background: 'hsl(var(--card) / 0.6)', border: '0.5px solid hsl(var(--border) / 0.7)', color: 'hsl(var(--foreground))' }}
          aria-label="章号"
        />
      </div>

      {error && (
        <div className="text-[11px] px-1" style={{ color: 'hsl(var(--state-blocked))' }}>读取失败：{error}</div>
      )}

      {/* 时间线 */}
      <div className="flex-1 overflow-auto pr-1">
        {!loading && turns.length === 0 && !error && (
          <div className="text-[11px] px-1 py-4" style={{ color: INK_MUTED }}>
            这里还没有发言 ——
            这一段（或这一章）可能还没跑过讨论。跑过之后再回来看，就能读到每个角色说了什么。
          </div>
        )}
        <ol className="flex flex-col gap-2.5">
          {turns.map((t) => (
            <li key={`${t.turn}-${t.agent}`} className="flex gap-2">
              {/* 头像字（角色配色由后端给出，与交流流同一套） */}
              <span
                className="shrink-0 rounded-full flex items-center justify-center text-[11px] font-medium"
                style={{ width: 22, height: 22, background: `${t.color}22`, color: t.color, border: `0.5px solid ${t.color}66` }}
                aria-hidden="true"
              >
                {t.short}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11.5px] font-medium" style={{ color: 'hsl(var(--foreground))' }}>{t.name}</span>
                  <span className="text-[10px]" style={{ color: INK_MUTED }}>第 {t.turn} 位发言</span>
                </div>
                <div
                  className="text-[11.5px] whitespace-pre-wrap break-words mt-0.5"
                  style={{ color: 'hsl(var(--foreground) / 0.92)', lineHeight: 1.62 }}
                >
                  {t.text}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
