// ============================================================
// apps/desktop/src/updater/config.ts
// 更新源地址（baseUrl）的持久化。
//
// 契约来源：ADR D14.1 ——
//   持久化位置：`<userData>/updates/config.json`，`{ "baseUrl": "…" }`。
//   **不是** localStorage（主进程需要在渲染进程未起时也能读）。
//   配置为空 ⇒ 使用内置更新源（DEFAULT_UPDATE_BASE_URL）；显式填非法值才会被拒绝。
// ============================================================

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

/**
 * 内置更新源。
 *
 * 更新器此前**没有默认值**：首次启动 baseUrl 是空串，「检查更新」按钮直接禁用，
 * 用户不知道该填什么地址 —— 等于应用内更新从未可用。
 *
 * 指向 GitHub Release 的 latest/download 别名：它永远解析到最新正式版，
 * 无需随版本改地址；清单与产物都在同一个 release 里，相对 url 天然成立。
 */
export const DEFAULT_UPDATE_BASE_URL =
  'https://github.com/hemppp/yanzhou/releases/latest/download';

export interface UpdaterConfig {
  baseUrl: string;
}

/** 读取配置；文件缺失 / 损坏 / 非法一律回落到内置更新源（不抛）。 */
export async function readConfig(configPath: string): Promise<UpdaterConfig> {
  try {
    const raw = await fsp.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { baseUrl?: unknown }).baseUrl === 'string') {
      const configured = (parsed as { baseUrl: string }).baseUrl;
      // ★ 空串沿用内置源：配置为空意味着「用户没改过」，不是「关掉更新」。
      //   此前空串直接导致「检查更新」按钮禁用，应用内更新形同不存在。
      return { baseUrl: configured.trim() === '' ? DEFAULT_UPDATE_BASE_URL : configured };
    }
    return { baseUrl: DEFAULT_UPDATE_BASE_URL };
  } catch {
    return { baseUrl: DEFAULT_UPDATE_BASE_URL };
  }
}

/**
 * 写入配置（原子写：先写 `.tmp` 再 rename，避免半截文件）。
 * 目录不存在时自动创建。
 */
export async function writeConfig(configPath: string, config: UpdaterConfig): Promise<void> {
  const dir = path.dirname(configPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${configPath}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify({ baseUrl: config.baseUrl }, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, configPath);
}

/**
 * 规范化 baseUrl：去掉尾随 `/`，允许空串。
 * 便于 `${baseUrl}/manifest.json` 与相对 `url` 的解析。
 */
export function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl ?? '').trim().replace(/\/+$/, '');
}

/**
 * 校验更新源协议：**必须是 `http:` 或 `https:`**（ADR D14.2 冻结：
 * 「更新源必须是 http: 或 https:；其他协议拒绝」）。
 * 空串视为「关闭」，返回 null（合法）。
 */
export function validateBaseUrl(baseUrl: string): { ok: true } | { ok: false; error: string } {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized === '') return { ok: true };
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, error: `更新源地址不是合法 URL: ${normalized}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `更新源地址协议不被支持（仅允许 http: / https:）: ${parsed.protocol}` };
  }
  return { ok: true };
}

/** `${baseUrl}/manifest.json`（ADR D14.1：清单地址 = `${baseUrl}/manifest.json`）。 */
export function manifestUrlOf(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/manifest.json`;
}

/**
 * 解析清单里的 `url` 字段：允许**相对路径**（相对 baseUrl 解析）或绝对 `http(s):` URL
 * （ADR D14.2 冻结）。其他协议拒绝。
 */
export function resolveArtifactUrl(baseUrl: string, artifactUrl: string): string {
  const raw = String(artifactUrl ?? '').trim();
  if (raw === '') throw new Error('manifest 中的 url 为空');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`url 协议不被支持（仅允许 http: / https:）: ${parsed.protocol}`);
    }
    return parsed.toString();
  }
  const base = `${normalizeBaseUrl(baseUrl)}/`;
  const resolved = new URL(raw.replace(/^\/+/, ''), base);
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new Error(`url 协议不被支持（仅允许 http: / https:）: ${resolved.protocol}`);
  }
  return resolved.toString();
}