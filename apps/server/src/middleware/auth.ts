import type { Context, Next } from 'hono';
import { getLocalUser, type LocalUser } from '../services/local-user-service.js';

/**
 * 本地版的「当前用户」。
 *
 * 历史版本这里承载 JWT 登录态与管理员角色；本地版没有账号体系，
 * 由本地单用户服务直接注入。字段保持与旧代码兼容，方便各模块
 * 继续用 `c.get('user').id` 作为数据归属键。
 */
export type AuthUser = LocalUser;

export type AuthVariables = {
  user: AuthUser;
};

/**
 * 注入本地用户上下文。
 *
 * 名为 requireAuth 是为了避免改动 39 处路由挂载点；语义上它已经不做
 * 任何鉴权 —— 本地版没有登录流程，请求一律以本地用户身份执行。
 */
export async function requireAuth(c: Context<{ Variables: AuthVariables }>, next: Next) {
  try {
    const user = await getLocalUser();
    c.set('user', user);
  } catch (error) {
    console.error('[Auth Middleware] 获取本地用户失败:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '本地用户初始化失败' } }, 500);
  }
  await next();
}

/** 兼容旧调用点：本地版里可选认证与强制认证等价 */
export const optionalAuth = requireAuth;
