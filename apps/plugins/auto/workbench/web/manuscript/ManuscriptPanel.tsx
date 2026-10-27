// ============================================================
// auto 子插件 · manuscript —— 正文阅读（只读）
//
// 为什么要有这个面板：AI 长跑能把一章一章写出来落库，但界面上一直**看不到正文**
// —— 作者只能去翻数据库或用接口脚本，等于「生成了也读不着、质量问题发现不了」。
// 本面板把已落库的章节摆出来：左边章节目录、右边正文，顶部全书统计。
//
// ★ 定位是**只读**：编辑仍在手写台的编辑器里做（auto 模式不该长出第二套编辑器，
//   否则两处写同一章会互相覆盖）。这里只回答「写出来了吗 / 写得怎么样」。
//
// ★ 取数走 `chapters/projects/<projectId>`（apiClient 自动补 baseUrl 与 X-Project-Id；
//   用它而不是裸 fetch —— 裸 fetch 得自己补鉴权头与完整 URL，见 pipelineSession 的教训）。
//   路径形态**不是** `?projectId=`：写成 query 会 404，还会被容错逻辑静默吞成"0 章"。
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpenText, RefreshCw, Loader2, AlertTriangle } from 'lucide-react';
import { apiClient } from '@novel-plugins/data-core/api/apiClient';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import {
  MANUSCRIPT_API_ENTITY, chapterLabel, computeStats, extractChapterArray, sortChapters,
  type ManuscriptChapter,
} from './services/manuscriptData';

/** 正文栏的最大宽度：太宽一行太长、眼睛来回扫，读不下去（正文阅读的经验值） */
const READING_MAX_WIDTH = 680;

/** 千分位字数：长跑一部长篇动辄十万字，裸数字看不出量级 */
function fmtNum(n: number): string {
  return n.toLocaleString('zh-CN');
}

export function ManuscriptPanel({ projectId: projectIdProp }: { projectId?: string | null } = {}) {
  // ★ 宿主在插件浮窗场景传 projectId；工作台看板场景走面板实时 props。
  //   两种都要兜住：缺省时退回「当前项目」——面板不该因为少一个 prop 就空着。
  const currentProjectId = useCurrentProjectId();
  const projectId = projectIdProp ?? currentProjectId;

  const [raw, setRaw] = useState<ManuscriptChapter[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const chapters = useMemo(() => sortChapters(raw), [raw]);
  const stats = useMemo(() => computeStats(chapters), [chapters]);

  const load = useCallback(async () => {
    if (!projectId) { setRaw([]); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.get<unknown>(
        `${MANUSCRIPT_API_ENTITY}/projects/${encodeURIComponent(projectId)}`,
        undefined,
        // silent：面板自己渲染错误条，不再往全局弹一条重复的 toast
        { silent: true, timeoutMs: 30_000 },
      );
      setRaw(extractChapterArray(res));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRaw([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  /**
   * 当前选中章。
   * ★ 不存「选中了第几章」而存 id：刷新后仍能停在原来那章；若那章没了（被删/重排），
   *   自动回落到第一章 —— 既不报错也不跳到一个不存在的章。
   */
  const selected = useMemo(
    () => chapters.find((c) => c.id === selectedId) ?? chapters[0] ?? null,
    [chapters, selectedId],
  );

  // ---- 无项目：宿主还没选书 ----
  if (!projectId) {
    return (
      <div className="h-full flex items-center justify-center text-[11px] px-6 text-center"
        style={{ color: 'hsl(var(--muted-foreground))' }} data-panel="manuscript">
        先在左上角选一本书，这里才会显示它写出来的正文。
      </div>
    );
  }

  const header = (
    <div className="flex items-center gap-2 flex-wrap">
      <BookOpenText size={14} style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />
      <span className="text-[11px] font-medium" style={{ color: 'hsl(var(--foreground))' }}>正文阅读</span>
      {stats.count > 0 && (
        <span className="text-[10px] text-muted-foreground" data-stat="summary">
          共 {stats.count} 章 · 总 {fmtNum(stats.totalWords)} 字 · 平均 {fmtNum(stats.avgWords)} 字/章
        </span>
      )}
      <button
        type="button"
        onClick={() => void load()}
        disabled={loading}
        aria-label="刷新章节"
        className="ml-auto flex items-center gap-1 text-[10px] px-2 py-0.5 rounded"
        style={{
          background: 'transparent',
          borderWidth: '0.5px',
          borderStyle: 'solid',
          borderColor: 'hsl(var(--border))',
          color: 'hsl(var(--muted-foreground))',
          cursor: loading ? 'default' : 'pointer',
        }}
      >
        {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
        刷新
      </button>
    </div>
  );

  const errorBar = error && (
    <div className="text-[10.5px] rounded-lg px-3 py-2 flex items-start gap-1.5"
      style={{ background: 'hsl(var(--destructive) / 0.08)', color: 'hsl(var(--destructive))' }}>
      <AlertTriangle size={12} className="shrink-0" style={{ marginTop: 'var(--space-0)' }} aria-hidden="true" />
      <span className="min-w-0">读取章节失败：{error}</span>
    </div>
  );

  // ---- 空态：没有章节（这是最该把话说清楚的一屏）----
  if (chapters.length === 0) {
    return (
      <div className="h-full flex flex-col gap-2.5 p-3" data-panel="manuscript">
        {header}
        {errorBar}
        {!error && (
          <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-center px-6">
            <BookOpenText size={22} style={{ color: 'hsl(var(--muted-foreground) / 0.5)' }} aria-hidden="true" />
            <div className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>
              这本书还没有章节
            </div>
            <div className="text-[10px] leading-[1.7]" style={{ color: 'hsl(var(--muted-foreground))' }}>
              去「流水线」面板跑到长跑（试写 / 长跑），写出来的章会一章一章出现在这里。
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" data-panel="manuscript">
      {/* ── 头部：面板名 + 全书统计 + 刷新 ── */}
      <div className="shrink-0 px-3 pt-3 pb-3 flex flex-col gap-3"
        style={{ borderBottom: '0.5px solid hsl(var(--border) / 0.5)' }}>
        {header}
        {errorBar}
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* ── 左：章节目录（按 order 排，点一下切章）── */}
        <nav
          className="shrink-0 overflow-y-auto py-1.5"
          style={{ width: 196, borderRight: '0.5px solid hsl(var(--border) / 0.5)' }}
          aria-label="章节目录"
        >
          {chapters.map((c) => {
            const on = c.id === selected?.id;
            const words = c.wordCount > 0 ? c.wordCount : 0;
            return (
              <button
                key={c.id}
                type="button"
                data-chapter-order={c.order}
                aria-current={on ? 'true' : undefined}
                onClick={() => setSelectedId(c.id)}
                className="w-full text-left px-2.5 py-1.5 flex flex-col gap-0.5"
                style={{
                  background: on ? 'hsl(var(--primary) / 0.10)' : 'transparent',
                  borderLeft: `2px solid ${on ? 'hsl(var(--primary))' : 'transparent'}`,
                  cursor: 'pointer',
                }}
              >
                <span className="flex items-baseline gap-1.5 min-w-0">
                  <span className="shrink-0 text-[10px] tabular-nums"
                    style={{ color: on ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }}>
                    {chapterLabel(c.order)}
                  </span>
                  {words > 0 && (
                    <span className="ml-auto shrink-0 text-[9.5px] tabular-nums"
                      style={{ color: 'hsl(var(--muted-foreground))' }}>
                      {fmtNum(words)}字
                    </span>
                  )}
                </span>
                <span className="text-[10px] truncate"
                  style={{ color: on ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))' }}>
                  {c.title || '（无标题）'}
                </span>
              </button>
            );
          })}
        </nav>

        {/* ── 右：正文（只读，自己滚）── */}
        <section className="flex-1 min-h-0 overflow-y-auto" aria-label="正文">
          {selected ? (
            <div className="mx-auto px-6 py-5" style={{ maxWidth: READING_MAX_WIDTH }}>
              <h2 className="text-[12px] font-semibold"
                style={{ color: 'hsl(var(--foreground))', fontFamily: "'Noto Serif SC', serif" }}>
                {chapterLabel(selected.order)}　{selected.title || '（无标题）'}
              </h2>
              <div className="mt-1 text-[10px] text-muted-foreground" data-selected-words>
                {fmtNum(selected.wordCount > 0 ? selected.wordCount : selected.content.replace(/\s/g, '').length)} 字
                {selected.status ? ` · ${selected.status}` : ''}
              </div>
              {selected.content?.trim() ? (
                // whitespace-pre-wrap：正文里作者/模型自己带的空行与缩进必须原样保留
                // （这是读小说的排版，不是代码块，所以用 pre-wrap 而不是 pre）
                <div
                  className="mt-3 text-[11.5px] whitespace-pre-wrap break-words leading-relaxed"
                  style={{ color: 'hsl(var(--foreground) / 0.92)' }}
                >
                  {selected.content}
                </div>
              ) : (
                <p className="mt-3 text-[10.5px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  这一章还没正文（只有章节条目）—— 长跑交付后才会有内容。
                </p>
              )}
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-[10.5px]"
              style={{ color: 'hsl(var(--muted-foreground))' }}>
              从左边选一章开始读。
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default ManuscriptPanel;
