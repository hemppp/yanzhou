import { useState, useMemo, useRef, useCallback, useEffect, memo } from 'react';
import { Plus, Pencil, X, Check, Trash2, FileText, ChevronRight, BookOpen } from 'lucide-react';
import { useChapterStore, useProjectStore, cascadeCleanChapterClient } from '@novel-plugins/data-core/stores';
import { saveChapter, updateChapter as updateChapterInDb } from '@novel-plugins/data-core/data/databaseService';
import { useGSAP, chapterListEnter } from '@novel-plugins/ui-kit/gsap';
import { nanoid } from 'nanoid';
import { safeConfirm } from '@novel-plugins/ui-kit/safeConfirm';
import { openChapterInEditor } from '../utils/openChapter';
import { TrashDialog } from './TrashDialog';

// ★ memo + 拆分 wordCount 为独立 prop + 稳定 handler：
// 之前 `onClick={() => setCurrentChapter(chapter.id)}` 等内联箭头函数每次渲染都产生新引用，
// 导致 memo 浅比较失效，所有章节项每次都重渲染。
// 现在传入稳定的 useCallback handler（通过 chapterId 参数区分），真正实现"用户在 A 章打字时，B/C/D 章跳过渲染"。
const ChapterListItem = memo(function ChapterListItem({
  chapter,
  wordCount,
  isActive,
  onSelectChapter,
  onEditChapter,
  onDeleteChapter,
  editing,
  editTitle,
  onEditTitleChange,
  onSaveEdit,
  onCancelEdit,
  index = 0,
}: {
  chapter: { id: string; order: number; title: string; status: string };
  wordCount: number;
  isActive: boolean;
  // ★ 稳定 handler：接收 chapterId 参数，避免内联箭头函数导致 memo 失效
  onSelectChapter: (chapterId: string) => void;
  onEditChapter: (chapterId: string, title: string) => void;
  onDeleteChapter: (chapterId: string, e: React.MouseEvent) => void;
  editing: boolean;
  editTitle: string;
  onEditTitleChange: (v: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  index?: number;
}) {
  const [isHovered, setIsHovered] = useState(false);

  // ★ 章节状态点（2026-09-18 墨韵化）：
  //   原值是硬编码彩色 rgba —— draft 灰、revised **橙(255,180,90)**、final **青绿(90,200,150)**，
  //   在水墨体系（色相恒 0 饱和度）里是漏网的彩色；且外圈还有 `0 0 6px` 发光。
  //   改为走 SignalTone 的状态色（体系唯一的彩色出口，极低饱和）：
  //   草稿→idle 墨阶 / 修订→warn / 定稿→done / 归档→更淡的墨阶。发光去掉。
  const statusDots = {
    draft: 'hsl(var(--tone-3))',
    revised: 'hsl(var(--sig-warn))',
    final: 'hsl(var(--sig-done))',
    archived: 'hsl(var(--tone-3) / 0.6)',
  } as const;

  const statusDot = statusDots[chapter.status as keyof typeof statusDots] ?? statusDots.draft;

  return (
    <div
      onClick={() => onSelectChapter(chapter.id)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onDoubleClick={() => onEditChapter(chapter.id, chapter.title)}
      className="sidebar-chapter-item"
      style={{
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-4)',
        // ★ 用户口径（2026-10-05）「章节UI上下的宽度不是长度」：要减半的是**行高**。
        //   参考图左栏行距实测 27px（`t6-refrows.py`：y80→107→134→161→188→217→244→270），
        //   本行原来上下各 8px 内边距（含两行内容时实高 54-70），这里收到 2px。
        //   水平内边距回到 10（左栏宽度已改回 240，不再需要为 120px 让位）。
        padding: 'var(--space-0) var(--space-4)',
        borderRadius: 'var(--r-xs)',
        position: 'relative',
        // ★ 墨韵化（2026-09-18）：原来 active/hover/常态是三档「青霭玻璃」半透明底 +
        //   0.5px 勾线 + 玻璃高光内阴影 + backdropFilter 磨砂。
        //   现在：选中=淡墨底+1px 浓墨线，悬停=paper-hover 实色，常态透明。
        //   backdropFilter 一并去掉 —— 面板底色本来就是不透明的，磨砂看不见却给每一行
        //   都开一层合成层（章节多时是实打实的开销）。
        background: isActive
          ? 'hsl(var(--tone) / 0.07)'
          : isHovered
          ? 'hsl(var(--paper-hover))'
          : 'transparent',
        // 勾线统一 1px：0.5px 在非 retina 屏会被舍成 0 或 1，粗细不匀
        border: isActive
          ? '1px solid hsl(var(--paper-line-strong))'
          : '1px solid transparent',
        transition: 'background 0.2s ease, border-color 0.2s ease',
        animation: `slideTop 0.5s cubic-bezier(0.16, 1, 0.3, 1) ${index * 0.04}s both`,
      }}
    >
      {/* 序号徽章 — 圆弧UI */}
      {/* ★ 用户口径（2026-10-05）「章节UI上下的宽度不是长度」：行高要减半（54 → 27 量级），
          而 30px 徽章比目标行高还高 ⇒ 收到 22px（字号 12→11），并去掉与行 gap 重复的
          marginRight（行内已有 gap: 10）。 */}
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          fontWeight: 700,
          fontFamily: "'Inter', sans-serif",
          color: 'hsl(var(--tone-2))',
          // ★ 原为 `hsl(${order*37} 55% 70%)` 的**色相递增彩虹渐变** ——
          //   整个水墨体系里最后一处「按序号生成彩色 hue」的地方（2026-09-18 走查发现）。
          //   序号是纯装饰，改回墨阶：淡墨底 + 1px 墨线，靠字重与数字本身区分。
          background: 'hsl(var(--tone) / 0.06)',
          border: '1px solid hsl(var(--paper-line))',
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.02em',
          position: 'relative',
        }}
      >
        {chapter.order}
      </div>

      {/* 章节名 + 字数（★ 用户口径 2026-10-05「章节UI上下的宽度不是长度」：
          行高对齐参考图 27px ⇒ 由「上下两行」压成**单行**：章节名占满剩余宽度并省略号收尾，
          字数/草稿贴行右端。两行叠放时内容高 17+2+15=34，压成单行后行内容高取较高者 22（徽章）。 */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 'var(--space-3)' }}>
        {editing ? (
          <input
            type="text"
            value={editTitle}
            onChange={(e) => onEditTitleChange(e.target.value)}
            onBlur={onSaveEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSaveEdit();
              if (e.key === 'Escape') onCancelEdit();
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            style={{
              width: '100%',
              padding: 'var(--space-0) var(--space-2)',
              fontSize: 12,
              borderRadius: 'var(--r-2xs)',
              outline: 'none',
              border: '1px solid hsl(var(--paper-line-strong))',
              background: 'hsl(var(--paper-field))',
              color: 'hsl(var(--foreground))',
              fontFamily: "'Noto Serif SC', serif",
            }}
          />
        ) : (
          <>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12,
                fontWeight: 500,
                fontFamily: "'Noto Serif SC', serif",
                color: isActive ? 'hsl(var(--foreground))' : 'hsl(var(--foreground) / 0.88)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                lineHeight: 1.3,
              }}
            >
              {chapter.title}
            </div>
            <div
              /* ★ 用户口径（2026-10-05）「章节UI上下的宽度不是长度」：字数/草稿由
                 「标题下一行」改为**同一行贴右端**（`flexShrink: 0` 保住自身宽度，
                 先压缩左侧章节名），行高因此不再被第二行撑起。 */
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                flexShrink: 0,
                minWidth: 0,
                overflow: 'hidden',
                // ★ 11px 是体系字号地板（原来内联写死 10.5px，是**内联样式**，
                //   逃过了 `.text-[10px]` 那条类名兜底规则 —— 真机探针抓到的就是它）
                fontSize: 10,
                // ink-pale(58%) 亮色下只有 3.3:1，字数是用户要读的内容 → tone-2(4.61:1)
                color: 'hsl(var(--tone-2))',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: statusDot,
                }}
              />
              <span
                style={{
                  // 行被拖窄时先裁字数文本，再牺牲章节名（后者自带 ellipsis）
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {wordCount > 0 ? `${wordCount.toLocaleString()} 字` : '未开始'}
              </span>
              {/* ★ 草稿文字标签（截图口径）：status==='draft' 时行尾补「草稿」。
                  左边的 5px 点只表「有状态」，扫读时认不出是草稿还是修订，
                  文字标签补齐这一层信息；配色走 tone-2 + paper-line 低对比度，
                  与分割线同一档，不抢正文的视觉重量。 */}
              {chapter.status === 'draft' && (
                <span
                  style={{
                    padding: '0 var(--space-1)',
                    borderRadius: 3,
                    border: '1px solid hsl(var(--paper-line))',
                    color: 'hsl(var(--tone-2))',
                    // ★ 11px 是体系字号地板（见上方注释），内联样式同样不破例
                    fontSize: 10,
                    lineHeight: '14px',
                    flexShrink: 0,
                  }}
                >
                  草稿
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* 操作按钮 - 右侧（悬停浮层）
          ★ 用户口径（2026-10-05）「是章节UI上下的宽度不是长度」：行高按参考图压到 27-28px，
          这排按钮若回到文档流会把行高撑到 26 以上并挤掉章节名（徽章 22 + 行 gap 10 +
          按钮组 26 + 行内边距已超过行内容宽）。故保持**绝对定位浮在行右端**
          （行本身已 position:relative），只在悬停时出现，并自带一层 paper 底遮住底下的字；
          不悬停时 pointer-events:none，避免不可见按钮抢走点击。 */}
      {!editing && (
        <div
          style={{
            position: 'absolute',
            right: 6,
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 2,
            display: 'flex',
            gap: 'var(--space-0)',
            padding: 'var(--space-0)',
            borderRadius: 'var(--r-sm)',
            background: 'hsl(var(--paper))',
            opacity: isHovered ? 1 : 0,
            pointerEvents: isHovered ? 'auto' : 'none',
            transition: 'opacity 0.2s ease',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onEditChapter(chapter.id, chapter.title); }}
            style={{
              width: 22,
              height: 22,
              borderRadius: 'var(--r-sm)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'hsl(var(--paper-hover))',
              color: 'hsl(var(--tone-2))',
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: 'hsl(var(--paper-line))',
              cursor: 'pointer',
            }}
            title="重命名"
          >
            <Pencil size={10} />
          </button>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => onDeleteChapter(chapter.id, e)}
            style={{
              width: 22,
              height: 22,
              borderRadius: 'var(--r-sm)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'hsl(var(--paper-hover))',
              color: 'hsl(var(--tone-2))',
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: 'hsl(var(--paper-line))',
              cursor: 'pointer',
            }}
            title="删除"
          >
            <Trash2 size={10} />
          </button>
        </div>
      )}
    </div>
  );
});

// ---- 分卷折叠态（面板内 UI 偏好，按项目记忆）----
//
// 存 localStorage 而不是 store：这是**纯视图偏好**，不入库、不跨设备，
// 也没有必要让服务端知道；键里带 projectId 是因为不同书的卷名会撞
// （两本书都有「卷一」），共用一把键会让 A 书的折叠态串到 B 书。
//
// 读/写一律 try 包住：Safari 隐私模式与配额耗尽都会**抛异常**，
// 折叠功能不该因为存不下偏好就崩掉整个侧边栏（降级为会话内有效）。
const COLLAPSED_VOLUMES_KEY_PREFIX = 'nm.manual.leftSidebar.collapsedVolumes';

function collapsedVolumesKey(projectId: string | undefined): string | null {
  return projectId ? `${COLLAPSED_VOLUMES_KEY_PREFIX}:${projectId}` : null;
}

function readCollapsedVolumes(key: string | null): string[] {
  if (!key) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function writeCollapsedVolumes(key: string | null, volumes: string[]): void {
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(volumes));
  } catch {
    // 存不下就只保留会话内状态
  }
}

export function LeftSidebar() {
  // 拆 selector：精确订阅，避免无关字段变化触发 re-render
  const chapters = useChapterStore((s) => s.chapters);
  const currentChapterId = useChapterStore((s) => s.currentChapterId);
  const liveWordCount = useChapterStore((s) => s.liveWordCount);
  const addChapter = useChapterStore((s) => s.addChapter);
  const updateChapter = useChapterStore((s) => s.updateChapter);
  const deleteChapter = useChapterStore((s) => s.deleteChapter);
  const currentProject = useProjectStore((s) => s.currentProject);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  // 创建章节的弹层
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newVolume, setNewVolume] = useState('');
  const [creatingBusy, setCreatingBusy] = useState(false);
  // 回收站弹窗
  const [trashVisible, setTrashVisible] = useState(false);

  // ★ 分卷折叠态：按项目记忆（见文件上方 helper 的说明）
  const volumeStorageKey = collapsedVolumesKey(currentProject?.id);
  const [collapsedVolumes, setCollapsedVolumes] = useState<string[]>(() =>
    readCollapsedVolumes(volumeStorageKey),
  );
  // 切换项目（面板不卸载）时重新读取该项目的折叠态，避免 A 书的偏好套到 B 书
  useEffect(() => {
    setCollapsedVolumes(readCollapsedVolumes(volumeStorageKey));
  }, [volumeStorageKey]);

  const sidebarRef = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    // ★ scope 未挂载或无章节时跳过，避免 "Invalid scope" / "GSAP target not found" 警告
    if (!sidebarRef.current) return;
    const items = sidebarRef.current.querySelectorAll('.sidebar-chapter-item');
    if (items.length === 0) return;
    chapterListEnter('.sidebar-chapter-item');
  }, { scope: sidebarRef, dependencies: [chapters.length] });

  // 按 order 排序章节
  const sortedChapters = useMemo(
    () => [...chapters].sort((a, b) => a.order - b.order),
    [chapters],
  );

  // 卷-章 分组
  const volumeGroups = useMemo(() => {
    const map = new Map<string, typeof sortedChapters>();
    for (const ch of sortedChapters) {
      const v = ch.label?.trim() || '未分卷';
      const arr = map.get(v) ?? [];
      arr.push(ch);
      map.set(v, arr);
    }
    return Array.from(map.entries());
  }, [sortedChapters]);

  // ★ 稳定的章节选择 handler（useCallback 保证引用稳定，配合 ChapterListItem 的 memo）
  //   走 openChapterInEditor：切当前章 + 把中心区切回「章节正文」
  //   （只切 store 的话，正占着中心区的「章节」面板不会让位，表现为"点了没反应"）
  const handleSelectChapter = useCallback((id: string) => {
    openChapterInEditor(id);
  }, []);

  // ★ 稳定的取消编辑 handler
  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditTitle('');
  }, []);

  // ★ 分卷折叠/展开 + 落盘（写盘放在 updater 里是幂等的：同一份数组重复写结果一致）
  const toggleVolume = useCallback((volume: string) => {
    setCollapsedVolumes((prev) => {
      const next = prev.includes(volume)
        ? prev.filter((v) => v !== volume)
        : [...prev, volume];
      writeCollapsedVolumes(volumeStorageKey, next);
      return next;
    });
  }, [volumeStorageKey]);

  // 双击编辑标题
  const handleDoubleClick = useCallback((id: string, title: string) => {
    setEditingId(id);
    setEditTitle(title);
  }, []);

  // 保存编辑（章节标题）
  // ★ Bug 修复：之前用 content: '' / wordCount: 0 / status: 'draft' 等默认值调用 saveChapter，
  //   会把已有内容清空。这里改用「先读后写」，只更新 title / updatedAt，其它字段原样保留。
  const handleSaveEdit = useCallback(async () => {
    if (!editingId) return;
    const trimmed = editTitle.trim();
    const existing = chapters.find((c) => c.id === editingId);
    if (!existing) {
      setEditingId(null);
      setEditTitle('');
      return;
    }
    if (!trimmed) {
      // 标题为空 → 视作取消
      setEditingId(null);
      setEditTitle('');
      return;
    }
    const updated = { ...existing, title: trimmed, updatedAt: Date.now() };
    updateChapter(editingId, { title: trimmed, updatedAt: updated.updatedAt });
    try {
      await updateChapterInDb(editingId, { title: trimmed, updatedAt: updated.updatedAt });
    } catch (e) {
      console.warn('保存章节标题失败:', e);
    }
    setEditingId(null);
    setEditTitle('');
  }, [editingId, editTitle, chapters, updateChapter]);

  // 按 Escape 取消编辑
  useEffect(() => {
    if (!editingId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setEditingId(null);
        setEditTitle('');
      } else if (e.key === 'Enter') {
        handleSaveEdit();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [editingId, handleSaveEdit]);

  // 创建章节
  const handleCreate = useCallback(async () => {
    if (!currentProject) return;
    const title = newTitle.trim();
    if (!title) return;
    setCreatingBusy(true);
    try {
      // ★ 按 当前项目 的章节数计算 order，避免跨项目导致编号不连续
      const newOrder = chapters.filter(c => c.projectId === currentProject.id).length + 1;
      const id = nanoid();
      const now = new Date();
      const chapter = {
        id,
        projectId: currentProject.id,
        title,
        content: '',
        order: newOrder,
        wordCount: 0,
        status: 'draft' as const,
        label: newVolume.trim() || undefined,
        createdAt: now,
        updatedAt: now,
      };
      // 写入 DB
      await saveChapter(chapter as never);
      addChapter({
        id,
        projectId: currentProject.id,
        title,
        content: '',
        order: newOrder,
        wordCount: 0,
        summary: undefined,
        status: 'draft',
        label: newVolume.trim() || undefined,
        pov: undefined,
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
      } as never);
      // 自动选中新章节 + 把中心区切回正文（否则新建完看不到它）
      openChapterInEditor(id);
      setNewTitle('');
      setNewVolume('');
      setCreating(false);
    } catch (e) {
      console.error('创建章节失败:', e);
    } finally {
      setCreatingBusy(false);
    }
  }, [currentProject, newTitle, newVolume, chapters.length, addChapter]);

  // 删除章节（软删除 → 移入回收站）
  // 仅更新 store，由 syncService 自动同步到后端（DELETE /chapters/:id 软删除）
  const handleDelete = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!safeConfirm('将此章节移入回收站？可随时从回收站还原。')) return;
      // 先获取被删章节的 order，联动清理前端各 store 的关联数据
      const chapter = chapters.find((c) => c.id === id);
      if (chapter) {
        cascadeCleanChapterClient(chapter.order);
      }
      deleteChapter(id);
    },
    [deleteChapter, chapters],
  );

  if (!currentProject) {
    return null;
  }

  return (
    <div
      ref={sidebarRef}
      className="h-full flex flex-col font-[Inter,sans-serif]"
      aria-label="章节侧边栏"
    >
      {/* ★ 面板标题条（截图口径）：面板名 + 真实章节计数徽标。
          此前左栏没有自己的标题，只有 dockview 的标签，计数也无处可见。
          计数取的就是下面列表渲染的同一份 sortedChapters —— 徽标与列表
          永远是同一个数，不会出现「徽标 12 / 列表 11」的口径漂移。
          ★ t6 尺寸对齐参考图：高度与 dock 组头同规格 **33px**。
          参考图 1489×931 实测：左栏标题条占应用区 y31..63，与中心栏组头逐行齐平。
          原值 `h-9`(36px) 比参考图高 3px，正文面因此比参考图晚 3px 开始。
          ★ 不画下边线：参考图左栏 y63 整行 `#fdfdfd`（无分隔线），
          只有中心栏组头在 y63 有 `#dcdcdc` 细线（该线由 dock-theme.css 的
          `.dv-tabs-and-actions-container { border-bottom }` 提供）。原 `border-b` 会产生
          一条参考图没有的通栏线，故去掉。 */}
      <div className="flex h-[33px] shrink-0 items-center justify-between px-3">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-tone">
          <BookOpen size={12} aria-hidden="true" className="text-tone-3" />
          章节
        </span>
        <span
          className="mc-num rounded-chip px-1.5 py-0.5 text-[10px] text-tone-2"
          style={{ background: 'hsl(var(--paper-hover))' }}
          title={`共 ${sortedChapters.length} 章`}
          aria-label={`共 ${sortedChapters.length} 章`}
        >
          {sortedChapters.length}
        </span>
      </div>

      {/* 章节列表（卷分组） */}
      <div className="flex-1 overflow-y-auto py-3 mc-scrollbar">
        {sortedChapters.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <FileText size={20} className="mx-auto mb-2 text-tone-3" />
            <p className="text-[11px] text-tone-2">
              暂无章节 · 在下方创建第一章
            </p>
          </div>
        ) : (
          <div className="px-3 space-y-4">
            {volumeGroups.map(([volume, volChapters]) => {
              // 卷标题的显示条件：多卷（原来就只有多卷才显示）**或**单卷但有真实卷名
              // （截图里「卷一」这种单卷书也要有标题）。单卷且无卷名（'未分卷'）时
              // 不渲染标题 —— 与旧行为一致，也避免给一本没分卷的书凭空造一个卷。
              const showVolumeHeader = volumeGroups.length > 1 || volume !== '未分卷';
              const collapsed = collapsedVolumes.includes(volume);
              return (
                <div key={volume} className="space-y-1.5">
                  {/* 卷标题 —— 可折叠/展开，折叠态按项目持久化 */}
                  {showVolumeHeader && (
                    <button
                      type="button"
                      onClick={() => toggleVolume(volume)}
                      aria-expanded={!collapsed}
                      title={collapsed ? `展开「${volume}」` : `折叠「${volume}」`}
                      className="flex w-full items-center gap-1 rounded-chip px-1 py-0.5 text-left text-[10px] font-semibold tracking-wide text-tone-2 transition-colors hover:bg-paper-hover hover:text-tone"
                    >
                      <ChevronRight
                        size={11}
                        aria-hidden="true"
                        className={collapsed ? 'transition-transform' : 'rotate-90 transition-transform'}
                      />
                      <span className="truncate">{volume}</span>
                      <span className="mc-num ml-auto font-normal text-tone-3">
                        {volChapters.length}
                      </span>
                    </button>
                  )}
                  {/* 章节列表（★ 用户口径 2026-10-05「章节UI上下的宽度不是长度」：
                      行距按参考图左栏对齐（`t6-refrows.py` 实测 27px：y80→107→134→161…），
                      行盒自身 = 上下内边距 4 + 徽章 22 + 边框 2 = 28px ⇒ 这里不再另加间距。 */}
                  {!collapsed && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                      {volChapters.map((chapter, chapIdx) => {
                        const isActive = currentChapterId === chapter.id;
                        const wc = liveWordCount?.chapterId === chapter.id
                          ? liveWordCount.wordCount
                          : chapter.wordCount;
                        return (
                          <ChapterListItem
                            key={chapter.id}
                            chapter={chapter}
                            wordCount={wc}
                            isActive={isActive}
                            // ★ 传入稳定的 useCallback handler，避免内联箭头函数导致 memo 失效
                            onSelectChapter={handleSelectChapter}
                            onEditChapter={handleDoubleClick}
                            onDeleteChapter={handleDelete}
                            editing={editingId === chapter.id}
                            editTitle={editTitle}
                            onEditTitleChange={setEditTitle}
                            onSaveEdit={handleSaveEdit}
                            onCancelEdit={handleCancelEdit}
                            index={chapIdx}
                          />
                        );
                      })}
                    </div>
                  )}
                  {/* 折叠时给一行提示，避免用户以为「卷里的章节不见了」 */}
                  {collapsed && (
                    <p className="px-1 text-[10px] text-tone-3">
                      已折叠 {volChapters.length} 章
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 底部 — 新建章节 + 回收站 */}
      <div className="px-3 py-2 border-t" style={{ borderColor: 'hsl(var(--paper-line))' }}>
        {!creating ? (
          <div className="flex items-center gap-1.5">
            {/* 「新建章节」：图标 + 文字标签常显（120px 栏宽实验已回滚，栏宽回到 240）。
                title/aria-label 保留 —— 纯图标态或读屏下仍需要可访问名。 */}
            <button
              onClick={() => {
                setCreating(true);
                setNewVolume(volumeGroups[0]?.[0] ?? '');
              }}
              className="nm-btn-apple nm-btn-apple-secondary flex-1 justify-center text-[11px] py-2"
              title="新建章节"
              aria-label="新建章节"
            >
              <Plus size={13} />
              <span>新建章节</span>
            </button>
            <button
              onClick={() => setTrashVisible(true)}
              className="nm-btn-apple-icon-sm shrink-0"
              aria-label="回收站"
              title="回收站"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ) : (
          <div className="space-y-2 animate-slide-up">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="章节名"
              autoFocus
              className="w-full px-2.5 py-1.5 text-[11px] rounded-md outline-none transition-colors"
              style={{
                color: 'hsl(var(--foreground))',
                background: 'rgb(var(--glass-tint) / 0.45)',
                border: '1px solid hsl(var(--paper-line-strong))',
                backdropFilter: 'blur(10px) saturate(150%)',
                WebkitBackdropFilter: 'blur(10px) saturate(150%)',
                boxShadow: 'inset 0 1px 0 rgb(var(--glass-highlight) / 0.35)',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') {
                  setCreating(false);
                  setNewTitle('');
                  setNewVolume('');
                }
              }}
            />
            <input
              type="text"
              value={newVolume}
              onChange={(e) => setNewVolume(e.target.value)}
              placeholder="卷名（可选）"
              list="volume-suggestions"
              className="w-full px-2.5 py-1.5 text-[11px] rounded-md outline-none transition-colors"
              style={{
                color: 'hsl(var(--foreground))',
                background: 'rgb(var(--glass-tint) / 0.45)',
                border: '1px solid hsl(var(--paper-line-strong))',
                backdropFilter: 'blur(10px) saturate(150%)',
                WebkitBackdropFilter: 'blur(10px) saturate(150%)',
                boxShadow: 'inset 0 1px 0 rgb(var(--glass-highlight) / 0.35)',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') {
                  setCreating(false);
                  setNewTitle('');
                  setNewVolume('');
                }
              }}
            />
            <datalist id="volume-suggestions">
              {volumeGroups.map(([v]) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleCreate}
                disabled={creatingBusy || !newTitle.trim()}
                className="flex-1 nm-btn-apple nm-btn-apple-primary text-[11px] py-1.5"
              >
                <Check size={11} />
                <span>创建</span>
              </button>
              <button
                onClick={() => {
                  setCreating(false);
                  setNewTitle('');
                  setNewVolume('');
                }}
                className="nm-btn-apple-icon-sm"
                aria-label="取消新建"
                title="取消"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 回收站弹窗 */}
      <TrashDialog visible={trashVisible} onClose={() => setTrashVisible(false)} />
    </div>
  );
}
