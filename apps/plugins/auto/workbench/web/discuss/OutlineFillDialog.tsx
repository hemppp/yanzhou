// ============================================================
// 大纲填入弹窗
//
// 在 AI 对话激活"大纲架构师"技能后，点击消息底部的"填入大纲"按钮弹出。
// 将 AI 生成的内容填入大纲编辑器的对应文本框：
//   - 核心冲突
//   - 某章细节
//
// 支持两种模式：
//   1. 自动解析：识别 AI 输出中的【核心冲突】【第X章】标记，自动映射
//   2. 手动选择：用户选择填入目标，编辑内容后确认
// ============================================================

import { useEffect, useState, useMemo, useCallback } from 'react';
import { X, BookOpen, Target, Check, ArrowRight, FileText, Wand2 } from 'lucide-react';
import { useChapterStore } from '@novel-plugins/data-core/stores';
import { useOutlineNotepadStore } from '@novel-plugins/data-core/stores';
import { dispatchToastEvent } from '@novel-plugins/ui-kit/errors';

interface OutlineFillDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** AI 消息内容（原始 Markdown） */
  aiContent: string;
  /** 当前项目 ID */
  projectId: string;
}

// ---- 解析 AI 输出 ----

interface ParsedChapter {
  order: number;       // 章节序号（从"第X章"提取）
  title: string;       // 章节标题（标记后的文字）
  content: string;     // 章节细节内容
}

interface ParsedOutline {
  coreConflict: string | null;
  chapters: ParsedChapter[];
}

/**
 * 解析 AI 输出中的结构化大纲标记。
 * 识别格式：
 *   【核心冲突】
 *   （内容）
 *
 *   【第3章 章节标题】
 *   （内容）
 */
function parseOutlineContent(raw: string): ParsedOutline {
  const result: ParsedOutline = { coreConflict: null, chapters: [] };
  if (!raw.trim()) return result;

  // 统一换行
  const text = raw.replace(/\r\n/g, '\n');

  // 匹配所有【...】标记及其后续内容
  // 标记格式：【核心冲突】或【第X章 标题】或【第X章】
  const markerRegex = /【([^】]+)】([\s\S]*?)(?=【[^】]+】|$)/g;
  let match: RegExpExecArray | null;
  let hasAnyMarker = false;

  while ((match = markerRegex.exec(text)) !== null) {
    const marker = match[1]!.trim();
    const content = match[2]!.trim();
    hasAnyMarker = true;

    // 核心冲突
    if (marker === '核心冲突' || marker.includes('核心冲突')) {
      result.coreConflict = content;
      continue;
    }

    // 第X章 [标题]
    const chapterMatch = marker.match(/^第\s*(\d+)\s*章(?:\s+(.+))?$/);
    if (chapterMatch) {
      const order = parseInt(chapterMatch[1]!, 10);
      const title = chapterMatch[2]?.trim() ?? '';
      result.chapters.push({ order, title, content });
    }
  }

  // 若无任何标记，返回空（让用户手动选择）
  void hasAnyMarker;
  return result;
}

/** 去除 Markdown 标记，转纯文本 */
function toPlainText(raw: string): string {
  let text = raw;
  // 代码块 → 移除
  text = text.replace(/```[\s\S]*?```/g, '');
  // 行内代码 `code` → code
  text = text.replace(/`([^`]+)`/g, '$1');
  // 加粗/斜体
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  // 标题 ## / ### → 移除前缀
  text = text.replace(/^#{1,6}\s+/gm, '');
  // 链接 [text](url) → text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // 引用 > text → text
  text = text.replace(/^>\s+/gm, '');
  // 列表标记
  text = text.replace(/^[\s]*[-*+]\s+/gm, '');
  text = text.replace(/^[\s]*\d+\.\s+/gm, '');
  return text.trim();
}

// ---- 填入目标类型 ----

type FillTarget =
  | { kind: 'coreConflict' }
  | { kind: 'chapter'; chapterId: string; order: number; title: string };

// ---- 组件 ----

export function OutlineFillDialog({
  isOpen,
  onClose,
  aiContent,
  projectId,
}: OutlineFillDialogProps) {
  const chapters = useChapterStore((s) => s.chapters);
  const setCoreConflict = useOutlineNotepadStore((s) => s.setCoreConflict);
  const setChapterDetail = useOutlineNotepadStore((s) => s.setChapterDetail);
  const dataByProject = useOutlineNotepadStore((s) => s.dataByProject);

  const [target, setTarget] = useState<FillTarget | null>(null);
  const [content, setContent] = useState('');
  const [mergeMode, setMergeMode] = useState(false);

  // 排序章节
  const sortedChapters = useMemo(() => {
    return [...chapters]
      .filter((c) => !c.deletedAt)
      .sort((a, b) => a.order - b.order);
  }, [chapters]);

  // 解析 AI 内容
  const parsed = useMemo(() => parseOutlineContent(aiContent), [aiContent]);

  // 当前项目的已有大纲数据（用于显示已有内容提示）
  const notepadData = dataByProject[projectId];

  // 打开时初始化
  useEffect(() => {
    if (isOpen) {
      // 默认：若解析到核心冲突，默认选核心冲突；否则选第一个章节（若有）
      if (parsed.coreConflict) {
        setTarget({ kind: 'coreConflict' });
        setContent(parsed.coreConflict);
      } else if (sortedChapters.length > 0) {
        const first = sortedChapters[0]!;
        setTarget({ kind: 'chapter', chapterId: first.id, order: first.order, title: first.title });
        setContent(toPlainText(aiContent));
      } else {
        setTarget({ kind: 'coreConflict' });
        setContent(toPlainText(aiContent));
      }
      setMergeMode(false);
    }
  }, [isOpen, parsed, sortedChapters, aiContent]);

  // Esc 关闭
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // 切换填入目标时，智能填充内容
  const handleTargetChange = useCallback(
    (newTarget: FillTarget) => {
      setTarget(newTarget);
      if (newTarget.kind === 'coreConflict' && parsed.coreConflict) {
        setContent(parsed.coreConflict);
      } else if (newTarget.kind === 'chapter') {
        // 尝试匹配解析出的章节
        const matched = parsed.chapters.find((c) => c.order === newTarget.order);
        if (matched) {
          setContent(matched.content);
        } else {
          // 无匹配，填入全文纯文本
          setContent(toPlainText(aiContent));
        }
      }
    },
    [parsed, aiContent]
  );

  if (!isOpen) return null;

  // 已有内容提示
  const existingText = (() => {
    if (!target) return '';
    if (target.kind === 'coreConflict') {
      return notepadData?.coreConflict ?? '';
    }
    return notepadData?.chapterDetails?.[target.chapterId] ?? '';
  })();

  const canConfirm = !!target && content.trim().length > 0;

  const handleConfirm = () => {
    if (!target || !content.trim()) return;
    const plain = toPlainText(content);
    if (!plain) return;

    if (target.kind === 'coreConflict') {
      setCoreConflict(projectId, mergeMode && existingText.trim()
        ? `${existingText.trim()}\n\n${plain}`
        : plain);
      dispatchToastEvent({ type: 'success', message: '已填入核心冲突' });
    } else {
      setChapterDetail(projectId, target.chapterId, plain, mergeMode);
      dispatchToastEvent({
        type: 'success',
        message: `已填入第${target.order}章细节`,
      });
    }
    onClose();
  };

  // 自动解析结果摘要
  const parsedSummary = (() => {
    const parts: string[] = [];
    if (parsed.coreConflict) parts.push('核心冲突');
    if (parsed.chapters.length > 0) {
      parts.push(`${parsed.chapters.length} 个章节细节`);
    }
    return parts.length > 0 ? `已识别：${parts.join(' · ')}` : '未识别到结构化标记，可手动选择填入目标';
  })();

  return (
    <div
      className="nm-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="填入大纲"
    >
      <div
        className="nm-modal-card w-full max-w-2xl max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="nm-modal-header">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{
              background: 'hsl(199, 89%, 48% / 0.18)',
              border: '0.5px solid hsl(199, 89%, 48% / 0.4)',
            }}
          >
            <BookOpen size={18} style={{ color: 'hsl(199, 89%, 40%)' }} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="nm-modal-title">填入大纲</h2>
            <p className="text-[10px] mt-0.5 flex items-center gap-1" style={{ color: 'hsl(var(--ink-pale))' }}>
              <Wand2 size={10} />
              {parsedSummary}
            </p>
          </div>
          <button onClick={onClose} className="nm-modal-close" aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="nm-modal-body space-y-4">
          {/* 填入目标选择 */}
          <div>
            <label className="nm-modal-label">填入目标</label>
            <div className="space-y-1.5">
              {/* 核心冲突 */}
              <TargetOption
                selected={target?.kind === 'coreConflict'}
                onClick={() => handleTargetChange({ kind: 'coreConflict' })}
                icon={<Target size={13} />}
                label="核心冲突"
                hint={parsed.coreConflict ? '已识别' : '手动填入'}
                hasExisting={!!notepadData?.coreConflict?.trim()}
                color="hsl(0 0% 38%)"
              />
              {/* 各章节 */}
              {sortedChapters.length === 0 ? (
                <div
                  className="text-xs rounded-xl px-3 py-2"
                  style={{ color: 'hsl(var(--ink-pale))', background: 'rgb(var(--glass-tint) / 0.3)' }}
                >
                  还没有章节，请先在章节列表中创建
                </div>
              ) : (
                sortedChapters.map((ch) => {
                  const matched = parsed.chapters.find((c) => c.order === ch.order);
                  const hasExisting = !!notepadData?.chapterDetails?.[ch.id]?.trim();
                  return (
                    <TargetOption
                      key={ch.id}
                      selected={target?.kind === 'chapter' && target.chapterId === ch.id}
                      onClick={() =>
                        handleTargetChange({
                          kind: 'chapter',
                          chapterId: ch.id,
                          order: ch.order,
                          title: ch.title,
                        })
                      }
                      icon={<FileText size={13} />}
                      label={`第${ch.order}章 ${ch.title || '未命名'}`}
                      hint={matched ? '已识别' : '手动填入'}
                      hasExisting={hasExisting}
                      color="hsl(0 0% 30%)"
                    />
                  );
                })
              )}
            </div>
          </div>

          {/* 填入模式 */}
          {existingText.trim() && (
            <div>
              <label className="nm-modal-label" id="nm-fill-mode-label">填入模式</label>
              <div className="flex gap-2" role="radiogroup" aria-labelledby="nm-fill-mode-label">
                <ModeButton
                  active={!mergeMode}
                  onClick={() => setMergeMode(false)}
                  label="覆盖"
                  hint="替换已有内容"
                />
                <ModeButton
                  active={mergeMode}
                  onClick={() => setMergeMode(true)}
                  label="追加"
                  hint="在已有内容后追加"
                />
              </div>
              {existingText.trim() && (
                <div
                  className="mt-2 text-[10px] rounded-xl px-2.5 py-1.5"
                  style={{
                    background: 'rgb(var(--glass-tint) / 0.3)',
                    color: 'hsl(var(--ink-pale))',
                    border: '0.5px solid hsl(var(--border) / 0.4)',
                  }}
                >
                  <span className="opacity-70">已有内容（{existingText.trim().length} 字）：</span>
                  <span className="line-clamp-2 mt-0.5 block whitespace-pre-wrap">
                    {existingText.trim().slice(0, 80)}
                    {existingText.trim().length > 80 ? '…' : ''}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* 内容编辑 */}
          <div>
            <label className="nm-modal-label">填入内容（可编辑）</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="nm-modal-textarea"
              style={{ minHeight: '160px', fontFamily: '"Songti SC", "Source Han Serif", "Noto Serif CJK SC", Georgia, serif' }}
              placeholder="AI 生成的内容将显示在这里，你可以编辑后再填入……"
              spellCheck={false}
            />
            <div className="text-[10px] mt-1 flex items-center gap-2" style={{ color: 'hsl(var(--ink-pale))' }}>
              <span>{content.trim().length} 字</span>
              {content.trim() && (
                <button
                  onClick={() => setContent(toPlainText(content))}
                  className="text-[10px] flex items-center gap-1 hover:opacity-70 transition-opacity"
                  style={{ color: 'hsl(var(--mountain-deep))' }}
                  title="去除 Markdown 标记"
                >
                  <Wand2 size={10} /> 纯文本化
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="nm-modal-footer">
          <button onClick={onClose} className="nm-modal-btn">
            取消
          </button>
          <div className="flex-1" />
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="nm-modal-btn nm-modal-btn-primary flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Check size={12} /> 填入大纲 <ArrowRight size={12} />
          </button>
        </div>
      </div>

      <style>{`
        .line-clamp-2 {
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
      `}</style>
    </div>
  );
}

// ---- 子组件 ----

function TargetOption({
  selected,
  onClick,
  icon,
  label,
  hint,
  hasExisting,
  color,
}: {
  selected: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
  hasExisting: boolean;
  color: string;
}) {
  return (
    <button
      onClick={onClick}
      // ★ 选择控件，不是动作按钮：选中态靠 border/bg 表达。
      // 加 aria-pressed 让 shuimo 主题显式豁免笔触（笔触一生效 border-color 就不再绘制，选中环会消失）。
      aria-pressed={selected}
      className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2 transition-all text-left"
      style={{
        background: selected ? `${color}14` : 'rgb(var(--glass-tint) / 0.3)',
        border: `0.5px solid ${selected ? `${color}66` : 'hsl(var(--border) / 0.4)'}`,
      }}
    >
      <span
        className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: `${color}1a`, color }}
      >
        {icon}
      </span>
      <span
        className="flex-1 text-xs font-medium truncate"
        style={{ color: selected ? color : 'hsl(var(--foreground))' }}
      >
        {label}
      </span>
      {hasExisting && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-md"
          style={{
            background: 'hsl(38, 92%, 50% / 0.12)',
            color: 'hsl(32, 95%, 44%)',
          }}
        >
          已有
        </span>
      )}
      <span
        className="text-[10px] px-1.5 py-0.5 rounded-md"
        style={{
          background: hint === '已识别' ? 'hsl(142, 71%, 45% / 0.12)' : 'rgb(var(--glass-tint) / 0.5)',
          color: hint === '已识别' ? 'hsl(142, 71%, 35%)' : 'hsl(var(--ink-pale))',
        }}
      >
        {hint}
      </span>
      {selected && (
        <Check size={13} style={{ color }} />
      )}
    </button>
  );
}

function ModeButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      onClick={onClick}
      // ★ 互斥二选一 = 选择控件，不是动作按钮：active 态靠渐变背景 + border 表达，
      // 穿上 shuimo 笔触反而会把选中态盖掉。role=radio 让主题侧显式豁免。
      role="radio"
      aria-checked={active}
      className="flex-1 rounded-xl px-3 py-2 transition-all text-left"
      style={{
        background: active
          ? 'linear-gradient(180deg, hsl(var(--mountain-cyan) / 0.92), hsl(var(--mountain-deep) / 0.92))'
          : 'rgb(var(--glass-tint) / 0.3)',
        border: `0.5px solid ${active ? 'hsl(var(--mountain-light) / 0.6)' : 'hsl(var(--border) / 0.4)'}`,
        color: active ? 'white' : 'hsl(var(--ink-light))',
        boxShadow: active
          ? '0 4px 12px hsl(var(--mountain-deep) / 0.32), inset 0 1px 0 rgb(255 255 255 / 0.3)'
          : 'inset 0 1px 0 rgb(var(--glass-highlight) / 0.2)',
      }}
    >
      <div className="text-xs font-semibold">{label}</div>
      <div className="text-[10px] mt-0.5 opacity-80">{hint}</div>
    </button>
  );
}
