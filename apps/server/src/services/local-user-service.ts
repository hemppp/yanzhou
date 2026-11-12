// ============================================================
// 本地单用户服务
//
// 本地版没有登录/注册/管理员：整个服务只认一个「本地用户」。
// 该用户仅用于满足数据模型中的 user_id 外键（项目归属、用户级设置等），
// 不再承载任何认证或权限语义。
//
// 引导策略（保留历史数据）：
// - 库里已有用户时，沿用最早创建的用户（优先管理员）作为本地用户，
//   这样旧项目、AI 配置等 user_settings 仍然可见；
// - 库里没有用户时，创建一个固定 id 的本地用户；
// - 再把所有历史项目归到该用户名下，避免多账号残留导致书架缺书。
// ============================================================

import { getDb, schema, ne, saveToDisk } from '@novel/db';

const { users, projects } = schema;

export interface LocalUser {
  id: string;
  username: string;
  displayName: string;
}

/** 无历史用户时创建的本地用户 id（固定值，便于排查） */
export const LOCAL_USER_ID = 'local-user';

let cached: LocalUser | null = null;
let inflight: Promise<LocalUser> | null = null;

function pickExistingUser(rows: Array<{ id: string; username: string; displayName: string; isAdmin: boolean }>): LocalUser | null {
  if (rows.length === 0) return null;
  const chosen = rows.find((r) => r.isAdmin) ?? rows[0];
  return { id: chosen.id, username: chosen.username, displayName: chosen.displayName };
}

/**
 * 获取（必要时创建）本地用户。结果在进程内缓存。
 *
 * 注意：必须在数据库初始化完成后调用（宿主启动时已保证）。
 */
export async function getLocalUser(): Promise<LocalUser> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const db = getDb();
    if (!db) throw new Error('[LocalUser] 数据库不可用');

    const rows = db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        isAdmin: users.isAdmin,
      })
      .from(users)
      .all() as Array<{ id: string; username: string; displayName: string; isAdmin: boolean }>;

    let user = pickExistingUser(rows);

    if (!user) {
      const now = new Date();
      user = { id: LOCAL_USER_ID, username: 'local', displayName: '本地用户' };
      db.insert(users).values({
        id: user.id,
        username: user.username,
        // 本地版没有密码校验；该列非空，占位即可
        passwordHash: '',
        displayName: user.displayName,
        isAdmin: false,
        createdAt: now,
        updatedAt: now,
      }).run();
      await saveToDisk(true);
      console.warn(`[LocalUser] 已创建本地用户（${user.id}）`);
    }

    // 历史多用户数据合并：所有项目归到本地用户，保证书架完整可见。
    // 只改归属列，不动 updatedAt（否则每次启动都会打乱「最近编辑」排序）。
    try {
      const assigned = db.update(projects).set({ userId: user.id }).where(ne(projects.userId, user.id)).run();
      void assigned;
      await saveToDisk(true);
    } catch (err) {
      console.warn('[LocalUser] 合并历史项目归属失败（忽略，不影响启动）:', err);
    }

    cached = user;
    return user;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** 启动时主动引导一次（失败只告警，不阻断服务启动） */
export async function ensureLocalUser(): Promise<void> {
  try {
    await getLocalUser();
  } catch (err) {
    console.error('[LocalUser] 初始化本地用户失败:', err);
  }
}

/** 测试/数据库重置时清空缓存 */
export function resetLocalUserCache(): void {
  cached = null;
}
