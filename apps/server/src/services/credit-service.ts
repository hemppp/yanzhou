// ============================================================
// 系统积分流水 Service（系统文：积分使用结余追踪）
// ============================================================

import { schema } from '@novel/db';
import type { CreditTransaction } from '@novel/shared';
import { BaseService, normalizeTimestamps, toDbTimestamps, parseJson } from './base-service.js';
import { v4 as uuidv4 } from 'uuid';

const JSON_FIELDS = ['tags'];

function rowToCreditTransaction(r: Record<string, unknown>): CreditTransaction {
  const result = normalizeTimestamps<CreditTransaction>(r);
  (result as unknown as Record<string, unknown>).tags = parseJson(r.tags, []) as string[];
  return result;
}

function creditTransactionToRow(t: CreditTransaction): Record<string, unknown> {
  const row = { ...t } as unknown as Record<string, unknown>;
  row.tags = JSON.stringify(t.tags ?? []);
  toDbTimestamps(row);
  return row;
}

const service = new BaseService<CreditTransaction>(schema.creditTransactions, {
  rowToModel: rowToCreditTransaction,
  modelToRow: creditTransactionToRow,
  jsonFields: JSON_FIELDS,
  loadByColumn: 'projectId',
  entityLabel: 'CreditTransactions',
  scope: 'project',
});

export async function createCreditTransaction(
  data: Omit<CreditTransaction, 'createdAt' | 'updatedAt'>,
  projectId: string,
): Promise<CreditTransaction> {
  const now = Date.now();
  const tx: CreditTransaction = {
    ...data,
    id: data.id ?? uuidv4(),
    characterId: data.characterId ?? '',
    chapter: data.chapter ?? 1,
    type: data.type,
    // 赠予只记录物品/奖励，不参与积分结算
    amount: data.type === 'gift' ? 0 : data.amount,
    tags: data.tags ?? [],
    createdAt: now,
    updatedAt: now,
  };
  await service.save(tx, false, projectId);
  return tx;
}

export async function getCreditTransaction(id: string, projectId: string): Promise<CreditTransaction | null> {
  return service.getById(id, projectId);
}

export async function listCreditTransactions(projectId: string): Promise<CreditTransaction[]> {
  return service.loadAll(projectId, projectId);
}

export async function updateCreditTransaction(
  id: string,
  data: Partial<Omit<CreditTransaction, 'id' | 'createdAt'>>,
  projectId: string,
): Promise<void> {
  // 改成赠予时强制归零，避免残留旧积分数额影响结余
  const normalized = data.type === 'gift' ? { ...data, amount: 0 } : data;
  await service.update(id, { ...normalized, updatedAt: Date.now() }, projectId);
}

export async function deleteCreditTransaction(id: string, projectId: string): Promise<void> {
  await service.delete(id, projectId);
}
