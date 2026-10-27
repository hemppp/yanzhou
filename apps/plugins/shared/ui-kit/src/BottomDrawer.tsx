import { useState, type ReactNode, type ElementType, type ComponentType, Suspense, useMemo, useCallback } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { useGlassRipple } from './useGlassRipple';

export interface BottomDrawerTab {
  key: string;
  label: string;
  icon: ElementType;
  /** 在 BottomDrawer 内部渲染的组件 */
  Component?: ComponentType<Record<string, never>>;
  content?: ReactNode;
  badge?: number | string;
  group?: 'primary' | 'advanced';
}

export interface BottomDrawerProps {
  tabs: BottomDrawerTab[];
  /** 受控：当前激活的 tab key */
  activeKey?: string | null;
  onActiveKeyChange?: (key: string) => void;
  /** 受控：是否展开 */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 非弹窗渲染（仅在未提供弹窗 props 时生效）*/
  defaultActiveKey?: string | null;
  defaultOpen?: boolean;
  /** 展开时的高度 */
  expandedHeight?: number;
  /** 收起时的高度（仅 tab 模式）*/
  collapsedHeight?: number;
  /** 底部标题（左侧）*/
  label?: string;
}

/**
 * 底部抽屉（tab 切换），支持受控 / 非弹窗双模式
 * - 收起：仅显示 tab 条
 * - 展开：显示 tab 条 + 内容
 * - 分组：primary / advanced 之间用 1px 竖线分隔
 */
export function BottomDrawer({
  tabs,
  activeKey: controlledActive,
  onActiveKeyChange,
  isOpen: controlledOpen,
  onOpenChange,
  defaultActiveKey,
  defaultOpen = false,
  expandedHeight = 360,
  collapsedHeight = 36,
  label: _label = '辅助',
}: BottomDrawerProps) {
  const isControlledOpen = controlledOpen !== undefined;
  const isControlledActive = controlledActive !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const handleTabPointerDown = useGlassRipple<HTMLButtonElement>();
  const [internalActive, setInternalActive] = useState<string | null>(
    defaultActiveKey ?? (tabs[0]?.key ?? null),
  );

  const isOpen = isControlledOpen ? controlledOpen : internalOpen;
  const activeKey = isControlledActive ? controlledActive : internalActive;

  // 使用 useCallback 封装 setOpen/setActive 等回调，避免每次渲染重新创建
  const setOpen = useCallback((next: boolean) => {
    if (!isControlledOpen) setInternalOpen(next);
    onOpenChange?.(next);
  }, [isControlledOpen, onOpenChange]);

  const setActive = useCallback((key: string) => {
    if (!isControlledActive) setInternalActive(key);
    onActiveKeyChange?.(key);
  }, [isControlledActive, onActiveKeyChange]);

  const active = tabs.find(t => t.key === activeKey);

  // 鍒嗙粍娓叉煋锛氫娇鐢?useMemo 缂撳瓨鍒嗙粍缁撴灉锛岄伩鍏嶆瘡娆℃覆鏌撳垱寤烘柊鏁扮粍
  const grouped = useMemo(() => {
    const groups: { tabs: BottomDrawerTab[]; isLast?: boolean }[] = [];
    let current: BottomDrawerTab[] = [];
    let currentGroup: string | undefined;
    for (const tab of tabs) {
      const g = tab.group ?? 'primary';
      if (g !== currentGroup) {
        if (current.length > 0) {
          groups.push({ tabs: current });
        }
        current = [tab];
        currentGroup = g;
      } else {
        current.push(tab);
      }
    }
    if (current.length > 0) groups.push({ tabs: current, isLast: true });
    return groups;
  }, [tabs]);

  return (
    <div
      className="nm-bottom-drawer shrink-0 flex flex-col glass-frost glass-edge-glow"
      style={{
        height: isOpen ? expandedHeight : collapsedHeight,
        borderTop: '0.5px solid hsl(var(--border) / 0.6)',
        boxShadow: '0 -1px 0 rgb(var(--glass-highlight) / 0.7), 0 -4px 16px hsl(var(--glass-shadow) / 0.05)',
      }}
      aria-label="底部辅助抽屉"
    >
      {/* Tab 鏉?*/}
      <div className="shrink-0 h-9 flex items-center">
        <div className="flex-1 flex justify-center items-center gap-1">
        {grouped.map((group, groupIdx) => (
          <div key={groupIdx} className="flex items-center gap-1">
            {groupIdx > 0 && (
              <span
                className="mx-1 inline-block w-px h-4"
                style={{ background: 'hsl(var(--border))' }}
                aria-hidden="true"
              />
            )}
            {group.tabs.map(tab => {
              const Icon = tab.icon;
              const isActive = tab.key === activeKey && isOpen;
              return (
                <button
                  key={tab.key}
                  onClick={() => {
                    if (activeKey === tab.key && isOpen) {
                      setOpen(false);
                    } else {
                      setActive(tab.key);
                      setOpen(true);
                    }
                  }}
                  onPointerDown={handleTabPointerDown}
                  className="nm-btn-apple glass-ripple glass-pressable glass-edge-glow text-[11px] px-2.5 py-1 transition-all duration-200"
                  style={{
                    color: isActive ? 'hsl(var(--mountain-deep))' : 'hsl(var(--muted-foreground))',
                    background: isActive
                      ? 'rgb(var(--glass-tint) / 0.55)'
                      : 'transparent',
                    backdropFilter: isActive ? 'blur(12px) saturate(160%)' : 'none',
                    WebkitBackdropFilter: isActive ? 'blur(12px) saturate(160%)' : 'none',
                    boxShadow: isActive
                      ? 'inset 0 1px 0 rgb(var(--glass-highlight) / 0.6), 0 1px 2px hsl(var(--glass-shadow) / 0.04)'
                      : 'none',
                    border: isActive
                      ? '0.5px solid hsl(var(--mountain-cyan) / 0.25)'
                      : '0.5px solid transparent',
                  }}
                  aria-label={tab.label}
                  aria-selected={isActive}
                  role="tab"
                >
                  <Icon size={12} aria-hidden="true" />
                  <span>{tab.label}</span>
                  {tab.badge !== undefined && tab.badge !== 0 && (
                    <span
                      className="ml-1 text-[10px] tabular-nums px-1.5 rounded-full"
                      style={{ background: 'hsl(var(--cinnabar) / 0.15)', color: 'hsl(var(--cinnabar))' }}
                    >
                      {tab.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
        </div>
        <div className="w-8"></div>
        <button
          onClick={() => setOpen(!isOpen)}
          className="nm-btn-apple-icon-sm glass-pressable"
          title={isOpen ? '收起' : '展开'}
          aria-label={isOpen ? '收起抽屉' : '展开抽屉'}
        >
          {isOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
      </div>

      {/* 占位 */}
      {isOpen && active && (
        <div className="flex-1 overflow-hidden" role="tabpanel" aria-label={active.label}>
          {active.Component ? (
            <Suspense fallback={null}>
              <active.Component />
            </Suspense>
          ) : (
            active.content
          )}
        </div>
      )}
    </div>
  );
}
