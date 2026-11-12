// ============================================================
// CreditLedger — 系统积分账本（系统文：积分使用结余追踪）
// 以角色为中心的积分流水账：选人物 → 记一笔获得/消耗 → 逐笔结余、负结余告警
// 结余不入库，全部由 shared 的推导函数从流水实时计算（单一代码路径）
// ============================================================

import { useMemo, useState } from 'react';
import { nanoid } from 'nanoid';
import {
  Coins, Search, User, Plus, TrendingUp, TrendingDown, AlertTriangle,
  Trash2, ShoppingCart, Zap, ArrowRight, Gift,
} from 'lucide-react';
import { useCreditStore, useCharacterStore, useItemStore } from '@novel-plugins/data-core/stores';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import {
  deriveCreditBalance,
  replayCreditLedger,
  type CreditTransaction,
  type CreditTransactionType,
} from '@novel/shared';
import { computeCreditItemAcquisition } from './creditItemSync';

interface FormState {
  /** gain=获得积分 / spend=消耗积分 / gift=系统赠予（零积分） */
  type: CreditTransactionType;
  chapter: string;
  amount: string;
  reason: string;
  relatedItemId: string;
}

const EMPTY_FORM: FormState = { type: 'gain', chapter: '1', amount: '', reason: '', relatedItemId: '' };

export function CreditLedger() {
  const transactions = useCreditStore((s) => s.creditTransactions);
  const addCreditTransaction = useCreditStore((s) => s.addCreditTransaction);
  const deleteCreditTransaction = useCreditStore((s) => s.deleteCreditTransaction);
  const characters = useCharacterStore((s) => s.characters);
  const items = useItemStore((s) => s.items);
  const projectId = useCurrentProjectId();

  const [charSearch, setCharSearch] = useState('');
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
  const [selectedTxId, setSelectedTxId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [ledgerFilter, setLedgerFilter] = useState<'all' | 'points' | 'gifts'>('all');

  const projectTransactions = useMemo(
    () => transactions.filter((t) => t.projectId === projectId),
    [transactions, projectId]
  );
  const projectChars = useMemo(
    () => characters.filter((c) => c.projectId === projectId),
    [characters, projectId]
  );
  const projectItems = useMemo(
    () => items.filter((i) => i.projectId === projectId),
    [items, projectId]
  );

  // 各角色当前结余 / 累计收支 / 赠予次数（左栏徽标与汇总）
  const balances = useMemo(() => {
    const map = new Map<
      string,
      { balance: number; gained: number; spent: number; gifts: number }
    >();
    for (const t of projectTransactions) {
      const entry = map.get(t.characterId) ?? { balance: 0, gained: 0, spent: 0, gifts: 0 };
      if (t.type === 'gain') {
        entry.balance += t.amount;
        entry.gained += t.amount;
      } else if (t.type === 'spend') {
        entry.balance -= t.amount;
        entry.spent += t.amount;
      } else {
        // gift：只记录赠予，不影响积分结余
        entry.gifts += 1;
      }
      map.set(t.characterId, entry);
    }
    return map;
  }, [projectTransactions]);

  const filteredChars = useMemo(() => {
    if (!charSearch.trim()) return projectChars;
    const s = charSearch.toLowerCase();
    return projectChars.filter((c) =>
      c.name.toLowerCase().includes(s) ||
      c.aliases?.some((a) => a.toLowerCase().includes(s))
    );
  }, [projectChars, charSearch]);

  // 选中人物的逐笔结余流水（chapter 升序）
  const ledger = useMemo(
    () => (selectedCharId ? replayCreditLedger(projectTransactions, selectedCharId) : []),
    [projectTransactions, selectedCharId]
  );
  const visibleLedger = useMemo(() => {
    if (ledgerFilter === 'points') return ledger.filter((t) => t.type !== 'gift');
    if (ledgerFilter === 'gifts') return ledger.filter((t) => t.type === 'gift');
    return ledger;
  }, [ledger, ledgerFilter]);
  const pointCount = useMemo(() => ledger.filter((t) => t.type !== 'gift').length, [ledger]);
  const giftCount = useMemo(() => ledger.filter((t) => t.type === 'gift').length, [ledger]);

  const selectedTx = selectedTxId ? projectTransactions.find((t) => t.id === selectedTxId) : null;
  const selectedTxItem = selectedTx?.relatedItemId
    ? projectItems.find((i) => i.id === selectedTx.relatedItemId)
    : null;
  const selectedChar = selectedCharId ? projectChars.find((c) => c.id === selectedCharId) : null;
  const charBalance = selectedCharId ? deriveCreditBalance(projectTransactions, selectedCharId) : 0;
  const charSummary = selectedCharId ? balances.get(selectedCharId) : null;

  // 表单中关联物品的定价参考（spend 时可一键按定价填入）
  const formItem = form.relatedItemId ? projectItems.find((i) => i.id === form.relatedItemId) : null;

  /** 记账后把「关联物品」同步进该角色的持有关系（兑换 / 奖励 / 赠予都算获得） */
  const syncAcquiredItem = (itemId: string | undefined, characterId: string, chapter: number) => {
    if (!itemId) return;
    const itemState = useItemStore.getState();
    const item = itemState.items.find((i) => i.id === itemId && i.projectId === projectId);
    if (!item) return;
    const updates = computeCreditItemAcquisition(item, characterId, chapter);
    if (updates) itemState.updateItem(item.id, updates);
  };

  const handleSubmit = () => {
    const isGift = form.type === 'gift';
    // 赠予不涉及积分；gain/spend 必须是正数
    const amount = isGift ? 0 : Number(form.amount);
    const chapter = Number(form.chapter);
    const reason = form.reason.trim();
    if (!projectId) { setFormError('请先选择项目'); return; }
    if (!selectedCharId) { setFormError('请先选择人物'); return; }
    if (!Number.isInteger(chapter) || chapter < 1) { setFormError('章节必须是 ≥1 的整数'); return; }
    if (!isGift && (!Number.isFinite(amount) || amount <= 0)) {
      setFormError('积分数额必须为正数');
      return;
    }
    if (isGift && !reason && !form.relatedItemId) {
      setFormError('赠予需要填写奖励内容或关联物品');
      return;
    }

    if (selectedTxId) {
      useCreditStore.getState().updateCreditTransaction(selectedTxId, {
        characterId: selectedCharId,
        chapter,
        type: form.type,
        amount,
        reason: reason || undefined,
        relatedItemId: form.relatedItemId || undefined,
        updatedAt: Date.now(),
      });
    } else {
      const tx: CreditTransaction = {
        id: nanoid(),
        projectId,
        characterId: selectedCharId,
        chapter,
        type: form.type,
        amount,
        reason: reason || undefined,
        relatedItemId: form.relatedItemId || undefined,
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      addCreditTransaction(tx);
    }

    // 账本与物品库联动：关联物品即视为角色在本章获得
    syncAcquiredItem(form.relatedItemId || undefined, selectedCharId, chapter);

    setShowForm(false);
    setSelectedTxId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  /** 打开「记赠予」表单（位于「记一笔」旁边） */
  const startGift = () => {
    setSelectedTxId(null);
    setShowForm(true);
    setForm({ ...EMPTY_FORM, type: 'gift', chapter: '1' });
    setFormError(null);
  };

  const startEdit = (tx: CreditTransaction) => {
    setSelectedTxId(tx.id);
    setShowForm(true);
    setForm({
      type: tx.type,
      chapter: String(tx.chapter),
      amount: tx.type === 'gift' ? '' : String(tx.amount),
      reason: tx.reason ?? '',
      relatedItemId: tx.relatedItemId ?? '',
    });
    setFormError(null);
  };

  if (!projectId) {
    return (
      <div className="h-full flex items-center justify-center bg-card">
        <p className="text-sm text-muted-foreground font-medium">请先选择一个项目</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-card">
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧：人物搜索 + 列表（徽标 = 当前结余） */}
        <div className="w-64 border-r border-border flex flex-col bg-muted/40">
          <div className="px-3 pt-3 pb-2">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={charSearch}
                onChange={(e) => { setCharSearch(e.target.value); setSelectedCharId(null); setSelectedTxId(null); }}
                placeholder="搜索人物..."
                className="w-full pl-8 pr-3 py-1.5 text-sm bg-card border border-border rounded-[14px] focus:outline-none focus:border-ring placeholder:text-muted-foreground transition-colors"
              />
            </div>
          </div>
          <div className="px-3 pt-2 pb-1">
            <p className="text-[10px] text-muted-foreground">绑定系统的人物</p>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {filteredChars.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <User size={20} className="mx-auto mb-2 text-muted-foreground/60" />
                <p className="text-xs text-muted-foreground">未找到相关人物</p>
              </div>
            ) : (
              filteredChars.map((c) => {
                const info = balances.get(c.id);
                const hasLedger = info !== undefined;
                return (
                  <button
                    key={c.id}
                    onClick={() => {
                      setSelectedCharId(c.id);
                      setSelectedTxId(null);
                      setShowForm(false);
                      setLedgerFilter('all');
                    }}
                    className={`w-full text-left px-3 py-2 rounded-2xl mb-0.5 flex items-center justify-between transition-colors ${
                      selectedCharId === c.id ? 'bg-muted' : 'hover:bg-muted'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0"
                        style={{ backgroundColor: c.color || 'hsl(0 0% 50%)' }}
                      >
                        {c.name[0]}
                      </div>
                      <span className="text-sm text-foreground truncate">{c.name}</span>
                    </div>
                    {hasLedger && (
                      <span
                        className={`text-[10px] font-semibold shrink-0 ml-2 flex items-center gap-0.5 ${
                          info!.balance < 0 ? 'text-red-500' : 'text-amber-600'
                        }`}
                      >
                        <Coins size={10} />
                        {info!.balance}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* 中间：结余汇总 + 流水列表 */}
        <div className="w-96 border-r border-border flex flex-col">
          {selectedChar ? (
            <>
              <div className="px-4 pt-3 pb-3 border-b border-border/60">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                    <Coins size={14} className="text-amber-500" />
                    {selectedChar.name} 的系统账本
                    <span className="text-[10px] font-normal text-muted-foreground">积分 / 赠予</span>
                  </h3>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={startGift}
                      className="flex items-center gap-1 px-2 py-1 text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded-xl hover:bg-amber-100 transition-colors"
                      title="记录系统赠予的物品或奖励（不扣积分）"
                    >
                      <Gift size={12} />
                      记赠予
                    </button>
                    <button
                      onClick={() => { setSelectedTxId(null); setShowForm(true); setForm({ ...EMPTY_FORM, chapter: '1' }); }}
                      className="flex items-center gap-1 px-2 py-1 text-xs bg-foreground text-background rounded-xl hover:bg-foreground/85 transition-colors"
                    >
                      <Plus size={12} />
                      记一笔
                    </button>
                  </div>
                </div>
                <div className="mt-2.5 flex items-end gap-3">
                  <div>
                    <p className="text-[10px] text-muted-foreground">当前结余</p>
                    <p className={`text-2xl font-bold tabular-nums ${charBalance < 0 ? 'text-red-500' : 'text-foreground'}`}>
                      {charBalance}
                    </p>
                  </div>
                  <div className="text-[10px] text-muted-foreground pb-1 leading-relaxed">
                    <p>累计获得 <span className="text-green-600 font-medium">+{charSummary?.gained ?? 0}</span></p>
                    <p>累计消耗 <span className="text-red-500 font-medium">-{charSummary?.spent ?? 0}</span></p>
                    {(charSummary?.gifts ?? 0) > 0 && (
                      <p>系统赠予 <span className="text-amber-600 font-medium">{charSummary?.gifts} 次</span></p>
                    )}
                  </div>
                </div>
              </div>

              {/* 流水筛选：积分收支 / 系统赠予分开看 */}
              <div className="px-3 pt-2 flex items-center gap-1">
                {([
                  ['all', '全部', ledger.length],
                  ['points', '积分', pointCount],
                  ['gifts', '赠予', giftCount],
                ] as const).map(([key, label, count]) => (
                  <button
                    key={key}
                    onClick={() => setLedgerFilter(key)}
                    className={`px-2 py-0.5 text-[10px] rounded-full transition-colors ${
                      ledgerFilter === key
                        ? 'bg-foreground text-background'
                        : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10'
                    }`}
                  >
                    {label} {count}
                  </button>
                ))}
              </div>

              <div className="flex-1 overflow-y-auto px-2 py-2">
                {visibleLedger.length === 0 ? (
                  <div className="px-4 py-8 text-center">
                    <Coins size={24} className="mx-auto mb-2 text-muted-foreground/60" />
                    <p className="text-sm text-muted-foreground">
                      {ledgerFilter === 'gifts'
                        ? '暂无赠予记录'
                        : ledgerFilter === 'points'
                          ? '暂无积分流水'
                          : '暂无系统流水'}
                    </p>
                    <p className="text-[10px] text-muted-foreground/60 mt-1">
                      「记一笔」记录积分收支，「记赠予」记录系统给的东西
                    </p>
                  </div>
                ) : (
                  visibleLedger.map((t) => {
                    const isGain = t.type === 'gain';
                    const isGift = t.type === 'gift';
                    const relatedItem = t.relatedItemId ? projectItems.find((i) => i.id === t.relatedItemId) : null;
                    return (
                      <button
                        key={t.id}
                        onClick={() => { if (!showForm) { setSelectedTxId(t.id); } }}
                        className={`w-full text-left px-3 py-2 rounded-2xl mb-0.5 transition-colors ${
                          selectedTxId === t.id ? 'bg-muted' : 'hover:bg-muted'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <div
                            className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                              isGift ? 'bg-amber-100' : isGain ? 'bg-green-100' : 'bg-red-100'
                            }`}
                          >
                            {isGift ? (
                              <Gift size={12} className="text-amber-600" />
                            ) : isGain ? (
                              <TrendingUp size={12} className="text-green-600" />
                            ) : (
                              <TrendingDown size={12} className="text-red-500" />
                            )}
                          </div>
                          {isGift ? (
                            <span className="text-xs font-semibold text-amber-600 shrink-0">赠予</span>
                          ) : (
                            <span className={`text-sm font-semibold tabular-nums ${isGain ? 'text-green-600' : 'text-red-500'}`}>
                              {isGain ? '+' : '-'}{t.amount}
                            </span>
                          )}
                          <span className="text-sm text-foreground/85 truncate flex-1">
                            {t.reason || (isGift ? (relatedItem?.name ?? '系统赠予') : isGain ? '获得积分' : '消耗积分')}
                          </span>
                          <span className="text-[10px] text-muted-foreground shrink-0">余 {t.balanceAfter}</span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-1 ml-8">
                          <span className="text-[10px] text-muted-foreground">第 {t.chapter} 章</span>
                          {relatedItem && (
                            <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                              · <ShoppingCart size={9} /> {relatedItem.name}
                            </span>
                          )}
                          {!isGift && t.balanceAfter < 0 && (
                            <span className="text-[10px] text-red-500 flex items-center gap-0.5 font-medium">
                              <AlertTriangle size={9} /> 结余为负
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <Coins size={36} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">选择人物查看系统账本</p>
              </div>
            </div>
          )}
        </div>

        {/* 右侧：流水详情 / 记账表单 */}
        <div className="flex-1 overflow-y-auto">
          {showForm ? (
            <div className="p-4 space-y-4">
              <div className="flex items-center gap-2">
                <Zap size={14} className="text-amber-500" />
                <h3 className="text-sm font-semibold text-foreground">
                  {selectedTxId
                    ? form.type === 'gift' ? '编辑赠予' : '编辑流水'
                    : form.type === 'gift' ? '记赠予' : '记一笔'}
                </h3>
              </div>

              {/* 类型 */}
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1.5">类型</div>
                <div className="flex gap-2">
                  {(['gain', 'spend', 'gift'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setForm((f) => ({ ...f, type: t }))}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-2xl border transition-colors ${
                        form.type === t
                          ? t === 'gain'
                            ? 'bg-green-50 border-green-300 text-green-700'
                            : t === 'spend'
                              ? 'bg-red-50 border-red-300 text-red-600'
                              : 'bg-amber-50 border-amber-300 text-amber-700'
                          : 'bg-card border-border text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {t === 'gain' ? (
                        <TrendingUp size={13} />
                      ) : t === 'spend' ? (
                        <TrendingDown size={13} />
                      ) : (
                        <Gift size={13} />
                      )}
                      {t === 'gain' ? '获得' : t === 'spend' ? '消耗' : '赠予'}
                    </button>
                  ))}
                </div>
              </div>

              {/* 章节 + 数额（赠予不涉及积分） */}
              <div className="flex gap-3">
                <div className={form.type === 'gift' ? 'flex-1' : 'w-28'}>
                  <div className="text-xs font-semibold text-muted-foreground mb-1.5">章节</div>
                  <input
                    type="number"
                    min={1}
                    value={form.chapter}
                    onChange={(e) => setForm((f) => ({ ...f, chapter: e.target.value }))}
                    className="w-full px-2.5 py-1.5 text-sm bg-card border border-border rounded-[14px] focus:outline-none focus:border-ring"
                  />
                </div>
                {form.type !== 'gift' && (
                  <div className="flex-1">
                    <div className="text-xs font-semibold text-muted-foreground mb-1.5">积分数额</div>
                    <input
                      type="number"
                      min={0}
                      value={form.amount}
                      onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                      placeholder="如 500"
                      className="w-full px-2.5 py-1.5 text-sm bg-card border border-border rounded-[14px] focus:outline-none focus:border-ring placeholder:text-muted-foreground"
                    />
                  </div>
                )}
              </div>
              {form.type === 'gift' && (
                <p className="text-[10px] text-amber-600 mt-1">
                  赠予只记录系统给出的东西，不扣积分
                </p>
              )}

              {/* 事由 / 赠予内容 */}
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1.5">
                  {form.type === 'gift' ? '奖励内容' : '事由'}
                </div>
                <input
                  value={form.reason}
                  onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                  placeholder={
                    form.type === 'gain'
                      ? '如：完成新手任务 / 击杀魔兽'
                      : form.type === 'spend'
                        ? '如：兑换功法 / 购买丹药'
                        : '如：新手礼包 / 初级功法 / 系统空间'
                  }
                  className="w-full px-2.5 py-1.5 text-sm bg-card border border-border rounded-[14px] focus:outline-none focus:border-ring placeholder:text-muted-foreground"
                />
              </div>

              {/* 关联物品 */}
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1.5">
                  {form.type === 'gift'
                    ? '赠予物品（可选）'
                    : form.type === 'spend'
                      ? '兑换物品（可选）'
                      : '关联物品（可选）'}
                </div>
                <div className="relative">
                  <select
                    value={form.relatedItemId}
                    onChange={(e) => {
                      const id = e.target.value;
                      const item = id ? projectItems.find((i) => i.id === id) : null;
                      setForm((f) => ({
                        ...f,
                        relatedItemId: id,
                        // 消耗且未填数额时，按物品积分定价自动填入
                        amount: f.type === 'spend' && !f.amount && item?.creditPrice ? String(item.creditPrice) : f.amount,
                      }));
                    }}
                    className="w-full px-2.5 py-1.5 text-sm bg-card border border-border rounded-[14px] focus:outline-none focus:border-ring"
                  >
                    <option value="">无</option>
                    {projectItems.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}{i.creditPrice ? `（定价 ${i.creditPrice}）` : ''}
                      </option>
                    ))}
                  </select>
                  {form.type === 'spend' && formItem?.creditPrice && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      该物品积分定价 {formItem.creditPrice}
                    </p>
                  )}
                  {form.type === 'gift' && form.relatedItemId && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      记账后会同步写入该角色的物品持有
                    </p>
                  )}
                </div>
              </div>

              {formError && (
                <p className="text-xs text-red-500 flex items-center gap-1">
                  <AlertTriangle size={11} /> {formError}
                </p>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleSubmit}
                  className="px-3 py-1.5 text-sm bg-foreground text-background rounded-xl hover:bg-foreground/85 transition-colors"
                >
                  {selectedTxId
                    ? '保存'
                    : form.type === 'gift' ? '记入赠予' : '记入账本'}
                </button>
                <button
                  onClick={() => { setShowForm(false); setSelectedTxId(null); setForm(EMPTY_FORM); setFormError(null); }}
                  className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground/85 transition-colors"
                >
                  取消
                </button>
              </div>
            </div>
          ) : selectedTx ? (
            <div className="p-4 space-y-4">
              <div className="flex items-start gap-3">
                <div
                  className={`w-12 h-12 rounded-full flex items-center justify-center text-white font-bold shadow-md ${
                    selectedTx.type === 'gift'
                      ? 'bg-amber-500'
                      : selectedTx.type === 'gain' ? 'bg-green-500' : 'bg-red-400'
                  }`}
                >
                  {selectedTx.type === 'gift' ? (
                    <Gift size={20} />
                  ) : selectedTx.type === 'gain' ? (
                    <TrendingUp size={20} />
                  ) : (
                    <TrendingDown size={20} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-foreground">
                    {selectedTx.type === 'gift'
                      ? (selectedTx.reason || selectedTxItem?.name || '系统赠予')
                      : `${selectedTx.type === 'gain' ? '获得' : '消耗'} ${selectedTx.amount} 积分`}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    第 {selectedTx.chapter} 章
                    {selectedTx.type === 'gift' && (
                      <span className="ml-1.5 text-amber-600 font-medium">系统赠予</span>
                    )}
                  </p>
                </div>
              </div>

              {selectedTx.reason && (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1.5">
                    {selectedTx.type === 'gift' ? '赠予内容' : '事由'}
                  </div>
                  <div className="text-sm text-foreground/85 bg-muted rounded-2xl p-3">{selectedTx.reason}</div>
                </div>
              )}

              {selectedTxItem && (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1.5">
                    {selectedTx.type === 'gift' ? '赠予物品' : '关联物品'}
                  </div>
                  <div className="flex items-center gap-2 bg-muted rounded-2xl p-3">
                    {selectedTx.type === 'gift' ? (
                      <Gift size={14} className="text-amber-600" />
                    ) : (
                      <ShoppingCart size={14} className="text-muted-foreground" />
                    )}
                    <span className="text-sm text-foreground/85">{selectedTxItem.name}</span>
                    {selectedTxItem.creditPrice != null && (
                      <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                        <Coins size={9} /> {selectedTxItem.creditPrice}
                      </span>
                    )}
                    <ArrowRight size={12} className="text-muted-foreground/60 ml-auto" />
                  </div>
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => startEdit(selectedTx)}
                  className="px-3 py-1.5 text-sm text-muted-foreground bg-muted rounded-xl hover:bg-secondary transition-colors"
                >
                  编辑
                </button>
                <button
                  onClick={() => {
                    deleteCreditTransaction(selectedTx.id);
                    setSelectedTxId(null);
                  }}
                  className="px-3 py-1.5 text-sm text-red-500 bg-red-50 rounded-xl hover:bg-red-100 transition-colors flex items-center gap-1"
                >
                  <Trash2 size={12} />
                  {selectedTx.type === 'gift' ? '删除记录' : '删除流水'}
                </button>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <Coins size={36} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">选择流水查看详情</p>
                <p className="text-[10px] text-muted-foreground/60 mt-1.5 max-w-52">
                  追踪系统文角色的积分收支、变动后结余与系统赠予；负结余即提示账目不一致
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
