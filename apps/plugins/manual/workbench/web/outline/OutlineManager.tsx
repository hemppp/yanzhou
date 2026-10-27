// ============================================================
// 大纲编辑器（纯文本存储器 + 网文大纲模板）
//
// 重构说明：
//   - 移除"AI 智能生成"与分区的 AI 续写 / AI 优化，大纲回归纯文本存储器
//   - 新增"网文大纲模板"模块：核心冲突文本框 + 每章细节文本框（按章节列表动态生成）
//   - 保留原"自由笔记分区"功能（纯文本，无 AI）
//   - AI 编写大纲改为通过"大纲架构师"技能对话 + 填入弹窗实现
//   - 数据通过 outlineNotepadStore 统一管理，AI 填入弹窗可共享
// ============================================================

import { useEffect, useState, useCallback, useMemo } from 'react';
import { nanoid } from 'nanoid';
import {
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  GripVertical,
  AlertCircle,
  FileText,
  Trash,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Target,
} from 'lucide-react';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import { useOutlineStore, useChapterStore } from '@novel-plugins/data-core/stores';
import { useOutlineNotepadStore, type NotepadSection } from '@novel-plugins/data-core/stores';
import { safeConfirm } from '@novel-plugins/ui-kit/safeConfirm';
import { dispatchToastEvent } from '@novel-plugins/ui-kit/errors';

// ---- 默认分区定义（用于"恢复默认分区"） ----

const DEFAULT_SECTION_DEFS: Omit<NotepadSection, 'id'>[] = [
  { title: '一句话故事', content: '', placeholder: '用一句话讲清楚主角、冲突与转折，让人一听就想读这本书。' },
  { title: '核心主题', content: '', placeholder: '这个故事想表达什么？爱 / 救赎 / 自由 / 身份认同……' },
  { title: '类型与风格', content: '', placeholder: '类型（玄幻 / 都市 / 悬疑 / 科幻 / 历史…）与文风（冷硬 / 诙谐 / 诗意 / 朴实）。' },
  { title: '故事背景', content: '', placeholder: '时间 / 地点 / 世界观 / 社会形态 / 关键设定。' },
  { title: '视角与时间线', content: '', placeholder: '第几人称、过去还是现在时、故事跨度多久。' },
  { title: '主要人物', content: '', placeholder: '主角 / 关键配角 / 反派各一行：核心动机、性格、外在标签。' },
  { title: '故事梗概', content: '', placeholder: '用一段话描述主线走向（不必剧透结局）。' },
  { title: '结构框架', content: '', placeholder: '开端 / 发展 / 高潮 / 结局大致安排；或三幕剧 / 英雄之旅节点。' },
  { title: '开场与结尾', content: '', placeholder: '故事如何开篇？如何收束？两个画面是否形成呼应？' },
  { title: '伏笔与悬念', content: '', placeholder: '哪里埋下伏笔 / 哪里揭示 / 哪些反转值得保留到最后。' },
  { title: '基调与意象', content: '', placeholder: '整体氛围、反复出现的意象、希望读者读完后留下的"味道"。' },
  { title: '备注', content: '', placeholder: '其他灵感、参考作品、写作禁忌……' },
];

// ---- 主组件 ----

export function OutlineManager() {
  const projectId = useCurrentProjectId();
  const treeNodes = useOutlineStore((s) => s.nodes);
  const setTreeNodes = useOutlineStore((s) => s.setNodes);

  // ★ 从 store 获取大纲数据
  const loadProject = useOutlineNotepadStore((s) => s.loadProject);
  const dataByProject = useOutlineNotepadStore((s) => s.dataByProject);
  const setCoreConflict = useOutlineNotepadStore((s) => s.setCoreConflict);
  const setChapterDetail = useOutlineNotepadStore((s) => s.setChapterDetail);
  const setSections = useOutlineNotepadStore((s) => s.setSections);

  // ★ 章节列表（用于"每章细节"文本框）
  const chapters = useChapterStore((s) => s.chapters);

  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  // ★ 折叠状态：每章细节默认折叠，避免占屏
  const [collapsedChapters, setCollapsedChapters] = useState<Record<string, boolean>>({});
  const [templateCollapsed, setTemplateCollapsed] = useState(false);

  // 打开项目时加载
  useEffect(() => {
    if (!projectId) {
      setInitialized(false);
      return;
    }
    loadProject(projectId);
    setInitialized(true);
  }, [projectId, loadProject]);

  const notepadData = projectId ? dataByProject[projectId] : undefined;
  const sections = notepadData?.sections ?? [];
  const coreConflict = notepadData?.coreConflict ?? '';
  const chapterDetails = notepadData?.chapterDetails ?? {};

  // 排序后的章节（按 order 升序，过滤软删除）
  const sortedChapters = useMemo(() => {
    return [...chapters]
      .filter((c) => !c.deletedAt)
      .sort((a, b) => a.order - b.order);
  }, [chapters]);

  // ---- 分区操作 ----

  const updateSection = useCallback(
    (id: string, patch: Partial<NotepadSection>) => {
      if (!projectId) return;
      const next = sections.map((s) => (s.id === id ? { ...s, ...patch } : s));
      setSections(projectId, next);
    },
    [projectId, sections, setSections]
  );

  const addSection = useCallback(
    (afterId?: string) => {
      if (!projectId) return;
      const newSection: NotepadSection = {
        id: nanoid(10),
        title: '新建分区',
        content: '',
        placeholder: '请填写…',
      };
      const next = afterId
        ? (() => {
            const idx = sections.findIndex((s) => s.id === afterId);
            if (idx < 0) return [...sections, newSection];
            return [...sections.slice(0, idx + 1), newSection, ...sections.slice(idx + 1)];
          })()
        : [...sections, newSection];
      setSections(projectId, next);
      setEditingTitleId(newSection.id);
    },
    [projectId, sections, setSections]
  );

  const removeSection = useCallback(
    (id: string) => {
      if (!projectId) return;
      const next = sections.filter((s) => s.id !== id);
      setSections(projectId, next);
      if (editingTitleId === id) setEditingTitleId(null);
    },
    [projectId, sections, setSections, editingTitleId]
  );

  const moveSection = useCallback(
    (id: string, dir: -1 | 1) => {
      if (!projectId) return;
      const idx = sections.findIndex((s) => s.id === id);
      if (idx < 0) return;
      const target = idx + dir;
      if (target < 0 || target >= sections.length) return;
      const next = [...sections];
      const removed = next.splice(idx, 1);
      const item = removed[0];
      if (!item) return;
      next.splice(target, 0, item);
      setSections(projectId, next);
    },
    [projectId, sections, setSections]
  );

  const handleResetToDefault = () => {
    if (
      !safeConfirm(
        '将根据默认分区重建列表，已有内容会保留（按标题匹配），缺失的会追加在末尾。是否继续？'
      )
    ) {
      return;
    }
    if (!projectId) return;
    const existingByTitle = new Map(
      sections.map((s) => [s.title.trim(), s] as const)
    );
    const next: NotepadSection[] = [];
    for (const def of DEFAULT_SECTION_DEFS) {
      const hit = existingByTitle.get(def.title.trim());
      if (hit) {
        next.push({ ...hit, placeholder: def.placeholder });
        existingByTitle.delete(def.title.trim());
      } else {
        next.push({ ...def, id: nanoid(10) });
      }
    }
    for (const s of Array.from(existingByTitle.values())) {
      if (s) next.push(s);
    }
    setSections(projectId, next);
  };

  const handleClearLegacyTree = () => {
    if (!safeConfirm('将清空旧的"树形大纲节点"数据（旧版已弃用）。是否继续？')) return;
    try {
      setTreeNodes([]);
      dispatchToastEvent({ type: 'success', message: '已清空旧树形大纲数据' });
    } catch {
      dispatchToastEvent({ type: 'error', message: '清空失败' });
    }
  };

  const handleClearChapterDetail = (chapterId: string, chapterTitle: string) => {
    if (!projectId) return;
    if (!safeConfirm(`清空「${chapterTitle}」的章节细节？`)) return;
    setChapterDetail(projectId, chapterId, '');
  };

  // 统计
  const stats = useMemo(() => {
    const filled = sections.filter((s) => s.content.trim().length > 0).length;
    const sectionChars = sections.reduce((sum, s) => sum + s.content.length, 0);
    const chapterDetailChars = Object.values(chapterDetails).reduce(
      (sum, t) => sum + (t?.length ?? 0),
      0
    );
    return {
      filled,
      total: sections.length,
      totalChars: sectionChars + chapterDetailChars + coreConflict.length,
    };
  }, [sections, chapterDetails, coreConflict]);

  if (!projectId) {
    return (
      <div
        className="h-full flex items-center justify-center"
        
      >
        <div className="text-center">
          <AlertCircle size={48} className="mx-auto text-muted-foreground/40 mb-4" />
          <p className="text-sm text-muted-foreground">请先选择项目</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" >
      {/* Toolbar */}
      <div
        className="px-6 py-3 flex items-center gap-2"
        
      >
        <div className="flex items-center gap-2">
          <FileText size={16} style={{ color: 'hsl(var(--primary))' }} />
          <h2 className="text-sm font-semibold text-foreground">大纲编辑器</h2>
        </div>

        <span className="text-xs text-muted-foreground ml-2">
          {stats.filled}/{stats.total} 分区 · {stats.totalChars} 字
        </span>

        <div className="flex-1" />

        <button
          onClick={handleResetToDefault}
          className="text-xs rounded-xl px-2.5 py-1.5 flex items-center gap-1.5 transition-colors text-muted-foreground hover:bg-muted/60"
          // ★ 拆长写：`border` 简写会重置 border-image 相关长写属性。
          //   （2026-09-18 由浮窗面板扫描抓出；全仓同类还有约 59 处，见
          //    .workbuddy/ui-checks/count-inline-borders.mjs 的统计）
          style={{
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: 'rgba(15,15,15,0.12)',
          }}
          title="按默认分区补全（已有内容按标题保留）"
        >
          <RotateCcw size={11} /> 恢复默认分区
        </button>
        {treeNodes.length > 0 && (
          <button
            onClick={handleClearLegacyTree}
            className="text-xs rounded-xl px-2.5 py-1.5 flex items-center gap-1.5 transition-colors text-destructive border border-destructive/30 hover:bg-destructive/10"
            title="清空旧版树形大纲节点数据"
          >
            <Trash size={11} /> 清空旧数据 ({treeNodes.length})
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-5 space-y-5">
          {!initialized ? null : (
            <>
              {/* ===== 网文大纲模板模块 ===== */}
              <TemplateSection
                coreConflict={coreConflict}
                onCoreConflictChange={(v) => setCoreConflict(projectId, v)}
                chapters={sortedChapters}
                chapterDetails={chapterDetails}
                collapsedChapters={collapsedChapters}
                onToggleChapter={(cid) =>
                  setCollapsedChapters((prev) => ({ ...prev, [cid]: !prev[cid] }))
                }
                templateCollapsed={templateCollapsed}
                onToggleTemplate={() => setTemplateCollapsed((v) => !v)}
                onChapterDetailChange={(cid, v) => setChapterDetail(projectId, cid, v)}
                onClearChapterDetail={handleClearChapterDetail}
              />

              {/* ===== 自由笔记分区 ===== */}
              <div>
                <div className="flex items-center gap-2 mb-3 px-1">
                  <BookOpen size={13} style={{ color: 'hsl(var(--muted-foreground))' }} />
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    自由笔记分区
                  </h3>
                  <div className="flex-1 h-px" style={{ background: 'rgba(15,15,15,0.06)' }} />
                </div>

                {sections.length === 0 ? (
                  <EmptyState onAdd={() => addSection()} />
                ) : (
                  <div className="space-y-4">
                    {sections.map((section, idx) => (
                      <SectionCard
                        key={section.id}
                        section={section}
                        isFirst={idx === 0}
                        isLast={idx === sections.length - 1}
                        isEditingTitle={editingTitleId === section.id}
                        onStartEditTitle={() => setEditingTitleId(section.id)}
                        onFinishEditTitle={() => setEditingTitleId(null)}
                        onChangeTitle={(v) => updateSection(section.id, { title: v })}
                        onChangeContent={(v) => updateSection(section.id, { content: v })}
                        onMoveUp={() => moveSection(section.id, -1)}
                        onMoveDown={() => moveSection(section.id, 1)}
                        onDelete={() => {
                          if (safeConfirm(`删除分区「${section.title || '未命名'}」？`)) {
                            removeSection(section.id);
                          }
                        }}
                        onAddBelow={() => addSection(section.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      {initialized && (
        <div
          className="px-6 py-3"
          
        >
          <div className="max-w-3xl mx-auto flex items-center gap-2">
            <button
              onClick={() => addSection()}
              className="text-xs font-medium rounded-xl px-3 py-1.5 flex items-center gap-1.5 transition-colors text-white hover:brightness-110"
              style={{ background: 'hsl(var(--primary))' }}
            >
              <Plus size={12} /> 添加分区
            </button>
            <span className="text-[10px] text-muted-foreground">
              内容自动保存到本地 · 激活"大纲架构师"技能可与 AI 讨论并填入大纲
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- 网文大纲模板模块 ----

interface TemplateSectionProps {
  coreConflict: string;
  onCoreConflictChange: (v: string) => void;
  chapters: Array<{ id: string; title: string; order: number }>;
  chapterDetails: Record<string, string>;
  collapsedChapters: Record<string, boolean>;
  onToggleChapter: (chapterId: string) => void;
  templateCollapsed: boolean;
  onToggleTemplate: () => void;
  onChapterDetailChange: (chapterId: string, v: string) => void;
  onClearChapterDetail: (chapterId: string, chapterTitle: string) => void;
}

function TemplateSection({
  coreConflict,
  onCoreConflictChange,
  chapters,
  chapterDetails,
  collapsedChapters,
  onToggleChapter,
  templateCollapsed,
  onToggleTemplate,
  onChapterDetailChange,
  onClearChapterDetail,
}: TemplateSectionProps) {
  return (
    <div
      className="rounded-2xl"
      style={{
        background: 'transparent',
        // 墨阶化（2026-09-16）：原为 sky 系 rgba(14,165,233,…)，
        // 是上轮 hex 批量替换漏掉的逗号写法（只匹配了 #0ea5e9 形式）。
        border: '1px solid hsl(var(--border) / 0.6)',
        boxShadow: '0 1px 3px hsl(var(--foreground) / 0.04)',
      }}
    >
      {/* 模块标题 */}
      <button
        onClick={onToggleTemplate}
        className="w-full flex items-center gap-2 px-4 py-3 transition-colors hover:bg-foreground/5 rounded-t-2xl"
      >
        {templateCollapsed ? <ChevronRight size={14} style={{ color: 'hsl(var(--muted-foreground))' }} /> : <ChevronDown size={14} style={{ color: 'hsl(var(--muted-foreground))' }} />}
        <Target size={14} style={{ color: 'hsl(var(--muted-foreground))' }} />
        <h3 className="text-sm font-semibold text-foreground">网文大纲模板</h3>
        <span className="text-[10px] text-muted-foreground ml-1">
          核心冲突 · 每章细节
        </span>
        <div className="flex-1" />
        <span className="text-[10px] text-muted-foreground/50">点击{templateCollapsed ? '展开' : '折叠'}</span>
      </button>

      {!templateCollapsed && (
        <div className="px-4 pb-4 space-y-4">
          {/* 核心冲突 */}
          <div>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-foreground mb-1.5">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: 'hsl(var(--destructive))' }}
              />
              核心冲突
            </label>
            <textarea
              value={coreConflict}
              onChange={(e) => onCoreConflictChange(e.target.value)}
              placeholder="主角想要什么？谁 / 什么在阻止？冲突的根源是什么？例：一个自卑的高中生意外获得读心能力，却发现周围人表面的善意下藏着算计，他必须在信任与自我保护之间抉择……"
              className="w-full bg-transparent outline-none resize-y text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/50 rounded-xl px-3 py-2.5"
              style={{
                minHeight: '90px',
                background: 'hsl(var(--foreground) / 0.03)',
                border: '1px solid hsl(var(--border) / 0.5)',
                fontFamily: '"Songti SC", "Source Han Serif", "Noto Serif CJK SC", Georgia, serif',
              }}
              spellCheck={false}
            />
            <div className="text-[10px] text-muted-foreground/50 mt-1 px-1">
              {coreConflict.trim() ? `${coreConflict.trim().length} 字` : '空白'}
            </div>
          </div>

          {/* 每章细节 */}
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground mb-1.5">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: 'hsl(var(--entity-outline))' }}
              />
              每章细节
              <span className="text-[10px] text-muted-foreground font-normal ml-1">
                （{chapters.length} 章）
              </span>
            </div>

            {chapters.length === 0 ? (
              <div
                className="text-xs text-muted-foreground rounded-xl px-3 py-4 text-center"
                style={{ background: 'rgba(15,15,15,0.02)', border: '1px dashed rgba(15,15,15,0.1)' }}
              >
                还没有章节，请先在章节列表中创建章节
              </div>
            ) : (
              <div className="space-y-2">
                {chapters.map((ch) => {
                  const detail = chapterDetails[ch.id] ?? '';
                  // 默认：有内容展开，无内容折叠；用户点击后记住状态
                  const collapsed = collapsedChapters[ch.id] ?? !detail.trim();
                  return (
                    <div
                      key={ch.id}
                      className="rounded-xl"
                      style={{
                        border: '1px solid rgba(15,15,15,0.06)',
                        background: detail.trim() ? 'hsl(var(--background) / 0.6)' : 'transparent',
                      }}
                    >
                      {/* 章节标题行 */}
                      <div className="flex items-center gap-1.5 px-3 py-2">
                        <button
                          onClick={() => onToggleChapter(ch.id)}
                          className="p-0.5 rounded-lg hover:bg-muted/60 transition-colors"
                          aria-label={collapsed ? '展开' : '折叠'}
                        >
                          {collapsed ? (
                            <ChevronRight size={12} style={{ color: 'hsl(var(--muted-foreground))' }} />
                          ) : (
                            <ChevronDown size={12} style={{ color: 'hsl(var(--muted-foreground))' }} />
                          )}
                        </button>
                        <span
                          className="text-[10px] font-mono px-1.5 py-0.5 rounded-md"
                          style={{
                            background: 'hsl(var(--foreground) / 0.1)',
                            color: 'hsl(var(--foreground))',
                          }}
                        >
                          第{ch.order}章
                        </span>
                        <button
                          onClick={() => onToggleChapter(ch.id)}
                          className="flex-1 text-left text-sm text-foreground truncate hover:text-foreground transition-colors"
                          title={ch.title}
                        >
                          {ch.title || '未命名章节'}
                        </button>
                        {detail.trim() && (
                          <span className="text-[10px] text-muted-foreground/50">{detail.trim().length} 字</span>
                        )}
                        {detail.trim() && (
                          <button
                            onClick={() => onClearChapterDetail(ch.id, ch.title || `第${ch.order}章`)}
                            className="p-1 rounded-lg hover:bg-destructive/10 transition-colors"
                            title="清空本章细节"
                            aria-label="清空本章细节"
                          >
                            <Trash2 size={11} style={{ color: 'hsl(var(--destructive))' }} />
                          </button>
                        )}
                      </div>
                      {/* 章节细节文本框 */}
                      {!collapsed && (
                        <div className="px-3 pb-3">
                          <textarea
                            value={detail}
                            onChange={(e) => onChapterDetailChange(ch.id, e.target.value)}
                            placeholder={`第${ch.order}章 细节：本章核心事件、冲突推进、角色行动、伏笔铺设/回收、章节结尾钩子……`}
                            className="w-full bg-transparent outline-none resize-y text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/50 rounded-lg px-2.5 py-2"
                            style={{
                              minHeight: '80px',
                              background: 'rgba(15,15,15,0.015)',
                              border: '1px solid rgba(15,15,15,0.05)',
                              fontFamily: '"Songti SC", "Source Han Serif", "Noto Serif CJK SC", Georgia, serif',
                            }}
                            spellCheck={false}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- 自由笔记分区卡片 ----

interface SectionCardProps {
  section: NotepadSection;
  isFirst: boolean;
  isLast: boolean;
  isEditingTitle: boolean;
  onStartEditTitle: () => void;
  onFinishEditTitle: () => void;
  onChangeTitle: (v: string) => void;
  onChangeContent: (v: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onAddBelow: () => void;
}

function SectionCard({
  section,
  isFirst,
  isLast,
  isEditingTitle,
  onStartEditTitle,
  onFinishEditTitle,
  onChangeTitle,
  onChangeContent,
  onMoveUp,
  onMoveDown,
  onDelete,
  onAddBelow,
}: SectionCardProps) {
  const isEmpty = !section.content.trim();
  const charCount = section.content.length;

  return (
    <div
      className="rounded-xl transition-shadow"
      style={{
        background: 'transparent',
        border: '1px solid rgba(15,15,15,0.08)',
        boxShadow: '0 1px 2px rgba(15,15,15,0.02)',
      }}
    >
      {/* 标题行 */}
      <div
        className="flex items-center gap-1.5 px-3 py-2.5"
        style={{ borderBottom: '1px solid rgba(15,15,15,0.05)' }}
      >
        <span className="text-muted-foreground/50">
          <GripVertical size={12} />
        </span>
        {isEditingTitle ? (
          <input
            value={section.title}
            onChange={(e) => onChangeTitle(e.target.value)}
            onBlur={onFinishEditTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') onFinishEditTitle();
            }}
            autoFocus
            className="flex-1 text-sm font-semibold text-foreground bg-transparent outline-none px-1 py-0.5 rounded-[14px]"
            style={{ border: '1px solid hsl(var(--ring) / 0.5)' }}
          />
        ) : (
          <button
            onClick={onStartEditTitle}
            className="flex-1 text-left text-sm font-semibold text-foreground truncate px-1 py-0.5 rounded-xl hover:bg-foreground/[0.03]"
            title="点击修改分区标题"
          >
            {section.title || '未命名分区'}
          </button>
        )}

        <IconButton onClick={onMoveUp} disabled={isFirst} title="上移" aria-label="上移分区">
          <ArrowUp size={11} />
        </IconButton>
        <IconButton onClick={onMoveDown} disabled={isLast} title="下移" aria-label="下移分区">
          <ArrowDown size={11} />
        </IconButton>
        <IconButton onClick={onAddBelow} title="下方插入新分区" aria-label="下方插入新分区">
          <Plus size={12} />
        </IconButton>
        <IconButton onClick={onDelete} title="删除分区" aria-label="删除分区" danger>
          <Trash2 size={11} />
        </IconButton>
      </div>

      {/* 内容区 */}
      <div className="px-4 py-3">
        <textarea
          value={section.content}
          onChange={(e) => onChangeContent(e.target.value)}
          placeholder={section.placeholder}
          className="w-full bg-transparent outline-none resize-y text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/50"
          style={{
            minHeight: '110px',
            fontFamily: '"Songti SC", "Source Han Serif", "Noto Serif CJK SC", Georgia, serif',
          }}
          spellCheck={false}
        />
        <div className="flex items-center justify-end mt-2">
          <div className="text-[10px] text-muted-foreground/50">
            {isEmpty
              ? '空白'
              : `${section.content.trim().length} 字${charCount !== section.content.trim().length ? ` · ${charCount} 字符` : ''}`}
          </div>
        </div>
      </div>
    </div>
  );
}

function IconButton({
  onClick,
  disabled,
  title,
  children,
  danger,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`inline-flex items-center justify-center min-w-6 min-h-6 p-1 rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        disabled
          ? ''
          : danger
            ? 'hover:bg-destructive/10'
            : 'hover:bg-muted/60'
      }`}
      style={{ color: danger ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))' }}
    >
      {children}
    </button>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="text-center py-8">
      <p className="text-sm text-muted-foreground">还没有任何分区</p>
      <button
        onClick={onAdd}
        className="mt-3 w-full text-xs font-medium rounded-xl px-3 py-1.5 flex items-center justify-center gap-1.5 transition-colors bg-primary text-primary-foreground hover:opacity-90"
      >
        <Plus size={12} /> 添加第一个分区
      </button>
    </div>
  );
}
