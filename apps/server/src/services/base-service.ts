// ============================================================
// 泛型 Service 基类
// 从 databaseService.ts 迁移的工厂模式
// 接收 Drizzle 表定义，提供 loadAll/save/update/delete 方法
//
// 支持两种作用域：
// - scope: 'global'（默认）：使用主库 getDb()，写入后调用 saveToDisk 落盘
// - scope: 'project'：使用项目库 getProjectDbSync(projectId)，better-sqlite3 增量写入，无需 saveToDisk
// ============================================================

import { getDb, getProjectDbSync, eq, saveToDisk } from '@novel/db';
import { v4 as uuidv4 } from 'uuid';

type RawRow = Record<string, unknown>;

/**
 * 解析实体主键：空字符串 / 纯空白 / null / undefined 一律视为「未提供」，生成新 UUID。
 *
 * ★ 2026-11-13 修复：AI 工具会传 `id: ''`，而各 service 里写的是
 *   `data.id ?? uuidv4()` —— `??` 只挡 null/undefined，空字符串会原样成为主键。
 *   第一次插入 id='' 成功，第二次就报 `UNIQUE constraint failed: characters.id`。
 *   把判断收口到这里，所有实体（角色/物品/地点/伏笔…）与后续新增服务都自动受益。
 */
export function resolveEntityId(id: unknown): string {
  if (typeof id === 'string') {
    const trimmed = id.trim();
    if (trimmed) return trimmed;
  }
  return uuidv4();
}

/** Drizzle 返回行原始类型，含时间戳转换 */
export function toNumber(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

/** 解析 JSON 字段 */
export function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return (v as T) ?? fallback;
}

/** 序列化 JSON 字段（与 parseJson 配对，统一 JSON 列的读写收口） */
export function jsonStringify(v: unknown): string {
  return JSON.stringify(v);
}

/** 将 Date → number 转换应用到 createdAt/updatedAt/deletedAt 字段 */
export function normalizeTimestamps<T>(row: RawRow): T {
  if (row.createdAt !== undefined) row.createdAt = toNumber(row.createdAt);
  if (row.updatedAt !== undefined) row.updatedAt = toNumber(row.updatedAt);
  if (row.deletedAt !== undefined && row.deletedAt !== null) row.deletedAt = toNumber(row.deletedAt);
  return row as unknown as T;
}

/** 将 JS 实体中的 number timestamp 转为 Date 供 Drizzle 插入 */
export function toDbTimestamps(data: Record<string, unknown>): void {
  if (typeof data.createdAt === 'number') data.createdAt = new Date(data.createdAt as number);
  if (typeof data.updatedAt === 'number') data.updatedAt = new Date(data.updatedAt as number);
  if (typeof data.deletedAt === 'number') data.deletedAt = new Date(data.deletedAt as number);
}

export interface EntityServiceConfig<T extends { id: string; createdAt: number; updatedAt: number }> {
  rowToModel: (row: RawRow) => T;
  modelToRow: (model: T) => Record<string, unknown>;
  jsonFields?: string[];
  loadByColumn?: string;
  entityLabel: string;
  /** 作用域：'global' 用主库；'project' 用项目库（每本书独立 .db） */
  scope?: 'global' | 'project';
}

/**
 * 泛型 CRUD Service 基类。
 * 封装 Drizzle ORM 的常见读写操作，子类只需提供表定义和模型转换函数。
 *
 * 注意：table 参数使用 `any` 类型是合理的——Drizzle 的 sqliteTable() 返回值
 * 没有统一的基类或 index signature，无法用 TypeScript 的结构类型或接口约束。
 * 实际类型安全由子类的 rowToModel/modelToRow 转换函数保证。
 */
export class BaseService<T extends { id: string; createdAt: number; updatedAt: number }> {

  // Drizzle sqliteTable() 返回值无统一基类/索引签名，无法用结构化类型约束；
  // 实际类型安全由子类的 rowToModel/modelToRow 保证。下游 query/rows 的 any 均源于此。
  private table: any;
  private rowToModel: (row: RawRow) => T;
  private modelToRow: (model: T) => Record<string, unknown>;
  private jsonFields: string[];
  private loadByColumn: string | undefined;
  private entityLabel: string;
  private scope: 'global' | 'project';

  constructor(table: any, config: EntityServiceConfig<T>) {
    this.table = table;
    this.rowToModel = config.rowToModel;
    this.modelToRow = config.modelToRow;
    this.jsonFields = config.jsonFields ?? [];
    this.loadByColumn = config.loadByColumn;
    this.entityLabel = config.entityLabel;
    this.scope = config.scope ?? 'global';
  }

  /**
   * 获取数据库实例。
   * - scope='global'：返回主库 getDb()
   * - scope='project'：返回 getProjectDbSync(projectId)；未初始化抛错
   *
   * 项目级 service 要求调用方传入 projectId（由 router 从 URL/header 提取并 init）。
   */
  private requireDb(projectId?: string) {
    if (this.scope === 'project') {
      if (!projectId) {
        throw new Error(`[${this.entityLabel}] 项目级 service 缺少 projectId`);
      }
      const db = getProjectDbSync(projectId);
      if (!db) {
        throw new Error(`[${this.entityLabel}] 项目库未初始化: ${projectId}`);
      }
      return db;
    }
    const db = getDb();
    if (!db) throw new Error(`[${this.entityLabel}] 数据库不可用`);
    return db;
  }

  /** scope='project' 时跳过 saveToDisk（better-sqlite3 增量写入，无需手动落盘） */
  private async maybePersist(): Promise<void> {
    if (this.scope === 'global') {
      await saveToDisk();
    }
  }

  async loadAll(filterValue: string | undefined, projectId?: string): Promise<T[]> {
    const db = this.requireDb(projectId);
    const rows = (
      this.loadByColumn != null && filterValue != null && filterValue !== ''
        ? db.select().from(this.table).where(eq(this.table[this.loadByColumn], filterValue))
        : db.select().from(this.table)
    ).all() as T[];
    return rows.map((r) => this.rowToModel(r as unknown as RawRow));
  }

  async getById(id: string, projectId?: string): Promise<T | null> {
    const db = this.requireDb(projectId);
    const row = db.select().from(this.table).where(eq(this.table.id, id)).get() as RawRow | undefined;
    return row ? this.rowToModel(row) : null;
  }

  async save(entity: T, upsert = false, projectId?: string): Promise<void> {
    const db = this.requireDb(projectId);

    // ★ 主键兜底：空字符串不是合法 id（见 resolveEntityId 注释）。
    //   在序列化前修正，调用方拿到的仍是同一个对象引用，返回的 id 也是新生成的。
    entity.id = resolveEntityId(entity.id);

    const row = this.modelToRow(entity);
    if (upsert) {
      // 冲突时只更新业务字段，保留 id 和 createdAt 不变
      const updateFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k !== 'id' && k !== 'createdAt') updateFields[k] = v;
      }
      db.insert(this.table).values(row).onConflictDoUpdate({
        target: this.table.id,
        set: updateFields,
      }).run();
    } else {
      db.insert(this.table).values(row).run();
    }
    await this.maybePersist();
  }

  async update(id: string, updates: Partial<T>, projectId?: string): Promise<void> {
    const db = this.requireDb(projectId);

    const setData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'id') continue;
      if (value !== undefined) {
        // ★ 时间列（drizzle `mode: 'timestamp'`，如 createdAt/updatedAt/deletedAt）只接受 Date：
        //   调用方把 rowToModel 产物（毫秒数字）整体回传时 —— 角色合并正是如此
        //   （characters.ts 把 mergeTwoCharacters 的完整 Character 交给 updateCharacter）——
        //   drizzle 的 mapToDriverValue 会在 value.getTime() 上抛 TypeError → 500。
        //   按列元数据统一归一化，比逐字段特判更抗未来新增时间列。
        const col = this.table[key] as { columnType?: string } | undefined;
        if (typeof value === 'number' && !Number.isNaN(value) && col?.columnType === 'SQLiteTimestamp') {
          setData[key] = new Date(value);
        } else {
          setData[key] = this.jsonFields.includes(key) ? jsonStringify(value) : value;
        }
      }
    }
    db.update(this.table).set(setData).where(eq(this.table.id, id)).run();
    await this.maybePersist();
  }

  async delete(id: string, projectId?: string): Promise<void> {
    const db = this.requireDb(projectId);

    db.delete(this.table).where(eq(this.table.id, id)).run();
    await this.maybePersist();
  }

  /**
   * 安全查询——数据库不可用时返回空数组而非抛出异常。
   * 适用于列表页等可降级展示的场景。
   */
  async loadAllSafe(filterValue: string | undefined, projectId?: string): Promise<T[]> {
    try {
      return await this.loadAll(filterValue, projectId);
    } catch (e) {
      console.error(`[${this.entityLabel}] loadAll 失败`, e);
      return [];
    }
  }
}
