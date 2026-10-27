import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Bookmark, Check, Copy, Link2, MapPin, Pin, Sword, Users, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAnnotationStore, useForeshadowStore, useChapterStore, useEarmarkStore } from '@novel-plugins/data-core/stores';
import { EarmarkDialog } from '../foreshadow/EarmarkDialog';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import { usePluginRegistry, useProjectMode, filterByProjectMode } from '@/plugin/registry';
import { nanoid } from 'nanoid';
import type { ForeshadowType, AnnotationType, Earmark } from '@novel/shared';
import type { Editor } from '@tiptap/core';
import type { SelectionActionDef } from '@/plugin/types';

interface SelectionMenuProps {
  editor: Editor;
}

const MENU_GAP = 8;
const EDGE_MARGIN = 8;

/** 视口内定位：默认贴选区上方，上方放不下且下方放得下才翻到下方；水平夹紧到视口内 */
function computePlacement(rect: DOMRect, menuW: number, menuH: number) {
  const aboveFits = rect.top - MENU_GAP - menuH >= EDGE_MARGIN;
  const belowFits = rect.bottom + MENU_GAP + menuH <= window.innerHeight - EDGE_MARGIN;
  const below = !aboveFits && belowFits;
  const y = below ? rect.bottom + MENU_GAP : rect.top - MENU_GAP;
  const halfW = menuW / 2;
  const x = Math.min(
    Math.max(rect.left + rect.width / 2, halfW + EDGE_MARGIN),
    window.innerWidth - halfW - EDGE_MARGIN,
  );
  return { x, y, below };
}

const typeConfig: Record<string, { Icon: LucideIcon; label: string; annotationType: AnnotationType; color: string }> = {
  character: { Icon: Users, label: '角色', annotationType: 'character', color: '#dbeafe' },
  item: { Icon: Sword, label: '物品', annotationType: 'item', color: '#dcfce7' },
  location: { Icon: MapPin, label: '地点', annotationType: 'location', color: '#f3e8ff' },
  foreshadow: { Icon: Bookmark, label: '添加伏笔', annotationType: 'foreshadow', color: '#fef3c7' },
  event: { Icon: Zap, label: '事件', annotationType: 'event', color: '#fee2e2' },
  relation: { Icon: Link2, label: '关联', annotationType: 'relation', color: '#fce7f3' },
};

const foreshadowTypes: { value: ForeshadowType; label: string }[] = [
  { value: 'identity', label: '身份' },
  { value: 'motivation', label: '动机' },
  { value: 'relation', label: '关系' },
  { value: 'trauma', label: '创伤' },
  { value: 'turning', label: '转折' },
  { value: 'fate', label: '命运' },
];

/** 插件选区动作按钮：icon 可为 Lucide 组件或 emoji 字符串 */
function PluginActionButton({
  def, text, editor, onDone,
}: {
  def: SelectionActionDef;
  text: string;
  editor: Editor;
  onDone: () => void;
}) {
  const Icon = typeof def.icon === 'string' || def.icon == null ? null : def.icon;
  return (
    <button
      className="selection-menu-btn"
      style={def.color ? ({ '--menu-hover': def.color } as React.CSSProperties) : undefined}
      onClick={() => {
        try {
          void def.run({ text, editor });
        } catch (err) {
          console.warn(`[plugin] 选区动作 ${def.key} 执行失败:`, err);
        }
        onDone();
      }}
      title={def.label}
    >
      {Icon ? <Icon size={14} aria-hidden="true" /> : <span style={{ fontSize: '13px' }}>{typeof def.icon === 'string' ? def.icon : '🧩'}</span>}
      <span>{def.label}</span>
    </button>
  );
}

export function SelectionMenu({ editor }: SelectionMenuProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0, below: false });
  const [selectedText, setSelectedText] = useState('');
  const [showForeshadowForm, setShowForeshadowForm] = useState(false);
  const [earmarkDialogOpen, setEarmarkDialogOpen] = useState(false);
  const [fsDescription, setFsDescription] = useState('');
  const [fsType, setFsType] = useState<ForeshadowType>('motivation');
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // 最近一次有效选区的视口矩形；表单态切换时用它重算位置
  const lastRectRef = useRef<DOMRect | null>(null);
  const formOpenRef = useRef(false);
  const showTimerRef = useRef<number | undefined>(undefined);
  // execCommand 兜底复制会改动 document selection，短窗期内忽略 selectionchange
  const suppressUntilRef = useRef(0);

  // 使用 selector 精确订阅
  const addAnnotation = useAnnotationStore(s => s.addAnnotation);
  const addForeshadow = useForeshadowStore(s => s.addForeshadow);
  const addEarmark = useEarmarkStore(s => s.addEarmark);
  const linkToForeshadow = useEarmarkStore(s => s.linkToForeshadow);
  const foreshadows = useForeshadowStore(s => s.foreshadows);
  const chapters = useChapterStore(s => s.chapters);
  const currentChapterId = useChapterStore(s => s.currentChapterId);
  const projectId = useCurrentProjectId();
  // ★ 插件化：插件注册的选区动作追加在原生标注按钮之后（按当前项目创作模式过滤）
  const mode = useProjectMode();
  const pluginActions = filterByProjectMode(usePluginRegistry(s => s.selectionActions), mode);

  const currentChapter = chapters.find((ch) => ch.id === currentChapterId);

  const closeMenu = () => {
    setIsVisible(false);
    setShowForeshadowForm(false);
    formOpenRef.current = false;
  };

  useEffect(() => {
    const readSelection = (): { text: string; rect: DOMRect } | null => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
      const editorElement = document.querySelector('.ProseMirror');
      if (!editorElement || !editorElement.contains(selection.anchorNode)) return null;
      const text = selection.toString();
      if (text.trim() === '') return null;
      return { text, rect: selection.getRangeAt(0).getBoundingClientRect() };
    };

    const show = () => {
      if (formOpenRef.current) return;
      const sel = readSelection();
      if (!sel) {
        setIsVisible(false);
        return;
      }
      lastRectRef.current = sel.rect;
      // 先按估算尺寸定位，useLayoutEffect 中按实测尺寸校正
      setPosition(computePlacement(sel.rect, 540, 44));
      setSelectedText(sel.text);
      setShowForeshadowForm(false);
      formOpenRef.current = false;
      setCopied(false);
      setIsVisible(true);
    };

    const handleSelectionChange = () => {
      if (Date.now() < suppressUntilRef.current) return;
      if (formOpenRef.current) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        window.clearTimeout(showTimerRef.current);
        setIsVisible(false);
        return;
      }
      // 拖选过程中只排队，选区稳定后才显示；mouseup 时会立即触发一次
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = window.setTimeout(show, 160);
    };

    const handleMouseUp = (event: MouseEvent) => {
      if (Date.now() < suppressUntilRef.current) return;
      const target = event.target as Node | null;
      const editorElement = document.querySelector('.ProseMirror');
      if (!target || !editorElement || !editorElement.contains(target)) return;
      // 表单打开时点击编辑器 = 放弃表单回到正文
      if (formOpenRef.current) {
        setIsVisible(false);
        setShowForeshadowForm(false);
        formOpenRef.current = false;
        return;
      }
      window.clearTimeout(showTimerRef.current);
      show();
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('mouseup', handleMouseUp);
      window.clearTimeout(showTimerRef.current);
    };
  }, []);

  // ★ t6 F-4：滚动即关闭。
  //
  // 菜单用 `position: fixed` 钉在**视口坐标**（`.selection-menu-anchor`，见 globals.css
  // 的 z-index:9999），但锚点只在选区变化时算一次。编辑器内部滚动（`.nm-editor-scroll-host`）
  // 时选区文本随之上移，菜单却原地不动 —— 实测：选区 y 688 → 468（滚动 220px），
  // 菜单 y 恒为 641，于是悬停在无关内容（第 2+ 个批注块）之上并挡住它的按钮。
  //
  // 选区菜单跟随滚动没有意义（拖选已经结束），主流编辑器一律「滚动即收起」，
  // 故这里在**捕获阶段**监听 scroll（内层滚动容器不冒泡，必须 capture）关掉菜单。
  useEffect(() => {
    if (!isVisible) return;
    const handleScroll = (event: Event) => {
      // 菜单自身内部滚动（如未来的长列表）不应关闭它。
      // ★ target 必须用 instanceof Node 收窄：resize 事件的 target 是 window（不是 Node），
      //   直接 menuRef.current.contains(window) 会抛 TypeError（参数不是 Node）。
      const t = event.target;
      if (menuRef.current && t instanceof Node && menuRef.current.contains(t)) return;
      closeMenu();
    };
    document.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [isVisible]);

  // Esc 关闭（含表单态）
  useEffect(() => {
    if (!isVisible && !showForeshadowForm) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsVisible(false);
      setShowForeshadowForm(false);
      formOpenRef.current = false;
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isVisible, showForeshadowForm]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsVisible(false);
        setShowForeshadowForm(false);
        formOpenRef.current = false;
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 显示后按实测尺寸校正位置（layout effect 在绘制前执行，无闪烁）
  useLayoutEffect(() => {
    if (!isVisible) return;
    const el = menuRef.current;
    const rect = lastRectRef.current;
    if (!el || !rect) return;
    const next = computePlacement(rect, el.offsetWidth, el.offsetHeight);
    setPosition((prev) => (prev.x === next.x && prev.y === next.y && prev.below === next.below ? prev : next));
  }, [isVisible, showForeshadowForm, selectedText, pluginActions.length]);

  /** 剪贴板 API 不可用时的兜底复制 */
  const copyViaExecCommand = (text: string): boolean => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    suppressUntilRef.current = Date.now() + 300;
    let ok: boolean;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  };

  const handleCopy = () => {
    const finish = () => {
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
        setIsVisible(false);
      }, 900);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(selectedText).then(finish).catch(() => {
        if (copyViaExecCommand(selectedText)) finish();
      });
    } else if (copyViaExecCommand(selectedText)) {
      finish();
    }
  };

  const openForeshadowForm = () => {
    setFsDescription(selectedText);
    // 表单比按钮条高得多，用表单估算尺寸重算位置，避免视口顶部被截断
    const rect = lastRectRef.current;
    if (rect) setPosition(computePlacement(rect, 266, 300));
    formOpenRef.current = true;
    setShowForeshadowForm(true);
  };

  const handleAnnotate = (type: string) => {
    if (type === 'foreshadow') {
      openForeshadowForm();
      return;
    }

    const config = typeConfig[type];
    if (!config || !editor || !projectId) return;

    const from = editor.state.selection.from;
    const to = editor.state.selection.to;

    const annotationId = nanoid();
    addAnnotation({
      id: annotationId,
      projectId,
      chapterId: currentChapterId || '',
      type: config.annotationType,
      startOffset: from,
      endOffset: to,
      selectedText,
      targetId: undefined,
      targetType: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    editor.chain().focus().setMark('highlight', { color: getHighlightColor(type) }).run();
    setIsVisible(false);
  };

  const handleCreateForeshadow = () => {
    if (!editor || !fsDescription.trim() || !projectId) return;

    const from = editor.state.selection.from;
    const to = editor.state.selection.to;

    const fsId = nanoid();
    const annotationId = nanoid();

    const foreshadowData = {
      id: fsId,
      projectId,
      description: fsDescription,
      type: fsType,
      status: 'planted' as const,
      seedChapter: currentChapter?.order ?? 1,
      seedText: selectedText,
      seedAnnotationId: annotationId,
      hints: [],
      relatedCharacters: [],
      relatedItems: [],
      relatedEvents: [],
      earmarks: [],
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    addForeshadow(foreshadowData);

    addAnnotation({
      id: annotationId,
      projectId,
      chapterId: currentChapterId || '',
      type: 'foreshadow',
      startOffset: from,
      endOffset: to,
      selectedText,
      targetId: fsId,
      targetType: 'foreshadow',
      foreshadowType: fsType,
      foreshadowStatus: 'planted',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    editor.chain().focus().setMark('highlight', { color: 'rgba(245, 158, 11, 0.12)' }).run();

    window.dispatchEvent(new CustomEvent('novelmuse:open-foreshadow'));

    closeMenu();
    setFsDescription('');
    setFsType('motivation');
  };

  const handleSaveEarmark = (data: Partial<Earmark>) => {
    if (!projectId || !currentChapterId) return;

    const newEarmark: Earmark = {
      id: nanoid(),
      projectId,
      chapterId: currentChapterId,
      type: data.type || 'possibility',
      foreshadowId: data.foreshadowId,
      description: data.description,
      outcome: data.outcome,
      probability: data.probability,
      relatedCharacters: [],
      relatedItems: [],
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    addEarmark(newEarmark);

    if (data.foreshadowId) {
      linkToForeshadow(newEarmark.id, data.foreshadowId);
    }

    setEarmarkDialogOpen(false);
  };

  const getHighlightColor = (type: string): string => {
    // 低透明度背景色，不干扰正常书写
    const colors: Record<string, string> = {
      character: 'rgba(59, 130, 246, 0.12)',
      item: 'rgba(34, 197, 94, 0.12)',
      location: 'rgba(168, 85, 247, 0.12)',
      foreshadow: 'rgba(245, 158, 11, 0.12)',
      event: 'rgba(239, 68, 68, 0.12)',
      relation: 'rgba(236, 72, 153, 0.12)',
    };
    return colors[type] || 'rgba(107, 114, 128, 0.12)';
  };

  if (!projectId) return null;

  // 对话框打开时菜单虽已隐藏，仍需保持挂载（EarmarkDialog 渲染在同一 portal 内）
  if (!isVisible && !showForeshadowForm && !earmarkDialogOpen) return null;

  // 使用 Portal 渲染到 body，避免被 .nm-editor-card 的 backdrop-filter 影响
  // （backdrop-filter 会让内部 position: fixed 降级为相对该祖先定位）
  return createPortal(
    <>
    <div
      ref={menuRef}
      className="selection-menu-anchor"
      style={{
        left: position.x,
        top: position.y,
        transform: `translate(-50%, ${position.below ? '0' : '-100%'})`,
        width: 'max-content',
      }}
    >
      {showForeshadowForm ? (
        <div className="selection-menu-card is-form selection-menu-pop">
          <div className="selection-menu-form">
            <div className="selection-menu-form-title">
              <Bookmark size={14} aria-hidden="true" /> 创建伏笔
            </div>
            <div className="selection-menu-form-hint">
              选中文字：「{selectedText.slice(0, 20)}{selectedText.length > 20 ? '...' : ''}」
            </div>
            <textarea
              value={fsDescription}
              onChange={(e) => setFsDescription(e.target.value)}
              placeholder="描述这个伏笔的内容..."
              className="selection-menu-textarea"
              rows={3}
              autoFocus
            />
            <select
              value={fsType}
              onChange={(e) => setFsType(e.target.value as ForeshadowType)}
              className="selection-menu-select"
            >
              {foreshadowTypes.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <div className="selection-menu-actions">
              <button
                onClick={handleCreateForeshadow}
                disabled={!fsDescription.trim()}
                className="selection-menu-primary"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-1)' }}
              >
                <Check size={14} aria-hidden="true" /> 创建伏笔
              </button>
              <button
                onClick={closeMenu}
                className="selection-menu-secondary"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="selection-menu-card selection-menu-pop">
          {Object.entries(typeConfig).map(([key, config]) => {
            const Icon = config.Icon;
            return (
              <button
                key={key}
                onClick={() => handleAnnotate(key)}
                className="selection-menu-btn"
                style={{ '--menu-hover': config.color } as React.CSSProperties}
                title={`标注为${config.label}`}
              >
                <Icon size={14} aria-hidden="true" />
                <span>{config.label}</span>
              </button>
            );
          })}
          <div className="selection-menu-divider" />
          <button
            onClick={() => {
              setIsVisible(false);
              setEarmarkDialogOpen(true);
            }}
            className="selection-menu-btn"
            style={{ '--menu-hover': '#fff7ed' } as React.CSSProperties}
            title="添加书角标记"
          >
            <Pin size={14} aria-hidden="true" />
            <span>标记</span>
          </button>
          <button
            onClick={handleCopy}
            className="selection-menu-icon-btn"
            title={copied ? '已复制' : '复制选中文本'}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          {pluginActions.length > 0 && <div className="selection-menu-divider" />}
          {pluginActions.map((def) => (
            <PluginActionButton
              key={def.key}
              def={def}
              text={selectedText}
              editor={editor}
              onDone={closeMenu}
            />
          ))}
          <span className="selection-menu-count">{selectedText.length} 字</span>
        </div>
      )}
    </div>
    <EarmarkDialog
      open={earmarkDialogOpen}
      onOpenChange={setEarmarkDialogOpen}
      onSave={handleSaveEarmark}
      onCreateForeshadow={async (description, fsType) => {
        if (!projectId || !currentChapterId) return null;
        const fsId = nanoid();
        addForeshadow({
          id: fsId,
          projectId,
          description,
          type: fsType,
          status: 'planted',
          seedChapter: currentChapter?.order ?? 1,
          hints: [],
          relatedCharacters: [],
          relatedItems: [],
          relatedEvents: [],
          earmarks: [],
          tags: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        return fsId;
      }}
      chapterId={currentChapterId || undefined}
      existingForeshadows={foreshadows}
    />
  </>,
    document.body,
  );
}
