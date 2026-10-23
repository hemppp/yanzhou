// ============================================================
// 某个智能体的技能列表（含开关）—— **通用件**
//
// 这是"该 skills UI 并非写作专属"的落点：只要给它一个 agentId，
// 它就渲染那个智能体的技能与开关。今天写作官用它，明天接别的 agent 不必再写一遍。
//
// 数据来自 GET /api/ai/skill-targets/:agentId（技能 + 开关一起下发），
// 开关改动**以服务端返回为准**（不做纯前端乐观更新：开关状态是这个功能的全部意义，
// 界面显示"已开"而服务端是关的，比慢半拍糟得多）。
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertCircle, Inbox } from 'lucide-react';
import { resolveSkillIcon } from './skillsConfig';
import { SkillSwitch } from './SkillSwitch';
import {
  fetchTargetSkills, toggleAgentSkill, toggleAllAgentSkills,
  type TargetSkillsView, type TargetSkill,
} from './services/skillLibrary';
import { dispatchToastEvent } from '@novel-plugins/ui-kit/errors';

export function AgentSkillList({
  agentId, onChanged, compact,
}: {
  agentId: string;
  /** 开关改动后回调（面板左列的计数要跟着变） */
  onChanged?: () => void;
  /** 紧凑模式：描述只留一行（窄栏里用） */
  compact?: boolean;
}) {
  const [view, setView] = useState<TargetSkillsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 正在提交的技能 id（禁用那一条，不锁整页） */
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setView(await fetchTargetSkills(agentId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  const markPending = (id: string, on: boolean) => {
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  };

  /** 单条开关：以服务端结果为准更新本地 */
  const handleToggle = useCallback(async (skill: TargetSkill, next: boolean) => {
    markPending(skill.id, true);
    try {
      await toggleAgentSkill(agentId, skill.id, next);
      setView((v) => {
        if (!v) return v;
        const skills = v.skills.map((s) => (s.id === skill.id ? { ...s, enabled: next, configured: true } : s));
        return {
          target: { ...v.target, enabled: skills.filter((s) => s.enabled).length },
          skills,
        };
      });
      onChanged?.();
    } catch (e) {
      // 失败要说话：静默失败会让人以为"开关点不动"
      dispatchToastEvent({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      markPending(skill.id, false);
    }
  }, [agentId, onChanged]);

  const handleAll = useCallback(async (next: boolean) => {
    setBulkBusy(true);
    try {
      const r = await toggleAllAgentSkills(agentId, next);
      setView((v) => (v ? {
        target: { ...v.target, enabled: next ? v.skills.length : 0 },
        skills: v.skills.map((s) => ({ ...s, enabled: next, configured: true })),
      } : v));
      dispatchToastEvent({ type: 'success', message: `已${next ? '开启' : '关闭'} ${r.count} 条技能`, duration: 2500 });
      onChanged?.();
    } catch (e) {
      dispatchToastEvent({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBulkBusy(false);
    }
  }, [agentId, onChanged]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-[11px] text-muted-foreground" role="status">
        <Loader2 size={13} className="animate-spin" aria-hidden="true" /> 正在读取技能…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-muted-foreground" role="alert">
        <AlertCircle size={13} className="shrink-0 mt-0.5 text-destructive" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-destructive">读取失败：{error}</div>
          <button onClick={() => void load()} className="mt-1 underline hover:text-foreground">重试</button>
        </div>
      </div>
    );
  }

  if (!view) return null;
  const skills = view.skills;

  return (
    <div className="flex flex-col gap-2">
      {/* 头部：计数 + 批量开关。计数是"配了几条"的唯一凭据，别藏起来 */}
      <div className="flex items-center gap-2 px-1">
        <span className="text-[11px] text-muted-foreground">
          已开启 <span className="text-foreground font-semibold">{view.target.enabled}</span> / {view.target.total}
        </span>
        <div className="flex-1" />
        <button
          disabled={bulkBusy || skills.length === 0}
          onClick={() => void handleAll(true)}
          className="text-[11px] px-1.5 py-0.5 rounded-md border hover:bg-muted/60 disabled:opacity-40"
        >全部开启</button>
        <button
          disabled={bulkBusy || skills.length === 0}
          onClick={() => void handleAll(false)}
          className="text-[11px] px-1.5 py-0.5 rounded-md border hover:bg-muted/60 disabled:opacity-40"
        >全部关闭</button>
      </div>

      {skills.length === 0 && (
        <div className="flex flex-col items-center gap-1.5 py-6 text-[11px] text-muted-foreground" role="status">
          <Inbox size={16} aria-hidden="true" />
          <div>{view.target.name}名下还没有技能</div>
          <div className="text-[11px] opacity-80">去「智能体 Skills → 技能库」安装，或把已有技能的归属改到它</div>
        </div>
      )}

      <ul className="flex flex-col gap-1">
        {skills.map((s) => {
          const Icon = resolveSkillIcon(s.iconKey || s.id);
          const busy = pending.has(s.id);
          return (
            <li
              key={s.id}
              data-skill={s.id}
              data-enabled={s.enabled ? 'true' : 'false'}
              className="flex items-center gap-2 rounded-xl px-2 py-1.5 border"
              style={{
                borderColor: s.enabled ? `${s.color}66` : 'hsl(var(--border) / 0.6)',
                background: s.enabled ? `${s.color}12` : 'transparent',
              }}
            >
              <Icon size={14} style={{ color: s.color }} className="shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium truncate flex items-center gap-1.5">
                  <span className="truncate">{s.name}</span>
                  {s.source === 'installed' && (
                    <span className="shrink-0 text-[11px] px-1 rounded bg-muted text-muted-foreground">已装</span>
                  )}
                </div>
                {s.description && (
                  <div className={`text-[11px] text-muted-foreground leading-tight ${compact ? 'truncate' : 'line-clamp-2'}`}>
                    {s.description}
                  </div>
                )}
              </div>
              <SkillSwitch
                enabled={s.enabled}
                busy={busy}
                label={`${s.name} 技能开关（${view.target.name}）`}
                onChange={(next) => void handleToggle(s, next)}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
