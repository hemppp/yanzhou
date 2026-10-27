import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Editor } from '@tiptap/react';
import { X, ChevronUp, ChevronDown, Replace, Check, Search } from 'lucide-react';

interface FindReplaceBarProps {
  editor: Editor | null;
  visible: boolean;
  onClose: () => void;
}

interface MatchRange {
  from: number;
  to: number;
}

/**
 * 查找替换浮层
 * - Ctrl+F 唤起 / Esc 关闭
 * - 高亮所有匹配（用 highlight mark）
 * - 上一个 / 下一个 / 替换 / 全部替换
 *
 * 实现说明：
 *  - 用 editor.state.doc.textBetween 扫描全文，得到 [from, to] 区间数组
 *  - 跳转：editor.commands.setTextSelection
 *  - 替换：editor.commands.deleteRange + insertContentAt
 *  - 高亮：用 Highlight(multicolor) 给匹配位置加 mark，使用专门颜色避免和正文 mark 冲突
 */
export function FindReplaceBar({ editor, visible, onClose }: FindReplaceBarProps) {
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [matches, setMatches] = useState<MatchRange[]>([]);
  const [showReplace, setShowReplace] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);
  // 用于在替换后避免 onUpdate 触发重新搜索导致索引错乱
  const isReplacingRef = useRef(false);

  // 全文扫描匹配
  const computeMatches = useCallback(() => {
    if (!editor || !findText) {
      setMatches([]);
      setCurrentIndex(0);
      return;
    }
    const ranges: MatchRange[] = [];
    const doc = editor.state.doc;
    doc.descendants((node, pos) => {
      if (!node.isText) return true;
      const text = node.text ?? '';
      if (!text) return false;
      const needle = caseSensitive ? findText : findText.toLowerCase();
      const hay = caseSensitive ? text : text.toLowerCase();
      let i = 0;
      while (i <= hay.length - needle.length) {
        const idx = hay.indexOf(needle, i);
        if (idx === -1) break;
        const from = pos + idx;
        const to = from + needle.length;
        if (wholeWord) {
          const before = idx === 0 ? '' : text[idx - 1];
          const after = idx + needle.length >= text.length ? '' : text[idx + needle.length];
          const isWordChar = (c: string) => /\w/.test(c);
          if ((before && isWordChar(before)) || (after && isWordChar(after))) {
            i = idx + 1;
            continue;
          }
        }
        ranges.push({ from, to });
        i = idx + needle.length;
      }
      return false;
    });
    setMatches(ranges);
    setCurrentIndex(ranges.length > 0 ? 0 : 0);
  }, [editor, findText, caseSensitive, wholeWord]);

  // 搜索词变化时重新计算
  useEffect(() => {
    if (!visible) return;
    computeMatches();
  }, [visible, findText, caseSensitive, wholeWord, computeMatches]);

  // 文档变化时重新计算（但替换过程中跳过）
  useEffect(() => {
    if (!editor || !visible) return;
    const handler = () => {
      if (isReplacingRef.current) return;
      computeMatches();
    };
    editor.on('update', handler);
    return () => { editor.off('update', handler); };
  }, [editor, visible, computeMatches]);

  // 可见时自动聚焦
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => findInputRef.current?.focus());
    } else {
      // 关闭时清除高亮
      setFindText('');
      setMatches([]);
      setCurrentIndex(0);
    }
  }, [visible]);

  // 跳转到指定匹配并高亮
  const jumpTo = useCallback((idx: number) => {
    if (!editor || matches.length === 0) return;
    const safeIdx = ((idx % matches.length) + matches.length) % matches.length;
    const range = matches[safeIdx];
    if (!range) return;
    setCurrentIndex(safeIdx);
    editor.commands.setTextSelection({ from: range.from, to: range.to });
    editor.commands.scrollIntoView();
  }, [editor, matches]);

  const goPrev = useCallback(() => jumpTo(currentIndex - 1), [jumpTo, currentIndex]);
  const goNext = useCallback(() => jumpTo(currentIndex + 1), [jumpTo, currentIndex]);

  // 替换当前匹配
  const replaceOne = useCallback(() => {
    if (!editor || matches.length === 0 || !findText) return;
    const range = matches[currentIndex];
    if (!range) return;
    isReplacingRef.current = true;
    editor
      .chain()
      .focus()
      .setTextSelection({ from: range.from, to: range.to })
      .deleteRange({ from: range.from, to: range.to })
      .insertContentAt(range.from, replaceText)
      .run();
    isReplacingRef.current = false;
    // 替换后重新计算并跳到下一个
    requestAnimationFrame(() => {
      computeMatches();
      requestAnimationFrame(() => {
        // 替换后位置可能变化，跳到同位置的新匹配
        const newIdx = Math.min(currentIndex, Math.max(0, matches.length - 1));
        jumpTo(newIdx);
      });
    });
  }, [editor, matches, currentIndex, findText, replaceText, computeMatches, jumpTo]);

  // 全部替换
  const replaceAll = useCallback(() => {
    if (!editor || matches.length === 0 || !findText) return;
    isReplacingRef.current = true;
    // 从后往前替换，避免位置偏移
    const sorted = [...matches].sort((a, b) => b.from - a.from);
    editor.chain().focus();
    for (const range of sorted) {
      editor
        .chain()
        .setTextSelection({ from: range.from, to: range.to })
        .deleteRange({ from: range.from, to: range.to })
        .insertContentAt(range.from, replaceText)
        .run();
    }
    isReplacingRef.current = false;
    setMatches([]);
    setCurrentIndex(0);
    requestAnimationFrame(() => {
      computeMatches();
    });
  }, [editor, matches, findText, replaceText, computeMatches]);

  // 键盘快捷
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    }
  }, [onClose, goPrev, goNext]);

  // 匹配数显示
  const matchCount = useMemo(() => {
    if (!findText) return null;
    if (matches.length === 0) return '0 / 0';
    return `${currentIndex + 1} / ${matches.length}`;
  }, [findText, matches, currentIndex]);

  if (!visible) return null;

  return (
    <div
      className="absolute z-50 top-2 right-3 w-[420px] max-w-[calc(100vw-24px)] rounded-xl overflow-hidden"
      style={{
        background: 'rgb(var(--glass-tint) / 0.85)',
        backdropFilter: 'blur(24px) saturate(180%)',
        WebkitBackdropFilter: 'blur(24px) saturate(180%)',
        border: '0.5px solid hsl(var(--mountain-cyan) / 0.35)',
        boxShadow: '0 12px 40px rgba(31, 38, 80, 0.18), 0 2px 8px rgba(31, 38, 80, 0.08), inset 0 1px 0 rgb(var(--glass-highlight) / 0.6)',
      }}
      role="dialog"
      aria-label="查找替换"
    >
      {/* 查找行 */}
      <div className="flex items-center gap-1.5 px-3 py-2">
        <Search size={13} style={{ color: 'hsl(var(--ink-pale))' }} aria-hidden="true" />
        <input
          ref={findInputRef}
          type="text"
          value={findText}
          onChange={(e) => setFindText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="查找…"
          className="flex-1 min-w-0 px-1.5 py-1 text-[11px] outline-none rounded-[14px]"
          style={{
            color: 'hsl(var(--foreground))',
            background: 'rgb(var(--glass-tint) / 0.5)',
            border: '0.5px solid hsl(var(--border) / 0.5)',
          }}
          aria-label="查找内容"
        />
        {matchCount && (
          <span className="text-[10px] tabular-nums px-1.5 shrink-0" style={{ color: 'hsl(var(--ink-pale))' }}>
            {matchCount}
          </span>
        )}
        <button
          onClick={() => setShowReplace(!showReplace)}
          className="shrink-0 p-1 rounded-xl transition-colors hover:bg-[hsl(var(--mist-pale) / 0.6)]"
          style={{ color: 'hsl(var(--ink-light))' }}
          title={showReplace ? '收起替换' : '展开替换'}
          aria-label={showReplace ? '收起替换' : '展开替换'}
          aria-pressed={showReplace}
        >
          <ChevronDown size={13} style={{ transform: showReplace ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </button>
        <button
          onClick={onClose}
          className="shrink-0 p-1 rounded-xl transition-colors hover:bg-[hsl(var(--mist-pale) / 0.6)]"
          style={{ color: 'hsl(var(--ink-light))' }}
          title="关闭（Esc）"
          aria-label="关闭"
        >
          <X size={13} />
        </button>
      </div>

      {/* 替换行 */}
      {showReplace && (
        <div className="flex items-center gap-1.5 px-3 pb-2">
          <Replace size={13} style={{ color: 'hsl(var(--ink-pale))' }} aria-hidden="true" />
          <input
            type="text"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="替换为…"
            className="flex-1 min-w-0 px-1.5 py-1 text-[11px] outline-none rounded-[14px]"
            style={{
              color: 'hsl(var(--foreground))',
              background: 'rgb(var(--glass-tint) / 0.5)',
              border: '0.5px solid hsl(var(--border) / 0.5)',
            }}
            aria-label="替换为"
          />
          <button
            onClick={replaceOne}
            disabled={matches.length === 0}
            className="shrink-0 px-2 py-1 text-[10px] rounded-xl transition-colors hover:bg-[hsl(var(--mist-pale) / 0.7)] disabled:opacity-40"
            style={{ color: 'hsl(var(--ink-light))' }}
            title="替换当前（Enter）"
            aria-label="替换当前"
          >
            替换
          </button>
          <button
            onClick={replaceAll}
            disabled={matches.length === 0}
            className="shrink-0 px-2 py-1 text-[10px] rounded-xl transition-colors hover:bg-[hsl(var(--mist-pale) / 0.7)] disabled:opacity-40"
            style={{ color: 'hsl(var(--ink-light))' }}
            title="全部替换"
            aria-label="全部替换"
          >
            全部
          </button>
        </div>
      )}

      {/* 工具条 */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-t" style={{ borderColor: 'hsl(var(--border) / 0.3)' }}>
        <button
          onClick={goPrev}
          disabled={matches.length === 0}
          className="shrink-0 p-1 rounded-xl transition-colors hover:bg-[hsl(var(--mist-pale) / 0.7)] disabled:opacity-40"
          style={{ color: 'hsl(var(--ink-light))' }}
          title="上一个（Shift+Enter）"
          aria-label="上一个匹配"
        >
          <ChevronUp size={13} />
        </button>
        <button
          onClick={goNext}
          disabled={matches.length === 0}
          className="shrink-0 p-1 rounded-xl transition-colors hover:bg-[hsl(var(--mist-pale) / 0.7)] disabled:opacity-40"
          style={{ color: 'hsl(var(--ink-light))' }}
          title="下一个（Enter）"
          aria-label="下一个匹配"
        >
          <ChevronDown size={13} />
        </button>
        <div className="w-px h-3 mx-1" style={{ background: 'hsl(var(--border) / 0.4)' }} />
        <button
          onClick={() => setCaseSensitive(!caseSensitive)}
          className="shrink-0 px-1.5 py-0.5 text-[10px] rounded-xl transition-colors"
          style={{
            color: caseSensitive ? 'hsl(var(--mountain-deep))' : 'hsl(var(--ink-pale))',
            background: caseSensitive ? 'hsl(var(--mountain-pale) / 0.7)' : 'transparent',
            border: `0.5px solid ${caseSensitive ? 'hsl(var(--mountain-cyan) / 0.5)' : 'transparent'}`,
          }}
          title="区分大小写"
          aria-label="区分大小写"
          aria-pressed={caseSensitive}
        >
          Aa
        </button>
        <button
          onClick={() => setWholeWord(!wholeWord)}
          className="shrink-0 px-1.5 py-0.5 text-[10px] rounded-xl transition-colors"
          style={{
            color: wholeWord ? 'hsl(var(--mountain-deep))' : 'hsl(var(--ink-pale))',
            background: wholeWord ? 'hsl(var(--mountain-pale) / 0.7)' : 'transparent',
            border: `0.5px solid ${wholeWord ? 'hsl(var(--mountain-cyan) / 0.5)' : 'transparent'}`,
          }}
          title="全字匹配"
          aria-label="全字匹配"
          aria-pressed={wholeWord}
        >
          全字
        </button>
        {findText && matches.length === 0 && (
          <span className="ml-auto text-[10px] flex items-center gap-1" style={{ color: 'hsl(var(--cinnabar))' }}>
            <X size={10} /> 无匹配
          </span>
        )}
        {findText && matches.length > 0 && (
          <span className="ml-auto text-[10px] flex items-center gap-1" style={{ color: 'hsl(var(--willow))' }}>
            <Check size={10} /> 已匹配
          </span>
        )}
      </div>
    </div>
  );
}
