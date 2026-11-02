// ============================================================
// WorkbenchPlan — 当前章的「工作计划」卡（2026-09-11 换内核）
//
// ★ 为什么换：原版拉的是 autowrite 的 `GET /batches` —— 那是**旧流水线**的产物
//   （规划官产出的批次计划），与新流程脱节：新流程以**单章**为单位，
//   讨论 → 收敛 → 写作 → 复核 → 交付，核心产物是「本章结论」而不是批次。
//
// 现在这张卡以当前章为中心：
//   上半 阶段推进（讨论 / 写作 / 意图门 / 校对门 / 润色门 / 交付）
//        —— 状态由前端**按收到的事件累积**（收到 conclusion 即讨论完成、收到 gate 即该门完成），
//           不解析 phase 文案：文案会改，事件契约不会。
//   下半 本章结论（讨论的产物 —— 也是意图复核的对照物）
//
// 结论文本由定稿官按固定字段输出，这里做**容错解析**：
// 认得出来就结构化展示，认不出来就原样显示，绝不因为格式跑偏而丢内容。
// ============================================================

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ListOrdered } from 'lucide-react';

export type StageKey = 'discuss' | 'write' | 'review' | 'check' | 'polish' | 'deliver';
export type StageState = 'idle' | 'running' | 'done' | 'blocked';

/**
 * 单章闭环的六个阶段。
 * ★ 导出给 ChapterPlanGraphPanel 复用 —— 阶段名与顺序是**契约**，
 *   图谱版与列表版各写一份必然漂移（改一处漏一处是这类 UI 最典型的 bug）。
 */
export const STAGES: ReadonlyArray<{ key: StageKey; label: string; hint: string }> = [
  { key: 'discuss', label: '讨论', hint: '设计智能体来回讨论并收敛出本章结论' },
  { key: 'write', label: '写作', hint: '写作官据结论出稿（目标 3000 字，不足 2500 会先补写）' },
  { key: 'review', label: '意图门', hint: '对照本章结论查有无落实；打回上限 2 次' },
  { key: 'check', label: '校对门', hint: '全文对照设定库查冲突；给一次定向修订后不拦交付' },
  { key: 'polish', label: '润色门', hint: '质量评分（软门，只评分不拦交付）' },
  { key: 'deliver', label: '交付', hint: '写入章节；该章已有正文时按治理原则不自动覆盖' },
];

/** 定稿官约定的字段名 —— 只有认得出的字段才做结构化 */
// 顺序与 discuss/roles.ts 的 ROLE_CONVENER 输出格式保持一致（「角色」是 2026-09-12 补的：
// 此前格式里没有角色栏，而实体沉淀与意图复核都靠它，见 framework/entity-sink.ts）
const CONCERN_FIELDS = ['节拍', '角色', '关键物', '伏笔', '禁项', '结束状态', '待定'];

/** 阶段四态配色 —— 走语义变量。idle 此前误用了并不存在的 --border-secondary（一直靠 fallback 兜着） */
const STATE_STYLE: Record<StageState, { dot: string; text: string; label: string }> = {
  idle: { dot: 'hsl(var(--state-idle))', text: 'hsl(var(--muted-foreground))', label: '待开始' },
  running: { dot: 'hsl(var(--state-running))', text: 'hsl(var(--state-running))', label: '进行中' },
  done: { dot: 'hsl(var(--state-done))', text: 'hsl(var(--state-done))', label: '已完成' },
  blocked: { dot: 'hsl(var(--state-blocked))', text: 'hsl(var(--state-blocked))', label: '被挡下' },
};

interface ConclusionField {
  key: string;
  value: string;
}

/** 把定稿官的固定格式解析成字段；解析不出来就返回空数组（调用方原样兜底） */
function parseConclusion(text: string): ConclusionField[] {
  const out: ConclusionField[] = [];
  let cur: ConclusionField | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^：:]{1,8})[：:]\s*(.*)$/);
    if (m && CONCERN_FIELDS.includes((m[1] ?? '').trim())) {
      if (cur) out.push(cur);
      cur = { key: (m[1] ?? '').trim(), value: m[2] ?? '' };
    } else if (cur) {
      // 续行（列表项等）
      cur.value += '\n' + line;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export interface WorkbenchPlanProps {
  /** 当前章标题（可选） */
  chapterTitle?: string;
  /** 讨论收敛出的「本章结论」；空 = 还没讨论 */
  conclusion?: string | null;
  /** 是否正在跑一轮会话（用于把「讨论」标成进行中） */
  running?: boolean;
  /** 其余阶段的状态；未实现的阶段传 idle 即可 */
  stages?: Partial<Record<StageKey, StageState>>;
}

export function WorkbenchPlan({ chapterTitle, conclusion, running, stages }: WorkbenchPlanProps) {
  const [open, setOpen] = useState(true);

  const fields = useMemo(() => (conclusion ? parseConclusion(conclusion) : []), [conclusion]);

  const stateOf = (key: StageKey): StageState => {
    if (key === 'discuss') {
      if (conclusion) return 'done';
      return running ? 'running' : 'idle';
    }
    return stages?.[key] ?? 'idle';
  };

  return (
    <section
      className="flex flex-col min-h-0 rounded-xl h-full w-full"
      style={{ background: 'hsl(var(--card) / 0.5)', border: '0.5px solid hsl(var(--border) / 0.55)' }}
    >
      <header
        className="shrink-0 flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: '0.5px solid hsl(var(--border) / 0.45)' }}
      >
        <ListOrdered size={12} style={{ color: 'hsl(var(--primary) / 0.85)' }} aria-hidden="true" />
        <span className="text-[12px] font-medium" style={{ color: 'hsl(var(--ink))' }}>
          本章计划
        </span>
        {chapterTitle && (
          <span className="text-[11px] truncate max-w-[180px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
            {chapterTitle}
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto inline-flex items-center justify-center rounded-md"
          title={open ? '收起结论' : '展开结论'}
          aria-label={open ? '收起本章结论' : '展开本章结论'}
          aria-expanded={open}
          style={{ width: 22, height: 22, color: 'hsl(var(--muted-foreground))' }}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5">

        {/* —— 阶段推进 —— */}
        <ol className="flex items-center gap-1 flex-wrap mb-3">
          {STAGES.map((s, i) => {
            const st = stateOf(s.key);
            const sty = STATE_STYLE[st];
            return (
              <li key={s.key} className="flex items-center gap-1">
                <span
                  className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded"
                  title={s.hint}
                  style={{ background: st === 'idle' ? 'transparent' : 'rgb(var(--glass-tint) / 0.45)' }}
                >
                  <span
                    className="rounded-full"
                    style={{ width: 6, height: 6, background: sty.dot }}
                    aria-hidden="true"
                  />
                  <span className="text-[11px] font-medium" style={{ color: st === 'idle' ? 'hsl(var(--muted-foreground))' : 'hsl(var(--ink))' }}>
                    {s.label}
                  </span>
                  <span className="text-[11px]" style={{ color: sty.text }}>
                    {sty.label}
                  </span>
                </span>
                {i < STAGES.length - 1 && (
                  <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground) / 0.5)' }} aria-hidden="true">
                    ›
                  </span>
                )}
              </li>
            );
          })}
        </ol>

        {/* —— 本章结论 —— */}
        {!conclusion ? (
          <div className="text-[11px] leading-[1.75]" style={{ color: 'hsl(var(--muted-foreground) / 0.85)' }}>
            还没有结论。在左侧对智能体说明这一章要写什么，讨论收敛出的「本章结论」会落在这里 ——
            它既是写作官的输入，也是复核时的对照物。
          </div>
        ) : !open ? (
          <div className="text-[11px] truncate" style={{ color: 'hsl(var(--muted-foreground) / 0.85)' }}>
            本章结论已收敛（收起中）
          </div>
        ) : fields.length === 0 ? (
          // 格式跑偏时原样显示，绝不丢内容
          <pre
            className="text-[11px] leading-[1.75] whitespace-pre-wrap"
            style={{ color: 'hsl(var(--ink-light))', margin: 0, fontFamily: 'inherit' }}
          >
            {conclusion}
          </pre>
        ) : (
          <dl className="space-y-1.5">
            {fields.map((f) => (
              <div key={f.key} className="flex gap-2">
                <dt
                  className="shrink-0 text-[11px] font-medium"
                  style={{ color: 'hsl(var(--primary) / 0.9)', minWidth: 48 }}
                >
                  {f.key}
                </dt>
                <dd
                  className="text-[11px] leading-[1.7] whitespace-pre-wrap"
                  style={{ color: 'hsl(var(--ink-light))', margin: 0, minWidth: 0 }}
                >
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}
