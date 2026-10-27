// ============================================================
// 砚舟 - 认证 API 封装层
// 封装所有与认证相关的后端 API 调用
// ============================================================

import { apiClient } from './apiClient';
import type { User } from '../stores/authStore';

// ---------- 请求/响应类型 ----------

/** 登录请求参数 */
export interface LoginRequest {
  /** 用户名 */
  username: string;
  /** 密码 */
  password: string;
}

/** 注册请求参数 */
export interface RegisterRequest {
  /** 用户名 */
  username: string;
  /** 密码（至少6位） */
  password: string;
  /** 显示名称 */
  displayName: string;
}

/**
 * 认证响应（C4）：登录/注册成功后仅返回用户信息。
 * JWT 由服务端写入 HttpOnly + SameSite=Strict Cookie（前端 JS 不可读），
 * 不再返回 token 字段——XSS 无法窃取会话。
 */
export interface AuthResponse {
  /** 当前用户信息 */
  user: User;
}

/**
 * 认证相关 API 集合
 *
 * 所有方法均通过 apiClient 发起 HTTP 请求。
 * C4 迁移后不再调用 setToken：会话凭据完全由 HttpOnly Cookie 承载，
 * 页面刷新后凭 Cookie 自动恢复（authStore.initialize 调 /auth/me 校准）。
 */
export const authApi = {
  /**
   * 用户登录（服务端写入认证 Cookie）
   * @param data - 登录凭证（用户名 + 密码）
   * @返回 当前用户信息
   * @throws {ApiError} 401 - 用户名或密码错误
   * @throws {ApiError} 422 - 参数验证失败
   * @throws {ApiError} 500 - 服务器内部错误
   */
  async login(data: LoginRequest): Promise<AuthResponse> {
    return apiClient.post<AuthResponse>('/auth/login', data);
  },

  /**
   * 用户注册（成功即登录，服务端写入认证 Cookie）
   * @param data - 注册信息（用户名 + 密码 + 显示名称）
   * @返回 当前用户信息
   * @throws {ApiError} 409 - 用户名已被注册
   * @throws {ApiError} 422 - 参数验证失败（如密码过短）
   * @throws {ApiError} 500 - 服务器内部错误
   */
  async register(data: RegisterRequest): Promise<AuthResponse> {
    return apiClient.post<AuthResponse>('/auth/register', data);
  },

  /**
   * 获取当前已登录用户的信息（凭 HttpOnly Cookie 认证）
   * @返回 当前用户信息
   * @throws {ApiError} 401 - 未登录或会话已过期
   * @throws {ApiError} 500 - 服务器内部错误
   */
  async getCurrentUser(): Promise<User> {
    return apiClient.get<User>('/auth/me');
  },

  /**
   * 刷新 JWT（服务端轮换 HttpOnly Cookie）
   * @返回 当前用户信息
   * @throws {ApiError} 401 - 刷新令牌无效或过期
   */
  async refreshToken(): Promise<User> {
    const response = await apiClient.post<{ user: User }>('/auth/refresh');
    return response.user;
  },

  /**
   * 用户登出（服务端吊销令牌 + 清除 Cookie）
   * 本地状态清除由 authStore.logout() 负责
   * @throws {ApiError} 网络错误时静默处理（登出不因网络问题失败）
   */
  async logout(): Promise<void> {
    try {
      await apiClient.post<void>('/auth/logout');
    } catch {
      // 即使后端登出请求失败，也不影响前端清除状态
    }
  },

  /**
   * 检查用户名是否可用（注册页实时检测）
   * @returns available=true 表示可用，reason 描述不可用原因
   */
  async checkUsername(username: string): Promise<{ available: boolean; reason: string }> {
    const result = await apiClient.get<{ username: string; available: boolean; reason: string }>(
      '/auth/check-username',
      { username },
      { silent: true },
    );
    return { available: result.available, reason: result.reason };
  },
};

// ---------- 管理员后台 API ----------

/** 管理员后台用户列表项 */
export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  avatar?: string;
  isAdmin: boolean;
  createdAt: number;
  lastLoginAt?: number;
  updatedAt: number;
}

/** 系统统计 */
export interface AdminStats {
  users: number;
  admins: number;
  projects: number;
  chapters: number;
}

export const adminApi = {
  /** 获取所有用户列表 */
  async listUsers(): Promise<AdminUser[]> {
    return apiClient.get<AdminUser[]>('/admin/users');
  },

  /** 重置指定用户密码 */
  async resetUserPassword(userId: string, newPassword: string): Promise<void> {
    await apiClient.patch<void>(`/admin/users/${userId}/password`, { newPassword });
  },

  /** 删除用户 */
  async deleteUser(userId: string): Promise<void> {
    await apiClient.delete<void>(`/admin/users/${userId}`);
  },

  /** 设置/取消管理员权限 */
  async setUserAdmin(userId: string, isAdmin: boolean): Promise<void> {
    await apiClient.patch<void>(`/admin/users/${userId}/admin`, { isAdmin });
  },

  /** 获取系统统计 */
  async getStats(): Promise<AdminStats> {
    return apiClient.get<AdminStats>('/admin/stats');
  },
};
