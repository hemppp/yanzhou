// ============================================================
// LocationRelationsEditor — 地点关系编辑（地点 ↔ 地点 / 地点 ↔ 角色）
//
// 关系不再由「角色与地点同章出现」推断（主角每章换地方会把地图连成毛线球），
// 所以必须留一个手动补的口子：扫描没识别到的关系，用户可以自己加。
// 存储只写在地点侧（角色的结构里没有地点字段），图上按无序对去重。
// ============================================================

import { useState } from 'react';
import type { Location, LocationRelation, LocationRelationType } from '@novel/shared';
import {
  useCharacterStore,
  useLocationStore,
} from '@novel-plugins/data-core/stores';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import { Link2, Plus, X } from 'lucide-react';

interface LocationRelationsEditorProps {
  location: Location;
  onSave: (updates: Partial<Location>) => void;
}

const LOCATION_RELATION_META: Record<
  LocationRelationType,
  { label: string; color: string; hint: string }
> = {
  located_in: { label: '位于', color: 'text-sky-700 bg-sky-50', hint: '在……之内 / 角色在某地' },
  nearby: { label: '邻近', color: 'text-emerald-700 bg-emerald-50', hint: '两处相邻/挨着' },
  routes_to: { label: '通往', color: 'text-amber-700 bg-amber-50', hint: '道路/传送连接两处' },
  related_to: { label: '关联', color: 'text-foreground/85 bg-muted', hint: '泛关联' },
};

const LOCATION_RELATION_TYPES: LocationRelationType[] = [
  'located_in', 'nearby', 'routes_to', 'related_to',
];

// 与 EntityForm 其他表单一致的统一样式（该文件内的常量不导出，这里保持一致即可）
const inputCls =
  'w-full px-3 py-2 text-sm text-foreground bg-card border border-border rounded-[14px] focus:outline-none focus:border-ring placeholder:text-muted-foreground transition-colors';
const selectCls =
  'w-full px-3 py-2 text-sm text-foreground bg-card border border-border rounded-[14px] focus:outline-none focus:border-ring transition-colors appearance-none';

export function LocationRelationsEditor({ location, onSave }: LocationRelationsEditorProps) {
  const projectId = useCurrentProjectId();
  const locations = useLocationStore((s) => s.locations);
  const characters = useCharacterStore((s) => s.characters);
  const relations = location.relations ?? [];

  const [showAdd, setShowAdd] = useState(false);
  const [targetKind, setTargetKind] = useState<LocationRelation['targetKind']>('location');
  const [targetId, setTargetId] = useState('');
  const [relType, setRelType] = useState<LocationRelationType>('located_in');
  const [chapter, setChapter] = useState('');
  const [relDesc, setRelDesc] = useState('');

  const projectLocations = locations.filter(
    (l) => l.projectId === projectId && l.id !== location.id,
  );
  const projectCharacters = characters.filter((c) => c.projectId === projectId);
  const targetOptions = targetKind === 'location' ? projectLocations : projectCharacters;

  const findTargetName = (relation: LocationRelation): string | undefined => {
    if (relation.targetKind === 'location') {
      return locations.find((l) => l.id === relation.targetId)?.name;
    }
    return characters.find((c) => c.id === relation.targetId)?.name;
  };

  const reset = () => {
    setTargetKind('location');
    setTargetId('');
    setRelType('located_in');
    setChapter('');
    setRelDesc('');
    setShowAdd(false);
  };

  const addRelation = () => {
    if (!targetId) return;
    const relation: LocationRelation = {
      targetId,
      targetKind,
      type: relType,
      chapter: chapter === '' ? undefined : Number(chapter),
      description: relDesc.trim() || undefined,
    };
    // 一对象一类型的重复关系在图上会被去重成一条，这里直接拦住不重复存
    if (
      relations.some(
        (r) => r.targetId === targetId && r.targetKind === targetKind && r.type === relType,
      )
    ) {
      reset();
      return;
    }
    onSave({ relations: [...relations, relation] });
    reset();
  };

  const removeRelation = (idx: number) => {
    onSave({ relations: relations.filter((_, i) => i !== idx) });
  };

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
        <Link2 size={12} />
        地点关系
        <span className="text-[10px] text-muted-foreground normal-case font-normal">
          （与其他地点或角色的关联 — 位于/邻近/通往）
        </span>
      </label>

      {relations.length === 0 ? (
        <p className="text-xs text-muted-foreground italic py-1">尚未识别到关系，可手动添加</p>
      ) : (
        <ol className="space-y-1.5">
          {relations.map((r, idx) => {
            const targetName = findTargetName(r);
            const meta = LOCATION_RELATION_META[r.type] ?? LOCATION_RELATION_META.related_to;
            return (
              <li
                key={`${r.targetKind}-${r.targetId}-${r.type}-${idx}`}
                className="group flex items-center gap-2 px-2.5 py-1.5 rounded-2xl border border-border/60 bg-card hover:bg-muted transition-colors"
              >
                <span
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-xl text-[10px] ${meta.color}`}
                >
                  {meta.label}
                </span>
                <span className="text-sm text-foreground font-medium">
                  {targetName ?? (r.targetKind === 'location' ? '未知地点' : '未知角色')}
                </span>
                {r.chapter !== undefined && r.chapter !== null && (
                  <span className="text-[10px] text-muted-foreground">第 {r.chapter} 章</span>
                )}
                {r.description && (
                  <span
                    className="text-[10px] text-muted-foreground truncate flex-1"
                    title={r.description}
                  >
                    {r.description}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeRelation(idx)}
                  className="ml-auto p-1 rounded-xl text-muted-foreground/60 hover:text-rose-500 hover:bg-rose-50 transition-colors opacity-0 group-hover:opacity-100"
                  title="删除此关系"
                  aria-label="删除此关系"
                >
                  <X size={12} />
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {!showAdd ? (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          disabled={projectLocations.length === 0 && projectCharacters.length === 0}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground/85 hover:bg-muted border border-dashed border-border rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={12} />
          添加地点关系
        </button>
      ) : (
        <div className="p-3 border border-border rounded-2xl bg-muted/50 space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <select
              value={targetKind}
              onChange={(e) => {
                setTargetKind(e.target.value as LocationRelation['targetKind']);
                setTargetId('');
              }}
              className={selectCls}
              aria-label="关系对象类型"
            >
              <option value="location">地点</option>
              <option value="character">角色</option>
            </select>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className={selectCls}
              aria-label="关系对象"
            >
              <option value="">选择目标…</option>
              {targetOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <select
            value={relType}
            onChange={(e) => setRelType(e.target.value as LocationRelationType)}
            className={selectCls}
            aria-label="关系类型"
          >
            {LOCATION_RELATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {LOCATION_RELATION_META[t].label}（{LOCATION_RELATION_META[t].hint}）
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={chapter}
              onChange={(e) => setChapter(e.target.value)}
              className={inputCls}
              type="number"
              min={1}
              placeholder="关系建立章节（可选）"
            />
            <input
              value={relDesc}
              onChange={(e) => setRelDesc(e.target.value)}
              className={inputCls}
              placeholder="补充说明（可选）"
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={addRelation}
              disabled={!targetId}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-primary hover:bg-primary/90 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              保存关系
            </button>
            <button
              type="button"
              onClick={reset}
              className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground/85 transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}