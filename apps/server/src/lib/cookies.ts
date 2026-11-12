// ============================================================
// 认证 Cookie 工具（C4：token 存储迁移）
//
// 目标：JWT 不再写入 localStorage（XSS 可读），改由 HttpOnly + SameSite=Strict
// 的 Cookie 携带。服务端鉴权中间件同时接受「Authorization: Bearer」头与
// 本 Cookie（过渡期兼容），前端刷新页面后仅凭 Cookie 即可恢复会话。
//
// 安全说明：
// - HttpOnly：JS 无法读取（防御 XSS 窃取令牌）
// - SameSite=Strict：跨站请求不携带（防御 CSRF；配合 JSON 请求体校验更稳）
// - Secure：仅在显式设置 COOKIE_SECURE=true 时启用（本地/内网为 http，
//   盲目加 Secure 会导致 Cookie 不发送、登录失效；HTTPS 部署请务必设置）
// ============================================================

import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

export const AUTH_COOKIE_NAME = 'novelmuse_token';

/**
 * 与 JWT 有效期对齐（jwt.ts 的 DEFAULT_EXPIRES_IN，默认 30d）。
 * 读取同一个 JWT_EXPIRES_IN 环境变量，支持 '3h'/'30m'/'2d'/'30d'/'90s'/纯秒数，
 * 保证「Cookie 寿命 = 令牌寿命」，两者不会各自漂移。
 *
 * ★ 2026-11-12：默认 3h → 30d。注意这里的单位是**秒**（Hono 的 maxAge 会直接
 *   写成 Max-Age 属性），所以 30d 是 2,592,000。
 */
function resolveAuthCookieMaxAge(): number {
  const raw = (process.env.JWT_EXPIRES_IN || '30d').trim();
  const m = raw.match(/^(\d+)([smhd])?$/i);
  if (!m) return 30 * 24 * 60 * 60;
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 60 * 60, d: 24 * 60 * 60 };
  return parseInt(m[1], 10) * (multipliers[(m[2] || 's').toLowerCase()] ?? 1);
}

/** 与 JWT 有效期对齐（默认 30d）；到期后 401 → 前端清除会话要求重新登录 */
const AUTH_COOKIE_MAX_AGE = resolveAuthCookieMaxAge();

/** 读取认证 Cookie（无则返回 undefined） */
export function getAuthCookie(c: Context): string | undefined {
  return getCookie(c, AUTH_COOKIE_NAME);
}

/** 写入认证 Cookie（HttpOnly + SameSite=Strict） */
export function setAuthCookie(c: Context, token: string): void {
  setCookie(c, AUTH_COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    maxAge: AUTH_COOKIE_MAX_AGE,
    secure: process.env.COOKIE_SECURE === 'true',
  });
}

/** 清除认证 Cookie（登出） */
export function clearAuthCookie(c: Context): void {
  deleteCookie(c, AUTH_COOKIE_NAME, { path: '/' });
}
