// ============================================================
// 砚舟 - Drizzle ORM 数据库 Schema (SQLite)
// ============================================================

import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

// ---- 插件 KV（插件数据扩展 v1）----

export const pluginKv = sqliteTable('plugin_kv', {
  id: text('id').primaryKey(),
  pluginId: text('plugin_id').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
  projectId: text('project_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  uniqueKey: uniqueIndex('idx_plugin_kv_unique').on(table.pluginId, table.key, table.projectId),
}));

// ---- 用户 ----

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  avatar: text('avatar'),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  usernameIdx: index('idx_users_username').on(table.username),
}));

// ---- 项目 ----

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  coverImage: text('cover_image'),
  penName: text('pen_name'),
  genre: text('genre'),
  targetWordCount: integer('target_word_count'),
  currentWordCount: integer('current_word_count').notNull().default(0),
  /** 创作模式：'manual'（手写框架）| 'auto'（AI 写作框架）。NULL/旧数据按 'manual' 处理 */
  mode: text('mode'),
  /** 开书设定（AI 写作新书向导产出），JSON 文本；手写项目为 NULL */
  brief: text('brief'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  userIdIdx: index('idx_projects_user_id').on(table.userId),
}));

// ---- 章节 ----

export const chapters = sqliteTable('chapters', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  content: text('content').notNull().default(''),
  order: integer('order').notNull(),
  wordCount: integer('word_count').notNull().default(0),
  summary: text('summary'),
  status: text('status').notNull().default('draft'), // 草稿|已修订|已完成|已归档
  label: text('label'),
  pov: text('pov'), // 视角角色 ID
  // 故事内时间（如「第 3 日」）。★ 与章号不是一回事：一章可能写三天，也可能一天写五章。
  // 水车的三层时间戳靠它判断"她说'昨天'对不对"。由交付时从定稿官的契约里抽取，抽不到就是 null。
  storyTime: text('story_time'),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }), // 软删除时间戳，null = 未删除
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  projectIdIdx: index('idx_chapters_project_id').on(table.projectId),
  orderIdx: index('idx_chapters_order').on(table.order),
}));

// ---- 角色 ----

export const characters = sqliteTable('characters', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  aliases: text('aliases'), // JSON 字符串数组
  thumbnail: text('thumbnail'),
  color: text('color'),
  role: text('role'),       // 角色定位：protagonist / supporting / minor
  // 内核
  desire: text('desire'),
  fear: text('fear'),
  belief: text('belief'),
  weakness: text('weakness'),
  // 描述
  appearance: text('appearance'),
  personality: text('personality'),
  backstory: text('backstory'),
  speechStyle: text('speech_style'),
  // 动态
  states: text('states'),        // JSON EntityState[]
  relations: text('relations'),  // JSON CharacterRelation[]
  chapters: text('chapters'),    // JSON 数字数组
  tags: text('tags'),            // JSON 字符串数组
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  projectIdIdx: index('idx_characters_project_id').on(table.projectId),
}));

// ---- 物品 ----

export const items = sqliteTable('items', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type'),
  description: text('description'),
  thumbnail: text('thumbnail'),
  color: text('color'),
  creditPrice: real('credit_price'),      // 积分定价（系统文：商城兑换所需积分）
  states: text('states'),                // JSON EntityState[]
  holders: text('holders'),              // JSON ItemHolder[] 装备流转史
  currentHolders: text('current_holders'), // JSON string[] 当前持有者（可共享、可空）
  relations: text('relations'),           // JSON ItemRelation[] 物品间关系
  chapters: text('chapters'),            // JSON 数字数组
  tags: text('tags'),                    // JSON 字符串数组
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  projectIdIdx: index('idx_items_project_id').on(table.projectId),
}));

// ---- 系统积分（系统文：积分使用结余追踪） ----

export const creditTransactions = sqliteTable('credit_transactions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  characterId: text('character_id'),     // 积分持有者（绑定系统者）
  chapter: integer('chapter').notNull(), // 发生章节
  type: text('type').notNull(),          // gain|spend
  amount: real('amount').notNull(),      // 数额（恒为正，方向由 type 决定）
  reason: text('reason'),                // 事由
  relatedItemId: text('related_item_id'), // 关联物品（兑换所得 / 获得之物）
  tags: text('tags'),                    // JSON 字符串数组
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  projectIdIdx: index('idx_credit_transactions_project_id').on(table.projectId),
  characterIdIdx: index('idx_credit_transactions_character_id').on(table.characterId),
}));

// ---- 地点 ----

export const locations = sqliteTable('locations', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  thumbnail: text('thumbnail'),
  color: text('color'),
  latitude: real('latitude'),
  longitude: real('longitude'),
  mapZoom: integer('map_zoom'),
  world: text('world'),
  states: text('states'),       // JSON EntityState[]
  chapters: text('chapters'),   // JSON 数字数组
  tags: text('tags'),           // JSON 字符串数组
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  projectIdIdx: index('idx_locations_project_id').on(table.projectId),
}));

// ---- 事件 ----

export const storyEvents = sqliteTable('story_events', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  chapter: integer('chapter').notNull(),
  participants: text('participants'),       // JSON 字符串数组（角色 ID）
  relatedItems: text('related_items'),      // JSON 字符串数组
  relatedLocations: text('related_locations'), // JSON 字符串数组
  consequences: text('consequences'),       // JSON 字符串数组
  tags: text('tags'),                       // JSON 字符串数组
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  projectIdIdx: index('idx_story_events_project_id').on(table.projectId),
}));

// ---- 伏笔 ----

export const foreshadows = sqliteTable('foreshadows', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  description: text('description').notNull(),
  type: text('type').notNull(),       // 身份|动机|关系|创伤|转折|命运
  status: text('status').notNull().default('planted'), // 已播种|已暗示|已回收|已废弃
  // 生命周期
  seedChapter: integer('seed_chapter').notNull(),
  seedText: text('seed_text'),
  seedAnnotationId: text('seed_annotation_id'),
  hints: text('hints'),               // JSON ForeshadowHint[]
  payoffChapter: integer('payoff_chapter'),
  payoffText: text('payoff_text'),
  payoffAnnotationId: text('payoff_annotation_id'),
  // 关联
  relatedCharacters: text('related_characters'), // JSON 字符串数组
  relatedItems: text('related_items'),           // JSON 字符串数组
  relatedEvents: text('related_events'),         // JSON 字符串数组
  earmarks: text('earmarks'),                    // JSON 字符串数组 - 关联的 Earmark IDs
  tags: text('tags'),                            // JSON 字符串数组
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  projectIdIdx: index('idx_foreshadows_project_id').on(table.projectId),
}));

// ---- 书角标记 ----

export const earmarks = sqliteTable('earmarks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  chapterId: text('chapter_id').notNull().references(() => chapters.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),  // 伏笔播种|伏笔回收|可能性
  foreshadowId: text('foreshadow_id').references(() => foreshadows.id, { onDelete: 'set null' }),  // 关联的伏笔 ID（可选）
  description: text('description'),
  outcome: text('outcome'),
  probability: real('probability'),  // 0-100
  relatedCharacters: text('related_characters'),  // JSON 字符串数组
  relatedItems: text('related_items'),  // JSON 字符串数组
  tags: text('tags'),  // JSON 字符串数组
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  projectIdIdx: index('idx_earmarks_project_id').on(table.projectId),
  chapterIdIdx: index('idx_earmarks_chapter_id').on(table.chapterId),
}));

// ---- 标注 ----

export const annotations = sqliteTable('annotations', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  chapterId: text('chapter_id').notNull().references(() => chapters.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),       // 角色|物品|地点|伏笔|事件|关系|自定义
  startOffset: integer('start_offset').notNull(),
  endOffset: integer('end_offset').notNull(),
  selectedText: text('selected_text').notNull(),
  color: text('color'),
  // 关联
  targetId: text('target_id'),
  targetType: text('target_type'),    // 角色|物品|地点|事件|伏笔
  description: text('description'),
  // 伏笔专用
  foreshadowType: text('foreshadow_type'),
  foreshadowStatus: text('foreshadow_status'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  projectIdIdx: index('idx_annotations_project_id').on(table.projectId),
  chapterIdIdx: index('idx_annotations_chapter_id').on(table.chapterId),
}));

// ---- 大纲 ----

export const outlineNodes = sqliteTable('outline_nodes', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  parentId: text('parent_id'),  // 自引用外键因 TS 循环类型推断限制未添加，由 service 层校验完整性
  type: text('type').notNull(),       // 幕|章节|场景|节拍|笔记
  title: text('title').notNull(),
  description: text('description'),
  order: integer('order').notNull(),
  linkedChapterIds: text('linked_chapter_ids'), // JSON 字符串数组
  tags: text('tags'),                           // JSON 字符串数组
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  projectIdIdx: index('idx_outline_nodes_project_id').on(table.projectId),
}));

// ---- 时间线 ----

export const timelineEvents = sqliteTable('timeline_events', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  chapter: integer('chapter'),
  timestamp: text('timestamp'),       // 故事内时间（自由文本）
  order: integer('order').notNull(),
  characterIds: text('character_ids'), // JSON 字符串数组
  type: text('type').notNull(),       // 事件|伏笔|状态变化
  color: text('color'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  projectIdIdx: index('idx_timeline_events_project_id').on(table.projectId),
}));

// ---- 笔记/片段 ----

export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title'),
  content: text('content').notNull().default(''),
  tags: text('tags'),                 // JSON 字符串数组
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  linkedChapterId: text('linked_chapter_id').references(() => chapters.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  projectIdIdx: index('idx_notes_project_id').on(table.projectId),
}));

// ---- 参考书（纯阅读对照）----

export const referenceBooks = sqliteTable('reference_books', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  author: text('author'),
  content: text('content').notNull().default(''),
  chapters: text('chapters', { mode: 'json' }).notNull().default([]),  // JSON { title, content }[]
  currentChapter: integer('current_chapter').notNull().default(0),
  source: text('source'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  projectIdIdx: index('idx_reference_books_project_id').on(table.projectId),
}));

// ---- 写作统计 ----

export const writingStats = sqliteTable('writing_stats', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),       // YYYY-MM-DD
  wordCount: integer('word_count').notNull().default(0),
  chapterId: text('chapter_id'),
  duration: integer('duration'),      // 写作时长（秒）
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  projectIdIdx: index('idx_writing_stats_project_id').on(table.projectId),
}));

// ---- 快照 ----

export const snapshots = sqliteTable('snapshots', {
  id: text('id').primaryKey(),
  chapterId: text('chapter_id').notNull().references(() => chapters.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  wordCount: integer('word_count').notNull(),
  label: text('label'),
  auto: integer('auto', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  chapterIdIdx: index('idx_snapshots_chapter_id').on(table.chapterId),
}));

// ---- AI 对话 ----

export const aiConversations = sqliteTable('ai_conversations', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  chapterId: text('chapter_id'),
  messages: text('messages'),         // JSON AIMessage[]
  context: text('context'),           // JSON AIContext
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  projectIdIdx: index('idx_ai_conversations_project_id').on(table.projectId),
}));

// ---- 文本标记 ----

export const textMarkers = sqliteTable('text_markers', {
  id: text('id').primaryKey(),
  chapterId: text('chapter_id').notNull().references(() => chapters.id, { onDelete: 'cascade' }),
  startOffset: integer('start_offset').notNull(),
  endOffset: integer('end_offset').notNull(),
  color: text('color').notNull(),
  label: text('label'),
}, (table) => ({
  chapterIdIdx: index('idx_text_markers_chapter_id').on(table.chapterId),
}));

// ---- 系列 ----

// 注意：series 数据量预期很小（每位作者通常仅维护少数系列），
// 此处索引主要用于按名称查找，避免全表扫描。
export const series = sqliteTable('series', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  projectIds: text('project_ids'),       // JSON 字符串数组
  sharedCharacterIds: text('shared_character_ids'), // JSON 字符串数组
  sharedLocationIds: text('shared_location_ids'),   // JSON 字符串数组
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  nameIdx: index('idx_series_name').on(table.name),
}));

// ============================================================
// Relations（Drizzle relations，用于查询时自动 join）
// ============================================================

export const usersRelations = relations(users, ({ many }) => ({
  projects: many(projects),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  user: one(users, { fields: [projects.userId], references: [users.id] }),
  chapters: many(chapters),
  characters: many(characters),
  items: many(items),
  creditTransactions: many(creditTransactions),
  locations: many(locations),
  events: many(storyEvents),
  foreshadows: many(foreshadows),
  earmarks: many(earmarks),
  outlineNodes: many(outlineNodes),
  notes: many(notes),
}));

export const chaptersRelations = relations(chapters, ({ one, many }) => ({
  project: one(projects, { fields: [chapters.projectId], references: [projects.id] }),
  annotations: many(annotations),
  snapshots: many(snapshots),
  markers: many(textMarkers),
}));

export const charactersRelations = relations(characters, ({ one }) => ({
  project: one(projects, { fields: [characters.projectId], references: [projects.id] }),
}));

export const itemsRelations = relations(items, ({ one }) => ({
  project: one(projects, { fields: [items.projectId], references: [projects.id] }),
}));

export const creditTransactionsRelations = relations(creditTransactions, ({ one }) => ({
  project: one(projects, { fields: [creditTransactions.projectId], references: [projects.id] }),
}));

export const locationsRelations = relations(locations, ({ one }) => ({
  project: one(projects, { fields: [locations.projectId], references: [projects.id] }),
}));

export const foreshadowsRelations = relations(foreshadows, ({ one }) => ({
  project: one(projects, { fields: [foreshadows.projectId], references: [projects.id] }),
}));

export const earmarksRelations = relations(earmarks, ({ one }) => ({
  project: one(projects, { fields: [earmarks.projectId], references: [projects.id] }),
  chapter: one(chapters, { fields: [earmarks.chapterId], references: [chapters.id] }),
  foreshadow: one(foreshadows, { fields: [earmarks.foreshadowId], references: [foreshadows.id] }),
}));

export const annotationsRelations = relations(annotations, ({ one }) => ({
  chapter: one(chapters, { fields: [annotations.chapterId], references: [chapters.id] }),
}));

// ---- 用户 AI 设置 ----

export const userSettings = sqliteTable('user_settings', {
  userId: text('user_id').primaryKey(),
  aiFeatures: text('ai_features', { mode: 'json' }).notNull().default('{}'),
  aiProviderConfig: text('ai_provider_config', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// ============================================================
// 分层记忆（docs/architecture/multi-agent-memory-architecture.md）
//
// 三张表对应架构里的三层关注点：
//   agent_memory   L2 智能体专属记忆（agent_id 必填 = 隔离的物理保证）
//   memory_audit   记忆访问审计（读 L1 / 被拒 / 写 L2 / 沉淀）
//   fact_conflicts 事实冲突队列（同槽位两值 → 不覆盖，等人裁）
// ============================================================

export const agentMemory = sqliteTable('agent_memory', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  /** ★ 隔离的物理保证：所有查询强制带它，句柄生成、不接受调用方拼 */
  agentId: text('agent_id').notNull(),
  /** 'fact_ref'（事实引用，存指针）| 'experience'（经历流，存原文） */
  form: text('form').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
  /** 事实式存 factId；叙事式存章号/发言 id —— 引用必须可回溯 */
  sourceRef: text('source_ref'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  uniqueKey: uniqueIndex('idx_agent_memory_unique').on(table.agentId, table.form, table.key),
  byAgent: index('idx_agent_memory_agent').on(table.agentId, table.form),
}));

export const memoryAudit = sqliteTable('memory_audit', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  agentId: text('agent_id').notNull(),
  /** 'read_l1' | 'deny_l1' | 'write_l2' | 'ingest' | 'conflict' */
  action: text('action').notNull(),
  /** JSON 数组：本次涉及的键 */
  keys: text('keys').notNull(),
  reason: text('reason'),
  allow: integer('allow', { mode: 'boolean' }).notNull(),
  detail: text('detail'),
  at: integer('at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  byTime: index('idx_memory_audit_at').on(table.projectId, table.at),
  byAgent: index('idx_memory_audit_agent').on(table.projectId, table.agentId, table.at),
}));

export const factConflicts = sqliteTable('fact_conflicts', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  /** 槽位，如 'characters/陈默/state' */
  slot: text('slot').notNull(),
  existingValue: text('existing_value'),
  incomingValue: text('incoming_value'),
  /** 来源（章号等），便于判断哪个更新 */
  source: text('source'),
  /** 'open' | 'resolved' */
  status: text('status').notNull(),
  /** 裁决留痕（JSON）：decision/chosenValue/resolver/needResink/at —— 只打标记等于没裁 */
  resolution: text('resolution'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
}, (table) => ({
  openOn: index('idx_fact_conflicts_open').on(table.projectId, table.status, table.createdAt),
}));

// ============================================================
// 集中式 Skills 库
//
// 口径（docs/architecture/skills-library.md）：
//   · 一处集中存放**所有**技能，智能体与各 agent 都从这里取自己那一类；
//   · 库**只支持安装与删除**（不提供编辑）—— 技能正文属于"装进来的东西"，
//     就地改会让库与技能来源脱节；
//   · 内部按两类分开存放：`category='assistant'`（智能体 skills）与
//     `category='agent'`（agent skills，带 owner_agent 指明归属哪个 agent）。
//
// ★ 2026-09-17 归属口径修订（作者）：**公共的才是全局，用户自己上传的是私有的**
//   · `user_id IS NULL` → 公共技能（内置 / 插件带），所有用户可见、可装可删
//   · `user_id = <uid>` → 该用户自己上传的，**只有本人可见**、只有本人能删
//
//   为什么 id 要带命名空间：`id` 是主键，两个用户各传一个同名技能会直接撞主键。
//   所以私有技能的 id 存成 `${userId}:${rawId}`（公共的保持原样）。
//   这个做法与 `agent_skill_toggles.id` 一致 —— 那份代码的注释写了理由：
//   「直接当主键，避免依赖复合唯一索引的实现差异」。
// ============================================================

export const skillLibrary = sqliteTable('skill_library', {
  /** 技能 id（沿用注册表里的 id，如 'worldbuilder'） */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  color: text('color').notNull().default('#94a3b8'),
  /** 前端图标 key（本地映射到 lucide 图标，后端不下发组件） */
  iconKey: text('icon_key').notNull().default('sparkles'),
  /**
   * ★ 分类存放（用户口径）：
   *   'assistant' = 智能体 skills（对话智能体本体用）
   *   'agent'     = agent skills（写作官等子智能体用，必须带 ownerAgent）
   */
  category: text('category').notNull(),
  /** category='agent' 时必填：归属的 agent id（与 DesignRole.key 对齐） */
  ownerAgent: text('owner_agent'),
  /** 技能正文（叠加到 system prompt 的专家指导） */
  systemPrompt: text('system_prompt').notNull().default(''),
  /** 需要前端注入的上下文类型（JSON 数组） */
  contextKeys: text('context_keys').notNull().default('[]'),
  /** 'builtin'（随产品带）/ 'installed'（用户装进来的） */
  source: text('source').notNull().default('installed'),
  /**
   * 归属用户。★ 2026-09-17 加：
   *   NULL  = 公共技能（内置 / 插件带），所有用户可见
   *   非空  = 该用户自己上传的私有技能，只有本人可见
   * 私有技能的 `id` 同时带 `${userId}:` 前缀，避免不同用户同名撞主键。
   */
  userId: text('user_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  byCategory: index('idx_skill_library_category').on(table.category, table.ownerAgent),
  /** 按归属过滤（`user_id IS NULL OR user_id = ?`）是每次读取的必经之路 */
  byUser: index('idx_skill_library_user').on(table.userId),
}));

/**
 * 每个智能体的技能开关（**按用户**存：同一台机器上不同用户各自配自己的）。
 *
 * 为什么单独一张表而不是往 skill_library 上加列：
 * 同一条技能可以同时属于多个智能体（例如"世界观顾问"给对话智能体一个、给策划官一个），
 * 开关是 (用户, 智能体, 技能) 三元组的属性，不是技能自身的属性。
 */
export const agentSkillToggles = sqliteTable('agent_skill_toggles', {
  /** `${userId}:${agentId}:${skillId}` —— 直接当主键，避免依赖复合唯一索引的实现差异 */
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  /** 智能体 id：'chat'（智能体本体）或 agent id（如 'writer'） */
  agentId: text('agent_id').notNull(),
  skillId: text('skill_id').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  uniqueToggle: uniqueIndex('idx_agent_skill_toggles_unique').on(table.userId, table.agentId, table.skillId),
  byAgent: index('idx_agent_skill_toggles_agent').on(table.userId, table.agentId),
}));

