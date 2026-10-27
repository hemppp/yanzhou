// ============================================================
// 砚舟 - 认证状态管理
// 基于 Zustand + persist 中间件
// 统一走后端 JWT 认证（authApi）
// ============================================================

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { authApi } from '../api/authApi';
import { getToken, clearToken as apiClearToken } from '../api/apiClient';

// ---------- 类型定义 ----------

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatar?: string;
  isAdmin?: boolean;
  createdAt: number;
  lastLoginAt?: number;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isInitialized: boolean;

  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  getToken: () => string | null;
  initialize: () => Promise<void>;
  fetchUser: () => Promise<void>;
  setLoading: (loading: boolean) => void;
  checkSession: () => boolean;
}

// ---------- Store 实现 ----------

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      isInitialized: false,

      login: async (username: string, password: string) => {
        set({ isLoading: true });
        try {
          const { user } = await authApi.login({ username, password });
          set({ user, isAuthenticated: true, isLoading: false });
        } catch (error) {
          set({ isLoading: false, user: null, isAuthenticated: false });
          throw error;
        }
      },

      register: async (username: string, password: string, displayName: string) => {
        set({ isLoading: true });
        try {
          const { user } = await authApi.register({ username, password, displayName });
          set({ user, isAuthenticated: true, isLoading: false });
        } catch (error) {
          set({ isLoading: false, user: null, isAuthenticated: false });
          throw error;
        }
      },

      logout: async () => {
        try {
          await authApi.logout();
        } finally {
          // ★ 登出清理：聊天历史/大纲/参考书分析/章节缓存不跨账号残留
          try {
            const { clearAllLocalUserData } = await import('../data/localUserData');
            clearAllLocalUserData();
          } catch { /* 清理失败不阻断登出 */ }
          apiClearToken();
          set({ user: null, isAuthenticated: false, isLoading: false });
        }
      },

      // 兼容旧调用点；C4 后令牌仅在内存中（刷新后为 null），会话由 HttpOnly Cookie 承载
      getToken: () => getToken(),

      /**
       * 初始化（C4）：Cookie 是唯一会话凭据，启动后后台调用 /auth/me 校准。
       *
       * 关键设计：isInitialized 立即设为 true，不等待网络请求。
       * 这样 App.tsx 的 加载中 spinner 立即消失，用户可以立即看到页面。
       * Cookie 验证在后台进行：有效 → 恢复登录态；无效/过期 → 未认证。
       */
      initialize: async () => {
        if (get().isInitialized) return;

        // 先标记已初始化让 UI 渲染，后台验证 Cookie 会话
        set({ isInitialized: true, isLoading: true });

        authApi.getCurrentUser()
          .then((user) => {
            set({ user, isAuthenticated: true, isLoading: false });
          })
          .catch(() => {
            apiClearToken();
            set({ user: null, isAuthenticated: false, isLoading: false });
          });
      },

      fetchUser: async () => {
        set({ isLoading: true });
        try {
          const user = await authApi.getCurrentUser();
          set({ user, isAuthenticated: true, isLoading: false });
        } catch {
          apiClearToken();
          set({ user: null, isAuthenticated: false, isLoading: false });
        }
      },

      setLoading: (loading: boolean) => { set({ isLoading: loading }); },

      checkSession: () => {
        const state = get();
        return state.isAuthenticated && state.user !== null;
      },
    }),
    {
      name: 'novelmuse_auth',
      // C4：不再持久化登录标记——会话状态完全由服务端 Cookie 决定，
      // 持久化的旧值会与真实 Cookie 状态脱节（如其他标签页登出）。
      partialize: () => ({}),
      skipHydration: typeof window === 'undefined',
    }
  )
);
