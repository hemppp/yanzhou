// ============================================================
// 用户 AI 配置 loader 的注册（跨路由共享）
//
// 背景：POST /api/ai/config 设置的 loader **只存在内存里**。server 重启后，
// 或者用户压根没进过 AI 设置页时，`configLoaders.get(userId)` 是 undefined，
// `getAIConfig(userId)` 就会静默回退到 `loadConfigFromEnv()`（服务端环境变量）。
//
// ★ 这个回退是**静默**的，所以踩坑时毫无提示。2026-09-17 实际踩到：
//   「AI 智能体讨论不显示思维链」——根因就是讨论走的是插件路由
//   `/api/plugins/autowrite/session`，而 ensureConfigMiddleware 只挂在 `/api/ai/*` 上；
//   用户不进设置页 → loader 没注册 → 讨论静默改用环境变量里的默认模型，
//   该模型**不吐 reasoning_content** → 思维链永远是空的（且不报任何错）。
//
// 所以：**任何会调 AI 的路由（含插件路由）都必须先过这里**。
// 抽成独立模块而不是留在 modules/ai.ts，是为了让 plugin/host.ts 也能用而不引入循环依赖。
// ============================================================

import type { Context, Next } from 'hono';
import { getDb, schema, eq } from '@novel/db';
import {
  configLoaders,
  setConfigLoader,
} from './providers/provider-factory.js';

/**
 * 确保指定用户的 AI 配置 loader 已注册（幂等：已注册直接返回）。
 *
 * loader 不存在时从 `user_settings.ai_provider_config` 读取并注册；
 * 用户没配过则 cfg 为空，回退到服务端环境变量配置。
 */
export async function ensureUserConfigLoader(userId: string): Promise<void> {
  if (!userId) return;
  if (configLoaders.has(userId)) return;
  const db = getDb();
  if (!db) return;
  try {
    const rows = db.select({ aiProviderConfig: schema.userSettings.aiProviderConfig })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, userId))
      .all();
    const cfg = rows.length > 0 && rows[0]?.aiProviderConfig
      ? rows[0].aiProviderConfig as {
          baseUrl?: string; apiKey?: string; model?: string; provider?: string;
          temperature?: number; topP?: number; frequencyPenalty?: number; presencePenalty?: number;
        }
      : {};
    // 注册 loader（即使 cfg 为空，loader 也会回退到服务端环境变量）
    setConfigLoader(userId, async () => ({
      baseUrl: cfg.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: cfg.apiKey || process.env.OPENAI_API_KEY || '',
      model: cfg.model || process.env.OPENAI_MODEL || 'gpt-4-turbo',
      provider: (cfg.provider as 'openai' | 'ollama' | 'custom') || 'openai',
      // 采样参数原样带出（未配 = undefined = 不发该字段，保持原行为）
      ...(typeof cfg.temperature === 'number' ? { temperature: cfg.temperature } : {}),
      ...(typeof cfg.topP === 'number' ? { topP: cfg.topP } : {}),
      ...(typeof cfg.frequencyPenalty === 'number' ? { frequencyPenalty: cfg.frequencyPenalty } : {}),
      ...(typeof cfg.presencePenalty === 'number' ? { presencePenalty: cfg.presencePenalty } : {}),
    }));
    // 诊断日志：打印配置概要（隐藏 apiKey 中间部分）
    const maskedKey = cfg.apiKey
      ? `${cfg.apiKey.slice(0, 6)}...${cfg.apiKey.slice(-4)}`
      : '(空)';
    console.log(`[AI Config] 用户 ${userId} 配置: baseUrl=${cfg.baseUrl || '(默认)'}, model=${cfg.model || '(默认)'}, provider=${cfg.provider || 'openai'}, apiKey=${maskedKey}`);
  } catch (e) {
    console.warn(`[AI Config] 初始化用户 ${userId} 配置 loader 失败:`, e);
  }
}

/**
 * Hono 中间件：在会调 AI 的路由前确保 loader 已注册。
 * **必须在 requireAuth 之后挂载**（要靠 c.get('user') 取用户）。
 */
export async function ensureConfigMiddleware(c: Context, next: Next): Promise<void> {
  const user = c.get('user') as { id?: string } | undefined;
  if (user?.id) {
    await ensureUserConfigLoader(user.id);
  }
  await next();
}
