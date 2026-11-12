// ============================================================
// .env 引导（必须在其它模块之前被 import）
// ------------------------------------------------------------
// 背景：tsx 4.x **不会**自动加载 .env；此前只能靠 `tsx --env-file=…`
//   手动传（scripts / start-dev.cmd 里都容易漏），一漏就静默丢配置
//   （PORT / HOST_MODE / AI 配置… 全部回退默认值）。
// 方案：用 Node 原生 `process.loadEnvFile()`（Node ≥20.12 / 本项目 Node ≥24）
//   从**仓库根**加载 .env。
// 语义（关键）：loadEnvFile **不覆盖**已存在的 process.env ——
//   · 桌面端由主进程注入的 HTTPS_PROXY / DISABLE_PROXY_DETECT 等仍然胜出；
//   · shell 里显式导出的变量也胜出。只有「进程里没有」的键才从 .env 补入。
// 定位：与 @novel/db 同法 —— 从本文件向上找 pnpm-workspace.yaml 定为仓库根，
//   因此无论 cwd 是仓库根还是 apps/server，都能找到同一份 .env。
// 打包态：桌面/部署环境没有 .env，existsSync 守卫直接跳过，零副作用。
// ============================================================

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 从 start 向上找到含 pnpm-workspace.yaml 的目录；找不到则返回 start。 */
function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/**
 * 从仓库根加载 .env（若存在）。幂等，失败只告警不阻断启动。
 * @returns 实际加载的 .env 绝对路径；未加载（不存在）时返回 null。
 */
export function loadDotEnv(): string | null {
  // 定位本模块源码位置。CJS 打包（esbuild，桌面端）下 import.meta.url 为 undefined
  // ⇒ 既无源码位置可锚定，打包态也**没有** .env，直接静默跳过（勿告警）。
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
  try {
    const envPath = join(findRepoRoot(here), '.env');
    if (!existsSync(envPath)) return null;
    process.loadEnvFile(envPath);
    return envPath;
  } catch (e) {
    console.warn('[Env] .env 加载失败（忽略，继续用现有环境变量）:', (e as Error).message);
    return null;
  }
}

// 顶层副作用：被 import 即加载。日志延后到微任务，避免打乱宿主启动日志顺序。
const loaded = loadDotEnv();
if (loaded) {
  queueMicrotask(() => console.log(`[Env] 已加载 ${loaded}`));
}
