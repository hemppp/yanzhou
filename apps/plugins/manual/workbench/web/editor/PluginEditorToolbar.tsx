// ============================================================
// 编辑器插件工具栏 —— 渲染插件通过 ctx.registerEditorToolbarItem 注册的按钮
//
// 无插件注册时整条工具栏不渲染（不占正文空间）。按钮回调收到当前 Tiptap editor 实例，
// isActive 用于高亮（如 mark 已应用）。单个按钮回调抛错只 warn，不影响其他按钮。
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { Puzzle } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { usePluginRegistry, useProjectMode, filterByProjectMode } from '@/plugin/registry';
import type { EditorToolbarItemDef } from '@/plugin/types';

function ToolbarButton({ def, editor }: { def: EditorToolbarItemDef; editor: Editor }) {
  const Icon = def.icon ?? Puzzle;
  // 激活态随编辑器选区/内容变化刷新：订阅 transaction 而非每次渲染重算
  const [active, setActive] = useState(false);

  const recompute = useCallback(() => {
    if (!def.isActive) return;
    try {
      setActive(def.isActive(editor));
    } catch {
      setActive(false);
    }
  }, [def, editor]);

  useEffect(() => {
    if (!def.isActive) return;
    recompute();
    editor.on('transaction', recompute);
    return () => {
      editor.off('transaction', recompute);
    };
  }, [editor, def.isActive, recompute]);

  const onClick = () => {
    try {
      void def.run(editor);
    } catch (err) {
      console.warn(`[plugin] 工具栏按钮 ${def.key} 执行失败:`, err);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={def.label}
      aria-label={def.label}
      aria-pressed={def.isActive ? active : undefined}
      className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded-lg transition-colors"
      style={{
        color: active ? 'hsl(var(--primary))' : 'hsl(var(--ink-light))',
        background: active ? 'hsl(var(--primary) / 0.12)' : 'transparent',
        borderWidth: '0.5px',
        borderStyle: 'solid',
        borderColor: active ? 'hsl(var(--primary) / 0.4)' : 'hsl(var(--border) / 0.5)',
      }}
    >
      <Icon size={13} aria-hidden="true" />
      <span className="hidden sm:inline">{def.label}</span>
    </button>
  );
}

/** 插件工具栏容器：无条目时不渲染任何 DOM */
export function PluginEditorToolbar({ editor }: { editor: Editor | null }) {
  // ★ 按当前项目创作模式过滤：不适用于本模式的插件工具栏按钮不显示
  const mode = useProjectMode();
  const items = filterByProjectMode(usePluginRegistry((s) => s.editorToolbarItems), mode);
  if (!editor || items.length === 0) return null;
  return (
    <div
      className="flex items-center gap-1.5 flex-wrap"
      style={{ paddingBottom: 'var(--space-3)' }}
      role="toolbar"
      aria-label="插件工具栏"
    >
      {items.map((def) => (
        <ToolbarButton key={def.key} def={def} editor={editor} />
      ))}
    </div>
  );
}
