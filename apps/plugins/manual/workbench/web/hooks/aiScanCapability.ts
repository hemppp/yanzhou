// ============================================================
// manual 模块内的 AI 扫描能力契约（本模块自带类型声明，零运行时依赖）
//
// 为什么在模块内声明而不去 import 另一模块的实现：
//   三层拆分禁止 manual → auto 的静态 import（门禁断言 A 的 M2A）。
//   模块内只保留「能力形状」的类型声明，运行时经 kernel 注册表
//   getCapability('ai.scan') 取**提供方模块注册的共享实现**：
//   · 能力表（AI 接口）是**两边模块都可引用的共享面**：core 契约写的是
//     「一个模块提供实现、另一个模块按名消费，缺席时静默降级」，kernel 不按
//     模块/创作模式隔离它（模式隔离只作用于 UI 扩展点与模块间静态 import）；
//   · ★ 2026-10-11：provider 已由本模块补齐（`web/ai/aiCapabilityProvider.ts`，
//     经 manual 入口 apply() 注册 ai.scan / ai.timelineExtract / ai.quickPhrases）。
//     此前的「全仓无 provider ⇒ 能力为 null ⇒ 调用点静默 return」为历史状态；
//     各调用点的缺席分支按设计 §5.3 保留（能力真的缺席时仍然生效）。
// ============================================================

/** 流式时间线事件（即 `ai.scan` 能力返回的事件结构） */
export interface StreamTimelineEvent {
  title: string;
  description: string;
  type: 'event' | 'foreshadow' | 'state_change';
  characterNames: string[];
  chapterOrder: number;
  timestamp?: string;
  /** 原文证据片段（服务端已校验逐字命中，可直接用于二次去重/定位） */
  quote?: string;
}

/** 流式实体（角色/物品/地点） */
export interface StreamEntity {
  entityType: 'character' | 'item' | 'location';
  name: string;
  description: string;
  context: string;
  appearance?: string;
  personality?: string;
  role?: 'protagonist' | 'femaleLead' | 'supporting' | 'minor';
  speechStyle?: string;
  itemType?: string;
}

/** 流式物品流转 */
export interface StreamItemTransfer {
  transferType: 'item_transfer';
  itemName: string;
  fromCharacter: string;
  toCharacter: string;
  action: 'gained' | 'lost' | 'transferred' | 'held';
  context: string;
}

/** 流式角色别名关系 */
export interface StreamAliasMatch {
  aliasType: 'alias_match';
  primaryName: string;
  aliases: string[];
  context: string;
}

/** 流式积分流水（系统文：正文明确写出的积分消耗/获得/系统赠予） */
export interface StreamCreditTransaction {
  creditType: 'credit_transaction';
  action: 'gain' | 'spend' | 'gift';
  characterName: string;
  amount: number;
  reason?: string;
  itemName?: string;
  chapterOrder: number;
}

/** 扫描被跳过（后端红石开关关闭）时抛出的错误 —— 本地同名类，调用方用 instanceof 判定 */
export class ScanSkippedError extends Error {
  reason: string;
  constructor(reason: string) {
    super(`扫描被跳过：${reason}`);
    this.name = 'ScanSkippedError';
    this.reason = reason;
  }
}

/**
 * `ai.scan` 能力的形状：由提供方经
 * `ctx.registerCapability('ai.scan', impl)` 注册后，任一模块都可按名取用 ——
 * AI 接口是两边共享的引用面（kernel 不按模块/创作模式过滤；隔离只作用于
 * UI 扩展点与模块间静态 import）。
 * ★ 2026-10-11 起提供方 = 本模块 `web/ai/aiCapabilityProvider.ts`（manual 入口注册）。
 * 缺失（null）时：自动实体检测 / 最新章节轮询**静默 return**（设计 §5.3）。
 */
export interface AIScanCapability {
  scanTimelineStream(
    chapterContent: string,
    chapterOrder: number,
    existingEntities: {
      characters: Array<string | { name: string; aliases: string[] }>;
      items: string[];
      locations: string[];
    },
    onEvent: (event: StreamTimelineEvent) => void,
    onEntity?: (entity: StreamEntity) => void,
    onItemTransfer?: (transfer: StreamItemTransfer) => void,
    onAliasMatch?: (aliasMatch: StreamAliasMatch) => void,
    signal?: AbortSignal,
    projectId?: string,
    onCreditTransaction?: (credit: StreamCreditTransaction) => void,
  ): Promise<StreamTimelineEvent[]>;
  extractEventsByKeyword(
    content: string,
    title: string,
    order: number,
    keyword: string,
    onEvent: (event: StreamTimelineEvent) => void,
  ): Promise<void>;

  // ---- 红石开关面（见 AIScanRedstone）----
  isScannerEnabled: () => boolean;
  isExtractEnabled: () => boolean;
  registerAbort: (feature: string, controller: AbortController) => () => void;
  subscribeRedstone: (cb: () => void) => () => void;
}

/**
 * 红石开关面（scanner/extract）—— 同属 `ai.scan` 能力的一部分
 * （设计 §5.2 只允许 5 个能力名，故不新造 `ai.redstone` 契约）。
 * 能力缺失时：视为「已启用」，保持原行为（不改变既有语义）。
 */
export interface AIScanRedstone {
  isScannerEnabled: () => boolean;
  isExtractEnabled: () => boolean;
  registerAbort: (feature: string, controller: AbortController) => () => void;
  /** 订阅红石开关变化（供 useSyncExternalStore 保持响应性） */
  subscribeRedstone: (cb: () => void) => () => void;
}