// ============================================================
// 章节修改提案确认框 —— AI 想改正文时，作者必须逐次点确认
// ============================================================
//
// ## 为什么需要这个组件
//   AI 改正文的风险远高于改一个角色字段：一次误判就是整章报废
//   （本项目实测过 3333 字全废）。所以服务端的 `propose_chapter_edit`
//   工具**不写库**，只把「AI 想怎么写」交到这里；作者点「确认写入」后，
//   才由**前端**调 `updateChapter` 落库。
//
// ## 三道防线（缺一不可）
//   1. **服务端零写入** —— 工具 handler 里没有 updateChapter（见
//      `apps/server/src/ai/tools/chapter-proposal-tools.ts`）。
//   2. **这个确认框** —— 没有「一键全同意」，每条提案独立确认。
//   3. **写入前显示影响面** —— 「N 字 → M 字」+ 内容预览，作者按确认前就知道
//      会变成什么样。
//
// ## 为什么不复用 OutlineFillDialog
//   那个是「把 AI 输出填进大纲文本框」，目标是 localStorage 里的 store；
//   本组件写的是**章节正文**（走 HTTP PUT，有版本与软删联动），
//   数据路径与风险级别都不同，混在一起会让两条安全模型纠缠。

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import { plainTextToHtml, htmlToText } from '@novel-plugins/data-core';
import { useChapterStore } from '@novel-plugins/data-core/stores';

/** 服务端 `propose_chapter_edit` 的 payload 形状（见 registry 的 ToolHandlerResult.entity） */
export interface ChapterProposal {
  chapterId: string;
  chapterTitle: string;
  chapterOrder: number;
  mode: 'append' | 'replace';
  content: string;
  reason: string;
  currentChars: number;
  nextChars: number;
}

/** 从 `{tool_result}` 帧里安全取出提案（形状不对就返回 null，绝不抛） */
export function readChapterProposal(value: unknown): ChapterProposal | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const entity = o.entity;
  if (!entity || typeof entity !== 'object') return null;
  const e = entity as Record<string, unknown>;
  if (e.type !== 'chapter' || e.action !== 'propose') return null;
  const p = e.payload;
  if (!p || typeof p !== 'object') return null;
  const payload = p as Record<string, unknown>;
  if (typeof payload.chapterId !== 'string' || typeof payload.content !== 'string') return null;
  const mode = payload.mode === 'replace' ? 'replace' : 'append';
  return {
    chapterId: payload.chapterId,
    chapterTitle: typeof payload.chapterTitle === 'string' ? payload.chapterTitle : '（未命名）',
    chapterOrder: typeof payload.chapterOrder === 'number' ? payload.chapterOrder : 0,
    mode,
    content: payload.content,
    reason: typeof payload.reason === 'string' ? payload.reason : '',
    currentChars: typeof payload.currentChars === 'number' ? payload.currentChars : 0,
    nextChars: typeof payload.nextChars === 'number' ? payload.nextChars : 0,
  };
}

export function ChapterProposalDialog({
  proposal,
  baseContent,
  onClose,
  onApplied,
}: {
  proposal: ChapterProposal | null;
  /**
   * 目标章节的**当前正文**（HTML）。追加模式必须靠它拼接 —— 不能只凭字数估算。
   * 调用方在打开对话框前从 store 里取（`useChapterStore` 的 chapters 里就有）。
   */
  baseContent: string;
  onClose: () => void;
  /** 写入成功后回调（携带新的字数），供调用方刷新 store / 提示 */
  onApplied: (result: { title: string; wordCount: number }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /** 作者可编辑提案正文 —— 「确认」不等于「原样接受」 */
  const [draft, setDraft] = useState('');

  useEffect(() => {
    setDraft(proposal?.content ?? '');
    setErr('');
    setBusy(false);
  }, [proposal]);

  const preview = useMemo(() => {
    const text = draft.trim();
    if (!text) return '（空）';
    return text.length > 600 ? `${text.slice(0, 600)}\n\n…（共 ${text.length} 字）` : text;
  }, [draft]);

  if (!proposal) return null;

  const handleApply = async () => {
    const text = draft.trim();
    if (!text) {
      setErr('正文为空，无法写入。');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      // 追加：新内容拼到**当前正文**（baseContent）后面；覆盖：直接替换。
      // ★ 两种模式都要转 HTML —— 章节正文列存的是 HTML（编辑器按 <p> 渲染），
      //   直接塞纯文本会被当成一个段落，换行全丢。
      const html = plainTextToHtml(text);
      const nextHtml = proposal.mode === 'append' ? appendHtml(baseContent, html) : html;
      const nextWordCount = htmlToText(nextHtml).replace(/\s/g, '').length;

      /**
       * ★ 必须走 **store 的 updateChapter**，不能直接调 data-core 的
       *   `updateChapter`（那个是裸 HTTP PUT）。
       *
       *   实测踩过的坑：直接 PUT 时后端确实写进去了，但 store 里仍是旧正文，
       *   随后 `useEntitySync` 检测到「store 与上次不同」→ 把**旧值**再 PUT 一遍，
       *   于是刚写进去的正文被**覆盖回旧内容**（正文长度 299 → 18）。
       *
       *   走 store 则顺序正确：store 先变 → sync 层看到变化 → 持久化新值。
       *   同时 `wordCount` 一并写进 store：`chapter-service.updateChapter` 只在
       *   `wordCount !== undefined` 时才同步项目总字数，它不会自己按 content 重算。
       */
      useChapterStore.getState().updateChapter(proposal.chapterId, {
        content: nextHtml,
        wordCount: nextWordCount,
        updatedAt: Date.now(),
      });
      onApplied({ title: proposal.chapterTitle, wordCount: nextWordCount });
      onClose();
    } catch (e) {
      setErr(`写入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const isReplace = proposal.mode === 'replace';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="章节修改提案确认"
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.35)' }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-[620px] flex-col overflow-hidden rounded-window border shadow-xl"
        style={{ background: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
      >
        {/* 标题条 */}
        <div className="flex shrink-0 items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid hsl(var(--border))' }}>
          {isReplace ? (
            <AlertTriangle size={14} style={{ color: 'hsl(var(--destructive))' }} aria-hidden="true" />
          ) : (
            <Check size={14} style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />
          )}
          <span className="text-[12px] font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
            AI 想{isReplace ? '替换' : '追加'}第 {proposal.chapterOrder} 章「{proposal.chapterTitle}」
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
            className="ml-auto rounded-chip p-1 transition-colors disabled:opacity-40"
            style={{ color: 'hsl(var(--muted-foreground))' }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>

        {/* 影响面 */}
        <div className="shrink-0 px-4 py-2 text-[11px]" style={{ background: 'hsl(var(--muted) / 0.4)', color: 'hsl(var(--muted-foreground))' }}>
          <div className="mc-num">
            字数 <b style={{ color: 'hsl(var(--foreground))' }}>{proposal.currentChars}</b>
            {' → '}
            <b style={{ color: isReplace ? 'hsl(var(--destructive))' : 'hsl(var(--foreground))' }}>
              {isReplace ? draft.trim().length : proposal.currentChars + draft.trim().length}
            </b>
            {isReplace ? '（整章覆盖，原正文将被替换）' : '（追加到末尾，原正文保留）'}
          </div>
          {proposal.reason && <div className="mt-1">AI 说明：{proposal.reason}</div>}
        </div>

        {/* 正文：可编辑 */}
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-4 py-3">
          <span className="shrink-0 text-[10.5px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
            提案正文（可直接改，改完再确认）
          </span>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            aria-label="提案正文"
            className="min-h-[160px] flex-1 resize-none rounded-md border p-2 font-[Inter,sans-serif] text-[11.5px] leading-[1.7] outline-none"
            style={{
              background: 'hsl(var(--background))',
              borderColor: 'hsl(var(--border))',
              color: 'hsl(var(--foreground))',
            }}
          />
          {preview && preview !== draft.trim() && (
            <span className="shrink-0 text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
              预览：{preview.split('\n')[0]}…
            </span>
          )}
          {err && (
            <div role="alert" className="shrink-0 text-[10.5px]" style={{ color: 'hsl(var(--destructive))' }}>
              {err}
            </div>
          )}
        </div>

        {/* 动作 */}
        <div className="flex shrink-0 items-center gap-2 px-4 py-3" style={{ borderTop: '1px solid hsl(var(--border))' }}>
          <span className="text-[10.5px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
            不确认则正文保持不变
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="ml-auto rounded-chip border px-3 py-1.5 text-[11px] transition-colors disabled:opacity-40"
            style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
          >
            放弃
          </button>
          <button
            type="button"
            onClick={() => void handleApply()}
            disabled={busy || draft.trim().length === 0}
            className="rounded-chip px-3 py-1.5 text-[11px] font-medium text-white transition-opacity disabled:opacity-40"
            style={{ background: isReplace ? 'hsl(var(--destructive))' : 'hsl(var(--primary))' }}
          >
            {busy ? '写入中…' : isReplace ? '确认替换' : '确认追加'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 追加：把新 HTML 拼到旧 HTML 后面（旧内容为空则直接返回新内容） */
function appendHtml(base: string, add: string): string {
  const b = (base ?? '').trim();
  if (!b) return add;
  return `${b}\n${add}`;
}
