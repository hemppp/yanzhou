// ============================================================
// ui-kit/ui/utils.ts —— shadcn 的 `cn()` 类名合并器
//
// 为什么放在 ui-kit（plugins/shared）而不是 apps/web：
//   1) **门禁**：manual / auto 两个 workbench **禁止** import kernel 内部路径
//      （scripts/verify/verify-workbench-isolation.mjs 的 K2A/A2M 边），
//      组件放 apps/web 会导致两侧只能"抄一份"或违规引用；
//      放 shared 则 kernel 与两个模块都能合法 import（kernel→shared 不是禁边）。
//   2) ui-kit 已是全仓**唯一**的共享 UI 落点（ToastProvider / primitives / aiBars 都在此）。
//
// ⚠️ 前缀沿用 `@novel-plugins/ui-kit/ui/*`（tsconfig 的 `/*` 映射 + vite 前缀别名都通），
//    不要改成相对路径跨包引用。
// ============================================================

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并类名：clsx 负责条件拼接，tailwind-merge 负责**消解同类冲突**
 * （后写的胜出）—— shadcn 组件允许外部用 className 覆盖内部样式，靠的就是它。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
