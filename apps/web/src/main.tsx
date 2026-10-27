import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// ★ VS Code Dark Modern token 层必须**最先**引入：它定义 :root / html.dark 的
//   全量 --vscode-* 变量，并把旧 shadcn/daisyUI 变量位映射到它们之上。
//   定义在 :root 意味着**任何插件包无需 import 本文件**即可消费（ADR 约定 C-1）。
import '@novel-plugins/ui-kit/styles/vscode-dark-modern.css';
import './styles/globals.css';
import { registerProjectIdGetter, resolveApiUrl } from './services/api/apiClient';
import { applyStoredTheme } from './stores/themeStore';

// ★ 首屏渲染前同步应用本地主题，否则会先闪一下默认配色再切换
applyStoredTheme();
import { useProjectStore } from './stores';
import { mountWebPlugin, type WebPluginEntry } from './plugin/host';
import type { WebPluginModule } from './plugin/types';
import { pluginModeFromDir } from '@novel/core/web';

// 注册 projectId getter：apiClient 在每次请求时读取，自动注入 X-Project-Id 头部。
// 后端项目级路由根据此头部初始化对应的项目库（每本书独立 .db 文件）。
registerProjectIdGetter(() => useProjectStore.getState().currentProject?.id);

// ★ 插件挂载前先对齐 Server 端状态（novel-plugin-standard/1.0）：
//   Server 侧被禁用 / 安装门拒绝 / 挂载失败的插件，Web 面不再挂载，
//   避免"面板还在、接口全 404"的半坏状态。Server 不可达时放行全部（保持离线可打开）。
async function fetchServerPluginStates(): Promise<Map<string, string> | null> {
  try {
    const res = await fetch(resolveApiUrl('health'));
    if (!res.ok) return null;
    const data = (await res.json()) as { plugins?: Array<{ id: string; status: string }> };
    return new Map((data.plugins ?? []).map((p) => [p.id, p.status]));
  } catch {
    return null;
  }
}

// ★ 本地插件 Web 面 —— vite 构建期静态收集（import.meta.glob），
//   覆盖 apps/plugins/{manual,auto,shared,local}/*/web/index.tsx 四个模式目录；
//   AI 创建的插件落盘后自动进入此集合；新增文件需重启 vite dev（或重新构建）后生效。
//   单个失败只禁用该插件。
async function mountAllWebPlugins(): Promise<void> {
  const states = await fetchServerPluginStates();
  // 仅当 Server 明确报告该插件状态非 ok 时拦截；Server 不可达 / 纯 Web 插件（无 Server 面）不拦截
  const blocked = (id: string): boolean => {
    const st = states?.get(id);
    return st !== undefined && st !== 'ok';
  };

  // 内置插件 + 外部插件统一在此登记（构建期清单），每条显式带 modes。
  // ★ D36-⑦：manual / auto 两大模块的内置面板清单**不再静态登记**——
  //   模块入口 `apps/plugins/{manual,auto}/workbench/web/index.tsx` 由下方
  //   import.meta.glob 自动收集（与既有模式目录插件同一机制）。
  //   好处：模块缺席 ⇒ 其入口文件不存在 ⇒ 不被 glob 收集 ⇒ 无悬空 import，
  //   天然满足「任一模块关闭后另一模块仍完全可用」。
  const staticEntries: WebPluginEntry[] = [
    // 世界观建造师示例插件（面板 + 命令 + 选区动作 + 编辑器扩展）
    { id: 'novel.worldbuilding', load: () => import('@novel-plugins/worldbuilding/web'), modes: ['manual'] },
    // 外部插件在此追加：{ id: 'xxx', load: () => import('@novel-plugins/xxx/web'), modes: [...] }
  ];
  for (const entry of staticEntries) {
    if (blocked(entry.id)) {
      console.warn(`[plugins] Web 面跳过 ${entry.id}（Server 端状态: ${states?.get(entry.id)}）`);
      continue;
    }
    await mountWebPlugin(entry.id, entry.load, entry.modes);
  }

  // 模式目录插件自动收集挂载：apps/plugins/{manual,auto,shared,local}/*/web/index.tsx
  // 适用模式由父目录名推导（local → shared），随 mountWebPlugin 一起登记到各扩展点条目。
  const modules = import.meta.glob([
    '../../../apps/plugins/manual/*/web/index.tsx',
    '../../../apps/plugins/auto/*/web/index.tsx',
    '../../../apps/plugins/shared/*/web/index.tsx',
    '../../../apps/plugins/local/*/web/index.tsx',
  ]);
  for (const [path, loader] of Object.entries(modules)) {
    try {
      const mod = (await loader()) as WebPluginModule;
      const match = path.match(/plugins\/(manual|auto|shared|local)\/([^/]+)\/web\/index\.tsx$/);
      const dir = match?.[1] ?? '';
      const shortId = match?.[2] ?? 'unknown';
      // 模式事实来源 = 父目录名（与 @novel/core 的安装门一致）
      const modes = pluginModeFromDir(dir);
      if (!modes) {
        console.warn(`[plugins] 未知插件目录，跳过: ${path}`);
        continue;
      }
      const id = typeof mod.name === 'string' && mod.name ? mod.name : `local.${shortId}`;
      if (blocked(id)) {
        console.warn(`[plugins] Web 面跳过 ${id}（Server 端状态: ${states?.get(id)}）`);
        continue;
      }
      await mountWebPlugin(id, async () => mod, [modes]);
      console.debug(`[local-plugins] Web 面已挂载: ${id} (${path}, modes: ${modes})`);
    } catch (err) {
      console.error(`[local-plugins] Web 面挂载失败 (${path}):`, err);
    }
  }
}

void mountAllWebPlugins();

// 初始化数据库——仅在 Node 环境（Electron/SSR）下需要。
// 浏览器 SPA 走 localStorage 桥接（见 services/data/databaseService.ts），
// 无需 sql.js wasm 加载，避免主 bundle 膨胀。
const isBrowser = typeof window !== 'undefined';
if (!isBrowser) {
  void import('@novel/db').then(({ initDatabase }) =>
    initDatabase().catch((err: unknown) => {
      console.error('[砚舟] 数据库初始化失败（非致命）:', err);
    }),
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
