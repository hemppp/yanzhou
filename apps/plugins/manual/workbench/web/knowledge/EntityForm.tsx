import { useState } from 'react';
import type { Character, CharacterRelation, Item, ItemHolder, ItemRelation, ItemRelationType, Location } from '@novel/shared';
import { useCharacterStore, useItemStore } from '@novel-plugins/data-core/stores';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import { safeConfirm } from '@novel-plugins/ui-kit/safeConfirm';
import { Trash2, Tag, X, Check, UserPlus, UserMinus, ArrowRightLeft, Network, Plus, ArrowRight, ArrowLeft, ArrowLeftRight, Link2, Hand } from 'lucide-react';

interface EntityFormProps<T extends Character | Item | Location> {
  entity: T;
  onSave: (updates: Partial<T>) => void;
  onDelete: () => void;
}

const TAG_COLORS = [
  'bg-muted text-muted-foreground',
  'bg-amber-50 text-amber-700',
  'bg-rose-50 text-rose-700',
  'bg-sky-50 text-sky-700',
  'bg-emerald-50 text-emerald-700',
  'bg-violet-50 text-violet-700',
];

const HOLDER_ACTION_META: Record<ItemHolder['action'], { label: string; icon: typeof UserPlus; color: string }> = {
  gained: { label: '获得', icon: UserPlus, color: 'text-emerald-600 bg-emerald-50' },
  lost: { label: '失去', icon: UserMinus, color: 'text-rose-600 bg-rose-50' },
  transferred: { label: '受让', icon: ArrowRightLeft, color: 'text-sky-600 bg-sky-50' },
  held: { label: '持有', icon: Hand, color: 'text-slate-600 bg-slate-100' },
};

// 表单元素统一样式（顶层常量，子组件可复用）
const inputCls = "w-full px-3 py-2 text-sm text-foreground bg-card border border-border rounded-[14px] focus:outline-none focus:border-ring placeholder:text-muted-foreground transition-colors";
const textareaCls = "w-full px-3 py-2 text-sm text-foreground bg-card border border-border rounded-[14px] focus:outline-none focus:border-ring placeholder:text-muted-foreground transition-colors resize-none";
const selectCls = "w-full px-3 py-2 text-sm text-foreground bg-card border border-border rounded-[14px] focus:outline-none focus:border-ring transition-colors appearance-none";

function getTagColor(tag: string) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

function FormField({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

// 角色定位：主角 / 女主 / 配角 / 路人甲
type CharRole = 'protagonist' | 'femaleLead' | 'supporting' | 'minor';
const CHAR_ROLE_META: Record<CharRole, { label: string; activeCls: string }> = {
  protagonist: { label: '主角', activeCls: 'bg-amber-100 text-amber-800 border-amber-300' },
  femaleLead: { label: '女主', activeCls: 'bg-pink-100 text-pink-800 border-pink-300' },
  supporting: { label: '配角', activeCls: 'bg-sky-100 text-sky-800 border-sky-300' },
  minor: { label: '路人甲', activeCls: 'bg-muted text-muted-foreground border-border' },
};
const CHAR_ROLES: CharRole[] = ['protagonist', 'femaleLead', 'supporting', 'minor'];

export default function EntityForm<T extends Character | Item | Location>({ entity, onSave, onDelete }: EntityFormProps<T>) {
  const [name, setName] = useState(entity.name);
  const [description] = useState(
    'description' in entity ? (entity.description || '') : ''
  );
  const [tagInput, setTagInput] = useState('');

  // 内部统一 onSave：把泛型 Partial<T> 转换为可接收具体子类型参数的统一签名
  // 解决 CharacterRelation[] / ItemRelation[] 等不兼容字段导致 Partial<Character | Item> 无法互相转换的问题
   
  const saveAny: (updates: any) => void = onSave as any;

  const handleSave = () => {
    saveAny({ name, description });
  };

  const handleAddTag = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && tagInput.trim()) {
      e.preventDefault();
      const newTags = [...(entity.tags || []), tagInput.trim()];
      saveAny({ tags: newTags });
      setTagInput('');
    }
  };

  const handleRemoveTag = (tag: string) => {
    const newTags = (entity.tags || []).filter((t) => t !== tag);
    saveAny({ tags: newTags });
  };

  const isCharacter = 'aliases' in entity;
  const isItem = 'holders' in entity;
  const isLocation = 'states' in entity && !('holders' in entity) && !('aliases' in entity);

  return (
    <div className="px-6 py-6 max-w-2xl">
      {/* Header */}
      <div className="mb-8">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleSave}
          className="w-full text-2xl font-bold text-foreground bg-transparent border-none outline-none placeholder:text-muted-foreground/60 focus:ring-0"
          placeholder="未命名"
        />
        <div className="mt-2 h-px bg-muted" />
      </div>

      {/* Properties 区块 */}
      <div className="space-y-5">
        {/* Character 字段 */}
        {isCharacter && (
          <>
            {/* 角色定位：主角 / 女主 / 配角 / 路人甲 标签形式。
                点击标签即固定到角色上（选中态高亮），再次点击同一标签取消选中回退到默认。
                saveAny 走通用 onSave，与所有其他字段共用同一持久化链路。 */}
            <FormField label="角色定位" hint="点击标签为角色标记定位">
              <div className="flex flex-wrap gap-2">
                {CHAR_ROLES.map((r) => {
                  const current = (entity as Character).role;
                  const isActive = (current ?? 'minor') === r;
                  const meta = CHAR_ROLE_META[r];
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() => saveAny({ role: r })}
                      aria-pressed={isActive}
                      className={`inline-flex items-center px-3 py-1 text-xs font-medium rounded-full border transition-all ${
                        isActive
                          ? `${meta.activeCls} shadow-sm scale-105`
                          : 'bg-card text-muted-foreground border-border hover:border-ring hover:text-foreground'
                      }`}
                    >
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </FormField>

            {/* 基本信息只读概览卡：展示从正文自动提取的简介 / 首次出场章 / 标签，
                与下方编辑表单区分，一眼看到提取结果（不重复进入输入框） */}
            <div className="rounded-2xl border border-border bg-muted/60 p-4 space-y-3">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">基本信息</div>
              {(entity as Character).backstory && (
                <div>
                  <div className="text-[10px] text-muted-foreground mb-0.5">简介</div>
                  <p className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap">{(entity as Character).backstory}</p>
                </div>
              )}
              {(entity as Character).chapters && (entity as Character).chapters!.length > 0 && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-[10px] text-muted-foreground">首次出场</span>
                  <span className="text-foreground/85 font-medium">第 {Math.min(...(entity as Character).chapters!)} 章</span>
                  <span className="text-[10px] text-muted-foreground">（共 {(entity as Character).chapters!.length} 章）</span>
                </div>
              )}
              {(entity as Character).tags && (entity as Character).tags!.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {(entity as Character).tags!.map((t) => (
                    <span key={t} className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${getTagColor(t)}`}>{t}</span>
                  ))}
                </div>
              )}
            </div>

            <FormField label="别名" hint="用逗号分隔多个别名">
              <input
                value={(entity as Character).aliases?.join(', ') || ''}
                onChange={(e) => {
                  const aliases = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                  saveAny({ aliases });
                }}
                className={inputCls}
                placeholder="输入别名，用逗号分隔"
              />
            </FormField>

            <FormField label="外貌">
              <textarea
                value={(entity as Character).appearance || ''}
                onChange={(e) => saveAny({ appearance: e.target.value })}
                className={textareaCls}
                rows={3}
                placeholder="描述角色的外貌特征..."
              />
            </FormField>

            <FormField label="性格">
              <textarea
                value={(entity as Character).personality || ''}
                onChange={(e) => saveAny({ personality: e.target.value })}
                className={textareaCls}
                rows={3}
                placeholder="描述角色的性格特点..."
              />
            </FormField>

            <FormField label="欲望">
              <input
                value={(entity as Character).desire || ''}
                onChange={(e) => saveAny({ desire: e.target.value })}
                className={inputCls}
                placeholder="角色最渴望的是什么..."
              />
            </FormField>

            <FormField label="恐惧">
              <input
                value={(entity as Character).fear || ''}
                onChange={(e) => saveAny({ fear: e.target.value })}
                className={inputCls}
                placeholder="角色最害怕的是什么..."
              />
            </FormField>

            <FormField label="背景故事">
              <textarea
                value={(entity as Character).backstory || ''}
                onChange={(e) => saveAny({ backstory: e.target.value })}
                className={textareaCls}
                rows={5}
                placeholder="描述角色的背景故事..."
              />
            </FormField>

            <FormField label="说话风格">
              <input
                value={(entity as Character).speechStyle || ''}
                onChange={(e) => saveAny({ speechStyle: e.target.value })}
                className={inputCls}
                placeholder="描述角色的说话方式..."
              />
            </FormField>

            {/* 角色关系 */}
            <CharacterRelationsEditor
              character={entity as Character}
              onSave={onSave as (u: Partial<Character>) => void}
            />
          </>
        )}

        {/* Item 字段 */}
        {isItem && (
          <>
            <FormField label="类型">
              <select
                value={(entity as Item).type || 'other'}
                onChange={(e) => saveAny({ type: e.target.value })}
                className={selectCls}
              >
                <option value="weapon">武器</option>
                <option value="armor">防具</option>
                <option value="clothing">衣物</option>
                <option value="treasure">宝物</option>
                <option value="token">信物</option>
                <option value="artifact">法器</option>
                <option value="medicine">药物</option>
                <option value="potion">丹药</option>
                <option value="book">书籍</option>
                <option value="scroll">卷轴</option>
                <option value="document">文书</option>
                <option value="key">钥匙</option>
                <option value="gem">宝石</option>
                <option value="vehicle">载具</option>
                <option value="tool">工具</option>
                <option value="food">食物</option>
                <option value="plant">植物</option>
                <option value="animal">动物</option>
                <option value="prop">道具</option>
                <option value="other">其他</option>
              </select>
            </FormField>

            <FormField label="描述">
              <textarea
                value={(entity as Item).description || ''}
                onChange={(e) => saveAny({ description: e.target.value })}
                className={textareaCls}
                rows={4}
                placeholder="描述这个物品..."
              />
            </FormField>

            {/* 当前持有者多选（可共享） */}
            <ItemHoldersEditor
              item={entity as Item}
              onSave={onSave as (u: Partial<Item>) => void}
            />

            {/* 物品间关系（配对/包含/部件/对立/变形/关联） */}
            <ItemRelationsEditor
              item={entity as Item}
              onSave={onSave as (u: Partial<Item>) => void}
            />
          </>
        )}

        {/* Location 字段 */}
        {isLocation && (
          <FormField label="描述">
            <textarea
              value={(entity as Location).description || ''}
              onChange={(e) => saveAny({ description: e.target.value })}
              className={textareaCls}
              rows={4}
              placeholder="描述这个地方..."
            />
          </FormField>
        )}

        {/* Tags */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <Tag size={12} />
            标签
          </label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {(entity.tags || []).map((tag) => (
              <span
                key={tag}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full ${getTagColor(tag)}`}
              >
                {tag}
                <button
                  onClick={() => handleRemoveTag(tag)}
                  className="ml-0.5 hover:opacity-70 transition-opacity"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={handleAddTag}
            className={inputCls}
            placeholder="输入标签后按 Enter 添加..."
          />
        </div>
      </div>

      {/* Delete 按钮 */}
      <div className="mt-8 pt-6 border-t border-border/60">
        <button
          onClick={() => {
            if (safeConfirm('确定删除？此操作不可撤销。')) {
              onDelete();
            }
          }}
          className="inline-flex items-center gap-2 px-3 py-2 text-sm text-red-500 hover:text-red-600 hover:bg-red-50 rounded-xl transition-colors"
        >
          <Trash2 size={14} />
          删除
        </button>
      </div>
    </div>
  );
}

// ============================================================
// ItemHoldersEditor — 装备持有者编辑（多选 chip + 流转史时间线）
// 同一装备可被多角色同时持有
// ============================================================

interface ItemHoldersEditorProps {
  item: Item;
  onSave: (updates: Partial<Item>) => void;
}

function ItemHoldersEditor({ item, onSave }: ItemHoldersEditorProps) {
  const projectId = useCurrentProjectId();
  const characters = useCharacterStore((s) => s.characters);
  const getCharacterById = useCharacterStore((s) => s.getCharacterById);

  const projectChars = characters.filter((c) => c.projectId === projectId);
  const current = item.currentHolders ?? [];

  const toggleHolder = (cid: string) => {
    const next = current.includes(cid)
      ? current.filter((id) => id !== cid)
      : [...current, cid];
    onSave({ currentHolders: next });
  };

  // 流转史按 chapter 升序
  const timeline = [...(item.holders ?? [])].sort((a, b) => a.chapter - b.chapter);

  return (
    <>
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <Check size={12} />
          当前持有者
          <span className="text-[10px] text-muted-foreground normal-case font-normal">
            （可多选 — 装备可被多个角色共同持有）
          </span>
        </label>
        {projectChars.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-1">该项目中暂无角色，无法分配持有者</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {projectChars.map((c) => {
              const isOn = current.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleHolder(c.id)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                    isOn
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                      : 'bg-card text-muted-foreground border-border hover:bg-muted'
                  }`}
                  aria-pressed={isOn}
                >
                  {isOn && <Check size={10} />}
                  {c.name}
                </button>
              );
            })}
          </div>
        )}
        {current.length === 0 && projectChars.length > 0 && (
          <p className="text-[10px] text-muted-foreground mt-1">未选择任何角色（视为「无主装备」）</p>
        )}
      </div>

      {/* 装备流转史 */}
      {timeline.length > 0 && (
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            装备流转史
          </label>
          <ol className="border-l-2 border-border/60 pl-4 space-y-2">
            {timeline.map((h, i) => {
              const meta = HOLDER_ACTION_META[h.action];
              const Icon = meta.icon;
              const char = getCharacterById(h.characterId);
              return (
                <li key={`${h.characterId}-${h.chapter}-${h.action}-${i}`} className="text-xs flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-xl ${meta.color}`}>
                    <Icon size={10} />
                    {meta.label}
                  </span>
                  <span className="text-foreground/85">{char?.name ?? '未知角色'}</span>
                  <span className="text-muted-foreground">第 {h.chapter} 章</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </>
  );
}

// ============================================================
// CharacterRelationsEditor — 角色关系编辑（多对多 + 方向 + 章节）
// 支持：主动（from）、被动（to）、互相（mutual）
// ============================================================

interface CharacterRelationsEditorProps {
  character: Character;
  onSave: (updates: Partial<Character>) => void;
}

const DIRECTION_META: Record<CharacterRelation['direction'], { label: string; Icon: typeof ArrowRight; color: string }> = {
  from: { label: '对对方', Icon: ArrowRight, color: 'text-sky-700 bg-sky-50' },
  to: { label: '被对方', Icon: ArrowLeft, color: 'text-violet-700 bg-violet-50' },
  mutual: { label: '互相', Icon: ArrowLeftRight, color: 'text-emerald-700 bg-emerald-50' },
};

function CharacterRelationsEditor({ character, onSave }: CharacterRelationsEditorProps) {
  const projectId = useCurrentProjectId();
  const characters = useCharacterStore((s) => s.characters);
  const getCharacterById = useCharacterStore((s) => s.getCharacterById);
  const relations = character.relations ?? [];

  // 添加表单
  const [showAdd, setShowAdd] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [relType, setRelType] = useState('');
  const [chapter, setChapter] = useState<string>('');
  const [direction, setDirection] = useState<CharacterRelation['direction']>('mutual');
  const [relDesc, setRelDesc] = useState('');

  const projectChars = characters.filter(
    (c) => c.projectId === projectId && c.id !== character.id
  );

  const reset = () => {
    setTargetId('');
    setRelType('');
    setChapter('');
    setDirection('mutual');
    setRelDesc('');
    setShowAdd(false);
  };

  const addRelation = () => {
    if (!targetId || !relType.trim()) return;
    const next: CharacterRelation[] = [
      ...relations,
      {
        targetId,
        type: relType.trim(),
        direction,
        chapter: chapter === '' ? undefined : Number(chapter),
        description: relDesc.trim() || undefined,
      },
    ];
    onSave({ relations: next });
    reset();
  };

  const removeRelation = (idx: number) => {
    onSave({ relations: relations.filter((_, i) => i !== idx) });
  };

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
        <Network size={12} />
        角色关系
        <span className="text-[10px] text-muted-foreground normal-case font-normal">
          （与其他角色的关联 — 父亲/师父/仇人/朋友...）
        </span>
      </label>

      {/* 已有关系列表 */}
      {relations.length === 0 ? (
        <p className="text-xs text-muted-foreground italic py-1">尚未添加任何关系</p>
      ) : (
        <ol className="space-y-1.5">
          {relations.map((r, idx) => {
            const target = getCharacterById(r.targetId);
            const meta = DIRECTION_META[r.direction] ?? DIRECTION_META.mutual;
            const Icon = meta.Icon;
            return (
              <li
                key={`${r.targetId}-${r.type}-${idx}`}
                className="group flex items-center gap-2 px-2.5 py-1.5 rounded-2xl border border-border/60 bg-card hover:bg-muted transition-colors"
              >
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-xl text-[10px] ${meta.color}`}>
                  <Icon size={10} />
                  {meta.label}
                </span>
                <span className="text-sm text-foreground font-medium">
                  {r.type}
                </span>
                <span className="text-xs text-muted-foreground">
                  {target?.name ?? '未知角色'}
                </span>
                {r.chapter !== undefined && (
                  <span className="text-[10px] text-muted-foreground">第 {r.chapter} 章</span>
                )}
                {r.description && (
                  <span className="text-[10px] text-muted-foreground truncate flex-1" title={r.description}>
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

      {/* 添加 */}
      {!showAdd ? (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          disabled={projectChars.length === 0}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground/85 hover:bg-muted border border-dashed border-border rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={12} />
          添加关系
        </button>
      ) : (
        <div className="p-3 border border-border rounded-2xl bg-muted/50 space-y-2.5">
          {projectChars.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">该项目中暂无其他角色，无法添加关系</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  className={selectCls}
                >
                  <option value="">选择目标角色...</option>
                  {projectChars.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <input
                  value={relType}
                  onChange={(e) => setRelType(e.target.value)}
                  className={inputCls}
                  placeholder="关系类型（如：父亲、仇人）"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={direction}
                  onChange={(e) => setDirection(e.target.value as CharacterRelation['direction'])}
                  className={selectCls}
                >
                  <option value="mutual">互相</option>
                  <option value="from">我 → 对对方</option>
                  <option value="to">对方 → 我</option>
                </select>
                <input
                  value={chapter}
                  onChange={(e) => setChapter(e.target.value)}
                  className={inputCls}
                  type="number"
                  min={1}
                  placeholder="关系建立章节（可选）"
                />
              </div>
              <input
                value={relDesc}
                onChange={(e) => setRelDesc(e.target.value)}
                className={inputCls}
                placeholder="补充说明（可选）"
              />
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={addRelation}
                  disabled={!targetId || !relType.trim()}
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
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// ItemRelationsEditor — 物品间关系编辑（多对多 + 关系类型 + 章节 + 描述）
// 支持：paired_with / contains / part_of / opposite_of / transforms_into / related_to
// ============================================================

interface ItemRelationsEditorProps {
  item: Item;
  onSave: (updates: Partial<Item>) => void;
}

const ITEM_RELATION_META: Record<ItemRelationType, { label: string; color: string; hint: string }> = {
  paired_with: { label: '配对', color: 'text-sky-700 bg-sky-50', hint: '剑-鞘、钥匙-锁' },
  contains: { label: '包含', color: 'text-amber-700 bg-amber-50', hint: '宝箱-金币' },
  part_of: { label: '部件', color: 'text-violet-700 bg-violet-50', hint: '组件-整机' },
  opposite_of: { label: '对立', color: 'text-rose-700 bg-rose-50', hint: '正-邪法宝' },
  transforms_into: { label: '变形', color: 'text-emerald-700 bg-emerald-50', hint: '狼人-人形' },
  related_to: { label: '关联', color: 'text-foreground/85 bg-muted', hint: '泛关联' },
};

const ITEM_RELATION_TYPES: ItemRelationType[] = [
  'paired_with', 'contains', 'part_of', 'opposite_of', 'transforms_into', 'related_to',
];

function ItemRelationsEditor({ item, onSave }: ItemRelationsEditorProps) {
  const projectId = useCurrentProjectId();
  const allItems = useItemStore((s) => s.items);
  const relations = item.relations ?? [];

  const [showAdd, setShowAdd] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [relType, setRelType] = useState<ItemRelationType>('related_to');
  const [chapter, setChapter] = useState('');
  const [relDesc, setRelDesc] = useState('');

  const projectItems = allItems.filter(
    (i) => i.projectId === projectId && i.id !== item.id,
  );

  const findItemById = (id: string) => allItems.find((i) => i.id === id);

  const reset = () => {
    setTargetId('');
    setRelType('related_to');
    setChapter('');
    setRelDesc('');
    setShowAdd(false);
  };

  const addRelation = () => {
    if (!targetId) return;
    const next: ItemRelation[] = [
      ...relations,
      {
        targetItemId: targetId,
        type: relType,
        chapter: chapter === '' ? undefined : Number(chapter),
        description: relDesc.trim() || undefined,
      },
    ];
    onSave({ relations: next });
    reset();
  };

  const removeRelation = (idx: number) => {
    onSave({ relations: relations.filter((_, i) => i !== idx) });
  };

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
        <Link2 size={12} />
        物品间关系
        <span className="text-[10px] text-muted-foreground normal-case font-normal">
          （与其他物品的关联 — 配对/包含/部件/对立/变形）
        </span>
      </label>

      {/* 已有关系列表 */}
      {relations.length === 0 ? (
        <p className="text-xs text-muted-foreground italic py-1">尚未添加任何物品关系</p>
      ) : (
        <ol className="space-y-1.5">
          {relations.map((r, idx) => {
            const target = findItemById(r.targetItemId);
            const meta = ITEM_RELATION_META[r.type] ?? ITEM_RELATION_META.related_to;
            return (
              <li
                key={`${r.targetItemId}-${r.type}-${idx}`}
                className="group flex items-center gap-2 px-2.5 py-1.5 rounded-2xl border border-border/60 bg-card hover:bg-muted transition-colors"
              >
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-xl text-[10px] ${meta.color}`}>
                  {meta.label}
                </span>
                <span className="text-sm text-foreground font-medium">
                  {target?.name ?? '未知物品'}
                </span>
                {r.chapter !== undefined && (
                  <span className="text-[10px] text-muted-foreground">第 {r.chapter} 章</span>
                )}
                {r.description && (
                  <span className="text-[10px] text-muted-foreground truncate flex-1" title={r.description}>
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

      {/* 添加 */}
      {!showAdd ? (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          disabled={projectItems.length === 0}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground/85 hover:bg-muted border border-dashed border-border rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={12} />
          添加物品关系
        </button>
      ) : (
        <div className="p-3 border border-border rounded-2xl bg-muted/50 space-y-2.5">
          {projectItems.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">该项目中暂无其他物品，无法添加关系</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  className={selectCls}
                >
                  <option value="">选择目标物品...</option>
                  {projectItems.map((i) => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
                <select
                  value={relType}
                  onChange={(e) => setRelType(e.target.value as ItemRelationType)}
                  className={selectCls}
                >
                  {ITEM_RELATION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {ITEM_RELATION_META[t].label}（{ITEM_RELATION_META[t].hint}）
                    </option>
                  ))}
                </select>
              </div>
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
