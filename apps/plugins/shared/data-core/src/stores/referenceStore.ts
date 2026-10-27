// ============================================================
// 砚舟 - 参考书状态 (ReferenceBook Store)
// 改为通过后端 HTTP API 持久化（替代 IndexedDB），实现跨浏览器/设备同步。
// ============================================================

import { create } from 'zustand';
import type { ReferenceBook } from '@novel/shared';
import { apiClient } from '../api/apiClient';

// ---- 章节分割（非阻塞版）----
export function splitChapters(text: string): { title: string; content: string }[] {
  const lines = text.split('\n');
  const chapters: { title: string; content: string[] }[] = [];
  let current: { title: string; content: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (/^(第[一二三四五六七八九十百千\d]+[章节部]|Chapter\s+\d+|Volume\s+\d+|序[章言]|尾声)/i.test(trimmed) && trimmed.length < 50) {
      if (current) chapters.push(current);
      current = { title: trimmed, content: [] };
    } else if (current) {
      current.content.push(lines[i]!);
    }
  }
  if (current) chapters.push(current);
  if (chapters.length === 0) chapters.push({ title: '全文', content: lines });
  return chapters.map(c => ({ title: c.title, content: c.content.join('\n') }));
}

interface ReferenceState {
  books: ReferenceBook[];
  activeBookId: string | null;
  isOpen: boolean;
  /** 是否正在处理中 */
  processing: boolean;

  loadBooks: (projectId: string) => Promise<void>;
  addBook: (book: { projectId: string; title: string; author?: string; content: string; source?: string }) => Promise<void>;
  removeBook: (id: string) => Promise<void>;
  setActiveBook: (id: string | null) => void;
  setCurrentChapter: (id: string, chapter: number) => Promise<void>;
  /** 拆书报告回存：替换该书的「拆书报告」章节（由 AI 对话拆书完成后调用） */
  appendReportChapter: (id: string, report: string) => Promise<boolean>;
  togglePanel: () => void;
  setOpen: (open: boolean) => void;
}

export const useReferenceStore = create<ReferenceState>((set, get) => ({
  books: [],
  activeBookId: null,
  isOpen: false,
  processing: false,

  loadBooks: async (projectId) => {
    if (!projectId) return;
    try {
      const books = await apiClient.get<ReferenceBook[]>(
        `/references/projects/${encodeURIComponent(projectId)}`,
        undefined,
        { silent: true },
      );
      set({ books: books ?? [] });
    } catch (e) {
      console.warn('[ReferenceStore] 加载参考书失败:', e);
      set({ books: [] });
    }
  },

  addBook: async (input) => {
    set({ processing: true });
    try {
      // 异步分割章节（非阻塞主线程）
      const chapters = await new Promise<{ title: string; content: string }[]>((resolve) => {
        setTimeout(() => resolve(splitChapters(input.content)), 0);
      });

      const created = await apiClient.post<ReferenceBook>(
        '/references',
        {
          projectId: input.projectId,
          title: input.title,
          author: input.author,
          content: input.content,
          chapters,
          currentChapter: 0,
          source: input.source,
        },
        { silent: true },
      );
      const books = [...get().books, created];
      set({ books, activeBookId: created.id, processing: false });
    } catch (e) {
      console.warn('[ReferenceStore] 创建参考书失败:', e);
      set({ processing: false });
    }
  },

  removeBook: async (id) => {
    // 乐观更新：先保存旧状态以便回滚
    const prevBooks = get().books;
    const prevActiveBookId = get().activeBookId;
    const books = prevBooks.filter(b => b.id !== id);
    const activeBookId = prevActiveBookId === id ? null : prevActiveBookId;
    set({ books, activeBookId });
    try {
      await apiClient.delete(`/references/${encodeURIComponent(id)}`, { silent: true });
    } catch (e) {
      console.warn('[ReferenceStore] 删除参考书失败，回滚:', e);
      // 回滚到删除前的状态
      set({ books: prevBooks, activeBookId: prevActiveBookId });
    }
  },

  setActiveBook: (id) => set({ activeBookId: id }),

  appendReportChapter: async (id, report) => {
    const book = get().books.find(b => b.id === id);
    if (!book || !report.trim()) return false;
    const chapters = [...book.chapters.filter(c => !c.title.startsWith('拆书报告')), { title: '拆书报告', content: report }];
    const prevBooks = get().books;
    set({ books: prevBooks.map(b => b.id === id ? { ...b, chapters } : b) });
    try {
      await apiClient.put(
        `/references/${encodeURIComponent(id)}`,
        { chapters },
        { silent: true },
      );
      return true;
    } catch (e) {
      console.warn('[ReferenceStore] 保存拆书报告失败:', e);
      set({ books: prevBooks });
      return false;
    }
  },

  setCurrentChapter: async (id, chapter) => {
    const prevBooks = get().books;
    const books = prevBooks.map(b => b.id === id ? { ...b, currentChapter: chapter } : b);
    set({ books });
    try {
      await apiClient.put(
        `/references/${encodeURIComponent(id)}`,
        { currentChapter: chapter },
        { silent: true },
      );
    } catch (e) {
      console.warn('[ReferenceStore] 更新阅读位置失败，回滚:', e);
      set({ books: prevBooks });
    }
  },

  togglePanel: () => set(s => ({ isOpen: !s.isOpen })),
  setOpen: (open) => set({ isOpen: open }),
}));
