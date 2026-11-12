// ============================================================
// 系统积分流水路由（系统文：积分使用结余追踪）
// 结余不入库、实时派生：前端用 shared 的 deriveCreditBalance/replayCreditLedger 计算
// ============================================================

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import {
  createCreditTransaction,
  getCreditTransaction,
  listCreditTransactions,
  updateCreditTransaction,
  deleteCreditTransaction,
} from '../services/credit-service.js';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectScope, type ProjectScopedVariables } from '../lib/project-scope.js';

const creditTransactionFields = {
  id: z.string().optional(),
  projectId: z.string().min(1),
  characterId: z.string().min(1, '积分持有者不能为空'),
  chapter: z.number().int().min(1),
  // gain=获得积分 / spend=消耗积分 / gift=系统赠予（不涉及积分）
  type: z.enum(['gain', 'spend', 'gift']),
  amount: z.number().nonnegative('积分数额不能为负'),
  reason: z.string().optional(),
  relatedItemId: z.string().optional(),
  tags: z.array(z.string()).optional(),
};

const createCreditTransactionSchema = z.object(creditTransactionFields).superRefine((value, ctx) => {
  if (value.type === 'gift') {
    if (value.amount !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: '赠予不消耗积分，amount 必须为 0',
      });
    }
    if (!value.reason?.trim() && !value.relatedItemId) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: '赠予需要填写奖励内容或关联物品',
      });
    }
  } else if (value.amount <= 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['amount'],
      message: '积分数额必须为正数',
    });
  }
});

// 更新允许只传部分字段；gift 的 amount=0 由 service 统一归一化，
// 其余合法性在合并后的创建路径 / 客户端表单里保证。
const updateCreditTransactionSchema = z.object(creditTransactionFields).partial();

const router = new Hono<{ Variables: ProjectScopedVariables }>();

router.get('/projects/:projectId', requireAuth, async (c) => {
  const denial = await requireProjectScope(c);
  if (denial) return denial;
  const projectId = c.get('projectId')!;
  const transactions = await listCreditTransactions(projectId);
  return c.json({ data: transactions });
});

router.get('/:id', requireAuth, async (c) => {
  const denial = await requireProjectScope(c);
  if (denial) return denial;
  const projectId = c.get('projectId')!;
  const id = c.req.param('id')!;
  const tx = await getCreditTransaction(id, projectId);
  if (!tx) return c.json({ error: { code: 'NOT_FOUND', message: '积分流水不存在' } }, 404);
  return c.json({ data: tx });
});

router.post('/', requireAuth, zValidator('json', createCreditTransactionSchema), async (c) => {
  const denial = await requireProjectScope(c);
  if (denial) return denial;
  const projectId = c.get('projectId')!;
  const data = c.req.valid('json') as z.infer<typeof createCreditTransactionSchema>;
  // 强制以 URL/header 中的 projectId 为准（防止 body 注入其他项目的 projectId）
  const tx = await createCreditTransaction(
    { ...data, projectId } as Parameters<typeof createCreditTransaction>[0],
    projectId,
  );
  return c.json({ data: tx }, 201);
});

router.put('/:id', requireAuth, zValidator('json', updateCreditTransactionSchema), async (c) => {
  const denial = await requireProjectScope(c);
  if (denial) return denial;
  const projectId = c.get('projectId')!;
  const id = c.req.param('id')!;
  const existing = await getCreditTransaction(id, projectId);
  if (!existing) {
    // upsert：不存在则创建（RFC 7231 PUT 幂等语义，与 items 路由一致）
    const data = c.req.valid('json');
    const created = await createCreditTransaction(
      { id, ...data, projectId } as Parameters<typeof createCreditTransaction>[0],
      projectId,
    );
    return c.json({ data: created }, 201);
  }
  const data = c.req.valid('json') as z.infer<typeof updateCreditTransactionSchema>;
  // 部分更新时用「合并后」的类型/数额做校验，避免把 gift 改成 gain 却残留 0 积分
  const nextType = data.type ?? existing.type;
  const nextAmount = data.amount ?? existing.amount;
  if (nextType === 'gift') {
    if (nextAmount !== 0) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: '赠予不消耗积分，amount 必须为 0' } },
        400,
      );
    }
  } else if (nextAmount <= 0) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: '积分数额必须为正数' } },
      400,
    );
  }

  await updateCreditTransaction(id, data, projectId);
  const tx = await getCreditTransaction(id, projectId);
  return c.json({ data: tx });
});

router.delete('/:id', requireAuth, async (c) => {
  const denial = await requireProjectScope(c);
  if (denial) return denial;
  const projectId = c.get('projectId')!;
  const id = c.req.param('id')!;
  await deleteCreditTransaction(id, projectId);
  return c.json({ data: { success: true } });
});

export default router;
