// ============================================================
// 分层记忆 · 类型与常量
// 设计：docs/architecture/multi-agent-memory-architecture.md
//
// 两条铁律写在类型里，让越权**编不过**：
//   · 传给智能体的句柄没有「写全局」的方法
//   · 事实引用（FactRef）与经历（Experience）是不同类型，不能互相赋值
// ============================================================

/** 记忆形态：同一层内部的"双式"，必须隔离（事实能当依据，叙事只能被引用） */
export type MemoryForm = 'fact_ref' | 'experience';

/** L2 事实引用：**存指针不存副本**（副本会变成"第二真相"） */
export interface FactRef {
  /** 指向 L1 事实的稳定 id，如 'characters:陈默' */
  factId: string;
  /** 这个智能体当时为什么采信它（复盘用） */
  why: string;
  sourceChapter?: number;
}

/** L2 经历：该智能体视角下的发言/收到的话。**不能被当作事实依据** */
export interface Experience {
  /** 经历类型：自己说的 / 收到的同伴发言 */
  kind: 'said' | 'heard';
  text: string;
  /** 谁说的（heard 时必填） */
  from?: string;
  /** 归属章号/轮次，引用时必须能回溯 */
  ref: string;
}

/** L1 读取的**具名触发**。枚举里没有"想看看"这类值 —— 那是故意的 */
export type L1ReadReason =
  | 'discuss-context'         // 设计讨论前的装配（每个角色按自己的白名单拿一份）
  | 'continuity-check'        // 设定管家核对出处
  | 'assemble-before-write'   // 写作官落笔前装配
  | 'gate-review'             // 门禁复核（意图/校对）
  | 'recall-by-need';         // 按需回读早期情节

/** 审计动作 */
export type MemoryAuditAction =
  | 'assemble'        // 装配完成：记本次**注入内容**的指纹（I6 可复现的抓手）
  | 'read_l1'
  | 'deny_l1'
  | 'write_l2'
  | 'deny_write_l2'
  | 'ingest'
  | 'conflict';

/**
 * L1 事实式的**键族**。白名单按族授权，避免把键写成散字符串（改一处要改十处）。
 * 命名规范：`<族>.<主体>[.<子键>]`
 */
export const L1_KEY_FAMILIES = [
  'settings.projectName',
  'settings.genre',
  'settings.brief',
  'entity.characters',   // entity.characters.<名称>
  'entity.locations',
  'entity.items',
  'foreshadow',          // foreshadow.<名称>.status
  'constraint',          // constraint.<名称>
  'outline',             // outline.<节点>
  'chapter',             // chapter.<n>.summary
] as const;

export type L1KeyFamily = typeof L1_KEY_FAMILIES[number];

/** 角色可读的 L1 键模式（支持末尾 `*` 通配） */
export interface RoleMemoryPolicy {
  /** 允许读的键模式，如 'entity.characters.*'；**缺省为空 = 什么都读不到（fail-closed）** */
  readL1?: string[];
  /** 查库宽权限（设定管家专用）：可读全部 L1 事实式，但仍要带 reason 与出处 */
  l1Wide?: boolean;
  /** 是否允许读 L1 叙事式（章节正文）。reviewer 明确为 false —— 只对契约，不被文笔带偏 */
  readNarrative?: boolean;
}

/**
 * 键是否命中某个模式。
 * 三条规则（**族名天然覆盖子树**，不用逐条写通配）：
 *   1. 以 `*` 结尾 → 前缀匹配（'entity.characters.*' 命中 'entity.characters.陈默'）
 *   2. 不含通配 → **精确命中它自己和它的子树**（'settings.brief' 命中 'settings.brief' 与 'settings.brief.x'）
 *   3. 否则精确匹配
 * ※ 规则 2 是必须的：白名单里写族名是最自然的写法（`settings.brief`），
 *   而申请侧拼出来的键往往带尾巴（`settings.brief.*`）—— 只做精确匹配会让"看着声明了却读不到"。
 */
export function matchPattern(pattern: string, key: string): boolean {
  if (pattern.endsWith('*')) return key.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith('.')) return key.startsWith(pattern);
  return pattern === key || key.startsWith(`${pattern}.`);
}

/** 键是否命中任一模式 */
export function matchAny(patterns: readonly string[] | undefined, key: string): boolean {
  if (!patterns || patterns.length === 0) return false;   // fail-closed
  return patterns.some((p) => matchPattern(p, key));
}

/** 键所属的族（用于把白名单结果映射回 digest 字段） */
export function familyOf(key: string): string {
  const parts = key.split('.');
  if (parts.length >= 2 && (parts[0] === 'settings' || parts[0] === 'entity')) return `${parts[0]}.${parts[1]}`;
  return parts[0];
}
