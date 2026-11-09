import { fileURLToPath } from 'node:url';
import { defineConfig, configDefaults } from 'vitest/config';

const here = fileURLToPath(new URL('.', import.meta.url));
// 工作区包在**主仓**里靠 `apps/plugins/auto/novel.autowrite/node_modules/@novel/*`
// 的 pnpm 软链解析；但 git worktree 不携带 node_modules，且测试文件本身位于
// apps/plugins/... —— 向上查找只到 apps/，永远碰不到 apps/server/node_modules。
// 故此处显式 alias 到本仓 packages/*/src（两者均为 TS 源码入口，见各自 package.json）。
const workspace = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));

export default defineConfig({
  // Vite 的 root 默认是 process.cwd()，不是配置文件所在目录 —— 不显式钉住的话，
  // 从仓库根跑 `vitest run --config .../vitest.config.ts` 会因 include 相对 cwd
  // 而命中 0 文件（实测：「No test files found」）。
  root: here,
  resolve: {
    alias: {
      '@novel/db': workspace('packages/db/src/index.ts'),
      '@novel/core': workspace('packages/core/src/index.ts'),
    },
  },
  test: {
    // 2026-11-09：本模块自 6207fe3「AI 写作大模块回仓」起没有任何 runner 覆盖
    //（apps/server/vitest.config.ts 的 include 在剥离时删掉了指向本目录的那一行）。
    // 本配置是模块自带的跑法：`vitest run --config apps/plugins/auto/novel.autowrite/vitest.config.ts`。
    include: ['server/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/node_modules/**'],
    environment: 'node',
    // 与 apps/server 一致：涉及 SQLite 初始化 + 动态 import，整体较慢
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
