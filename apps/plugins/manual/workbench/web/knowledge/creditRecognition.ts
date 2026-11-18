// ============================================================
// 系统积分识别：确定性规则（纯函数）
//
// 系统文的积分有两个来源：AI 扫描出的 credit_transaction 行，以及用户在
// 「系统积分」面板手动记账。两者必须走**同一套规则**，否则会出现
// 「AI 记的账去重了、手记的没去重」这类漂移。
//
// 这里只放纯逻辑（金额归一、去重键、物品解析、账目自检），写 store 由调用方做。
// 从 useScanProcessors 里抽出来，是因为它已经不只是扫描的一部分：
// 面板、扫描、系统发物补记三条路径都要用。
// ============================================================

import type { CreditTransaction, Item } from '@novel/shared';

export type CreditAction = 'gain' | 'spend' | 'gift';

/** 归一化：去标点、去空格、转小写（用于比较名称/事由） */
export function normalizeCreditText(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^一-龥a-z0-9]/g, '');
}

/**
 * 金额归一。
 *
 * gift（系统赠予物品）不涉及积分，恒为 0；其余必须是正数。
 * 返回 null 表示这条流水本身不合法，调用方应丢弃。
 */
export function normalizeCreditAmount(action: CreditAction, rawAmount: number): number | null {
  if (action === 'gift') return 0;
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) return null;
  return rawAmount;
}

/**
 * 去重键。
 *
 * ★ 刻意**不含 reason 文本**：实测重复扫描同一章时，模型会把
 * 「首次绑定系统，初始积分」改写成「首次绑定系统获初始积分」——
 * 按文本相等去重会漏判，账本里同一笔出现两次。
 *
 * 关联物品参与比较：同一章里两件**不同物品**的赠予必须各记一条。
 * 物品解析不到时（如技能名「基础剑法」没有物品 id）退回按 类型+金额 判重。
 */
export function creditDedupeKey(
  action: CreditAction,
  amount: number,
  resolvedItemName?: string,
): string {
  return `${action}|${amount}|${normalizeCreditText(resolvedItemName ?? '')}`;
}

/** 已有流水的去重键（关联物品用 id 反查名称） */
export function existingCreditDedupeKey(
  tx: Pick<CreditTransaction, 'type' | 'amount' | 'relatedItemId'>,
  items: Array<Pick<Item, 'id' | 'name'>>,
): string {
  const name = tx.relatedItemId
    ? items.find((i) => i.id === tx.relatedItemId)?.name
    : undefined;
  return creditDedupeKey(tx.type as CreditAction, tx.amount ?? 0, name);
}

/**
 * 按名称解析物品（扫描给出的 itemName → 库里的物品）。
 *
 * 先精确、再互相包含（「妖狼牙」↔「妖狼牙三枚」这类原文写法差异）。
 * 单字名不参与包含匹配，避免「刀」命中「断水刀」。
 */
export function resolveCreditItem(
  itemName: string | undefined,
  items: Array<Pick<Item, 'id' | 'name'>>,
): Pick<Item, 'id' | 'name'> | undefined {
  const name = (itemName ?? '').trim();
  if (!name) return undefined;

  const exact = items.find((i) => i.name === name);
  if (exact) return exact;
  if (name.length < 2) return undefined;

  return items.find(
    (i) => i.name.length >= 2 && (i.name.includes(name) || name.includes(i.name)),
  );
}

/** 账目自检结果：负结余说明流水有错（漏记获得 / 多记消耗） */
export interface CreditAudit {
  balance: number;
  gained: number;
  spent: number;
  gifts: number;
  /** 逐笔累计过程中出现过负结余的章节（升序） */
  negativeAtChapters: number[];
}

/**
 * 按章节顺序重算某角色的账目，并找出**第一次出现负结余**的位置。
 *
 * 为什么不直接看最终结余：最终为正也可能中途透支过（先花 500 再得 1000），
 * 那种账目同样是错的，只是被后面的收入盖住了。
 */
export function auditCreditLedger(
  transactions: Array<Pick<CreditTransaction, 'characterId' | 'chapter' | 'type' | 'amount'>>,
  characterId: string,
): CreditAudit {
  const mine = transactions
    .filter((t) => t.characterId === characterId)
    .slice()
    .sort((a, b) => a.chapter - b.chapter);

  let balance = 0;
  let gained = 0;
  let spent = 0;
  let gifts = 0;
  const negativeAtChapters: number[] = [];

  for (const t of mine) {
    if (t.type === 'gain') {
      balance += t.amount;
      gained += t.amount;
    } else if (t.type === 'spend') {
      balance -= t.amount;
      spent += t.amount;
    } else {
      gifts += 1;
    }
    if (balance < 0 && !negativeAtChapters.includes(t.chapter)) {
      negativeAtChapters.push(t.chapter);
    }
  }

  return { balance, gained, spent, gifts, negativeAtChapters };
}