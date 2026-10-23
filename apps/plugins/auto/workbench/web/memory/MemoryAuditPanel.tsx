// ============================================================
// ⚠️ 已停用（2026-09-15）—— 不要再往这里加功能
//
// 记忆审计看板已换成图谱版：`MemoryGraphPanel.tsx`。
// 本文件不再被任何组件挂载。三段文字的**内容口径**（冲突 / 各角色 L2 与水车 /
// 审计流水）原样搬到图谱版里，冲突的三态裁决也一并保留 —— 改口径时两处对齐。
//
// 是否物理删除**待拍板**（先标注、不擅自删）。
// ============================================================
//
// 记忆审计看板（M-e）
//
// 三块内容，对应分层记忆架构里需要「看得见」的三件事：
//   ① 审计流水：谁在什么用途下读了全局记忆 / 被拒了什么 —— **隔离只有看得见才可信**
//   ② 事实冲突：同批次同槽位矛盾（两条都没写，等人裁）
//   ③ 各角色私记条数：证明 L2 真的在按 agentId 分开落
//
// 交互：打开时拉一次 + 手动刷新（**不轮询** —— 记忆审计不是实时指标，
// 每次都要读三张表，没必要为它常驻开销）。
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react';
import {
  fetchMemoryView, resolveConflict, ACTION_LABEL, REASON_LABEL,
  type MemoryView,
} from './services/memorySession';

const ROLE_LABEL: Record<string, string> = {
  'plot-designer': '剧情设计师',
  'character-designer': '角色设计师',
  'continuity-keeper': '设定管家',
  convener: '定稿官',
  writer: '写作官',
  reviewer: '意图复核',
  proofreader: '校对门',
  orchestrator: '编排层',
};

function hhmmss(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function MemoryAuditPanel({ projectId }: { projectId?: string | null }) {
  const [view, setView] = useState<MemoryView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 裁决后的后端提示（尤其"需要重跑该章沉淀才会真正改库"这句要说给作者看） */
  const [hint, setHint] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      setView(await fetchMemoryView());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  if (!projectId) {
    return <div className="p-4 text-[12px]" style={{ color: 'hsl(var(--muted-foreground))' }}>未加载项目</div>;
  }

  const denied = view?.audit.filter((a) => !a.allow) ?? [];

  return (
    <div className="p-3.5 flex flex-col gap-3" data-panel="memory">
      {/* ── 头部：一句话说明 + 刷新 ── */}
      <div className="flex items-center gap-2">
        <ShieldCheck size={14} style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />
        <span className="text-[12px] font-medium" style={{ color: 'hsl(var(--foreground))' }}>
          记忆审计
        </span>
        <span className="text-[10.5px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
          谁在什么用途下读了全局记忆
        </span>
        <button
          type="button"
          onClick={() => void load()}
          aria-label="刷新"
          className="ml-auto flex items-center gap-1 text-[10.5px] px-2 py-0.5 rounded"
          style={{ background: 'transparent', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))', cursor: 'pointer' }}
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          刷新
        </button>
      </div>

      {error && (
        <div className="text-[11.5px] rounded-lg px-3 py-2" style={{ background: 'hsl(var(--destructive) / 0.08)', color: 'hsl(var(--destructive))' }}>
          读取失败：{error}
        </div>
      )}

      {hint && (
        <div className="text-[11px] rounded-lg px-3 py-2" data-hint style={{ background: 'hsl(var(--primary) / 0.08)', color: 'hsl(var(--primary))' }}>
          {hint}
        </div>
      )}

      {view && !view.available && (
        <div className="text-[11.5px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
          项目库还没建（先跑一次讨论或立设定，审计才会有内容）。
        </div>
      )}

      {/* ── ① 冲突（最要紧，放最上面）── */}
      {view && view.conflicts.length > 0 && (
        <section>
          <div className="flex items-center gap-1.5 mb-1.5">
            <AlertTriangle size={12} style={{ color: 'hsl(var(--destructive))' }} aria-hidden="true" />
            <span className="text-[11.5px] font-medium" style={{ color: 'hsl(var(--destructive))' }}>
              事实冲突 {view.conflicts.length} 条
            </span>
            <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
              同批次同槽位两个值 —— 两条都没写，等人裁
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            {view.conflicts.map((c) => (
              <div key={c.id} className="rounded-lg px-3 py-2" style={{ border: '0.5px solid hsl(var(--destructive) / 0.4)' }} data-conflict={c.slot}>
                <div className="text-[11.5px]" style={{ color: 'hsl(var(--foreground))' }}>{c.slot}</div>
                <div className="text-[11px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  已在库：<span style={{ color: 'hsl(var(--foreground))' }}>{c.existing ?? '—'}</span>
                  <span className="mx-1.5">✗</span>
                  本批：<span style={{ color: 'hsl(var(--foreground))' }}>{c.incoming ?? '—'}</span>
                  {c.source && <span className="ml-2 opacity-70">（{c.source}）</span>}
                </div>
                {/* 裁决要"有内容"：只打标记等于没裁（记下决策、采用哪个值、要不要重跑沉淀） */}
                <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                  {([
                    ['keep', '用库里那个'],
                    ['accept', '用本批那个'],
                    ['drop', '都不算'],
                  ] as const).map(([decision, label]) => (
                    <button
                      key={decision}
                      type="button"
                      data-resolve={`${c.id}:${decision}`}
                      onClick={() => void resolveConflict(c.id, decision).then((r) => { setHint(r?.hint ?? null); return load(); })}
                      className="text-[10.5px] px-2 py-0.5 rounded"
                      style={{ background: 'transparent', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))', cursor: 'pointer' }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── ③ 各角色私记（隔离在使用中的证据）── */}
      {view && view.agents.length > 0 && (
        <section>
          <div className="text-[11.5px] font-medium mb-1.5" style={{ color: 'hsl(var(--foreground))' }}>
            各角色专属记忆（L2）
          </div>
          <div className="flex flex-col gap-1">
            {view.agents.map((a) => (
              <div key={a.agentId} className="flex items-center gap-2 flex-wrap" data-agent={a.agentId}>
                <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))', minWidth: 66 }}>
                  {ROLE_LABEL[a.agentId] ?? a.agentId}
                </span>
                <span className="text-[10.5px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  经历 {a.said}{a.factRef > 0 ? ` · 事实引用 ${a.factRef}` : ''}
                </span>
                {/* 它自己的水车：斗 1 最新 —— 一眼看出"这个角色现在记得哪几章" */}
                {a.wheel.length > 0 ? (
                  <span className="text-[10.5px] flex items-center gap-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    水车
                    {a.wheel.map((n, i) => (
                      <span
                        key={`${n}-${i}`}
                        className="px-1.5 rounded"
                        style={{
                          background: i === 0 ? 'hsl(var(--primary) / 0.14)' : 'hsl(var(--secondary))',
                          color: i === 0 ? 'hsl(var(--primary))' : 'hsl(var(--foreground))',
                        }}
                        title={i === 0 ? '斗 1（最新）' : `斗 ${i + 1}`}
                      >
                        ch{n}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="text-[10.5px]" style={{ color: 'hsl(var(--muted-foreground))' }}>水车空</span>
                )}
                {a.summaries.length > 0 && (
                  <span className="text-[10.5px]" style={{ color: 'hsl(var(--muted-foreground))' }} title="已出界、压成一句话沉在它自己的长期池">
                    已归档 ch{a.summaries.join('/')}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── ② 审计流水 ── */}
      <section className="min-h-0">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[11.5px] font-medium" style={{ color: 'hsl(var(--foreground))' }}>
            审计流水
          </span>
          <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
            近 {view?.audit.length ?? 0} 条
            {denied.length > 0 && ` · 其中被拒 ${denied.length}`}
          </span>
        </div>
        <div className="flex flex-col" data-audit-list>
          {(view?.audit ?? []).map((a) => (
            <div
              key={a.id}
              className="flex items-start gap-2 py-1"
              style={{ borderBottom: '0.5px dashed hsl(var(--border) / 0.6)' }}
              data-audit={a.action}
            >
              <span className="text-[11px] tabular-nums shrink-0 pt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                {hhmmss(a.at)}
              </span>
              <span
                className="text-[11px] shrink-0 pt-0.5"
                style={{ color: a.allow ? 'hsl(var(--muted-foreground))' : 'hsl(var(--destructive))', minWidth: 40 }}
              >
                {ACTION_LABEL[a.action] ?? a.action}
              </span>
              <span className="text-[11px] shrink-0 pt-0.5" style={{ color: 'hsl(var(--foreground))', minWidth: 62 }}>
                {ROLE_LABEL[a.agentId] ?? a.agentId}
              </span>
              <span className="text-[10.5px] flex-1 min-w-0" style={{ color: 'hsl(var(--muted-foreground))' }}>
                {a.reason ? (REASON_LABEL[a.reason] ?? a.reason) : ''}
                {a.detail ? ` · ${a.detail}` : ''}
              </span>
            </div>
          ))}
          {view && view.audit.length === 0 && (
            <div className="text-[11.5px] py-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
              还没有审计记录 —— 跑一段讨论或流水线就会出现。
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
