// ============================================================
// 砚舟 - 数据库初始化 (Drizzle ORM + sql.js)
//
// sql.js 是纯 JavaScript/WebAssembly 实现的 SQLite，
// 无需原生编译，无需 Visual Studio Build Tools。
// 数据持久化到本地文件，浏览器环境下使用内存模式。
// ============================================================

import * as schema from './schema';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
// 静态导入 drizzle，确保 esbuild CJS 打包时能正确内联（动态 import 在 CJS 模式下不会被打包）
import { drizzle } from 'drizzle-orm/sql-js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { adapterManager, type DatabaseAdapter } from './adapter.js';

/** sql.js 初始化函数类型 */
type InitSqlJsFn = typeof import('sql.js').default;

/** Drizzle 数据库实例类型。
 *  注意：项目库实际使用 better-sqlite3 适配器，但其查询构造器 API
 *  （select/insert/update/delete）与 sql.js 一致，因此复用此类型做结构化约束。
 */
export type DrizzleDb = SQLJsDatabase<typeof schema>;

/** sql.js SQL 模块缓存 */
let _sqlModule: Awaited<ReturnType<InitSqlJsFn>> | null = null;

/** sql.js Database 实例 */
let _sqlite: import('sql.js').Database | null = null;

/** Drizzle ORM 包装实例 */
let _db: DrizzleDb | null = null;

/** 当前文件所在目录（兼容 ESM 和 CJS）
 * 不使用 __dirname 作为变量名，避免与 Node.js 全局 __dirname 冲突
 * CJS 模式下 __dirname 由 Node.js 提供，ESM 模式下从 import.meta.url 计算 */
let _moduleDir: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  _moduleDir = dirname(__filename);
} catch {
  _moduleDir = __dirname;
}

/**
 * 获取固定的数据库路径（绝对路径）
 * 固定在项目根目录下的 data/ 目录，避免相对路径导致的数据分散
 */
async function getDefaultDbPath(): Promise<string> {
  const fs = await import('fs');
  const path = await import('path');
  // 从 _moduleDir 向上查找项目根目录（以 pnpm-workspace.yaml 为标记）
  let dir = _moduleDir;
  while (true) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // 已到达磁盘根目录
    dir = parent;
  }
  return path.join(dir, 'data', 'novelmuse.db');
}

/** 数据库文件路径 */
let _dbPath = './novelmuse.db'; // 默认值，会在 initDatabase 中更新

/** 持久化防抖定时器，用于合并写入 */
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

/** 初始化保护锁，防止并发初始化导致连接泄漏 */
let _initPromise: Promise<DrizzleDb | null> | null = null;

/**
 * 是否在浏览器中运行。
 *
 * @novel/db 的 package.json exports.browser 字段会将前端打包工具的 import
 * 重定向到 ./src/browser.ts（stub），因此本文件理论上只在 Node.js 运行。
 * 此处保留检测作为防御性回退：若某些打包器不遵守 exports.browser 路由，
 * 仍能避免尝试加载 fs / sql.js 等 Node 专用模块。
 *
 * 不使用 typeof process === 'undefined' 检测：bundler（如 Vite）可能注入
 * process polyfill，导致浏览器环境误判为 Node。
 */
export const isBrowser =
  typeof globalThis !== 'undefined' &&
  typeof (globalThis as Record<string, unknown>).window !== 'undefined';

// ---- 文件系统辅助（Node.js only）----

let _fs: typeof import('fs') | null = null;
let _path: typeof import('path') | null = null;

async function getFs() {
  if (_fs) return _fs;
  if (isBrowser) {
    console.warn('[砚舟 DB] 浏览器环境下不支持文件持久化，使用内存模式。');
    return null;
  }
  try {
    _fs = await import('fs');
    return _fs;
  } catch {
    console.warn('[砚舟 DB] fs 模块不可用，使用内存模式。');
    return null;
  }
}

async function getPath() {
  if (_path) return _path;
  if (isBrowser) return null;
  try {
    _path = await import('path');
    return _path;
  } catch {
    console.warn('[砚舟 DB] path 模块不可用。');
    return null;
  }
}

// ---- sql.js 模块加载 ----

/**
 * 异步加载 sql.js WASM 模块（仅 Node.js 环境）。
 * 首次调用时初始化，后续直接返回缓存结果。
 * 浏览器环境下返回 null。
 */
async function loadSqlModule(): Promise<Awaited<ReturnType<InitSqlJsFn>> | null> {
  if (_sqlModule) return _sqlModule;
  if (isBrowser) return null;

  try {
    const sqlJsModule = await import('sql.js');
    const initSqlJs = sqlJsModule.default as InitSqlJsFn;
    _sqlModule = await initSqlJs();
    console.log('[砚舟 DB] sql.js WebAssembly 模块已加载。');
    return _sqlModule;
  } catch (e) {
    console.error('[砚舟 DB] sql.js 模块加载失败:', e);
    return null;
  }
}

// ---- 文件持久化 ----

/**
 * 从磁盘加载数据库文件并创建 sql.js Database 实例。
 */
async function loadDatabaseFromFile(path: string): Promise<import('sql.js').Database | null> {
  const SQL = await loadSqlModule();
  if (!SQL) return null;

  const fs = await getFs();
  if (!fs) return null;

  const backupPath = `${path}.bak`;

  if (fs.existsSync(path)) {
    console.log(`[砚舟 DB] 从文件加载数据库: ${path}`);
    try {
      const buffer = fs.readFileSync(path);
      if (buffer.length === 0) {
        // 空文件 - 可能被其他进程覆盖，尝试从备份恢复
        console.warn('[砚舟 DB] 数据库文件为空，尝试从备份恢复...');
        if (fs.existsSync(backupPath)) {
          const backupBuffer = fs.readFileSync(backupPath);
          if (backupBuffer.length > 0) {
            console.log('[砚舟 DB] 已从备份恢复');
            return new SQL.Database(backupBuffer);
          }
        }
        console.warn('[砚舟 DB] 备份不可用，创建新数据库');
        return new SQL.Database();
      }
      return new SQL.Database(buffer);
    } catch (e) {
      console.error('[砚舟 DB] 加载数据库失败，尝试从备份恢复:', e);
      if (fs.existsSync(backupPath)) {
        try {
          const backupBuffer = fs.readFileSync(backupPath);
          if (backupBuffer.length > 0) {
            console.log('[砚舟 DB] 已从备份恢复');
            return new SQL.Database(backupBuffer);
          }
        } catch (backupErr) {
          console.error('[砚舟 DB] 备份恢复失败:', backupErr);
        }
      }
      console.warn('[砚舟 DB] 无可用备份，创建空数据库');
      return new SQL.Database();
    }
  }

  console.log(`[砚舟 DB] 数据库文件不存在，创建新数据库: ${path}`);
  return new SQL.Database();
}

/**
 * 将数据库持久化到磁盘。
 * 使用 debounce 模式：多次调用合并为一次写入（200ms 防抖），确保最后的数据不丢失且减少磁盘写放大。
 *
 * @param force - 为 true 时立即写入并清空待处理的定时器
 */
async function persistToFile(force = false): Promise<void> {
  if (!_sqlite) return;
  if (isBrowser) return;

  const fs = await getFs();
  if (!fs) return;

  if (force) {
    // 强制写入：清除待处理的定时器，立即执行
    if (_persistTimer !== null) {
      clearTimeout(_persistTimer);
      _persistTimer = null;
    }
    await _doWrite();
    return;
  }

  // 防抖：如果已有定时器则跳过，否则 200ms 后写入
  if (_persistTimer !== null) return;
  _persistTimer = setTimeout(async () => {
    _persistTimer = null;
    await _doWrite();
  }, 200);
}

/**
 * 执行实际的磁盘写入操作，使用 openSync + writeSync + fsyncSync + closeSync
 * 确保数据真正落盘（防止操作系统缓存导致数据丢失）。
 */
async function _doWrite(): Promise<void> {
  if (!_sqlite) return;

  const fs = await getFs();
  if (!fs) return;

  const path = await getPath();
  if (!path) return;

  try {
    const data = _sqlite.export();
    const buffer = Buffer.from(data);
    const dir = path.dirname(_dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const backupPath = `${_dbPath}.bak`;

    // 先备份当前文件（如果存在且非空），防止新写入失败导致数据丢失
    try {
      if (fs.existsSync(_dbPath)) {
        const existing = fs.statSync(_dbPath);
        if (existing.size > 0) {
          fs.copyFileSync(_dbPath, backupPath);
        }
      }
    } catch {
      // 备份失败不阻断写入流程
    }

    // 写入临时文件，完成后原子性重命名，避免写入中途崩溃导致文件损坏
    const tmpPath = `${_dbPath}.tmp`;
    let fd: number | null = null;
    try {
      fd = fs.openSync(tmpPath, 'w');
      fs.writeSync(fd, buffer);
      fs.fsyncSync(fd);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* 忽略关闭错误 */ }
      }
    }

    // 原子性替换：rename 在同一文件系统上是原子的
    try {
      fs.renameSync(tmpPath, _dbPath);
    } catch {
      // rename 失败（Windows 上可能因为文件被占用），回退到直接写入
      try { fs.unlinkSync(tmpPath); } catch { /* 忽略 */ }
      fd = fs.openSync(_dbPath, 'w');
      try {
        fs.writeSync(fd, buffer);
        fs.fsyncSync(fd);
      } finally {
        try { fs.closeSync(fd); } catch { /* 忽略 */ }
      }
    }
  } catch (e) {
    console.error('[砚舟 DB] 数据库持久化失败:', e);
  }
}

// ---- 公共 API ----

/**
 * 内部：返回 sql.js 当前 Drizzle 实例。
 * 仅供 SqlJsAdapter 使用，避免与下方委托式的公共 getDb() 形成递归。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSqlJsDb(): DrizzleDb | null {
  return _db;
}

/**
 * 内联建表（迁移文件不可用时的回退方案）
 * 确保 sql.js 引擎在没有 drizzle SQL 文件时仍能正常启动
 * 与 schema.ts 保持表结构一致
 */
function bootstrapTables(): void {
  if (!_sqlite) return;
  console.log('[砚舟 DB] 使用内联建表（迁移文件不可用）');

  const statements = [
    // 用户
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`,

    // 用户设置
    `CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY NOT NULL,
      ai_features TEXT NOT NULL DEFAULT '{}',
      ai_provider_config TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,

    // 项目
    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      cover_image TEXT,
      pen_name TEXT,
      genre TEXT,
      target_word_count INTEGER,
      current_word_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)`,

    // 章节
    `CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      "order" INTEGER NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      label TEXT,
      pov TEXT,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chapters_project_id ON chapters(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_chapters_order ON chapters("order")`,

    // 角色
    `CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      aliases TEXT,
      thumbnail TEXT,
      color TEXT,
      role TEXT,
      desire TEXT,
      fear TEXT,
      belief TEXT,
      weakness TEXT,
      appearance TEXT,
      personality TEXT,
      backstory TEXT,
      speech_style TEXT,
      states TEXT,
      relations TEXT,
      chapters TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_characters_project_id ON characters(project_id)`,

    // 物品
    `CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT,
      description TEXT,
      thumbnail TEXT,
      color TEXT,
      credit_price REAL,
      states TEXT,
      holders TEXT,
      current_holders TEXT,
      relations TEXT,
      chapters TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_items_project_id ON items(project_id)`,

    // 系统积分流水（系统文：积分使用结余追踪）
    `CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      character_id TEXT,
      chapter INTEGER NOT NULL DEFAULT 1,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      reason TEXT,
      related_item_id TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_credit_transactions_project_id ON credit_transactions(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_credit_transactions_character_id ON credit_transactions(character_id)`,

    // 地点
    `CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      thumbnail TEXT,
      color TEXT,
      latitude REAL,
      longitude REAL,
      map_zoom INTEGER,
      world TEXT,
      states TEXT,
      chapters TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_locations_project_id ON locations(project_id)`,

    // 事件
    `CREATE TABLE IF NOT EXISTS story_events (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      chapter INTEGER NOT NULL,
      participants TEXT,
      related_items TEXT,
      related_locations TEXT,
      consequences TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_story_events_project_id ON story_events(project_id)`,

    // 伏笔
    `CREATE TABLE IF NOT EXISTS foreshadows (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      description TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planted',
      seed_chapter INTEGER NOT NULL,
      seed_text TEXT,
      seed_annotation_id TEXT,
      hints TEXT,
      payoff_chapter INTEGER,
      payoff_text TEXT,
      payoff_annotation_id TEXT,
      related_characters TEXT,
      related_items TEXT,
      related_events TEXT,
      earmarks TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_foreshadows_project_id ON foreshadows(project_id)`,

    // 书角标记
    `CREATE TABLE IF NOT EXISTS earmarks (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      type TEXT NOT NULL,
      foreshadow_id TEXT,
      description TEXT,
      outcome TEXT,
      probability REAL,
      related_characters TEXT,
      related_items TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON UPDATE NO ACTION ON DELETE CASCADE,
      FOREIGN KEY (foreshadow_id) REFERENCES foreshadows(id) ON UPDATE NO ACTION ON DELETE SET NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_earmarks_project_id ON earmarks(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_earmarks_chapter_id ON earmarks(chapter_id)`,

    // 标注
    `CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      type TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      selected_text TEXT NOT NULL,
      color TEXT,
      target_id TEXT,
      target_type TEXT,
      description TEXT,
      foreshadow_type TEXT,
      foreshadow_status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_annotations_project_id ON annotations(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_annotations_chapter_id ON annotations(chapter_id)`,

    // 大纲
    `CREATE TABLE IF NOT EXISTS outline_nodes (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      "order" INTEGER NOT NULL,
      linked_chapter_ids TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_outline_nodes_project_id ON outline_nodes(project_id)`,

    // 时间线
    `CREATE TABLE IF NOT EXISTS timeline_events (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      chapter INTEGER,
      timestamp TEXT,
      "order" INTEGER NOT NULL,
      character_ids TEXT,
      type TEXT NOT NULL,
      color TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_timeline_events_project_id ON timeline_events(project_id)`,

    // 笔记
    `CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL DEFAULT '',
      tags TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      linked_chapter_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE,
      FOREIGN KEY (linked_chapter_id) REFERENCES chapters(id) ON UPDATE NO ACTION ON DELETE SET NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notes_project_id ON notes(project_id)`,

    // 参考书
    `CREATE TABLE IF NOT EXISTS reference_books (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT,
      content TEXT NOT NULL DEFAULT '',
      chapters TEXT NOT NULL DEFAULT '[]',
      current_chapter INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_reference_books_project_id ON reference_books(project_id)`,

    // 写作统计
    `CREATE TABLE IF NOT EXISTS writing_stats (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      date TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      chapter_id TEXT,
      duration INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_writing_stats_project_id ON writing_stats(project_id)`,

    // 快照
    `CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      chapter_id TEXT NOT NULL,
      content TEXT NOT NULL,
      word_count INTEGER NOT NULL,
      label TEXT,
      auto INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_snapshots_chapter_id ON snapshots(chapter_id)`,

    // AI 对话
    `CREATE TABLE IF NOT EXISTS ai_conversations (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      chapter_id TEXT,
      messages TEXT,
      context TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ai_conversations_project_id ON ai_conversations(project_id)`,

    // 文本标记
    `CREATE TABLE IF NOT EXISTS text_markers (
      id TEXT PRIMARY KEY NOT NULL,
      chapter_id TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      color TEXT NOT NULL,
      label TEXT,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_text_markers_chapter_id ON text_markers(chapter_id)`,

    // 系列
    `CREATE TABLE IF NOT EXISTS series (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      project_ids TEXT,
      shared_character_ids TEXT,
      shared_location_ids TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_series_name ON series(name)`,

    // ★ 插件 KV（插件数据扩展 v1）：plugin_id + key + project_id 唯一
    `CREATE TABLE IF NOT EXISTS plugin_kv (
      id TEXT PRIMARY KEY NOT NULL,
      plugin_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      project_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_kv_unique ON plugin_kv(plugin_id, key, project_id)`,
  ];

  for (const sql of statements) {
    try {
      _sqlite.exec(sql);
    } catch (e) {
      console.warn(`[砚舟 DB] 内联建表语句跳过（可能已存在）: ${e}`);
    }
  }
  console.log('[砚舟 DB] ✅ 内联建表完成');
}

/**
 * 运行数据库迁移——读取 drizzle-kit 生成的 SQL 文件并逐条执行。
 * 仅在 Node.js 环境下有效（需要 fs 模块）。
 */
async function runMigrations(): Promise<void> {
  if (!_sqlite) return;

  const fs = await getFs();
  if (!fs) {
    console.warn('[砚舟 DB] 无法运行迁移：文件系统不可用。');
    return;
  }

  const path = await getPath();
  if (!path) {
    console.warn('[砚舟 DB] 无法运行迁移：path 模块不可用。');
    return;
  }

  // 创建迁移版本追踪表（如果不存在）
  _sqlite!.run(`
    CREATE TABLE IF NOT EXISTS __novelmuse_migrations (
      filename TEXT PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  // 查询已应用的迁移
  const appliedResult = _sqlite!.exec('SELECT filename FROM __novelmuse_migrations');
  const applied = new Set<string>();
  for (const row of appliedResult[0]?.values ?? []) {
    applied.add(row[0] as string);
  }

  // 查找迁移文件
  const migrationsDir = path.resolve(_moduleDir, '../drizzle');
  if (!fs.existsSync(migrationsDir)) {
    console.warn('[砚舟 DB] 迁移目录不存在:', migrationsDir);
    // 迁移目录缺失时使用内联建表兜底
    bootstrapTables();
    return;
  }

  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    bootstrapTables();
    return;
  }

  let skipped = 0;
  let executed = 0;

  for (const file of files) {
    if (applied.has(file)) {
      skipped++;
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    // 按 statement-breakpoint 分割逐条执行
    const statements = sql.split('--> statement-breakpoint');
    // 逐条执行，单条失败不影响其他语句（保证建表最终落地）
    let failed = false;
    try {
      for (const stmt of statements) {
        const trimmed = stmt.trim();
        if (!trimmed) continue;
        try {
          _sqlite!.run(trimmed);
        } catch (stmtErr) {
          console.warn(`[砚舟 DB] 迁移语句跳过（可能已存在）: ${String(stmtErr)}`);
          failed = true;
        }
      }
      // 记录已应用的迁移（即使部分语句跳过，仍标记为已应用）
      _sqlite!.run('INSERT OR IGNORE INTO __novelmuse_migrations (filename, applied_at) VALUES (?, ?)', [
        file,
        Date.now(),
      ]);
      if (failed) {
        console.warn(`[砚舟 DB] 已应用迁移 ${file}（部分语句跳过）`);
      } else {
        console.log(`[砚舟 DB] 已执行迁移: ${file}`);
      }
      executed++;
    } catch (e) {
      console.error(`[砚舟 DB] 迁移文件执行失败: ${file}`, e);
      // 任一迁移文件整体失败则放弃后续迁移，改用默认建表兜底
      console.warn('[砚舟 DB] 迁移中断，改为兜底建表以保证服务可用');
      break;
    }
  }

  if (skipped > 0) {
    console.log(`[砚舟 DB] 跳过 ${skipped} 个已应用的迁移文件。`);
  }
  if (executed === 0 && skipped > 0) {
    console.log('[砚舟 DB] 所有迁移已是最新的。');
  }
}

/**
 * 初始化数据库。异步方法，必须在应用启动时 await。
 * - 加载 sql.js Wasm 模块
 * - 从文件读取或创建数据库
 * - 启用 WAL / foreign_keys / busy_timeout
 * - 包装为 Drizzle ORM 实例
 *
 * 内置并发保护：多次并发调用返回同一个 Promise，防止连接泄漏。
 *
 * @param dbPath - SQLite 数据库文件路径，默认为 `data/novelmuse.db`（项目根目录下）
 */
export async function initSqlJs(dbPath?: string): Promise<DrizzleDb | null> {
  if (isBrowser) {
    console.warn('[砚舟 DB] 运行在浏览器环境，数据库不可用。数据将存储在内存中。');
    return null;
  }

  // 并发保护：如果已有初始化进行中，返回同一 Promise
  if (_initPromise) return _initPromise;
  if (_db) return _db;

  // 修复竞态：在任何 await 之前设置 _initPromise，防止并发调用重复初始化
  _initPromise = (async () => {
    _dbPath = dbPath ?? await getDefaultDbPath();
    return _doInit();
  })();

  try {
    return await _initPromise;
  } finally {
    _initPromise = null;
  }
}

/**
 * 实际执行数据库初始化的内部函数。
 * 被 initDatabase 通过 _initPromise 锁保护，确保不会并发初始化。
 */
async function _doInit(): Promise<DrizzleDb | null> {
  // 加载 sql.js Database
  _sqlite = await loadDatabaseFromFile(_dbPath);
  if (!_sqlite) return null;

  // PRAGMA 设置（sql.js 为内存数据库，WAL/synchronous 无效，仅保留有效项）
  _sqlite.run('PRAGMA foreign_keys=ON');
  _sqlite.run('PRAGMA busy_timeout=5000');

  // 加载 drizzle-orm/sql-js 适配器（使用顶部静态导入的 drizzle）
  try {
    _db = drizzle(_sqlite, { schema }) as DrizzleDb;
  } catch (e) {
    console.error('[砚舟 DB] drizzle-orm/sql-js 加载失败:', e);
    _sqlite.close();
    _sqlite = null;
    return null;
  }

  // 验证表是否存在
  try {
    _db.select().from(schema.projects).limit(1).all();
  } catch {
    // 表不存在，尝试自动运行迁移
    console.log('[砚舟 DB] 表未初始化，正在自动运行迁移...');
    try {
      await runMigrations();
      console.log('[砚舟 DB] 迁移执行成功。');
    } catch (migErr) {
      console.warn(
        '[砚舟 DB] 自动迁移失败。请手动运行 `drizzle-kit push` 来创建表。',
        migErr,
      );
    }
  }

  // 确保 users 表存在（迁移文件可能遗漏）
  try {
    _db.select().from(schema.users).limit(1).all();
  } catch {
    console.log('[砚舟 DB] users 表不存在，正在创建...');
    try {
      if (_sqlite) {
        _sqlite.run(`
          CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY NOT NULL,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            avatar TEXT,
            is_admin INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            last_login_at INTEGER,
            updated_at INTEGER NOT NULL
          )
        `);
        _sqlite.run(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);
        console.log('[砚舟 DB] users 表创建成功。');
      }
    } catch (userErr) {
      console.warn('[砚舟 DB] users 表创建失败', userErr);
    }
  }

  // 确保 users 表有 is_admin 列（迁移文件可能未包含该列）
  try {
    const userCols = _sqlite!.exec("PRAGMA table_info(users)");
    const hasIsAdmin = userCols[0]?.values.some((row: unknown[]) => row[1] === 'is_admin');
    if (!hasIsAdmin) {
      console.log('[砚舟 DB] users 表缺少 is_admin 列，正在添加...');
      _sqlite!.run('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
      console.log('[砚舟 DB] users.is_admin 列已添加。');
    }
  } catch (isAdminErr) {
    console.warn('[砚舟 DB] 检查 users.is_admin 列失败:', isAdminErr);
  }

  // 确保 projects 表有 user_id 列（数据隔离）
  try {
    const cols = _sqlite!.exec("PRAGMA table_info(projects)");
    const hasUserId = cols[0]?.values.some((row: unknown[]) => row[1] === 'user_id');
    if (!hasUserId) {
      console.log('[砚舟 DB] projects 表缺少 user_id 列，正在添加...');
      _sqlite!.run('ALTER TABLE projects ADD COLUMN user_id TEXT');
      // 为已有项目设置默认 user_id（取第一个用户）
      const firstUser = _sqlite!.exec('SELECT id FROM users LIMIT 1');
      if (firstUser[0]?.values[0]) {
        const defaultUserId = firstUser[0].values[0][0] as string;
        _sqlite!.run(`UPDATE projects SET user_id = ? WHERE user_id IS NULL OR user_id = ''`, [defaultUserId]);
        console.log(`[砚舟 DB] 已将已有项目关联到用户 ${defaultUserId}`);
      }
      _sqlite!.run('CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)');
      console.log('[砚舟 DB] projects.user_id 列添加成功。');
    }
  } catch (userIdErr) {
    console.warn('[砚舟 DB] 检查 projects.user_id 列失败', userIdErr);
  }

  // 确保 projects 表有 mode 列（创作模式：manual = 手写框架 / auto = AI 写作框架）
  // 旧库补列后为 NULL，读取侧统一按 'manual' 兜底，因此这里刻意不回填数据。
  try {
    const cols = _sqlite!.exec("PRAGMA table_info(projects)");
    const hasMode = cols[0]?.values.some((row: unknown[]) => row[1] === 'mode');
    if (!hasMode) {
      console.log('[砚舟 DB] projects 表缺少 mode 列，正在添加...');
      _sqlite!.run('ALTER TABLE projects ADD COLUMN mode TEXT');
      console.log('[砚舟 DB] projects.mode 列添加成功。');
    }
  } catch (modeErr) {
    console.warn('[砚舟 DB] 检查 projects.mode 列失败', modeErr);
  }

  // 确保 projects 表有 brief 列（AI 写作的开书设定，JSON 文本）。
  // 与 mode 同理：旧库补列后为 NULL，读取侧按「没有设定」兜底，不回填数据。
  try {
    const cols = _sqlite!.exec("PRAGMA table_info(projects)");
    const hasBrief = cols[0]?.values.some((row: unknown[]) => row[1] === 'brief');
    if (!hasBrief) {
      console.log('[砚舟 DB] projects 表缺少 brief 列，正在添加...');
      _sqlite!.run('ALTER TABLE projects ADD COLUMN brief TEXT');
      console.log('[砚舟 DB] projects.brief 列添加成功。');
    }
  } catch (briefErr) {
    console.warn('[砚舟 DB] 检查 projects.brief 列失败', briefErr);
  }

  // 确保 user_settings 表存在（迁移文件可能遗漏）
  try {
    _db.select().from(schema.userSettings).limit(1).all();
  } catch {
    console.log('[砚舟 DB] user_settings 表不存在，正在创建...');
    try {
      if (_sqlite) {
        _sqlite.run(`
          CREATE TABLE IF NOT EXISTS user_settings (
            user_id TEXT PRIMARY KEY NOT NULL,
            ai_features TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL,
              ai_provider_config TEXT,
            updated_at INTEGER NOT NULL
          )
        `);
        console.log('[砚舟 DB] user_settings 表创建成功。');
      }
    } catch (settingsErr) {
      console.warn('[砚舟 DB] user_settings 表创建失败:', settingsErr);
    }
  }

    // 迁移：为已有 user_settings 表添加 ai_provider_config 列
    try {
      _sqlite!.run("ALTER TABLE user_settings ADD COLUMN ai_provider_config TEXT");
      console.log("[砚舟 DB] user_settings.ai_provider_config 列已添加。");
    } catch {
      // 列已存在，忽略
    }

  // chapters.deleted_at 列（软删除 / 回收站）
  try {
    const chapCols = _sqlite!.exec("PRAGMA table_info(chapters)");
    const hasDeletedAt = chapCols[0]?.values.some((row: unknown[]) => row[1] === 'deleted_at');
    if (!hasDeletedAt) {
      console.log('[砚舟 DB] chapters 缺少 deleted_at 列，正在添加...');
      _sqlite!.run('ALTER TABLE chapters ADD COLUMN deleted_at INTEGER');
      console.log('[砚舟 DB] chapters.deleted_at 列添加成功。');
    }
    _sqlite!.run('CREATE INDEX IF NOT EXISTS idx_chapters_deleted_at ON chapters(deleted_at)');
  } catch (chapColErr) {
    console.warn('[砚舟 DB] 检查 chapters.deleted_at 列失败', chapColErr);
  }

  // reference_books 表（参考书持久化）
  try {
    _db.select().from(schema.referenceBooks).limit(1).all();
  } catch {
    console.log('[砚舟 DB] reference_books 表不存在，正在创建...');
    try {
      if (_sqlite) {
        _sqlite.run(`
          CREATE TABLE IF NOT EXISTS reference_books (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL,
            title TEXT NOT NULL,
            author TEXT,
            content TEXT NOT NULL DEFAULT '',
            chapters TEXT NOT NULL DEFAULT '[]',
            current_chapter INTEGER NOT NULL DEFAULT 0,
            source TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
          )
        `);
        _sqlite.run(`CREATE INDEX IF NOT EXISTS idx_reference_books_project_id ON reference_books(project_id)`);
        console.log('[砚舟 DB] reference_books 表创建成功。');
      }
    } catch (refErr) {
      console.warn('[砚舟 DB] reference_books 表创建失败:', refErr);
    }
  }

  // 确保 items 表有 current_holders 列（装备系统：当前持有者）
  try {
    const itemCols = _sqlite!.exec("PRAGMA table_info(items)");
    const hasCurrentHolders = itemCols[0]?.values.some((row: unknown[]) => row[1] === 'current_holders');
    if (!hasCurrentHolders) {
      console.log('[砚舟 DB] items 表缺少 current_holders 列，正在添加...');
      _sqlite!.run('ALTER TABLE items ADD COLUMN current_holders TEXT');

      // 数据迁移：从 holders 流转记录推导填充 currentHolders
      // 规则：按 chapter 升序遍历，最后一次动作是 gained/transferred 的角色视为当前持有者
      const allItems = _sqlite!.exec("SELECT id, holders FROM items");
      for (const row of allItems[0]?.values ?? []) {
        const id = row[0] as string;
        const holdersJson = row[1] as string | null;
        const currentHolders: string[] = [];
        if (holdersJson) {
          try {
            const holders = JSON.parse(holdersJson) as Array<{
              characterId: string; chapter: number; action: string;
            }>;
            const lastAction = new Map<string, string>();
            for (const h of [...holders].sort((a, b) => a.chapter - b.chapter)) {
              lastAction.set(h.characterId, h.action);
            }
            for (const [cid, action] of lastAction) {
              if (action === 'gained' || action === 'transferred') currentHolders.push(cid);
            }
          } catch (e) {
            console.warn(`[砚舟 DB] 物品 ${id} 的 holders 解析失败，已置空`, e);
          }
        }
        _sqlite!.run('UPDATE items SET current_holders = ? WHERE id = ?', [JSON.stringify(currentHolders), id]);
      }
      console.log('[砚舟 DB] items.current_holders 列添加并迁移成功。');
    }
  } catch (itemColErr) {
    console.warn('[砚舟 DB] 检查 items.current_holders 列失败', itemColErr);
  }

  // 确保 items 表有 relations 列（物品间关系：配对 / 包含 / 部件 / 对立 / 变形）
  try {
    const itemCols2 = _sqlite!.exec("PRAGMA table_info(items)");
    const hasRelations = itemCols2[0]?.values.some((row: unknown[]) => row[1] === 'relations');
    if (!hasRelations) {
      console.log('[砚舟 DB] items 表缺少 relations 列，正在添加...');
      _sqlite!.run('ALTER TABLE items ADD COLUMN relations TEXT');
      // 历史数据：默认空数组
      const allItems = _sqlite!.exec("SELECT id FROM items");
      for (const row of allItems[0]?.values ?? []) {
        const id = row[0] as string;
        _sqlite!.run('UPDATE items SET relations = ? WHERE id = ?', [JSON.stringify([]), id]);
      }
      console.log('[砚舟 DB] items.relations 列添加并初始化完成。');
    }
  } catch (itemRelationsErr) {
    console.warn('[砚舟 DB] 检查 items.relations 列失败', itemRelationsErr);
  }

  // 确保 items 表有 credit_price 列（系统文：积分定价）
  try {
    const itemCols3 = _sqlite!.exec("PRAGMA table_info(items)");
    const hasCreditPrice = itemCols3[0]?.values.some((row: unknown[]) => row[1] === 'credit_price');
    if (!hasCreditPrice) {
      console.log('[砚舟 DB] items 表缺少 credit_price 列，正在添加...');
      _sqlite!.run('ALTER TABLE items ADD COLUMN credit_price REAL');
      console.log('[砚舟 DB] items.credit_price 列添加成功。');
    }
  } catch (itemCreditPriceErr) {
    console.warn('[砚舟 DB] 检查 items.credit_price 列失败', itemCreditPriceErr);
  }

  // 确保 characters 表有 role 列（角色定位：主角 / 配角 / 路人甲）
  // 历史数据：默认 NULL（前端未设置时按 路人甲/minor 处理，无需回填）
  try {
    const charCols = _sqlite!.exec("PRAGMA table_info(characters)");
    const hasRole = charCols[0]?.values.some((row: unknown[]) => row[1] === 'role');
    if (!hasRole) {
      console.log('[砚舟 DB] characters 表缺少 role 列，正在添加...');
      _sqlite!.run('ALTER TABLE characters ADD COLUMN role TEXT');
      console.log('[砚舟 DB] characters.role 列添加成功。');
    }
  } catch (charRoleErr) {
    console.warn('[砚舟 DB] 检查 characters.role 列失败', charRoleErr);
  }

  // 确保 locations 表有 world 列（多世界/穿越小说支持）
  // 历史数据：默认 NULL（单世界，地图坐标按章节分组）
  try {
    const locCols = _sqlite!.exec("PRAGMA table_info(locations)");
    const hasWorld = locCols[0]?.values.some((row: unknown[]) => row[1] === 'world');
    if (!hasWorld) {
      console.log('[砚舟 DB] locations 表缺少 world 列，正在添加...');
      _sqlite!.run('ALTER TABLE locations ADD COLUMN world TEXT');
      console.log('[砚舟 DB] locations.world 列添加成功。');
    }
  } catch (locWorldErr) {
    console.warn('[砚舟 DB] 检查 locations.world 列失败', locWorldErr);
  }

  // 确保 writing_stats 表有 created_at / updated_at 列
  // 历史数据：列缺失时 ALTER TABLE 添加，旧行回填为 0（service 层 toNumber 已兜底）
  try {
    const wsCols = _sqlite!.exec("PRAGMA table_info(writing_stats)");
    const hasCreatedAt = wsCols[0]?.values.some((row: unknown[]) => row[1] === 'created_at');
    const hasUpdatedAt = wsCols[0]?.values.some((row: unknown[]) => row[1] === 'updated_at');
    if (!hasCreatedAt) {
      console.log('[砚舟 DB] writing_stats 表缺少 created_at 列，正在添加...');
      _sqlite!.run('ALTER TABLE writing_stats ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasUpdatedAt) {
      console.log('[砚舟 DB] writing_stats 表缺少 updated_at 列，正在添加...');
      _sqlite!.run('ALTER TABLE writing_stats ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
    }
  } catch (wsColErr) {
    console.warn('[砚舟 DB] 检查 writing_stats 列失败:', wsColErr);
  }

  // 确保 snapshots 表有 updated_at 列
  // 历史数据：列缺失时 ALTER TABLE 添加，旧行用 created_at 回填（保留创建时间作为更新时间）
  try {
    const snapCols = _sqlite!.exec("PRAGMA table_info(snapshots)");
    const hasUpdatedAt = snapCols[0]?.values.some((row: unknown[]) => row[1] === 'updated_at');
    if (!hasUpdatedAt) {
      console.log('[砚舟 DB] snapshots 表缺少 updated_at 列，正在添加并用 created_at 回填...');
      _sqlite!.run('ALTER TABLE snapshots ADD COLUMN updated_at INTEGER');
      // 用 created_at 回填，确保现有快照有合理的 updatedAt
      _sqlite!.run('UPDATE snapshots SET updated_at = created_at WHERE updated_at IS NULL');
    }
  } catch (snapColErr) {
    console.warn('[砚舟 DB] 检查 snapshots.updated_at 列失败:', snapColErr);
  }

  // ---- 复合索引（性能优化：覆盖项目内按次序排列查询、章节内偏移查询、日期范围统计）----
  // 用 IF NOT EXISTS 保护，重复执行安全。
  try {
    const COMPOSITE_INDEXES: Array<{ name: string; table: string; cols: string }> = [
      // 项目内按 order 排章节（章节列表 / 大纲对齐）
      { name: 'idx_chapters_project_order', table: 'chapters', cols: '(project_id, "order")' },
      // 章节内按 offset 排标注（编辑器选区 -> 标注查询）
      { name: 'idx_annotations_chapter_offset', table: 'annotations', cols: '(chapter_id, start_offset)' },
      // 最近快照（恢复 / 历史）
      { name: 'idx_snapshots_chapter_created', table: 'snapshots', cols: '(chapter_id, created_at DESC)' },
      // 按日期拉写作统计（连续打卡 / 日历年视图）
      { name: 'idx_writing_stats_project_date', table: 'writing_stats', cols: '(project_id, date)' },
      // 大纲树（按 parent_id 找子节点）
      { name: 'idx_outline_nodes_project_parent', table: 'outline_nodes', cols: '(project_id, parent_id)' },
      // 最近对话（聊天列表）
      { name: 'idx_ai_conversations_project_updated', table: 'ai_conversations', cols: '(project_id, updated_at DESC)' },
      // 章节标签查询
      { name: 'idx_earmarks_chapter_type', table: 'earmarks', cols: '(chapter_id, type)' },
      // 时间线事件按章查询
      { name: 'idx_timeline_events_project_chapter', table: 'timeline_events', cols: '(project_id, chapter)' },
    ];
    for (const ix of COMPOSITE_INDEXES) {
      try {
        _sqlite!.run(`CREATE INDEX IF NOT EXISTS ${ix.name} ON ${ix.table} ${ix.cols}`);
      } catch (ixErr) {
        console.warn(`[砚舟 DB] 创建复合索引 ${ix.name} 失败:`, ixErr);
      }
    }
    console.log(`[砚舟 DB] 已确保 ${COMPOSITE_INDEXES.length} 个复合索引存在。`);
  } catch (idxErr) {
    console.warn('[砚舟 DB] 复合索引创建阶段失败（非致命）:', idxErr);
  }

  // 迁移可能修改了表结构（ALTER TABLE ADD COLUMN），强制立即落盘
  // 防止重启后磁盘文件仍缺列、迁移反复执行的问题
  try {
    await persistToFile(true);
  } catch (persistErr) {
    console.warn('[砚舟 DB] 迁移后强制落盘失败（非致命）:', persistErr);
  }

  console.log('[砚舟 DB] 数据库初始化完成。');
  return _db;
}

/**
 * 使用自定义路径创建独立的数据库客户端（不缓存、不影响全局实例）。
 * 适用于测试或导入多数据库场景。
 *
 * @param dbPath - 数据库文件路径
 */
export async function createDbClient(
  dbPath: string,
): Promise<{ db: DrizzleDb; sqlite: import('sql.js').Database } | null> {
  if (isBrowser) return null;

  const SQL = await loadSqlModule();
  if (!SQL) return null;

  const fs = await getFs();
  let sqlite: import('sql.js').Database;
  if (fs?.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    sqlite = new SQL.Database(buffer);
  } else {
    sqlite = new SQL.Database();
  }

  sqlite.run('PRAGMA foreign_keys=ON');
  sqlite.run('PRAGMA busy_timeout=5000');

  try {
    const db = drizzle(sqlite, { schema }) as DrizzleDb;
    return { db, sqlite };
  } catch {
    sqlite.close();
    return null;
  }
}

/**
 * 关闭数据库，并将数据持久化到磁盘。
 */
let _closePromise: Promise<void> | null = null;

export async function closeSqlJs(): Promise<void> {
  // 并发保护：如果已有 close 进行中，复用同一个 Promise
  // 防止 DB 包和 server 的处理器并发调用导致 _sqlite.close() 两次
  if (_closePromise) return _closePromise;
  if (!_sqlite) return;

  _closePromise = (async () => {
    try {
      await persistToFile(true); // 强制立即写入
      _sqlite?.close();
    } catch (e) {
      console.error('[砚舟 DB] 关闭时持久化失败:', e);
    } finally {
      _sqlite = null;
      _db = null;
      _closePromise = null; // 修复：重置 promise，允许重新初始化后再次关闭
    }
  })();
  return _closePromise;
}

// 注册进程退出钩子，确保应用被 kill 时数据库正确关闭并持久化
// 注意：DB 包不再注册 SIGINT/SIGTERM 处理器。
// 原实现中 closeDatabase() 是 async 但处理器立即 process.exit(0)，
// 导致 persistToFile 的磁盘写入微任务永远不执行，未落盘数据丢失。
// 关闭职责完全由消费方（server）负责：await closeDatabase() 后再 exit。
// 独立使用 DB 包的场景，调用方必须自行注册信号处理器并 await closeDatabase()。

/**
 * 默认使用 debounce 模式（200ms 合并写入），避免高频写入造成磁盘 I/O 瓶颈。
 *
 * @param force - true 时立即写入并清空待处理的定时器；false 时走 debounce。
 *                 批量操作场景应使用默认值 false，关键节点（如登录、创建管理员）
 *                 可显式传 true。
 */
/** 内部：sql.js 持久化（仅供 SqlJsAdapter 使用，避免与公共 saveToDisk 委托形成递归） */
export async function persistSqlJs(force = false): Promise<void> {
  await persistToFile(force);
}

// ---- 导出 ----
export { schema };
export { eq, and, or, ne, isNull, isNotNull, inArray, notInArray, like, ilike, gte, gt, lte, lt, desc, asc, sql } from 'drizzle-orm';
export default getDb;

// ---- 持久化适配器注册（本地优先：默认 sql.js）----
// 把现有 sql.js 实现收口为 DatabaseAdapter。公共 API（initDatabase/getDb/
// saveToDisk/closeDatabase）统一委托给 adapterManager.activeAdapter，
// 因此未来切 better-sqlite3 / 服务端 DB 时，业务层（BaseService / 各 router）
// 无需改动，只需 register 新适配器并 setActive。

/** sql.js 适配器：直接委托本模块原有的 sql.js 实现 */
export const sqlJsAdapter: DatabaseAdapter = {
  engine: 'sqljs',
  init: (dbPath) => initSqlJs(dbPath),
  getDb: () => getSqlJsDb(),
  persist: (force) => persistSqlJs(force),
  close: () => closeSqlJs(),
  isReady: () => !!getSqlJsDb(),
};

adapterManager.register(sqlJsAdapter);
adapterManager.setActive('sqljs');

// ---- 引擎选择 ----
// 默认启用 better-sqlite3（WAL 增量写入，原生性能，消除 sql.js 整库 export 写放大）。
// 设置 NOVELMUSE_DB_ENGINE=sqljs 可显式回退到 sql.js（WASM，无需编译）。
// better-sqlite3 未安装或初始化失败时自动回退 sql.js，不阻断启动。
let engineResolved = false;

async function ensureEngineSelected(): Promise<void> {
  if (engineResolved) return;
  engineResolved = true;

  // 显式回退到 sql.js
  if (process.env.NOVELMUSE_DB_ENGINE === 'sqljs') {
    console.log('[DB] 使用 sql.js 引擎（NOVELMUSE_DB_ENGINE=sqljs）');
    return;
  }

  try {
    const mod = await import('./better-sqlite3-adapter.js');
    const adapter = mod.createBetterSqliteAdapter();
    adapterManager.register(adapter);
    adapterManager.setActive('better-sqlite3');
    console.log('[DB] 已切换到 better-sqlite3 引擎（WAL 增量写入）');
  } catch (e) {
    console.warn(
      '[DB] better-sqlite3 引擎启用失败（需先安装 better-sqlite3），回退 sql.js：',
      (e as Error)?.message ?? String(e),
    );
  }
}

// ---- 公共 API：统一委托给当前活动适配器 ----
// 这样所有调用方（BaseService / router）无需感知具体引擎。

export async function initDatabase(dbPath?: string): Promise<unknown | null> {
  await ensureEngineSelected();
  return adapterManager.activeAdapter.init(dbPath);
}

export function getDb(): DrizzleDb | null {
  return adapterManager.activeAdapter.getDb() as DrizzleDb | null;
}

export async function saveToDisk(force = false): Promise<void> {
  await adapterManager.activeAdapter.persist(force);
}

export async function closeDatabase(): Promise<void> {
  await adapterManager.activeAdapter.close();
}

/**
 * 获取主库底层 sqlite 实例（better-sqlite3 的 Database）。
 * 仅在 better-sqlite3 引擎下可用；sql.js 引擎下返回 null。
 * 用于数据迁移脚本等需要原生 SQLite API 的场景。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getMainSqlite(): any {
  const adapter = adapterManager.activeAdapter;
  if (adapter.engine !== 'better-sqlite3') return null;
  return adapter.getRawSqlite?.() ?? null;
}

// ---- 项目库 API（每本书独立数据库文件）----
// 见 project-db.ts 完整文档。这里 re-export 以便 server 端统一从 @novel/db 导入。
export {
  initProjectDb,
  getProjectDb,
  getProjectDbSync,
  getProjectDbPath,
  PROJECT_ID_PATTERN,
  isValidProjectId,
  assertValidProjectId,
  persistProjectDb,
  closeProjectDb,
  closeAllProjectDbs,
  deleteProjectDb,
  getOpenProjectDbCount,
  onProjectDbInit,
  listOpenProjectDbs,
  getProjectSqliteRaw,
} from './project-db.js';

// ---- 主库 → 项目库 数据迁移 ----
export { migrateToProjectDbs, needsMigration } from './migrate-to-project-dbs.js';
