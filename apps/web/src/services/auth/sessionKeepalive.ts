// ============================================================
// 砚舟 - 会话保活（滑动续期）
//
// 配合服务端 3h JWT/HttpOnly Cookie（JWT_EXPIRES_IN，默认 '3h'）：
// - 每 10 分钟检查一次：仅当「近 30 分钟内有真实用户操作」才调
//   POST /auth/refresh 换发新 Cookie → 持续使用期间永不掉线。
// - 超过活动窗口就不续期 → 令牌在最后一次续期后 3 小时到期，
//   即「3 小时无操作自动退出登录」（到期后下一次 401 由 apiClient
//   全局跳转登录页，并携带 redirect 回跳参数）。
// - 不在续期成功后覆盖 authStore.user：refresh 接口返回的是精简
//   user 对象（缺 createdAt 等），完整信息以登录时和 /auth/me 为准。
// ============================================================

import { authApi } from '../api/authApi';
import { useAuthStore } from '@/stores/authStore';

/** 续期检查间隔：10 分钟 */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** 活动窗口：近 30 分钟内有操作才续期（避免挂机标签页无限续命） */
const ACTIVITY_WINDOW_MS = 30 * 60 * 1000;

let started = false;
let lastActivityAt = Date.now();
let refreshing = false;

function touchActivity(): void {
  lastActivityAt = Date.now();
}

async function refreshIfNeeded(): Promise<void> {
  if (refreshing) return;
  if (!useAuthStore.getState().isAuthenticated) return;
  // 无操作超过活动窗口：故意不续期，让令牌按 3 小时窗口自然过期
  if (Date.now() - lastActivityAt > ACTIVITY_WINDOW_MS) return;

  refreshing = true;
  try {
    await authApi.refreshToken();
    // 成功即可：新 Cookie 已由服务端 Set-Cookie 轮换，无需改前端状态。
    // 失败若为 401（令牌失效/被吊销），apiClient 全局处理会跳登录页；
    // 其余失败（网络抖动等）静默跳过，令牌未到期前下个周期再试。
  } catch {
    // 静默：见上
  } finally {
    refreshing = false;
  }
}

/** 启动会话保活（幂等；App 挂载时调用一次） */
export function startSessionKeepalive(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  for (const evt of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(evt, touchActivity, { passive: true, capture: true });
  }
  // 标签页重新可见视为恢复使用：先记活动，再由下个周期决定是否续期
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') touchActivity();
  });

  window.setInterval(() => { void refreshIfNeeded(); }, CHECK_INTERVAL_MS);
}
