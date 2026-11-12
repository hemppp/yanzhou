// ============================================================
// 插件管理器（内置插件）—— 查看/开关插件、检查全局依赖
//
// 由宿主在启动时以"插件"身份挂载（演示"管理功能本身也是插件"）。
// 路由：GET /api/plugin-manager、GET /api/plugin-manager/deps、
//       POST /api/plugin-manager/:id/enable、POST /api/plugin-manager/:id/disable
// 本地版没有账号/管理员，管理接口不再做鉴权。
// ============================================================

import { Hono } from 'hono';
import type { ServerPluginHost } from './host.js';
import type { ServerPluginContext } from './types.js';
import type { PluginEntry, PluginModule } from '@novel/core';

/** 构造插件管理器条目（宿主闭包注入：插件需要访问 host 实例） */
export function createPluginManagerEntry(getHost: () => ServerPluginHost): PluginEntry {
  return {
    id: 'novel.plugin-manager',
    source: 'builtin',
    manifest: {
      id: 'novel.plugin-manager',
      name: '插件管理器',
      description: '查看/开关插件、检查全局互相依赖',
      version: '0.1.0',
      permissions: ['routes'],
      server: { inject: ['routes'] },
    },
    load: async (): Promise<PluginModule> => createPluginManagerPlugin(getHost),
  };
}

export function createPluginManagerPlugin(getHost: () => ServerPluginHost): PluginModule {
  return {
    name: 'novel.plugin-manager',
    apply(ctx: ServerPluginContext): void {
      const router = new Hono();

      /** 插件列表（含状态/权限/依赖/开关/守护器） */
      router.get('/', async (c) => {
        try {
          const host = getHost();
          const plugins = host.getPluginStatus();
          const analysis = host.getDependencyAnalysis();
          const byId = new Map(analysis.nodes.map((n) => [n.id, n]));
          return c.json({
            plugins: plugins.map((p) => ({
              ...p,
              requiredBy: byId.get(p.id)?.requiredBy ?? [],
            })),
            deps: analysis,
            guardianPolicy: host.getGuardianPolicy(),
          });
        } catch (err) {
          console.error('[plugin-manager] 列表失败:', err);
          return c.json({ error: { code: 'INTERNAL_ERROR', message: '获取插件列表失败' } }, 500);
        }
      });

      /** 全局依赖分析（互相依赖 + 缺失 + 循环） */
      router.get('/deps', async (c) => {
        try {
          return c.json({ deps: getHost().getDependencyAnalysis() });
        } catch (err) {
          console.error('[plugin-manager] 依赖分析失败:', err);
          return c.json({ error: { code: 'INTERNAL_ERROR', message: '依赖分析失败' } }, 500);
        }
      });

      /** 启用插件 */
      router.post('/:id/enable', async (c) => {
        const id = c.req.param('id');
        try {
          const result = await getHost().setPluginEnabled(id, true);
          if (!result.ok) {
            return c.json({ error: { code: 'DEPENDENCY_UNMET', message: result.error ?? `无法启用 ${id}` } }, 409);
          }
          return c.json({ ok: true, id, enabled: true });
        } catch (err) {
          console.error(`[plugin-manager] 启用 ${id} 失败:`, err);
          return c.json({ error: { code: 'INTERNAL_ERROR', message: `启用 ${id} 失败` } }, 500);
        }
      });

      /** 禁用插件 */
      router.post('/:id/disable', async (c) => {
        const id = c.req.param('id');
        try {
          // 禁用前检查：依赖该插件的其他插件会受影响
          const host = getHost();
          const analysis = host.getDependencyAnalysis();
          const node = analysis.nodes.find((n) => n.id === id);
          const dependents = (node?.requiredBy ?? []).filter((d) => host.getPluginStatus().find((p) => p.id === d)?.enabled);
          const result = await host.setPluginEnabled(id, false);
          if (!result.ok) {
            return c.json({ error: { code: 'INTERNAL_ERROR', message: result.error ?? `无法禁用 ${id}` } }, 500);
          }
          return c.json({ ok: true, id, enabled: false, affectedDependents: dependents });
        } catch (err) {
          console.error(`[plugin-manager] 禁用 ${id} 失败:`, err);
          return c.json({ error: { code: 'INTERNAL_ERROR', message: `禁用 ${id} 失败` } }, 500);
        }
      });

      /** 手动放行（跳过剩余隔离期） */
      router.post('/:id/promote', async (c) => {
        const id = c.req.param('id');
        try {
          const result = getHost().promotePlugin(id);
          if (!result.ok) {
            return c.json({ error: { code: 'NOT_FOUND', message: result.error ?? `无法放行 ${id}` } }, 404);
          }
          const guardian = getHost().getPluginStatus().find((p) => p.id === id)?.guardian ?? null;
          return c.json({ ok: true, id, guardian });
        } catch (err) {
          console.error(`[plugin-manager] 放行 ${id} 失败:`, err);
          return c.json({ error: { code: 'INTERNAL_ERROR', message: `放行 ${id} 失败` } }, 500);
        }
      });

      /** 重置回隔离态（failed 插件修复后重新观察；被禁用的插件会同时重新挂载启用） */
      router.post('/:id/re-quarantine', async (c) => {
        const id = c.req.param('id');
        try {
          const result = await getHost().requarantinePlugin(id);
          if (!result.ok) {
            return c.json({ error: { code: 'NOT_FOUND', message: result.error ?? `无法重置 ${id}` } }, 404);
          }
          const guardian = getHost().getPluginStatus().find((p) => p.id === id)?.guardian ?? null;
          return c.json({ ok: true, id, remounted: result.remounted, guardian });
        } catch (err) {
          console.error(`[plugin-manager] 重置 ${id} 失败:`, err);
          return c.json({ error: { code: 'INTERNAL_ERROR', message: `重置 ${id} 失败` } }, 500);
        }
      });

      ctx.effect(() => ctx.routes.register('/api/plugin-manager', router), 'plugin-manager routes');
      ctx.logger.info('插件管理器已挂载（/api/plugin-manager）');
    },
  };
}
