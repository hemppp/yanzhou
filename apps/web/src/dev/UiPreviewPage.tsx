// ============================================================
// dev/UiPreviewPage.tsx —— UI 改造对照页（**仅开发环境**）
//
// 目的：在**不动任何现网页面**的前提下，把「新外壳 + 新组件」搭出来给作者比对，
//       满意再决定是否替换 DockShell 的外层。路由由 App.tsx 用 `import.meta.env.DEV`
//       守卫，生产构建里这条路由**不存在**（也不会进包）。
//
// 页面分四段，对应改造的四个层次：
//   ① 令牌（色/圆角/间距）—— "现代中性风"到底长什么样
//   ② 组件对照（旧 .nm-btn-apple-*  vs  新 shadcn Button）
//   ③ 外壳骨架（顶栏 / 活动栏 / 文档标签 / 状态栏 / 分屏）
//   ④ 面板外观（用一个真实面板的"新皮"示意）
//
// ⚠️ 这里**只写展示**，不接 store、不调 API —— 对照页的意义是"看长相"，
//    接真数据是替换阶段的事（且替换时业务逻辑一行不改）。
// ============================================================

import { useEffect, useState } from 'react';
import {
  BookOpenText, Users, MapPin, Lightbulb, Database, Network, BarChart3, Clock,
  StickyNote, AlignLeft, Search, Settings, ChevronDown, X, Plus, PanelLeft, Columns2,
  Sparkles, Send, FileText, Trash2,
} from 'lucide-react';
import { Button } from '@novel-plugins/ui-kit/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@novel-plugins/ui-kit/ui/dialog';
import { cn } from '@novel-plugins/ui-kit/ui/utils';
// 作用域化的候选令牌（不做全局改动，见该文件头注）
import './ui-preview.css';

/** 小节标题 */
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <header className="mb-4">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

function Swatch({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="size-8 shrink-0 rounded-md border border-border" style={{ background: value }} />
      <span className="border-b border-dotted border-border text-xs text-foreground">{name}</span>
    </div>
  );
}

const RAIL_ICONS = [
  { icon: BookOpenText, label: '章节' },
  { icon: Users, label: '角色' },
  { icon: MapPin, label: '地点' },
  { icon: Lightbulb, label: '伏笔' },
  { icon: Database, label: '物品' },
  { icon: Network, label: '关系图' },
  { icon: BarChart3, label: '统计' },
  { icon: Clock, label: '时间线' },
  { icon: StickyNote, label: '笔记' },
  { icon: AlignLeft, label: '大纲' },
];

const DOC_TABS = ['第一章 夜班', '第二章 门锁', 'AI 对话'];
const CHAPTERS = [
  { title: '第一章 夜班', words: 3272, active: true },
  { title: '第二章 门锁', words: 3019 },
  { title: '第三章 侧门', words: 3097 },
];

export function UiPreviewPage() {
  const [tab, setTab] = useState(0);
  const [dark, setDark] = useState(false);
  const [rail, setRail] = useState(0);
  /** 令牌档：false = 现状（苹果大圆角 + 冷灰），true = 现代中性（小圆角 + 中性灰） */
  const [modern, setModern] = useState(true);

  /**
   * ★ 令牌类必须挂在 `<html>` 上，**不能**只包在本页外层 div：
   *   Radix 的 Dialog / Dropdown / Popover 一律 **portal 到 body**，挂在 div 上时
   *   弹层落在作用域**之外**、拿不到候选令牌（实测：Dialog 圆角仍是旧的 16px、
   *   描边仍是冷灰）。这也正是正式改造时的正确形态 —— 令牌本就该在 html 上全局生效。
   *   本页是独立路由（整屏），挂 html 不会影响别的页面；卸载时还原。
   */
  useEffect(() => {
    const el = document.documentElement;
    const hadModern = el.classList.contains('ui-preview-theme--modern');
    const hadDark = el.classList.contains('dark');
    el.classList.toggle('ui-preview-theme--modern', modern);
    el.classList.toggle('dark', dark || hadDark);
    return () => {
      el.classList.toggle('ui-preview-theme--modern', hadModern);
      el.classList.toggle('dark', hadDark);
    };
  }, [modern, dark]);

  return (
    <div className={cn('min-h-screen bg-background p-6 text-foreground')}>
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">UI 改造对照页</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              仅开发环境可见（<code className="rounded bg-muted px-1">/dev/ui-preview</code>）。
              这里只做"看长相"，不接数据、不动业务逻辑。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex rounded-md border border-border p-0.5">
              <Button
                variant={modern ? 'ghost' : 'secondary'}
                size="sm"
                onClick={() => setModern(false)}
              >
                现状令牌
              </Button>
              <Button
                variant={modern ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setModern(true)}
              >
                现代中性
              </Button>
            </div>
            <Button variant="outline" size="sm" onClick={() => setDark((d) => !d)}>
              {dark ? '看亮色' : '看暗色'}
            </Button>
          </div>
        </header>

        <div className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          当前令牌档：<span className="font-medium text-foreground">{modern ? '现代中性' : '现状'}</span>
          <span className="mx-2 text-border">·</span>
          {modern
            ? '圆角 8px / 文字更深 / 中性灰描边（这是候选值，只作用于本页）'
            : '圆角 16px / 冷灰描边（= 现网正在用的值）'}
        </div>

        {/* ① 令牌 */}
        <Section title="① 令牌层" hint="现代中性风 = 这套灰阶 + 小圆角 + 细描边。改这里，全站（含所有面板）一起变。">
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
            <Swatch name="--background" value="hsl(var(--background))" />
            <Swatch name="--card" value="hsl(var(--card))" />
            <Swatch name="--popover" value="hsl(var(--popover))" />
            <Swatch name="--muted" value="hsl(var(--muted))" />
            <Swatch name="--secondary" value="hsl(var(--secondary))" />
            <Swatch name="--accent" value="hsl(var(--accent))" />
            <Swatch name="--primary" value="hsl(var(--primary))" />
            <Swatch name="--border" value="hsl(var(--border))" />
          </div>
          <div className="mt-6 flex flex-wrap items-end gap-6">
            <div>
              <div className="mb-2 text-xs text-muted-foreground">圆角（现在 16px 偏大）</div>
              <div className="flex items-center gap-3">
                <span className="rounded-sm border border-border bg-muted px-3 py-2 text-xs">sm 6px</span>
                <span className="rounded-md border border-border bg-muted px-3 py-2 text-xs">md 8px</span>
                <span className="rounded-lg border border-border bg-muted px-3 py-2 text-xs">lg 10px</span>
              </div>
            </div>
            <div>
              <div className="mb-2 text-xs text-muted-foreground">正文 / 次级 / 弱化 文字</div>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-foreground">正文 foreground</span>
                <span className="text-muted-foreground">次级 muted</span>
              </div>
            </div>
          </div>
        </Section>

        {/* ② 组件对照 */}
        <Section title="② 组件层（左旧 / 右新）" hint="旧的是本仓 .nm-btn-apple-* 手写类；新的是 shadcn Button（源码在本仓 ui-kit/ui）。">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="rounded-md border border-dashed border-border p-4">
              <div className="mb-3 text-xs text-muted-foreground">旧：.nm-btn-apple-*</div>
              <div className="flex flex-wrap items-center gap-2">
                <button className="nm-btn-apple-primary">主按钮</button>
                <button className="nm-btn-apple-secondary">次按钮</button>
                <button className="nm-btn-apple-ghost">幽灵</button>
                <button className="nm-btn-apple-destructive">危险</button>
              </div>
            </div>
            <div className="rounded-md border border-dashed border-border p-4">
              <div className="mb-3 text-xs text-muted-foreground">新：shadcn Button</div>
              <div className="flex flex-wrap items-center gap-2">
                <Button>主按钮</Button>
                <Button variant="secondary">次按钮</Button>
                <Button variant="outline">描边</Button>
                <Button variant="ghost">幽灵</Button>
                <Button variant="destructive">危险</Button>
                <Button size="sm">小</Button>
                <Button size="icon" aria-label="设置"><Settings /></Button>
              </div>
            </div>
          </div>
        </Section>

        {/* ②b 弹层 */}
        <Section
          title="②b 弹层（Dialog / Popover 面）"
          hint="Radix 底座 + 自动 portal + 焦点陷阱 + Esc/外点关闭。本仓现在这些是手写的（AddBookModal 甚至没有 role=dialog）。"
        >
          <div className="flex flex-wrap items-center gap-3">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="destructive">删除确认（Dialog）</Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>移入回收站？</DialogTitle>
                  <DialogDescription>
                    「第二章 门锁」将被移入回收站，可从「回收站」还原。此操作不会删除正文数据。
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline">取消</Button>
                  <Button variant="destructive">
                    <Trash2 /> 移入回收站
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">新建书籍（Dialog）</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>新建书籍</DialogTitle>
                  <DialogDescription>填书名与类型，创建后进入「第一章」。</DialogDescription>
                </DialogHeader>
                <div className="grid gap-3">
                  <label className="grid gap-1.5 text-xs">
                    <span className="text-muted-foreground">书名</span>
                    <input
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
                      placeholder="例如：夜班"
                    />
                  </label>
                  <label className="grid gap-1.5 text-xs">
                    <span className="text-muted-foreground">类型</span>
                    <input
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
                      placeholder="系统流 · 末日求生"
                    />
                  </label>
                </div>
                <DialogFooter>
                  <Button variant="outline">取消</Button>
                  <Button>创建</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          {/* popover 面：DropdownMenu / Popover / Command 都建在这一层上 */}
          <div className="mt-6">
            <div className="mb-2 text-xs text-muted-foreground">
              弹层面（<code className="rounded bg-muted px-1">bg-popover</code>）—— 本次新补的令牌，
              下拉/右键菜单/命令面板将统一用它
            </div>
            <div className="w-64 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
              {['移入回收站', '重命名', '导出本章'].map((t) => (
                <div key={t} className="rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground">
                  {t}
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* ③ 外壳骨架 */}
        <Section title="③ 外壳骨架" hint="顶栏 / 活动栏 / 文档标签 / 状态栏 —— 用真实信息架构（假数据），看整体气质。">
          <div className="overflow-hidden rounded-lg border border-border">
            {/* 顶栏 */}
            <div className="flex h-9 items-center gap-3 border-b border-border bg-card px-3">
              <Button variant="ghost" size="icon" className="size-7" aria-label="返回书架">
                <PanelLeft />
              </Button>
              <nav className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>砚舟</span>
                <span className="text-border">/</span>
                <span className="font-medium text-foreground">第一章 夜班</span>
              </nav>
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm">重写</Button>
                <Button variant="ghost" size="sm">夜间</Button>
                <Button variant="ghost" size="icon" className="size-7" aria-label="设置"><Settings /></Button>
              </div>
            </div>

            <div className="flex h-[420px]">
              {/* 活动栏 */}
              <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-2" aria-label="活动栏">
                {RAIL_ICONS.map((it, i) => (
                  <button
                    key={it.label}
                    type="button"
                    aria-label={it.label}
                    aria-pressed={rail === i}
                    onClick={() => setRail(i)}
                    className={cn(
                      'relative flex size-8 items-center justify-center rounded-md transition-colors',
                      rail === i
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )}
                  >
                    <it.icon className="size-4" />
                  </button>
                ))}
              </nav>

              {/* 主区 + 右栏（分屏示意） */}
              <div className="flex min-w-0 flex-1 flex-col">
                {/* 文档标签 */}
                <div className="flex h-8 shrink-0 items-center border-b border-border bg-card" role="group" aria-label="文档标签">
                  {DOC_TABS.map((t, i) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTab(i)}
                      className={cn(
                        'flex h-full items-center gap-1 border-r border-border px-3 text-xs transition-colors',
                        tab === i
                          ? 'bg-background text-foreground shadow-[inset_0_1px_0_hsl(var(--primary))]'
                          : 'text-muted-foreground hover:bg-accent/60',
                      )}
                    >
                      <FileText className="size-3" />
                      <span className="truncate">{t}</span>
                      <X className="size-3 opacity-50" />
                    </button>
                  ))}
                  <button type="button" aria-label="打开文档标签" className="ml-1 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60">
                    <Plus className="size-3" />
                  </button>
                  <div className="ml-auto flex items-center gap-1 pr-2">
                    <Button variant="ghost" size="sm" className="h-6 gap-1 text-[10px]">
                      <Columns2 className="size-3" /> 分屏
                    </Button>
                  </div>
                </div>

                <div className="flex min-h-0 flex-1">
                  {/* 左：章节列表 */}
                  <div className="w-56 shrink-0 overflow-y-auto border-r border-border p-2">
                    <div className="mb-2 flex items-center gap-2 px-1">
                      <Search className="size-3 text-muted-foreground" />
                      <span className="text-[10px] text-muted-foreground">搜索…</span>
                    </div>
                    {CHAPTERS.map((c) => (
                      <div
                        key={c.title}
                        className={cn(
                          'flex items-center justify-between rounded-md px-2 py-1 text-xs',
                          c.active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50',
                        )}
                      >
                        <span className="truncate">{c.title}</span>
                        <span className="ml-2 shrink-0 text-[9.5px] tabular-nums opacity-60">{c.words}</span>
                      </div>
                    ))}
                  </div>

                  {/* 中：正文 */}
                  <div className="min-w-0 flex-1 overflow-y-auto bg-background p-8">
                    <h2 className="mb-6 text-center text-lg font-semibold">第一章 夜班</h2>
                    <div className="mx-auto max-w-[34em] space-y-3 text-sm leading-[1.9]">
                      <p>陈默把手放下来。手落到身侧。他没往前走，也没转身。绿光在他鞋面上亮了一块，亮着亮着，他退了一步，再退一步，退进黑里。</p>
                      <p>苏晚的手指还扣在陈默袖口上，扣了一下，松开，落回身侧。「他按了。」她说。</p>
                      <p className="text-muted-foreground">（正文排版本身不入本次改造 —— 宣纸/横格纸那套保留，这里只示意外壳。）</p>
                    </div>
                  </div>

                  {/* 右：AI 对话（分屏） */}
                  <div className="flex w-72 shrink-0 flex-col border-l border-border bg-card">
                    <div className="flex h-8 items-center gap-2 border-b border-border px-3">
                      <Sparkles className="size-3 text-muted-foreground" />
                      <span className="text-xs font-medium">AI 对话</span>
                      <span className="ml-auto text-[9.5px] text-muted-foreground">对话智能体</span>
                    </div>
                    <div className="flex-1 space-y-3 overflow-y-auto p-3">
                      <div className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground">
                        写第 2 章：陈默去公司查姐姐的行踪
                      </div>
                      <div className="max-w-[92%] text-xs leading-relaxed text-muted-foreground">
                        收到。剧情设计师先给三条可能的开场，设定管家会核对第二〇三号柜的伏笔时机……
                      </div>
                    </div>
                    <div className="border-t border-border p-2">
                      <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1">
                        <input className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground" placeholder="问点什么…" />
                        <Button size="icon" className="size-6"><Send /></Button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 状态栏 */}
            <div className="flex h-6 items-center gap-3 border-t border-border bg-card px-3 text-[10px] text-muted-foreground">
              <span>已保存</span>
              <span>3,272 字</span>
              <span>手写模式</span>
              <span className="ml-auto">VS Code Modern · 亮色</span>
            </div>
          </div>
        </Section>

        {/* ④ 面板外观 */}
        <Section title="④ 面板外观" hint="业务面板（章节/角色/伏笔/图谱…）统一到这套外壳质感：标题条更薄、列表行更紧、控件更小。">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-card">
              <div className="flex h-8 items-center justify-between border-b border-border px-3">
                <span className="text-xs font-medium">章节</span>
                <Button variant="ghost" size="icon" className="size-6"><Plus /></Button>
              </div>
              <div className="p-2">
                {CHAPTERS.map((c) => (
                  <div key={c.title} className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-xs', c.active && 'bg-accent text-accent-foreground')}>
                    <span className="size-1.5 rounded-full bg-muted-foreground/50" />
                    <span className="truncate">{c.title}</span>
                    <span className="ml-auto text-[9.5px] tabular-nums text-muted-foreground">{c.words}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card">
              <div className="flex h-8 items-center justify-between border-b border-border px-3">
                <span className="text-xs font-medium">实体与设定</span>
                <ChevronDown className="size-3 text-muted-foreground" />
              </div>
              <div className="space-y-2 p-3">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">角色</span>
                  <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[9.5px] tabular-nums">12</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">地点</span>
                  <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[9.5px] tabular-nums">5</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">伏笔</span>
                  <span className="ml-auto rounded bg-destructive/10 px-1.5 py-0.5 text-[9.5px] tabular-nums text-destructive">2</span>
                </div>
              </div>
            </div>
          </div>
        </Section>

        <footer className="pb-8 text-center text-xs text-muted-foreground">
          这一页只动 UI。满意后我会把 <code className="rounded bg-muted px-1">DockShell</code> 的外层换成这套，
          再逐个面板换皮 —— 业务逻辑（store / API / 插件契约）一行不改。
        </footer>
      </div>
    </div>
  );
}
