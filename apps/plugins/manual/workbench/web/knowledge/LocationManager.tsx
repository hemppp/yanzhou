import { useState } from 'react';
import { useLocationStore } from '@novel-plugins/data-core/stores';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import EntityForm from './EntityForm';
import { Search, Plus, MapPin, AlertCircle, Map, List, Network } from 'lucide-react';
import { nanoid } from 'nanoid';
import type { Location } from '@novel/shared';
import { LocationGraph } from './LocationGraph';

const AVATAR_GRADIENTS = [
  'from-emerald-200 to-teal-200',
  'from-sky-200 to-blue-200',
  'from-amber-200 to-yellow-200',
  'from-rose-200 to-pink-200',
  'from-violet-200 to-indigo-200',
  'from-lime-200 to-green-200',
];

const TAG_COLORS = [
  'bg-foreground/5 text-muted-foreground',
  'bg-amber-50 text-amber-700',
  'bg-rose-50 text-rose-700',
  'bg-sky-50 text-sky-700',
  'bg-emerald-50 text-emerald-700',
  'bg-violet-50 text-violet-700',
];

function getAvatarGradient(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

function getTagColor(tag: string) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

export function LocationManager() {
  const locations = useLocationStore((s) => s.locations);
  const addLocation = useLocationStore((s) => s.addLocation);
  const updateLocation = useLocationStore((s) => s.updateLocation);
  const deleteLocation = useLocationStore((s) => s.deleteLocation);
  const projectId = useCurrentProjectId();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Location | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'graph'>('list');

  if (!projectId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-foreground/5 flex items-center justify-center mx-auto mb-4">
            <AlertCircle size={28} className="text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground font-medium">请先选择一个项目</p>
        </div>
      </div>
    );
  }

  const filtered = locations.filter(
    (l) => l.projectId === projectId && (l.name.includes(search) || l.tags?.some(t => t.includes(search)))
  );

  const handleCreate = () => {
    try {
      setError(null);
      const newLoc: Location = {
        id: nanoid(),
        projectId,
        name: '新地点',
        description: '',
        states: [],
        chapters: [],
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      addLocation(newLoc);
      setSelectedId(newLoc.id);
      setEditing(newLoc);
    } catch {
      setError('创建地点失败，请重试');
    }
  };

  const handleSave = (updates: Partial<Location>) => {
    if (!editing) return;
    try {
      setError(null);
      updateLocation(editing.id, updates as Partial<Location>);
      setEditing({ ...editing, ...updates } as Location);
    } catch {
      setError('保存地点失败，请重试');
    }
  };

  const handleDelete = () => {
    if (!editing) return;
    try {
      setError(null);
      deleteLocation(editing.id);
      setSelectedId(null);
      setEditing(null);
    } catch {
      setError('删除地点失败，请重试');
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* 顶部工具栏：视图切换 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground tracking-tight">地点管理</span>
        </div>
        <div className="flex items-center gap-1 p-0.5 rounded-2xl bg-foreground/5">
          <button
            onClick={() => setViewMode('list')}
            className={`p-1.5 rounded-xl transition-all ${viewMode === 'list' ? 'bg-white shadow-sm' : ''}`}
            style={{ color: viewMode === 'list' ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))' }}
            aria-label="列表视图"
            title="列表视图"
          >
            <List size={14} />
          </button>
          <button
            onClick={() => setViewMode('graph')}
            className={`p-1.5 rounded-xl transition-all ${viewMode === 'graph' ? 'bg-white shadow-sm' : ''}`}
            style={{ color: viewMode === 'graph' ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))' }}
            aria-label="图谱视图"
            title="图谱视图"
          >
            <Network size={14} />
          </button>
        </div>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-hidden">
        {viewMode === 'list' ? (
          <div className="h-full flex">
            {/* Sidebar */}
            <div className="w-72 border-r border-border flex flex-col">
              {/* Header */}
              <div className="px-4 pt-4 pb-3">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-semibold text-foreground tracking-tight">地点列表</h2>
                  <button
                    onClick={handleCreate}
                    className="p-1.5 rounded-xl text-muted-foreground hover:text-muted-foreground hover:bg-foreground/5 transition-colors"
                    aria-label="创建新地点"
                  >
                    <Plus size={14} />
                  </button>
                </div>
                {/* Search */}
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <label htmlFor="location-search" className="sr-only">搜索地点</label>
                  <input
                    id="location-search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索地点..."
                    className="w-full pl-8 pr-3 py-1.5 text-sm bg-white border border-border rounded-[14px] focus:outline-none focus:border-ring/50 placeholder:text-muted-foreground transition-colors"
                  />
                </div>
              </div>

              {/* Location 列表 */}
              <div className="flex-1 overflow-y-auto px-2 pb-2" role="listbox" aria-label="地点列表">
                {filtered.length === 0 ? (
                  <div className="px-4 py-8 text-center">
                    <div className="w-12 h-12 rounded-full bg-foreground/5 flex items-center justify-center mx-auto mb-3">
                      <MapPin size={20} className="text-muted-foreground" />
                    </div>
                    <p className="text-sm text-muted-foreground">{search ? '无匹配地点' : '暂无地点'}</p>
                    {!search && (
                      <button onClick={handleCreate} className="mt-3 text-xs text-muted-foreground hover:text-foreground underline underline-offset-2">
                        创建第一个地点
                      </button>
                    )}
                  </div>
                ) : (
                  locations.map((loc) => (
                    <button
                      key={loc.id}
                      onClick={() => { setSelectedId(loc.id); setEditing(loc); setError(null); }}
                      className={`w-full text-left px-3 py-2.5 rounded-2xl mb-0.5 transition-colors group ${
                        selectedId === loc.id
                          ? 'bg-foreground/5'
                          : 'hover:bg-foreground/[0.03]'
                      }`}
                      role="option"
                      aria-selected={selectedId === loc.id}
                    >
                      <div className="flex items-center gap-2.5">
                        <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${getAvatarGradient(loc.name)} flex items-center justify-center shrink-0`}>
                          <MapPin size={14} className="text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-foreground truncate">{loc.name}</div>
                          {loc.description && (
                            <div className="text-xs text-muted-foreground truncate">{loc.description.slice(0, 30)}</div>
                          )}
                        </div>
                      </div>
                      {Array.isArray(loc.tags) && loc.tags.length > 0 && (
                        <div className="flex gap-1 mt-1.5 ml-[42px] flex-wrap">
                          {loc.tags.slice(0, 3).map((tag) => (
                            <span key={tag} className={`inline-block px-2 py-0.5 text-[10px] font-medium rounded-full ${getTagColor(tag)}`}>
                              {tag}
                            </span>
                          ))}
                          {loc.tags.length > 3 && (
                            <span className="inline-block px-1.5 py-0.5 text-[10px] text-muted-foreground">+{loc.tags.length - 3}</span>
                          )}
                        </div>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Main 内容 */}
            <div className="flex-1 overflow-y-auto">
              {error && (
                <div className="mx-6 mt-4 px-4 py-3 bg-red-50 border border-red-100 rounded-2xl flex items-start gap-2.5" role="alert">
                  <AlertCircle size={15} className="text-red-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm text-red-600">{error}</p>
                    <button
                      onClick={() => setError(null)}
                      className="text-xs text-red-400 hover:text-red-600 mt-1 transition-colors"
                    >
                      关闭
                    </button>
                  </div>
                </div>
              )}
              {editing ? (
                <EntityForm
                  entity={editing}
                  onSave={handleSave}
                  onDelete={handleDelete}
                />
              ) : (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center">
                    <div className="w-16 h-16 rounded-full bg-foreground/[0.03] flex items-center justify-center mx-auto mb-4">
                      <Map size={28} className="text-muted-foreground/60" />
                    </div>
                    <p className="text-sm text-muted-foreground">选择地点查看详情</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <LocationGraph />
        )}
      </div>
    </div>
  );
}
