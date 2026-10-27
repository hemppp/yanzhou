// ============================================================
// 砚舟 - 核心数据类型定义
// ============================================================

// ---- 基础类型 ----

export interface BaseEntity {
  id: string;
  createdAt: number;
  updatedAt: number;
}

// ---- 项目 ----

/**
 * 创作模式 —— 决定该项目加载哪一套工作台，两套 UI **互斥**：
 * - 'manual'：手写框架（罗盘气泡 + 自由浮窗面板 + AI 对话框辅助）
 * - 'auto'  ：AI 写作框架（智能体交流流 + 流式写文；手写面板与罗盘一律不挂载）
 * 缺省/旧数据一律视为 'manual'。
 */
export type ProjectMode = 'manual' | 'auto';

/**
 * 小说流派大分类：
 * - 'system'：**系统流** —— 主角带系统 / 金手指，世界围绕「面板、任务、奖励」运转
 * - 'none'  ：**无系统流** —— 现实或纯架空，没有外挂装置，靠人物与世界自身推动
 */
export type GenreCategory = 'system' | 'none';

/**
 * 开书设定（AI 写作新书向导产出）。
 *
 * 只在 `mode === 'auto'` 的项目上有意义：手写模式的书由作者自己在编辑器里组织设定，
 * 不走这套表单。这份数据会作为「创作设定」**强制注入**讨论链路（见
 * `novel.autowrite/server/framework/context-resolver.ts`），
 * 让设计角色与写作官在第一轮就拿到书名之外的开局 / 世界观 / 笔风 / 主角 / 女主 / 流派。
 */
export interface NovelBrief {
  /** 开局：故事从哪一刻、哪个场景切入 */
  opening: string;
  /** 世界观：时代 / 舞台 / 规则 / 力量体系 */
  worldview: string;
  /** 笔风基调：叙事语气与节奏（如「冷硬克制、短句为主」） */
  style: string;
  /** 主角姓名 */
  protagonist: string;
  /** 是否多女主（true 时 heroines 是多位） */
  multipleHeroines: boolean;
  /** 女主姓名列表；单女主时长度 1 */
  heroines: string[];
  /** 流派大分类 */
  genreCategory: GenreCategory;
  /** 细分流派名（如「末日求生」） */
  genre: string;
}

export interface Project extends BaseEntity {
  userId: string;
  name: string;
  description?: string;
  coverImage?: string;
  penName?: string;
  genre?: string;
  targetWordCount?: number;
  currentWordCount: number;
  /** 创作模式，见 ProjectMode；缺省 'manual' */
  mode?: ProjectMode;
  /** 开书设定，见 NovelBrief；仅 AI 写作模式会写入 */
  brief?: NovelBrief;
}

// ---- 章节 ----

export interface Chapter extends BaseEntity {
  projectId: string;
  title: string;
  content: string;        // Markdown 内容
  order: number;
  wordCount: number;
  summary?: string;       // AI 生成的摘要
  status: ChapterStatus;
  label?: string;         // 自定义标签
  pov?: string;           // 视角角色 ID
  deletedAt?: number | null; // 软删除时间戳，null/undefined = 未删除
}

export type ChapterStatus = 'draft' | 'revised' | 'final' | 'archived';

// ---- 角色 ----

export interface Character extends BaseEntity {
  projectId: string;
  name: string;
  aliases: string[];       // 别名/代称
  thumbnail?: string;
  color?: string;          // 高亮颜色
  role?: 'protagonist' | 'femaleLead' | 'supporting' | 'minor';  // 角色定位：主角 / 女主 / 配角 / 路人甲

  // 内核（手动填写）
  desire?: string;         // 欲望
  fear?: string;           // 恐惧
  belief?: string;         // 信念
  weakness?: string;       // 致命弱点

  // 描述
  appearance?: string;     // 外貌
  personality?: string;    // 性格
  backstory?: string;      // 背景故事
  speechStyle?: string;    // 说话风格/口头禅

  // 动态追踪（自动 + 手动）
  states: EntityState[];
  relations: CharacterRelation[];
  chapters: number[];      // 出场章节列表
  tags: string[];
}

export interface CharacterRelation {
  targetId: string;
  type: string;            // 关系类型
  description?: string;
  chapter?: number | null; // 关系建立/变化的章节（DB 可空）
  direction: 'from' | 'to' | 'mutual';
}

// ---- 物品 ----

export interface Item extends BaseEntity {
  projectId: string;
  name: string;
  type?: string;           // 物品类型（武器/信物/法器/...）
  description?: string;
  thumbnail?: string;
  color?: string;
  creditPrice?: number;    // 积分定价（系统文：系统商城兑换所需积分）
  states: EntityState[];
  holders: ItemHolder[];        // 装备流转史（按 chapter 顺序）
  currentHolders: string[];     // 当前持有者（可共享、可空）—— 从 holders 派生或显式记录
  relations: ItemRelation[];    // 物品间关系（配对 / 包含 / 部件 / 对立 / 变形 / 关联）
  chapters: number[];
  tags: string[];
}

export interface ItemHolder {
  characterId: string;
  chapter: number;
  /** held = 该章中角色持有/使用/穿戴此物品（无流转变化，不写入流转史，仅更新当前持有者） */
  action: 'gained' | 'lost' | 'transferred' | 'held';
}

/** 物品间关系（如剑-鞘、钥匙-锁、信物-信物） */
export interface ItemRelation {
  targetItemId: string;
  type: ItemRelationType;
  description?: string;
  chapter?: number;
}

export type ItemRelationType =
  | 'paired_with'   // 配对：剑-鞘、钥匙-锁
  | 'contains'      // 包含：宝箱-金币
  | 'part_of'       // 属于：组件-整机
  | 'opposite_of'   // 对立：正-邪法宝
  | 'transforms_into' // 变形：狼人-人形
  | 'related_to';   // 泛关联

/**
 * 派生：按 holders 流转史实时推算当前持有者集合。
 * 当 currentHolders 字段缺失或与 holders 推导结果不一致时，可作为兜底。
 *
 * 规则：按 chapter 升序遍历 holders，每个角色的最后一次动作若是 gained / transferred
 * 则视为当前持有；lost 则视为已失去。
 */
export function deriveCurrentHolders(holders: ItemHolder[] = []): string[] {
  const lastAction = new Map<string, ItemHolder['action']>();
  for (const h of [...holders].sort((a, b) => a.chapter - b.chapter)) {
    lastAction.set(h.characterId, h.action);
  }
  const result: string[] = [];
  for (const [cid, action] of lastAction) {
    if (action === 'gained' || action === 'transferred') result.push(cid);
  }
  return result;
}

// ---- 系统积分（系统文：积分使用结余追踪） ----

export type CreditTransactionType = 'gain' | 'spend';  // 获得 | 消耗

export interface CreditTransaction extends BaseEntity {
  projectId: string;
  characterId: string;          // 积分持有者（绑定系统者）
  chapter: number;              // 发生章节
  type: CreditTransactionType;
  amount: number;               // 数额（恒为正数，方向由 type 决定）
  reason?: string;              // 事由（任务奖励 / 击杀 / 兑换 ...）
  relatedItemId?: string;       // 关联物品（消耗兑换所得 / 获得之物）
  tags: string[];
}

/**
 * 派生：某角色截至某章（含）的积分结余。
 * 不指定 upToChapter 时计算全部流水的最终结余。
 * 可为负——负数本身就是"账目不一致"的信号，供结余追踪告警。
 */
export function deriveCreditBalance(
  transactions: CreditTransaction[] = [],
  characterId: string,
  upToChapter?: number,
): number {
  let balance = 0;
  for (const t of transactions) {
    if (t.characterId !== characterId) continue;
    if (upToChapter !== undefined && t.chapter > upToChapter) continue;
    balance += t.type === 'gain' ? t.amount : -t.amount;
  }
  return balance;
}

/** 派生：所有角色的当前积分结余映射 */
export function deriveCreditBalances(transactions: CreditTransaction[] = []): Map<string, number> {
  const balances = new Map<string, number>();
  for (const t of transactions) {
    const delta = t.type === 'gain' ? t.amount : -t.amount;
    balances.set(t.characterId, (balances.get(t.characterId) ?? 0) + delta);
  }
  return balances;
}

/**
 * 派生：按章节升序的流水列表，附每笔后的结余（以该角色全部流水为基准重放）。
 * 用于账本视图逐笔展示"变动后结余"，负结余即为追踪告警点。
 */
export function replayCreditLedger(
  transactions: CreditTransaction[] = [],
  characterId: string,
): Array<CreditTransaction & { balanceAfter: number }> {
  const sorted = transactions
    .filter((t) => t.characterId === characterId)
    .sort((a, b) => a.chapter - b.chapter || a.createdAt - b.createdAt);
  let balance = 0;
  return sorted.map((t) => {
    balance += t.type === 'gain' ? t.amount : -t.amount;
    return { ...t, balanceAfter: balance };
  });
}

// ---- 地点 ----

export interface Location extends BaseEntity {
  projectId: string;
  name: string;
  description?: string;
  thumbnail?: string;
  color?: string;
  latitude?: number;
  longitude?: number;
  mapZoom?: number;
  /** 所属世界（用于多世界/穿越小说） */
  world?: string;
  states: EntityState[];
  chapters: number[];
  tags: string[];
}

// ---- 事件 ----

export interface StoryEvent extends BaseEntity {
  projectId: string;
  title: string;
  description?: string;
  chapter: number;
  participants: string[];  // 参与角色 ID
  relatedItems: string[];  // 关联物品 ID
  relatedLocations: string[]; // 关联地点 ID
  consequences: string[];  // 导致的变化描述
  tags: string[];
}

// ---- 伏笔 ----

export interface Foreshadow extends BaseEntity {
  projectId: string;
  description: string;      // 一句话描述
  type: ForeshadowType;
  status: ForeshadowStatus;

  // 生命周期
  seedChapter: number;      // 播种章节
  seedText?: string;        // 播种位置的文字
  seedAnnotationId?: string;
  hints: ForeshadowHint[];
  payoffChapter?: number | null;   // 回收章节（DB 可空）
  payoffText?: string;
  payoffAnnotationId?: string;

  // 关联
  relatedCharacters: string[];
  relatedItems: string[];
  relatedEvents: string[];
  earmarks: string[];       // 关联的 Earmark IDs
  tags: string[];
}

export type ForeshadowType =
  | 'identity'    // 身份
  | 'motivation'  // 动机
  | 'relation'    // 关系
  | 'trauma'      // 创伤
  | 'turning'     // 转折
  | 'fate';       // 命运

export type ForeshadowStatus =
  | 'planted'     // 已播种
  | 'hinted'      // 已暗示
  | 'payed_off'   // 已回收
  | 'abandoned';  // 已废弃

export interface ForeshadowHint {
  chapter: number;
  text?: string;
  annotationId?: string;
  earmarkId?: string;  // 关联的 Earmark ID
}

// ---- 书角标记 ----

/**
 * 书角标记 - 用于标记章节与伏笔的关系
 * 可以标记章节中埋下的伏笔、回收的伏笔，或者某种可能性
 */
export interface Earmark extends BaseEntity {
  projectId: string;
  chapterId: string;           // 关联的章节 ID
  type: EarmarkType;          // 标记类型
  
  // 关联的伏笔（可选）
  foreshadowId?: string;      // 关联的伏笔 ID
  
  // 描述
  description?: string;       // 备注说明
  outcome?: string;           // 预期结局描述
  
  // 可能性（用于多重结局模式）
  probability?: number;       // 发生可能性 (0-100)
  
  // 关联的其他实体
  relatedCharacters: string[]; // 相关角色 IDs
  relatedItems: string[];     // 相关物品 IDs
  
  tags: string[];             // 标签
}

/**
 * 书角标记类型
 * - foreshadow_seed: 伏笔播种 - 这里可能埋下某个伏笔
 * - foreshadow_payoff: 伏笔回收 - 这里可能回收某个伏笔
 * - possibility: 可能性 - 这里可能有某种发展
 */
export type EarmarkType = 
  | 'foreshadow_seed'    // 伏笔播种 - 这里可能埋下某个伏笔
  | 'foreshadow_payoff'  // 伏笔回收 - 这里可能回收某个伏笔
  | 'possibility';       // 可能性 - 这里可能有某种发展

// ---- 参考书（纯阅读对照）----

export interface ReferenceBook {
  id: string;
  projectId: string;
  title: string;
  author?: string;
  content: string;
  /** 按章节分割 */
  chapters: { title: string; content: string }[];
  /** 当前阅读位置 */
  currentChapter: number;
  source?: string;
  createdAt: number;
  updatedAt: number;
}

// ---- 标注（划词标注）----

export interface Annotation extends BaseEntity {
  projectId: string;
  chapterId: string;
  type: AnnotationType;
  startOffset: number;     // 在章节内容中的起始位置
  endOffset: number;       // 结束位置
  selectedText: string;    // 选中的文字
  color?: string;

  // 关联
  targetId?: string;       // 关联的角色/物品/地点/事件 ID
  targetType?: 'character' | 'item' | 'location' | 'event' | 'foreshadow';
  description?: string;    // 标注描述

  // 伏笔专用
  foreshadowType?: ForeshadowType;
  foreshadowStatus?: ForeshadowStatus;
}

export type AnnotationType =
  | 'character'
  | 'item'
  | 'location'
  | 'foreshadow'
  | 'event'
  | 'relation'
  | 'custom';

// ---- 实体状态追踪 ----

export interface EntityState {
  chapter: number;
  field: string;           // 状态字段名
  oldValue?: string;
  newValue: string;
  description?: string;
}

// ---- 大纲 ----

export interface OutlineNode extends BaseEntity {
  projectId: string;
  parentId?: string;
  type: OutlineNodeType;
  title: string;
  description?: string;
  order: number;
  linkedChapterIds: string[];
  tags: string[];
}

export type OutlineNodeType =
  | 'act'        // 幕
  | 'chapter'    // 章节
  | 'scene'      // 场景
  | 'beat'       // 节拍
  | 'note';      // 笔记

// ---- 时间线 ----

export interface TimelineEvent extends BaseEntity {
  projectId: string;
  title: string;
  description?: string;
  chapter?: number | null;  // 关联章节（DB 可空）
  timestamp?: string;      // 故事内时间（自由文本）
  order: number;
  characterIds: string[];  // 涉及角色
  type: 'event' | 'foreshadow' | 'state_change';
  color?: string;
}

// ---- 笔记/片段 ----

export interface Note extends BaseEntity {
  projectId: string;
  title?: string;
  content: string;
  tags: string[];
  pinned: boolean;
  linkedChapterId?: string;
}

// ---- 写作统计 ----

export interface WritingStats {
  projectId: string;
  date: string;            // YYYY-MM-DD
  wordCount: number;
  chapterId?: string;
  duration?: number;       // 写作时长（秒）
}

// ---- 快照 ----

export interface Snapshot extends BaseEntity {
  chapterId: string;
  content: string;
  wordCount: number;
  label?: string;
  auto: boolean;           // 是否自动保存
}

// ---- AI 相关 ----

export interface AIConversation extends BaseEntity {
  projectId: string;
  chapterId?: string;
  messages?: AIMessage[];
  context?: AIContext;
}

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface AIContext {
  chapterContent?: string;
  characterIds: string[];
  itemIds: string[];
  locationIds: string[];
  foreshadowIds: string[];
  includeOutline: boolean;
  includeFullNovel: boolean;
}

export interface AIScanResult {
  chapterId: string;
  characters: EntityMention[];
  items: EntityMention[];
  locations: EntityMention[];
  events: EventMention[];
  stateChanges: StateChangeMention[];
  foreshadowSuggestions: ForeshadowSuggestion[];
  consistencyIssues: ConsistencyIssue[];
}

export interface EntityMention {
  name: string;
  existingId?: string;     // 匹配到已有实体的 ID
  isNew: boolean;
  context: string;         // 上下文文字
  offset?: number;         // 在章节内容中的位置（扫描器未必填充）
}

export interface EventMention {
  title: string;
  description: string;
  /** 事件类型：普通事件 / 伏笔铺垫 / 状态变化 */
  type: 'event' | 'foreshadow' | 'state_change';
  /** 涉及角色名称（角色在文中的名字） */
  characterNames: string[];
  /** 章节序号 */
  chapterOrder: number;
  /** 故事内时间（自由文本，如有） */
  timestamp?: string;
  /** 参与角色（兼容旧字段，可选） */
  participants?: string[];
  /** 在章节内容中的位置（可选） */
  offset?: number;
}

export interface StateChangeMention {
  entityId?: string;
  entityName?: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
  context?: string;
  // 扫描器历史字段（兼容 mapScannerResult 输出）
  entity?: string;
  change?: string;
  attribute?: string;
}

export interface ForeshadowSuggestion {
  text: string;
  type: ForeshadowType;
  relatedCharacters?: string[];
  reason?: string;
  // 扫描器历史字段（兼容 mapScannerResult 输出）
  description?: string;
  context?: string;
  confidence?: number;
}

export interface ConsistencyIssue {
  type?: 'timeline' | 'location' | 'character' | 'item' | 'custom';
  severity?: 'error' | 'warning' | 'info';
  description: string;
  chapterId?: string;
  offset?: number;
  relatedEntityIds?: string[];
  // 扫描器历史字段（兼容 mapScannerResult 输出）
  issue?: string;
  suggestion?: string;
}

// ---- 标记/高亮 ----

export interface TextMarker {
  id: string;
  chapterId: string;
  startOffset: number;
  endOffset: number;
  color: string;
  label?: string;
}

// ---- 系列 ----

export interface Series extends BaseEntity {
  name: string;
  description?: string;
  projectIds: string[];
  sharedCharacterIds: string[];
  sharedLocationIds: string[];
}
