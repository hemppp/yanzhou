import { useState, useEffect, useCallback } from 'react';
import { Trash2, RotateCcw, X, AlertTriangle, RefreshCw } from 'lucide-react';
import type { Chapter } from '@novel/shared';
import {
  listTrashedChapters,
  restoreChapter,
  hardDeleteChapter,
  emptyChapterTrash,
} from '@novel-plugins/data-core/data/databaseService';
import { useChapterStore, useProjectStore } from '@novel-plugins/data-core/stores';
import { safeConfirm } from '@novel-plugins/ui-kit/safeConfirm';

interface TrashDialogProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * 回收站弹窗 — 显示已软删除的章节，支持还原 / 彻底删除 / 清空。
 * 还原后章节会自动加回章节 store。
 */
export function TrashDialog({ visible, onClose }: TrashDialogProps) {
  const currentProject = useProjectStore((s) => s.currentProject);
  const addChapter = useChapterStore((s) => s.addChapter);
  const [trashed, setTrashed] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!currentProject) {
      setTrashed([]);
      return;
    }
    setLoading(true);
    try {
      const list = await listTrashedChapters(currentProject.id);
      setTrashed(list);
    } finally {
      setLoading(false);
    }
  }, [currentProject]);

  useEffect(() => {
    if (visible) reload();
  }, [visible, reload]);

  const handleRestore = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const restored = await restoreChapter(id);
      if (restored) {
        // 加回 store 让左侧栏显示
        addChapter(restored);
        setTrashed((prev) => prev.filter((c) => c.id !== id));
      }
    } finally {
      setBusy(false);
    }
  }, [addChapter]);

  const handleHardDelete = useCallback(async (id: string, title: string) => {
    if (!safeConfirm(`彻底删除「${title}」？此操作不可恢复。`)) return;
    setBusy(true);
    try {
      await hardDeleteChapter(id);
      setTrashed((prev) => prev.filter((c) => c.id !== id));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleEmptyAll = useCallback(async () => {
    if (trashed.length === 0) return;
    if (!safeConfirm(`清空回收站？将永久删除 ${trashed.length} 个章节，此操作不可恢复。`)) return;
    if (!currentProject) return;
    setBusy(true);
    try {
      await emptyChapterTrash(currentProject.id);
      setTrashed([]);
    } finally {
      setBusy(false);
    }
  }, [trashed.length, currentProject]);

  if (!visible) return null;

  return (
    <div
      className="nm-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="回收站"
    >
      <div
        className="nm-modal-card w-[520px] max-w-[calc(100vw-32px)] max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="nm-modal-header">
          <Trash2 size={15} style={{ color: 'hsl(var(--ink-light))' }} aria-hidden="true" />
          <h2 className="nm-modal-title">回收站</h2>
          {trashed.length > 0 && (
            <button
              onClick={handleEmptyAll}
              disabled={busy}
              className="text-[10px] px-2 py-1 rounded-xl transition-colors hover:bg-[hsl(var(--cinnabar-pale) / 0.6)] disabled:opacity-40"
              style={{ color: 'hsl(var(--cinnabar))' }}
              title="清空回收站"
              aria-label="清空回收站"
            >
              清空
            </button>
          )}
          <button
            onClick={reload}
            disabled={loading}
            className="nm-modal-close"
            title="刷新"
            aria-label="刷新"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
          <button
            onClick={onClose}
            className="nm-modal-close"
            title="关闭"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>

        {/* 列表 */}
        <div className="nm-modal-body px-2 py-2 space-y-1.5">
          {trashed.length === 0 ? (
            <div className="py-8 text-center">
              <div className="text-3xl mb-2 opacity-50">🗑️</div>
              <p className="text-[11px]" style={{ color: 'hsl(var(--ink-pale))' }}>
                {loading ? '加载中...' : '回收站为空'}
              </p>
            </div>
          ) : (
            trashed.map((ch) => (
              <div
                key={ch.id}
                className="nm-modal-item"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-medium truncate" style={{ color: 'hsl(var(--foreground))' }}>
                    {ch.title || '未命名章节'}
                  </div>
                  <div className="text-[10px] mt-0.5 flex items-center gap-2" style={{ color: 'hsl(var(--ink-pale))' }}>
                    <span>{ch.wordCount.toLocaleString()} 字</span>
                    {ch.deletedAt && (
                      <span>· 删除于 {new Date(ch.deletedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleRestore(ch.id)}
                  disabled={busy}
                  className="shrink-0 flex items-center gap-1 px-2 py-1 text-[10px] rounded-xl transition-colors hover:bg-[hsl(var(--willow-pale) / 0.7)] disabled:opacity-40"
                  style={{ color: 'hsl(var(--willow))' }}
                  title="还原章节"
                  aria-label="还原章节"
                >
                  <RotateCcw size={11} aria-hidden="true" />
                  还原
                </button>
                <button
                  onClick={() => handleHardDelete(ch.id, ch.title)}
                  disabled={busy}
                  className="shrink-0 p-1 rounded-xl transition-colors hover:bg-[hsl(var(--cinnabar-pale) / 0.7)] disabled:opacity-40"
                  style={{ color: 'hsl(var(--cinnabar))' }}
                  title="彻底删除（不可恢复）"
                  aria-label="彻底删除"
                >
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              </div>
            ))
          )}
        </div>

        {/* 底部提示 */}
        {trashed.length > 0 && (
          <div className="nm-modal-footer" style={{ justifyContent: 'flex-start' }}>
            <AlertTriangle size={11} style={{ color: 'hsl(var(--ochre))' }} aria-hidden="true" />
            <span className="text-[10px]" style={{ color: 'hsl(var(--ink-pale))' }}>
              软删除的章节可随时还原；点击"彻底删除"将永久移除。
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
