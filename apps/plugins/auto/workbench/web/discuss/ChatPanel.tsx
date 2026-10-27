import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import DOMPurify from 'dompurify';
import { useChapterStore, useCharacterStore } from '@novel-plugins/data-core/stores';
import { useProjectStore } from '@novel-plugins/data-core/stores';
import { useOutlineNotepadStore } from '@novel-plugins/data-core/stores';
import { useAIRedstoneStore } from '../../stores/aiRedstoneStore';
import { useChatHistoryStore } from '../../stores/chatHistoryStore';
import { useEditorStore } from '@novel-plugins/data-core/stores';
import { novelChatStream } from './services/chatService';
import { apiClient, getToken } from '@novel-plugins/data-core/api/apiClient';
import { resolveApiUrl } from '@novel-plugins/data-core/api/apiClient';
import { OutlineCheckModal } from './OutlineCheckModal';
import { ContinueWriteModal } from './ContinueWriteModal';
import { validateUserInput } from './services/securityService';
import { Send, Bot, User, AlertCircle, RefreshCw, Snowflake, Check, Trash2, PenLine, CornerDownLeft, Replace, FileText, Square, BookOpen, BookMarked } from 'lucide-react';
import { format } from 'date-fns';
import type { Editor } from '@tiptap/core';
import { useNavigate } from 'react-router-dom';
import { PATHS } from '@/routes/paths';
// ★ D46：技能注册表已下沉 shared（data-core），本模块与 novel.autowrite 共用同一实例
import { getSkillMeta, getSkillHistorySuffix, useSkillBarProps } from '@novel-plugins/data-core';
import { buildSkillContext } from './skillContextBuilder';
import { OutlineFillDialog } from './OutlineFillDialog';
// AI 交互原语（思考轨迹 / 工具标签 / 状态指示 / 布局档位）—— 见 primitives/index.ts
import { LoadingPixels, ThinkingTrace, ToolChip } from '@novel-plugins/ui-kit/primitives';
import { refreshEntityStore } from './services/entityRefresh';
import { useReferenceStore } from '@novel-plugins/data-core/stores';
import { useToast } from '@novel-plugins/ui-kit';
// ★ D46：技能选择器 / 快捷语栏的**展示层**已下沉 shared/ui-kit（数据由下方容器注入）
import { SkillsBar as UiSkillsBar } from '@novel-plugins/ui-kit';
import { plainTextToHtml } from '@novel-plugins/data-core/editor/entityDetector';
import type { ToolCallEvent, ToolResultEvent } from './services/chatService';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  timestamp: number;
}


/** Markdown 渲染组件 — memoize 避免 onChunk 高频更新时重复解析 */
const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="prose prose-sm prose-invert max-w-none">
      <ReactMarkdown
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ className, children, ...props }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono" {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className={`block p-2 rounded bg-muted text-xs font-mono overflow-x-auto mb-2 ${className || ''}`} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre className="mb-2">{children}</pre>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-muted-foreground/30 pl-3 italic text-muted-foreground mb-2">
              {children}
            </blockquote>
          ),
          h1: ({ children }) => <h1 className="text-base font-bold mb-2 mt-3">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-bold mb-1.5 mt-2.5">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold mb-1 mt-2">{children}</h3>,
          hr: () => <hr className="my-3 border-muted-foreground/20" />,
          a: ({ href, children }) => (
            <a href={href} className="text-primary underline hover:text-primary/80" target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

/**
 * 思考归档栏 —— 薄适配层。
 *
 * 实现已迁到 `ai/primitives` 的 ThinkingTrace（竖轨 + grid 展开动画 + 计时 + 复制）。
 * 这里保留原组件名与入参签名，只为不动本文件里那两处调用点；
 * **新代码请直接用 ThinkingTrace**，不要再往这层加逻辑。
 */
function ThinkingBar({ thinking, isStreaming }: { thinking: string; isStreaming?: boolean }) {
  return <ThinkingTrace text={thinking} isStreaming={isStreaming} />;
}

// ============================================================
// 应用到正文 — 将 AI 回复内容写入编辑器
// 安全模式：DOMPurify 去标签 + 纯文本提取
// ============================================================

/** 安全提取纯文本（去除 Markdown/HTML 标签） */
function sanitizeToPlainText(raw: string): string {
  // ★ 增强：先正则预处理常见 Markdown 语法，再走 DOMPurify
  //   之前直接 DOMPurify 对纯 Markdown 文本（无 HTML 标签）效果有限，
  //   会残留 **、##、[]() 等标记符号
  let text = raw;
  // 代码块 → 移除（代码不适合插入正文）
  text = text.replace(/```[\s\S]*?```/g, '');
  // 行内代码 `code` → code
  text = text.replace(/`([^`]+)`/g, '$1');
  // 加粗/斜体 **text** / __text__ / *text* / _text_ → text
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, '$1$2');
  text = text.replace(/(^|[^_])_([^_]+)_/g, '$1$2');
  // 标题 ## / ### → 移除前缀
  text = text.replace(/^#{1,6}\s+/gm, '');
  // 链接 [text](url) → text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // 图片 ![alt](url) → 移除
  text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, '');
  // 引用 > text → text
  text = text.replace(/^>\s+/gm, '');
  // 列表标记 - / * / 1. → 移除
  text = text.replace(/^[\s]*[-*+]\s+/gm, '');
  text = text.replace(/^[\s]*\d+\.\s+/gm, '');
  // 水平线 --- / *** → 移除
  text = text.replace(/^[-*]{3,}$/gm, '');
  // 再走 DOMPurify 兜底（处理残留 HTML）
  const sanitized = DOMPurify.sanitize(text, { ALLOWED_TAGS: [] });
  const div = document.createElement('div');
  div.innerHTML = sanitized;
  return (div.textContent || '').trim();
}

type InsertMode = 'cursor' | 'end' | 'replace';

/** 将文本应用到编辑器 */
function applyToEditor(editor: Editor, content: string, mode: InsertMode): boolean {
  const plain = sanitizeToPlainText(content);
  if (!plain) return false;
  // ★ 转 HTML 再注入：plain 是纯文本（可能含 \n），直接交给 tiptap 会被当 HTML 解析 →
  //   换行被当空白吞掉、段落全并成一段。plainTextToHtml 做 \n\n→<p>、单个 \n→<br>。
  const html = plainTextToHtml(plain);
  try {
    if (mode === 'replace') {
      editor.chain().focus().setContent(html).run();
    } else if (mode === 'end') {
      const end = editor.state.doc.content.size;
      editor.chain().focus().insertContentAt(end, html).run();
    } else {
      editor.chain().focus().insertContent(html).run();
    }
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// 流式同步写入 hook — 边生成边插入正文
// ============================================================

interface StreamingInsertState {
  anchorPos: number;       // 初始插入位置（流开始时的光标位置）
  insertedLength: number;  // 已插入总长度（用于回滚）
  buffer: string;          // Markdown 缓冲区（遇段落边界或达阈值才剥离插入）
  active: boolean;         // 是否正在写入
}

const INITIAL_STATE: StreamingInsertState = {
  anchorPos: 0,
  insertedLength: 0,
  buffer: '',
  active: false,
};

/** 流式同步写入：把 AI chunk 实时插入编辑器锚点后 */
function useStreamingInsert(editor: Editor | null) {
  const stateRef = useRef<StreamingInsertState>({ ...INITIAL_STATE });

  /** 开始流式写入：记录当前光标位置作为锚点 */
  const start = useCallback(() => {
    if (!editor) return false;
    const pos = editor.state.selection.from;
    stateRef.current = {
      anchorPos: pos,
      insertedLength: 0,
      buffer: '',
      active: true,
    };
    return true;
  }, [editor]);

  /** 遇到段落边界(\n)或缓冲达 80 字 → 批量剥离 Markdown → 插入锚点后 */
  const flush = useCallback(() => {
    const st = stateRef.current;
    if (!st.active || !editor || !st.buffer) return;
    const plain = sanitizeToPlainText(st.buffer);
    if (!plain) {
      st.buffer = '';
      return;
    }
    const insertPos = st.anchorPos + st.insertedLength;
    // ★ 转 HTML 再插入（理由同 applyToEditor）；
    //   ⚠️ insertedLength 必须累加**插入内容的长度**（HTML），因为它同时是 rollback 的删除长度
    //   （deleteRange 按文档位置算）。若仍累加纯文本长度，回滚会少删 → 留残片。
    const html = plainTextToHtml(plain);
    try {
      editor.chain().focus().insertContentAt(insertPos, html).run();
      st.insertedLength += html.length;
    } catch {
      // 插入失败（如编辑器已卸载），停止写入避免错乱
      st.active = false;
    }
    st.buffer = '';
  }, [editor]);

  /** 接收 chunk：缓冲到 buffer，达阈值则 flush */
  const onChunk = useCallback((chunk: string) => {
    const st = stateRef.current;
    if (!st.active) return;
    st.buffer += chunk;
    // 遇到段落边界或缓冲达 80 字 → flush
    if (st.buffer.includes('\n') || st.buffer.length >= 80) {
      flush();
    }
  }, [flush]);

  /** 流结束：flush 残留缓冲 */
  const finish = useCallback(() => {
    const st = stateRef.current;
    if (!st.active) return;
    if (st.buffer) flush();
    st.active = false;
  }, [flush]);

  /** 回滚：删除所有已插入内容（Esc 中断时调用） */
  const rollback = useCallback(() => {
    const st = stateRef.current;
    if (!editor || st.insertedLength === 0) {
      st.active = false;
      st.buffer = '';
      return;
    }
    try {
      editor.chain()
        .focus()
        .deleteRange({ from: st.anchorPos, to: st.anchorPos + st.insertedLength })
        .run();
    } catch {
      // 回滚失败静默处理
    }
    st.active = false;
    st.buffer = '';
    st.insertedLength = 0;
  }, [editor]);

  return useMemo(
    () => ({ start, onChunk, finish, rollback, flush }),
    [start, onChunk, finish, rollback, flush],
  );
}

/** 操作栏：插入光标处 / 追加文末 / 替换全文 */
function ApplyActions({ content, editor }: { content: string; editor: Editor | null }) {
  const [done, setDone] = useState<InsertMode | null>(null);
  const [open, setOpen] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);

  const handle = (mode: InsertMode) => {
    if (!editor) return;
    if (applyToEditor(editor, content, mode)) {
      setDone(mode);
      setOpen(false);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => setDone(null), 1500);
    }
  };

  const disabled = !editor;

  return (
    <div className="mt-1.5 relative inline-block">
      <button
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-xl transition-all ${
          disabled
            ? 'text-muted-foreground/30 cursor-not-allowed'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
        }`}
        title={disabled ? '请先进入章节编辑页' : '应用到正文'}
        aria-label="应用到正文"
      >
        {done ? <Check size={11} className="text-green-500" /> : <PenLine size={11} />}
        <span>{done ? '已应用' : '写入正文'}</span>
      </button>
      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 left-0 mt-1 w-40 rounded-2xl border border-border/50 bg-popover/95 backdrop-blur-xl shadow-lg overflow-hidden text-[11px]">
            <button
              onClick={() => handle('cursor')}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/60 transition-colors text-left"
            >
              <CornerDownLeft size={12} className="text-muted-foreground" />
              <span>插入光标处</span>
            </button>
            <button
              onClick={() => handle('end')}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/60 transition-colors text-left"
            >
              <FileText size={12} className="text-muted-foreground" />
              <span>追加到文末</span>
            </button>
            <button
              onClick={() => handle('replace')}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/60 transition-colors text-left text-amber-600 dark:text-amber-400"
            >
              <Replace size={12} />
              <span>替换全文</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** 大纲填入按钮 — 激活"大纲架构师"技能后，AI 消息底部显示此按钮 */
function OutlineFillButton({ content, onClick }: { content: string; onClick: () => void }) {
  if (!content.trim()) return null;
  return (
    <button
      onClick={onClick}
      className="mt-1.5 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-xl transition-all text-sky-600 dark:text-sky-400 hover:bg-sky-500/10"
      title="将此内容填入大纲编辑器"
      aria-label="填入大纲"
    >
      <BookOpen size={11} />
      <span>填入大纲</span>
    </button>
  );
}

/**
 * 工具调用气泡 — 显示 AI 调用实体工具的实时状态。
 * calling：转圈 + 工具名
 * success：勾 + 工具名 + 受影响实体摘要
 * error：警告 + 工具名 + 失败原因
 */
const TOOL_LABELS: Record<string, string> = {
  create_character: '创建角色',
  update_character: '修改角色',
  create_foreshadow: '创建伏笔',
  update_foreshadow: '修改伏笔',
  create_location: '创建地点',
  update_location: '修改地点',
  create_item: '创建物品',
  update_item: '修改物品',
  set_outline_core_conflict: '设置核心冲突',
  set_chapter_outline: '设置章节大纲',
  set_outline_section: '设置大纲分区',
};

/**
 * 工具调用 —— 薄适配层，实现已迁到 `ai/primitives` 的 ToolChip。
 *
 * 为什么改：原实现给**每一次**工具调用都开一个带头像的独立气泡框。
 * 一次 Agent 回合常有 5–15 次调用（见 2026-09-16 审计第六节：
 * 打开一章会自动触发 3+ 次模型调用），气泡会把对话流碎成一地方块。
 * ToolChip 把它压成一行「图标 + 动词 + 对象名」，只在失败时自动展开详情。
 */
function ToolCallBubble({ event }: {
  event: {
    id: string;
    name: string;
    status: 'calling' | 'success' | 'error';
    result?: string;
    entity?: { type: string; action: string; name?: string };
  };
}) {
  return <ToolChip event={event} label={TOOL_LABELS[event.name] ?? event.name} />;
}

/**
 * 处理大纲工具的 payload — 将 AI 工具调用结果写入大纲笔记本 store（localStorage）。
 *
 * 大纲数据存储在前端 localStorage（useOutlineNotepadStore），后端无数据库表，
 * 因此后端工具 handler 不做实际持久化，而是返回结构化 payload，
 * 由本函数在前端侧完成写入。
 *
 * payload.field 决定写入目标：
 *   - 'core_conflict'：写入核心冲突文本框
 *   - 'chapter_detail'：写入某章细节文本框（需按 title/order 解析 chapterId）
 *   - 'section'：写入自由笔记分区
 */
function applyOutlinePayload(
  payload: Record<string, unknown>,
  projectId: string,
  chapters: { id: string; title: string; order: number }[],
): { ok: boolean; message: string } {
  const store = useOutlineNotepadStore.getState();
  store.loadProject(projectId);
  const field = payload.field as string;
  const merge = payload.merge === true;

  if (field === 'core_conflict') {
    const text = String(payload.text ?? '');
    if (merge) {
      const prev = store.getProjectData(projectId)?.coreConflict ?? '';
      store.setCoreConflict(projectId, prev.trim() ? `${prev.trim()}\n\n${text.trim()}` : text);
    } else {
      store.setCoreConflict(projectId, text);
    }
    return { ok: true, message: '核心冲突已更新' };
  }

  if (field === 'chapter_detail') {
    const text = String(payload.text ?? '');
    const chapterTitle = payload.chapter_title ? String(payload.chapter_title) : '';
    const chapterOrder = typeof payload.chapter_order === 'number' ? payload.chapter_order : undefined;

    // 解析目标章节：优先精确标题匹配，其次按 order 匹配，最后模糊标题
    let targetChapter: { id: string; title: string } | undefined;
    if (chapterTitle) {
      targetChapter = chapters.find(c => c.title === chapterTitle);
    }
    if (!targetChapter && chapterOrder !== undefined) {
      targetChapter = chapters.find(c => c.order === chapterOrder);
    }
    if (!targetChapter && chapterTitle) {
      targetChapter = chapters.find(c => c.title.includes(chapterTitle) || chapterTitle.includes(c.title));
    }
    if (!targetChapter) {
      return { ok: false, message: `未找到章节「${chapterTitle || `第${chapterOrder}章`}」` };
    }
    store.setChapterDetail(projectId, targetChapter.id, text, merge);
    return { ok: true, message: `「${targetChapter.title}」大纲细节已更新` };
  }

  if (field === 'section') {
    const title = String(payload.title ?? '');
    const content = String(payload.content ?? '');
    const data = store.getProjectData(projectId);
    if (!data) return { ok: false, message: '大纲数据未加载' };
    const sections = [...data.sections];
    const idx = sections.findIndex(s => s.title === title);
    if (idx >= 0) {
      // 已有分区：覆盖或追加
      sections[idx] = {
        ...sections[idx]!,
        content: merge && sections[idx]!.content.trim()
          ? `${sections[idx]!.content.trim()}\n\n${content.trim()}`
          : content,
      };
    } else {
      // 新分区
      sections.push({ id: nanoidLocal(), title, content, placeholder: '' });
    }
    store.setSections(projectId, sections);
    return { ok: true, message: `分区「${title}」已更新` };
  }

  return { ok: false, message: `未知的大纲字段：${field}` };
}

/**
 * 构建工具模式下的额外上下文：章节列表 + 当前大纲状态。
 * 让 LLM 知道有哪些章节（用于 set_chapter_outline）以及大纲已有内容（避免盲写）。
 */
function buildToolContext(
  baseContext: string,
  chapters: { id: string; title: string; order: number }[],
  projectId: string,
): string {
  const parts: string[] = [baseContext];

  // 章节列表
  if (chapters.length > 0) {
    const sorted = [...chapters].sort((a, b) => a.order - b.order);
    const lines = sorted.map(c => `  ${c.order}. ${c.title}`);
    parts.push(`【章节列表】（共 ${sorted.length} 章，调用 set_chapter_outline 时用 chapter_title 或 chapter_order 指定目标）\n${lines.join('\n')}`);
  }

  // 当前大纲状态
  const store = useOutlineNotepadStore.getState();
  store.loadProject(projectId);
  const data = store.getProjectData(projectId);
  if (data) {
    const outlineParts: string[] = ['【当前大纲状态】'];
    if (data.coreConflict.trim()) {
      outlineParts.push(`核心冲突：${data.coreConflict.slice(0, 200)}${data.coreConflict.length > 200 ? '...' : ''}`);
    } else {
      outlineParts.push('核心冲突：（空）');
    }
    const filledSections = data.sections.filter(s => s.content.trim());
    if (filledSections.length > 0) {
      outlineParts.push('已有分区内容：');
      for (const s of filledSections) {
        outlineParts.push(`  - ${s.title}：${s.content.slice(0, 80)}${s.content.length > 80 ? '...' : ''}`);
      }
    } else {
      outlineParts.push('分区内容：（均为空）');
    }
    const filledChapters = Object.entries(data.chapterDetails).filter(([, v]) => v.trim());
    if (filledChapters.length > 0) {
      outlineParts.push('已有章节细节：');
      for (const [cid, detail] of filledChapters) {
        const ch = chapters.find(c => c.id === cid);
        outlineParts.push(`  - ${ch?.title ?? cid}：${detail.slice(0, 80)}${detail.length > 80 ? '...' : ''}`);
      }
    }
    parts.push(outlineParts.join('\n'));
  }

  return parts.filter(Boolean).join('\n\n');
}

/** nanoid 轻量封装（避免在组件顶部重复 import） */
function nanoidLocal(): string {
  // 使用 crypto.randomUUID 作为简单唯一 ID（浏览器原生支持）
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}


/**
 * 技能选择器（auto 侧容器）—— 只做数据接线，展示层复用 shared/ui-kit。
 *
 * ★ D46：展示层（液态玻璃胶囊、墨阶分类色、气泡漂移）已下沉
 *   `@novel-plugins/ui-kit` 的 SkillsBar/QuickPromptsBar，供 novel.autowrite
 *   等**同域其它插件包**复用；本文件只保留 auto 专属接线：
 *     · 技能列表来自 shared 技能注册表（后端 GET /api/ai/skills，含插件注册项）
 *     · 手写模式下过滤掉流程型 auto-write 技能（双模块分离）
 *     · 「添加技能」跳转经 kernel 路由（PATHS.settings）
 *   故 ui-kit 无需反向依赖 auto 的 store 与 kernel 路由（设计 §2.3）。
 */
export function SkillsBar({
  activeSkillId, onActivate, onCancel, disabled, embedded, showToggle = true,
}: {
  activeSkillId: string | null;
  onActivate: (skillId: string) => void;
  onCancel: () => void;
  disabled: boolean;
  /** embedded：供贴附气泡的弹出层渲染（跳过折叠头部，始终展开网格） */
  embedded?: boolean;
  /** 是否渲染「技能」展开按钮（ChatPanel 内保留徽章时传 false） */
  showToggle?: boolean;
}) {
  const navigate = useNavigate();
  // ★ 技能列表与图标解析已下沉 shared；本组件只把数据接进纯展示层
  const { skills, activeSkill, loading, onExpand } = useSkillBarProps(activeSkillId);

  return (
    <UiSkillsBar
      skills={skills}
      activeSkill={activeSkill}
      activeSkillId={activeSkillId}
      onActivate={onActivate}
      onCancel={onCancel}
      disabled={disabled}
      embedded={embedded}
      showToggle={showToggle}
      loading={loading}
      onExpand={onExpand}
      onOpenSettings={() => navigate(PATHS.settings)}
    />
  );
}

/** 快捷语栏 —— 展示层已下沉 ui-kit；再导出以保持既有引用路径（AiChatBubbleRail / 模块桶文件）不变 */
export { QuickPromptsBar } from '@novel-plugins/ui-kit';

/** AI 对话面板的功能控制状态（由浮窗层的贴附气泡持有与切换） */
export interface ChatPanelControlProps {
  /** 同步写入：AI 回复边生成边插入正文 */
  syncInsert: boolean;
  /** 工具调用：AI 可读写实体模块（与 enableAgent 互斥） */
  enableTools: boolean;
  /** Agent 模式：多步规划/网页搜索/章节读写（与 enableTools 互斥） */
  enableAgent: boolean;
  /** 当前激活的技能 ID（null = 未激活） */
  activeSkillId: string | null;
  onSyncInsertChange: (v: boolean) => void;
  onEnableToolsChange: (v: boolean) => void;
  onEnableAgentChange: (v: boolean) => void;
  onActiveSkillChange: (id: string | null) => void;
}

/** controls 缺失时各开关的兜底值在函数内联构造（no-op 回调），不再需要独立常量 */

export function ChatPanel(props: { controls?: ChatPanelControlProps } & Partial<ChatPanelControlProps>) {
  // ★ 兼容两种传法：{ controls } 对象（契约形态）与平铺字段（PanelContent 展开 chatControls 的
  //   实际传法）。此前只读 props.controls，平铺路径取不到 → 永远落在 FALLBACK（开关全 no-op），
  //   工具调用/技能激活在聊天请求里全部丢失（2026-09-10 自动写作 E2E 实测定位）。
  const controls: ChatPanelControlProps = props.controls ?? {
    syncInsert: props.syncInsert ?? false,
    enableTools: props.enableTools ?? false,
    enableAgent: props.enableAgent ?? false,
    activeSkillId: props.activeSkillId ?? null,
    onSyncInsertChange: props.onSyncInsertChange ?? (() => {}),
    onEnableToolsChange: props.onEnableToolsChange ?? (() => {}),
    onEnableAgentChange: props.onEnableAgentChange ?? (() => {}),
    onActiveSkillChange: props.onActiveSkillChange ?? (() => {}),
  };
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thinkingContent, setThinkingContent] = useState('');
  // ★ activeSkillId：当前激活的技能 ID（null = 未激活）——状态由贴附气泡持有（controls）
  // 激活后该轮对话会叠加专家 system prompt + 注入实体上下文
  const activeSkillId = controls.activeSkillId;
  // ★ 大纲校验弹窗状态
  const [showOutlineCheck, setShowOutlineCheck] = useState(false);
  const [pendingActionName, setPendingActionName] = useState('');
  // ★ 智能续写弹窗状态
  const [showContinueWrite, setShowContinueWrite] = useState(false);
  // ★ 大纲填入弹窗状态：存储待填入的 AI 消息内容（null = 关闭）
  const [fillDialogContent, setFillDialogContent] = useState<string | null>(null);
  // ★ 工具调用 / Agent 模式开关：状态由浮窗层的贴附气泡持有（controls），此处只读
  const enableTools = controls.enableTools;
  const enableAgent = controls.enableAgent;
  // ★ 当前正在进行的工具调用列表（用于在消息区显示工具调用气泡）
  const [toolEvents, setToolEvents] = useState<Array<{
    id: string;
    name: string;
    status: 'calling' | 'success' | 'error';
    result?: string;
    entity?: { type: string; action: string; name?: string; payload?: Record<string, unknown> };
  }>>([]);
  // ★ 扫榜拆书：AI 对话内列出扫榜收藏的书，选择后发起拆书；
  //   流完成后报告自动回存该书（参考书架内可点击查看）
  const [scanPickerOpen, setScanPickerOpen] = useState(false);
  const scanReportTargetRef = useRef<string | null>(null);
  const refBooks = useReferenceStore(s => s.books);
  const loadRefBooks = useReferenceStore(s => s.loadBooks);
  const toast = useToast();
  const scanBooks = useMemo(
    () => refBooks.filter(b => b.source?.startsWith('扫榜')),
    [refBooks],
  );
  // 打开选择器时确保参考书已加载
  useEffect(() => {
    if (!scanPickerOpen) return;
    const pid = useProjectStore.getState().currentProject?.id;
    if (pid && useReferenceStore.getState().books.length === 0) void loadRefBooks(pid);
  }, [scanPickerOpen, loadRefBooks]);

  // ★★★ 第一步：先调用所有 Zustand store hooks 获取数据（必须在所有 ref 和 useCallback 之前）
  const chapters = useChapterStore(s => s.chapters);
  const currentChapterId = useChapterStore(s => s.currentChapterId);
  const characters = useCharacterStore(s => s.characters);
  const currentProject = useProjectStore(s => s.currentProject);
  const features = useAIRedstoneStore(s => s.features);
  const loadHistory = useChatHistoryStore(s => s.loadHistory);
  const saveMessage = useChatHistoryStore(s => s.saveMessage);
  const updateLastAssistant = useChatHistoryStore(s => s.updateLastAssistant);
  const clearHistory = useChatHistoryStore(s => s.clearHistory);
  const editor = useEditorStore(s => s.editor);

  // ★ 流式同步写入：开关状态由浮窗层的贴附气泡持有（controls）
  const syncInsertEnabled = controls.syncInsert;
  const streamingInsert = useStreamingInsert(editor);

  const currentChapter = chapters.find(ch => ch.id === currentChapterId);

  // 计算历史记录的 key：
  //   - 大纲架构师等跨章节技能 → 项目级独立历史 `${projectId}:outline`
  //   - 普通对话 → 章节级历史 `${projectId}:${chapterId}`
  const skillHistorySuffix = getSkillHistorySuffix(activeSkillId ?? undefined);
  const historyKey = currentProject
    ? (skillHistorySuffix
      ? `${currentProject.id}:${skillHistorySuffix}`
      : currentChapterId
        ? `${currentProject.id}:${currentChapterId}`
        : null)
    : null;

  // ★★★ 第二步：初始化所有 ref（此时上面的变量都已定义）
  const scrollRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const thinkingRef = useRef('');
  const assistantContentRef = useRef('');
  const isMountedRef = useRef(true);
  const pendingPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // ★ 用 ref 存储所有回调中需要访问的最新值，彻底消除 useCallback 的依赖数组问题
  // 这避免了因 input/loading/currentChapter/characters 等频繁变化导致的回调重建，
  // 从根源上切断无限重渲染的可能性
  const messagesRef = useRef<ChatMessage[]>(messages);
  const inputRef = useRef(input);
  const loadingRef = useRef(loading);
  const syncInsertEnabledRef = useRef(syncInsertEnabled);
  // 受控 setter 经 ref 供空依赖回调使用
  const syncInsertSetterRef = useRef(controls.onSyncInsertChange);
  useEffect(() => { syncInsertSetterRef.current = controls.onSyncInsertChange; }, [controls]);
  const editorRef = useRef<Editor | null>(editor);
  const streamingInsertRef = useRef(streamingInsert);
  const currentChapterRef = useRef(currentChapter);
  const charactersRef = useRef(characters);
  const chaptersRef = useRef(chapters);
  const historyKeyRef = useRef<string | null>(historyKey);
  const activeSkillIdRef = useRef<string | null>(activeSkillId);
  const currentProjectRef = useRef(currentProject);
  const saveMessageRef = useRef(saveMessage);
  const updateLastAssistantRef = useRef(updateLastAssistant);
  const enableToolsRef = useRef(enableTools);
  const enableAgentRef = useRef(enableAgent);
  const handleContinueWriteRef = useRef<() => void>(() => {});
  const handleSendWithPhaseRef = useRef<(text: string, phase: string) => Promise<void>>(async () => {});

  // 卸载时清理所有异步资源
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (pendingPersistTimerRef.current) {
        clearTimeout(pendingPersistTimerRef.current);
        pendingPersistTimerRef.current = null;
      }
      if (abortControllerRef.current) {
        try { abortControllerRef.current.abort(); } catch { /* 忽略 */ }
        abortControllerRef.current = null;
      }
    };
  }, []);

  // ★★★ 第三步：同步所有状态到 ref，让回调函数始终能读取最新值而无需作为依赖
  // 使用 useEffect 而不是渲染期直接赋值，避免副作用
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { inputRef.current = input; }, [input]);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  useEffect(() => { syncInsertEnabledRef.current = syncInsertEnabled; }, [syncInsertEnabled]);
  useEffect(() => { editorRef.current = editor; }, [editor]);
  useEffect(() => { streamingInsertRef.current = streamingInsert; }, [streamingInsert]);
  useEffect(() => { currentChapterRef.current = currentChapter; }, [currentChapter]);
  useEffect(() => { charactersRef.current = characters; }, [characters]);
  useEffect(() => { chaptersRef.current = chapters; }, [chapters]);
  useEffect(() => { historyKeyRef.current = historyKey; }, [historyKey]);
  useEffect(() => { activeSkillIdRef.current = activeSkillId; }, [activeSkillId]);
  useEffect(() => { currentProjectRef.current = currentProject; }, [currentProject]);
  useEffect(() => { saveMessageRef.current = saveMessage; }, [saveMessage]);
  useEffect(() => { updateLastAssistantRef.current = updateLastAssistant; }, [updateLastAssistant]);
  useEffect(() => { enableToolsRef.current = enableTools; }, [enableTools]);
  useEffect(() => { enableAgentRef.current = enableAgent; }, [enableAgent]);

  // 加载历史记录
  useEffect(() => {
    if (historyKey) {
      const history = loadHistory(historyKey);
      setMessages(history);
    } else {
      setMessages([]);
    }
  }, [historyKey, loadHistory]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, thinkingContent, toolEvents]);

  // ★★★ 重构 handleSend：空依赖数组，全部通过 ref 读取最新值
  const handleSend = useCallback(async (overrideText?: string, opts?: { freshContext?: boolean }) => {
    const text = overrideText ?? inputRef.current;
    const isLoading = loadingRef.current;
    const hKey = historyKeyRef.current;
    const ed = editorRef.current;
    const si = streamingInsertRef.current;
    const cc = currentChapterRef.current;
    const chars = charactersRef.current;
    const skillId = activeSkillIdRef.current;
    const proj = currentProjectRef.current;
    const saveMsg = saveMessageRef.current;
    const syncInsert = syncInsertEnabledRef.current;
    const toolsOn = enableToolsRef.current;
    const agentOn = enableAgentRef.current;

    if (!text.trim() || isLoading || sendingRef.current || !hKey) return;
    sendingRef.current = true;

    const { safe, sanitized } = validateUserInput(text);
    if (!safe || !sanitized) {
      scanReportTargetRef.current = null; // 发送未成立，清掉可能的拆书目标
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '检测到输入中包含不安全内容，请修改后重试。',
        timestamp: Date.now(),
      }]);
      setInput('');
      sendingRef.current = false;
      return;
    }

    const userMsg: ChatMessage = { role: 'user', content: sanitized, timestamp: Date.now() };
    const assistantMsg: ChatMessage = { role: 'assistant', content: '', timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg, assistantMsg]);
    saveMsg(hKey, userMsg);
    saveMsg(hKey, assistantMsg);
    setInput('');
    setLoading(true);
    setError(null);
    setThinkingContent('');
    thinkingRef.current = '';
    assistantContentRef.current = '';
    setToolEvents([]);

    try {
      // ★ freshContext（扫榜拆书用）：不带历史对话——历史里的失败/闲聊消息
      //   会把模型带偏（曾导致拆书报告存成模型的元回复）
      const prevMessages = opts?.freshContext ? [] : messagesRef.current.slice(0, -2);
      const history = prevMessages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }));

      const controller = new AbortController();
      abortControllerRef.current = controller;

      if (syncInsert && ed && si) {
        si.start();
      }

      // ★ 构建上下文：技能上下文 + 工具/Agent 模式下的章节列表/大纲状态
      let extraContext = skillId && proj
        ? buildSkillContext(proj.id, getSkillMeta(skillId)?.contextKeys ?? [])
        : '';
      if ((toolsOn || agentOn) && proj) {
        extraContext = buildToolContext(extraContext, chaptersRef.current, proj.id);
      }

      await novelChatStream(sanitized, {
        chapterTitle: cc?.title,
        chapterContent: cc?.content?.slice(0, 8000),
        characterNames: chars.map(c => c.name),
        skillId: skillId ?? undefined,
        projectId: proj?.id,
        enableTools: toolsOn,
        enableAgent: agentOn,
        extraContext: extraContext || undefined,
      }, {
        onChunk: (chunk) => {
          if (!isMountedRef.current || controller.signal.aborted) return;
          assistantContentRef.current += chunk;
          const currentSi = streamingInsertRef.current;
          if (syncInsertEnabledRef.current && currentSi) {
            currentSi.onChunk(chunk);
          }
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') {
              const updated = { ...last, content: last.content + chunk };
              return [...prev.slice(0, -1), updated];
            }
            return prev;
          });
        },
        onThinking: (chunk) => {
          if (!isMountedRef.current || controller.signal.aborted) return;
          thinkingRef.current += chunk;
          setThinkingContent(thinkingRef.current);
        },
        onComplete: () => {
          if (!isMountedRef.current) return;
          setLoading(false);
          sendingRef.current = false;
          abortControllerRef.current = null;
          const currentSi = streamingInsertRef.current;
          if (syncInsertEnabledRef.current && currentSi) {
            currentSi.finish();
          }
          const finalThinking = thinkingRef.current;
          const finalContent = assistantContentRef.current;
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') {
              const updates: Partial<ChatMessage> = { content: last.content };
              if (finalThinking) {
                updates.thinking = finalThinking;
              }
              return [...prev.slice(0, -1), { ...last, ...updates }];
            }
            return prev;
          });
          // ★ 使用请求开始时捕获的 historyKey：防止流期间切换项目/章节后，
          //   旧响应被写入新项目的聊天历史（跨项目串写）
          const currentHKey = hKey;
          const currentUpdateLast = updateLastAssistantRef.current;
          if (currentHKey) {
            if (pendingPersistTimerRef.current) clearTimeout(pendingPersistTimerRef.current);
            pendingPersistTimerRef.current = setTimeout(() => {
              if (!isMountedRef.current) return;
              currentUpdateLast(currentHKey, {
                content: finalContent,
                ...(finalThinking ? { thinking: finalThinking } : {}),
              });
            }, 0);
          }

          // ★ 扫榜拆书报告回存：本轮由「扫榜拆书」选择器发起（目标书 id 在 ref 中），
          //   流完成后把报告写入该参考书的「拆书报告」章节（书架内可点击查看）
          const targetBookId = scanReportTargetRef.current;
          if (targetBookId && finalContent && finalContent.trim().length > 80) {
            scanReportTargetRef.current = null;
            void useReferenceStore.getState().appendReportChapter(targetBookId, finalContent).then(ok => {
              if (ok && isMountedRef.current) {
                setMessages(prev => [...prev, {
                  role: 'assistant',
                  content: '📎 拆书完成：报告已存入参考书。打开「参考书 → 书架」点击「查看拆书报告」即可阅读。',
                  timestamp: Date.now(),
                }]);
                toast.success('拆书报告已回存参考书');
              }
            });
          }
        },
        onError: (err) => {
          if (!isMountedRef.current) return;
          setError(err.message);
          setLoading(false);
          sendingRef.current = false;
          abortControllerRef.current = null;
          scanReportTargetRef.current = null; // 失败的拆书流不回存报告
          const currentSi = streamingInsertRef.current;
          if (syncInsertEnabledRef.current && currentSi) {
            currentSi.rollback();
          }
        },
        onToolCall: (event: ToolCallEvent) => {
          if (!isMountedRef.current) return;
          // 工具开始调用：追加一条 calling 状态的气泡
          setToolEvents(prev => [
            ...prev,
            { id: event.id, name: event.name, status: 'calling' },
          ]);
        },
        onToolResult: (event: ToolResultEvent) => {
          if (!isMountedRef.current) return;
          // 工具执行完成：更新对应气泡为 success/error
          setToolEvents(prev =>
            prev.map(t =>
              t.id === event.id
                ? {
                    ...t,
                    status: event.success ? 'success' : 'error',
                    result: event.result,
                    entity: event.entity,
                  }
                : t,
            ),
          );
          // ★ 工具成功后按类型处理：outline 写入前端 store，其他刷新后端数据
          if (event.success && event.entity) {
            const pid = currentProjectRef.current?.id;
            if (!pid) return;
            if (event.entity.type === 'outline') {
              // 大纲数据在前端 localStorage，直接写入 notepadStore
              if (event.entity.payload) {
                const chs = chaptersRef.current;
                const res = applyOutlinePayload(event.entity.payload, pid, chs);
                // 更新气泡显示实际写入结果
                setToolEvents(prev =>
                  prev.map(t =>
                    t.id === event.id
                      ? { ...t, status: res.ok ? 'success' : 'error', result: res.ok ? t.result : res.message }
                      : t,
                  ),
                );
              }
            } else {
              // 角色/伏笔/地点/物品：从后端重新拉取刷新 store
              refreshEntityStore(event.entity.type, pid);
            }
          }
        },
      }, history, controller.signal);
    } catch (err) {
      if (!isMountedRef.current) return;
      const message = err instanceof Error ? err.message : 'AI 响应失败，请重试';
      setError(message);
      setLoading(false);
      sendingRef.current = false;
      abortControllerRef.current = null;
      scanReportTargetRef.current = null;
      const currentSi = streamingInsertRef.current;
      if (syncInsertEnabledRef.current && currentSi) {
        currentSi.rollback();
      }
    }
  }, []);  // ★ 空依赖数组！所有值通过 ref 读取

  // ★ 扫榜拆书：从收藏列表选书 → 以该书文案发起拆书分析 → 完成后报告回存参考书
  const handleScanBreakdown = useCallback((bookId: string) => {
    if (loadingRef.current) return;
    if (!historyKeyRef.current) {
      toast.warning('请先选择一个章节再发起拆书');
      return;
    }
    const book = useReferenceStore.getState().books.find(b => b.id === bookId);
    if (!book) return;
    const intro = book.chapters[0]?.content || '';
    setScanPickerOpen(false);
    void handleSend([
      `请对《${book.title}》（作者：${book.author || '未知'}）进行拆书分析。以下是该书的官方文案：`,
      '',
      intro,
      '',
      '请分节输出：1) 题材定位与核心卖点；2) 核心冲突与钩子设计；3) 从文案推断的人物配置；4) 开篇策略；5) 可借鉴的写作手法。',
    ].join('\n'), { freshContext: true });
    // handleSend 同步段执行完后（发送已成立）再登记目标书，避免早退分支留下悬空目标
    scanReportTargetRef.current = book.id;
  }, [handleSend, toast]);

  // ★ handleRetry 也改为通过 ref 访问，避免依赖 messages 和 handleSend
  const handleRetry = useCallback(() => {
    setError(null);
    const lastUserMsg = messagesRef.current.filter(m => m.role === 'user').pop();
    if (lastUserMsg) {
      setMessages(prev => prev.slice(0, -2));
      setInput(lastUserMsg.content);
      // 用 setTimeout 确保 input state 更新后再发送
      setTimeout(() => handleSend(lastUserMsg.content), 0);
    }
  }, []);  // ★ 空依赖，handleSend 稳定

  const handleClearHistory = useCallback(() => {
    const hKey = historyKeyRef.current;
    if (hKey && confirm('确定要清空当前章节的对话记录吗？')) {
      clearHistory(hKey);
      setMessages([]);
    }
  }, [clearHistory]);

  // ★ 停止生成
  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
      try { abortControllerRef.current.abort(); } catch { /* 忽略 */ }
      abortControllerRef.current = null;
    }
    setLoading(false);
    sendingRef.current = false;
    scanReportTargetRef.current = null; // 用户中止的拆书流不回存报告
    const currentSi = streamingInsertRef.current;
    if (syncInsertEnabledRef.current && currentSi) {
      currentSi.rollback();
    }
  }, []);  // ★ 空依赖

  // ★ 智能续写：检查大纲后弹出续写确认窗
  const handleContinueWrite = useCallback(async () => {
    const proj = currentProjectRef.current;
    const cc = currentChapterRef.current;
    const isLoading = loadingRef.current;
    if (!proj?.id || !cc) return;
    if (isLoading || sendingRef.current) return;

    try {
      const res = await apiClient.post<{ hasOutline: boolean }>('/ai/check-outline', {
        projectId: proj.id,
      }, { timeoutMs: 10_000 });
      if (res?.hasOutline === false) {
        setPendingActionName('智能续写');
        setShowOutlineCheck(true);
        return;
      }
    } catch {
      // 检查失败时静默执行
    }

    setShowContinueWrite(true);
  }, []);  // ★ 空依赖

  // ★★★ handleSendWithPhase 也重构为空依赖数组，通过 ref 读值
  const handleSendWithPhase = useCallback(async (text: string, phase: string) => {
    const hKey = historyKeyRef.current;
    const ed = editorRef.current;
    const si = streamingInsertRef.current;
    const cc = currentChapterRef.current;
    const chars = charactersRef.current;
    const skillId = activeSkillIdRef.current;
    const proj = currentProjectRef.current;
    const saveMsg = saveMessageRef.current;

    if (!text.trim() || !hKey) return;
    sendingRef.current = true;

    const { safe, sanitized } = validateUserInput(text);
    if (!safe || !sanitized) {
      sendingRef.current = false;
      return;
    }

    const isContinue = phase === '智能续写';
    const userMsg: ChatMessage = { role: 'user', content: sanitized, timestamp: Date.now() };
    const assistantMsg: ChatMessage = { role: 'assistant', content: '', timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg, assistantMsg]);
    saveMsg(hKey, userMsg);
    saveMsg(hKey, assistantMsg);
    setInput('');
    setLoading(true);
    setError(null);
    setThinkingContent('');
    thinkingRef.current = '';
    assistantContentRef.current = '';

    try {
      const prevMessages = messagesRef.current.slice(0, -2);
      const history = prevMessages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }));

      const controller = new AbortController();
      abortControllerRef.current = controller;

      if (isContinue && ed && si) {
        si.start();
      }

      const token = getToken();
      const response = await fetch(resolveApiUrl('ai/chat-stream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          simple: true,
          phase,
          chapterTitle: cc?.title,
          characterNames: chars.map(c => c.name),
          chapterContent: cc?.content?.slice(0, 8000),
          userMessage: sanitized,
          conversationHistory: history,
          projectId: proj?.id,
          currentChapterOrder: cc?.order,
          skillId: skillId ?? undefined,
          extraContext: skillId && proj
            ? buildSkillContext(proj.id, getSkillMeta(skillId)?.contextKeys ?? [])
            : undefined,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`流式请求失败: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // 单个 SSE 事件块解析（循环内与流结束后的残余 buffer 共用）
      const processEventBlock = (eventBlock: string) => {
        for (const line of eventBlock.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6);
          try {
            const data = JSON.parse(dataStr);
            if (data.chunk) {
              if (!isMountedRef.current || controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
              assistantContentRef.current += data.chunk;
              const currentSi = streamingInsertRef.current;
              if (isContinue && currentSi) {
                currentSi.onChunk(data.chunk);
              }
              setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last && last.role === 'assistant') {
                  return [...prev.slice(0, -1), { ...last, content: last.content + data.chunk }];
                }
                return prev;
              });
            } else if (data.thinking) {
              if (!isMountedRef.current || controller.signal.aborted) return;
              thinkingRef.current += data.thinking;
              setThinkingContent(thinkingRef.current);
            } else if (data.done) {
              // 完成
            } else if (data.error) {
              throw new Error(data.message || '流式对话失败');
            }
          } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') throw e;
            if (e instanceof Error && (e.message.startsWith('流式') || e.message === '流式对话失败')) throw e;
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let sepIndex: number;
        while ((sepIndex = buffer.indexOf('\n\n')) >= 0) {
          const eventBlock = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          processEventBlock(eventBlock);
        }
      }

      // ★ decoder 最终 flush + 残余 buffer：最后一条事件可能没有尾部空行
      buffer += decoder.decode();
      processEventBlock(buffer);

      setLoading(false);
      sendingRef.current = false;
      abortControllerRef.current = null;
      const currentSi = streamingInsertRef.current;
      if (isContinue && currentSi) {
        currentSi.finish();
      }

      const finalContent = assistantContentRef.current;
      const finalThinking = thinkingRef.current;
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant') {
          const updates: Partial<ChatMessage> = { content: finalContent };
          if (finalThinking) {
            updates.thinking = finalThinking;
          }
          return [...prev.slice(0, -1), { ...last, ...updates }];
        }
        return prev;
      });
      // ★ 使用请求开始时捕获的 historyKey（同 handleSend）
      const currentHKey = hKey;
      const currentUpdateLast = updateLastAssistantRef.current;
      if (currentHKey) {
        if (pendingPersistTimerRef.current) clearTimeout(pendingPersistTimerRef.current);
        pendingPersistTimerRef.current = setTimeout(() => {
          if (!isMountedRef.current) return;
          currentUpdateLast(currentHKey, {
            content: finalContent,
            ...(finalThinking ? { thinking: finalThinking } : {}),
          });
        }, 0);
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      const message = err instanceof Error ? err.message : '操作失败，请重试';
      setError(message);
      setLoading(false);
      sendingRef.current = false;
      abortControllerRef.current = null;
      const currentSi = streamingInsertRef.current;
      if (isContinue && currentSi) {
        currentSi.rollback();
      }
    }
  }, []);  // ★ 空依赖数组

  // ★★★ 同步回调函数到 ref，让其他空依赖回调可以互相访问
  useEffect(() => {
    handleContinueWriteRef.current = handleContinueWrite;
  }, [handleContinueWrite]);
  useEffect(() => {
    handleSendWithPhaseRef.current = handleSendWithPhase;
  }, [handleSendWithPhase]);

  // ★ 技能激活拦截：续写技能走弹窗，其余正常激活（空依赖，通过 ref 调用）
  const handleSkillActivate = useCallback((skillId: string) => {
    if (skillId === 'continue-writer') {
      handleContinueWriteRef.current();
    } else {
      controls.onActiveSkillChange(skillId);
    }
  }, [controls]);

  // ★ 技能取消
  const handleSkillCancel = useCallback(() => {
    controls.onActiveSkillChange(null);
  }, [controls]);

  // ★ 贴附气泡事件桥：快捷语选择填入输入框、技能选择走统一激活逻辑
  useEffect(() => {
    const onPick = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (typeof text === 'string' && text) setInput(text);
    };
    const onSkill = (e: Event) => {
      const skillId = (e as CustomEvent<string | null>).detail ?? null;
      if (skillId === null) handleSkillCancel();
      else handleSkillActivate(skillId);
    };
    window.addEventListener('nm-chat:pick-prompt', onPick as EventListener);
    window.addEventListener('nm-chat:skill', onSkill as EventListener);
    return () => {
      window.removeEventListener('nm-chat:pick-prompt', onPick as EventListener);
      window.removeEventListener('nm-chat:skill', onSkill as EventListener);
    };
  }, [handleSkillActivate, handleSkillCancel]);

  // ★ 大纲弹窗关闭
  const handleOutlineCheckClose = useCallback(() => {
    setShowOutlineCheck(false);
  }, []);

  // ★ 续写弹窗关闭
  const handleContinueWriteClose = useCallback(() => {
    setShowContinueWrite(false);
  }, []);

  // ★ 续写弹窗确认：执行续写（空依赖，通过 ref 调用 handleSendWithPhase）
  const handleContinueConfirm = useCallback(async (prompt: string) => {
    setShowContinueWrite(false);
    const ed = editorRef.current;
    if (ed) {
      // 续写默认开启同步写入（setter 经 ref，见下方同步区）
      syncInsertSetterRef.current(true);
      // 等一帧确保 state 更新后再发送
      requestAnimationFrame(() => {
        handleSendWithPhaseRef.current(prompt, '智能续写');
      });
    } else {
      handleSendWithPhaseRef.current(prompt, '智能续写');
    }
  }, []);  // ★ 空依赖

  // ★ 同步写入 / 工具调用 / Agent 模式的开关已移至浮窗左缘的贴附气泡（AiChatBubbleRail），
  //   状态由浮窗持有（controls），切换互斥逻辑也在浮窗层处理。

  // ★ 输入框回车发送
  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // ★ 输入法合成中一律不处理回车。中文用拼音输入时，候选框上按回车是「确认候选」，
    //   此时若当发送处理，会把半截拼音直接发出去 —— 中文写作工具的必踩坑，
    //   本文件此前没有这道判断（同样是 React.KeyboardEvent，改用 e.nativeEvent.isComposing）。
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // ★ 发送按钮点击
  const handleSendClick = useCallback(() => {
    handleSend();
  }, [handleSend]);

  return (
    <div className="h-full flex flex-col nm-glass rounded-2xl">
      {(currentChapter || messages.length > 0) && (
        <div className="shrink-0 px-3 py-1.5 border-b flex items-center gap-2 mc-divider">
          {currentChapter && (
            <span className="text-xs text-muted-foreground truncate max-w-[200px]">
              {currentChapter.title}
            </span>
          )}
          {messages.length > 0 && (
            <button
              onClick={handleClearHistory}
              className="p-1 rounded-xl hover:bg-muted transition-colors ml-auto"
              title="清空对话记录"
              aria-label="清空对话记录"
            >
              <Trash2 size={14} className="text-muted-foreground" />
            </button>
          )}
        </div>
      )}

      <div ref={scrollRef} className="mc-scroll flex-1 overflow-y-auto p-3 space-y-5 mc-scrollbar" role="log" aria-label="聊天消息" aria-live="polite">
        {messages.length === 0 && !error ? (
          /* 空态：不用大图标压场，改成"眉标 + 两行说明"——
             图标在单色体系里没有信息量，反而抢位置 */
          <div className="px-2 py-8 text-center">
            <div className="mc-eyebrow mb-2">写作助手已就绪</div>
            <p className="text-[11.5px] leading-relaxed text-tone-2">基于你的知识库和当前章节回答问题</p>
            <p className="mt-1 text-2xs text-tone-3">Ctrl/Cmd + Enter 快捷唤起 · 上下方向键翻历史</p>
          </div>
        ) : (
          messages.map((msg, idx) => (
            <div key={`${msg.timestamp}-${idx}`} className={`flex gap-2.5 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              {/* 墨圈头像：助手侧改用「纸面 + 勾线」，不再用实心色块 ——
                  实心块在长对话里会变成一排抢眼的点，把正文压下去 */}
              <div
                className={`flex size-6 shrink-0 items-center justify-center rounded-full ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-paper text-tone-2 shadow-hairline'
                }`}
                aria-hidden="true"
              >
                {msg.role === 'user' ? <User size={12} /> : <Bot size={12} />}
              </div>

              <div className={`min-w-0 flex-1 ${msg.role === 'user' ? 'flex flex-col items-end text-right' : ''}`}>
                {/* 思考归档栏 — 已完成 */}
                {msg.role === 'assistant' && msg.thinking && (
                  <ThinkingBar thinking={msg.thinking} />
                )}
                {/* 思考中 — 流式 */}
                {msg.role === 'assistant' && thinkingContent && !msg.thinking && loading && idx === messages.length - 1 && (
                  <ThinkingBar thinking={thinkingContent} isStreaming />
                )}

                {msg.role === 'user' ? (
                  /* 用户侧：保留实心气泡 —— 它是「我」的锚点，需要压得住 */
                  <div className="inline-block max-w-full rounded-card bg-primary px-3 py-2 text-[11.5px] leading-relaxed text-primary-foreground shadow-hairline">
                    <span className="whitespace-pre-wrap break-words">{msg.content}</span>
                  </div>
                ) : (
                  /* 助手侧：**不给气泡**，正文直接落在纸面上。
                     长回复套气泡会又挤又灰（原来 rounded-2xl + border-2 + mc-card 三层叠加）；
                     直接排版能读、能选、能复制，也是该库 Chat 的做法。 */
                  <div
                    className={`text-[11.5px] leading-relaxed text-tone ${
                      loading && idx === messages.length - 1 && msg.content ? 'mc-caret-tail' : ''
                    }`}
                  >
                    {msg.content ? (
                      <MarkdownContent content={msg.content} />
                    ) : loading && idx === messages.length - 1 && !thinkingContent ? (
                      <LoadingPixels label="AI 正在回复" />
                    ) : null}
                  </div>
                )}

                {msg.role === 'assistant' && msg.content && !(loading && idx === messages.length - 1) && (
                  activeSkillId === 'outline-architect' ? (
                    <OutlineFillButton
                      content={msg.content}
                      onClick={() => setFillDialogContent(msg.content)}
                    />
                  ) : (
                    <ApplyActions content={msg.content} editor={editor} />
                  )
                )}

                <div className="mc-num mt-1 text-2xs text-tone-3">
                  {format(msg.timestamp, 'HH:mm')}
                </div>
              </div>
            </div>
          ))
        )}

        {/* ★ 工具调用：显示 AI 调用实体工具的实时状态。
            原来是「每次调用一个带头像的气泡」，现压成一行一条（见 ToolCallBubble 注释）——
            一次回合动辄 5–15 次调用，气泡会把对话流碎掉。 */}
        {toolEvents.length > 0 && (
          <div className="space-y-0.5" aria-live="polite">
            <div className="mc-eyebrow px-1.5 pb-0.5">工具调用</div>
            {toolEvents.map(event => (
              <ToolCallBubble key={event.id} event={event} />
            ))}
          </div>
        )}

        {error && (
          <div className="flex gap-2" role="alert" aria-live="assertive">
            <div className="w-7 h-7 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
              <AlertCircle size={14} className="text-destructive" />
            </div>
            <div className="flex-1">
              <div className="px-3 py-2 rounded-2xl text-sm mc-auth-error border-2">
                {error}
              </div>
              <button
                onClick={handleRetry}
                className="flex items-center gap-1 text-xs text-primary hover:underline mt-1 mc-btn"
                aria-label="重试发送消息"
              >
                <RefreshCw size={10} aria-hidden="true" />
                重试
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 p-3 border-t mc-divider">
        {/* 技能 / 快捷语 / 模式开关已移至浮窗左缘的贴附气泡（AiChatBubbleRail）；
            技能与快捷语选择通过事件桥回传（nm-chat:skill / nm-chat:pick-prompt） */}

        {/* ★ 技能库/智能体技能入口**不在这里**（2026-09-13）：本面板是**手写模式**的 AI 对话，
            而技能的归属对象（写作官等）是 AI 写作链路里的 agent —— 手写模式不共用那套，
            摆在这里会指向一个当前模式下不存在的智能体。
            入口在 AutoWriteWorkbench 的「智能体对话」输入栏上方（见 EntrySkillPanel / AgentSkillsPanel）。 */}

        <div className="flex gap-2 items-center">
          {/* ★ 扫榜拆书：列出扫榜收藏的书，选择后就地发起拆书（报告回存参考书） */}
          <div className="relative shrink-0">
            <button
              onClick={() => setScanPickerOpen(o => !o)}
              disabled={!currentProject || !features.chat || !historyKey || loading}
              className={`w-9 h-9 flex items-center justify-center rounded-xl transition-all ${
                scanPickerOpen
                  ? 'text-primary-foreground mc-auth-btn-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50 border'
              } ${(!currentProject || !features.chat || !historyKey) ? 'opacity-40 cursor-not-allowed' : ''}`}
              aria-label={scanPickerOpen ? '关闭扫榜拆书' : '扫榜拆书：选择收藏的书'}
              title="扫榜拆书：从扫榜收藏的书里选一本，AI 就地拆书，报告自动存入参考书"
            >
              <BookMarked size={14} aria-hidden="true" />
            </button>
            {scanPickerOpen && (
              <div className="absolute bottom-11 left-0 w-64 max-h-60 overflow-y-auto rounded-2xl border bg-background shadow-lg p-1.5 z-20">
                <div className="px-2 py-1 text-[10px] text-muted-foreground">
                  扫榜收藏的书（在「参考书 → 书源」中收藏）
                </div>
                {scanBooks.length === 0 && (
                  <div className="px-2 py-3 text-xs text-muted-foreground">还没有收藏的书，去「参考书 → 书源」收藏一本</div>
                )}
                {scanBooks.map(b => (
                  <button
                    key={b.id}
                    onClick={() => handleScanBreakdown(b.id)}
                    disabled={loading}
                    className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-muted/60 text-xs flex items-center gap-2 disabled:opacity-50"
                    title={b.source ?? undefined}
                  >
                    <span className="truncate flex-1">{b.title}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{b.author}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <label htmlFor="chat-input" className="sr-only">AI 对话输入</label>
          <input
            id="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={
              !features.chat
                ? "AI 对话已暂停"
                : !historyKey
                  ? "请先选择一个章节"
                  : syncInsertEnabled
                    ? "与 AI 讨论你的小说（回复将写入正文）..."
                    : "与 AI 讨论你的小说..."
            }
            className={`flex-1 px-3 py-2 text-[11.5px] border rounded-control bg-background mc-input ${
              !features.chat || !historyKey ? 'opacity-50 cursor-not-allowed' : ''
            } ${syncInsertEnabled ? 'border-primary/50' : ''}`}
            disabled={loading || !features.chat || !historyKey}
          />
          {loading ? (
            // ★ 停止生成按钮：loading 时显示，点击中断流式 + 回滚同步写入
            <button
              onClick={handleStop}
              className="mc-press mc-sheen shrink-0 size-9 flex items-center justify-center rounded-control text-primary-foreground mc-auth-btn-primary"
              aria-label="停止生成"
              title="停止生成（已写入的内容将被撤销）"
            >
              <Square size={14} aria-hidden="true" />
            </button>
          ) : (
            <button
              onClick={handleSendClick}
              disabled={!input.trim() || !features.chat || !historyKey}
              className={`mc-press mc-sheen shrink-0 size-9 flex items-center justify-center rounded-control text-primary-foreground disabled:opacity-50 mc-auth-btn-primary ${
                !features.chat || !historyKey ? 'cursor-not-allowed' : ''
              }`}
              aria-label={features.chat ? "发送消息" : "AI 对话已暂停"}
              title={!features.chat ? "AI 对话已暂停" : !historyKey ? "请先选择一个章节" : undefined}
            >
              {features.chat ? (
                <Send size={14} aria-hidden="true" />
              ) : (
                <Snowflake size={14} aria-hidden="true" />
              )}
            </button>
          )}
        </div>
        {!features.chat && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Snowflake size={12} />
            AI 对话功能已冻结，请在设置中开启
          </div>
        )}
      </div>

      {/* ★ 大纲校验弹窗 */}
      <OutlineCheckModal
        visible={showOutlineCheck}
        onClose={handleOutlineCheckClose}
        actionName={pendingActionName}
      />
      {/* ★ 智能续写弹窗 */}
      <ContinueWriteModal
        visible={showContinueWrite}
        chapterTitle={currentChapter?.title ?? ''}
        onConfirm={handleContinueConfirm}
        onClose={handleContinueWriteClose}
      />
      {/* ★ 大纲填入弹窗 — 激活"大纲架构师"技能后填入大纲编辑器 */}
      <OutlineFillDialog
        isOpen={!!fillDialogContent}
        onClose={() => setFillDialogContent(null)}
        aiContent={fillDialogContent ?? ''}
        projectId={currentProject?.id ?? ''}
      />
    </div>
  );
}
