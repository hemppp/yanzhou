// ============================================================
// AI 工具：create_plugin —— 让 AI 对话具备创建插件的能力
//
// AI（LLM）通过 function calling 调用此工具，传入插件语义化参数：
//   { id, name, description, permissions?, dependsOn?, serverCode?, webCode? }
// 工具负责：
//   1. 校验 id 合法性 + manifest（zod）
//   2. 生成插件文件到 apps/plugins/local/{id}/（serverCode/webCode 缺省时用内置模板）
//   3. 运行时挂载（非路由扩展点即时生效；路由标记重启生效）
//   4. 返回结果（成功 + 生效范围说明）
//
// 安全约束：
//   - id 必须 ^[a-z0-9]+(\.[a-z0-9]+)+$（防目录穿越）
//   - 不暴露 delete 类能力，插件运行在宿主沙箱（失败隔离）
//   - 写入目录固定为 LOCAL_PLUGINS_DIR/{id}，禁止 ../
// ============================================================

import { mkdirSync, writeFileSync, existsSync, renameSync, rmSync } from 'fs';
import { join, resolve, sep } from 'path';
import { validateManifest, type PluginEntry } from '@novel/core';
import type { ToolDefinition } from '../providers/provider-factory.js';
import { LOCAL_PLUGINS_DIR, localEntryFromMeta, listLocalPlugins } from '../../plugin/local-scanner.js';

// ---- 宿主注入（index.ts 启动时设置；避免 host.ts ↔ tools 循环依赖）----

interface HostLike {
  addPluginEntry(entry: PluginEntry): Promise<{ ok: boolean; error?: string }>;
}
let hostRef: HostLike | null = null;
export function setPluginHostForTools(host: HostLike | null): void {
  hostRef = host;
}

// ---- 模板 ----

const ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9]+)+$/;

/** 生成代码/注释用的安全文本：剥离引号、反引号、模板语法等字符，限长 */
function commentSafe(input: string, maxLen = 60): string {
  const cleaned = input.replace(/[`"'\\$<>{}]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, maxLen) || 'AI 插件';
}

/** 安全的 JS 字符串字面量：把任意输入嵌入生成代码的字符串位置（含引号/换行转义） */
function jsStringLiteral(input: string): string {
  return JSON.stringify(String(input)).replace(/'/g, '\\u0027');
}

const MAX_PLUGIN_NAME_LENGTH = 60;
const MAX_PLUGIN_DESCRIPTION_LENGTH = 500;
const MAX_PLUGIN_CODE_LENGTH = 200_000;

/** 通用插件模板（server 面）：KV CRUD 路由 + AI 工具 + 事件示例 */
function serverTemplate(id: string, name: string): string {
  const shortId = id.split('.').pop() ?? 'item';
  const safeName = commentSafe(name);
  const nameLit = jsStringLiteral(name);
  return `// ${safeName} —— 由 AI 对话创建（create_plugin 工具）
import { Hono } from 'hono';
import type { ServerPluginContext } from '@novel/core';

export const name = '${id}';
export const inject = ['routes', 'db', 'ai', 'events'];

export function apply(ctx: ServerPluginContext): void {
  const router = new Hono();

  // 列表：从插件 KV 读取（项目隔离）
  router.get('/', async (c) => {
    const projectId = c.req.header('x-project-id');
    const items = ctx.db.kv.list('${id}', 'item:', { projectId });
    return c.json({ items: items.map((f) => f.value) });
  });

  // 创建：写入插件 KV
  router.post('/', async (c) => {
    const projectId = c.req.header('x-project-id');
    if (!projectId) return c.json({ error: '缺少 X-Project-Id 头' }, 400);
    const body = await c.req.json<{ name?: string; note?: string }>();
    if (!body.name) return c.json({ error: 'name 必填' }, 400);
    const id = \`\${Date.now()}-\${Math.random().toString(36).slice(2, 8)}\`;
    const item = { id, name: body.name, note: body.note ?? '', createdAt: Date.now() };
    await ctx.db.kv.set('${id}', \`item:\${id}\`, item, { projectId });
    return c.json({ item });
  });

  router.delete('/:id', async (c) => {
    const projectId = c.req.header('x-project-id');
    await ctx.db.kv.delete('${id}', \`item:\${c.req.param('id')}\`, { projectId });
    return c.json({ ok: true });
  });

  ctx.effect(() => ctx.routes.register('/api/plugins/${shortId}', router), '${id}: routes');

  // AI 工具：创建条目
  ctx.ai.tools.register(
    { type: 'function', function: { name: 'create_${shortId}', description: '创建一条${nameLit}记录', parameters: { type: 'object', properties: { name: { type: 'string', description: '名称' }, note: { type: 'string', description: '备注' } }, required: ['name'] } } },
    async (args, toolCtx) => {
      const itemId = \`\${Date.now()}-\${Math.random().toString(36).slice(2, 8)}\`;
      const item = { id: itemId, name: String(args.name ?? ''), note: String(args.note ?? ''), createdAt: Date.now() };
      await ctx.db.kv.set('${id}', \`item:\${itemId}\`, item, { projectId: toolCtx.projectId });
      return { success: true, result: JSON.stringify(item), entity: { type: 'outline' as never, action: 'create', id: itemId, name: item.name } };
    },
  );

  // 事件订阅示例：章节保存时计数
  ctx.events.on('chapter.saved', async (payload: { projectId: string }) => {
    const count = ctx.db.kv.get<number>('${id}', 'stats.chapters', { projectId: payload.projectId }) ?? 0;
    await ctx.db.kv.set('${id}', 'stats.chapters', count + 1, { projectId: payload.projectId });
  });

  ctx.logger.info(${nameLit} + ' Server 面已挂载');
}
`;
}

/** 通用插件模板（web 面）：项目面板 + 设置 section */
function webTemplate(id: string, name: string): string {
  const shortId = id.split('.').pop() ?? 'item';
  const safeName = commentSafe(name);
  const nameLit = jsStringLiteral(name);
  return `// ${safeName} —— 由 AI 对话创建（create_plugin 工具）
import React from 'react';
import { Sparkles } from 'lucide-react';
import type { WebPluginContext, WebApiFetch } from '@novel/core/web';

// ★ 带鉴权 API（C7）：服务端 /api/plugins/* 默认要求登录，必须经 ctx.api 访问
let apiFetch: WebApiFetch = (path, init) => fetch(path, init);

function ${shortId[0].toUpperCase()}${shortId.slice(1)}Panel() {
  const [items, setItems] = React.useState<Array<{ id: string; name: string; note: string }>>([]);
  const [loading, setLoading] = React.useState(true);
  const [name, setName] = React.useState('');

  const load = React.useCallback(() => {
    setLoading(true);
    apiFetch('/api/plugins/${shortId}')
      .then((r) => r.json())
      .then((data) => setItems(data.items ?? []))
      .catch((err) => console.warn('[${id}] 加载失败', err))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(load, [load]);

  const create = async () => {
    if (!name.trim()) return;
    await apiFetch('/api/plugins/${shortId}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    setName('');
    load();
  };

  return (
    <div className="p-4 space-y-3 overflow-y-auto">
      <div className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="新条目..." className="flex-1 px-3 py-1.5 rounded-lg border text-sm" onKeyDown={(e) => e.key === 'Enter' && create()} />
        <button onClick={create} className="px-3 py-1.5 rounded-lg text-sm" style={{ background: 'hsl(var(--primary))', color: '#fff' }}>新增</button>
      </div>
      {loading && <div className="text-sm opacity-60">加载中...</div>}
      {!loading && items.length === 0 && <div className="text-sm opacity-60">暂无条目，输入名称创建一个</div>}
      {items.map((it) => (
        <div key={it.id} className="rounded-lg border p-3">
          <div className="font-medium">{it.name}</div>
          {it.note && <div className="text-xs opacity-60 mt-0.5">{it.note}</div>}
        </div>
      ))}
    </div>
  );
}

export const name = '${id}';
export const inject = ['projectPanels', 'commands', 'settings'];

export function apply(ctx: WebPluginContext): void {
  apiFetch = ctx.api; // 注入带鉴权 fetch（C7）
  ctx.registerProjectPanel({ key: '${shortId}', label: ${nameLit}, icon: Sparkles, Component: ${shortId[0].toUpperCase()}${shortId.slice(1)}Panel, width: 480, height: 640 });
  ctx.registerSettingsSection({
    key: '${id}.settings',
    title: ${nameLit},
    description: '在设置页管理' + ${nameLit} + '（与工作台面板共享同一份数据）',
    icon: Sparkles,
    category: 'plugins',
    Component: ${shortId[0].toUpperCase()}${shortId.slice(1)}Panel,
  });
  ctx.registerCommand({ id: '${id}.add', title: '打开' + ${nameLit}, keywords: [${nameLit}], run: () => { window.dispatchEvent(new CustomEvent('nm:open-panel', { detail: { key: '${shortId}' } })); } });
  ctx.logger.info(${nameLit} + ' Web 面已挂载');
}
`;
}

// ---- 工具实现 ----

export interface CreatePluginArgs {
  id: string;
  name: string;
  description?: string;
  permissions?: string[];
  dependsOn?: string[];
  serverCode?: string;
  webCode?: string;
}

export async function createPlugin(args: CreatePluginArgs, ctx: { projectId: string; user?: { id?: string } }): Promise<{ success: boolean; result: string }> {
  // 本地版没有账号/管理员，不再做角色闸门；保留下面的自定义源码安全策略。

  // ★ 自定义源码闸门：serverCode 会在服务端进程内动态 import 执行。
  //   默认只允许内置固定模板；确需自定义源码时显式设置 PLUGIN_ALLOW_CUSTOM_CODE=1。
  if ((args.serverCode || args.webCode) && process.env.PLUGIN_ALLOW_CUSTOM_CODE !== '1') {
    return {
      success: false,
      result: '自定义插件源码创建已被安全策略禁用（省略 serverCode/webCode 可使用内置固定模板；如确需自定义，请设置环境变量 PLUGIN_ALLOW_CUSTOM_CODE=1 后重试）',
    };
  }

  // 1. 安全校验 + id 规范化
  //    LLM 常生成带连字符/下划线的 id（如 novel.test-items）→ 自动归一化为小写字母数字+点
  const rawId = String(args.id ?? '').trim().toLowerCase();
  const id = rawId.replace(/[^a-z0-9.]+/g, '');
  const name = String(args.name ?? '').trim();
  if (!name || name.length > MAX_PLUGIN_NAME_LENGTH) {
    return { success: false, result: `插件名称长度必须在 1-${MAX_PLUGIN_NAME_LENGTH} 字符之间` };
  }
  if (args.description && args.description.length > MAX_PLUGIN_DESCRIPTION_LENGTH) {
    return { success: false, result: `插件描述过长（上限 ${MAX_PLUGIN_DESCRIPTION_LENGTH} 字符）` };
  }
  if ((args.serverCode?.length ?? 0) > MAX_PLUGIN_CODE_LENGTH || (args.webCode?.length ?? 0) > MAX_PLUGIN_CODE_LENGTH) {
    return { success: false, result: `插件源码过长（单面上限 ${MAX_PLUGIN_CODE_LENGTH} 字符）` };
  }
  if (!ID_PATTERN.test(id)) {
    return { success: false, result: `插件 id 非法：必须为反向域名风格（仅小写字母数字和点，如 novel.worldbuilding）。收到 "${rawId}"${id !== rawId ? `（已尝试归一化为 "${id}" 仍不合法）` : ''}` };
  }
  if (id !== rawId) {
    return createPluginInternal({ ...args, id, name }, ctx, `（id 已自动归一化：${rawId} → ${id}）`);
  }
  if (!name) {
    return { success: false, result: '缺少插件名称（name）' };
  }
  return createPluginInternal({ ...args, id, name }, ctx, '');
}

async function createPluginInternal(args: CreatePluginArgs, ctx: { projectId: string; user?: { id?: string } }, prefixNote: string): Promise<{ success: boolean; result: string }> {
  const { id, name } = args;
  // ★ 目录使用完整规范化 id（含点号），杜绝不同完整 id 共享 shortId 导致的目录碰撞覆盖
  const dir = join(LOCAL_PLUGINS_DIR, id);
  const pluginsRoot = resolve(LOCAL_PLUGINS_DIR);
  if (!resolve(dir).startsWith(pluginsRoot + sep)) {
    return { success: false, result: '插件路径非法（目录越界）' };
  }
  if (existsSync(dir) || listLocalPlugins().some((m) => m.id === id)) {
    return { success: false, result: `插件 ${id} 已存在（拒绝覆盖）。如需重建，请先删除 apps/plugins/local/${id}/ 后重试` };
  }

  // 2. manifest
  const rawManifest = {
    id,
    name,
    description: args.description ?? '由 AI 对话创建的插件',
    version: '0.1.0',
    permissions: args.permissions ?? ['routes', 'db:project', 'ai:tools', 'events'],
    dependsOn: args.dependsOn ?? [],
    server: { inject: ['routes', 'db', 'ai', 'events'] },
    web: { inject: ['projectPanels', 'commands', 'settings'] },
    serverEntry: './server/index.ts',
    webEntry: './web/index.tsx',
  };

  try {
    validateManifest(rawManifest);
  } catch (err) {
    return { success: false, result: `manifest 校验失败: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 3. 写文件（原子：先写临时目录，全部成功后 rename 到正式目录；
  //    失败清理临时目录，不留可被扫描加载的半成品）
  const tmpDir = join(LOCAL_PLUGINS_DIR, `.tmp-${id.replace(/\./g, '-')}-${Date.now()}`);
  try {
    mkdirSync(join(tmpDir, 'server'), { recursive: true });
    mkdirSync(join(tmpDir, 'web'), { recursive: true });
    writeFileSync(join(tmpDir, 'plugin.json'), JSON.stringify(rawManifest, null, 2), 'utf-8');
    writeFileSync(join(tmpDir, 'server', 'index.ts'), args.serverCode ?? serverTemplate(id, name), 'utf-8');
    writeFileSync(join(tmpDir, 'web', 'index.tsx'), args.webCode ?? webTemplate(id, name), 'utf-8');
    renameSync(tmpDir, dir);
  } catch (err) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败仅记录 */ }
    return { success: false, result: `写入插件文件失败: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 4. 运行时挂载（若宿主已就绪）
  const meta = listLocalPlugins().find((m) => m.id === id);
  if (hostRef && meta) {
    try {
      const entry = localEntryFromMeta(meta);
      const r = await hostRef.addPluginEntry(entry);
      if (!r.ok) {
        return {
          success: true,
          result: `插件 ${id} 已创建（文件已写入 apps/plugins/local/${id}/），但运行时挂载未生效: ${r.error}。重启 server 后自动加载。`,
        };
      }
      return {
        success: true,
        result: `${prefixNote}✅ 插件「${name}」（${id}）已创建并挂载。文件位于 apps/plugins/local/${id}/。非路由扩展点（AI 工具/事件/面板/设置）已生效；若含新增路由，请重启 server 后完全生效（Hono 限制）。web 面板在 vite dev 下自动出现，刷新页面可见。`,
      };
    } catch (err) {
      return { success: true, result: `${prefixNote}插件 ${id} 已创建（文件已写入），运行时挂载失败: ${err instanceof Error ? err.message : String(err)}。重启 server 后自动加载。` };
    }
  }

  return { success: true, result: `${prefixNote}插件「${name}」（${id}）已创建，文件位于 apps/plugins/local/${id}/。重启 server 后自动加载（Web 面板构建时自动收集）。` };
}

/** 工具定义（LLM 可见） */
export const createPluginToolDef: ToolDefinition = {
  type: 'function',
  function: {
    name: 'create_plugin',
    description: '创建/安装一个新的插件（模块化功能扩展）。AI 对话可直接创建插件：传入 id（反向域名风格）、name、可选描述/权限/依赖，以及可选的 serverCode/webCode（缺省用通用模板：KV CRUD 路由 + 项目面板 + 设置区）。创建后写入 apps/plugins/local/{id}/ 并尝试运行时挂载。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '插件 id，反向域名风格，如 novel.worldbuilding（小写字母数字+点）' },
        name: { type: 'string', description: '插件展示名称，如「世界观建造师」' },
        description: { type: 'string', description: '插件描述' },
        permissions: { type: 'array', items: { type: 'string', enum: ['routes', 'db:global', 'db:project', 'ai:tools', 'ai:skills', 'ai:agents', 'ai:providers', 'events', 'settings', 'scheduler'] }, description: '权限声明（可选，默认 routes/db:project/ai:tools/events）' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: '依赖的其他插件 id（可选）' },
        serverCode: { type: 'string', description: '自定义 Server 面源码（TS，export { name, inject, apply(ctx) }）。缺省用通用模板' },
        webCode: { type: 'string', description: '自定义 Web 面源码（TSX，export { name, apply(ctx) }）。缺省用通用模板' },
      },
      required: ['id', 'name'],
    },
  },
};

/** 本地插件清单工具：让 AI 了解已有插件（避免重复创建） */
export async function listPluginsForAI(): Promise<{ success: boolean; result: string }> {
  const metas = listLocalPlugins();
  if (metas.length === 0) {
    return { success: true, result: '当前没有本地插件（apps/plugins/local/ 为空）' };
  }
  return {
    success: true,
    result: JSON.stringify(metas.map((m) => ({ id: m.id, name: m.rawManifest.name, description: m.rawManifest.description }))),
  };
}

export const listPluginsToolDef: ToolDefinition = {
  type: 'function',
  function: {
    name: 'list_local_plugins',
    description: '列出当前已安装的本地插件（apps/plugins/local/ 目录），创建新插件前可调用避免重复',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};
