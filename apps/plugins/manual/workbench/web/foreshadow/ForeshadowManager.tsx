import { useState } from 'react';
import { useForeshadowStore, useChapterStore } from '@novel-plugins/data-core/stores';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import {
  ChevronDown, ChevronRight, AlertCircle, RefreshCw, Sprout, Lightbulb,
  CircleCheck, CircleOff, Bookmark, NotebookPen, Pencil, Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { safeConfirm } from '@novel-plugins/ui-kit/safeConfirm';
import type { Foreshadow } from '@novel/shared';

const statusConfig: Record<Foreshadow['status'], {
  label: string; Icon: LucideIcon; groupIconClass: string; activeClass: string;
}> = {
  planted: {
    label: '已播种', Icon: Sprout, groupIconClass: 'text-emerald-600',
    activeClass: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  },
  hinted: {
    label: '已暗示', Icon: Lightbulb, groupIconClass: 'text-amber-600',
    activeClass: 'bg-amber-50 text-amber-700 border-amber-300',
  },
  payed_off: {
    label: '已回收', Icon: CircleCheck, groupIconClass: 'text-blue-600',
    activeClass: 'bg-blue-50 text-blue-700 border-blue-300',
  },
  abandoned: {
    label: '已废弃', Icon: CircleOff, groupIconClass: 'text-muted-foreground',
    activeClass: 'bg-muted text-muted-foreground border-border',
  },
};

const foreshadowTypeLabels: Record<Foreshadow['type'], string> = {
  identity: '身份', motivation: '动机', relation: '关系',
  trauma: '创伤', turning: '转折', fate: '命运',
};

export function ForeshadowManager() {
  // 使用 selector 拆分订阅，避免订阅整个 store 导致无关字段变化触发重渲染
  const foreshadows = useForeshadowStore((s) => s.foreshadows);
  const updateForeshadow = useForeshadowStore((s) => s.updateForeshadow);
  const deleteForeshadow = useForeshadowStore((s) => s.deleteForeshadow);
  const chapters = useChapterStore((s) => s.chapters);
  const projectId = useCurrentProjectId();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 如果没有项目 ID，显示提示信息
  if (!projectId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Bookmark size={44} className="mx-auto text-muted-foreground/25 mb-4" strokeWidth={1.5} />
          <p className="text-sm text-muted-foreground">请先选择一个项目</p>
        </div>
      </div>
    );
  }

  const grouped = {
    planted: foreshadows.filter((f) => f.projectId === projectId && f.status === 'planted'),
    hinted: foreshadows.filter((f) => f.projectId === projectId && f.status === 'hinted'),
    payed_off: foreshadows.filter((f) => f.projectId === projectId && f.status === 'payed_off'),
    abandoned: foreshadows.filter((f) => f.projectId === projectId && f.status === 'abandoned'),
  };

  const handleStatusChange = (id: string, newStatus: Foreshadow['status']) => {
    try {
      setError(null);
      const updates: Partial<Foreshadow> = { status: newStatus, updatedAt: Date.now() };
      if (newStatus === 'payed_off') {
        const lastChapter = chapters.length > 0 ? chapters[chapters.length - 1] : null;
        updates.payoffChapter = lastChapter ? lastChapter.order : 1;
      }
      updateForeshadow(id, updates);
    } catch {
      setError('更新伏笔状态失败，请重试');
    }
  };

  const handleSaveDesc = (id: string) => {
    try {
      setError(null);
      updateForeshadow(id, { description: editDesc, updatedAt: Date.now() });
      setEditingId(null);
    } catch {
      setError('保存伏笔失败，请重试');
    }
  };

  const handleDelete = (id: string) => {
    try {
      setError(null);
      if (!safeConfirm('确定删除此伏笔？')) return;
      deleteForeshadow(id);
    } catch {
      setError('删除伏笔失败，请重试');
    }
  };

  const renderGroup = (status: Foreshadow['status'], items: Foreshadow[]) => {
    const config = statusConfig[status];
    if (items.length === 0) return null;

    return (
      <div key={status} className="mb-5">
        <div className="flex items-center gap-1.5 mb-2">
          <config.Icon size={14} aria-hidden="true" className={config.groupIconClass} />
          <h3 className="text-xs font-semibold text-muted-foreground">{config.label}</h3>
          <span className="text-[10px] text-muted-foreground bg-muted/60 rounded-full px-1.5 leading-4">
            {items.length}
          </span>
        </div>
        {items.map((fs) => {
          const expanded = expandedId === fs.id;
          return (
            <div
              key={fs.id}
              className={`rounded-2xl border mb-1.5 bg-card transition-colors ${
                expanded ? 'border-border shadow-sm' : 'border-border hover:border-ring'
              }`}
            >
              <div
                className="flex items-center gap-2 cursor-pointer min-w-0 px-3 py-2 rounded-2xl"
                onClick={() => setExpandedId(expanded ? null : fs.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpandedId(expanded ? null : fs.id); }}
                tabIndex={0}
                role="button"
                aria-expanded={expanded}
              >
                {expanded
                  ? <ChevronDown size={14} aria-hidden="true" className="text-muted-foreground shrink-0" />
                  : <ChevronRight size={14} aria-hidden="true" className="text-muted-foreground shrink-0" />}
                {editingId === fs.id ? (
                  <input
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    onBlur={() => handleSaveDesc(fs.id)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveDesc(fs.id)}
                    className="flex-1 text-xs px-2 py-1 border border-ring rounded-xl bg-transparent outline-none"
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    aria-label="编辑伏笔描述"
                  />
                ) : (
                  <span className="flex-1 text-xs truncate text-foreground" title="双击编辑描述">
                    {fs.description}
                  </span>
                )}
                <span className="shrink-0 text-[10px] text-muted-foreground bg-muted/60 rounded-full px-1.5 py-0.5">
                  第{fs.seedChapter}章
                </span>
              </div>

              {expanded && (
                <div className="px-3 pb-2.5 pt-2 border-t border-border space-y-2.5">
                  <div className="text-[10px] text-muted-foreground flex items-center flex-wrap gap-x-1.5">
                    <span>{foreshadowTypeLabels[fs.type] ?? fs.type}</span>
                    <span>·</span>
                    <span>播种于第{fs.seedChapter}章</span>
                    {fs.payoffChapter != null && (
                      <>
                        <span>·</span>
                        <span>回收于第{fs.payoffChapter}章</span>
                      </>
                    )}
                    {fs.hints.length > 0 && (
                      <>
                        <span>·</span>
                        <span>暗示 {fs.hints.length} 次</span>
                      </>
                    )}
                  </div>

                  {Array.isArray(fs.tags) && fs.tags.length > 0 && (
                    <div className="flex gap-1.5 flex-wrap">
                      {fs.tags.map((tag) => (
                        <span key={tag} className="text-[10px] text-muted-foreground bg-muted/60 rounded-full px-1.5 py-0.5">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-1.5 flex-wrap">
                    {(['planted', 'hinted', 'payed_off', 'abandoned'] as const).map((s) => {
                      const active = fs.status === s;
                      const sc = statusConfig[s];
                      return (
                        <button
                          key={s}
                          onClick={() => handleStatusChange(fs.id, s)}
                          className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-full border transition-colors cursor-pointer ${
                            active
                              ? `${sc.activeClass} font-medium`
                              : 'border-border text-muted-foreground hover:bg-accent'
                          }`}
                          aria-label={`设置状态为${sc.label}`}
                          aria-pressed={active}
                        >
                          <sc.Icon size={11} aria-hidden="true" />
                          {sc.label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex justify-end gap-1">
                    <button
                      onClick={() => { setEditingId(fs.id); setEditDesc(fs.description); }}
                      className="w-7 h-7 rounded-xl inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                      aria-label="编辑描述"
                      title="编辑描述"
                    >
                      <Pencil size={13} aria-hidden="true" />
                    </button>
                    <button
                      onClick={() => handleDelete(fs.id)}
                      className="w-7 h-7 rounded-xl inline-flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      aria-label="删除此伏笔"
                      title="删除"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground tracking-tight flex items-center gap-1.5">
          <Bookmark size={14} aria-hidden="true" className="text-primary" />
          伏笔管理
        </h2>
        <p className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1">
          在编辑器中选中文字，点「添加伏笔」来创建
        </p>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {error && (
          <div className="mb-3 p-3 bg-destructive/10 border border-destructive/40 rounded-2xl flex items-start gap-2.5" role="alert">
            <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-destructive font-medium">{error}</p>
              <button
                onClick={() => setError(null)}
                className="inline-flex items-center gap-1.5 text-xs mt-2 px-2 py-1 rounded-xl bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors cursor-pointer"
              >
                <RefreshCw size={12} aria-hidden="true" />
                关闭
              </button>
            </div>
          </div>
        )}
        {foreshadows.filter(f => f.projectId === projectId).length === 0 ? (
          <div className="border border-border rounded-2xl p-6">
            <div className="text-center mb-4">
              <div className="w-14 h-14 rounded-full bg-muted/60 flex items-center justify-center mx-auto mb-3">
                <NotebookPen size={22} aria-hidden="true" className="text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">暂无伏笔</p>
            </div>
            <div className="text-xs text-muted-foreground space-y-2 max-w-xs mx-auto">
              <p className="mb-3">在编辑器中创建伏笔：</p>
              <ol className="space-y-1.5 list-none">
                <li className="flex items-start gap-2">
                  <span className="shrink-0 w-4 h-4 rounded-full bg-muted/80 text-[10px] flex items-center justify-center">1</span>
                  <span>选中要标记的文字内容</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="shrink-0 w-4 h-4 rounded-full bg-muted/80 text-[10px] flex items-center justify-center">2</span>
                  <span>在划词菜单中点「添加伏笔」</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="shrink-0 w-4 h-4 rounded-full bg-muted/80 text-[10px] flex items-center justify-center">3</span>
                  <span>填写描述与类型后确认创建</span>
                </li>
              </ol>
            </div>
          </div>
        ) : (
          <>
            {renderGroup('planted', grouped.planted)}
            {renderGroup('hinted', grouped.hinted)}
            {renderGroup('payed_off', grouped.payed_off)}
            {renderGroup('abandoned', grouped.abandoned)}
          </>
        )}
      </div>
    </div>
  );
}
