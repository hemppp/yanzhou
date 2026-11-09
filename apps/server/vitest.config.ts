import { fileURLToPath } from 'node:url';
import { defineConfig, configDefaults } from 'vitest/config';

/** 解析到本仓 packages/* 的 TS 源码入口（Windows 下必须走 fileURLToPath，不能用 URL.pathname） */
const pkg = (p: string) => fileURLToPath(new URL(`../../packages/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    // ★ 2026-11-09：插件测试文件位于 apps/plugins/...，向上查找 node_modules 只到
    //   apps/，碰不到 apps/server/node_modules/@novel/* 的 pnpm 软链；git worktree
    //   更是整个 node_modules 都不带。显式映射到 packages/*/src（均为 TS 源码入口），
    //   让 server 套件无论在主仓还是 worktree 都能解析工作区包。
    alias: {
      // 顺序敏感：更具体的 '@novel/core/web' 必须排在 '@novel/core' 之前
      '@novel/core/web': pkg('core/src/web.ts'),
      '@novel/core': pkg('core/src/index.ts'),
      '@novel/db': pkg('db/src/index.ts'),
      '@novel/shared': pkg('shared/src/index.ts'),
    },
  },
  test: {
    // ★ 2026-11-09：恢复 t10（AI 写作模块剥离）时被删掉的第二个 include。
    //   模块已于 6207fe3「AI 写作大模块回仓」装回，但本行一直没恢复 —— 于是
    //   novel.autowrite 的 13 个测试文件 / 266 用例长期没有任何 runner 覆盖
    //   （18 条失败因此无人看见，直到本次基线才暴露）。
    //   模块自带的独立跑法见 apps/plugins/auto/novel.autowrite/vitest.config.ts。
    //   注：exclude 里的 `**/node_modules/**` 仍保留 —— 插件目录下的 node_modules
    //   副本仍可能被其它 glob 扫到，且它是通用护栏。
    include: ['src/**/*.test.ts', '../plugins/auto/novel.autowrite/server/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/node_modules/**'],
    environment: 'node',
    // 插件挂载涉及动态 import + SQLite 初始化，整体较慢
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // 每个测试文件独立进程：宿主/DB 全局状态不互相污染
    pool: 'forks',
  },
});
