import { useMemo, useEffect, useRef, useState } from 'react';
import { useChapterStore, useStatsStore, useCharacterStore, useOutlineStore, useForeshadowStore } from '@novel-plugins/data-core/stores';
import { BarChart3, TrendingUp, Target, Clock, Award } from 'lucide-react';
import { AchievementBadge, ALL_ACHIEVEMENTS } from './AchievementBadge';
import { useAchievements } from '../hooks/useAchievements';
import { useGSAP, scrollBatchEnter } from '@novel-plugins/ui-kit/gsap';

function useCountUp(target: number, duration = 800) {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    const from = fromRef.current;
    const diff = target - from;
    if (diff === 0) return;

    startTimeRef.current = performance.now();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const tick = (now: number) => {
      const t = Math.min(1, (now - startTimeRef.current) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = Math.round(from + diff * eased);
      setDisplay(val);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      fromRef.current = target;
    };
  }, [target, duration]);

  return display;
}

export function WritingDashboard() {
  const containerRef = useRef<HTMLDivElement>(null);
  // ★ 性能优化：拆 selector，避免订阅整个 store 导致无关字段变化也触发重渲染
  //   之前 `useChapterStore()` 解构会订阅整个 state，liveWordCount 每次按键变化都触发整页重渲染
  //   现在按字段订阅，只有对应字段变化才 re-render
  const chapters = useChapterStore((s) => s.chapters);
  const liveWordCount = useChapterStore((s) => s.liveWordCount);
  const todayWordCount = useStatsStore((s) => s.todayWordCount);
  const dailyGoal = useStatsStore((s) => s.dailyGoal);
  const characters = useCharacterStore((s) => s.characters);
  const nodes = useOutlineStore((s) => s.nodes);
  const foreshadows = useForeshadowStore((s) => s.foreshadows);
  const { unlockedIds, checkAchievements } = useAchievements();

  // ★ 实时总字数：当前编辑章节使用 liveWordCount（每次按键更新），
  // 其余章节用 store 中的 wordCount（200ms 防抖后更新）
  const totalWords = useMemo(() => {
    return chapters.reduce((sum, ch) => {
      if (liveWordCount && ch.id === liveWordCount.chapterId) {
        return sum + liveWordCount.wordCount;
      }
      return sum + (ch.wordCount || 0);
    }, 0);
  }, [chapters, liveWordCount]);

  const progress = dailyGoal > 0 ? Math.min(100, (todayWordCount / dailyGoal) * 100) : 0;

  // ★ 实时数字递增动画：从当前显示值过渡到目标值，store 更新即触发
  const animatedToday = useCountUp(todayWordCount);
  const animatedTotal = useCountUp(totalWords);

  // ★ 写作天数：从 chapters 的 updatedAt 去重计算（有写作活动的独立天数）
  const writingDays = useMemo(() => {
    if (chapters.length === 0) return 0;
    const dates = new Set<string>();
    for (const ch of chapters) {
      // 有实际内容的章节才算写作活动
      if ((ch.wordCount || 0) > 0) {
        dates.add(new Date(ch.updatedAt).toISOString().split('T')[0]!);
      }
    }
    return dates.size;
  }, [chapters]);

  const animatedDays = useCountUp(writingDays);

  const last7Days = useMemo(() => {
    const now = new Date();
    const days: { day: string; words: number }[] = [];
    const todayDateStr = now.toISOString().split('T')[0]!;

    for (let i = 6; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0]!;

      const words = chapters
        .filter(ch => {
          const updated = new Date(ch.updatedAt);
          return updated.toISOString().split('T')[0] === dateStr;
        })
        .reduce((sum, ch) => {
          // ★ 今日当前编辑章节使用 liveWordCount 实时值，让今日柱状图随写作实时增长
          if (dateStr === todayDateStr && liveWordCount && ch.id === liveWordCount.chapterId) {
            return sum + liveWordCount.wordCount;
          }
          return sum + (ch.wordCount || 0);
        }, 0);

      days.push({
        day: (['日', '一', '二', '三', '四', '五', '六'][date.getDay()] ?? '') as string,
        words,
      });
    }

    return days;
  }, [chapters, liveWordCount]);

  const consecutiveDays = useMemo(() => {
    if (chapters.length === 0) return 0;

    const dates = [...new Set(
      chapters.map(ch => new Date(ch.updatedAt).toISOString().split('T')[0])
    )].sort().reverse();

    if (dates.length === 0) return 0;

    const today = new Date().toISOString().split('T')[0];
    const startDate = dates[0]!;

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    if (startDate !== today && startDate !== yesterdayStr) return 0;

    let streak = 0;
    const current = new Date(startDate);
    for (const dateStr of dates) {
      const expected = current.toISOString().split('T')[0];
      if (dateStr === expected) {
        streak++;
        current.setDate(current.getDate() - 1);
      } else {
        break;
      }
    }

    return streak;
  }, [chapters]);

  // ★ 章节字数 Top5 排名：memoize 避免每次渲染都重排（之前内联在 JSX 中，每次 liveWordCount 变化都重排）
  const top5Chapters = useMemo(
    () => [...chapters].sort((a, b) => b.wordCount - a.wordCount).slice(0, 5),
    [chapters],
  );

  useEffect(() => {
    const newOnes = checkAchievements();
    newOnes.forEach(id => {
      console.warn('🏆 新成就解锁:', id);
    });
  }, [chapters, characters, nodes, foreshadows]);

  // 仅保留卡片入场动画，数字递增由 useCountUp hook 驱动（React 渲染，实时更新）
  useGSAP(() => {
    if (!containerRef.current) return;
    scrollBatchEnter('.dashboard-card');
  }, { scope: containerRef, dependencies: [] });

  const maxDaily = Math.max(...last7Days.map((d) => d.words), 1);

  const metrics = [
    { label: '今日字数', value: animatedToday.toLocaleString(), icon: TrendingUp, sub: `目标 ${dailyGoal.toLocaleString()} · ${Math.round(progress)}%` },
    { label: '总字数', value: animatedTotal.toLocaleString(), icon: BarChart3, sub: `${chapters.length} 章 · 平均 ${chapters.length > 0 ? Math.round(totalWords / chapters.length).toLocaleString() : 0} 字/章` },
    { label: '写作天数', value: String(animatedDays), icon: Target, sub: null },
    { label: '连续写作', value: String(consecutiveDays), icon: Clock, sub: '天' },
  ];

  return (
    <div ref={containerRef} className="h-full overflow-y-auto" style={{ background: 'transparent' }}>
      <div className="max-w-4xl mx-auto px-8 py-8 space-y-8">
        {/* Header */}
        <h2
          className="text-2xl font-semibold text-foreground"
          style={{ letterSpacing: '-0.02em' }}
        >
          📊 写作统计
        </h2>

        {/* Metric Cards */}
        <div className="grid grid-cols-4 gap-3">
          {metrics.map((m) => (
            <div
              key={m.label}
              className="dashboard-card rounded-xl p-4 transition-shadow hover:shadow-sm"
              style={{ background: 'hsl(var(--foreground) / 0.03)', border: '1px solid hsl(var(--border) / 0.4)' }}
            >
              <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-2">
                <m.icon size={13} />
                <span style={{ letterSpacing: '0.03em' }}>{m.label}</span>
              </div>
              <div
                className="text-2xl font-semibold text-foreground tabular-nums"
                style={{ letterSpacing: '-0.02em' }}
              >
                {m.value}
              </div>
              {m.label === '今日字数' && (
                <div className="w-full h-1 rounded-full mt-2.5 overflow-hidden" style={{ background: 'rgba(15,15,15,0.06)' }}>
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${progress}%`, background: 'hsl(var(--mountain-cyan))' }}
                  />
                </div>
              )}
              {m.sub && (
                <div className="text-xs text-muted-foreground mt-1.5">{m.sub}</div>
              )}
            </div>
          ))}
        </div>

        {/* Weekly Trend */}
        <div
          className="rounded-xl p-6"
          style={{ background: 'transparent', border: '1px solid hsl(var(--border) / 0.5)' }}
        >
          <h3
            className="text-xs font-semibold text-muted-foreground uppercase mb-4"
            style={{ letterSpacing: '0.05em' }}
          >
            本周写作趋势
          </h3>
          <div className="flex items-end gap-2 h-36">
            {last7Days.map((d, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1.5">
                <div className="text-xs text-muted-foreground font-medium">
                  {d.words > 0 ? d.words : ''}
                </div>
                <div
                  className="w-full rounded-t transition-all"
                  style={{
                    height: `${Math.max((d.words / maxDaily) * 100, d.words > 0 ? 12 : 3)}%`,
                    minHeight: 3,
                    background: d.words > 0 ? 'hsl(var(--primary))' : 'rgba(15,15,15,0.06)',
                    opacity: d.words > 0 ? 0.8 : 0.4,
                  }}
                />
                <div className="text-xs text-muted-foreground">{d.day}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Chapter Ranking */}
        <div
          className="rounded-xl p-6"
          style={{ background: 'hsl(var(--foreground) / 0.03)', border: '1px solid hsl(var(--border) / 0.4)' }}
        >
          <h3
            className="text-xs font-semibold text-muted-foreground uppercase mb-4"
            style={{ letterSpacing: '0.05em' }}
          >
            章节字数排名
          </h3>
          <div className="space-y-2">
            {top5Chapters.map((ch, i) => (
                <div
                  key={ch.id}
                  className="flex items-center gap-3 py-2 px-3 rounded-2xl"
                  style={{ background: 'hsl(var(--card))' }}
                >
                  <span
                    className="text-xs font-semibold w-5 h-5 flex items-center justify-center rounded-full"
                    style={{
                      background: i === 0 ? 'hsl(var(--primary))' : 'rgba(15,15,15,0.06)',
                      color: i === 0 ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                    }}
                  >
                    {i + 1}
                  </span>
                  <span className="text-sm flex-1 truncate text-foreground">{ch.title}</span>
                  <span className="text-sm font-mono text-muted-foreground">
                    {ch.wordCount.toLocaleString()}
                  </span>
                </div>
              ))}
            {chapters.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">暂无章节数据</p>
            )}
          </div>
        </div>

        {/* Achievements */}
        <div
          className="rounded-xl p-6"
          style={{ background: 'transparent', border: '1px solid hsl(var(--border) / 0.5)' }}
        >
          <h3
            className="text-xs font-semibold text-muted-foreground uppercase mb-4 flex items-center gap-2"
            style={{ letterSpacing: '0.05em' }}
          >
            <Award size={14} />
            成就徽章
            <span className="text-xs font-normal text-muted-foreground ml-auto normal-case">
              {unlockedIds.size}/{ALL_ACHIEVEMENTS.length}
            </span>
          </h3>
          <div className="grid grid-cols-6 gap-1">
            {ALL_ACHIEVEMENTS.map(achievement => (
              <AchievementBadge
                key={achievement.id}
                achievement={achievement}
                unlocked={unlockedIds.has(achievement.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
