import { useState, useMemo, useEffect, useCallback, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, X, BookOpen, Settings, ArrowDown, ArrowUp } from 'lucide-react';
import { safeConfirm } from '@/utils/safeConfirm';
import { AddBookModal } from '@/components/ui/AddBookModal';
import { BookCard } from '@/components/ui/BookCard';
import { useCachedQuery } from '@/hooks/useCachedQuery';
import type { Project } from '@novel/shared';
import { apiClient, ApiError } from '@/services/api/apiClient';
import { setQueryData } from '@/services/api/queryClient';
import { queryKeys } from '@/services/api/queryKeys';
// ★ 2026-10-07「跳转加载转圈」全修复（④）：书架条目 hover/按下即预取「进项目」链路 chunk
import { prefetchProjectEntry } from '@/routes/prefetch';
import { useAuthStore } from '@/stores/authStore';
import {
  useProjectStore,
  useChapterStore,
  useCharacterStore,
  useItemStore,
  useCreditStore,
  useLocationStore,
  useEventStore,
  useForeshadowStore,
  useEarmarkStore,
  useAnnotationStore,
  useOutlineStore,
  useTimelineStore,
  useNoteStore,
} from '@/stores';
import { dispatchToastEvent } from '@/utils/errors';

type SortBy = 'updatedAt' | 'createdAt' | 'name' | 'currentWordCount';
type SortOrder = 'asc' | 'desc';

interface Filter {
  search: string;
  sortBy: SortBy;
  sortOrder: SortOrder;
}

const sortOptions = [
  { value: 'updatedAt', label: '最近更新' },
  { value: 'createdAt', label: '创建时间' },
  { value: 'name', label: '名称' },
  { value: 'currentWordCount', label: '字数' },
];


/**
 * 书架字标。
 *
 * ★ 2026-10-29 修正（品牌改名漏网 + 尺寸重定）：
 *   ① **品牌名**：这里一直渲染「听风细雨」—— 全仓 2026-10-19 那次
 *      「品牌改名 NovelMuse/听风细雨 → 砚舟」（commit fc57416）漏掉了这一处，
 *      于是书架顶上是旧名、页脚与 `<title>` 是新名（作者本轮走查一眼看出）。
 *      现在统一为「砚舟」。
 *   ② **尺寸**：原 `clamp(22px, 3.6vw, 38px)` 在 1485px 视口下顶到 38px，
 *      比它下面的书名（书封标题 15px 量级）大出一个数量级，整条顶栏被这一个
 *      词压住。收到 clamp(20px, 2.4vw, 26px) —— 仍是页面最大字号（它是字标），
 *      但不再与内容争重量。
 *   ③ 双色处理保留（前半墨色 + 后半主色），只换字与尺寸。
 */
function CalligraphyTitle() {
  return (
    <h1
      className="select-none"
      style={{
        fontFamily: "'Noto Serif SC', 'Source Han Serif SC', 'STKaiti', 'KaiTi', serif",
        fontSize: 'clamp(20px, 2.4vw, 26px)',
        fontWeight: 700,
        color: 'hsl(var(--foreground))',
        letterSpacing: '0.12em',
        lineHeight: 1,
      }}
    >
      <span className="opacity-90">砚</span>
      <span style={{ color: 'hsl(var(--primary))' }}>舟</span>
    </h1>
  );
}

/**
 * 单本书卡片的 memo 包装：把「per-book 的内联箭头函数」收口到此处，
 * 保证父组件重渲染（如 chapterCounts 更新、搜索/排序）时，props 引用稳定，
 * 从而让 BookCard 的 memo 真正生效，避免整列表无谓重渲染。
 */
const BookCardItem = memo(function BookCardItem({
  book,
  chapterCount,
  index,
  onOpen,
  onEdit,
  onDelete,
}: {
  book: Project;
  chapterCount: number;
  index: number;
  onOpen: (b: Project) => void;
  onEdit: (b: Project) => void;
  onDelete: (b: Project) => void;
}) {
  const handleClick = useCallback(() => onOpen(book), [book, onOpen]);
  const handleEdit = useCallback(() => onEdit(book), [book, onEdit]);
  const handleDelete = useCallback(() => onDelete(book), [book, onDelete]);
  // ★ 2026-10-07「跳转加载转圈」全修复（④）：悬停/按下即预取「进项目」链路 chunk。
  //   与 `handleClick` 不同，这里**不依赖具体某本书** —— 四段串行链（ProjectLayout →
  //   ProjectIndexPage → 章节数据 → ChapterEditor）与书目无关，任何一本书的意图都
  //   值得提前把 chunk 发出去。故依赖为空数组，函数引用恒定，BookCard 的 memo 不受影响。
  const handleIntent = useCallback(() => { prefetchProjectEntry(); }, []);
  return (
    <BookCard
      className="book-card-item"
      book={book}
      chapterCount={chapterCount}
      onClick={handleClick}
      onEdit={handleEdit}
      onDelete={handleDelete}
      onIntent={handleIntent}
      index={index}
    />
  );
});


export function BookshelfPage() {
  const navigate = useNavigate();
  const logout = useAuthStore(s => s.logout);
  const setCurrentProject = useProjectStore(s => s.setProject);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingBook, setEditingBook] = useState<Project | null>(null);
  const [filter, setFilter] = useState<Filter>({
    search: '',
    sortBy: 'updatedAt',
    sortOrder: 'desc',
  });

  // ★ 书架取数改走缓存查询（useCachedQuery）：
  //   挂载时**同步**用上次的结果渲染 —— 从别的页面转回书架不再闪「墨香渐浓...」；
  //   同时在后台重新拉取，新数据到了再平滑替换。
  //   查询键见 queryKeys.projects（与别处的失效前缀一致）。
  const {
    data: projectsData,
    isLoading: loading,
    error: booksError,
  } = useCachedQuery<Project[]>(queryKeys.projects, () => apiClient.get<Project[]>('/projects'));

  // 本地 state 保留：新建/编辑/删除仍然走乐观更新，避免等一次网络往返。
  // 初始值取缓存中的列表，之后由 projectsData 的变化回灌。
  const [books, setBooks] = useState<Project[]>(() => projectsData ?? []);
  useEffect(() => { if (projectsData) setBooks(projectsData); }, [projectsData]);

  // 列表变更后同时写回本地 state 与查询缓存 —— 返回书架、重新挂载时数据仍然是新的
  const applyBooks = useCallback((next: Project[]) => {
    setBooks(next);
    setQueryData(queryKeys.projects, next);
  }, []);

  // 加载失败提示（沿用原行为）：有缓存旧值时不打扰，只在确实没内容可看时报错
  useEffect(() => {
    if (booksError && !projectsData) {
      dispatchToastEvent({ type: 'error', message: '书籍加载失败，请刷新重试' });
    }
  }, [booksError, projectsData]);

  // ★ 章节计数原来是「串行等 N 个请求全回来才 setLoading(false)」——
  //   书籍已经拿到了却还要陪跑，书架因此白等一轮。现在拆成独立的缓存查询：
  //   书籍立刻渲染，计数回来了再逐个补上（缺省显示 0，不再是阻塞条件）。
  const projectIds = useMemo(() => (projectsData ?? []).map(p => p.id), [projectsData]);
  const projectIdsKey = projectIds.join(',');
  const { data: chapterCounts } = useCachedQuery<Record<string, number>>(
    queryKeys.chapterCounts(projectIdsKey),
    async () => {
      const entries = await Promise.all(
        projectIds.map(async (id) => {
          try {
            // 轻量计数接口：只返回章节数，不拉取章节正文（原实现会拉全量章节）
            const res = await apiClient.get<{ count: number }>(`/chapters/projects/${id}/count`);
            return [id, res?.count ?? 0] as const;
          } catch {
            return [id, 0] as const;
          }
        }),
      );
      return Object.fromEntries(entries);
    },
    { enabled: projectIds.length > 0 },
  );

  const filteredBooks = useMemo(() => {
    let result = [...books];
    if (filter.search) {
      const searchLower = filter.search.toLowerCase();
      result = result.filter(
        (book) =>
          book.name.toLowerCase().includes(searchLower) ||
          book.penName?.toLowerCase().includes(searchLower) ||
          book.genre?.toLowerCase().includes(searchLower)
      );
    }
    result.sort((a, b) => {
      let comparison: number;
      switch (filter.sortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'createdAt':
          comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
        case 'currentWordCount':
          comparison = (a.currentWordCount || 0) - (b.currentWordCount || 0);
          break;
        default:
          comparison = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      }
      return filter.sortOrder === 'desc' ? -comparison : comparison;
    });
    return result;
  }, [books, filter]);

  const handleSaveBook = useCallback(async (data: Partial<Project> & { title?: string; author?: string; cover?: string }) => {
    try {
      // AddBookModal 传出的字段名与 Project 不同，需映射
      const name = data.name || data.title || '';
      const penName = data.penName || data.author || '';
      const description = data.description || '';
      const coverImage = data.coverImage || data.cover || '';
      const targetWordCount = data.targetWordCount ?? undefined;
      // 流派：AI 写作向导选出来的展示名（如「系统流 · 末日求生」），手写模式为 undefined
      const genre = data.genre || undefined;
      // 开书设定：仅 AI 写作向导产出，服务端会把它注入每一章的讨论
      const brief = data.brief;
      // 创作模式：两套 UI 互斥，创建时定；编辑时允许切换（数据是同一份，只换工作台形态）
      const mode = data.mode;
      if (editingBook) {
        const result = await apiClient.put<Project>(`/projects/${editingBook.id}`, {
          name, penName, description, coverImage, targetWordCount, genre,
          ...(mode ? { mode } : {}),
          ...(brief ? { brief } : {}),
        });
        applyBooks(books.map(b => b.id === editingBook.id ? (result ?? b) : b));
      } else {
        const result = await apiClient.post<Project>('/projects', {
          name,
          genre,
          description,
          penName,
          coverImage,
          currentWordCount: 0,
          targetWordCount,
          mode: mode ?? 'manual',
          ...(brief ? { brief } : {}),
        });
        if (result) {
          applyBooks([...books, result]);
          // ★ 新建后**直接进书**：向导刚填完开书设定，作者的下一步就是「立设定 / 开写」，
          //   停在书架还得再点一次卡片 —— 实测这是个明显的体验断点（2026-09-13 走查发现）。
          //   只在**新建**时跳；编辑既有书不跳（改完名字不想被带走）。
          setShowAddModal(false);
          setEditingBook(null);
          // ★ 必须**先设当前项目**再跳：路由只有 /project（index=ProjectIndexPage）与
          //   /project/:bookId/:chapterId 两种形状，`/project/<id>` 单段会落到 404
          //   （2026-09-13 GUI 走查实测踩到）。书卡点击也是这两步，保持一致。
          setCurrentProject(result);
          // ★ 带上 bookId 进 URL（2026-09-15）：项目身份不能只活在内存 store 里，
          //   否则刷新即丢、页面塌成空态。带 id 后由 ProjectLayout 的 URL→store 恢复逻辑接手。
          navigate(`/project/${result.id}`);
          return;
        }
      }
      setShowAddModal(false);
      setEditingBook(null);
    } catch (error) {
      console.error('Failed to save book', error);
      // ★ 创建/更新失败必须给用户可见反馈，避免「以为创建成功但列表没出现」的静默失败
      dispatchToastEvent({ type: 'error', message: editingBook ? '保存失败，请稍后重试' : '创建失败，请检查网络后重试' });
    }
  }, [editingBook, books, applyBooks, setCurrentProject, navigate]);

  const handleDeleteBook = useCallback(async (book: Project) => {
    const confirmed = await safeConfirm('\u786e\u5b9a\u8981\u5220\u9664\u300c' + book.name + '\u300d\u5417\uff1f\u6240\u6709\u7ae0\u8282\u6570\u636e\u5c06\u6c38\u4e45\u4e22\u5931\u3002');
    if (!confirmed) return;
    try {
      // silent: 404（项目已不存在）视为已达成删除目标，不弹 toast；
      // 其他真实错误在 catch 中手动提示
      await apiClient.delete(`/projects/${book.id}`, { silent: true });
      applyBooks(books.filter(b => b.id !== book.id));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // 项目后端已不存在，视为删除成功，从列表移除
        applyBooks(books.filter(b => b.id !== book.id));
      } else {
        console.error('Failed to delete book', error);
        dispatchToastEvent({ type: 'error', message: '删除失败，请稍后重试' });
      }
    }
  }, [books, applyBooks]);

  const handleLogout = useCallback(async () => {
    const confirmed = await safeConfirm('确定要退出登录吗？');
    if (!confirmed) return;
    logout();
    navigate('/');
  }, [logout, navigate]);

  const handleEditBook = useCallback((book: Project) => {
    setEditingBook(book);
    setShowAddModal(true);
  }, []);

  // 点击书籍：先清空所有项目级 store，再设置新项目并导航
  // 防止旧项目数据残留（syncService 的清空在 ProjectLayout 挂载后才执行，子组件 effect 更早）
  const handleOpenBook = useCallback((book: Project) => {
    useChapterStore.setState({ chapters: [] });
    useCharacterStore.setState({ characters: [] });
    useItemStore.setState({ items: [] });
    useCreditStore.setState({ creditTransactions: [] });
    useLocationStore.setState({ locations: [] });
    useEventStore.setState({ events: [] });
    useForeshadowStore.setState({ foreshadows: [] });
    useEarmarkStore.setState({ earmarks: [] });
    useAnnotationStore.setState({ annotations: [] });
    useOutlineStore.setState({ nodes: [] });
    useTimelineStore.setState({ events: [] });
    useNoteStore.setState({ notes: [] });
    setCurrentProject(book);
    // ★ 同上：URL 带 bookId，刷新才能靠 ProjectLayout 的恢复逻辑救回当前书
    navigate(`/project/${book.id}`);
  }, [navigate, setCurrentProject]);
  return (
    <div className="relative min-h-screen overflow-x-hidden">
      {/* 液态玻璃环境背景由 App.tsx 全局挂载 */}

      {/* Main content layer */}
      <div className="relative z-10 flex flex-col min-h-screen">
        {/* Top bar — 液态玻璃工具栏 */}
        <header className="sticky top-0 z-20 bs-topbar">
          <div className="bs-topbar-inner">
            {/* Left: 字标 + 一处说明性小字（原来只有"听风细雨"四个大字孤零零挂着） */}
            <div className="bs-brand">
              <CalligraphyTitle />
              <span className="bs-brand-tag">墨香书阁</span>
            </div>

            {/* Right: 搜索 + 设置 + 新建 */}
            <div className="bs-topbar-actions">
              {/* 搜索：**有边框的输入框**，不再是悬浮玻璃胶囊。
                  胶囊 + 毛玻璃在顶栏里看起来像一枚标签而不是输入框，
                  用户第一眼判断不出"这里能打字"；描边输入框是更直白的能指。
                  聚焦反馈走 --ring（与全局焦点环同一 token）。 */}
              <div className="bs-search">
                <Search size={14} className="shrink-0" style={{ color: 'hsl(var(--muted-foreground))' }} />
                <input
                  type="text"
                  placeholder="搜索作品…"
                  value={filter.search}
                  onChange={e => setFilter(f => ({ ...f, search: e.target.value }))}
                  className="bs-search-input"
                  aria-label="搜索作品"
                />
                {filter.search && (
                  <button
                    onClick={() => setFilter(f => ({ ...f, search: '' }))}
                    className="bs-search-clear"
                    aria-label="清除搜索"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              {/* 设置：图标按钮改成方形描边（与输入框、主按钮同一套形态语言） */}
              <button
                onClick={() => navigate('/settings')}
                className="bs-icon-btn"
                aria-label="设置"
              >
                <Settings size={16} strokeWidth={1.6} />
              </button>

              <button
                className="nm-btn-apple-primary"
                style={{ height: 34 }}
                onClick={() => setShowAddModal(true)}
              >
                <Plus size={14} strokeWidth={2.5} />
                新建
              </button>
            </div>
          </div>
        </header>

        {/* Main content area */}
        <main className="bs-main">
          {/* 工具条：左「共 N 部作品」计数，右排序分段控件。
              原来是**只有右侧一坨**的悬浮胶囊（排序项 + 一道竖线 + 方向钮挤在
              一个圆角胶囊里，还带彩色投影），左边整片空白 —— 一屏里两个水平带
              （顶栏与它）都靠右堆东西，版心因此看不出边界。
              现在把它做成一条**通栏工具条**：左侧给计数（版心起点有了内容），
              右侧放排序，控件形态与顶栏统一（描边 + 方角 6px）。 */}
          <div className="bs-toolbar">
            <span className="bs-count">
              {loading ? '正在整理书架…' : `共 ${filteredBooks.length} 部作品`}
            </span>

            <div className="bs-sort" role="group" aria-label="排序方式">
              {sortOptions.map(opt => {
                const active = filter.sortBy === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setFilter(f => ({ ...f, sortBy: opt.value as SortBy }))}
                    aria-pressed={active}
                    className={active ? 'bs-sort-btn is-active' : 'bs-sort-btn'}
                  >
                    {opt.label}
                  </button>
                );
              })}
              <span className="bs-sort-sep" aria-hidden="true" />
              <button
                type="button"
                onClick={() => setFilter(f => ({ ...f, sortOrder: f.sortOrder === 'asc' ? 'desc' : 'asc' }))}
                className="bs-sort-btn bs-sort-order"
                aria-label={filter.sortOrder === 'desc' ? '当前降序，点击切换为升序' : '当前升序，点击切换为降序'}
                title={filter.sortOrder === 'desc' ? '降序' : '升序'}
              >
                {filter.sortOrder === 'desc'
                  ? <ArrowDown size={14} strokeWidth={2.2} />
                  : <ArrowUp size={14} strokeWidth={2.2} />}
              </button>
            </div>
          </div>

          {/* 加载态：骨架屏。
              ★ 2026-10-29 换掉原来的「大转圈 + 衬线体『墨香渐浓…』」——
                转圈 + 一句文学化文案会让每次回到书架都像在等一个慢接口，
                而实际上数据多数时候已在缓存里（useCachedQuery 同步出上一次结果）。
                骨架屏的观感是"内容马上就来"，且高度与真实卡片一致 ⇒ 不跳动。 */}
          {loading && (
            <div className="nm-book-grid" aria-hidden="true">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="bs-skeleton" />
              ))}
            </div>
          )}

          {/* 空态 */}
          {!loading && filteredBooks.length === 0 && (
            <div className="bs-empty">
              <div className="bs-empty-icon">
                <BookOpen size={26} strokeWidth={1.5} />
              </div>
              <h2 className="bs-empty-title">
                {filter.search ? '没有找到作品' : '书架还是空的'}
              </h2>
              <p className="bs-empty-desc">
                {filter.search
                  ? `没有名称、笔名或流派匹配「${filter.search}」的作品`
                  : '新建一部作品，开始你的第一段故事'}
              </p>
              {!filter.search && (
                <button
                  className="nm-btn-apple-primary"
                  style={{ height: 36 }}
                  onClick={() => setShowAddModal(true)}
                >
                  <Plus size={16} strokeWidth={2.5} />
                  新建作品
                </button>
              )}
            </div>
          )}

          {/* Book grid */}
          {!loading && filteredBooks.length > 0 && (
            <div className="nm-book-grid">
              {filteredBooks.map((book, i) => (
                <BookCardItem
                  key={book.id}
                  book={book}
                  chapterCount={chapterCounts?.[book.id] ?? 0}
                  onOpen={handleOpenBook}
                  onEdit={handleEditBook}
                  onDelete={handleDeleteBook}
                  index={i}
                />
              ))}
            </div>
          )}
        </main>

        {/* Footer：只留一处版权与登出。
            ★ 2026-10-29：去掉衬线体与「砚舟 · 墨香书阁」（品牌已由顶栏字标承担，
              页脚再写一遍是重复信息）；字号从 10px 提到 11px —— 10px 的正文
              在 1x 屏上低于中文可读下限。 */}
        <footer className="bs-footer">
          <span>© {new Date().getFullYear()} 砚舟</span>
          <button type="button" onClick={handleLogout} className="bs-footer-link">
            退出登录
          </button>
        </footer>
      </div>

      {/* Add/Edit modal */}
      <AddBookModal
        isOpen={showAddModal}
        onClose={() => { setShowAddModal(false); setEditingBook(null); }}
        onSubmit={handleSaveBook}
        editBook={editingBook}
      />

      {/* 书架页样式表。
          ★ 说明：本仓的页面样式惯例是「Tailwind 工具类 + 内联 style」，
            这里之所以仍然用一段作用域化的 <style>，是因为下面这些规则需要
            hover / focus-visible / 媒体查询 —— 内联样式表达不了伪类。
            全部取 token，无字面色值（改主题即跟随）。 */}
      <style>{`
        /* ---- 顶栏：通栏一条，带下边发丝线与半透明底 ---- */
        .bs-topbar {
          background: rgb(var(--glass-tint) / 0.82);
          backdrop-filter: blur(12px) saturate(150%);
          -webkit-backdrop-filter: blur(12px) saturate(150%);
          border-bottom: 1px solid hsl(var(--border) / 0.6);
        }
        .bs-topbar-inner {
          display: flex; align-items: center; justify-content: space-between;
          gap: var(--space-6);
          width: 100%; max-width: 1440px;
          margin: 0 auto;
          padding: var(--space-5) var(--space-8);
        }
        .bs-brand { display: flex; align-items: baseline; gap: var(--space-5); min-width: 0; }
        /* 字标旁的一句说明：给品牌一个"这是什么"的注脚，也让顶栏左侧有第二段信息 */
        .bs-brand-tag {
          font-family: 'Noto Serif SC', serif;
          font-size: 11px; letter-spacing: 0.16em;
          color: hsl(var(--muted-foreground));
          white-space: nowrap;
        }
        .bs-topbar-actions { display: flex; align-items: center; gap: var(--space-2); }

        /* ---- 搜索框：描边输入框（不是玻璃胶囊） ---- */
        .bs-search {
          display: flex; align-items: center; gap: var(--space-2);
          height: 34px;
          padding: 0 var(--space-2) 0 var(--space-5);
          border: 1px solid hsl(var(--border));
          border-radius: var(--r-sm);
          background: hsl(var(--card));
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .bs-search:focus-within {
          border-color: hsl(var(--ring));
          box-shadow: 0 0 0 3px hsl(var(--ring) / 0.15);
        }
        .bs-search-input {
          min-width: 120px;
          border: 0; outline: 0; background: transparent;
          font-family: inherit; font-size: 12.5px;
          color: hsl(var(--foreground));
        }
        .bs-search-input::placeholder { color: hsl(var(--muted-foreground)); }
        .bs-search-clear {
          display: flex; align-items: center; justify-content: center;
          width: 20px; height: 20px; border: 0; border-radius: var(--r-pill);
          background: hsl(var(--muted)); color: hsl(var(--muted-foreground));
          cursor: pointer;
        }
        .bs-search-clear:hover { color: hsl(var(--foreground)); }

        /* ---- 图标按钮：与输入框同高、同圆角、同描边 ---- */
        .bs-icon-btn {
          display: flex; align-items: center; justify-content: center;
          width: 34px; height: 34px;
          border: 1px solid hsl(var(--border));
          border-radius: var(--r-sm);
          background: hsl(var(--card));
          color: hsl(var(--muted-foreground));
          cursor: pointer;
          transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
        }
        .bs-icon-btn:hover {
          color: hsl(var(--foreground));
          border-color: hsl(var(--foreground) / 0.25);
          background: hsl(var(--muted));
        }
        .bs-icon-btn:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 2px; }

        /* ---- 版心：与顶栏内层同宽同内边距，四条水平带对齐 ---- */
        .bs-main {
          flex: 1;
          width: 100%; max-width: 1440px;
          margin: 0 auto;
          padding: var(--space-6) var(--space-8) var(--space-9);
        }

        /* ---- 工具条 ---- */
        .bs-toolbar {
          display: flex; align-items: center; justify-content: space-between;
          gap: var(--space-4);
          padding-bottom: var(--space-5);
          margin-bottom: var(--space-6);
          border-bottom: 1px solid hsl(var(--border) / 0.55);
        }
        .bs-count {
          font-size: 12px;
          color: hsl(var(--muted-foreground));
        }
        .bs-sort {
          display: flex; align-items: center; gap: var(--space-0);
          padding: 2px;
          border: 1px solid hsl(var(--border));
          border-radius: var(--r-sm);
          background: hsl(var(--muted) / 0.6);
        }
        .bs-sort-btn {
          height: 26px;
          padding: 0 var(--space-4);
          border: 0; border-radius: var(--r-xs);
          background: transparent;
          color: hsl(var(--muted-foreground));
          font-family: inherit; font-size: 12px;
          cursor: pointer;
          transition: background-color 0.15s ease, color 0.15s ease;
        }
        .bs-sort-btn:hover { color: hsl(var(--foreground)); }
        .bs-sort-btn.is-active {
          background: hsl(var(--card));
          color: hsl(var(--foreground));
          font-weight: 600;
          box-shadow: 0 1px 2px hsl(var(--glass-shadow) / 0.10);
        }
        .bs-sort-btn.is-active:hover { color: hsl(var(--foreground)); }
        .bs-sort-btn:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 1px; }
        .bs-sort-sep { width: 1px; height: 16px; background: hsl(var(--border)); }
        .bs-sort-order { display: flex; align-items: center; justify-content: center; width: 30px; padding: 0; }

        /* ---- 骨架屏 ---- */
        .bs-skeleton {
          aspect-ratio: 3 / 4;
          border-radius: var(--r-lg);
          background: hsl(var(--muted));
          animation: bs-pulse 1.4s ease-in-out infinite;
        }
        @keyframes bs-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.55; }
        }
        @media (prefers-reduced-motion: reduce) {
          .bs-skeleton { animation: none; }
        }

        /* ---- 空态：左对齐的一块说明，而不是页面正中一座孤岛 ---- */
        .bs-empty {
          display: flex; flex-direction: column; align-items: center;
          gap: var(--space-3);
          padding: var(--space-10) var(--space-6);
          text-align: center;
        }
        .bs-empty-icon {
          display: flex; align-items: center; justify-content: center;
          width: 56px; height: 56px;
          margin-bottom: var(--space-2);
          border: 1px solid hsl(var(--border));
          border-radius: var(--r-pill);
          background: hsl(var(--card));
          color: hsl(var(--muted-foreground));
        }
        .bs-empty-title {
          margin: 0;
          font-family: 'Noto Serif SC', serif;
          font-size: 17px; font-weight: 600;
          letter-spacing: 0.04em;
          color: hsl(var(--foreground));
        }
        .bs-empty-desc {
          margin: 0 0 var(--space-3);
          max-width: 34em;
          font-size: 12.5px;
          color: hsl(var(--muted-foreground));
        }

        /* ---- 页脚 ---- */
        .bs-footer {
          display: flex; align-items: center; justify-content: space-between;
          width: 100%; max-width: 1440px;
          margin: 0 auto;
          padding: var(--space-5) var(--space-8) var(--space-7);
          border-top: 1px solid hsl(var(--border) / 0.55);
          font-size: 11px;
          color: hsl(var(--muted-foreground));
        }
        .bs-footer-link {
          border: 0; background: transparent;
          font: inherit; color: inherit;
          cursor: pointer;
        }
        .bs-footer-link:hover { color: hsl(var(--foreground)); }

        /* ---- 书架网格 ---- */
        .nm-book-grid {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: var(--space-6);
        }
        @media (max-width: 1280px) {
          .nm-book-grid { grid-template-columns: repeat(4, 1fr); gap: var(--space-6); }
        }
        @media (max-width: 1024px) {
          .nm-book-grid { grid-template-columns: repeat(3, 1fr); gap: var(--space-6); }
        }
        @media (max-width: 900px) {
          .bs-topbar-inner, .bs-main, .bs-footer { padding-left: var(--space-5); padding-right: var(--space-5); }
          .bs-brand-tag { display: none; }
        }
        @media (max-width: 640px) {
          .nm-book-grid { grid-template-columns: repeat(2, 1fr); gap: var(--space-5); }
        }

        main::-webkit-scrollbar { width: 8px; }
        main::-webkit-scrollbar-track { background: transparent; }
        main::-webkit-scrollbar-thumb {
          background: hsl(var(--border));
          border-radius: var(--r-pill);
        }
        main::-webkit-scrollbar-thumb:hover { background: hsl(var(--muted-foreground) / 0.5); }
      `}</style>
    </div>
  );
}
