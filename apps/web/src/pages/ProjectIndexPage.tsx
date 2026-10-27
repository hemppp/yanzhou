/**
 * /project 索引页 — 当用户直接打开 /project（未指定章节）时展示
 *
 * 行为：
 * 1. 无 currentProject → 提示去书架选书
 * 2. 有项目 + 有章节 → 用 replace 跳到第一章节的编辑器（不进路由死循环）
 * 3. 有项目 + 无章节 → 展示"创建第一章"空状态（含输入框 + 创建按钮）
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { nanoid } from 'nanoid';
import { useChapterStore, useProjectStore } from '@/stores';
import { saveChapter } from '@/services/data/databaseService';
import { apiClient } from '@/services/api/apiClient';
import { useCachedQuery } from '@/hooks/useCachedQuery';
import { queryKeys } from '@/services/api/queryKeys';
import { PATHS } from '@/routes/paths';
import type { Project } from '@novel/shared';
import { BookOpen, Library, Plus, Sparkles } from 'lucide-react';

export const ProjectIndexPage: React.FC = () => {
  const navigate = useNavigate();
  // 使用独立选择器，避免订阅整个 store 导致不必要的重渲染
  const currentProject = useProjectStore(s => s.currentProject);
  const chapters = useChapterStore(s => s.chapters);
  const setCurrentChapter = useChapterStore(s => s.setCurrentChapter);
  const addChapter = useChapterStore(s => s.addChapter);
  const [newTitle, setNewTitle] = useState('');
  const [creatingBusy, setCreatingBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // —— 空态用：书架里的书 ——
  // 2026-09-15 加：原先「无项目」分支只有一行提示，直接打开 /project 的人是走到死路。
  // 这里拉一份列表，给出「一步进书」的入口。
  const setProject = useProjectStore(s => s.setProject);
  // ★ 书架列表也走缓存查询：直接打开 /project 时空态能立刻列出书（命中缓存），
  //   同时在后台校验。`enabled` 保证已有项目时完全不发请求（沿用原行为）。
  const { data: shelfData } = useCachedQuery<Project[]>(
    queryKeys.projects,
    () => apiClient.get<Project[]>('/projects'),
    { enabled: !currentProject },
  );
  const shelf = shelfData ?? [];

  /** 从空态一步进书：写 store + URL 带 bookId（与书架点书一致，刷新不会丢） */
  const openFromShelf = (b: Project) => {
    setProject(b);
    navigate(`/project/${b.id}`);
  };

  // 项目章节按 order 排序
  const projChapters = useMemo(
    () => currentProject
      ? chapters.filter(c => c.projectId === currentProject.id).slice().sort((a, b) => a.order - b.order)
      : [],
    [chapters, currentProject],
  );

  // 1️ 有项目 + 有章节 → 跳到第一章（用 ref 防止重复触发）
  const hasNavigatedRef = useRef(false);
  useEffect(() => {
    if (!currentProject) {
      hasNavigatedRef.current = false;  // 项目变化时重置
      return;
    }
    if (hasNavigatedRef.current) return;
    const first = projChapters[0];
    if (!first) return;
    hasNavigatedRef.current = true;
    // 不调用 setCurrentChapter —— ChapterEditor 挂载时会自己设置
    navigate(`/project/${currentProject.id}/${first.id}`, { replace: true });
  }, [currentProject?.id, projChapters[0]?.id]);   

  // 自动 focus 新建输入
  useEffect(() => {
    if (currentProject && projChapters.length === 0) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [currentProject?.id, projChapters.length]);

  const handleCreate = async () => {
    if (!currentProject) return;
    const title = newTitle.trim() || '第一章';
    setCreatingBusy(true);
    try {
      const newOrder = projChapters.length + 1;
      const id = nanoid();
      const now = Date.now();
      const chapter = {
        id,
        projectId: currentProject.id,
        title,
        content: '',
        order: newOrder,
        wordCount: 0,
        status: 'draft' as const,
        label: undefined,
        createdAt: now,
        updatedAt: now,
      };
      await saveChapter(chapter as never);
      addChapter({
        id,
        projectId: currentProject.id,
        title,
        content: '',
        order: newOrder,
        wordCount: 0,
        summary: undefined,
        status: 'draft',
        label: undefined,
        createdAt: now,
        updatedAt: now,
      });
      setCurrentChapter(id);
      setNewTitle('');
      // 直接跳到新章节的编辑器
      navigate(`/project/${currentProject.id}/${id}`, { replace: true });
    } catch (err) {
      console.error('[ProjectIndexPage] 创建章节失败', err);
    } finally {
      setCreatingBusy(false);
    }
  };

  // 2️⃣ 无项目 —— 空态引导卡
  // 2026-09-15 UI 优化：原版只有一个图标 + 一行小字，既无行动入口也无信息，
  // 直接访问 /project 的人等于撞墙。改成与「无章节」分支同规格的引导卡：
  // 主按钮「去书架」+ 书架里的书一步直达。
  if (!currentProject) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: 'transparent' }}>
        <div
          className="rounded-xl flex flex-col items-center"
          style={{
            maxWidth: 460,
            width: '90%',
            padding: 'var(--space-9)',
            background: 'hsla(0, 0%, 98%, 0.62)',
            backdropFilter: 'blur(12px) saturate(140%)',
            WebkitBackdropFilter: 'blur(12px) saturate(140%)',
            border: '1px solid hsl(var(--border) / 0.5)',
            boxShadow: '0 4px 16px hsl(var(--ink) / 0.05)',
            textAlign: 'center',
          }}
        >
          <BookOpen size={28} style={{ color: 'hsl(var(--ink-light))' }} className="mb-3" />
          <h2
            style={{
              fontFamily: "'Noto Serif SC', serif",
              fontSize: 16.5,
              fontWeight: 600,
              color: 'hsl(var(--ink))',
              margin: '0 0 var(--space-2)',
            }}
          >
            还没有打开任何书
          </h2>
          <p
            style={{
              fontFamily: "'Noto Serif SC', serif",
              fontSize: 12,
              color: 'hsl(var(--ink-light))',
              margin: '0 0 var(--space-7)',
            }}
          >
            从书架挑一本继续写，或新建一本
          </p>
          <button
            type="button"
            onClick={() => navigate(PATHS.bookshelf)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-md transition-all"
            style={{
              fontFamily: "'Noto Serif SC', serif",
              fontSize: 12,
              color: 'hsl(var(--card))',
              background: 'hsl(var(--mountain-deep))',
              // ★ 这里原本有内联 `border: 'none'`（2026-09-19 删）：
              //   `border-style: none` 时 **border-image 根本不绘制** →
              //   主题层的按钮外框穿不上（元素级规则被静默吃掉）。
              //   删掉无副作用：ink 主题下 Tailwind preflight 本来就是 `border-width: 0`。
              //   ⚠️ 本文件另一处「开始写作」按钮（~316 行）同样处理。
              cursor: 'pointer',
            }}
          >
            <Library size={14} />
            去书架
          </button>

          {shelf.length > 0 && (
            <div className="w-full" style={{ marginTop: 'var(--space-8)' }}>
              <div className="flex items-center gap-2" style={{ color: 'hsl(var(--ink-pale))', marginBottom: 'var(--space-4)' }}>
                <span style={{ flex: 1, height: 1, background: 'hsl(var(--border) / 0.6)' }} />
                <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 10, letterSpacing: '0.1em' }}>
                  书架里的书
                </span>
                <span style={{ flex: 1, height: 1, background: 'hsl(var(--border) / 0.6)' }} />
              </div>
              <div className="flex flex-col gap-1.5">
                {shelf.slice(0, 5).map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => openFromShelf(b)}
                    // ★ 导航项（打开某本书），不是动作按钮 → nm-nav-item 显式豁免笔触
                    className="nm-nav-item w-full px-3 py-2 rounded-md transition-all text-left truncate"
                    style={{
                      fontFamily: "'Noto Serif SC', serif",
                      fontSize: 12,
                      color: 'hsl(var(--ink))',
                      background: 'hsl(var(--card) / 0.6)',
                      // ★ 拆长写：让豁免完全由 nm-nav-item 显式承担，
                      //   不依赖「inline border 简写重置 border-image」这个隐式副作用
                      borderWidth: '1px',
                      borderStyle: 'solid',
                      borderColor: 'hsl(var(--border) / 0.5)',
                      cursor: 'pointer',
                    }}
                    title={b.name}
                  >
                    《{b.name}》
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // 3️⃣ 有项目 + 有章节 → useEffect 已经在 redirect 中，渲染一个轻量占位避免空白闪烁
  if (projChapters.length > 0) {
    return (
      <div
        className="h-full flex items-center justify-center"
        style={{ background: 'transparent', color: 'hsl(var(--ink-light))' }}
      >
        <div
          className="flex items-center gap-2"
          style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 12 }}
        >
          <Sparkles size={14} style={{ color: 'hsl(var(--mountain-deep))' }} />
          正在打开《{currentProject.name}》的编辑器…
        </div>
      </div>
    );
  }

  // 4️⃣ 有项目 + 无章节 → 空状态 + 创建第一章
  return (
    <div
      className="h-full flex items-center justify-center"
      style={{ background: 'transparent' }}
    >
      <div
        className="rounded-xl flex flex-col items-center"
        style={{
          maxWidth: 440,
          width: '90%',
          padding: 'var(--space-9)',
          background: 'hsla(0, 0%, 98%, 0.62)',
          backdropFilter: 'blur(12px) saturate(140%)',
          WebkitBackdropFilter: 'blur(12px) saturate(140%)',
          border: '1px solid hsl(var(--border) / 0.5)',
          boxShadow: '0 4px 16px hsl(var(--ink) / 0.05)',
          textAlign: 'center',
        }}
      >
        <Sparkles size={28} style={{ color: 'hsl(var(--mountain-deep))' }} className="mb-3" />
        <h2
          style={{
            fontFamily: "'Noto Serif SC', serif",
            fontSize: 16.5,
            fontWeight: 600,
            color: 'hsl(var(--ink))',
            margin: '0 0 var(--space-2)',
          }}
        >
          《{currentProject.name}》还没有章节
        </h2>
        <p
          style={{
            fontFamily: "'Noto Serif SC', serif",
            fontSize: 12,
            color: 'hsl(var(--ink-light))',
            margin: '0 0 var(--space-7)',
          }}
        >
          创建第一章，开始你的写作之旅
        </p>
        <div className="flex items-center gap-2 w-full">
          <input
            ref={inputRef}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
            }}
            placeholder="章节标题（留空则默认「第一章」）"
            disabled={creatingBusy}
            className="flex-1 px-3 py-2 rounded-md outline-none transition-all"
            style={{
              fontFamily: "'Noto Serif SC', serif",
              fontSize: 12,
              color: 'hsl(var(--ink))',
              background: 'hsl(var(--card))',
              border: '1px solid hsl(var(--mountain-deep) / 0.3)',
            }}
          />
          <button
            onClick={() => void handleCreate()}
            disabled={creatingBusy}
            className="flex items-center gap-1.5 px-4 py-2 rounded-md transition-all disabled:opacity-50"
            style={{
              fontFamily: "'Noto Serif SC', serif",
              fontSize: 12,
              color: 'hsl(var(--card))',
              background: 'hsl(var(--mountain-deep))',
              // 同「去书架」按钮：删掉内联 `border: 'none'`，否则主题层外框穿不上
            }}
          >
            <Plus size={14} />
            {creatingBusy ? '创建中…' : '开始写作'}
          </button>
        </div>
      </div>
    </div>
  );
};

