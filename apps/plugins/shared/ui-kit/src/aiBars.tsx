// ============================================================
// @novel-plugins/ui-kit/ai-bars — AI 对话的两条功能栏（快捷语 / 技能选择）
//
// ★ D46 修复①：本文件从 auto 模块的 `discuss/ChatPanel.tsx` **下沉**而来。
//
//   原因：`apps/plugins/auto/novel.autowrite`（独立插件包）需要复用这两条栏，
//   原先经 `@novel-plugins/auto-workbench/web` 引用 —— 一旦移走 auto 模块目录，
//   该说明符即解析失败（`[vite:load-fallback] ENOENT`），「另一模块缺席仍可用」
//   不再成立。下沉到 shared 后，两侧都只依赖**恒在**的 shared 包。
//
//   ★ 本包是**严格叶子**：不得 import `@/`（kernel）、不得 import
//   `react-router-dom`、不得 import `@novel-plugins/data-core`。
//   故：
//     · `SkillsBar` 改为**纯展示**，技能列表经 props 注入（由 data-core 的连接层提供）；
//     · 「添加技能」跳转经 `onOpenSettings` 回调注入（未提供则不渲染该按钮），
//       而不是在此 import kernel 的 `@/routes/paths` + `useNavigate`。
//
//   分层：ui-kit（纯展示，本文件）← data-core（连接 store）← 各插件/模块。
// ============================================================

import { useEffect, useState, type CSSProperties } from 'react';
import {
  ChevronDown, ChevronRight, MapPin, Settings, Sparkles, User, Wand2, X, Zap,
  type LucideIcon,
} from 'lucide-react';

// ============================================================
// 快捷语（QuickPrompts）
// ============================================================

/**
 * 快捷语 — 按写作场景分类，点击填入输入框（不自动发送，允许用户再修改）。
 * 覆盖：场景描写 / 人物刻画 / 情节推进 / 文字打磨 四类高频写作需求。
 * 样式与编辑器 QuickPhrasePanel 胶囊风格保持一致：液态玻璃 + 分类色 + 弹性形变。
 */
export type QuickPromptCategory = {
  category: string;
  icon: LucideIcon;
  color: string;
  items: string[];
};

/** 快捷提示词分类色 —— 水墨化：以「墨阶」代替色相区分（饱和度恒 0） */
export const QUICK_PROMPTS: QuickPromptCategory[] = [
  {
    category: '场景描写',
    icon: MapPin,
    color: 'hsl(0 0% 38%)', // 淡墨
    items: [
      '帮我描述一下当前的场景',
      '补充一些环境细节描写',
      '如何增强这段情节的氛围感',
    ],
  },
  {
    category: '人物刻画',
    icon: User,
    color: 'hsl(0 0% 22%)', // 浓墨
    items: [
      '帮我丰富主角的心理活动',
      '为本章添加一段人物对话',
      '帮我分析本章的人物关系',
    ],
  },
  {
    category: '情节推进',
    icon: Wand2,
    color: 'hsl(0 0% 46%)', // 中墨
    items: [
      '主角接下来应该怎么做？',
      '有什么伏笔需要注意吗？',
      '为本章设计一个情节转折',
    ],
  },
  {
    category: '文字打磨',
    icon: Sparkles,
    color: 'hsl(0 0% 58%)', // 清墨
    items: [
      '优化这段文字的表达',
      '分析一下本章的节奏',
      '给本章写一个开篇钩子',
    ],
  },
];

/**
 * 快捷语栏 — 始终显示在输入框上方，可折叠。
 * 样式与编辑器 QuickPhrasePanel 胶囊风格保持一致：
 *   - 液态玻璃背景（backdrop-filter blur + saturate）
 *   - 多层柔和投影（含 inset 顶部高光）
 *   - rounded-full 胶囊形态
 *   - hover:scale-105 / active:scale-95 弹性形变（无波纹）
 *   - 每条 chip 带分类 icon + 颜色
 * 点击 chip 只填入输入框，不自动发送，允许用户再修改。
 */
export function QuickPromptsBar({ onPick, disabled, embedded, variant }: { onPick: (text: string) => void; disabled: boolean; embedded?: boolean; variant?: 'bar' | 'bubbles' }) {
  const [expanded, setExpanded] = useState(false);
  // 折叠态默认展示的常用项（跨分类各取一条，覆盖最高频场景）
  // ★ 修复类型：noUncheckedIndexedAccess 下 g.items[0] 为 string | undefined，
  //   过滤掉空项避免 onPick(prompt) 类型不匹配
  const defaults = QUICK_PROMPTS
    .map((g) => ({ prompt: g.items[0], icon: g.icon, color: g.color }))
    .filter((d): d is { prompt: string; icon: LucideIcon; color: string } => !!d.prompt);

  if (disabled) return null;

  // ★ bubbles 变体：快捷语变成椭圆形气泡，在容器内居中分布并不规则漂移（模拟真实气泡）
  if (variant === 'bubbles') {
    // djb2 确定性哈希 → [0,1)：同一快捷语的漂移参数稳定
    const hashFraction = (str: string): number => {
      let hash = 5381;
      for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
      return ((hash >>> 0) % 10000) / 10000;
    };
    // 扁平化全部分组（bubbles 变体不分组，靠颜色区分来源）
    const all = QUICK_PROMPTS.flatMap((g) => g.items.map((prompt) => ({ prompt, color: g.color })));
    const COLS = 3;
    const rows = Math.ceil(all.length / COLS);
    return (
      <div className="relative w-full" style={{ height: rows * 96 + 20 }} role="group" aria-label="快捷语气泡">
        {all.map((item, idx) => {
          const col = idx % COLS;
          const row = Math.floor(idx / COLS);
          const f1 = hashFraction(item.prompt + ':x');
          const f2 = hashFraction(item.prompt + ':y');
          const f3 = hashFraction(item.prompt + ':d');
          // 槽位居中分布 + 少量随机抖动
          const left = 17 + (col * 66) / Math.max(1, COLS - 1) + (f1 - 0.5) * 8;
          const top = (row + 0.5) * (100 / rows) + (f2 - 0.5) * 6;
          const w = 104 + Math.round(f1 * 22);
          return (
            <button
              key={item.prompt}
              type="button"
              onClick={() => onPick(item.prompt)}
              title={item.prompt}
              className="nm-qbubble"
              style={{
                left: `${left}%`,
                top: `${top}%`,
                width: w,
                '--dx1': `${(f1 - 0.5) * 26}px`,
                '--dy1': `${(f2 - 0.5) * 22}px`,
                '--dx2': `${(f2 - 0.5) * -24}px`,
                '--dy2': `${(f3 - 0.5) * 20}px`,
                '--rot': `${(f3 - 0.5) * 7}deg`,
                '--qb-dur': `${7 + f3 * 5}s`,
                '--qb-delay': `${-f1 * 6}s`,
                borderColor: `${item.color}55`,
                color: 'hsl(var(--ink))',
              } as CSSProperties}
            >
              <span className="nm-qbubble-text">{item.prompt}</span>
            </button>
          );
        })}
      </div>
    );
  }

  // 胶囊 chip 样式（与 QuickPhrasePanel 一致）
  const chipStyle = (color: string): CSSProperties => ({
    background: 'rgb(var(--glass-tint) / 0.55)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    border: `1px solid ${color}33`,
    boxShadow:
      '0 4px 12px hsl(var(--glass-shadow) / 0.08), inset 0 1px 0 rgb(var(--glass-highlight) / 0.5)',
    color: 'hsl(var(--ink))',
    fontFamily: "'Noto Serif SC', serif",
  });

  // embedded：供贴附气泡的弹出层渲染（跳过折叠头部，直接展开全部分组）
  if (embedded) {
    return (
      <div className="space-y-2">
        {QUICK_PROMPTS.map((group) => (
          <div key={group.category} role="group" aria-label={group.category}>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1">{group.category}</div>
            <div className="flex flex-wrap gap-1">
              {group.items.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => onPick(prompt)}
                  className="px-2 py-1 text-[11px] rounded-full transition-all hover:scale-105 active:scale-95"
                  style={chipStyle(group.color)}
                  title={prompt}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="mb-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        <button
          onClick={() => setExpanded(v => !v)}
          className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground hover:bg-muted/40 rounded-xl transition-colors px-1.5 py-0.5"
          aria-expanded={expanded}
          aria-label={expanded ? '收起快捷语' : '展开快捷语'}
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <Sparkles size={10} className="text-amber-500/70" aria-hidden="true" />
          <span>快捷语</span>
        </button>
      </div>
      {!expanded ? (
        // 折叠态：横向滚动常用胶囊 chips（隐藏滚动条）
        <div
          className="nm-quick-prompts-scroll flex gap-1.5 overflow-x-auto pb-0.5 max-w-full"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch' }}
        >
          {defaults.map(({ prompt, icon: Icon, color }) => (
            <button
              key={prompt}
              onClick={() => onPick(prompt)}
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12px] transition-all hover:scale-105 active:scale-95 whitespace-nowrap"
              style={chipStyle(color)}
              title={prompt}
            >
              <Icon size={11} style={{ color }} aria-hidden="true" />
              <span className="max-w-[120px] truncate">{prompt}</span>
            </button>
          ))}
        </div>
      ) : (
        // 展开态：液态玻璃容器 + 分类胶囊网格
        <div
          className="space-y-2 rounded-2xl p-2"
          style={{
            background: 'rgb(var(--glass-tint) / 0.5)',
            backdropFilter: 'blur(24px) saturate(180%)',
            WebkitBackdropFilter: 'blur(24px) saturate(180%)',
            border: '1px solid hsl(var(--border) / 0.4)',
            boxShadow:
              '0 12px 40px hsl(var(--glass-shadow) / 0.12), 0 4px 12px hsl(var(--glass-shadow) / 0.06), inset 0 1px 0 rgb(var(--glass-highlight) / 0.6)',
          }}
        >
          {QUICK_PROMPTS.map((group) => {
            const Icon = group.icon;
            return (
              <div key={group.category} role="group" aria-label={group.category}>
                <div
                  className="text-[11px] uppercase tracking-wider mb-1 px-0.5 flex items-center gap-1"
                  style={{ color: group.color, opacity: 0.85 }}
                >
                  <Icon size={10} aria-hidden="true" />
                  <span>{group.category}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {group.items.map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => { onPick(prompt); setExpanded(false); }}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12px] transition-all hover:scale-105 active:scale-95"
                      style={chipStyle(group.color)}
                      title={prompt}
                    >
                      <Icon size={11} style={{ color: group.color }} aria-hidden="true" />
                      <span className="max-w-[140px] truncate">{prompt}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 技能选择器（SkillsBar）—— 纯展示，列表经 props 注入
// ============================================================

/**
 * 技能条目的最小展示形状（结构上兼容 data-core 的 `SkillMeta`）。
 * 只声明渲染所需字段，避免本叶子包依赖 data-core 的类型。
 */
export interface SkillChip {
  id: string;
  name: string;
  description?: string;
  icon: LucideIcon;
  /** 主题色（hex 或 hsl 字符串） */
  color: string;
}

/**
 * 技能选择器 — 让用户激活"专家模式"。
 *
 * 与快捷语的区别：
 *   - 快捷语：只填入输入框文本，用户可修改后手动发送
 *   - 技能：激活后该轮对话叠加专家 system prompt + 注入实体上下文，
 *     AI 会以专家视角回答；再次点击或点 X 取消激活
 *
 * 激活后：
 *   - 输入框上方显示当前激活的技能徽章（带 X 可取消）
 *   - 该轮对话的 NovelChatContext 携带 skillId + extraContext
 *   - 技能 prompt 与实体上下文由后端 chat-agent 叠加到 system prompt
 *
 * ★ D46：本组件是**纯展示**的 —— `skills` / `activeSkill` / `loading` 全部由
 *   连接层（`@novel-plugins/data-core` 的 `useSkillBarProps`）注入；设置页跳转经
 *   `onOpenSettings` 回调注入。故本包不需要 kernel registry、data-core 或 router。
 */
export function SkillsBar({
  skills, activeSkill, activeSkillId, onActivate, onCancel, disabled, embedded,
  showToggle = true, loading = false, onOpenSettings, onExpand,
}: {
  /** 可用技能列表（已按项目模式过滤） */
  skills: SkillChip[];
  /** 当前激活技能的元数据（无激活为 null） */
  activeSkill: SkillChip | null;
  activeSkillId: string | null;
  onActivate: (skillId: string) => void;
  onCancel: () => void;
  disabled: boolean;
  /** embedded：供贴附气泡的弹出层渲染（跳过折叠头部，始终展开网格） */
  embedded?: boolean;
  /** 是否渲染「技能」展开按钮（ChatPanel 内保留徽章时传 false） */
  showToggle?: boolean;
  /** 技能列表尚未拉取完成（渲染占位提示） */
  loading?: boolean;
  /** 「添加技能」跳转设置页；**未提供则不渲染该按钮**（保持本包不依赖 router） */
  onOpenSettings?: () => void;
  /** 展开时触发（连接层用它拉取技能列表；纯展示层不关心来源） */
  onExpand?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isExpanded = embedded || expanded;

  // 展开时触发一次拉取（连接层把 ensureLoaded 包进 onExpand 里）
  useEffect(() => {
    if (isExpanded) onExpand?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExpanded]);

  if (disabled) return null;

  // 胶囊样式（与 QuickPromptsBar 一致的液态玻璃风格）
  const chipStyle = (color: string, active: boolean): CSSProperties => ({
    background: active
      ? `linear-gradient(135deg, ${color}38, ${color}20)`
      : 'rgb(var(--glass-tint) / 0.55)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    border: `1px solid ${active ? color : color + '33'}`,
    boxShadow: active
      ? `0 0 0 2px ${color}40, 0 4px 16px ${color}30, inset 0 1px 0 rgb(var(--glass-highlight) / 0.5)`
      : '0 4px 12px hsl(var(--glass-shadow) / 0.08), inset 0 1px 0 rgb(var(--glass-highlight) / 0.5)',
    color: 'hsl(var(--ink))',
    fontFamily: "'Noto Serif SC', serif",
  });

  const emptyHint = skills.length === 0 ? (
    <div className="col-span-2 py-3 text-center text-[11px] text-muted-foreground" role="status">
      {loading ? '技能列表加载中…' : '暂无可用技能'}
    </div>
  ) : null;

  // embedded：跳过折叠头部，始终展开网格（供贴附气泡的弹出层使用）
  if (embedded) {
    return (
      <>
        <div
          className="grid grid-cols-2 gap-1.5 rounded-2xl p-2"
          style={{
            background: 'rgb(var(--glass-tint) / 0.5)',
            backdropFilter: 'blur(24px) saturate(180%)',
            WebkitBackdropFilter: 'blur(24px) saturate(180%)',
            border: '1px solid hsl(var(--border) / 0.4)',
            boxShadow:
              '0 12px 40px hsl(var(--glass-shadow) / 0.12), 0 4px 12px hsl(var(--glass-shadow) / 0.06), inset 0 1px 0 rgb(var(--glass-highlight) / 0.6)',
          }}
        >
          {skills.map((skill) => {
            const Icon = skill.icon;
            const isActive = activeSkillId === skill.id;
            return (
              <button
                key={skill.id}
                onClick={() => (isActive ? onCancel() : onActivate(skill.id))}
                className="flex items-start gap-2 p-2 rounded-xl text-left transition-all hover:scale-[1.02] active:scale-95"
                style={chipStyle(skill.color, isActive)}
                title={skill.description}
              >
                <Icon size={14} style={{ color: skill.color }} className="shrink-0 mt-0.5" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-semibold truncate" style={{ color: skill.color }}>
                    {skill.name}
                  </div>
                  <div className="text-[11px] text-muted-foreground line-clamp-2 leading-tight mt-0.5">
                    {skill.description}
                  </div>
                </div>
              </button>
            );
          })}
          {emptyHint}
        </div>

        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            // ★ nm-no-brush：这个按钮用 dashed 表达「还没启用」，边框是装饰性的，
            //   刻意不加装饰性外框。显式加类，别依赖「inline border 简写重置 border-image」的副作用。
            className="nm-no-brush w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-medium transition-all hover:scale-[1.02] active:scale-95"
            style={{
              background: 'rgb(var(--glass-tint) / 0.4)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              border: '1px dashed hsl(var(--border) / 0.5)',
              color: 'hsl(var(--muted-foreground))',
            }}
            title="前往设置页配置 AI 服务与技能"
            aria-label="添加技能"
          >
            <Settings size={12} aria-hidden="true" />
            <span>添加技能</span>
          </button>
        )}
      </>
    );
  }

  return (
    <div className="mb-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        {showToggle && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground hover:bg-muted/40 rounded-xl transition-colors px-1.5 py-0.5"
            aria-expanded={expanded}
            aria-label={expanded ? '收起技能' : '展开技能'}
          >
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            <Zap size={10} className="text-amber-500/70" aria-hidden="true" />
            <span>技能</span>
          </button>
        )}
        {activeSkill && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
            style={chipStyle(activeSkill.color, true)}
          >
            <activeSkill.icon size={10} style={{ color: activeSkill.color }} aria-hidden="true" />
            <span>{activeSkill.name}</span>
            <button
              onClick={onCancel}
              className="ml-0.5 hover:opacity-70 transition-opacity"
              aria-label="取消技能"
              title="取消技能"
            >
              <X size={10} style={{ color: activeSkill.color }} />
            </button>
          </span>
        )}
      </div>

      {expanded && (
        <div className="space-y-1.5">
          <div
            className="grid grid-cols-2 gap-1.5 rounded-2xl p-2"
            style={{
              background: 'rgb(var(--glass-tint) / 0.5)',
              backdropFilter: 'blur(24px) saturate(180%)',
              WebkitBackdropFilter: 'blur(24px) saturate(180%)',
              border: '1px solid hsl(var(--border) / 0.4)',
              boxShadow:
                '0 12px 40px hsl(var(--glass-shadow) / 0.12), 0 4px 12px hsl(var(--glass-shadow) / 0.06), inset 0 1px 0 rgb(var(--glass-highlight) / 0.6)',
            }}
          >
            {skills.map((skill) => {
              const Icon = skill.icon;
              const isActive = activeSkillId === skill.id;
              return (
                <button
                  key={skill.id}
                  onClick={() => {
                    if (isActive) {
                      onCancel();
                    } else {
                      onActivate(skill.id);
                      setExpanded(false);
                    }
                  }}
                  className="flex items-start gap-2 p-2 rounded-xl text-left transition-all hover:scale-[1.02] active:scale-95"
                  style={chipStyle(skill.color, isActive)}
                  title={skill.description}
                >
                  <Icon size={14} style={{ color: skill.color }} className="shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-semibold truncate" style={{ color: skill.color }}>
                      {skill.name}
                    </div>
                    <div className="text-[11px] text-muted-foreground line-clamp-2 leading-tight mt-0.5">
                      {skill.description}
                    </div>
                  </div>
                </button>
              );
            })}
            {emptyHint}
          </div>

          {onOpenSettings && (
            <button
              onClick={() => { onOpenSettings(); setExpanded(false); }}
              // ★ nm-no-brush：同上，dashed 引导按钮刻意不穿笔触（显式标记，不靠副作用）
              className="nm-no-brush w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-medium transition-all hover:scale-[1.02] active:scale-95"
              style={{
                background: 'rgb(var(--glass-tint) / 0.4)',
                backdropFilter: 'blur(20px) saturate(180%)',
                WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                border: '1px dashed hsl(var(--border) / 0.5)',
                color: 'hsl(var(--muted-foreground))',
              }}
              title="前往设置页配置 AI 服务与技能"
              aria-label="添加技能"
            >
              <Settings size={12} aria-hidden="true" />
              <span>添加技能</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}