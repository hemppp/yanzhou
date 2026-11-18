// ============================================================
// better-sqlite3 持久化适配器
//
// 基于原生 SQLite，支持 WAL（预写日志）+ 增量页写入，
// 消除 sql.js 的"整库 export 重写"写放大。
//
// 设计要点：
// - 动态导入 better-sqlite3 / drizzle-orm/better-sqlite3，使用「变量形式的 specifier」
//   以避免 TypeScript 在编译期静态解析缺失模块（未安装时仍能 tsc 通过）。
// - 迁移复用 packages/db/drizzle 下的 SQL 文件（与 sql.js 同源），保证 schema 一致。
// - 补充与 sql.js 等价的 ALTER TABLE 兼容性迁移，保证旧库可平滑升级。
// ============================================================

import type { DatabaseAdapter } from './adapter.js';
import * as schema from './schema.js';

// 用变量形式持有模块名（显式标注为 string，而非字面量类型），
// 避免 TypeScript 在编译期静态解析缺失模块而报错（未安装时仍能 tsc 通过）。
const BETTER_SQLITE3: string = 'better-sqlite3';
const DRIZZLE_BETTER_SQLITE3: string = 'drizzle-orm/better-sqlite3';

/** 解析默认数据库路径（与 sql.js 同源：项目根 data/novelmuse.db） */
async function resolveDefaultDbPath(): Promise<string> {
  const fs = await import('fs');
  const path = await import('path');
  // 不使用 __dirname 作为变量名，避免与 Node.js 全局冲突
  let _moduleDir: string;
  try {
    const { fileURLToPath } = await import('url');
    const __filename = fileURLToPath(import.meta.url);
    _moduleDir = path.dirname(__filename);
  } catch {
    _moduleDir = __dirname;
  }

  let dir = _moduleDir;
  // 向上查找 pnpm-workspace.yaml 标记项目根
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(dir, 'data', 'novelmuse.db');
}

/**
 * 内联建表：迁移目录不存在时的回退方案
 * 确保 Electron 打包版即使没有 drizzle SQL 文件也能正常启动
 * 与 packages/db/drizzle/*.sql 保持 schema 一致
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bootstrapTables(sqlite: any): void {
  console.log('[better-sqlite3] 使用内联建表（迁移文件不可用）');

  const statements = [
    // 核心表：users, projects, user_settings
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar TEXT,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER,
      updated_at INTEGER NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`,

    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      cover_image TEXT,
      pen_name TEXT,
      genre TEXT,
      target_word_count INTEGER,
      current_word_count INTEGER DEFAULT 0 NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)`,

    `CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY NOT NULL,
      ai_features TEXT DEFAULT '{}' NOT NULL,
      ai_provider_config TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,

    // 项目关联表
    `CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT DEFAULT '' NOT NULL,
      "order" INTEGER NOT NULL,
      word_count INTEGER DEFAULT 0 NOT NULL,
      summary TEXT,
      status TEXT DEFAULT 'draft' NOT NULL,
      label TEXT,
      pov TEXT,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chapters_project_id ON chapters(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_chapters_order ON chapters("order")`,

    `CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      aliases TEXT,
      thumbnail TEXT,
      color TEXT,
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
      role TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_characters_project_id ON characters(project_id)`,

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
      states TEXT,
      chapters TEXT,
      tags TEXT,
      world TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_locations_project_id ON locations(project_id)`,

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
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_earmarks_project_id ON earmarks(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_earmarks_chapter_id ON earmarks(chapter_id)`,

    `CREATE TABLE IF NOT EXISTS foreshadows (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      description TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT DEFAULT 'planted' NOT NULL,
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

    `CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT,
      content TEXT DEFAULT '' NOT NULL,
      tags TEXT,
      pinned INTEGER DEFAULT 0 NOT NULL,
      linked_chapter_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notes_project_id ON notes(project_id)`,

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

    `CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      chapter_id TEXT NOT NULL,
      content TEXT NOT NULL,
      word_count INTEGER NOT NULL,
      label TEXT,
      auto INTEGER DEFAULT 1 NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_snapshots_chapter_id ON snapshots(chapter_id)`,

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

    `CREATE TABLE IF NOT EXISTS writing_stats (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      date TEXT NOT NULL,
      word_count INTEGER DEFAULT 0 NOT NULL,
      chapter_id TEXT,
      duration INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_writing_stats_project_id ON writing_stats(project_id)`,

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

    `CREATE TABLE IF NOT EXISTS reference_books (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT,
      content TEXT DEFAULT '' NOT NULL,
      chapters TEXT DEFAULT '[]' NOT NULL,
      current_chapter INTEGER DEFAULT 0 NOT NULL,
      source TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE NO ACTION ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_reference_books_project_id ON reference_books(project_id)`,

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

    // 集中式 Skills 库（docs/architecture/skills-library.md）+ 每个智能体的技能开关
    // ★ 必须与 drizzle/0001_skills_library.sql 保持一致（打包版没有迁移目录，走这里）
    `CREATE TABLE IF NOT EXISTS skill_library (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '' NOT NULL,
      color TEXT DEFAULT '#94a3b8' NOT NULL,
      icon_key TEXT DEFAULT 'sparkles' NOT NULL,
      category TEXT NOT NULL,
      owner_agent TEXT,
      system_prompt TEXT DEFAULT '' NOT NULL,
      context_keys TEXT DEFAULT '[]' NOT NULL,
      source TEXT DEFAULT 'installed' NOT NULL,
      user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_skill_library_category ON skill_library(category, owner_agent)`,
    `CREATE INDEX IF NOT EXISTS idx_skill_library_user ON skill_library(user_id)`,
    `CREATE TABLE IF NOT EXISTS agent_skill_toggles (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      enabled INTEGER DEFAULT 0 NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skill_toggles_unique ON agent_skill_toggles(user_id, agent_id, skill_id)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_skill_toggles_agent ON agent_skill_toggles(user_id, agent_id)`,
  ];

  for (const sql of statements) {
    try {
      sqlite.exec(sql);
    } catch (e) {
      console.warn('[better-sqlite3] 建表语句执行失败:', e);
    }
  }
  console.log('[better-sqlite3] ✅ 内联建表完成');
}

/** 运行 drizzle 迁移（读取 ../drizzle/*.sql，已应用的跳过） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runMigrations(sqlite: any): Promise<void> {
  const fs = await import('fs');
  const path = await import('path');
  // 不使用 __dirname 作为变量名，避免与 Node.js 全局冲突
  let _moduleDir: string;
  try {
    const { fileURLToPath } = await import('url');
    const __filename = fileURLToPath(import.meta.url);
    _moduleDir = path.dirname(__filename);
  } catch {
    _moduleDir = __dirname;
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __novelmuse_migrations (
      filename TEXT PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  /**
   * ★ 必须用 prepare().all() 读，**不能用 exec()**。
   *
   * better-sqlite3 的 `exec()` 只负责执行语句、**不返回结果行**（它是 sql.js 的同名 API 的
   * 语义差异；sql.js 的 exec 会返回 [{columns, values}]）。此前这里写的是
   * `sqlite.exec('SELECT filename FROM ...')` 再去读 `[0].values` —— 永远拿到 undefined，
   * 于是 `applied` 恒为空集，每次都命中下面的「历史库兼容」分支：
   * **新迁移一行都不会执行，却全部被 INSERT 成"已应用"**。
   * 症状极隐蔽：日志看着正常、迁移记录一条不少、表就是没有（实测踩到：
   * 新增 0001_skills_library.sql 后 `skill_library` 表不存在，而它已被记为 applied）。
   */
  const applied = new Set<string>();
  try {
    const rows = sqlite.prepare('SELECT filename FROM __novelmuse_migrations').all() as Array<{ filename: string }>;
    for (const row of rows) applied.add(row.filename);
  } catch (e) {
    console.warn('[better-sqlite3] 读取迁移记录失败（按空处理）:', e);
  }

  const migrationsDir = path.resolve(_moduleDir, '../drizzle');
  if (!fs.existsSync(migrationsDir)) {
    console.warn('[better-sqlite3] 迁移目录不存在:', migrationsDir);
    // 回退到内联建表（确保 Electron 打包版能正常启动）
    bootstrapTables(sqlite);
    return;
  }

  const files = fs.readdirSync(migrationsDir).filter((f: string) => f.endsWith('.sql')).sort();

  // 历史库兼容：如果 __novelmuse_migrations 表为空，但业务表已存在
  //（说明是 sql.js 时代或更早建立的库），直接把所有迁移标记为已应用，
  // 避免重新执行 CREATE TABLE 触发 "table already exists" 错误。
  if (applied.size === 0 && files.length > 0) {
    const hasBusinessTable = sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='projects'`,
    ).get();
    if (hasBusinessTable) {
      console.log('[better-sqlite3] 检测到历史库（业务表已存在但迁移记录为空），跳过 drizzle migration 并标记为已应用。');
      const ts = Date.now();
      sqlite.exec('BEGIN');
      for (const file of files) {
        sqlite.prepare(
          'INSERT OR IGNORE INTO __novelmuse_migrations (filename, applied_at) VALUES (?, ?)',
        ).run(file, ts);
      }
      sqlite.exec('COMMIT');
      return;
    }
  }

  let migrationFailed = false;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    // 按 statement-breakpoint 分割逐条执行，与 sql.js 行为一致
    const statements = sql.split('--> statement-breakpoint');
    try {
      sqlite.exec('BEGIN');
      for (const stmt of statements) {
        const trimmed = stmt.trim();
        if (trimmed) sqlite.exec(trimmed);
      }
      const ts = Date.now();
      sqlite.prepare(
        'INSERT INTO __novelmuse_migrations (filename, applied_at) VALUES (?, ?)',
      ).run(file, ts);
      sqlite.exec('COMMIT');
      console.log(`[better-sqlite3] 已执行迁移: ${file}`);
    } catch (e) {
      try { sqlite.exec('ROLLBACK'); } catch { /* ignore */ }
      console.error(`[better-sqlite3] 迁移失败: ${file}`, e);
      migrationFailed = true;
      break;
    }
  }

  // 任一迁移失败则回退到内联建表（确保不中断启动）
  if (migrationFailed) {
    console.warn('[better-sqlite3] 迁移失败，回退到内联建表作为兜底');
    try {
      bootstrapTables(sqlite);
    } catch (e) {
      console.error('[better-sqlite3] 内联建表也失败:', e);
      throw e;
    }
  }
}

/**
 * 兼容性补丁：与 sql.js adapter 的 ALTER TABLE 阶段对齐。
 * 处理历史数据库（schema 演进过程中后加的字段/表/索引）。
 *
 * 注意：drizzle migration SQL 文件可能未包含后加的字段（如 characters.role、
 * locations.world），这里通过 PRAGMA table_info 检测并 ALTER TABLE 补齐。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyCompatPatches(sqlite: any): Promise<void> {
  const hasColumn = (table: string, col: string): boolean => {
    const info = sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>;
    return info.some((row) => row.name === col);
  };

  const hasTable = (table: string): boolean => {
    const r = sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    ).get(table);
    return !!r;
  };

  // 1. projects.user_id（数据隔离）
  try {
    if (hasTable('projects') && !hasColumn('projects', 'user_id')) {
      console.log('[better-sqlite3] projects 表缺少 user_id 列，正在添加...');
      sqlite.exec('ALTER TABLE projects ADD COLUMN user_id TEXT');
      const firstUser = sqlite.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined;
      if (firstUser) {
        sqlite.prepare(
          'UPDATE projects SET user_id = ? WHERE user_id IS NULL OR user_id = ?',
        ).run(firstUser.id, '');
        console.log(`[better-sqlite3] 已将已有项目关联到用户 ${firstUser.id}`);
      }
      sqlite.exec('CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)');
    }
  } catch (e) {
    console.warn('[better-sqlite3] 检查 projects.user_id 失败:', e);
  }

  // 1b. projects.mode（创作模式：manual = 手写框架 / auto = AI 写作框架）
  // 旧库补列后为 NULL，读取侧统一按 'manual' 兜底，因此刻意不回填数据。
  try {
    if (hasTable('projects') && !hasColumn('projects', 'mode')) {
      console.log('[better-sqlite3] projects 表缺少 mode 列，正在添加...');
      sqlite.exec('ALTER TABLE projects ADD COLUMN mode TEXT');
      console.log('[better-sqlite3] projects.mode 列添加成功。');
    }
  } catch (e) {
    console.warn('[better-sqlite3] 检查 projects.mode 失败:', e);
  }

  // 1c. projects.brief（AI 写作的开书设定，JSON 文本）
  // 旧库补列后为 NULL，读取侧按「没有设定」兜底，刻意不回填。
  try {
    if (hasTable('projects') && !hasColumn('projects', 'brief')) {
      console.log('[better-sqlite3] projects 表缺少 brief 列，正在添加...');
      sqlite.exec('ALTER TABLE projects ADD COLUMN brief TEXT');
      console.log('[better-sqlite3] projects.brief 列添加成功。');
    }
  } catch (e) {
    console.warn('[better-sqlite3] 检查 projects.brief 失败:', e);
  }

  // 2. user_settings.ai_provider_config
  try {
    if (hasTable('user_settings') && !hasColumn('user_settings', 'ai_provider_config')) {
      sqlite.exec('ALTER TABLE user_settings ADD COLUMN ai_provider_config TEXT');
      console.log('[better-sqlite3] user_settings.ai_provider_config 列已添加。');
    }
  } catch (e) {
    console.warn('[better-sqlite3] 检查 user_settings.ai_provider_config 失败:', e);
  }

  // 3. chapters.deleted_at
  try {
    if (hasTable('chapters')) {
      if (!hasColumn('chapters', 'deleted_at')) {
        sqlite.exec('ALTER TABLE chapters ADD COLUMN deleted_at INTEGER');
        console.log('[better-sqlite3] chapters.deleted_at 列添加成功。');
      }
      sqlite.exec('CREATE INDEX IF NOT EXISTS idx_chapters_deleted_at ON chapters(deleted_at)');
    }
  } catch (e) {
    console.warn('[better-sqlite3] 检查 chapters.deleted_at 失败:', e);
  }

  // 4. items.current_holders（从 holders 流转记录推导填充）
  try {
    if (hasTable('items') && !hasColumn('items', 'current_holders')) {
      console.log('[better-sqlite3] items 表缺少 current_holders 列，正在添加...');
      sqlite.exec('ALTER TABLE items ADD COLUMN current_holders TEXT');
      const allItems = sqlite.prepare('SELECT id, holders FROM items').all() as Array<{
        id: string; holders: string | null;
      }>;
      for (const row of allItems) {
        const currentHolders: string[] = [];
        if (row.holders) {
          try {
            const holders = JSON.parse(row.holders) as Array<{
              characterId: string; chapter: number; action: string;
            }>;
            const lastAction = new Map<string, string>();
            for (const h of [...holders].sort((a, b) => a.chapter - b.chapter)) {
              lastAction.set(h.characterId, h.action);
            }
            for (const [cid, action] of lastAction) {
              if (action === 'gained' || action === 'transferred') currentHolders.push(cid);
            }
          } catch {
            /* ignore parse error */
          }
        }
        sqlite.prepare('UPDATE items SET current_holders = ? WHERE id = ?').run(
          JSON.stringify(currentHolders), row.id,
        );
      }
      console.log('[better-sqlite3] items.current_holders 列添加并迁移成功。');
    }
  } catch (e) {
    console.warn('[better-sqlite3] 检查 items.current_holders 失败:', e);
  }

  // 5. items.relations
  try {
    if (hasTable('items') && !hasColumn('items', 'relations')) {
      console.log('[better-sqlite3] items 表缺少 relations 列，正在添加...');
      sqlite.exec('ALTER TABLE items ADD COLUMN relations TEXT');
      const allItems = sqlite.prepare('SELECT id FROM items').all() as Array<{ id: string }>;
      for (const row of allItems) {
        sqlite.prepare('UPDATE items SET relations = ? WHERE id = ?').run(
          JSON.stringify([]), row.id,
        );
      }
      console.log('[better-sqlite3] items.relations 列添加并初始化完成。');
    }
  } catch (e) {
    console.warn('[better-sqlite3] 检查 items.relations 失败:', e);
  }

  // 6. characters.role
  try {
    if (hasTable('characters') && !hasColumn('characters', 'role')) {
      sqlite.exec('ALTER TABLE characters ADD COLUMN role TEXT');
      console.log('[better-sqlite3] characters.role 列添加成功。');
    }
  } catch (e) {
    console.warn('[better-sqlite3] 检查 characters.role 失败:', e);
  }

  // 6.5 items.credit_price（系统文：积分定价）
  try {
    if (hasTable('items') && !hasColumn('items', 'credit_price')) {
      sqlite.exec('ALTER TABLE items ADD COLUMN credit_price REAL');
      console.log('[better-sqlite3] items.credit_price 列添加成功。');
    }
  } catch (e) {
    console.warn('[better-sqlite3] 检查 items.credit_price 失败:', e);
  }

  // 7. locations.world
  try {
    if (hasTable('locations') && !hasColumn('locations', 'world')) {
      sqlite.exec('ALTER TABLE locations ADD COLUMN world TEXT');
      console.log('[better-sqlite3] locations.world 列添加成功。');
    }
  } catch (e) {
    console.warn('[better-sqlite3] 检查 locations.world 失败:', e);
  }

  // 7.5 locations.relations（地点间 / 地点-角色 的显式关系）
  try {
    if (hasTable('locations') && !hasColumn('locations', 'relations')) {
      sqlite.exec('ALTER TABLE locations ADD COLUMN relations TEXT');
      const rows = sqlite.prepare('SELECT id FROM locations').all() as Array<{ id: string }>;
      for (const row of rows) {
        sqlite.prepare('UPDATE locations SET relations = ? WHERE id = ?').run(JSON.stringify([]), row.id);
      }
      console.log('[better-sqlite3] locations.relations 列添加并初始化完成。');
    }
  } catch (e) {
    console.warn('[better-sqlite3] 检查 locations.relations 失败:', e);
  }

  // 8. writing_stats.created_at / updated_at
  try {
    if (hasTable('writing_stats')) {
      if (!hasColumn('writing_stats', 'created_at')) {
        sqlite.exec('ALTER TABLE writing_stats ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
      }
      if (!hasColumn('writing_stats', 'updated_at')) {
        sqlite.exec('ALTER TABLE writing_stats ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
      }
    }
  } catch (e) {
    console.warn('[better-sqlite3] 检查 writing_stats 列失败:', e);
  }

  // 9. snapshots.updated_at
  try {
    if (hasTable('snapshots') && !hasColumn('snapshots', 'updated_at')) {
      sqlite.exec('ALTER TABLE snapshots ADD COLUMN updated_at INTEGER');
      sqlite.exec('UPDATE snapshots SET updated_at = created_at WHERE updated_at IS NULL');
      console.log('[better-sqlite3] snapshots.updated_at 列添加并回填完成。');
    }
  } catch (e) {
    console.warn('[better-sqlite3] 检查 snapshots.updated_at 失败:', e);
  }

  // 10. 复合索引（全部为字面量语句，逐条容错；不使用模板拼接以杜绝任何动态注入面）
  const safeExec = (sql: string): void => {
    try {
      sqlite.exec(sql);
    } catch {
      /* 单个索引失败不影响其它 */
    }
  };
  safeExec('CREATE INDEX IF NOT EXISTS idx_chapters_project_order ON chapters (project_id, "order")');
  safeExec('CREATE INDEX IF NOT EXISTS idx_annotations_chapter_offset ON annotations (chapter_id, start_offset)');
  safeExec('CREATE INDEX IF NOT EXISTS idx_snapshots_chapter_created ON snapshots (chapter_id, created_at DESC)');
  safeExec('CREATE INDEX IF NOT EXISTS idx_writing_stats_project_date ON writing_stats (project_id, date)');
  safeExec('CREATE INDEX IF NOT EXISTS idx_outline_nodes_project_parent ON outline_nodes (project_id, parent_id)');
  safeExec('CREATE INDEX IF NOT EXISTS idx_ai_conversations_project_updated ON ai_conversations (project_id, updated_at DESC)');
  safeExec('CREATE INDEX IF NOT EXISTS idx_earmarks_chapter_type ON earmarks (chapter_id, type)');
  safeExec('CREATE INDEX IF NOT EXISTS idx_timeline_events_project_chapter ON timeline_events (project_id, chapter)');

  // 10. users.is_admin（管理员后台）
  try {
    if (hasTable('users') && !hasColumn('users', 'is_admin')) {
      sqlite.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
      console.log('[better-sqlite3] users.is_admin 列已添加。');
      // 把 username='admin' 的用户提升为管理员（如果存在）
      const adminUser = sqlite.prepare('SELECT id FROM users WHERE username = ?').get('admin') as { id: string } | undefined;
      if (adminUser) {
        sqlite.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(adminUser.id);
        console.log(`[better-sqlite3] 已将用户 'admin' (${adminUser.id}) 提升为管理员。`);
      } else {
        // 没有 admin 用户时，把第一个用户提升为管理员（保证至少有一个管理员）
        const firstUser = sqlite.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get() as { id: string } | undefined;
        if (firstUser) {
          sqlite.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(firstUser.id);
          console.log(`[better-sqlite3] 已将第一个用户 (${firstUser.id}) 提升为管理员。`);
        }
      }
    }
  } catch (e) {
    console.warn('[better-sqlite3] 检查 users.is_admin 失败:', e);
  }

  // 9. skill_library.user_id（技能归属：NULL=公共，非空=该用户私有）
  //    ★ 2026-09-17 加。已有的 11 条 builtin 技能保持 NULL（=公共），无需回填 ——
  //      这正是"只有公共插件才是全局的"这条口径的落地。
  try {
    if (hasTable('skill_library') && !hasColumn('skill_library', 'user_id')) {
      console.log('[better-sqlite3] skill_library 表缺少 user_id 列，正在添加...');
      sqlite.exec('ALTER TABLE skill_library ADD COLUMN user_id TEXT');
      sqlite.exec('CREATE INDEX IF NOT EXISTS idx_skill_library_user ON skill_library(user_id)');
      console.log('[better-sqlite3] skill_library.user_id 已添加（已有技能保持 NULL=公共）。');
    }
  } catch (e) {
    console.warn('[better-sqlite3] 检查 skill_library.user_id 失败:', e);
  }
}

export function createBetterSqliteAdapter(): DatabaseAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sqlite: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null;
  let dbPath = './novelmuse.db';

  return {
    engine: 'better-sqlite3',

    async init(path?: string) {
      const { default: Database } = (await import(BETTER_SQLITE3)) as any;
      const { drizzle } = (await import(DRIZZLE_BETTER_SQLITE3)) as any;

      dbPath = path ?? (await resolveDefaultDbPath());

      // 确保目录存在
      const fs = await import('fs');
      const pathMod = await import('path');
      const dir = pathMod.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      sqlite = new Database(dbPath);
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('busy_timeout = 5000');
      sqlite.pragma('foreign_keys = ON');

      db = drizzle(sqlite, { schema });

      await runMigrations(sqlite);
      await applyCompatPatches(sqlite);
      return db;
    },

    getDb() {
      return db;
    },

    getRawSqlite() {
      return sqlite;
    },

    async persist(force?: boolean) {
      if (!sqlite) return;
      // WAL 已增量落盘；force 时做一次 checkpoint 将 WAL 合并回主库，
      // 保证关键节点（登录、保存配置）后数据立即可见于文件系统。
      if (force) {
        try {
          sqlite.pragma('wal_checkpoint(TRUNCATE)');
        } catch (e) {
          console.error('[better-sqlite3] checkpoint 失败:', e);
        }
      }
    },

    async close() {
      if (sqlite) {
        try {
          sqlite.pragma('wal_checkpoint(TRUNCATE)');
        } catch {
          /* ignore */
        }
        sqlite.close();
      }
      sqlite = null;
      db = null;
    },

    isReady() {
      return !!db;
    },
  };
}
