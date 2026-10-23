// ============================================================
// 自动写作 —— Web 面带鉴权 API 句柄
//
// 由 apply() 注入 ctx.api（自动带 JWT / 项目头），供本插件 Web 面复用。
//
// ★ 2026-09-28：原 `panel.tsx`（441 行，含 AutowriteSkillRail / AutowritePanel
//   两个从未注册的死组件）已删除 —— 它们轮询的 `/batches` 路由随旧批次流水线一并移除。
//   只把仍在用的 `setApiFetch` 留下，迁到本文件。
// ============================================================

import type { WebApiFetch } from '@novel/core/web';

let apiFetch: WebApiFetch = (path, init) => fetch(path, init);

/** 由 apply() 注入（替代裸 fetch） */
export function setApiFetch(fn: WebApiFetch): void {
  apiFetch = fn;
}

/** 带鉴权的 API 调用（供日后需要时的插件 Web 面复用） */
export function api(path: string, init?: RequestInit): Promise<Response> {
  return apiFetch(path, init);
}
