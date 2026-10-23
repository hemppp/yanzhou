// ============================================================
// 分层记忆 · 受控的 L1 装配（把闸门接到真实的装配路径上）
//
// 只加"闸门"不接到装配上 = 权限只是纸上声明。本文件是那条接线：
//   `readDigestFor(ctx, projectId, agentId, reason)`
//     → 先问闸门（白名单 + reason + 记账）
//     → 再按**被放行的键族**裁剪 SettingsDigest
//
// 效果（可直接感知）：
//   · 意图复核（reviewer）拿到的 digest 里**没有** characters/outline/chapters —— 它只对契约
//   · 剧情设计师拿不到 entity.locations.*（不在它的白名单里）
//   · 每次读取在 memory_audit 留一条，含 reason 与键
//
// 与 `resolveSettingsDigest` 的关系：后者是"无身份"的原始装配（编排层内部用）；
// 本函数是**面向某个智能体**的受控装配，角色侧一律走这里。
// ============================================================

import type { ServerPluginContext } from '@novel/core';
import { resolveSettingsDigest, type SettingsDigest } from '../context-resolver.js';
import { createMemoryGate, type GateDecision, type L1ReadReason } from './index.js';
import { familyOf, type RoleMemoryPolicy } from './types.js';

/** digest 字段 ← L1 键族 的映射（改 digest 字段时这里必须同步） */
const FIELD_TO_KEY_FAMILY: Array<{ field: keyof SettingsDigest; family: string }> = [
  { field: 'projectName', family: 'settings.projectName' },
  { field: 'genre', family: 'settings.genre' },
  { field: 'brief', family: 'settings.brief' },
  { field: 'characters', family: 'entity.characters' },
  { field: 'foreshadows', family: 'foreshadow' },
  { field: 'outline', family: 'outline' },
  { field: 'chapters', family: 'chapter' },
];

/** 一次装配要"申请"的全部键族（闸门按族的通配模式判定） */
export const DIGEST_KEYS: string[] = FIELD_TO_KEY_FAMILY.map((f) => `${f.family}.*`);

/**
 * digest 加载器。默认是真实的 `resolveSettingsDigest`（要读主库的 projects 表）；
 * 做成可注入是为了**单测能只验闸门与裁剪**，不必去搭一个主库。
 */
export type DigestLoader = (ctx: ServerPluginContext, projectId: string) => Promise<SettingsDigest>;

export interface GatedDigestResult {
  /** 裁剪后的 digest（只含被放行的字段） */
  digest: Partial<SettingsDigest>;
  decision: GateDecision;
  /** 是否获准读叙事式（调用方据此决定要不要注入上一章全文） */
  narrativeGranted: boolean;
}

/**
 * 面向某个智能体的受控装配。
 * @param narrative 是否要叙事式（章节正文）—— reviewer 等会被挡
 */
export async function readDigestFor(
  ctx: ServerPluginContext,
  projectId: string,
  agentId: string,
  reason: L1ReadReason,
  opts?: { narrative?: boolean; load?: DigestLoader },
): Promise<GatedDigestResult> {
  const gate = createMemoryGate(ctx);
  const decision = await gate.authorize({
    projectId, agentId, keys: DIGEST_KEYS, reason, narrative: opts?.narrative,
    // ★ 装配用 partial：digest 是一个"包"，角色拿它**获准的那部分**即可；
    //   若用默认的 strict，任何窄白名单角色都会整包被拒（实测踩到过）
    mode: 'partial',
  });

  // 整次不放行：返回空 digest（**不**降级成"给全部" —— 那是最糟的失败模式）
  if (!decision.allow) return { digest: {}, decision, narrativeGranted: decision.narrativeGranted };

  const load = opts?.load ?? resolveSettingsDigest;
  const full = await load(ctx, projectId);
  const grantedFamilies = new Set(decision.granted.map((k) => familyOf(k)));
  const digest: Partial<SettingsDigest> = {};
  for (const { field, family } of FIELD_TO_KEY_FAMILY) {
    if (!grantedFamilies.has(familyOf(family))) continue;
    const v = full[field];
    if (v !== undefined && v !== '') (digest as Record<string, unknown>)[field] = v;
  }
  return { digest, decision, narrativeGranted: decision.narrativeGranted };
}

/**
 * 纯函数版（不碰库）：给定策略与键，算出"这个角色能拿到 digest 的哪几个字段"。
 * 单测直接验权限矩阵，不必每次真去装配。
 */
export function digestFieldsFor(policy: RoleMemoryPolicy | undefined): Array<keyof SettingsDigest> {
  if (!policy) return [];                        // fail-closed
  if (policy.l1Wide) return FIELD_TO_KEY_FAMILY.map((f) => f.field);
  const out: Array<keyof SettingsDigest> = [];
  for (const { field, family } of FIELD_TO_KEY_FAMILY) {
    const allowed = (policy.readL1 ?? []).some((p) => {
      const pat = p.endsWith('*') ? p.slice(0, -1) : p;
      return `${family}.`.startsWith(pat.endsWith('.') ? pat : `${pat}.`) || family === pat;
    });
    if (allowed) out.push(field);
  }
  return out;
}
