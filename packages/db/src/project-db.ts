// ============================================================
// 项目库连接管理（每本书一个独立 SQLite 文件）
//
// 设计要点：
// - 每个项目对应一个独立的 .db 文件：data/projects/{projectId}.db
// - 使用 better-sqlite3（WAL 模式，增量写入）
// - LRU 缓存最近使用的项目库实例，避免频繁打开/关闭
// - 项目库的 schema 见 drizzle/project_tables.sql（16 张项目级表，无跨库外键）
// - 主库 novelmuse.db 保留全局表：users / user_settings / projects / series
// ============================================================

import * as schema from './schema.js';
import type { DrizzleDb } from './index.js';

// 用变量形式持有模块名，避免 TS 编译期静态解析缺失模块
const BETTER_SQLITE3: string = 'better-sqlite3';
const DRIZZLE_BETTER_SQLITE3: string = 'drizzle-orm/better-sqlite3';

/** 项目库实例缓存条目 */
interface ProjectDbEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sqlite: any;
  db: DrizzleDb;
  lastUsed: number;
}

/** LRU 缓存：projectId → 项目库实例 */
const _projectDbCache = new Map<string, ProjectDbEntry>();
/** 在途的首次打开（并发去重；完成后即删除）。 */
const _projectDbOpening = new Map<string, Promise<DrizzleDb>>();

// ---- 项目库初始化钩子 ----
// 用途：插件正式表迁移通道（ctx.db.migrate scope:'project'）——插件把迁移登记为
// pending 后，任何「之后才创建/打开」的项目库由钩子自动补跑，无需全量重开旧库。
type ProjectDbInitHook = (projectId: string) => void;
const _projectDbInitHooks: ProjectDbInitHook[] = [];

/** 注册项目库初始化回调（在应用自身 schema 迁移之后触发）；返回取消注册函数 */
export function onProjectDbInit(cb: ProjectDbInitHook): () => void {
  _projectDbInitHooks.push(cb);
  return () => {
    const i = _projectDbInitHooks.indexOf(cb);
    if (i >= 0) _projectDbInitHooks.splice(i, 1);
  };
}

/** 列出当前已打开项目库的原始 sqlite 连接（LRU 缓存内） */
export function listOpenProjectDbs(): Array<{ projectId: string; sqlite: unknown }> {
  return [..._projectDbCache.entries()].map(([projectId, e]) => ({ projectId, sqlite: e.sqlite }));
}

/** 按 projectId 取已打开项目库的原始 sqlite 连接（未打开返回 null） */
export function getProjectSqliteRaw(projectId: string): unknown {
  return _projectDbCache.get(projectId)?.sqlite ?? null;
}

/** 最大同时打开的项目库数量（超过则关闭最旧的） */
const MAX_OPEN_PROJECT_DBS = 5;

/** 项目库是否已初始化（保证 better-sqlite3 模块只加载一次） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _DatabaseCtor: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _drizzleCtor: any = null;
let _moduleLoaded = false;

/** 解析项目根目录（向上查找 pnpm-workspace.yaml） */
async function resolveProjectRoot(): Promise<string> {
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
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

/** 异步加载 better-sqlite3 和 drizzle-orm/better-sqlite3 模块 */
async function loadModules(): Promise<void> {
  if (_moduleLoaded) return;
  const { default: Database } = (await import(BETTER_SQLITE3)) as any;
  const { drizzle } = (await import(DRIZZLE_BETTER_SQLITE3)) as any;
  _DatabaseCtor = Database;
  _drizzleCtor = drizzle;
  _moduleLoaded = true;
}

/**
 * 项目库 id 的合法形态白名单。
 * - 生产 id 是 uuid v4
 * - 测试辅助库用 `entity-sink-test-1699...` 这类前缀 + 时间戳
 * 明确排除 `/`、`\`、`.`（含 `..`）、控制字符 —— 即一切路径分隔与穿越材料。
 */
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** projectId 是否可安全用于拼接文件路径 */
export function isValidProjectId(projectId: string): boolean {
  return PROJECT_ID_PATTERN.test(projectId);
}

/**
 * 校验 projectId，非法（含路径穿越意图）直接抛错。
 *
 * ★ 这是路径穿越的**最内层防线**。所有会打开项目库的入口 ——
 *   HTTP 的 requireProjectScope、admin 修库、插件 KV 读写、宿主 init 钩子、
 *   迁移脚本 —— 最终都汇到 initProjectDb → getProjectDbPath。
 *   在入口各自加校验必然会漏（实测已有 6 个调用方），此处收口才覆盖得住。
 */
export function assertValidProjectId(projectId: string): void {
  if (!isValidProjectId(projectId)) {
    throw new Error(
      `[ProjectDB] 非法 projectId（疑似路径穿越）: ${JSON.stringify(String(projectId).slice(0, 80))}`,
    );
  }
}

/**
 * 获取项目库文件路径。
 *
 * ★ 两道防线：
 *   ① id 形态白名单（assertValidProjectId）
 *   ② resolve 后断言结果仍落在 data/projects/ 之内
 * 缺任一道都可在 id 被污染时打开到沙箱之外 —— 曾可借此把**主库**当项目库打开。
 */
export async function getProjectDbPath(projectId: string): Promise<string> {
  const path = await import('path');
  assertValidProjectId(projectId);

  const root = await resolveProjectRoot();
  const projectsDir = path.resolve(root, 'data', 'projects');
  const dbPath = path.resolve(projectsDir, `${projectId}.db`);

  // ② 兜底：即便白名单将来被放宽，也不允许逃出 projects 目录
  if (!dbPath.startsWith(projectsDir + path.sep)) {
    throw new Error(
      `[ProjectDB] projectId 越出数据目录: ${JSON.stringify(String(projectId).slice(0, 80))}`,
    );
  }
  return dbPath;
}

/**
 * 运行项目库 migration（执行 drizzle/project_tables.sql）
 * 多次执行安全：所有 CREATE 都用 IF NOT EXISTS
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runProjectMigrations(sqlite: any): Promise<void> {
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

  const migrationsDir = path.resolve(_moduleDir, '../drizzle');
  const sqlFile = path.join(migrationsDir, 'project_tables.sql');

  if (!fs.existsSync(sqlFile)) {
    console.warn('[ProjectDB] 项目库迁移文件不存在:', sqlFile);
    return;
  }

  const sql = fs.readFileSync(sqlFile, 'utf-8');
  const statements = sql.split('--> statement-breakpoint');

  sqlite.exec('BEGIN');
  try {
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
    sqlite.exec('COMMIT');
  } catch (e) {
    try { sqlite.exec('ROLLBACK'); } catch { /* ignore */ }
    console.error('[ProjectDB] 项目库迁移失败:', e);
    throw e;
  }

  // 兼容补列：project_tables.sql 的 CREATE TABLE IF NOT EXISTS 对旧库不生效，
  // 后加的列（如 items.credit_price）需在此检测补齐，否则 drizzle 整表查询会报 no such column
  try {
    const itemCols = sqlite.pragma('table_info(items)') as Array<{ name: string }>;
    if (!itemCols.some((c) => c.name === 'credit_price')) {
      console.log('[ProjectDB] items 表缺少 credit_price 列，正在添加...');
      sqlite.exec('ALTER TABLE items ADD COLUMN credit_price REAL');
    }
  } catch (e) {
    console.warn('[ProjectDB] 检查 items.credit_price 列失败:', e);
  }

  // 冲突裁决留痕列（fact_conflicts 是本轮新表，旧库可能只有早期版本）
  try {
    const conflictCols = sqlite.pragma('table_info(fact_conflicts)') as Array<{ name: string }>;
    if (conflictCols.length > 0 && !conflictCols.some((c) => c.name === 'resolution')) {
      console.log('[ProjectDB] fact_conflicts 表缺少 resolution 列，正在添加...');
      sqlite.exec('ALTER TABLE fact_conflicts ADD COLUMN resolution text');
    }
  } catch (e) {
    console.warn('[ProjectDB] 检查 fact_conflicts.resolution 列失败:', e);
  }

  // 同理补章的故事内时间（水车三层时间戳的第三层）
  try {
    const chapterCols = sqlite.pragma('table_info(chapters)') as Array<{ name: string }>;
    if (!chapterCols.some((c) => c.name === 'story_time')) {
      console.log('[ProjectDB] chapters 表缺少 story_time 列，正在添加...');
      sqlite.exec('ALTER TABLE chapters ADD COLUMN story_time text');
    }
  } catch (e) {
    console.warn('[ProjectDB] 检查 chapters.story_time 列失败:', e);
  }
}

/**
 * 初始化项目库：创建/打开 DB 文件、跑 migration、缓存实例
 * 如果缓存已存在，直接返回。
 */
export async function initProjectDb(projectId: string): Promise<DrizzleDb> {
  // 缓存命中
  const cached = _projectDbCache.get(projectId);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.db;
  }

  // ★ 并发首次打开去重：中间有 `await loadModules()`，页面同时发起的多个
  //   项目级请求会一起穿透缓存，各开一条 better-sqlite3 连接；后写缓存者
  //   覆盖先写者，先开的连接从此无人 close（句柄/WAL 只能等进程退出）。
  const opening = _projectDbOpening.get(projectId);
  if (opening !== undefined) return opening;
  const task = openProjectDb(projectId).finally(() => {
    _projectDbOpening.delete(projectId);
  });
  _projectDbOpening.set(projectId, task);
  return task;
}

/** `initProjectDb` 的实际打开逻辑（同一项目保证只有一个在途）。 */
async function openProjectDb(projectId: string): Promise<DrizzleDb> {
  await loadModules();

  const fs = await import('fs');
  const path = await import('path');

  const dbPath = await getProjectDbPath(projectId);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new _DatabaseCtor(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');

  await runProjectMigrations(sqlite);

  const db = _drizzleCtor(sqlite, { schema }) as DrizzleDb;

  const entry: ProjectDbEntry = { sqlite, db, lastUsed: Date.now() };
  _projectDbCache.set(projectId, entry);

  // LRU 淘汰：超过上限时关闭最旧的
  if (_projectDbCache.size > MAX_OPEN_PROJECT_DBS) {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, e] of _projectDbCache) {
      if (id === projectId) continue;
      if (e.lastUsed < oldestTime) {
        oldestTime = e.lastUsed;
        oldestId = id;
      }
    }
    if (oldestId) {
      await closeProjectDb(oldestId);
      console.log(`[ProjectDB] LRU 淘汰项目库: ${oldestId}`);
    }
  }

  console.log(`[ProjectDB] 已初始化项目库: ${projectId}`);
  // 初始化钩子在应用自身 schema 迁移（runProjectMigrations）之后触发，
  // 插件迁移只会叠在宿主表之上，不会与之竞争
  for (const hook of _projectDbInitHooks) {
    try {
      hook(projectId);
    } catch (e) {
      // 钩子失败不阻断项目库初始化（调用方各自负责错误处理）
      console.error('[ProjectDB] init 钩子执行失败:', e);
    }
  }
  return db;
}

/**
 * 获取项目库的 Drizzle 实例。
 * 如果未初始化，会自动调用 initProjectDb。
 */
export async function getProjectDb(projectId: string): Promise<DrizzleDb> {
  return initProjectDb(projectId);
}

/**
 * 同步获取项目库实例（已缓存时直接返回，未缓存返回 null）。
 * 适用于 service 层在已知 projectId 已 init 的场景下避免 async。
 */
export function getProjectDbSync(projectId: string): DrizzleDb | null {
  const entry = _projectDbCache.get(projectId);
  if (entry) {
    entry.lastUsed = Date.now();
    return entry.db;
  }
  return null;
}

/**
 * 持久化项目库（WAL checkpoint）
 */
export async function persistProjectDb(projectId: string, force = false): Promise<void> {
  const entry = _projectDbCache.get(projectId);
  if (!entry) return;
  if (force) {
    try {
      entry.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {
      console.error(`[ProjectDB] checkpoint 失败 (${projectId}):`, e);
    }
  }
}

/**
 * 关闭指定项目库并从缓存移除。
 */
export async function closeProjectDb(projectId: string): Promise<void> {
  const entry = _projectDbCache.get(projectId);
  if (!entry) return;
  try {
    entry.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    entry.sqlite.close();
  } catch (e) {
    console.error(`[ProjectDB] 关闭失败 (${projectId}):`, e);
  }
  _projectDbCache.delete(projectId);
}

/**
 * 关闭所有已打开的项目库。用于优雅关闭。
 */
export async function closeAllProjectDbs(): Promise<void> {
  const ids = Array.from(_projectDbCache.keys());
  await Promise.all(ids.map((id) => closeProjectDb(id)));
  console.log(`[ProjectDB] 已关闭 ${ids.length} 个项目库`);
}

/**
 * 删除项目库文件（删除项目时调用）。
 * 先关闭连接，再删除 .db / .db-wal / .db-shm 文件。
 */
export async function deleteProjectDb(projectId: string): Promise<void> {
  await closeProjectDb(projectId);

  const fs = await import('fs');
  const dbPath = await getProjectDbPath(projectId);

  const filesToDelete = [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    `${dbPath}.bak`,
  ];

  for (const file of filesToDelete) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (e) {
      console.warn(`[ProjectDB] 删除文件失败 ${file}:`, e);
    }
  }

  /**
   * ★ 2026-11-09 删掉「目录空了就 rmdir」那步。
   *
   * 原来它删的是 `path.dirname(dbPath)` —— 而项目库都是**平铺**在
   * `<root>/data/projects/<projectId>.db`，所以这个 `dir` 永远是**共享的 projects 根目录**，
   * 不是某个项目自己的目录。两个并行测试进程同时用一个共享根时就会撞车：
   *   A 先 mkdir(projects)；B 恰在 A 建好文件前删完自己的库、看到目录已空 → rmdir(projects)；
   *   A 紧接着 `new Database(projects/x.db)` → SQLITE_CANTOPEN「directory does not exist」。
   * 实测 novel.autowrite 的 entity-sink / memory 两个测试文件在 `pool: 'forks'` 下并行时
   * 会间歇触发（约 1/5 的概率整文件 48 例被跳成 beforeAll 失败）。
   * 目录留着无害（initProjectDb 本来就会 mkdir），删掉共享目录才是错的。
   */

  console.log(`[ProjectDB] 已删除项目库文件: ${projectId}`);
}

/** 当前缓存中已打开的项目库数量（调试用） */
export function getOpenProjectDbCount(): number {
  return _projectDbCache.size;
}
