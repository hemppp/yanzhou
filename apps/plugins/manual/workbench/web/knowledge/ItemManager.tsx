// ============================================================
// ItemManager — 物品管理（以角色为中心）
// 搜索人物 → 显示该人物持有物品 → 点击物品查看流转历史
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { useItemStore, useCharacterStore } from '@novel-plugins/data-core/stores';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import { Search, Package, AlertCircle, User, PackageOpen, ArrowRight, Clock, Gift, ArrowLeftRight, Coins } from 'lucide-react';
import { deriveCurrentHolders, type ItemHolder } from '@novel/shared';
import { mergeSimilarCharacters } from './characterMerge';
import { CreditLedger } from './CreditLedger';

const ITEM_TYPE_LABELS: Record<string, string> = {
  weapon: '武器',
  token: '信物',
  artifact: '法器',
  document: '文书',
  key: '钥匙',
  medicine: '药物',
  other: '其他',
  clothing: '衣物',
  vehicle: '载具',
  treasure: '宝物',
  book: '书籍',
  food: '食物',
  plant: '植物',
  animal: '动物',
  tool: '工具',
  prop: '道具',
  potion: '丹药',
  armor: '防具',
  scroll: '卷轴',
  gem: '宝石',
};

function getItemTypeColor(type?: string): string {
  // 水墨化（2026-09-15）：按类型配色 → 按墨阶配色（饱和度恒 0）
  const colors: Record<string, string> = {
    weapon: 'hsl(0 0% 12%)',
    token: 'hsl(0 0% 34%)',
    artifact: 'hsl(0 0% 14%)',
    document: 'hsl(0 0% 52%)',
    key: 'hsl(0 0% 22%)',
    medicine: 'hsl(0 0% 44%)',
    clothing: 'hsl(0 0% 40%)',
    vehicle: 'hsl(0 0% 42%)',
    treasure: 'hsl(0 0% 20%)',
    book: 'hsl(0 0% 30%)',
    food: 'hsl(0 0% 58%)',
    plant: 'hsl(0 0% 46%)',
    animal: 'hsl(0 0% 28%)',
    tool: 'hsl(0 0% 36%)',
    prop: 'hsl(0 0% 60%)',
    potion: 'hsl(0 0% 48%)',
    armor: 'hsl(0 0% 26%)',
    scroll: 'hsl(0 0% 38%)',
    gem: 'hsl(0 0% 16%)',
    other: 'hsl(0 0% 50%)',
  };
  const key = type?.toLowerCase() || 'other';
  return colors[key] ?? 'hsl(0 0% 50%)';
}

export function ItemManager() {
  const items = useItemStore((s) => s.items);
  const characters = useCharacterStore((s) => s.characters);
  const getCharacterById = useCharacterStore((s) => s.getCharacterById);
  const projectId = useCurrentProjectId();
  const [mode, setMode] = useState<'items' | 'credits'>('items');
  const [charSearch, setCharSearch] = useState('');
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  // 挂载时自动合并相似角色
  useEffect(() => {
    const charState = useCharacterStore.getState();
    const itemState = useItemStore.getState();
    const projectChars = charState.characters.filter(c => c.projectId === projectId);
    const projectItems = itemState.items.filter(i => i.projectId === projectId);

    const { mergedCharacters, mergedItems, mergeCount } = mergeSimilarCharacters(projectChars, projectItems);

    if (mergeCount > 0) {
      // 更新全局 store
      const otherChars = charState.characters.filter(c => c.projectId !== projectId);
      const otherItems = itemState.items.filter(i => i.projectId !== projectId);
      charState.setCharacters([...otherChars, ...mergedCharacters]);
      itemState.setItems([...otherItems, ...mergedItems]);
      console.debug(`[ItemManager] 自动合并了 ${mergeCount} 对相似角色`);
    }
  }, [projectId]);

  const projectItems = useMemo(
    () => items.filter((i) => i.projectId === projectId),
    [items, projectId]
  );
  const projectChars = useMemo(
    () => characters.filter((c) => c.projectId === projectId),
    [characters, projectId]
  );

  // 搜索过滤角色
  const filteredChars = useMemo(() => {
    if (!charSearch.trim()) return projectChars;
    const s = charSearch.toLowerCase();
    return projectChars.filter((c) =>
      c.name.toLowerCase().includes(s) ||
      c.aliases?.some((a) => a.toLowerCase().includes(s))
    );
  }, [projectChars, charSearch]);

  // 选中角色
  const selectedChar = selectedCharId ? getCharacterById(selectedCharId) : null;

  // 显示的物品列表：选中人物则过滤，否则显示全部
  const displayItems = useMemo(() => {
    if (!selectedCharId) return projectItems;
    return projectItems.filter((item) => {
      const holders = item.currentHolders && item.currentHolders.length > 0
        ? item.currentHolders
        : deriveCurrentHolders(item.holders);
      return holders.includes(selectedCharId);
    });
  }, [projectItems, selectedCharId]);

  // 选中物品
  const selectedItem = selectedItemId
    ? projectItems.find((i) => i.id === selectedItemId)
    : null;

  // 物品流转历史
  const itemTransferHistory = useMemo((): ItemHolder[] => {
    if (!selectedItem) return [];
    const filtered = selectedCharId
      ? selectedItem.holders.filter((h) => h.characterId === selectedCharId)
      : selectedItem.holders;
    return [...filtered].sort((a, b) => a.chapter - b.chapter);
  }, [selectedItem, selectedCharId]);

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

  return (
    <div className="h-full flex flex-col">
      {/* 顶部标题 + 模式切换（物品 / 积分账本） */}
      <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground tracking-tight flex items-center gap-2">
          {mode === 'items' ? (
            <>
              <Package size={14} className="text-muted-foreground" />
              物品管理
            </>
          ) : (
            <>
              <Coins size={14} style={{ color: 'hsl(var(--ochre))' }} />
              积分账本
              <span className="text-[10px] font-normal text-muted-foreground">系统文</span>
            </>
          )}
        </h2>
        <div className="flex bg-foreground/10 rounded-[14px] p-0.5">
          <button
            onClick={() => setMode('items')}
            className={`px-2.5 py-1 text-xs rounded-xl transition-colors flex items-center gap-1 ${
              mode === 'items' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Package size={11} />
            物品
          </button>
          <button
            onClick={() => setMode('credits')}
            className={`px-2.5 py-1 text-xs rounded-xl transition-colors flex items-center gap-1 ${
              mode === 'credits' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Coins size={11} />
            积分账本
          </button>
        </div>
      </div>

      {mode === 'credits' ? (
        <CreditLedger />
      ) : (
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧：人物搜索 + 列表 */}
        <div className="w-64 border-r border-border/50 flex flex-col">
          <div className="px-3 pt-3 pb-2">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={charSearch}
                onChange={(e) => {
                  setCharSearch(e.target.value);
                  setSelectedCharId(null);
                  setSelectedItemId(null);
                }}
                placeholder="搜索人物..."
                className="w-full pl-8 pr-3 py-1.5 text-sm bg-background border border-border rounded-[14px] focus:outline-none focus:border-ring/50 placeholder:text-muted-foreground transition-colors"
              />
            </div>
          </div>

          <div className="px-3 pt-2 pb-1">
            <p className="text-[10px] text-muted-foreground">共 {projectChars.length} 个人物</p>
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {filteredChars.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <User size={20} className="mx-auto mb-2 text-muted-foreground/60" />
                <p className="text-xs text-muted-foreground">未找到相关人物</p>
              </div>
            ) : (
              filteredChars.map((c) => {
                const holderCount = projectItems.filter((item) => {
                  const holders = item.currentHolders?.length
                    ? item.currentHolders
                    : deriveCurrentHolders(item.holders);
                  return holders.includes(c.id);
                }).length;

                return (
                  <button
                    key={c.id}
                    onClick={() => {
                      setSelectedCharId(c.id);
                      setSelectedItemId(null);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-2xl mb-0.5 flex items-center justify-between transition-colors ${
                      selectedCharId === c.id ? 'bg-foreground/5' : 'hover:bg-foreground/[0.03]'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0"
                        style={{ backgroundColor: c.color || 'hsl(var(--muted-foreground))' }}
                      >
                        {c.name[0]}
                      </div>
                      <span className="text-sm text-foreground truncate">{c.name}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground shrink-0 ml-2">
                      {holderCount} 件
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* 中间：物品列表 */}
        <div className="w-72 border-r border-border/50 flex flex-col">
          <div className="px-4 pt-3 pb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">
              {selectedChar ? (
                <span className="flex items-center gap-1.5">
                  <div
                    className="w-5 h-5 rounded-full inline-flex items-center justify-center text-white text-[10px] font-bold"
                    style={{ backgroundColor: selectedChar.color || 'hsl(var(--muted-foreground))' }}
                  >
                    {selectedChar.name[0]}
                  </div>
                  {selectedChar.name} 的物品
                </span>
              ) : (
                '全部物品'
              )}
            </h3>
            <span className="text-xs text-muted-foreground">({displayItems.length})</span>
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {displayItems.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <PackageOpen size={24} className="mx-auto mb-2 text-muted-foreground/60" />
                <p className="text-sm text-muted-foreground">
                  {selectedChar ? '该人物暂无持有物品' : '暂无物品'}
                </p>
              </div>
            ) : (
              displayItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setSelectedItemId(item.id)}
                  className={`w-full text-left px-3 py-2 rounded-2xl mb-0.5 transition-colors ${
                    selectedItemId === item.id ? 'bg-foreground/5' : 'hover:bg-foreground/[0.03]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: item.color || getItemTypeColor(item.type) }}
                    />
                    <span className="text-sm text-foreground truncate flex-1">{item.name}</span>
                    <ArrowRight size={12} className="text-muted-foreground/60 shrink-0" />
                  </div>
                  <div className="flex items-center gap-1.5 mt-1 ml-4">
                    <span className="text-[10px] text-muted-foreground">
                      {ITEM_TYPE_LABELS[item.type || 'other'] || item.type}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* 右侧：物品详情 + 流转历史 */}
        <div className="flex-1 overflow-y-auto">
          {selectedItem ? (
            <div className="p-4 space-y-4">
              {/* 物品头部 */}
              <div className="flex items-start gap-3">
                <div
                  className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold shadow-md"
                  style={{ backgroundColor: selectedItem.color || getItemTypeColor(selectedItem.type) }}
                >
                  {selectedItem.name[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-foreground">{selectedItem.name}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                    <span>{ITEM_TYPE_LABELS[selectedItem.type || 'other'] || selectedItem.type}</span>
                    {selectedItem.creditPrice != null && (
                      <span className="inline-flex items-center gap-0.5 font-medium" style={{ color: 'hsl(var(--ochre))' }}>
                        <Coins size={10} />
                        {selectedItem.creditPrice} 积分
                      </span>
                    )}
                  </p>
                </div>
              </div>

              {/* 当前持有者 */}
              {(() => {
                const holders = selectedItem.currentHolders?.length
                  ? selectedItem.currentHolders
                  : deriveCurrentHolders(selectedItem.holders);
                if (holders.length === 0) return null;
                const holderChars = holders
                  .map((id) => getCharacterById(id))
                  .filter(Boolean);
                if (holderChars.length === 0) return null;
                return (
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground mb-1.5">当前持有者</div>
                    <div className="flex gap-1.5 flex-wrap">
                      {holderChars.map((c) => (
                        <span
                          key={c!.id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-foreground/[0.03] rounded-xl"
                        >
                          <div
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: c!.color || 'hsl(var(--muted-foreground))' }}
                          />
                          {c!.name}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* 物品描述 */}
              {selectedItem.description && (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1.5">描述</div>
                  <div className="text-sm text-foreground bg-foreground/[0.03] rounded-2xl p-3">
                    {selectedItem.description}
                  </div>
                </div>
              )}

              {/* 流转历史 */}
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Clock size={12} />
                  流转历史
                </div>
                {itemTransferHistory.length === 0 ? (
                  <div className="text-xs text-muted-foreground bg-foreground/[0.03] rounded-2xl p-3 text-center">
                    暂无流转记录
                  </div>
                ) : (
                  <div className="space-y-2">
                    {itemTransferHistory.map((h, idx) => {
                      const isGained = h.action === 'gained' || h.action === 'transferred';
                      const char = getCharacterById(h.characterId);
                      return (
                        <div
                          key={idx}
                          className="flex items-start gap-2 bg-foreground/[0.03] rounded-2xl p-2.5"
                        >
                          <div
                            className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                              isGained ? 'bg-green-100' : 'bg-red-100'
                            }`}
                          >
                            {isGained ? (
                              <Gift size={12} className="text-green-600" />
                            ) : (
                              <ArrowLeftRight size={12} className="text-red-500" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-foreground">
                              {char?.name || '未知角色'} {isGained ? '获得' : '失去'}
                            </div>
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              第 {h.chapter} 章
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 标签 */}
              {Array.isArray(selectedItem.tags) && selectedItem.tags.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1.5">标签</div>
                  <div className="flex gap-1 flex-wrap">
                    {selectedItem.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-xs bg-foreground/5 text-muted-foreground px-2 py-0.5 rounded-xl"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <Package size={36} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">选择物品查看详情</p>
              </div>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
