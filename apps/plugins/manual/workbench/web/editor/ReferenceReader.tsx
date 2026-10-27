// ============================================================
// ReferenceReader — 参考书面板（侧边栏双导航版）
// 双导航：书源（novel.bookscan 插件扫榜收藏）/ 书架（参考书阅读）。
// 拆书已迁移至 AI 对话面板（列出扫榜收藏的书）；拆完的报告作为
// 「拆书报告」章节回存本书，书架内点击「查看拆书报告」即可跳转阅读。
// ============================================================

import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { useReferenceStore } from '@novel-plugins/data-core/stores';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import { useToast } from '@novel-plugins/ui-kit';
import { ChevronLeft, ChevronRight, Upload, Trash2, Minus, Plus, Loader2, Compass, LibraryBig, ScrollText } from 'lucide-react';
import { BookScanDirectory } from './BookScanDirectory';

// 远山青（与项目 TOKEN.accent 一致）
const ACCENT = 'hsl(205, 70%, 46%)';

// 文件大小限制（10MB）
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// 插件命令（Ctrl+K「扫榜拆书：打开榜单导入」）通过该事件切到书源导航
const SCAN_IMPORT_OPEN_EVENT = 'nm:bookscan:open';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function ReferenceReader() {
  const projectId = useCurrentProjectId();
  const toast = useToast();
  const {
    books, activeBookId, processing,
    addBook, removeBook, setActiveBook, setCurrentChapter,
    loadBooks,
  } = useReferenceStore();
  const isDark = false; // 亮色模式固定
  const [nav, setNav] = useState<'sources' | 'library'>('library');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const fontSizeRef = useRef(15);

  const activeBook = useMemo(
    () => books.find(b => b.id === activeBookId) ?? null,
    [books, activeBookId]
  );
  const projectBooks = useMemo(
    () => books.filter(b => b.projectId === projectId),
    [books, projectId]
  );
  const currentChapterData = activeBook?.chapters[activeBook.currentChapter];
  const reportChapterIdx = activeBook
    ? activeBook.chapters.findIndex(c => c.title.startsWith('拆书报告'))
    : -1;

  // 初始化（仅在存在 projectId 时加载，避免无项目时嗅探）
  useEffect(() => {
    if (!projectId) return;
    loadBooks(projectId);
  }, [loadBooks, projectId]);

  // 插件命令唤起：切到书源导航
  useEffect(() => {
    const handler = () => setNav('sources');
    window.addEventListener(SCAN_IMPORT_OPEN_EVENT, handler);
    return () => window.removeEventListener(SCAN_IMPORT_OPEN_EVENT, handler);
  }, []);

  // 切换章节滚动
  useEffect(() => { contentRef.current?.scrollTo(0, 0); }, [activeBook?.currentChapter]);

  // 上传
  const handleUpload = useCallback(async (file: File) => {
    if (!projectId) {
      toast.warning('请先选择或创建项目后再上传参考书');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      toast.warning(
        `文件过大：${formatSize(file.size)}，请上传 10MB 以下的文件`,
        5000
      );
      // 清空 input，允许用户重新选同一文件
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    try {
      const text = await file.text();
      addBook({ projectId, title: file.name.replace(/\.(txt|md)$/, ''), content: text });
      toast.success(`已添加参考书：${file.name}`);
    } catch (_e) {
      toast.error('文件读取失败，请检查文件是否损坏');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [projectId, addBook, toast]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    e.target.value = '';
  }, [handleUpload]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  }, [handleUpload]);

  const handlePrevChapter = () => {
    if (!activeBook || activeBook.currentChapter <= 0) return;
    setCurrentChapter(activeBook.id, activeBook.currentChapter - 1);
  };

  const handleNextChapter = () => {
    if (!activeBook || activeBook.currentChapter >= activeBook.chapters.length - 1) return;
    setCurrentChapter(activeBook.id, activeBook.currentChapter + 1);
  };

  const changeFontSize = (delta: number) => {
    fontSizeRef.current = Math.max(12, Math.min(24, fontSizeRef.current + delta));
    if (contentRef.current) contentRef.current.style.fontSize = `${fontSizeRef.current}px`;
  };

  if (!projectId) return null;

  return (
    <div
      className="h-full flex"
      style={{
        background: 'hsl(var(--card))',
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {/* ════ 侧边栏双导航：书源 / 书架 ════ */}
      <nav className="shrink-0 w-16 flex flex-col items-center gap-1.5 py-3 border-r" style={{ borderColor: 'rgba(0,0,0,0.07)' }}>
        {([
          { key: 'sources', icon: Compass, label: '书源', title: '扫榜书源：收藏公共榜单上的书' },
          { key: 'library', icon: LibraryBig, label: '书架', title: '参考书架：阅读与查看拆书报告' },
        ] as const).map(item => {
          const Icon = item.icon;
          const active = nav === item.key;
          return (
            <button
              key={item.key}
              onClick={() => setNav(item.key)}
              title={item.title}
              className="w-14 py-2 flex flex-col items-center gap-1 rounded-2xl text-[10px] transition-all"
              style={active
                ? { background: 'rgba(35,131,199,0.12)', color: ACCENT, fontWeight: 600 }
                : { color: 'rgba(55,53,47,0.45)' }}
            >
              <Icon size={18} />
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* ════ 主区域 ════ */}
      {nav === 'sources' ? (
        <div className="flex-1 min-w-0">
          <BookScanDirectory onGoLibrary={() => setNav('library')} />
        </div>
      ) : (
        <div className="flex-1 min-w-0 flex flex-col">
          {/* 书选择 + 上传 */}
          <div className="shrink-0 px-3 py-2 border-b flex items-center gap-2" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
            <select
              value={activeBookId || ''}
              onChange={(e) => setActiveBook(e.target.value || null)}
              className="flex-1 min-w-0 px-3 py-1.5 text-sm border outline-none transition-colors"
              style={{
                borderRadius: 'var(--r-md)',
                background: isDark ? 'rgba(255,255,255,0.05)' : '#fff',
                color: isDark ? '#f5f5f3' : '#37352f',
                borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
              }}
            >
              <option value="">选择参考书...</option>
              {projectBooks.map(b => (
                <option key={b.id} value={b.id}>
                  {b.title}（{b.chapters.length}章）{b.chapters.some(c => c.title.startsWith('拆书报告')) ? ' · 有拆书报告' : ''}
                </option>
              ))}
            </select>
            {processing && <Loader2 size={12} className="animate-spin shrink-0" style={{ color: ACCENT }} />}
            <input ref={fileInputRef} type="file" accept=".txt,.md" className="hidden" onChange={handleFileChange} />
            <button onClick={() => fileInputRef.current?.click()} className="p-1.5 hover:bg-white/10 transition-colors" style={{ borderRadius: 'var(--r-sm)', color: processing ? 'rgba(0,0,0,0.4)' : ACCENT }} disabled={processing} title="上传 txt 文件">
              <Upload size={14} />
            </button>
          </div>

          {/* 章节导航 + 工具栏 */}
          {activeBook && (
            <div className="shrink-0 px-4 py-1.5 border-b flex items-center justify-between" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
              <div className="flex items-center gap-1">
                <button onClick={handlePrevChapter} className="p-1 hover:bg-white/10 transition-colors" style={{ borderRadius: 'var(--r-xs)', color: 'rgba(55,53,47,0.4)' }} disabled={activeBook.currentChapter <= 0}>
                  <ChevronLeft size={14} />
                </button>
                <span className="text-xs" style={{ color: 'rgba(55,53,47,0.5)' }}>
                  {activeBook.currentChapter + 1}/{activeBook.chapters.length}
                </span>
                <button onClick={handleNextChapter} className="p-1 hover:bg-white/10 transition-colors" style={{ borderRadius: 'var(--r-xs)', color: 'rgba(55,53,47,0.4)' }} disabled={activeBook.currentChapter >= activeBook.chapters.length - 1}>
                  <ChevronRight size={14} />
                </button>
              </div>
              <div className="flex items-center gap-1">
                {reportChapterIdx >= 0 && (
                  <button
                    onClick={() => setCurrentChapter(activeBook.id, reportChapterIdx)}
                    className="flex items-center gap-1 px-2 py-1 rounded-xl text-[10px] transition-colors"
                    style={{ background: 'rgba(35,131,199,0.1)', color: ACCENT }}
                    title="跳转到本书的拆书报告章节"
                  >
                    <ScrollText size={12} /> 查看拆书报告
                  </button>
                )}
                <button onClick={() => changeFontSize(-1)} className="p-1 hover:bg-white/10" style={{ borderRadius: 'var(--r-xs)', color: 'rgba(55,53,47,0.4)' }} title="缩小字号"><Minus size={12} /></button>
                <button onClick={() => changeFontSize(1)} className="p-1 hover:bg-white/10" style={{ borderRadius: 'var(--r-xs)', color: 'rgba(55,53,47,0.4)' }} title="放大字号"><Plus size={12} /></button>
                <button onClick={() => { if (activeBook) removeBook(activeBook.id); }} className="p-1 hover:bg-red-500/20" style={{ borderRadius: 'var(--r-xs)', color: '#c95454' }} title="删除此书"><Trash2 size={12} /></button>
              </div>
            </div>
          )}

          {/* 章节标题 */}
          {currentChapterData && (
            <div className="shrink-0 px-4 py-2 border-b text-center" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
              <span className="text-sm font-semibold" style={{ color: '#37352f' }}>{currentChapterData.title}</span>
            </div>
          )}

          {/* 内容 — 单 DOM 节点 + white-space:pre-wrap 避免数万 <p> 标签 */}
          {activeBook && processing ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 size={20} className="animate-spin" style={{ color: '#000000' }} />
            </div>
          ) : (
            <div
              ref={contentRef}
              className="flex-1 overflow-y-auto px-6 py-4"
              style={{
                fontSize: fontSizeRef.current,
                color: isDark ? '#e8e6e3' : '#37352f',
                fontFamily: "'Noto Serif SC', serif",
                lineHeight: 1.9,
                whiteSpace: 'pre-wrap',
                wordWrap: 'break-word',
              }}
            >
              {!activeBook ? (
                <div className="h-full flex flex-col items-center justify-center text-center" style={{ color: 'rgba(55,53,47,0.25)' }}>
                  <div
                    className="mb-4 opacity-40 flex items-center justify-center"
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: '50%',
                      background: 'rgba(0,0,0,0.04)',
                      border: '1px solid rgba(0,0,0,0.08)',
                    }}
                  >
                    <Upload size={28} />
                  </div>
                  <p className="text-sm mb-2">从书架选择一本参考书开始对照阅读</p>
                  <p className="text-xs">扫榜收藏的书会出现在书架 · 上传 .txt（最大 10MB）</p>
                  <button onClick={() => fileInputRef.current?.click()} className="mt-4 px-4 py-2 text-sm transition-colors" style={{ borderRadius: 'var(--r-md)', background: '#000000', color: '#ffffff' }}>选择文件</button>
                  <p className="mt-3 text-xs opacity-50">或拖拽文件到此面板</p>
                </div>
              ) : currentChapterData ? (
                // 纯文本用 white-space:pre-wrap 渲染，避免逐行创建 <p>
                currentChapterData.content
              ) : null}
            </div>
          )}

          {!activeBook && (
            <div className="shrink-0 px-4 py-2 text-center text-[10px]" style={{ color: 'rgba(55,53,47,0.15)' }}>
              拆书请到「AI 对话」选择扫榜收藏的书 · 报告会回存本书
            </div>
          )}
        </div>
      )}
    </div>
  );
}
