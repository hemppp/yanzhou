// ============================================================
// JWT & Password 工具库
// 提供 Token 签发/验证、密码哈希/比较功能
//
// 依赖说明：需要先安装 jsonwebtoken 和 bcryptjs
//   pnpm --filter @novel/server add jsonwebtoken bcryptjs
//   pnpm --filter @novel/server add -D @types/jsonwebtoken @types/bcryptjs
// ============================================================

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- 类型定义 ----

/** JWT Payload - 只包含必要信息，不含敏感数据 */
export interface JwtPayload {
  userId: string;
  username: string;
  /** Token 唯一 ID（用于吊销机制） */
  jti?: string;
}

// ---- 配置 ----

/**
 * 定位 JWT 密钥持久化目录（与 packages/db 的数据路径锚定方式一致）：
 * 从本模块位置向上查找 pnpm-workspace.yaml 标记的项目根，取其 data/ 目录。
 * 这样无论进程 cwd 如何（dev tsx watch / 生产 dist / 桌面打包），密钥始终与数据库同目录，
 * 且已加入 .gitignore，不会被提交。
 */
function resolveJwtSecretDir(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url)); // dev: apps/server/src/lib · build: dist/lib
    for (;;) {
      if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return join(dir, 'data');
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url 不可用（CJS 打包）→ 回退 cwd/data
  }
  return join(process.cwd(), 'data');
}

/**
 * JWT 签名密钥解析。
 *
 * 安全最佳实践（security-best-practices）：
 * - 生产环境必须显式配置 JWT_SECRET；缺失时返回 undefined，
 *   由 index.ts 的启动守卫直接拒绝启动（不进入半可用状态）。
 * - 开发环境使用「持久化随机密钥」（data/.jwt-secret），
 *   避免 tsx watch 每次重启生成新密钥导致全部 token 失效，
 *   同时删除源码内公开的固定回退值 'novelmuse-dev-secret'——
 *   该值任何人可见，可据此伪造任意用户（含管理员）token。
 * - 仅当持久化完全失败（只读目录等）才回退到进程内随机密钥并告警。
 */
function resolveJwtSecret(): string | undefined {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') return undefined;

  // 候选目录：DB_PATH 所在目录优先（Docker 等显式场景），其次项目根 data/（与数据库同目录）
  const candidates = [
    process.env.DB_PATH ? dirname(process.env.DB_PATH) : null,
    resolveJwtSecretDir(),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file = join(dir, '.jwt-secret');
      if (existsSync(file)) {
        const existing = readFileSync(file, 'utf-8').trim();
        if (existing) return existing;
      }
      const secret = randomBytes(32).toString('hex');
      writeFileSync(file, secret, { encoding: 'utf-8', flag: 'wx' });
      return secret;
    } catch {
      // 并发创建竞争：另一个进程已写入 → 读取其值；仍失败则尝试下一个目录
      try {
        const existing = readFileSync(join(dir, '.jwt-secret'), 'utf-8').trim();
        if (existing) return existing;
      } catch {
        // 忽略，尝试下一候选目录
      }
    }
  }

  const ephemeral = randomBytes(32).toString('hex');
  console.warn('[JWT] ⚠️ 开发环境无法持久化 JWT 密钥，使用进程内随机密钥（重启后所有 token 失效）。');
  return ephemeral;
}

const JWT_SECRET = resolveJwtSecret();
// ★ 2026-11-12：默认有效期 3h → 30d（用户要求「登录状态保存一个月」）。
//   配合 apps/web 的 sessionKeepalive 滑动续期：活跃期间每 10 分钟换发新令牌，
//   因此 30d 是「**连续 30 天没有任何操作**才退出」，而不是活跃 30 天后强制掉线。
//   Cookie 的 maxAge 读同一个变量（lib/cookies.ts），两者不会各自漂移。
const DEFAULT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';
const BCRYPT_SALT_ROUNDS = 10;

if (!JWT_SECRET) {
  console.warn('[JWT] ⚠️  生产环境未设置 JWT_SECRET 环境变量！请立即配置（启动守卫将拒绝启动）。');
}

// ---- Token 吊销机制（blocklist） ----

/** 被吊销的 token ID 集合 */
const revokedTokenSet = new Set<string>();

/** jti -> exp 时间戳（秒）映射，用于定期清理已过期的吊销记录 */
const revokedTokenExp = new Map<string, number>();

/** 每 1 小时清理一次已过期的吊销记录 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function cleanupExpiredRevokedTokens(): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [jti, exp] of revokedTokenExp) {
    if (exp <= now) {
      revokedTokenSet.delete(jti);
      revokedTokenExp.delete(jti);
    }
  }
}

setInterval(cleanupExpiredRevokedTokens, CLEANUP_INTERVAL_MS).unref();

// ---- 公共 API ----

/**
 * 签发 JWT Token
 * @param payload - 用户载荷数据（userId, username）
 * @param expiresIn - 过期时间，默认取 JWT_EXPIRES_IN（缺省 30 天）
 * @returns 签发的 JWT 字符串
 */
export function signToken(payload: JwtPayload, expiresIn?: string): string {
  const secret = JWT_SECRET;
  if (!secret) {
    throw new Error('[JWT] JWT_SECRET 未配置，无法签发 Token');
  }
  const options: jwt.SignOptions = {
    expiresIn: (expiresIn || DEFAULT_EXPIRES_IN) as jwt.SignOptions['expiresIn'],
    jwtid: randomUUID(),
  };
  return jwt.sign(payload, secret as jwt.Secret, options);
}

/**
 * 验证 JWT Token
 * @param token - 待验证的 JWT 字符串
 * @returns 解码后的 payload
 * @throws Token 无效、过期或已被吊销时抛出错误
 */
export function verifyToken(token: string): JwtPayload {
  const secret = JWT_SECRET;
  if (!secret) {
    throw new Error('[JWT] JWT_SECRET 未配置，无法验证 Token');
  }
  try {
    const decoded = jwt.verify(token, secret) as JwtPayload & { jti?: string; exp?: number };
    // 验证通过后检查 jti 是否在 blocklist 中
    if (decoded.jti && isTokenRevoked(decoded.jti)) {
      throw new Error('Token 已被吊销');
    }
    return decoded;
  } catch (error) {
    // 转换为更具体的错误信息
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error('Token 已过期');
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error('Token 无效');
    }
    throw error;
  }
}

/**
 * 吊销 Token：验证 token 并将其 jti 加入 blocklist
 * @param token - 待吊销的 JWT 字符串
 * @throws Token 签名无效时抛出错误（过期 token 仍可吊销）
 */
export function revokeToken(token: string): void {
  const secret = JWT_SECRET;
  if (!secret) {
    throw new Error('[JWT] JWT_SECRET 未配置，无法验证 Token');
  }
  // 验证签名（允许过期 token 吊销，避免过期 token 无法加入黑名单）
  const decoded = jwt.verify(token, secret, { ignoreExpiration: true }) as JwtPayload & { jti?: string; exp?: number };
  if (!decoded.jti) {
    throw new Error('Token 缺少 jti 字段，无法吊销');
  }
  revokedTokenSet.add(decoded.jti);
  if (decoded.exp) {
    revokedTokenExp.set(decoded.jti, decoded.exp);
  }
}

/**
 * 检查 jti 是否已被吊销
 * @param jti - Token 唯一 ID
 * @returns 是否已吊销
 */
export function isTokenRevoked(jti: string): boolean {
  return revokedTokenSet.has(jti);
}

/**
 * 使用 bcrypt 哈希密码
 * @param password - 明文密码
 * @returns 哈希后的密码字符串
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

/**
 * 比较明文密码与哈希值
 * @param password - 明文密码
 * @param hash - 存储的哈希值
 * @returns 是否匹配
 */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
