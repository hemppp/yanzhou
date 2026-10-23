// ============================================================
// 「智能体 Skills」面板（输入栏上方的第二个入口）
//
// 用户口径（2026-09-13）：
//   · 点击后展示**当前全部智能体**，并可为每个智能体单独配置 skills；
//   · 点某个智能体 → 看到**左关右开**的开关，用于开启/关闭该智能体的 skills；
//   · 添加技能的方式是一个**集中的 skills 库**：只支持安装与删除，
//     内部按「智能体 skills」与「agent skills」两类分开存放。
//
// 因此本面板两个页签：
//   按智能体 —— 智能体清单 → 下钻到某一个 → 它的技能 + 开关（复用 AgentSkillList）
//   技能库   —— 库的全部内容（按两类分组）+ 安装 / 删除
//
// ★ 不做成"左列智能体 + 右列技能"的左右分栏：这个面板挂在 AI 交流栏上方，
//   宽度只有三百来像素，两栏会挤到看不清技能名。下钻式在窄栏里更好用，
//   而且与"点击某个智能体后即可看到开关"这句描述完全一致。
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Loader2, AlertCircle, Trash2, Plus, X, PackageOpen,
} from 'lucide-react';
import { AgentSkillList } from './AgentSkillList';
import { EntrySkillPanel } from './EntrySkillPanel';
import { resolveSkillIcon } from './skillsConfig';
import {
  fetchSkillTargets, fetchSkillLibrary, fetchSkillMarket, installSkillOnLibrary, removeSkillFromLibrary,
  type SkillTargetView, type LibrarySkill, type MarketEntry, type OrphanOwner, type SkillCategory,
} from './services/skillLibrary';
import { dispatchToastEvent } from '@novel-plugins/ui-kit/errors';

type Tab = 'library' | 'market' | 'writer' | 'agents';

/** 智能体头像（色底 + 单字）—— 与交流流里的头像同一套视觉语言 */
function AgentAvatar({ short, color, size = 22 }: { short: string; color: string; size?: number }) {
  return (
    <span
      className="shrink-0 flex items-center justify-center rounded-full font-semibold"
      style={{ width: size, height: size, background: `${color}22`, color, fontSize: size * 0.5, border: `1px solid ${color}55` }}
      aria-hidden="true"
    >
      {short}
    </span>
  );
}

export function AgentSkillsPanel() {
  // ★ 2026-09-17：从「按智能体 / 技能库」两页签扩成三块 —— 技能库 / 写作agent / 智能体。
  //   起因：AI 对话输入栏上方那个「技能」按钮被撤掉，写作官的技能开关改到这里开。
  //   默认落在**技能库**（作者口径：进来先看库里有什么）。
  const [tab, setTab] = useState<Tab>('library');
  const [selected, setSelected] = useState<string | null>(null);

  const [targets, setTargets] = useState<SkillTargetView[] | null>(null);
  const [lib, setLib] = useState<{ skills: LibrarySkill[]; byCategory: { assistant: LibrarySkill[]; agent: LibrarySkill[] }; orphans: OrphanOwner[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  // 技能市场（2026-09-17）：公共目录 + 「我装没装」；installing 是正在装的那条 id
  const [market, setMarket] = useState<MarketEntry[] | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  const loadTargets = useCallback(async () => {
    try {
      const r = await fetchSkillTargets();
      setTargets(r.targets);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadLibrary = useCallback(async () => {
    try {
      setLib(await fetchSkillLibrary());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /** 技能市场：拉公共目录（带「我装没装」） */
  const loadMarket = useCallback(async () => {
    try {
      const r = await fetchSkillMarket();
      setMarket(r.entries);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /**
   * 从市场装一条：**装成当前用户私有的**（后端会把 id 加 `${userId}:` 前缀）。
   * 装完刷新市场（按钮变「已安装」）与技能库（新条目立刻出现）。
   */
  const handleInstallFromMarket = useCallback(async (m: MarketEntry) => {
    setInstalling(m.id);
    try {
      await installSkillOnLibrary({
        id: m.id,
        name: m.name,
        description: m.description,
        category: m.category,
        ownerAgent: m.ownerAgent,
        systemPrompt: m.systemPrompt,
        contextKeys: m.contextKeys,
      });
      dispatchToastEvent({ type: 'success', message: `已安装「${m.name}」` });
      await Promise.all([loadMarket(), loadLibrary(), loadTargets()]);
    } catch (e) {
      dispatchToastEvent({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setInstalling(null);
    }
  }, [loadMarket, loadLibrary, loadTargets]);

  useEffect(() => { void loadTargets(); }, [loadTargets]);
  useEffect(() => { if (tab === 'library') void loadLibrary(); }, [tab, loadLibrary]);
  useEffect(() => { if (tab === 'market') void loadMarket(); }, [tab, loadMarket]);

  /** 开关改动后：左列计数与库都要刷新（同一个数据源，别让两处显示不一致） */
  const refreshAll = useCallback(() => {
    void loadTargets();
    if (tab === 'library') void loadLibrary();
  }, [loadTargets, loadLibrary, tab]);

  const handleDelete = useCallback(async (skill: LibrarySkill) => {
    // ★ 2026-09-17：公共技能删了**影响所有用户**，私有技能只影响自己 ——
    //   两者风险差一个量级，确认文案必须分开写，否则等于没提醒。
    const isPublic = (skill.visibility ?? 'public') === 'public';
    const warn = isPublic
      ? `⚠️ 这是**公共技能**（内置 / 插件带）。\n删除后**所有用户**都会失去它，且不会自动恢复。`
      : `这是你自己的技能，删除后只影响你自己。`;
    if (!window.confirm(`从技能库删除「${skill.name}」？\n\n${warn}\n\n（同时会清掉所有智能体对它的开关记录）`)) return;
    setPendingDelete(skill.id);
    try {
      await removeSkillFromLibrary(skill.id);
      dispatchToastEvent({ type: 'success', message: `已删除「${skill.name}」`, duration: 2500 });
      await loadLibrary();
      await loadTargets();
    } catch (e) {
      dispatchToastEvent({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setPendingDelete(null);
    }
  }, [loadLibrary, loadTargets]);

  // ---- 库视图 ----
  const LibraryView = () => {
    if (!lib) {
      return (
        <div className="flex items-center justify-center gap-2 py-6 text-[11px] text-muted-foreground" role="status">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" /> 正在读取技能库…
        </div>
      );
    }
    const Section = ({
      label, note, items,
    }: { label: string; note: string; items: LibrarySkill[] }) => (
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2 px-1">
          <span className="text-[11px] font-semibold">{label}</span>
          <span className="text-[11px] text-muted-foreground">{items.length}</span>
          <span className="text-[11px] text-muted-foreground truncate">{note}</span>
        </div>
        {items.length === 0 && (
          <div className="px-2 py-2 text-[11px] text-muted-foreground">（这一类还没有技能）</div>
        )}
        {items.map((s) => {
          const Icon = resolveSkillIcon(s.iconKey || s.id);
          return (
            <div key={s.id} className="flex items-center gap-2 rounded-xl px-2 py-1.5 border" data-skill={s.id}>
              <Icon size={14} style={{ color: s.color }} className="shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-medium truncate">{s.name}</span>
                  {/* ★ 公共 / 私有必须一眼可辨：删公共技能会影响所有用户 */}
                  {(s.visibility ?? 'public') === 'public' ? (
                    <span className="shrink-0 text-[10px] px-1 rounded bg-muted text-muted-foreground" title="内置 / 插件带，所有用户可见">公共</span>
                  ) : (
                    <span className="shrink-0 text-[10px] px-1 rounded" style={{ background: 'hsl(var(--mountain-cyan) / 0.12)', color: 'hsl(var(--mountain-cyan))' }} title="你自己上传的，只有你能看到">私有</span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {s.ownerAgentName ? `归属 ${s.ownerAgentName}` : (s.category === 'assistant' ? '归属 对话智能体' : '未归属')}
                  {s.description ? ` · ${s.description}` : ''}
                </div>
              </div>
              <button
                onClick={() => void handleDelete(s)}
                disabled={pendingDelete === s.id}
                className="shrink-0 w-6 h-6 flex items-center justify-center rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-40"
                aria-label={`删除技能 ${s.name}`}
                title={(s.visibility ?? 'public') === 'public' ? '删除（公共技能，影响所有用户）' : '删除（你自己的技能）'}
              >
                {pendingDelete === s.id
                  ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                  : <Trash2 size={12} aria-hidden="true" />}
              </button>
            </div>
          );
        })}
      </div>
    );

    return (
      <div className="flex flex-col gap-3">
        <button
          onClick={() => setInstallOpen((v) => !v)}
          className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-xl border text-[11px] hover:bg-muted/60"
        >
          {installOpen ? <X size={12} aria-hidden="true" /> : <Plus size={12} aria-hidden="true" />}
          {installOpen ? '收起安装表单' : '安装技能'}
        </button>
        {installOpen && <InstallForm
          targets={targets ?? []}
          busy={busy}
          onSubmit={async (input) => {
            setBusy(true);
            try {
              const s = await installSkillOnLibrary(input);
              dispatchToastEvent({ type: 'success', message: `已安装「${s.name}」`, duration: 2500 });
              setInstallOpen(false);
              await loadLibrary();
              await loadTargets();
            } catch (e) {
              // 后端会把"为什么装不上"说清楚（id 非法 / 未知智能体），原样转达
              dispatchToastEvent({ type: 'error', message: e instanceof Error ? e.message : String(e), duration: 6000 });
            } finally {
              setBusy(false);
            }
          }}
        />}
        {lib.orphans.length > 0 && (
          <div className="flex items-start gap-1.5 rounded-xl px-2 py-1.5 text-[11px] border" style={{ borderColor: 'hsl(var(--destructive) / 0.4)' }} role="alert">
            <AlertCircle size={11} className="shrink-0 mt-0.5 text-destructive" aria-hidden="true" />
            <span>
              有 {lib.orphans.map((o) => `${o.count} 条技能归属到「${o.agentId}」`).join('、')}，
              但智能体清单里没有它 —— 这些技能在「按智能体」里**永远看不到**。
              请改归属，或把该智能体声明出来。
            </span>
          </div>
        )}
        <Section label="智能体 skills" note="归对话智能体本体" items={lib.byCategory.assistant} />
        <Section label="agent skills" note="归各子智能体" items={lib.byCategory.agent} />
      </div>
    );
  };

  // ---- 技能市场（2026-09-17 新增）----
  // 浏览公共技能源（后端当前读内置目录，接远程源时前端一行不用改）。
  // 装进来的技能是**当前用户私有的**，装完可在「技能库」页看到、在「智能体」页开启。
  function MarketView() {
    if (market === null) {
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground px-1 py-2">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" /> 正在读取技能市场…
        </div>
      );
    }
    if (market.length === 0) {
      return <div className="px-1 py-3 text-[11px] text-muted-foreground">（市场里暂时没有可装的技能）</div>;
    }
    return (
      <div className="flex flex-col gap-1.5">
        <div className="px-1 text-[11px] text-muted-foreground">
          公共技能源 · 共 {market.length} 条。装进来的技能归你自己，别人看不到。
        </div>
        {market.map((m) => {
          const Icon = resolveSkillIcon(m.id);
          return (
            <div key={m.id} className="flex items-center gap-2 rounded-xl px-2 py-1.5 border" data-market={m.id}>
              <Icon size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-medium truncate">{m.name}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">v{m.version}</span>
                  {(m.tags ?? []).map((t) => (
                    <span key={t} className="text-[10px] px-1 rounded bg-muted text-muted-foreground shrink-0">{t}</span>
                  ))}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">{m.description}</div>
                {/* 归属写了但清单里没这个 agent —— 装了也看不见，必须提前说 */}
                {!m.ownerKnown && (
                  <div className="text-[11px] text-destructive">⚠ 归属智能体「{m.ownerAgent}」不在清单里，装了也看不到</div>
                )}
              </div>
              {m.installed ? (
                <span className="shrink-0 text-[11px] text-muted-foreground px-1">已安装</span>
              ) : (
                <button
                  onClick={() => void handleInstallFromMarket(m)}
                  disabled={installing === m.id || !m.ownerKnown}
                  className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] hover:bg-muted/60 disabled:opacity-40"
                  aria-label={`安装 ${m.name}`}
                >
                  {installing === m.id
                    ? <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                    : <Plus size={11} aria-hidden="true" />}
                  安装
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // ---- 主渲染 ----
  if (selected) {
    const t = targets?.find((x) => x.id === selected);
    return (
      <div className="flex flex-col gap-2 p-2.5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSelected(null)}
            className="shrink-0 flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft size={12} aria-hidden="true" /> 全部智能体
          </button>
          <div className="flex-1" />
          {t && <span className="text-[11px] text-muted-foreground">{t.group}</span>}
        </div>
        {t && (
          <div className="flex items-center gap-2">
            <AgentAvatar short={t.short} color={t.color} size={26} />
            <div className="min-w-0">
              <div className="text-[12px] font-semibold truncate">{t.name}</div>
              <div className="text-[11px] text-muted-foreground truncate">{t.description}</div>
            </div>
          </div>
        )}
        <AgentSkillList agentId={selected} onChanged={refreshAll} compact />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2.5">
      {/* 三块：技能库（装/删）/ 写作agent（写作官的开关）/ 智能体（全部 agent 的开关） */}
      <div className="flex gap-1 p-0.5 rounded-xl" style={{ background: 'hsl(var(--muted) / 0.5)' }} role="tablist">
        {([['library', '技能库'], ['market', '技能市场'], ['writer', '写作agent'], ['agents', '智能体']] as Array<[Tab, string]>).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className="flex-1 px-2 py-1 rounded-lg text-[11px] transition-all"
            style={{
              background: tab === k ? 'hsl(var(--background))' : 'transparent',
              fontWeight: tab === k ? 600 : 400,
              color: tab === k ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
            }}
          >{label}</button>
        ))}
      </div>

      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground" role="alert">
          <AlertCircle size={11} className="shrink-0 mt-0.5 text-destructive" aria-hidden="true" />
          <span className="text-destructive">{error}</span>
        </div>
      )}

      {tab === 'library' && <LibraryView />}

      {tab === 'market' && <MarketView />}

      {/* 写作agent：写作官这一个 agent 的技能开关。
          原来挂在 AI 对话输入栏上方那个「技能」按钮的 Tab 里（2026-09-17 撤掉按钮后挪来这）。 */}
      {tab === 'writer' && (
        <EntrySkillPanel agentId="writer" title="写作 Skills" hint="写作官 · 按本章结论落笔成文" />
      )}

      {tab === 'agents' && (
        targets === null ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[11px] text-muted-foreground" role="status">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" /> 正在读取智能体…
          </div>
        ) : targets.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 py-6 text-[11px] text-muted-foreground" role="status">
            <PackageOpen size={16} aria-hidden="true" />
            <div>没有已声明的智能体</div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {[...new Set(targets.map((t) => t.group))].map((group) => (
              <div key={group} className="flex flex-col gap-1">
                <div className="px-1 text-[11px] text-muted-foreground">{group}</div>
                {targets.filter((t) => t.group === group).map((t) => (
                  <button
                    key={t.id}
                    data-agent={t.id}
                    onClick={() => setSelected(t.id)}
                    className="flex items-center gap-2 rounded-xl px-2 py-1.5 border text-left transition-colors hover:bg-muted/50"
                  >
                    <AgentAvatar short={t.short} color={t.color} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-medium truncate">{t.name}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{t.description}</div>
                    </div>
                    {/* 计数直接写出来：不显示就没法一眼看出"这个智能体配了几条" */}
                    <span className="shrink-0 text-[11px]" style={{ color: t.enabled > 0 ? t.color : 'hsl(var(--muted-foreground))' }}>
                      {t.enabled}/{t.total}
                    </span>
                    <ChevronRight size={12} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                  </button>
                ))}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

/** 安装表单 —— 库只支持安装与删除，所以这是"唯一的入口" */
function InstallForm({
  targets, busy, onSubmit,
}: {
  targets: SkillTargetView[];
  busy: boolean;
  onSubmit: (input: {
    id: string; name: string; description?: string; category: SkillCategory;
    ownerAgent?: string | null; systemPrompt?: string;
  }) => void | Promise<void>;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [category, setCategory] = useState<SkillCategory>('agent');
  const [ownerAgent, setOwnerAgent] = useState('writer');

  const agentTargets = targets.filter((t) => t.kind === 'agent');
  const canSubmit = id.trim() && name.trim() && !busy
    && (category === 'assistant' || !!ownerAgent);

  return (
    <form
      className="flex flex-col gap-1.5 rounded-xl p-2 border"
      onSubmit={(e) => {
        e.preventDefault();
        // ★ 主按钮是 type="submit"（不是按各步渲染不同节点）——
        //   这条踩过：React 同步换完 DOM 后浏览器才执行默认动作，会按换上去的节点解析
        void onSubmit({
          id: id.trim(), name: name.trim(),
          description: description.trim() || undefined,
          category,
          ownerAgent: category === 'agent' ? ownerAgent : null,
          systemPrompt: systemPrompt.trim() || undefined,
        });
      }}
    >
      <div className="flex gap-1">
        {([['agent', 'agent skills'], ['assistant', '智能体 skills']] as Array<[SkillCategory, string]>).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setCategory(k)}
            className="flex-1 px-2 py-1 rounded-lg text-[11px] border"
            style={{
              background: category === k ? 'hsl(var(--primary) / 0.12)' : 'transparent',
              borderColor: category === k ? 'hsl(var(--primary) / 0.5)' : 'hsl(var(--border))',
              fontWeight: category === k ? 600 : 400,
            }}
          >{label}</button>
        ))}
      </div>
      {category === 'agent' && (
        <label className="flex items-center gap-1.5 text-[11px]">
          <span className="text-muted-foreground shrink-0">归属智能体</span>
          <select
            value={ownerAgent}
            onChange={(e) => setOwnerAgent(e.target.value)}
            className="flex-1 min-w-0 px-1.5 py-1 rounded-md border bg-background text-[11px]"
          >
            {agentTargets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      )}
      <input
        value={id} onChange={(e) => setId(e.target.value)} placeholder="技能 id（字母数字，如 foreshadow-doctor）"
        className="px-2 py-1 rounded-md border bg-background text-[11px]"
      />
      <input
        value={name} onChange={(e) => setName(e.target.value)} placeholder="展示名称"
        className="px-2 py-1 rounded-md border bg-background text-[11px]"
      />
      <input
        value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话描述"
        className="px-2 py-1 rounded-md border bg-background text-[11px]"
      />
      <textarea
        value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)}
        placeholder="技能正文：叠加到 system prompt 的专家指导" rows={3}
        className="px-2 py-1 rounded-md border bg-background text-[11px] resize-y"
      />
      <button
        type="submit"
        disabled={!canSubmit}
        className="px-2 py-1.5 rounded-lg text-[11px] text-primary-foreground disabled:opacity-50 mc-auth-btn-primary"
      >
        {busy ? '安装中…' : '安装到技能库'}
      </button>
    </form>
  );
}
