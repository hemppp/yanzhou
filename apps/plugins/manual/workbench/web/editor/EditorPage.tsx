import { EditorContent } from '@tiptap/react';
import { useChapterStore, useProjectStore, useCharacterStore } from '@novel-plugins/data-core/stores';
import { useChapterJumpStore } from '../stores/chapterJumpStore';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { PATHS } from '@/routes/paths';
import { gsap, useGSAP } from '@novel-plugins/ui-kit/gsap';
import { pickFallbackChapterId } from '../utils/chapter';
import { SelectionMenu } from './SelectionMenu';
import { ForeshadowWarning } from '../foreshadow/ForeshadowWarning';
import { StyleAdvisor } from './panels/StyleAdvisor';
import { styleService } from '@novel-plugins/data-core/editor/styleService';
import type { StyleProfile } from '@novel-plugins/data-core/editor/styleService';
import { PluginEditorToolbar } from './PluginEditorToolbar';
import { EditorPanelRail } from './EditorPanelRail';
import { useEditorInstance } from './hooks/useEditorInstance';
import { useAnnotationBlockBridge } from './hooks/useAnnotationBlockBridge';
import { buildChapterMetaSegments } from './chapterMeta';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useAutoEntityDetection } from '../hooks/useAutoEntityDetection';
import { useLatestChapterPolling } from '../hooks/useLatestChapterPolling';
import { useEntityChapterSync } from '../hooks/useEntityChapterSync';
import { htmlToText, ensureHtmlContent } from '@novel-plugins/data-core/editor/entityDetector';
import { FileText, Plus, BookOpen as BookOpenIcon, Rows3, ScrollText } from 'lucide-react';
import { FindReplaceBar } from './FindReplaceBar';
// ★ 2026-10-26 页面视图（A4 稿纸分页）：纸卡片/页码层 + 分页行为（量页/翻页/缩放/光标跟随）
import { PageLayer } from './PageLayer';
import { usePageView } from './hooks/usePageView';
import { saveSnapshot, saveChapter } from '@novel-plugins/data-core/data/databaseService';
import { getCachedChapterContent, cacheChapterContent } from '@novel-plugins/data-core/data/chapterLocalCache';
import { nanoid } from 'nanoid';
import type { Snapshot } from '@novel/shared';

// ★ 样式常量：避免每次渲染创建新对象
// ★ 2026-10-29 左对齐改版：标题原为 `textAlign:'center'` + 正文居中，
//   整页以中线对称。作者本轮选定「左对齐」（见 globals.css `.ProseMirror` 的
//   同一批改动）—— 正文左对齐后，标题若仍居中，两者各有一条中轴，
//   视觉上会「对不齐」：标题看起来像被随手摆在中间。故标题与元信息行
//   一并改为左对齐，与正文共享同一条左基线。
const TITLE_INPUT_STYLE: React.CSSProperties = {
  fontSize: '26px',
  fontWeight: 700,
  color: 'hsl(var(--ink))',
  backgroundColor: 'transparent',
  border: 'none',
  outline: 'none',
  lineHeight: '1.3',
  textAlign: 'left',
};

const SUBTITLE_STYLE: React.CSSProperties = {
  color: 'hsl(var(--mountain-deep))',
};

/** 页面视图偏好的 localStorage 键（视图偏好，缺省**关**；见 readPageViewPref）。 */
const PAGE_VIEW_LS_KEY = 'novelmuse.editor.pageView';

/**
 * 页面视图偏好：缺省**关**（用户口径 2026-10-27「内容纸张不要分页」）。
 *
 * ★ 口径变更史（勿凭直觉改回去）：
 *   2026-10-26 曾按「像 Word 那样分页」做成默认**开**；次日作者看过实际观感后明确要求
 *   「内容纸张不要分页」⇒ 默认回到**连续视图**（无边、一整个长卷）。
 *   纸张分页能力**保留**（工具栏那个开关仍能切），只是不再是默认。
 *   偏好仍记在 localStorage：只有显式切到页面视图过（写 '1'），才会恢复成页面视图。
 */
function readPageViewPref(): boolean {
  try {
    return localStorage.getItem(PAGE_VIEW_LS_KEY) === '1';
  } catch {
    return false; // 隐私模式 / 存储被禁：按默认（连续视图）
  }
}

/** 元信息行的一段；四段全部来自真实数据，缺失时整段不进入数组（不渲染空占位/null） */

/**
 * 内容签名（djb2 变体）—— 用于「内容没实质变化就别再打 AI 请求」。
 * 与 StyleAdvisor 内的同名函数是**各自独立**的实现（有意不共享：
 * 两处防抖策略不同，耦合只会让任一侧的调整牵动另一侧）。
 */
function styleContentSignature(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

export function EditorPage() {
  const [styleProfile, setStyleProfile] = useState<StyleProfile | null>(null);
  const [findVisible, setFindVisible] = useState(false);
  // 上次已发起分析的正文签名（跨 render 保留，见下方风格学习 effect 的注释）
  const lastStyleSigRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollHostRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  // 拆 selector：原一次性订阅整个 store 导致 addWords、setXxx 都触发 re-render。
  // 现在每个 selector 独立，只有对应字段变化才 re-render。
  const chapters = useChapterStore((s) => s.chapters);
  const currentChapterId = useChapterStore((s) => s.currentChapterId);
  const getCurrentChapter = useChapterStore((s) => s.getCurrentChapter);
  const updateChapter = useChapterStore((s) => s.updateChapter);
  const currentProject = useProjectStore((s) => s.currentProject);
  /** 角色表：用于推导「在场人物」（角色 `chapters` 存的是出场章节的 order 序号） */
  const characters = useCharacterStore((s) => s.characters);
  const jumpSignal = useChapterJumpStore((s) => s.jumpSignal);
  const jumpAnchor = useChapterJumpStore((s) => s.jumpAnchor);

  const currentChapter = getCurrentChapter();

  // ★ 「最近章节」= 当前项目里 updatedAt 最新的那一章。
  //   早先按钮直接取 `chapters[0]`，但后端 listChapters 按 `order` 升序返回
  //   （chapter-service.ts），于是它打开的是**第一章** —— 与文案不符：
  //   空状态页的用途是「接着上次写」，对写作者来说"第一章"没有意义。
  //   后端 updateChapter 每次保存都会刷新 updatedAt，所以这个定义可靠。
  //   按 projectId 过滤，与 handleCreateChapter 的计数口径保持一致
  //   （store 在同一次会话里切换项目时可能短暂混有其它项目的章节）。
  //   口径与 ChapterEditor 的失效链接兜底共用 pickFallbackChapterId。
  const recentChapterId = useMemo(() => {
    const scoped = currentProject
      ? chapters.filter((c) => c.projectId === currentProject.id)
      : chapters;
    return pickFallbackChapterId(scoped);
  }, [chapters, currentProject]);

  const {
    editor,
    liveWordCount,
    prevWordCount: _prevWordCount,
    resetWordCount,
  } = useEditorInstance({
    initialContent: currentChapter?.content,
    styleProfile,
  });

  const editorRef = useRef(editor);
  editorRef.current = editor;

  // ---- 页面视图（A4 稿纸分页）：视图偏好 + 分页行为 ----
  // ★ 用户口径（2026-10-27）：「内容纸张不要分页」⇒ 默认连续视图；
  //   纸张分页（2026-10-26 做的 A4 纸页 + 页码）保留为**可选**视图，开关在标题行。
  //   偏好存 localStorage 而非服务端 KV：它与「面板开合」同量级（视图偏好，
  //   不是作品/排版数据），panelOpenStore 也是 localStorage 口径。
  const [pageView, setPageView] = useState<boolean>(readPageViewPref);
  const togglePageView = useCallback(() => {
    setPageView((on) => {
      const next = !on;
      try { localStorage.setItem(PAGE_VIEW_LS_KEY, next ? '1' : '0'); } catch { /* 隐私模式：静默 */ }
      return next;
    });
  }, []);
  const page = usePageView({ enabled: pageView, hostRef: scrollHostRef });

  // 空章节状态下「新建章节」：同步落库 + 写内存 + 打开新章，兑现空状态文案承诺
  const handleCreateChapter = useCallback(async () => {
    if (!currentProject) return;
    const id = nanoid();
    const now = Date.now();
    // ★ 按 当前项目 的章节数计算 order，避免跨项目导致编号不连续
    const projectChapterCount = chapters.filter(c => c.projectId === currentProject.id).length;
    const order = projectChapterCount + 1;
    const chapter = {
      id,
      projectId: currentProject.id,
      title: `第 ${order} 章`,
      content: '',
      order,
      wordCount: 0,
      summary: undefined,
      status: 'draft' as const,
      label: undefined,
      pov: undefined,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await saveChapter(chapter as never);
      useChapterStore.getState().addChapter(chapter as never);
      useChapterStore.getState().setCurrentChapter(id);
    } catch (e) {
      console.error('创建章节失败:', e);
    }
  }, [currentProject, chapters.length]);

  // ★ 实时字数由 useEditorInstance 的 onUpdate 回调驱动，直接传入 StatusBar
  // 不再在 EditorPage 中单独监听 editor.on('update')，避免重复订阅和潜在的字数冻结
  // 章节列表的字数显示走 store 的 chapter.wordCount，由 useEditorInstance 的 200ms 防抖 flushPersist 更新

  // ★ 风格学习（F-F 修复，2026-10-10）。原实现的三个问题：
  //   ① `deps: [chapters]` + 立即调用 ⇒ 章节内容每次变化都**立刻**打一次 60 s 的
  //      AI 请求（无防抖）。键入时 store 频繁更新，等于持续占满同源连接。
  //   ② `:137` 建了 AbortController 却**从未传给 analyzeStyle**（当时签名也没有
  //      signal 参数）⇒ abort 只改本地的 `aborted` 标志，请求本身取消不掉。
  //   ③ 于是在 AI 端点饱和时，这些 60 s 请求会把普通写请求挤到 8 s 客户端超时，
  //      而写请求是 `silent: true` ⇒ 静默丢数据（F-F）。
  //   现在：按内容签名去重 + 3 s 防抖 + 卸载/内容再变时**真取消**在途请求。
  //   签名与防抖阈值与 StyleAdvisor 各自独立实现（不互相依赖），两者都在场时
  //   各自持有一条连接，但都受防抖约束，不再随每次键入放大。
  useEffect(() => {
    let aborted = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const learnStyle = async () => {
      if (chapters.length < 1) return;
      const texts = chapters.slice(0, 5).map(ch => ch.content);
      // 内容不足 100 字符时样本太短，分析结果没有意义 —— 直接跳过，
      // 省下一条 60 s 的长连接（后端对此也只会返回降级结果）。
      if (texts.join('\n\n').trim().length < 100) return;
      const sig = styleContentSignature(texts.join('\n\n'));
      if (sig === lastStyleSigRef.current) return;
      // 先记签名再发请求：失败时也**不重试**（本地启发式兜底已足够），
      // 否则内容不变而请求失败的场景会在每次 render 后重复打。
      lastStyleSigRef.current = sig;
      try {
        const { profile: p, isLocalFallback } = await styleService.analyzeStyle(texts, controller.signal);
        if (!aborted && !controller.signal.aborted) {
          // 后端不可用时仍写入兜底结果（StyleAdvisor 仅用于本地启发式检查）
          if (!isLocalFallback) setStyleProfile(p);
        }
      } catch {
        // style analysis is 可选
      }
    };

    // 3 s 防抖：写作者连续键入期间不发请求，停笔后才分析一次
    timer = setTimeout(learnStyle, 3000);

    return () => {
      aborted = true;
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, [chapters]);

  useKeyboardShortcuts({
    onFind: () => setFindVisible(true),
    onCloseFind: () => setFindVisible(false),
  });

  // 空状态 — 未选择章节时显示引导
  const _entityChapterIdx = chapters.findIndex(c => c.id === currentChapterId) + 1;
  useAutoEntityDetection(
    currentChapterId,
    currentChapter?.content ?? '',
    currentChapter?.order ?? _entityChapterIdx,
  );

  // ★ 实体-章节反向同步：本地关键词匹配，移除失效引用 + 孤儿实体清理
  // 与 useAutoEntityDetection 互补：AI 加实体，本地清引用
  useEntityChapterSync(
    currentChapterId,
    currentChapter?.content ?? '',
    currentChapter?.order ?? _entityChapterIdx,
  );

  // 后台轮询扫描最新章节（静默，与当前编辑章节双路径规避）
  useLatestChapterPolling(currentChapterId);

  const prevChapterIdRef = useRef<string | null>(null);

  // Editor entrance 动画 on 挂载
  useGSAP(() => {
    if (!containerRef.current) return;
    // Fade in the 编辑器 area
    if (editorAreaRef.current) {
      gsap.from(editorAreaRef.current, {
        opacity: 0,
        y: 12,
        duration: 0.5,
        ease: 'power2.out',
      });
    }
    // Stagger toolbar 按钮
    if (toolbarRef.current) {
      const buttons = toolbarRef.current.querySelectorAll('button');
      if (buttons.length > 0) {
        gsap.from(buttons, {
          opacity: 0,
          y: -8,
          duration: 0.3,
          ease: 'power2.out',
          stagger: 0.06,
        });
      }
    }
  }, { scope: containerRef });

  // Chapter switch 过渡 动画
  useEffect(() => {
    if (!contentRef.current || !prevChapterIdRef.current) return;
    if (prevChapterIdRef.current === currentChapterId) return;
    gsap.fromTo(contentRef.current,
      { opacity: 0, y: 8 },
      { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' }
    );
  }, [currentChapterId]);

  // 时间线跳转：监听 jumpSignal，定位到目标段落并高亮 3 秒
  // jumpSignal 从 0 起步，首次跳转才触发；避免挂载时误触
  const jumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (jumpSignal === 0) return;

    // 章节内容加载是异步的（editor.commands.setContent 在另一个 effect 中），
    // 用 setTimeout 400ms 延迟查找，确保 ProseMirror DOM 已更新完毕
    let delayTimer: ReturnType<typeof setTimeout> | null = null;
    let highlightTimer: ReturnType<typeof setTimeout> | null = null;

    // 解析锚点：jumpAnchor 是 JSON 字符串 { title, desc, chars }
    let anchorTitle = '';
    let anchorDesc = '';
    let anchorChars: string[] = [];
    try {
      if (jumpAnchor) {
        const parsed = JSON.parse(jumpAnchor);
        anchorTitle = parsed.title ?? '';
        anchorDesc = parsed.desc ?? '';
        anchorChars = Array.isArray(parsed.chars) ? parsed.chars : [];
      }
    } catch {
      anchorTitle = jumpAnchor ?? '';
    }

    /** 从文本中提取有意义的关键词（2 字以上的片段） */
    const extractKeywords = (text: string): string[] => {
      if (!text) return [];
      const tokens = text.split(/[，。！？、；：\s,.;!?()[\]{}""''《》\-—…]+/).filter(t => t.length >= 2);
      return tokens;
    };

    /** 计算段落与锚点的匹配得分（命中关键词数越多越好） */
    const scoreParagraph = (paraText: string): number => {
      let score = 0;
      // 1. description 完整包含 → 最高分
      if (anchorDesc && anchorDesc.length >= 4 && paraText.includes(anchorDesc)) return 100;
      // 2. title 完整包含 → 高分
      if (anchorTitle && anchorTitle.length >= 2 && paraText.includes(anchorTitle)) return 80;
      // 3. 角色名命中（原文必定出现角色名，强信号）
      for (const cn of anchorChars) {
        if (cn.length >= 2 && paraText.includes(cn)) score += 4;
      }
      // 4. description 的关键词命中
      const descKeywords = extractKeywords(anchorDesc);
      for (const kw of descKeywords) {
        if (kw.length >= 2 && paraText.includes(kw)) score += 3;
      }
      // 5. title 的关键词命中
      const titleKeywords = extractKeywords(anchorTitle);
      for (const kw of titleKeywords) {
        if (kw.length >= 2 && paraText.includes(kw)) score += 5;
      }
      return score;
    };

    const findAndHighlight = (attempt: number) => {
      const host = editorAreaRef.current;
      if (!host) return;

      const paragraphs = Array.from(
        host.querySelectorAll<HTMLParagraphElement>('.ProseMirror p, .ProseMirror h1, .ProseMirror h2, .ProseMirror h3')
      ).filter(p => (p.textContent || '').trim().length > 0); // 排除空段落

      console.debug('[JumpHighlight] attempt', attempt, '段落数', paragraphs.length, '锚点', { anchorTitle, anchorDesc, anchorChars });

      // 编辑器内容可能还没加载完，空段落时重试（最多 5 次，每次间隔 200ms）
      if (paragraphs.length === 0) {
        if (attempt < 5) {
          delayTimer = setTimeout(() => findAndHighlight(attempt + 1), 200);
        }
        return;
      }

      // 评分匹配：找得分最高的段落
      let bestP: HTMLElement | null = null;
      let bestScore = 0;
      const scores: number[] = [];
      for (const p of paragraphs) {
        const score = scoreParagraph((p.textContent || '').trim());
        scores.push(score);
        if (score > bestScore) {
          bestScore = score;
          bestP = p;
        }
      }
      console.debug('[JumpHighlight] 各段落得分', scores, '最高分', bestScore);

      // 得分为 0 说明完全没匹配到，首次尝试时重试（内容可能还在加载）
      if ((!bestP || bestScore === 0) && attempt < 5) {
        delayTimer = setTimeout(() => findAndHighlight(attempt + 1), 200);
        return;
      }
      if (!bestP || bestScore === 0) {
        console.debug('[JumpHighlight] 匹配失败，不高亮');
        return;
      }

      console.debug('[JumpHighlight] 命中段落:', (bestP.textContent || '').slice(0, 50));
      // 滚动到目标段落
      bestP.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 给段落添加淡红色背景
      bestP.style.transition = 'background-color 0.5s ease';
      bestP.style.backgroundColor = 'rgba(220, 120, 120, 0.18)';
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => {
        bestP!.style.backgroundColor = '';
      }, 3000);
    };

    delayTimer = setTimeout(() => findAndHighlight(0), 300);

    return () => {
      if (delayTimer) clearTimeout(delayTimer);
      if (highlightTimer) clearTimeout(highlightTimer);
      if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
    };
  }, [jumpSignal, jumpAnchor]);

  // 旧「滚动进度 → 渐隐遮罩」监听已移除：卡片透明化后玻璃渐隐条失去意义

  useEffect(() => {
    if (!editor || !currentChapter) return;

    if (prevChapterIdRef.current === currentChapterId) return;

    let cancelled = false;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;

    const switchingChapter = prevChapterIdRef.current && currentChapterId;
    if (switchingChapter) {
      // Animate fade-out of old 内容 before switching
      if (contentRef.current) {
        gsap.to(contentRef.current, { opacity: 0, y: -4, duration: 0.15, ease: 'power2.in' });
      }

      const currentContent = editor.getHTML();
      const prevChapter = chapters.find(c => c.id === prevChapterIdRef.current);
      if (prevChapter && currentContent !== prevChapter.content) {
        const prevWordCount = htmlToText(currentContent).length;
        const prevWcNow = Date.now();
        // ★ 同步写本地缓存兜底（不依赖 50ms setTimeout 是否执行）：
        // 浏览器在 50ms 内关闭时，store 和后端可能都没更新，但缓存已落盘，下次加载可恢复
        cacheChapterContent(prevChapter.id, {
          content: currentContent,
          wordCount: prevWordCount,
          updatedAt: prevWcNow,
        });
        saveTimer = setTimeout(() => {
          if (!cancelled) {
            updateChapter(prevChapter.id, {
              content: currentContent,
              wordCount: prevWordCount,
              updatedAt: prevWcNow,
            });
            // 切换章节前为旧章节留一个自动快照（便于反悔）
            const snap: Snapshot = {
              id: nanoid(),
              chapterId: prevChapter.id,
              content: currentContent,
              wordCount: prevWordCount,
              label: `切换前自动快照 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
              auto: true,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            saveSnapshot(snap).catch((e) => console.warn('[EditorPage] 切换前自动快照失败:', e));
          }
        }, 50);
      }
    }

    // ★ 本地缓存兜底：若 localStorage 中有比后端（store/DB）更新的章节内容，
    // 优先使用，避免热更新/刷新把未落库的内容冲掉（见 chapterLocalCache）。
    // 注意：mount 竞态已被 useEditorInstance 的 prevWordCount guard 阻止，不会写入空缓存，
    // 因此空缓存只来自用户主动清空章节，可安全使用。
    const cached = getCachedChapterContent(currentChapterId!);
    const backendUpdatedAt = currentChapter.updatedAt ?? 0;
    const useCached = !!cached && cached.updatedAt >= backendUpdatedAt;
    const sourceContentRaw = useCached ? cached.content : currentChapter.content;
    // ★ 剔除正文中的 <hr>：禁用 horizontalRule 后编辑器不再渲染分隔线，
    // 但旧 localStorage 缓存可能仍残留带 hr 的内容，需在此净化，避免重新注入或回写后端。
    const sourceContent = (sourceContentRaw || '').replace(/<hr\b[^>]*\/?>/gi, '');

    // ★ 纯文本正文（AI 写作链路落库的是 `\n\n` 分段纯文本）必须转成 HTML 再注入：
    //   tiptap 的 setContent(字符串) 按 HTML 解析，直接喂纯文本会把换行当空白吞掉、段落全并成一段。
    //   已是 HTML 的内容原样返回，不受影响。
    const injectContent = ensureHtmlContent(sourceContent);

    const currentEditorContent = editor.getHTML();
    if (currentEditorContent !== injectContent) {
      editor.commands.setContent(injectContent, false);
    }
    // ★ 从 HTML 内容直接计算字数，不依赖 characterCount（setContent 不触发 update 时 storage 可能未更新）
    //   用 injectContent 算：纯文本正文经转换后，htmlToText 才能正确按段落取到全部文字
    //   （直接对纯文本算会把 `<` 等字符漏掉，且与编辑器实际渲染的内容不一致）
    const actualWc = htmlToText(injectContent).length;
    _prevWordCount.current = actualWc;
    resetWordCount(actualWc);
    // ★ 修正 store 中的 wordCount + 回写缓存内容（合并为一次 updateChapter）
    const needContentUpdate = useCached && currentEditorContent !== injectContent;
    const needWcFix = currentChapter.wordCount !== actualWc;
    if (needContentUpdate || needWcFix) {
      updateChapter(currentChapterId!, {
        ...(needContentUpdate ? { content: sourceContent, updatedAt: cached.updatedAt } : {}),
        wordCount: actualWc,
      });
    }

    prevChapterIdRef.current = currentChapterId;

    return () => {
      cancelled = true;
      if (saveTimer) clearTimeout(saveTimer);
    };
  }, [currentChapterId, editor]);

  // ★ 把「本章未解决批注块数量」发布给外壳（底部细条 N 条问题）。
  //   刻意声明在章节切换 effect **之后**：切章时 setContent(injectContent, false) 不触发
  //   editor 'update'，本 effect 排在切换之后才能读到新章内容（hook 内另有下一 macrotask 补发兜底）。
  useAnnotationBlockBridge(editor, currentChapterId);

  // ★ 章节元信息行（标题下方）：四段全部由真实数据推导，任一段缺失即整段不渲染。
  //   · 字数：编辑器实时字数（useEditorInstance 的 liveWordCount），未就绪时回落到章节持久化字数
  //   · 最后修改：chapter.updatedAt
  //   · 本章标识：chapter.label（真实标签）优先，否则 chapter.order（真实序号）→ D{n}
  //   · 在场人物：角色-章节关联（character.chapters 里存的是出场章节的 order），不写死
  const metaSegments = useMemo(
    () =>
      buildChapterMetaSegments({
        wordCount: currentChapter?.wordCount,
        updatedAt: currentChapter?.updatedAt,
        label: currentChapter?.label,
        order: currentChapter?.order,
        liveWordCount,
        characters,
      }),
    [currentChapter, liveWordCount, characters],
  );

  if (!currentChapter) {
    return (
      <div className="h-full flex flex-col bg-transparent font-[Inter,sans-serif]">
        <div className="flex-1 nm-editor-empty flex items-center justify-center px-6">
          <div className="max-w-md text-center space-y-5 animate-fade-in">
            <div className="mx-auto w-16 h-16 rounded-full nm-book-cover flex items-center justify-center shadow-lg">
              <FileText size={26} className="text-[rgba(255,255,255,0.92)]" />
            </div>
            <div className="space-y-2">
              <h2 className="text-[20.5px] font-[Noto_Serif_SC,serif] font-semibold" style={{ color: 'hsl(var(--ink))' }}>
                尚未开启章节
              </h2>
              <p className="text-[12px] leading-7" style={{ color: 'hsl(var(--ink-light))' }}>
                在左侧章节树中点选一个章节开始你的创作。
                <br />
                或者从下方新建一个章节。
              </p>
            </div>
            <div className="flex items-center justify-center gap-2 pt-2">
              <button
                onClick={handleCreateChapter}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-[12px] font-medium rounded-xl nm-btn-mist-primary transition-all duration-200"
              >
                <Plus size={14} />
                <span>新建章节</span>
              </button>
              <button
                onClick={() => useChapterStore.getState().setCurrentChapter(recentChapterId)}
                disabled={!recentChapterId}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-[12px] font-medium rounded-xl nm-btn-mist-primary transition-all duration-200 disabled:opacity-40"
              >
                <BookOpenIcon size={14} />
                <span>打开最近章节</span>
              </button>
              <button
                onClick={() => navigate(PATHS.bookshelf)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-[12px] font-medium rounded-xl nm-btn-mist-soft transition-all duration-200"
              >
                <Plus size={14} />
                <span>前往书架</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full flex flex-col bg-transparent font-[Inter,sans-serif]">
      {/* 编辑器面板栏（scope: 'editor' 的插件面板开关；无面板时不渲染） */}
      <EditorPanelRail />

      {/* Chapter 内容 包裹 为 过渡 animations */}
      <div ref={contentRef} className="flex-1 flex flex-col overflow-hidden min-h-0">
      {/* Chapter 标题 — Noto Serif 居中 */}
      <div className="nm-editor-responsive" style={{ paddingTop: 'clamp(24px, 4vh, 40px)', paddingBottom: 'var(--space-6)' }}>
        <input
          type="text"
          value={currentChapter.title}
          onChange={(e) =>
            updateChapter(currentChapterId!, { title: e.target.value })
          }
          className="w-full nm-editor-title text-left"
          style={TITLE_INPUT_STYLE}
          placeholder="输入章节标题..."
          aria-label="输入章节标题"
        />
        {/* 副标题：所属卷 */}
        {currentChapter.label && (
          <div className="text-left mt-2 text-[11px] font-[Noto_Serif_SC,serif] tracking-wider" style={SUBTITLE_STYLE}>
            {currentChapter.label}
          </div>
        )}
        {/* 元信息行：字数 · 最后修改 · 本章标识 · 在场人物（四段均为真实数据，缺失段不渲染） */}
        <div
          className="flex flex-wrap items-center justify-start gap-x-2 gap-y-1 mt-2 text-[11px]"
          style={{ color: 'hsl(var(--ink-pale))' }}
        >
          {metaSegments.map((segment, index) => (
            <span key={segment.key} className="inline-flex items-center gap-2">
              {index > 0 && <span aria-hidden="true">·</span>}
              <span title={segment.title}>{segment.text}</span>
            </span>
          ))}
          {metaSegments.length > 0 && <span aria-hidden="true">·</span>}
          <button
            type="button"
            onClick={() => editor?.chain().focus().insertAnnotationBlock().run()}
            disabled={!editor}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors hover:bg-[hsl(var(--mist-pale))] disabled:opacity-40"
            title="在当前段落之后插入批注块（Ctrl+Alt+A）"
            aria-label="插入批注块"
          >
            <Plus size={11} aria-hidden="true" />
            <span>批注</span>
          </button>
          {/* 页面视图开关（2026-10-26）：与「批注」同排的视图偏好。
              文案写**点下去会切到哪种视图**，标题补一句当前态 —— 单标签按钮不装双状态。 */}
          <button
            type="button"
            onClick={togglePageView}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors hover:bg-[hsl(var(--mist-pale))]"
            title={pageView ? '当前：页面视图（A4 纸页 + 页码）· 点一下切成连续视图' : '当前：连续视图 · 点一下切成页面视图（A4 纸页 + 页码）'}
            aria-label={pageView ? '切到连续视图' : '切到页面视图'}
            aria-pressed={pageView}
          >
            {pageView ? <ScrollText size={11} aria-hidden="true" /> : <Rows3 size={11} aria-hidden="true" />}
            <span>{pageView ? '连续视图' : '页面视图'}</span>
          </button>
          {/* 单页 / 多页（只在页面视图下出现）：单页 = 一屏一页（整页自适应），
              多页 = 缩小一屏并排两张纸。页码显示当前页，翻页见 tooltip。 */}
          {pageView && (
            <>
              <button
                type="button"
                onClick={() => page.setMode(page.mode === 'single' ? 'multi' : 'single')}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors hover:bg-[hsl(var(--mist-pale))]"
                title={page.mode === 'single' ? '当前：单页（一屏一页）· 点一下切多页（一屏两张纸）' : '当前：多页（一屏两张纸）· 点一下切单页'}
                aria-label={page.mode === 'single' ? '切到多页显示' : '切到单页显示'}
                aria-pressed={page.mode === 'multi'}
              >
                <Rows3 size={11} aria-hidden="true" />
                <span>{page.mode === 'single' ? '多页' : '单页'}</span>
              </button>
              <span className="mc-num tabular-nums" title="当前页 / 总页数；滚轮或 ← → 翻页">
                {page.pageIndex + 1} / {page.pageCount}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Foreshadow 警告 */}
      <div className="nm-editor-responsive">
        <ForeshadowWarning />
      </div>

      {/* 插件工具栏 — 无插件注册时不渲染 */}
      <div className="nm-editor-responsive">
        <PluginEditorToolbar editor={editor} />
      </div>

      {/* Editor area - 卡片化容器（外层不滚动，文本框内部独立滑动） */}
      <div className="flex-1 overflow-hidden min-h-0 relative nm-editor-responsive">
        {/* 查找替换浮层 */}
        <FindReplaceBar
          editor={editor}
          visible={findVisible}
          onClose={() => setFindVisible(false)}
        />
        {/* 外层：玻璃卡片壳（backdrop-filter 单独一层，避免与 overflow:auto 同元素产生渲染瑕疵） */}
        <div
          ref={editorAreaRef}
          className="nm-editor-card nm-editor-content relative overflow-hidden"
          style={{ height: '100%' }}
        >
          {/* 内层：滚动容器（独立 overflow，内部 padding）。
              ★ 2026-10-26 页面视图：内边距改由 CSS 接管（globals.css「页面视图」段 ——
                纸左右居中 + 画布呼吸），故此处内联值只在连续视图下给
                （内联样式压过 CSS，条件给是唯一干净的做法）。 */}
          <div
            ref={scrollHostRef}
            className={pageView ? 'nm-editor-scroll-host is-page-view' : 'nm-editor-scroll-host'}
            style={
              pageView
                ? undefined
                : {
                    // ★ 2026-10-29：**去掉左右内边距**（原 clamp(16px,4vw,48px)）。
                    //   版心现在由 `.nm-editor-responsive` 的 max-width 钉住
                    //   （34 字/行，且它自己居中，两侧已有留白），再叠一层左右 padding
                    //   等于从版心里再切掉最多 96px —— 实测正文只剩 482px（28 字/行），
                    //   而且它与标题的左基线错开 48px（标题贴版心左缘、正文被 padding 推右）。
                    //   上下留白保持不变。
                    paddingTop: 'clamp(20px, 4vh, 32px)',
                    // ★ 底部只留基础呼吸留白：原先这里还要为「快捷短语」position:fixed 浮层
                    //   预留一段动态测量的 padding（见该文件历史版本）。该功能已于 2026-10-08
                    //   改为底部面板里的一栏（见 QuickPhrasePanel），不再覆盖正文 ⇒ 无需预留。
                    paddingBottom: 'clamp(20px, 4vh, 32px)',
                  }
            }
          >

            {pageView ? (
              /* 缩放外框 → 页带（纸卡片层 + 正文流本体）。
                 ⚠️ SelectionMenu 必须留在缩放外框**之外**（见下方）：transform 会给
                    position:fixed 造出新的包含块，菜单会被一起缩放并对错锚点。 */
              <div className="nm-page-scale" style={page.scaleStyle}>
                <div ref={page.stripRef} className="nm-page-strip nm-page-view" style={page.stripStyle}>
                  <PageLayer pages={page.pageCount} />
                  <EditorContent editor={editor} />
                </div>
              </div>
            ) : (
              <EditorContent editor={editor} />
            )}
            {editor && <SelectionMenu editor={editor} />}
          </div>
        </div>
      </div>

      </div>

      {/* Style advisor */}
      <StyleAdvisor />

      {/* 时间线自动识别内联提示已移除：改为静默写入 */}
    </div>
  );
}
