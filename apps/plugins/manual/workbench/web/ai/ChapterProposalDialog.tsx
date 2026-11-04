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
// ## ★ 2026-11-04：确认后改为**流式流入**正文（作者口径「先定稿再流入」）
//   生成阶段仍然一个字都不写正文（上面的三道防线不变）；作者点「确认」= 定稿，
//   **定稿之后**才把内容**分块**写进正文，编辑器里能看到字一段段长出来。
//
//   为什么不逐字：`useEntitySync` 订阅 store，**每次变化都会 PUT 一次**（无节流）。
//   逐字写 = 上千次 PUT。这里按「约 20 块 × 140ms」推进 —— 一段 3000 字的章节
//   约 2.8 秒流完，约 20 次写入，视觉上已经是"字在长"。
//
//   可中途停止：已写入的部分**保留**（它们已经进 store 并会被持久化），
//   不会回滚 —— 因为正文是作者的作品，突然整段消失比"写了一半"更糟。
//
// ## 为什么不复用 OutlineFillDialog
//   那个是「把 AI 输出填进大纲文本框」，目标是 localStorage 里的 store；
//   本组件写的是**章节正文**（走 HTTP PUT，有版本与软删联动），
//   数据路径与风险级别都不同，混在一起会让两条安全模型纠缠。

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import { plainTextToHtml, htmlToText } from '@novel-plugins/data-core';
import { useChapterStore } from '@novel-plugins/data-core/stores';
import { publishExternalChapterContent } from '../editor/externalContent';

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

  /** 流式写入的计时器；组件卸载时要清掉，否则会继续往已关闭的对话框写 */
  const timerRef = useRef<number | null>(null);
  /** 作者点了「停止」——下一块不再排期，已写入的部分保留 */
  const stoppedRef = useRef(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  // ★ 提前返回必须放在**所有 hook 之后**：否则 proposal 从 null 变成非 null 时
  //   hook 数量会变化，React 抛 "Rendered more hooks than during the previous render"。
  if (!proposal) return null;

  /**
   * 写入第 index 块，然后排队下一块（除非已到底或被停止）。
   *
   * ★ 必须走 **store 的 updateChapter**，不能直接调 data-core 的
   *   `updateChapter`（那个是裸 HTTP PUT）。
   *   实测踩过的坑：直接 PUT 时后端确实写进去了，但 store 里仍是旧正文，
   *   随后 `useEntitySync` 检测到「store 与上次不同」→ 把**旧值**再 PUT 一遍，
   *   于是刚写进去的正文被**覆盖回旧内容**（正文长度 299 → 18）。
   *
   * 每一块都重新拼 HTML：`plainTextToHtml(partial)` 而不是在 HTML 字符串里切，
   * 否则会切在标签中间，渲染出半截 `<p>`。
   */
  const writeChunk = (chunks: string[], index: number) => {
    const partial = chunks.slice(0, index + 1).join('');
    const html = plainTextToHtml(partial);
    const nextHtml = proposal.mode === 'append' ? appendHtml(baseContent, html) : html;
    // `wordCount` 必须一并写：`chapter-service.updateChapter` 只在它非空时才同步
    // 项目总字数，不会自己按 content 重算。
    const wordCount = htmlToText(nextHtml).replace(/\s/g, '').length;

    useChapterStore.getState().updateChapter(proposal.chapterId, {
      content: nextHtml,
      wordCount,
      updatedAt: Date.now(),
    });
    // store 变了，但打开着的编辑器只在切章时同步 —— 显式告诉它一声，
    // 作者才看得到正文"一段段长出来"。见 ../editor/externalContent.ts。
    publishExternalChapterContent({ chapterId: proposal.chapterId, content: nextHtml });
    setProgress({ done: index + 1, total: chunks.length });

    if (index + 1 < chunks.length && !stoppedRef.current) {
      timerRef.current = window.setTimeout(() => writeChunk(chunks, index + 1), STREAM_STEP_MS);
      return;
    }

    timerRef.current = null;
    setBusy(false);
    onApplied({ title: proposal.chapterTitle, wordCount });
    onClose();
  };

  const handleApply = () => {
    const text = draft.trim();
    if (!text) {
      setErr('正文为空，无法写入。');
      return;
    }
    setBusy(true);
    setErr('');
    stoppedRef.current = false;
    const chunks = splitIntoStreamChunks(text);
    setProgress({ done: 0, total: chunks.length });
    writeChunk(chunks, 0);
  };

  /**
   * 停止：**立刻**停，不等已排队的那一块。
   * 已写入的部分保留（它们已经进 store、会被持久化），字数取 store 里的当前值。
   */
  const handleStop = () => {
    stoppedRef.current = true;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const current = useChapterStore.getState().chapters.find((c) => c.id === proposal.chapterId);
    setBusy(false);
    onApplied({ title: proposal.chapterTitle, wordCount: current?.wordCount ?? 0 });
    onClose();
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
            {busy
              ? `正在流入正文 ${progress.done}/${progress.total} · 停止后已写部分保留`
              : '不确认则正文保持不变'}
          </span>
          {busy ? (
            <button
              type="button"
              onClick={handleStop}
              className="ml-auto rounded-chip border px-3 py-1.5 text-[11px] transition-colors"
              style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="ml-auto rounded-chip border px-3 py-1.5 text-[11px] transition-colors"
              style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
            >
              放弃
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleApply()}
            disabled={busy || draft.trim().length === 0}
            className="rounded-chip px-3 py-1.5 text-[11px] font-medium text-white transition-opacity disabled:opacity-40"
            style={{ background: isReplace ? 'hsl(var(--destructive))' : 'hsl(var(--primary))' }}
          >
            {busy ? '流入中…' : isReplace ? '确认替换' : '确认追加'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 流式写入节奏：约 20 块 × 140ms ≈ 2.8s 流完一章（再快就看不清"在长"） */
const STREAM_MAX_CHUNKS = 20;
const STREAM_STEP_MS = 140;
/** 块的最小目标长度：短提案也要有流动感，但不能切得太碎 */
const STREAM_MIN_CHUNK = 12;

/**
 * 把定稿正文切成流式块。
 *
 * 按**句读**切（。！？!?；;… 与换行）再合并到目标尺寸 —— 不按定长切：
 * 定长会把一句话从中间劈开，看起来像卡顿而不是书写。
 * 没有标点的超长段落（常见于对话密集的段落）再由下面的 while 兜底硬切。
 */
function splitIntoStreamChunks(text: string): string[] {
  const target = Math.max(STREAM_MIN_CHUNK, Math.ceil(text.length / STREAM_MAX_CHUNKS));
  const units = text.split(/(?<=[。！？!?；;…\n])/).filter((s) => s.length > 0);
  const chunks: string[] = [];
  let buf = '';
  for (const u of units) {
    if (buf && buf.length + u.length > target) {
      chunks.push(buf);
      buf = u;
    } else {
      buf += u;
    }
    while (buf.length > target * 2) {
      chunks.push(buf.slice(0, target));
      buf = buf.slice(target);
    }
  }
  if (buf) chunks.push(buf);
  // 全篇没有可切点时只有一块 —— 那时"流式"没有意义，直接一次写完
  return chunks.length > 1 ? chunks : [text];
}

/** 追加：把新 HTML 拼到旧 HTML 后面（旧内容为空则直接返回新内容） */
function appendHtml(base: string, add: string): string {
  const b = (base ?? '').trim();
  if (!b) return add;
  return `${b}\n${add}`;
}
