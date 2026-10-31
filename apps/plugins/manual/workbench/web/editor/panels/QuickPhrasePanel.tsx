// ============================================================
// QuickPhrasePanel.tsx — 「快捷短语」底部面板分区（manual 模块）
//
// ★ 2026-10-08 改造：原先它是编辑器正文上方的一枚 `position:fixed` 漂移气泡
//   （`QuickPhraseBubble.tsx`，已删）。气泡是**覆盖层**，不在文档流里 ——
//   正文滚到底会被它压住（520px 窄屏实测压住 39px），EditorPage 因此要挂一个
//   `useLayoutEffect` 反量滚动容器底边、动态改 `paddingBottom` 给它让位。
//   改为**底部面板里的一栏**后：不再覆盖正文、不再需要预留量、不再有漂移动画
//   抢注意力；入口收进底部细条右侧（带条数），Ctrl+J 或点入口展开。
//
// 注册方式：由 `web/index.tsx` 的 `apply()` 调 `registerBottomPanelSection(...)`
//   （kernel 扩展点，见 `apps/web/src/components/shell/bottomSections.tsx`）。
//
// ★ 本文件的两个组件都**同步可渲染**（不得改 `React.lazy`）：底部面板展开区
//   没有任何 Suspense 边界，懒加载挂起会一路上溯到路由级 fallback，把整页换成
//   32px「加载中...」大转圈（2026-10-07「跳转加载转圈」修复的实测结论）。
//
// 编辑器实例：底部面板与编辑器不在同一 React 子树里，经 data-core 的
//   `useEditorStore`（EditorPage 挂载时写入）取同一个 TipTap 实例。
// ============================================================

import { useState, useRef, useEffect, useMemo } from 'react';
import { Sparkles, Plus, X, User, MapPin, Package, Wand2 } from 'lucide-react';
import { useQuickPhraseStore, type QuickPhrase } from '../../../stores';
import {
  useCharacterStore,
  useLocationStore,
  useItemStore,
  useEditorStore,
} from '@novel-plugins/data-core/stores';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import { getCapability } from '@/plugin/registry';
import { extractHeuristicPhrases } from './quickPhraseHeuristic';
import type { BottomThinEntryProps } from '@/components/shell/bottomSections';

const categoryConfig: Record<
  QuickPhrase['category'],
  { icon: typeof User; color: string; label: string }
> = {
  character: { icon: User, color: 'hsl(var(--entity-character, 217 91% 60%))', label: '角色' },
  location: { icon: MapPin, color: 'hsl(var(--entity-location, 271 91% 65%))', label: '地点' },
  item: { icon: Package, color: 'hsl(var(--entity-item, 142 71% 45%))', label: '物品' },
  ai: { icon: Wand2, color: 'hsl(var(--state-running, 38 92% 50%))', label: 'AI推荐' },
  custom: { icon: Sparkles, color: 'hsl(var(--state-idle, 220 9% 46%))', label: '自定义' },
};

/**
 * 快捷短语的数据面（细条入口与展开区一栏共用同一份推导）。
 *
 * 短语列表 = 项目短语（去重）+ 角色名/别名（前 5 位各前 2 个别名）
 *          + 地点（前 3）+ 物品（前 3），按使用次数降序取前 12。
 */
function useQuickPhraseData() {
  const projectId = useCurrentProjectId();
  const {
    phrases,
    addPhrase,
    removePhrase,
    incrementUsage,
    setIsGenerating,
    isGenerating,
  } = useQuickPhraseStore();
  const characters = useCharacterStore((s) => s.characters);
  const locations = useLocationStore((s) => s.locations);
  const items = useItemStore((s) => s.items);
  const editor = useEditorStore((s) => s.editor);

  const projectPhrases = useMemo(
    () =>
      phrases.filter(
        (p) => (p as QuickPhrase & { projectId?: string }).projectId === projectId || !('projectId' in p),
      ),
    [phrases, projectId],
  );

  const displayPhrases = useMemo(() => {
    const result: QuickPhrase[] = [];
    const seenTexts = new Set<string>();

    for (const p of projectPhrases) {
      const key = p.text.toLowerCase();
      if (!seenTexts.has(key)) {
        seenTexts.add(key);
        result.push(p);
      }
    }

    const projectChars = characters.filter((c) => c.projectId === projectId);
    for (const c of projectChars.slice(0, 5)) {
      if (!seenTexts.has(c.name.toLowerCase())) {
        seenTexts.add(c.name.toLowerCase());
        result.push({
          id: `char-${c.id}`,
          text: c.name,
          category: 'character',
          source: c.aliases?.[0],
          usageCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      if (c.aliases) {
        for (const alias of c.aliases.slice(0, 2)) {
          if (!seenTexts.has(alias.toLowerCase())) {
            seenTexts.add(alias.toLowerCase());
            result.push({
              id: `char-alias-${c.id}-${alias}`,
              text: alias,
              category: 'character',
              source: c.name,
              usageCount: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
        }
      }
    }

    const projectLocs = locations.filter((l) => l.projectId === projectId);
    for (const l of projectLocs.slice(0, 3)) {
      if (!seenTexts.has(l.name.toLowerCase())) {
        seenTexts.add(l.name.toLowerCase());
        result.push({
          id: `loc-${l.id}`,
          text: l.name,
          category: 'location',
          usageCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }

    const projectItems = items.filter((i) => i.projectId === projectId);
    for (const i of projectItems.slice(0, 3)) {
      if (!seenTexts.has(i.name.toLowerCase())) {
        seenTexts.add(i.name.toLowerCase());
        result.push({
          id: `item-${i.id}`,
          text: i.name,
          category: 'item',
          usageCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }

    return result.sort((a, b) => b.usageCount - a.usageCount).slice(0, 12);
  }, [projectPhrases, characters, locations, items, projectId]);

  return {
    projectId,
    editor,
    characters,
    displayPhrases,
    addPhrase,
    removePhrase,
    incrementUsage,
    setIsGenerating,
    isGenerating,
  };
}

/** 细条右侧入口：图标 + 「快捷短语」+ 条数；点击请求展开底部面板。 */
export function QuickPhraseThinEntry({ open, onOpen }: BottomThinEntryProps) {
  const { displayPhrases } = useQuickPhraseData();
  return (
    <button
      type="button"
      className="dock-bottom-entry"
      onClick={onOpen}
      aria-expanded={open}
      title={open ? '快捷短语（底部面板已展开）' : '展开底部面板，查看快捷短语'}
    >
      <Sparkles size={12} aria-hidden="true" />
      <span className="dock-bottom-entry-label">快捷短语</span>
      <span className="dock-bottom-entry-count">{displayPhrases.length}</span>
    </button>
  );
}

/** 展开区中的一栏：短语列表 + 「AI提取」/「添加」。 */
export function QuickPhraseSection() {
  const {
    projectId,
    editor,
    characters,
    displayPhrases,
    addPhrase,
    removePhrase,
    incrementUsage,
    setIsGenerating,
    isGenerating,
  } = useQuickPhraseData();

  const [showAddForm, setShowAddForm] = useState(false);
  const [newPhraseText, setNewPhraseText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showAddForm && inputRef.current) inputRef.current.focus();
  }, [showAddForm]);

  const handleInsertPhrase = (phrase: QuickPhrase) => {
    if (!editor) return;
    editor.chain().focus().insertContent(phrase.text).run();
    incrementUsage(phrase.id);
  };

  const handleAddCustomPhrase = () => {
    if (!newPhraseText.trim()) return;
    addPhrase({
      text: newPhraseText.trim(),
      category: 'custom',
      ...(projectId ? { projectId } : {}),
    } as QuickPhrase);
    setNewPhraseText('');
    setShowAddForm(false);
  };

  const handleGenerateAIPhrases = async () => {
    if (!editor || !projectId) return;
    setIsGenerating(true);
    try {
      const content = editor.getText();
      // AI 接口优先；无提供方时走本地启发式（设计 §5.3：ai.quickPhrases 缺失 → 启发式兜底）
      const cap = getCapability<{ generate: (c: string, ch: typeof characters) => Promise<string[]> }>(
        'ai.quickPhrases',
      );
      const aiPhrases = cap
        ? await cap.generate(content, characters)
        : extractHeuristicPhrases(content, characters);
      for (const p of aiPhrases) {
        addPhrase({
          text: p,
          category: 'ai',
          ...(projectId ? { projectId } : {}),
        } as QuickPhrase);
      }
    } catch (e) {
      console.debug('[QuickPhrase] AI生成失败:', e);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="dock-qp">
      <div className="dock-qp-toolbar">
        <button
          type="button"
          className="dock-qp-action"
          onClick={handleGenerateAIPhrases}
          disabled={isGenerating || !editor}
          title="从当前章节正文提取高频短语"
        >
          <Wand2 size={12} className={isGenerating ? 'animate-spin' : ''} aria-hidden="true" />
          <span>AI提取</span>
        </button>
        <button
          type="button"
          className="dock-qp-action"
          onClick={() => setShowAddForm((v) => !v)}
          title="手动添加一条快捷短语"
        >
          <Plus size={12} aria-hidden="true" />
          <span>添加</span>
        </button>
      </div>

      {showAddForm ? (
        <div className="dock-qp-add">
          <input
            ref={inputRef}
            className="dock-qp-input"
            value={newPhraseText}
            onChange={(e) => setNewPhraseText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddCustomPhrase();
              if (e.key === 'Escape') {
                setShowAddForm(false);
                setNewPhraseText('');
              }
            }}
            placeholder="输入常用句子…"
            aria-label="新快捷短语"
          />
          <button
            type="button"
            className="dock-qp-action"
            onClick={handleAddCustomPhrase}
            disabled={!newPhraseText.trim()}
          >
            确定
          </button>
        </div>
      ) : null}

      {displayPhrases.length === 0 ? (
        <div className="dock-qp-empty">暂无快捷短语，点击「AI提取」或「添加」开始</div>
      ) : (
        <div className="dock-qp-list">
          {displayPhrases.map((phrase) => {
            const cfg = categoryConfig[phrase.category];
            const Icon = cfg.icon;
            return (
              <span
                key={phrase.id}
                className="dock-qp-chip"
                style={{ borderColor: `color-mix(in srgb, ${cfg.color} 45%, transparent)` }}
              >
                <button
                  type="button"
                  className="dock-qp-chip-text"
                  onClick={() => handleInsertPhrase(phrase)}
                  title={`插入「${phrase.text}」（${cfg.label}）`}
                >
                  <Icon size={11} aria-hidden="true" style={{ color: cfg.color }} />
                  <span>{phrase.text}</span>
                </button>
                {phrase.category === 'custom' || phrase.category === 'ai' ? (
                  <button
                    type="button"
                    className="dock-qp-chip-remove"
                    onClick={() => removePhrase(phrase.id)}
                    aria-label={`删除短语：${phrase.text}`}
                    title="删除"
                  >
                    <X size={10} aria-hidden="true" />
                  </button>
                ) : null}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default QuickPhraseSection;
