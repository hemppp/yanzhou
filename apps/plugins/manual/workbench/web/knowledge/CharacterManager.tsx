import { useState } from 'react';
import { useCharacterStore, useProjectStore } from '@novel-plugins/data-core/stores';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import EntityForm from './EntityForm';
import { Search, Plus, Users, AlertCircle, RefreshCw, Sparkles, User, List, Network } from 'lucide-react';
import { nanoid } from 'nanoid';
import { apiClient } from '@novel-plugins/data-core/api/apiClient';
import type { Character } from '@novel/shared';
import { CharacterGraph } from './RelationGraph';

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, hsl(var(--mountain-pale)), hsl(var(--mountain-light)))',
  'linear-gradient(135deg, hsl(var(--mist-pale)), hsl(var(--mist-blue)))',
  'linear-gradient(135deg, hsl(var(--ochre-pale)), hsl(var(--ochre)))',
  'linear-gradient(135deg, hsl(var(--willow-pale)), hsl(var(--willow)))',
  'linear-gradient(135deg, hsl(var(--cinnabar-pale)), hsl(var(--cinnabar)))',
  'linear-gradient(135deg, hsl(var(--mountain-light)), hsl(var(--mountain-deep)))',
];

function getAvatarStyle(name: string): React.CSSProperties {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const grad = AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
  return { background: grad };
}

// 角色定位徽章：与 EntityForm 的角色定位配色语义一致
const ROLE_BADGE: Record<NonNullable<Character['role']>, { label: string; bg: string; fg: string }> = {
  protagonist: { label: '主角', bg: 'hsl(var(--ochre-pale) / 0.85)', fg: 'hsl(var(--ochre))' },
  femaleLead: { label: '女主', bg: 'hsl(var(--cinnabar-pale) / 0.85)', fg: 'hsl(var(--cinnabar))' },
  supporting: { label: '配角', bg: 'hsl(var(--mist-pale) / 0.85)', fg: 'hsl(var(--mountain-deep))' },
  minor: { label: '路人甲', bg: 'hsl(var(--secondary) / 0.7)', fg: 'hsl(var(--ink-light))' },
};

function CharacterCard({
  character,
  selected,
  onClick,
  index = 0,
}: {
  character: Character;
  selected: boolean;
  onClick: () => void;
  index?: number;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const avatarStyle = getAvatarStyle(character.name);
  const roleBadge = character.role ? ROLE_BADGE[character.role] : null;

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => { setIsHovered(false); setIsPressed(false); }}
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      className="w-full text-left"
      style={{
        cursor: 'pointer',
        borderRadius: 'var(--r-md)',
        overflow: 'hidden',
        aspectRatio: '3 / 4',
        position: 'relative',
        transition: 'transform 0.4s cubic-bezier(0.16,1,0.3,1), box-shadow 0.4s cubic-bezier(0.16,1,0.3,1)',
        boxShadow: selected
          ? '0 0 0 2px hsl(var(--mountain-cyan) / 0.5), 0 10px 30px hsl(var(--glass-shadow) / 0.25)'
          : isHovered
          ? '0 12px 30px hsl(var(--glass-shadow) / 0.22), 0 4px 12px hsl(var(--glass-shadow) / 0.12)'
          : '0 4px 14px hsl(var(--glass-shadow) / 0.12), 0 1px 4px hsl(var(--glass-shadow) / 0.06)',
        transform: isPressed
          ? 'translateY(-1px) scale(0.96)'
          : selected
          ? 'translateY(-3px) scale(1.02)'
          : isHovered
          ? 'translateY(-4px) scale(1.015)'
          : 'translateY(0) scale(1)',
        animation: `slideTop 0.7s cubic-bezier(0.16, 1, 0.3, 1) ${index * 0.04}s both`,
      }}
      role="option"
      aria-selected={selected}
    >
      {/* 头像/背景层 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          ...avatarStyle,
          transition: 'transform 0.6s cubic-bezier(0.16,1,0.3,1)',
          transform: isHovered ? 'scale(1.08)' : 'scale(1)',
        }}
      >
        {/* 首字母大字 */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 52,
            fontWeight: 700,
            fontFamily: "'Noto Serif SC', serif",
            color: 'rgba(255,255,255,0.92)',
            textShadow: '0 2px 12px rgba(0,0,0,0.25)',
          }}
        >
          {character.name[0]}
        </div>
      </div>

      {/* 顶部渐变遮罩 + 标签 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: 'var(--space-4) var(--space-4) var(--space-7)',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0) 100%)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 'var(--space-4)',
        }}
      >
        {Array.isArray(character.tags) && character.tags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)', maxWidth: '70%' }}>
            {character.tags.slice(0, 2).map((tag) => (
              <span
                key={tag}
                style={{
                  fontSize: 9.5,
                  padding: 'var(--space-0) var(--space-2)',
                  borderRadius: 'var(--r-md)',
                  fontWeight: 500,
                  background: 'rgba(255,255,255,0.28)',
                  color: 'rgba(255,255,255,0.95)',
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: 70,
                }}
              >
                {tag}
              </span>
            ))}
            {character.tags.length > 2 && (
              <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.8)' }}>+{character.tags.length - 2}</span>
            )}
          </div>
        )}
        {roleBadge && (
          <span
            style={{
              fontSize: 9.5,
              padding: 'var(--space-0) var(--space-2)',
              borderRadius: 'var(--r-md)',
              fontWeight: 600,
              background: roleBadge.bg,
              color: roleBadge.fg,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {roleBadge.label}
          </span>
        )}
      </div>

      {/* 底部渐变遮罩 + 信息区 */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: 'var(--space-8) var(--space-5) var(--space-5)',
          background: 'linear-gradient(0deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 50%, rgba(0,0,0,0) 100%)',
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            fontFamily: "'Noto Serif SC', serif",
            color: 'rgba(255,255,255,0.98)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            textShadow: '0 1px 4px rgba(0,0,0,0.3)',
          }}
        >
          {character.name}
        </div>
        {character.aliases && character.aliases.length > 0 && (
          <div
            style={{
              fontSize: 10,
              color: 'rgba(255,255,255,0.75)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              marginTop: 'var(--space-0)',
            }}
          >
            {character.aliases.join(' · ')}
          </div>
        )}
      </div>
    </button>
  );
}

export function CharacterManager() {
  const characters = useCharacterStore((s) => s.characters);
  const addCharacter = useCharacterStore((s) => s.addCharacter);
  const updateCharacter = useCharacterStore((s) => s.updateCharacter);
  const deleteCharacter = useCharacterStore((s) => s.deleteCharacter);
  const projectId = useCurrentProjectId();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Character | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'graph'>('list');

  if (!projectId) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: 'hsl(var(--card) / 0.4)' }}>
        <div className="text-center">
          <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: 'hsl(var(--mist-pale))' }}>
            <AlertCircle size={28} style={{ color: 'hsl(var(--mountain-deep))' }} />
          </div>
          <p className="text-sm font-medium" style={{ color: 'hsl(var(--ink-light))' }}>请先选择一个项目</p>
        </div>
      </div>
    );
  }

  const filtered = characters.filter(
    (c) =>
      c.projectId === projectId &&
      (c.name.includes(search) || c.aliases?.some((a) => a.includes(search)))
  );

  const handleCreate = () => {
    try {
      setError(null);
      const newChar: Character = {
        id: nanoid(),
        projectId,
        name: '新角色',
        aliases: [],
        tags: [],
        states: [],
        relations: [],
        chapters: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      addCharacter(newChar);
      setSelectedId(newChar.id);
      setEditing(newChar);
    } catch {
      setError('创建角色失败，请重试');
    }
  };

  const handleSave = (updates: Partial<Character>) => {
    if (!editing) return;
    try {
      setError(null);
      updateCharacter(editing.id, updates as Partial<Character>);
      setEditing({ ...editing, ...updates } as Character);
    } catch {
      setError('保存角色失败，请重试');
    }
  };

  const handleDelete = () => {
    if (!editing) return;
    try {
      setError(null);
      deleteCharacter(editing.id);
      setSelectedId(null);
      setEditing(null);
    } catch {
      setError('删除角色失败，请重试');
    }
  };

  const handleAIGenerate = async () => {
    try {
      setError(null);
      setAiGenerating(true);
      const description = prompt('请描述你想创建的角色（如：一个沉默寡言的剑客，背负着家族的仇恨）');
      if (!description) return;

      const res = await apiClient.post<Record<string, unknown>>(
        '/ai/generate-character',
        {
          description,
          // ?? undefined：未设题材时 project.genre 是 null，别把显式 null 发上去
          // （服务端 schema 可选字段只放行 undefined；两边都已按 nullish 收口）
          genre: useProjectStore.getState().currentProject?.genre ?? undefined,
          context: `项目：${useProjectStore.getState().currentProject?.name || ''}`,
        },
        // ★ timeoutMs 必传（2026-10-11 UI 实测）：apiClient 默认 8s，而生成角色是
        //   推理模型整段生成（实测 14–40s+）⇒ 不传必然「请求超时 (8s)」失败。
        //   120s 与 styleService/rhythmService 的 60s 同思路，生成类留更大余量。
        { timeoutMs: 120_000 },
      );

      // ★ 后端红石开关关闭时返回 { skipped: true, reason: '功能已关闭' }
      // 必须显式提示用户，否则 'name' in res 判断失败 → 静默无反馈
      if (res && typeof res === 'object' && 'skipped' in res) {
        const reason = (res as { reason?: string }).reason || '功能已关闭';
        setError(`AI 生成被跳过：${reason}。请在红石开关面板中开启「剧情生成」。`);
        return;
      }

      // ★ 后端 JSON 解析失败时返回 { raw: response }，提示用户 AI 返回格式异常
      if (res && typeof res === 'object' && 'raw' in res && !('name' in res)) {
        setError('AI 返回格式异常，请重试或更换描述');
        return;
      }

      if (res && typeof res === 'object' && 'name' in res) {
        // ★ 2026-10-11 UI 实测踩到的第三处（POST /api/characters 400，角色丢持久化）：
        //   /ai/generate-character 的 prompt 约定 relations 是
        //   `[{ target: "角色名", type, description }]`（**按名字** —— 目标角色
        //   可能还不存在），而 `CharacterRelation` 要的是 `targetId`（服务端 zod
        //   硬校验 `string` + `direction` 枚举）。原先原样强转 ⇒ 保存 400
        //   （`relations[0].targetId: expected string, received undefined`），
        //   角色只在本地 store 里「看得见」，一刷新就没了（实测 谢孤鸿）。
        //   收口：按名字/别名解析现有角色 → 解析到的建成真关系（mutual）；
        //   解析不到的丢弃并在面板明示 —— RelationGraph 本就只画
        //   `validCharIds` 里的边（L154），悬空关系既画不出也存不进。
        const aiRelations = Array.isArray(res.relations)
          ? (res.relations as Array<Record<string, unknown>>)
          : [];
        const relations: Character['relations'] = [];
        const unresolvedNames: string[] = [];
        for (const r of aiRelations) {
          const targetName = typeof r.target === 'string' ? r.target.trim() : '';
          if (!targetName) continue;
          const hit = characters.find(
            (c) =>
              c.projectId === projectId &&
              (c.name.trim() === targetName || (c.aliases ?? []).includes(targetName)),
          );
          if (!hit) {
            unresolvedNames.push(targetName);
            continue;
          }
          relations.push({
            targetId: hit.id,
            type: typeof r.type === 'string' && r.type.trim() ? r.type.trim() : '关联',
            description: typeof r.description === 'string' && r.description ? r.description : undefined,
            direction: 'mutual',
            chapter: null,
          });
        }
        const newChar: Character = {
          id: nanoid(),
          projectId,
          name: (res.name as string) || 'AI 角色',
          aliases: Array.isArray(res.aliases) ? res.aliases as string[] : [],
          appearance: (res.appearance as string) || '',
          personality: (res.personality as string) || '',
          backstory: (res.backstory as string) || '',
          speechStyle: (res.speechStyle as string) || '',
          desire: (res.desire as string) || '',
          fear: (res.fear as string) || '',
          belief: (res.belief as string) || '',
          weakness: (res.weakness as string) || '',
          tags: [],
          states: [],
          relations,
          chapters: [],
          thumbnail: undefined,
          color: undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        addCharacter(newChar);
        setSelectedId(newChar.id);
        setEditing(newChar);
        if (unresolvedNames.length > 0) {
          setError(
            `已生成「${newChar.name}」；其中 ${unresolvedNames.length} 条关系提示` +
              `（${unresolvedNames.join('、')}）在项目中暂无对应角色，未一并写入 —— ` +
              `先创建对应角色，再在关系图中手动连边即可。`,
          );
        }
      } else {
        // ★ 兜底：未知响应格式
        setError('AI 返回数据格式不识别，请重试');
      }
    } catch (e) {
      console.error('AI 生成角色失败：', e);
      const msg = e instanceof Error ? e.message : String(e);
      setError(`AI 生成失败：${msg.slice(0, 80)}`);
    } finally {
      setAiGenerating(false);
    }
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'hsl(var(--card) / 0.4)' }}>
      {/* 顶部工具栏：视图切换 */}
      <div className="flex items-center justify-between px-4 py-2 border-b" style={{ borderColor: 'hsl(var(--border) / 0.5)', background: 'hsl(var(--card) / 0.7)' }}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold font-[Noto_Serif_SC,serif]" style={{ color: 'hsl(var(--ink))' }}>角色管理</span>
        </div>
        <div className="flex items-center gap-1 p-0.5 rounded-2xl" style={{ background: 'hsl(var(--border) / 0.3)' }}>
          <button
            onClick={() => setViewMode('list')}
            className={`p-1.5 rounded-xl transition-all hover:bg-white/50 ${viewMode === 'list' ? 'bg-white shadow-sm' : ''}`}
            style={{ color: viewMode === 'list' ? 'hsl(var(--ink))' : 'hsl(var(--ink-light))' }}
            aria-label="列表视图"
            title="列表视图"
          >
            <List size={14} />
          </button>
          <button
            onClick={() => setViewMode('graph')}
            className={`p-1.5 rounded-xl transition-all hover:bg-white/50 ${viewMode === 'graph' ? 'bg-white shadow-sm' : ''}`}
            style={{ color: viewMode === 'graph' ? 'hsl(var(--ink))' : 'hsl(var(--ink-light))' }}
            aria-label="图谱视图"
            title="图谱视图"
          >
            <Network size={14} />
          </button>
        </div>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-hidden">
        {viewMode === 'list' ? (
          <div className="h-full flex">
            {/* Sidebar - 卡片网格 */}
            <div className="w-[380px] flex flex-col" style={{ borderRight: '1px solid hsl(var(--border) / 0.5)', background: 'hsl(var(--card) / 0.7)' }}>
              {/* Header */}
              <div className="px-4 pt-4 pb-3">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-semibold tracking-tight font-[Noto_Serif_SC,serif]" style={{ color: 'hsl(var(--ink))' }}>角色列表</h2>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={handleAIGenerate}
                      disabled={aiGenerating}
                      className="p-1.5 rounded-xl transition-colors hover:bg-[hsl(var(--mist-pale))] disabled:hover:bg-transparent"
                      style={{ color: 'hsl(var(--mountain-deep))' }}
                      aria-label="AI 生成角色"
                      title="AI 辅助生成角色设定"
                    >
                      {aiGenerating ? (
                        <RefreshCw size={14} className="animate-spin" />
                      ) : (
                        <Sparkles size={14} />
                      )}
                    </button>
                    <button
                      onClick={handleCreate}
                      className="p-1.5 rounded-xl transition-colors hover:bg-[hsl(var(--mist-pale))]"
                      style={{ color: 'hsl(var(--ink-light))' }}
                      aria-label="创建新角色"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
                {/* Search */}
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'hsl(var(--ink-pale))' }} />
                  <label htmlFor="character-search" className="sr-only">搜索角色</label>
                  <input
                    id="character-search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索角色..."
                    className="w-full pl-8 pr-3 py-1.5 text-sm rounded-[14px] focus:outline-none transition-shadow"
                    style={{
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      color: 'hsl(var(--ink))',
                    }}
                  />
                </div>
              </div>

              {/* Character 卡片网格 */}
              <div className="flex-1 overflow-y-auto px-3 pb-3 mc-scrollbar" role="listbox" aria-label="角色列表">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--space-5)' }}>
                  {filtered.map((char, i) => (
                    <CharacterCard
                      key={char.id}
                      character={char}
                      selected={selectedId === char.id}
                      onClick={() => { setSelectedId(char.id); setEditing(char); setError(null); }}
                      index={i}
                    />
                  ))}
                </div>
                {filtered.length === 0 && (
                  <div className="px-4 py-8 text-center">
                    <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3" style={{ background: 'hsl(var(--mist-pale))' }}>
                      <Users size={20} style={{ color: 'hsl(var(--mountain-deep))' }} />
                    </div>
                    <p className="text-sm" style={{ color: 'hsl(var(--ink-pale))' }}>{search ? '无匹配角色' : '暂无角色'}</p>
                    {!search && (
                      <button onClick={handleCreate} className="mt-3 text-xs underline underline-offset-2" style={{ color: 'hsl(var(--mountain-deep))' }}>
                        创建第一个角色
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Main 内容 */}
            <div className="flex-1 overflow-y-auto mc-scrollbar">
              {error && (
                <div className="mx-6 mt-4 px-4 py-3 border rounded-2xl flex items-start gap-2.5" style={{ background: 'hsl(var(--cinnabar-pale) / 0.6)', borderColor: 'hsl(var(--cinnabar) / 0.3)' }} role="alert">
                  <AlertCircle size={15} className="mt-0.5 shrink-0" style={{ color: 'hsl(var(--cinnabar))' }} />
                  <div className="flex-1">
                    <p className="text-sm" style={{ color: 'hsl(var(--cinnabar))' }}>{error}</p>
                    <button
                      onClick={() => setError(null)}
                      className="text-xs mt-1 transition-colors"
                      style={{ color: 'hsl(var(--ink-light))' }}
                    >
                      关闭
                    </button>
                  </div>
                </div>
              )}
              {editing ? (
                <EntityForm
                  entity={editing}
                  onSave={handleSave}
                  onDelete={handleDelete}
                />
              ) : (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center">
                    <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: 'hsl(var(--mist-pale) / 0.6)' }}>
                      <User size={28} style={{ color: 'hsl(var(--ink-pale))' }} />
                    </div>
                    <p className="text-sm" style={{ color: 'hsl(var(--ink-pale))' }}>选择角色查看详情</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <CharacterGraph />
        )}
      </div>
    </div>
  );
}
