// ============================================================
// 分层记忆 · 记忆闸门（MemoryGate）
//
// 职责（架构 §3 防线③）：
//   · 放行判定：agentId × 键白名单 × reason 合法性，任一不满足 → 拒绝
//   · **放行与拒绝都记账**（memory_audit）—— 复盘时能回答"它当时为什么读了这条"
//
// 三条设计取舍：
//   1. `reason` 必填，且它是**枚举**。写不出"想看看"这种值 —— 从类型上堵死越权动机
//   2. 白名单按角色声明，**缺省空集**：新增角色忘记声明 = 读不到，不是默认全读（fail-closed）
//   3. 审计失败**不能**让业务失败（交付已经成功，记账失败不该反过来废掉章节），
//      但要在日志里喊出来 —— 静默吞掉审计等于没有审计
// ============================================================

import { schema, type DrizzleDb } from '@novel/db';
import type { ServerPluginContext } from '@novel/core';
import { nowId } from '../text.js';
import { matchAny, type L1ReadReason, type MemoryAuditAction, type RoleMemoryPolicy } from './types.js';

/** 允许的 reason 全集（运行期再挡一层：类型挡不住的 JS 调用/外部字符串） */
const REASON_SET: ReadonlySet<string> = new Set<L1ReadReason>([
  'discuss-context', 'continuity-check', 'assemble-before-write', 'gate-review', 'recall-by-need',
]);

/**
 * 角色记忆策略表。
 * ★ 与 `discuss/roles.ts` 的 `memory` 字段保持一致 —— 测试会断言两处同步（单点真相在 roles.ts）。
 */
export type RolePolicyLookup = (agentId: string) => RoleMemoryPolicy | undefined;

export interface GateDecision {
  allow: boolean;
  /** 被允许的键（拒绝时为空） */
  granted: string[];
  /** 被拒的键（allow=false 时非空，便于日志/面板显示"它想读什么被拦了"） */
  denied: string[];
  reason: L1ReadReason;
  agentId: string;
  /** 本次是否**获准**读叙事式（章节正文）。调用方据此决定要不要注入上一章 */
  narrativeGranted: boolean;
}

export interface GateAuditInput {
  projectId: string;
  agentId: string;
  action: MemoryAuditAction;
  keys: string[];
  reason?: string;
  allow: boolean;
  detail?: string;
  /** ★ I6 的可执行版本：本次**注入内容**的指纹（hash + 字数），用于"同输入是否同结果"的复现核对 */
  fingerprint?: string;
}

/**
 * 注入内容指纹（I6「装配可复现」的落地形态）。
 *
 * 全文快照代价太大，但**指纹**足够回答两个问题：
 *   ① 同样的 (项目, 章, 角色, 授权集) 两次装配是否一致（漂移检测）
 *   ② 出问题时"它当时看到的是哪一份"（配合 keys 与字数可定位）
 * 用 djb2 —— 不是密码学哈希，够用且零依赖。
 */
export function fingerprintOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}-${text.length}`;
}

/**
 * 写一条审计。失败只告警不抛 —— 审计是"旁路"，不能反过来影响业务。
 */
export async function writeAudit(ctx: ServerPluginContext, input: GateAuditInput): Promise<void> {
  try {
    const db = ctx.db.project(input.projectId) as DrizzleDb;
    await db.insert(schema.memoryAudit).values({
      id: nowId(),
      projectId: input.projectId,
      agentId: input.agentId,
      action: input.action,
      keys: JSON.stringify(input.keys),
      reason: input.reason ?? null,
      allow: input.allow,
      detail: [input.detail, input.fingerprint ? `fp:${input.fingerprint}` : ''].filter(Boolean).join(' | ') || null,
      at: new Date(),
    });
  } catch (e) {
    console.warn('[memory] 审计写入失败（不影响业务）:', e);
  }
}

export class MemoryGate {
  constructor(
    private readonly ctx: ServerPluginContext,
    private readonly lookupPolicy: RolePolicyLookup,
  ) {}

  /**
   * 放行判定 + 记账。
   * @param keys 想读的 L1 键（事实式）
   * @param mode 两种**语义不同**的判定（别混用）：
   *   · 'strict'（默认）：只要有一个键越界就**整次拒绝**。
   *     用于"查一条具体事实"—— 越界往往说明调用方写错了角色/键，必须显式失败
   *   · 'partial'：能读的**部分放行**，越界的键体现为"结果里没有它"。
   *     用于"装配一整个 digest"—— 一个包给多个字段，角色就该只看到它获准的部分
   */
  async authorize(args: {
    projectId: string;
    agentId: string;
    keys: string[];
    reason: L1ReadReason;
    /** 是否在请求叙事式（章节正文） */
    narrative?: boolean;
    mode?: 'strict' | 'partial';
  }): Promise<GateDecision> {
    const { projectId, agentId, keys, reason, narrative, mode = 'strict' } = args;

    // ① reason 必须是枚举值（类型挡不住 JS 调用）
    if (!REASON_SET.has(reason)) {
      const decision: GateDecision = { allow: false, granted: [], denied: keys, reason, agentId, narrativeGranted: false };
      await writeAudit(this.ctx, {
        projectId, agentId, action: 'deny_l1', keys, reason: String(reason), allow: false,
        detail: '非法 reason（不在枚举内）',
      });
      return decision;
    }

    // ② 取该角色的策略；**没有声明 = 空集**（fail-closed）
    const policy = this.lookupPolicy(agentId);
    if (!policy) {
      await writeAudit(this.ctx, {
        projectId, agentId, action: 'deny_l1', keys, reason, allow: false,
        detail: '角色未声明 memory 策略（fail-closed）',
      });
      return { allow: false, granted: [], denied: keys, reason, agentId, narrativeGranted: false };
    }

    // ③ 叙事式闸门：reviewer 等明确不许读正文细节。
    // ★ 关键：「请求叙事被拒」**不株连事实式** ——
    //   partial 模式下（装配整包）事实部分照常按白名单给，只是不注入上一章；
    //   strict 模式下（点名要读某条）才整次拒绝。实测踩过：株连会让
    //   reviewer 连它**获准**的契约字段一起拿不到。
    const narrativeGranted = !narrative || policy.readNarrative === true;

    // ④ 逐键判定：l1Wide（设定管家）放行全部事实式键
    const granted = policy.l1Wide === true ? [...keys] : keys.filter((k) => matchAny(policy.readL1, k));
    const denied = keys.filter((k) => !granted.includes(k));
    const allow = mode === 'partial'
      ? granted.length > 0
      : (denied.length === 0 && keys.length > 0 && narrativeGranted);

    await writeAudit(this.ctx, {
      projectId, agentId, action: allow ? 'read_l1' : 'deny_l1', keys, reason, allow,
      detail: [
        denied.length
          ? `${mode === 'partial' ? '部分放行' : '越界拒绝'}：${denied.slice(0, 8).join(', ')}${denied.length > 8 ? ' …' : ''}`
          : '',
        narrative && !narrativeGranted ? '叙事式未获准（不注入上一章）' : '',
      ].filter(Boolean).join('；') || undefined,
    });

    return { allow, granted, denied, reason, agentId, narrativeGranted };
  }
}
