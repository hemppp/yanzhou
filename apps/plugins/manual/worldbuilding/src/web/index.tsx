// ============================================================
// 世界观建造师插件 —— Web 面
//
// 演示全部 Web 扩展点：
//  1. registerProjectPanel —— 项目工作台新增「势力」面板
//  2. registerCommand —— Ctrl+K 命令面板打开势力面板
//  3. registerSelectionAction —— 选中正文文字直接建为势力
//  4. registerEditorExtension —— 正文中的势力名高亮且可点击
// ============================================================

import React from 'react';
import { Landmark } from 'lucide-react';
import type { WebPluginContext, WebApiFetch } from '@novel/core/web';
import { FactionHighlight, setFactionNames } from './faction-highlight.js';

// ★ 带鉴权 API（C7）：由 apply() 注入 ctx.api（自动带 JWT/项目头），
//   禁止裸 fetch——服务端 /api/plugins/* 已默认要求登录。
let apiFetch: WebApiFetch = (path, init) => fetch(path, init);

export const name = 'novel.worldbuilding';
export const inject = ['projectPanels', 'commands', 'selection', 'editor'];

/** 请求宿主打开指定浮窗面板（ProjectLayout 监听 nm:open-panel） */
function openPanel(key: string): void {
  window.dispatchEvent(new CustomEvent('nm:open-panel', { detail: { key } }));
}

interface Faction {
  id: string;
  name: string;
  alignment: string;
  appearances: number;
}

/** 拉取势力列表；同时刷新正文高亮用的名字集合 */
async function fetchFactions(): Promise<Faction[]> {
  const res = await apiFetch('/api/plugins/worldbuilding');
  const data = (await res.json()) as { factions?: Faction[] };
  const list = data.factions ?? [];
  setFactionNames(list.map((f) => f.name));
  return list;
}

// 势力面板（轻量实现：经 ctx.api 调后端 /api/plugins/worldbuilding）
function FactionsPanel() {
  const [factions, setFactions] = React.useState<Faction[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [name, setName] = React.useState('');

  const load = React.useCallback(() => {
    setLoading(true);
    fetchFactions()
      .then(setFactions)
      .catch((err) => console.warn('[worldbuilding] 加载势力失败', err))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(load, [load]);

  const create = async () => {
    if (!name.trim()) return;
    await apiFetch('/api/plugins/worldbuilding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    setName('');
    load();
  };

  return (
    <div className="p-4 space-y-3 overflow-y-auto" style={{ maxHeight: '100%' }}>
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新势力名称..."
          className="flex-1 px-3 py-1.5 rounded-lg border text-sm"
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
        <button onClick={create} className="px-3 py-1.5 rounded-lg text-sm" style={{ background: 'hsl(var(--primary))', color: '#fff' }}>
          新增
        </button>
      </div>
      {loading && <div className="text-sm opacity-60">加载中...</div>}
      {!loading && factions.length === 0 && <div className="text-sm opacity-60">暂无势力，输入名称创建一个</div>}
      {factions.map((f) => (
        <div key={f.id} className="rounded-lg border p-3 space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-medium">{f.name}</span>
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'hsl(var(--mountain-pale))' }}>
              {f.alignment}
            </span>
          </div>
          <div className="text-xs opacity-60">出场 {f.appearances} 次</div>
        </div>
      ))}
    </div>
  );
}

export function apply(ctx: WebPluginContext): void {
  apiFetch = ctx.api; // 注入带鉴权 fetch（C7）
  // 项目面板（浮窗宿主自动渲染）—— 插件功能 UI 的唯一入口
  ctx.registerProjectPanel({
    key: 'factions',
    label: '势力',
    icon: Landmark,
    // ★ 2026-10-29：活动栏分区 —— 势力是世界观资料，与角色 / 地点同组。
    //   第三方插件照样可以（也应该）声明它；不声明只会归进兜底的「其它」组，
    //   不会被丢弃，也不会报错（见 kernel components/shell/panelSections.ts）。
    section: '资料',
    Component: FactionsPanel,
    width: 640,
    height: 720,
  });

  // 命令面板
  ctx.registerCommand({
    id: 'worldbuilding.add-faction',
    title: '新增势力',
    keywords: ['世界观', 'faction', '势力'],
    run: () => openPanel('factions'),
  });

  // 编辑器扩展：正文中的势力名加虚线下划并可点击回到面板
  ctx.registerEditorExtension({
    key: 'worldbuilding.faction-highlight',
    create: () => FactionHighlight,
  });

  // 选区动作：选中一段文字，直接建成同名势力并打开面板确认
  // （编辑器工具栏的「势力」快捷入口已移除：与顶栏面板按钮功能重复）
  ctx.registerSelectionAction({
    key: 'worldbuilding.create-from-selection',
    label: '建为势力',
    icon: Landmark,
    color: 'rgba(79, 145, 140, 0.14)',
    run: async ({ text }) => {
      const trimmed = text.trim().slice(0, 40);
      if (!trimmed) return;
      try {
        await apiFetch('/api/plugins/worldbuilding', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        });
        // 刷新高亮名单，新建的势力立刻在正文里高亮
        await fetchFactions().catch(() => undefined);
        openPanel('factions');
      } catch (err) {
        ctx.logger.warn(`从选区创建势力失败: ${String(err)}`);
      }
    },
  });

  ctx.logger.info('世界观建造师 Web 面已挂载（面板 / 命令 / 工具栏 / 选区动作）');
}
