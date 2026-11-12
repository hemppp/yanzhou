// ============================================================
// auto 子插件 · health —— 章节体检
//
// 设计取向：**产品仪表盘**，不是报表。
//   顶部一句结论（这本书现在能不能定稿）→ 四张指标卡 → 一张验收图 → 一列待办。
//   目标：打开 3 秒知道"要不要动手"、10 秒知道"动哪几章、动什么"。
//
// ★ 判据全部来自服务端 `/chapters/health`，本文件不定义任何阈值 ——
//   连图上那个"可定稿区"的边界也是 report.band / report.dialogue 给的。
//
// ★ 配色：只用一个语义双色（好 / 坏）+ 三段灰。宿主可用
//   --health-good / --health-bad 覆盖；没定义就用内置值，因此不依赖宿主色板。
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Loader2, AlertTriangle, FileText, Activity } from 'lucide-react';
import { apiClient } from '@novel-plugins/data-core/api/apiClient';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import { HealthScatter } from './HealthScatter';
import {
  extractHealthReport, groupHealth, verdictSegments, dupCountRange, fmtNum,
  type HealthReport,
} from './services/healthData';

const GOOD = 'var(--health-good, #2f8f6b)';
const BAD = 'var(--health-bad, #d4553a)';
const MONO = 'var(--yz-font-mono)';

const C = {
  card: 'hsl(var(--card))',
  ink: 'hsl(var(--foreground))',
  muted: 'hsl(var(--muted-foreground))',
  line: 'hsl(var(--border))',
};

export function ChapterHealthPanel({ projectId: projectIdProp }: { projectId?: string | null } = {}) {
  const currentProjectId = useCurrentProjectId();
  const projectId = projectIdProp ?? currentProjectId;

  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) { setReport(null); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.get<unknown>(
        'plugins/autowrite/chapters/health', undefined, {
          silent: true,
          timeoutMs: 60_000,
          /**
           * ★ 显式带项目头：apiClient 默认从全局 getter 取 X-Project-Id，
           *   而首次挂载时「面板已拿到 projectId」与「全局 getter 已注册」之间有窗口，
           *   实测会打出 400（缺头）。这里以组件自己的 projectId 为准，消除竞态。
           *
           * ★ 键名必须与 apiClient 的 `X-Project-Id` **大小写完全一致**：
           *   它用的是对象展开合并（`{...dynamic, ...options.headers}`），
           *   写成小写会让两个键同时存在，`Headers` 把值用逗号拼成
           *   `"<id>, <id>"` —— 后端解析失败，返回 404「项目不存在」。
           */
          headers: { 'X-Project-Id': projectId },
        },
      );
      setReport(extractHealthReport(res));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const data = useMemo(() => {
    if (!report) return null;
    const groups = groupHealth(report.chapters);
    const total = report.chapters.length;
    return {
      ...report,
      groups,
      total,
      ok: groups.ok.length,
      needFix: total - groups.ok.length,
      verdict: verdictSegments(groups, report.band.min, Math.round(report.dialogue.floor * 100)),
      avg: report.summary.avgChars,
    };
  }, [report]);

  if (!projectId) {
    return <Notice title="还没有选书" hint="在左上角选一本，这里会显示它的章节体检。" />;
  }
  if (!loading && data && data.total === 0) {
    return <Notice title="这本书还没有章节" hint="去「流水线」跑到试写或长跑，写出来的章会自动出现在这里。" />;
  }

  return (
    <div data-panel="health" style={{
      height: '100%', overflowY: 'auto', color: C.ink,
      background: 'hsl(var(--background))',
    }}>
      <div style={{ maxWidth: 1040, margin: '0 auto', padding: '26px 26px 44px' }}>

        {/* ─── 结论头 ─── */}
        <header style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          {/* ★ minWidth 不能给死值：工作台面板窄到 ~290px 时，
              280 的最小宽会直接把内容顶出容器（实测溢出 58px）。给 0 交给 flex 收缩。 */}
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 7, fontSize: 11,
              letterSpacing: '0.14em', color: C.muted, marginBottom: 10,
            }}>
              <Activity size={12} aria-hidden="true" />章节体检
            </div>
            <h1 style={{
              margin: 0, fontSize: 30, lineHeight: 1.18, fontWeight: 650,
              letterSpacing: '-0.02em',
            }}>
              {data ? headline(data.ok, data.total) : '正在体检…'}
            </h1>
            {data && (
              <p style={{ margin: '10px 0 0', fontSize: 13.5, lineHeight: 1.75, color: C.muted }}>
                {data.verdict.head.map((s, i) => (
                  <span key={i} style={s.emph ? { color: C.ink, fontWeight: 600 } : undefined}>{s.text}</span>
                ))}
                <br />
                {data.verdict.tail.map((s, i) => <span key={i}>{s.text}</span>)}
              </p>
            )}
          </div>

          <button type="button" onClick={() => void load()} disabled={loading}
            aria-label="重新体检"
            style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '7px 12px',
              borderRadius: 9, background: C.card, border: `1px solid ${C.line}`, color: C.muted,
              cursor: loading ? 'default' : 'pointer', flex: '0 0 auto',
            }}>
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            重新体检
          </button>
        </header>

        {error && (
          <div style={{
            marginTop: 16, display: 'flex', gap: 8, alignItems: 'flex-start',
            fontSize: 12, padding: '10px 14px', borderRadius: 10,
            background: 'color-mix(in srgb, ' + BAD + ' 8%, transparent)',
            color: BAD, border: `1px solid color-mix(in srgb, ${BAD} 22%, transparent)`,
          }}>
            <AlertTriangle size={13} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden="true" />
            <span>体检失败：{error}</span>
          </div>
        )}

        {data && (
          <>
            {/* ─── 指标卡 ─── */}
            <div style={{
              display: 'grid', gap: 12, marginTop: 22,
              // ★ min(100%, …)：容器比 150 还窄时，minmax(150px) 会把格子撑爆（实测溢出 58px）
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))',
            }}>
              <Stat
                label="可定稿"
                value={`${data.ok}`}
                suffix={`/ ${data.total} 章`}
                bar={{ ratio: data.total ? data.ok / data.total : 0, color: GOOD }}
              />
              <Stat label="平均篇幅" value={fmtNum(data.avg)} suffix="字 / 章"
                hint={`目标 ${fmtNum(data.band.target)} 字`} />
              <Stat label="篇幅要改" value={`${data.groups.short.length + data.groups.long.length}`}
                suffix="章" tone={data.groups.short.length + data.groups.long.length ? BAD : GOOD}
                hint={`${data.band.min}–${data.band.max} 字`} />
              <Stat label="对话要改" value={`${data.groups.dialogueOnly.length}`}
                suffix="章" tone={data.groups.dialogueOnly.length ? BAD : GOOD}
                hint={`下限 ${Math.round(data.dialogue.floor * 100)}%`} />
            </div>

            {/* ─── 验收图 ─── */}
            <Card style={{ marginTop: 14 }}>
              <CardHead title="一章一个点"
                sub="方块里 = 可以定稿。落在外面时，从哪个方向出去就说明该修什么。"
                right={<Legend good={GOOD} bad={BAD} />} />
              <div style={{ marginTop: 8 }}>
                <HealthScatter
                  chapters={data.chapters}
                  band={data.band}
                  dialogueFloor={data.dialogue.floor}
                  dialogueCeiling={data.dialogue.ceiling}
                  bad={BAD}
                  good={GOOD}
                />
              </div>
            </Card>

            {/* ─── 待办 ─── */}
            <Card style={{ marginTop: 14 }}>
              <CardHead title={`要动的 ${data.needFix} 章`}
                sub="左边补字数、右边补对话。两栏不重叠：篇幅是硬门，先归篇幅。" />
              <div style={{
                display: 'grid', gap: '4px 34px', marginTop: 14,
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
              }}>
                <FixGroup
                  title="篇幅"
                  count={data.groups.short.length + data.groups.long.length}
                  hint={`${data.band.min}–${data.band.max} 字`}
                  color={BAD}
                >
                  {[...data.groups.short, ...data.groups.long].map((c) => (
                    <FixRow key={c.order} order={c.order}
                      /* 条形按上限归一，门槛线落在 min/max 处 */
                      ratio={c.chars / data.band.max}
                      threshold={data.band.min / data.band.max}
                      color={BAD}
                      value={fmtNum(c.chars)}
                      delta={c.length === 'low' ? `−${fmtNum(data.band.min - c.chars)}` : `+${fmtNum(c.chars - data.band.max)}`} />
                  ))}
                </FixGroup>

                <FixGroup
                  title="对话"
                  count={data.groups.dialogueOnly.length}
                  hint={`下限 ${Math.round(data.dialogue.floor * 100)}%`}
                  color={BAD}
                >
                  {data.groups.dialogueOnly
                    .slice().sort((a, b) => a.dialogueRatio - b.dialogueRatio)
                    .map((c) => (
                      <FixRow key={c.order} order={c.order}
                        ratio={c.dialogueRatio / data.dialogue.ceiling}
                        threshold={data.dialogue.floor / data.dialogue.ceiling}
                        color={BAD}
                        /* 两位小数：14.97% 若留一位会显示成 15.0%，与"低于 15%"自相矛盾 */
                        value={`${(c.dialogueRatio * 100).toFixed(2)}%`}
                        delta={`−${((data.dialogue.floor - c.dialogueRatio) * 100).toFixed(2)}`} />
                    ))}
                  {data.groups.dup.length > 0 && (
                    <p style={{ margin: '10px 0 0', fontSize: 11.5, lineHeight: 1.7, color: C.muted }}>
                      {data.groups.dup.map((c) => `第 ${c.order} 章`).join('、')} 有跨章重复
                      （{dupCountRange(data.groups.dup)}），未达打回线，不计入上面两栏。
                    </p>
                  )}
                </FixGroup>
              </div>
            </Card>

            <p style={{
              margin: '18px 2px 0', fontSize: 11, lineHeight: 1.8, color: C.muted, opacity: 0.85,
            }}>
              判据与流水线同源：篇幅带、对话阈值、重复阈值全部取自服务端现役常量，前端不另写。
              所以"这里说合格"与"流水线放行"不会打架 —— 它们读的是同一个数。
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── 零件 ─────────────────────────── */

function headline(ok: number, total: number): string {
  if (total === 0) return '还没有章节';
  if (ok === total) return '全书都能定稿了';
  if (ok === 0) return '还没有一章能定稿';
  return `${total - ok} 章还不能定稿`;
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section style={{
      background: C.card, border: `1px solid ${C.line}`, borderRadius: 14,
      padding: '16px 18px 18px',
      ...style,
    }}>{children}</section>
  );
}

function CardHead({ title, sub, right }: { title: string; sub: string; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 620, letterSpacing: '-0.01em' }}>{title}</h2>
        <p style={{ margin: '4px 0 0', fontSize: 11.5, lineHeight: 1.6, color: C.muted }}>{sub}</p>
      </div>
      {right}
    </div>
  );
}

function Legend({ good, bad }: { good: string; bad: string }) {
  const item = (color: string, text: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: C.muted }}>
      <i style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />{text}
    </span>
  );
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', paddingTop: 2 }}>
      {item(good, '可定稿')}
      {item(bad, '要改')}
    </div>
  );
}

function Stat({ label, value, suffix, hint, tone, bar }: {
  label: string;
  value: string;
  suffix: string;
  hint?: string;
  tone?: string;
  bar?: { ratio: number; color: string };
}) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: '13px 15px 14px',
      display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0,
    }}>
      <span style={{ fontSize: 10.5, letterSpacing: '0.1em', color: C.muted }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 }}>
        <b style={{
          fontSize: 25, lineHeight: 1.1, fontWeight: 640, letterSpacing: '-0.02em',
          fontVariantNumeric: 'tabular-nums', color: tone ?? C.ink,
        }}>{value}</b>
        <span style={{ fontSize: 11, color: C.muted, whiteSpace: 'nowrap' }}>{suffix}</span>
      </span>
      {bar && (
        <span style={{ display: 'block', height: 4, borderRadius: 2, background: 'hsl(var(--border))', marginTop: 4, overflow: 'hidden' }}>
          <span style={{
            display: 'block', height: '100%', borderRadius: 2, background: bar.color,
            width: `${Math.max(2, Math.min(100, bar.ratio * 100))}%`,
          }} />
        </span>
      )}
      {hint && <span style={{ fontSize: 10.5, color: C.muted, opacity: 0.85 }}>{hint}</span>}
    </div>
  );
}

function FixGroup({ title, count, hint, color, children }: {
  title: string; count: number; hint: string; color: string; children: React.ReactNode;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10,
        paddingBottom: 8, borderBottom: `1px solid ${C.line}`,
      }}>
        <span style={{ width: 7, height: 7, borderRadius: 2, background: color, display: 'inline-block' }} />
        <b style={{ fontSize: 12.5, fontWeight: 600 }}>{title}</b>
        <span style={{ fontSize: 11.5, color: color, fontVariantNumeric: 'tabular-nums' }}>{count} 章</span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: C.muted }}>{hint}</span>
      </div>
      {count === 0
        ? <p style={{ margin: '4px 0 8px', fontSize: 11.5, color: C.muted }}>这一项没有要改的章。</p>
        : <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</div>}
    </div>
  );
}

function FixRow({ order, ratio, threshold, color, value, delta }: {
  order: number; ratio: number; threshold: number; color: string; value: string; delta: string;
}) {
  const w = Math.max(2, Math.min(100, ratio * 100));
  const t = Math.max(0, Math.min(100, threshold * 100));
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '44px minmax(24px, 1fr) auto', alignItems: 'center',
      gap: 9, padding: '5px 0',
    }}>
      <span style={{ fontSize: 11, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>第 {order} 章</span>
      <span style={{ position: 'relative', height: 5, borderRadius: 3, background: 'hsl(var(--border))' }}>
        <span style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3,
          width: `${w}%`, background: color, opacity: 0.85,
        }} />
        {/* 门槛刻度：让"差多少"有参照，而不是只有一条孤零零的条 */}
        <span style={{
          position: 'absolute', top: -3, bottom: -3, left: `${t}%`, width: 1.5,
          background: C.ink, opacity: 0.28,
        }} />
      </span>
      <span style={{
        fontSize: 11, textAlign: 'right', fontFamily: MONO,
        fontVariantNumeric: 'tabular-nums', color: C.ink,
      }}>
        {value}
        <span style={{ color: C.muted, marginLeft: 6 }}>{delta}</span>
      </span>
    </div>
  );
}

function Notice({ title, hint }: { title: string; hint: string }) {
  return (
    <div data-panel="health" style={{
      height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 8, padding: '60px 24px', textAlign: 'center',
      background: 'hsl(var(--background))',
    }}>
      <FileText size={26} style={{ color: C.muted, opacity: 0.45 }} aria-hidden="true" />
      <div style={{ fontSize: 13, color: C.ink }}>{title}</div>
      <div style={{ fontSize: 11.5, lineHeight: 1.7, color: C.muted, maxWidth: 330 }}>{hint}</div>
    </div>
  );
}

export default ChapterHealthPanel;
