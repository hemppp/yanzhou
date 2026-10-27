import { useState } from 'react';
import { useNoteStore } from '@novel-plugins/data-core/stores';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import { nanoid } from 'nanoid';
import { Plus, Pin, Trash2, Search, AlertCircle, RefreshCw, FileText, StickyNote } from 'lucide-react';
import type { Note } from '@novel/shared';

export function NoteManager() {
  const notes = useNoteStore((s) => s.notes);
  const addNote = useNoteStore((s) => s.addNote);
  const updateNote = useNoteStore((s) => s.updateNote);
  const deleteNote = useNoteStore((s) => s.deleteNote);
  const projectId = useCurrentProjectId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full" style={{ background: 'hsl(var(--card) / 0.4)' }}>
        <div className="text-center">
          <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: 'hsl(var(--mist-pale))' }}>
            <AlertCircle size={28} style={{ color: 'hsl(var(--mountain-deep))' }} />
          </div>
          <p className="text-sm font-medium" style={{ color: 'hsl(var(--ink-light))' }}>请先选择一个项目</p>
        </div>
      </div>
    );
  }

  const filtered = notes
    .filter(
      (n) =>
        n.projectId === projectId &&
        (n.title?.includes(search) ||
        n.content.includes(search) ||
        n.tags.some((t: string) => t.includes(search)))
    )
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.updatedAt - a.updatedAt;
    });

  const selected = notes.find((n) => n.id === selectedId);

  const handleAdd = () => {
    try {
      setError(null);
      const note: Note = {
        id: nanoid(),
        projectId,
        title: '新笔记',
        content: '',
        tags: [],
        pinned: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      addNote(note);
      setSelectedId(note.id);
    } catch {
      setError('创建笔记失败，请重试');
    }
  };

  const handleUpdate = (id: string, updates: Partial<Note>) => {
    try {
      setError(null);
      updateNote(id, { ...updates, updatedAt: Date.now() });
    } catch {
      setError('保存笔记失败，请重试');
    }
  };

  const handleDelete = (id: string) => {
    try {
      setError(null);
      deleteNote(id);
      setSelectedId(null);
    } catch {
      setError('删除笔记失败，请重试');
    }
  };

  return (
    <div className="h-full flex" style={{ background: 'hsl(var(--card) / 0.4)' }}>
      {/* Sidebar List */}
      <div
        className="w-56 flex flex-col shrink-0"
        style={{
          borderRight: '1px solid hsl(var(--border) / 0.5)',
          background: 'hsl(var(--card) / 0.7)',
        }}
      >
        <div className="p-3" style={{ borderBottom: '1px solid hsl(var(--border) / 0.45)' }}>
          <div className="flex items-center gap-1 mb-2">
            <h2 className="text-sm font-semibold font-[Noto_Serif_SC,serif]" style={{ color: 'hsl(var(--ink))', letterSpacing: '0.03em' }}>
              笔记
            </h2>
            <div className="flex-1" />
            <button
              onClick={handleAdd}
              className="p-1 rounded-xl transition-colors hover:bg-[hsl(var(--mist-pale))]"
              style={{ color: 'hsl(var(--ink-light))' }}
              aria-label="创建新笔记"
            >
              <Plus size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="relative">
            <Search
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2"
              style={{ color: 'hsl(var(--ink-pale))' }}
              aria-hidden="true"
            />
            <label htmlFor="note-search" className="sr-only">搜索笔记</label>
            <input
              id="note-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索..."
              className="w-full pl-6 pr-2 py-1.5 text-xs rounded-[14px] outline-none transition-colors"
              style={{
                background: 'hsl(var(--background))',
                border: '1px solid hsl(var(--border))',
                color: 'hsl(var(--ink))',
              }}
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto" role="listbox" aria-label="笔记列表">
          {filtered.length === 0 ? (
            <div className="p-4 text-center text-xs" style={{ color: 'hsl(var(--ink-pale))' }}>
              <StickyNote size={20} className="mx-auto mb-2" style={{ color: 'hsl(var(--ink-pale))' }} />
              <p>{search ? '没有匹配的笔记' : '暂无笔记'}</p>
            </div>
          ) : (
            filtered.map((note) => (
              <button
                key={note.id}
                onClick={() => { setSelectedId(note.id); setError(null); }}
                className="w-full text-left px-3 py-2.5 text-sm transition-colors"
                style={{
                  background: selectedId === note.id ? 'hsl(var(--mountain-pale) / 0.7)' : 'transparent',
                  borderLeft: selectedId === note.id ? '2px solid hsl(var(--mountain-cyan))' : '2px solid transparent',
                  borderBottom: '1px solid hsl(var(--border) / 0.3)',
                }}
                onMouseEnter={(e) => {
                  if (selectedId !== note.id) e.currentTarget.style.background = 'hsl(var(--mist-pale) / 0.5)';
                }}
                onMouseLeave={(e) => {
                  if (selectedId !== note.id) e.currentTarget.style.background = 'transparent';
                }}
                role="option"
                aria-selected={selectedId === note.id}
              >
                <div className="flex items-center gap-1">
                  {note.pinned && (
                    <Pin size={10} style={{ color: 'hsl(var(--ochre))' }} aria-label="已置顶" />
                  )}
                  <span className="font-medium truncate font-[Noto_Serif_SC,serif]" style={{ color: 'hsl(var(--ink))' }}>
                    {note.title || '无标题'}
                  </span>
                </div>
                <div className="text-xs truncate mt-0.5" style={{ color: 'hsl(var(--ink-pale))' }}>
                  {note.content.slice(0, 40) || '空笔记'}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col">
        {error && (
          <div
            className="m-4 p-3 rounded-lg flex items-start gap-2"
            style={{ background: 'hsl(var(--cinnabar-pale) / 0.6)', border: '1px solid hsl(var(--cinnabar) / 0.3)' }}
            role="alert"
          >
            <AlertCircle size={14} className="mt-0.5 shrink-0" style={{ color: 'hsl(var(--cinnabar))' }} />
            <div className="flex-1">
              <p className="text-sm" style={{ color: 'hsl(var(--cinnabar))' }}>{error}</p>
              <button
                onClick={() => setError(null)}
                className="flex items-center gap-1 text-xs mt-1 underline"
                style={{ color: 'hsl(var(--ink-light))' }}
              >
                <RefreshCw size={10} aria-hidden="true" />
                关闭
              </button>
            </div>
          </div>
        )}
        {selected ? (
          <>
            <div
              className="px-6 py-4 flex items-center gap-2"
              style={{ borderBottom: '1px solid hsl(var(--border) / 0.45)' }}
            >
              <label htmlFor="note-title" className="sr-only">笔记标题</label>
              <input
                id="note-title"
                value={selected.title || ''}
                onChange={(e) => handleUpdate(selected.id, { title: e.target.value })}
                placeholder="笔记标题"
                className="flex-1 text-lg font-semibold bg-transparent outline-none font-[Noto_Serif_SC,serif]"
                style={{ color: 'hsl(var(--ink))' }}
              />
              <button
                onClick={() =>
                  handleUpdate(selected.id, { pinned: !selected.pinned })
                }
                className="p-1.5 rounded-xl transition-colors hover:bg-[hsl(var(--mist-pale))]"
                style={{
                  color: selected.pinned ? 'hsl(var(--ochre))' : 'hsl(var(--ink-pale))',
                }}
                aria-label={selected.pinned ? '取消置顶' : '置顶笔记'}
              >
                <Pin size={14} aria-hidden="true" />
              </button>
              <button
                onClick={() => handleDelete(selected.id)}
                className="p-1.5 rounded-xl transition-colors hover:bg-[hsl(var(--cinnabar-pale))] hover:text-[hsl(var(--cinnabar))]"
                style={{ color: 'hsl(var(--ink-light))' }}
                aria-label="删除笔记"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
            <label htmlFor="note-content" className="sr-only">笔记内容</label>
            <textarea
              id="note-content"
              value={selected.content}
              onChange={(e) =>
                handleUpdate(selected.id, { content: e.target.value })
              }
              placeholder="开始写笔记..."
              className="flex-1 p-6 resize-none outline-none text-sm font-[Noto_Serif_SC,serif]"
              style={{ color: 'hsl(var(--ink))', lineHeight: '1.7' }}
            />
            <div
              className="px-6 py-2.5"
              style={{ borderTop: '1px solid hsl(var(--border) / 0.45)' }}
            >
              <label htmlFor="note-tags" className="sr-only">笔记标签</label>
              <input
                id="note-tags"
                value={selected.tags.join(', ')}
                onChange={(e) => {
                  const tags = e.target.value.split(',').map((t) => t.trim()).filter(Boolean);
                  handleUpdate(selected.id, { tags });
                }}
                placeholder="标签（逗号分隔）"
                className="w-full text-xs bg-transparent outline-none"
                style={{ color: 'hsl(var(--ink-pale))' }}
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-3">
              <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto" style={{ background: 'hsl(var(--mist-pale) / 0.6)' }}>
                <FileText size={28} style={{ color: 'hsl(var(--ink-pale))' }} />
              </div>
              <p className="text-sm" style={{ color: 'hsl(var(--ink-pale))' }}>选择或创建笔记</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
