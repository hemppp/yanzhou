import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/globals.css';
import {
  ApprovalCard,
  CodeBlock,
  InlineActions,
  LoadingPixels,
  PromptBar,
  SignalChip,
  SignalDot,
  SourceStack,
  StreamingText,
  TaskList,
  ThinkingTrace,
  ToolChip,
  type TaskItem,
} from '@novel-plugins/ui-kit/primitives';

/**
 * AI 交互原语的视觉验证装置（开发期专用，**生产包体不包含**：没有任何入口 import 它）。
 *
 * ⚠️ 千万别再给它配独立 HTML 入口。2026-09-18 实测：`apps/web/primitives-preview.html`
 *    在**浏览器里永远打不开** —— vite.config 里 `vite-plugin-html` 的 configureServer
 *    挂了 `connect-history-api-fallback`，对 index.html 注册了 catch-all rewrite，
 *    且只接管 Accept 含精确 `text/html` 的请求。于是 curl（Accept 为通配符）拿得到、Chrome 拿不到，
 *
 *    ⚠️ 那两个字面字符（星号紧跟斜杠）会**提前闭合本块注释** → tsc 报
 *    TS1109/TS1005/TS1160 一串语法错（2026-09-18 踩）。注释里永远别写它们。
 *    一律被重写成 /index.html 交给 SPA → 路由 404 → 跳登录。该 html 文件已删除。
 *
 * ✅ 正确的打开方式：挂到真实页面里（一份可跑的实现在
 *    `.workbuddy/ui-checks/gen-craft-verify.mjs` 的 MOUNT_PREVIEW）。
 *    在已登录的任意页面 eval 下面这段，它就会顶到前台：
 *
 *    const old = document.getElementById('root');
 *    if (old) { old.id = '__app_root_stashed'; old.style.display = 'none'; }   // ★ 必须隐藏，只改名不行
 *    const d = document.createElement('div'); d.id = 'root';
 *    d.style.cssText = 'position:fixed;inset:0;overflow:auto;z-index:99';
 *    document.body.appendChild(d);
 *    const s = document.createElement('script'); s.type = 'module';
 *    s.textContent = "import('/src/dev/primitivesPreview.tsx')";
 *    document.head.appendChild(s);
 *
 * 本模块**自挂载**到 #root（所以不需要入口 html），并自带三主题切换按钮。
 */

const TASKS: TaskItem[] = [
  { id: '1', title: '读取章节正文与知识库', status: 'done', meta: '3 源 · 0.4s' },
  { id: '2', title: '检索相关伏笔', status: 'done', meta: '命中 2 条 · 1.1s' },
  {
    id: '3',
    title: '生成角色与节奏宪章',
    status: 'running',
    meta: '写作官 · 5.2s',
    detail: '正在对齐三幕结构与角色弧光…',
  },
  { id: '4', title: '一致性校验', status: 'blocked', meta: '等待上一步', detail: '检测到 2 处时间线漂移，需人工确认。' },
  { id: '5', title: '落库', status: 'pending', meta: '—' },
];

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-paper-line px-5 py-6">
      <div className="mc-eyebrow mb-3">{title}</div>
      {children}
    </section>
  );
}

function Gallery() {
  return (
    <div className="space-y-0">
      <Block title="SignalDot / SignalChip —— 唯一允许的彩色出口">
        <div className="flex flex-wrap items-center gap-3">
          {(['idle', 'run', 'done', 'warn', 'stop'] as const).map((t) => (
            <span key={t} className="inline-flex items-center gap-1.5">
              <SignalDot tone={t} pulse={t === 'run'} />
              <SignalChip tone={t}>{t}</SignalChip>
            </span>
          ))}
        </div>
      </Block>

      <Block title="LoadingPixels —— 像素网格加载器">
        <LoadingPixels label="正在读取时间线" />
      </Block>

      <Block title="ThinkingTrace —— 裸文本模式（兼容旧 thinking 字段）">
        <ThinkingTrace
          defaultOpen
          text={'先确认这一章的位置：它是第二幕的转折点。\n需要让主角在这里第一次质疑自己的动机。\n检查伏笔：铜镜在第 3 章埋过，这里可以回收。'}
        />
      </Block>

      <Block title="ThinkingTrace —— 流式中 + 计时">
        <ThinkingTrace isStreaming text="正在检索 40 个物品与 33 个地点…" />
      </Block>

      <Block title="ToolChip —— 折成一行，失败自动展开">
        <div className="flex flex-col items-start gap-0.5">
          <ToolChip event={{ id: 'a', name: 'create_character', status: 'success', entity: { type: 'character', action: 'create', name: '沈砚' } }} label="生成角色" />
          <ToolChip event={{ id: 'b', name: 'update_outline', status: 'calling' }} label="写入大纲" />
          <ToolChip
            event={{ id: 'c', name: 'link_foreshadow', status: 'error', result: '目标伏笔不存在：铜镜（第 3 章）—— 可能是章节已被删除' }}
            label="关联伏笔"
          />
        </div>
      </Block>

      <Block title="TaskList —— 进度轨 + 连接线 + 嵌套">
        <TaskList tasks={TASKS} />
      </Block>

      <Block title="ApprovalCard —— 人机回环（两个动作刻意不等重）">
        <ApprovalCard
          title="要把这 3 条改动写进正文吗？"
          description="写作官建议改写第三段，并新增一处伏笔回收。"
          meta="影响 2 个角色 · 1 处伏笔 · 约 340 字"
          onApprove={() => {}}
          onReject={() => {}}
          preview={
            <div className="whitespace-pre-wrap p-2.5 text-[10.5px] leading-relaxed text-tone-2">
              {'- 他握紧了铜镜，指节发白。\n+ 他握紧了铜镜 —— 冰凉的镜面贴住掌心，像一句迟到的回答。'}
            </div>
          }
        />
      </Block>

      <Block title="StreamingText + 尾部光标 + 来源堆叠 + 行内动作">
        <StreamingText streaming className="max-w-[34rem]">
          <p className="m-0 text-[11.5px] leading-relaxed text-tone">
            铜镜在火光里转了一下，映出的不是他的脸，而是三年前那场雨。
          </p>
        </StreamingText>
        <div className="mt-3">
          <SourceStack
            sources={[
              { id: '1', short: '角', name: '角色 · 沈砚' },
              { id: '2', short: '伏', name: '伏笔 · 铜镜' },
              { id: '3', short: '地', name: '地点 · 破庙' },
              { id: '4', short: '事', name: '事件 · 雨夜' },
              { id: '5', short: '纲', name: '大纲 · 第二幕' },
            ]}
          />
        </div>
        <InlineActions
          actions={[
            { key: 'a', label: '插入正文', onClick: () => {} },
            { key: 'b', label: '再写一版', onClick: () => {} },
            { key: 'c', label: '解释这段', onClick: () => {} },
          ]}
        />
      </Block>

      <Block title="CodeBlock —— 行号槽独立，复制不带行号">
        <CodeBlock
          language="typescript"
          filename="gates.ts"
          code={'export function checkGate(stage: Stage) {\n-  return stage.done;\n+  return stage.done && !stage.drift;\n}'}
        />
      </Block>

      <Block title="PromptBar —— 输入栏（含中文输入法保护）">
        <PromptBar
          value="帮我看看这一章的节奏"
          onChange={() => {}}
          onSubmit={() => {}}
          hint="Enter 发送 · Shift+Enter 换行"
          accessory="12 字"
          toolbar={
            <>
              <SignalChip tone="run">写作官</SignalChip>
              <SignalChip tone="idle">@ 引用</SignalChip>
            </>
          }
        />
      </Block>

      <Block title="墨阶文字三档（对比度实测：tone-2 ≥4.61:1 / tone-3 仅装饰）">
        <div className="space-y-1">
          <p className="text-[11.5px] text-tone">tone —— 正文 / 用户需要读的一切</p>
          <p className="text-[11.5px] text-tone-2">tone-2 —— 标签 / 说明 / 表格 meta</p>
          <p className="text-[11.5px] text-tone-3">tone-3 —— placeholder / disabled / 装饰</p>
          <p className="mc-num text-[11.5px] text-tone-2">等宽数位 mc-num：1,234 字 · 56 秒 · 98.7%</p>
        </div>
      </Block>

      <Block title="圆角四档 + 投影四级">
        {/* ⚠️ 刻意写成字面量而不是 `rounded-${r}`：Tailwind 是**静态扫描**源码取类名的，
            拼接出来的类名它看不见、不会生成 —— 那样这里会全渲染成直角，
            验证就成了假阴性（而且会让人误以为是 CSS 没生效）。 */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="rounded-chip bg-paper px-3 py-2 text-[10.5px] text-tone-2 shadow-hairline">chip 6px</div>
          <div className="rounded-control bg-paper px-3 py-2 text-[10.5px] text-tone-2 shadow-hairline">control 8px</div>
          <div className="rounded-card bg-paper px-3 py-2 text-[10.5px] text-tone-2 shadow-hairline">card 10px</div>
          <div className="rounded-window bg-paper px-3 py-2 text-[10.5px] text-tone-2 shadow-hairline">window 14px</div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="rounded-card bg-paper px-3 py-2 text-[10.5px] text-tone-2 shadow-hairline">hairline</div>
          <div className="rounded-card bg-paper px-3 py-2 text-[10.5px] text-tone-2 shadow-card">card</div>
          <div className="rounded-card bg-paper px-3 py-2 text-[10.5px] text-tone-2 shadow-raised">raised</div>
          <div className="rounded-card bg-paper px-3 py-2 text-[10.5px] text-tone-2 shadow-overlay">overlay</div>
        </div>
      </Block>

      <Block title="字号地板（text-[10px] 应被抬到 11.5px）">
        <p className="text-[10px] text-tone-2">这行写的是 text-[10px]</p>
        <p className="text-[9.5px] text-tone-2">这行写的是 text-[9.5px]</p>
        <p className="text-[8px] text-tone-2">这行写的是 text-[8px]</p>
      </Block>
    </div>
  );
}

function App() {
  // ★ 主题收敛为单档 VS Code Dark Modern（ADR §6.1）：
  //   原先这里是 'light' | 'dark' | 'soot' 三档切换，'soot' 已随水墨三档一并退役。
  //   现在只保留明暗两档用于对照 token 是否两套都生效 —— 主题本身无浅色变体，
  //   所以 'light' 档仅作视觉对照，不代表受支持的主题。
  const [theme, setTheme] = React.useState<'light' | 'dark'>('dark');
  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.setAttribute('data-theme', 'vscode-dark-modern');
  }, [theme]);

  return (
    <div className="min-h-screen bg-paper-canvas">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-paper-line bg-paper px-5 py-3">
        <span className="mc-eyebrow">AI 交互原语 · 视觉验证</span>
        <div className="ml-auto flex gap-1.5">
          {(['light', 'dark'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTheme(t)}
              data-theme-btn={t}
              className={`mc-press rounded-control px-2.5 py-1 text-[10.5px] ${
                theme === t ? 'bg-primary text-primary-foreground' : 'bg-paper-hover-2 text-tone-2'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </header>
      <main className="mx-auto max-w-[46rem] px-5 py-6">
        <div className="overflow-hidden rounded-window bg-paper shadow-card">
          <Gallery />
        </div>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
