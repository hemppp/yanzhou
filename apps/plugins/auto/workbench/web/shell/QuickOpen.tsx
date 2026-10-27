// ============================================================
// QuickOpen —— Ctrl+P「快速打开」（IDE 的 Quick Open）
//
// IDE 里打开文件的两种方式，这里都给上：
//   · Ctrl+P：模糊搜索 → Enter 在**侧编辑器组**打开（这是 IDE 的习惯）
//   · 活动栏点击：单击 = 预览（斜体，会被下一个预览顶掉）；双击 = 固定
//
// 只做「看板」这一种实体，所以不实现 IDE 里的 `:`（跳行）`@`（符号）等前缀模式。
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkbenchPanel } from '../pipeline/workspaceDefs';

interface QuickOpenProps {
  open: boolean;
  panels: WorkbenchPanel[];
  /** 已打开的看板（列表里打勾） */
  openKeys: string[];
  onPick: (key: string) => void;
  onClose: () => void;
}

/** 极简模糊匹配：子序列命中即可，命中靠前的排前面（够用，不引第三方） */
function score(label: string, q: string): number {
  if (!q) return 1;
  const s = label.toLowerCase();
  const t = q.toLowerCase();
  let i = 0;
  let hits = 0;
  let first = -1;
  for (const ch of t) {
    const at = s.indexOf(ch, i);
    if (at < 0) return 0;
    if (first < 0) first = at;
    hits++;
    i = at + 1;
  }
  return 10 + hits - first * 0.1;
}

export function QuickOpen({ open, panels, openKeys, onPick, onClose }: QuickOpenProps) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setCursor(0);
    // 打开即聚焦输入框（IDE 的肌肉记忆）
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const list = useMemo(() => {
    const scored = panels
      .map((p) => ({ p, s: score(p.label, q.trim()) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return scored.map((x) => x.p);
  }, [panels, q]);

  useEffect(() => { setCursor(0); }, [q]);

  if (!open) return null;

  const commit = (i: number) => {
    const p = list[i];
    if (!p) return;
    onPick(p.key);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center"
      style={{ background: 'hsl(var(--glass-shadow) / 0.18)', paddingTop: '12vh' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-label="快速打开看板"
        data-quick-open="true"
        className="rounded-xl overflow-hidden"
        style={{
          width: 520,
          background: 'hsl(var(--card))',
          border: '0.5px solid hsl(var(--border))',
          boxShadow: '0 24px 64px hsl(var(--glass-shadow) / 0.24)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(list.length - 1, c + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); commit(cursor); }
          }}
          placeholder="快速打开看板…（输入名字筛选，Enter 打开）"
          aria-label="快速打开看板"
          className="w-full outline-none"
          style={{
            height: 38, padding: '0 var(--space-5)', fontSize: 12,
            background: 'transparent', border: 'none',
            borderBottom: '0.5px solid hsl(var(--border) / 0.6)',
            color: 'hsl(var(--foreground))',
          }}
        />
        <div style={{ maxHeight: 300, overflowY: 'auto' }} role="listbox">
          {list.length === 0 && (
            <div className="px-4 py-3 text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
              没有匹配的看板
            </div>
          )}
          {list.map((p, i) => (
            <button
              key={p.key}
              type="button"
              role="option"
              aria-selected={i === cursor}
              data-quick-item={p.key}
              onMouseEnter={() => setCursor(i)}
              onClick={() => commit(i)}
              className="w-full flex items-center gap-2 px-3 text-left"
              style={{
                height: 30,
                background: i === cursor ? 'hsl(var(--secondary))' : 'transparent',
                border: 'none',
                fontSize: 11.5,
                color: 'hsl(var(--foreground))',
                cursor: 'pointer',
              }}
            >
              <p.icon size={13} aria-hidden="true" />
              <span className="flex-1 truncate">{p.label}</span>
              {openKeys.includes(p.key) && (
                <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>已打开</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
