import { useState, memo, useEffect, useRef, useCallback } from 'react';
import type { Project } from '@novel/shared';
import { formatDistanceToNow } from '@/utils/date';
import { MoreVertical, Pencil, Trash2, BookOpen, Clock, FileText } from 'lucide-react';
import { BookCover } from './BookCover';
import { useGlassRipple } from '@/hooks/useGlassRipple';

interface BookCardProps {
  book: Project;
  onClick: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  chapterCount?: number;
  index?: number;
  className?: string;
  /**
   * ★ 2026-10-07「跳转加载转圈」全修复（④）：**意图预取**钩子。
   *
   * 在 `mouseenter` / `focus` / `pointerdown`（用户指向本书、但点击尚未发生）时调用，
   * 用来提前发出「进项目」链路的 chunk（见 `routes/prefetch.ts` 的
   * `prefetchProjectEntry`）。命中模块缓存后，点击导航时四段串行只剩数据请求的真实耗时。
   * 失败静默 —— 预取绝不能影响正常点击。
   */
  onIntent?: () => void;
}

/**
 * 书封上的前景色推导 —— `color-mix(in srgb, var(--cover-fg) N%, transparent)`。
 *
 * ★ 为什么不直接写 `rgba(255,255,255,.65)`：
 *   封面文字/胶囊/统计条原来全是硬编码白（为"下半部近黑"的封面服务）。
 *   封面换成暖调淡纸后白字只有 4.42:1（不达 AA），必须能整体翻成墨字。
 *   抽一个 `--cover-fg` + 各档 alpha，主题只换一个值就能翻面。
 *
 * ★ 为什么等价（所以默认主题逐像素不变）：
 *   `color-mix(in srgb, #ffffff 65%, transparent)` 算出来**就是**
 *   `rgba(255,255,255,0.65)` —— 实测算过，不是"差不多"。
 */
const coverFg = (alphaVar: string): string =>
  `color-mix(in srgb, var(--cover-fg) var(${alphaVar}), transparent)`;

const DROPDOWN_ITEM_BASE: React.CSSProperties = {  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  width: '100%',
  padding: 'var(--space-3) var(--space-5)',
  border: 'none',
  background: 'transparent',
  fontSize: 12,
  cursor: 'pointer',
  textAlign: 'left',
  transition: 'background 0.15s',
  fontFamily: "'Noto Serif SC', serif",
};

const BookCard = memo(function BookCard({ book, onClick, onEdit, onDelete, chapterCount = 0, index: _index = 0, className, onIntent }: BookCardProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // ★ 意图预取（④）：`pointerdown` 是最早的「用户确实要打开这本书」信号 ——
  //   比 click 早、比 mouseenter 更确定。涟漪处理器本就接受一个 onPointerDown 回调，
  //   这里把预取挂在同一个事件上（不额外加监听器、不改 DOM 结构）。
  const handleIntentPointerDown = useCallback(() => { onIntent?.(); }, [onIntent]);
  const handlePointerDown = useGlassRipple<HTMLDivElement>(handleIntentPointerDown);

  useEffect(() => {
    if (!showMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  const {
    name: bookName,
    penName: bookAuthor,
    genre: bookGenre = '未分类',
    currentWordCount: bookWordCountRaw = 0,
    updatedAt,
  } = book;

  const wordCountDisplay = (() => {
    const wc = bookWordCountRaw;
    return wc >= 10000
      ? `${(wc / 10000).toFixed(1)}万字`
      : `${wc.toLocaleString()} 字`;
  })();

  const handleMouseEnter = useCallback(() => { setIsHovered(true); onIntent?.(); }, [onIntent]);
  const handleMouseLeave = useCallback(() => { setIsHovered(false); setIsPressed(false); }, []);
  const handleMouseDown = useCallback(() => setIsPressed(true), []);
  const handleMouseUp = useCallback(() => setIsPressed(false), []);
  const handleMenuToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMenu(prev => !prev);
  }, []);

  return (
    <div
      ref={cardRef}
      className={`${className} glass-ripple glass-pressable`}
      style={{
        position: 'relative',
        cursor: 'pointer',
        borderRadius: 'var(--r-lg)',
        overflow: 'hidden',
        aspectRatio: '3 / 4',
        transition: 'transform 0.4s cubic-bezier(0.16,1,0.3,1), box-shadow 0.4s cubic-bezier(0.16,1,0.3,1)',
        // 投影值挂到 CSS 变量上（默认值与原来完全一致，见 fallback）。
        // ★ 为什么不用写死的字符串（2026-09-18）：这是**内联 style**，主题 CSS 压不动 ——
        //   换成淡纸底后，卡片底下一圈黑色投影让它们看着像"贴上去的"，
        //   而纸上的卡片本该是轻轻压在纸上。改成变量后主题可以自由改投影，
        //   不必用 !important 硬压内联样式。
        boxShadow: isHovered
          ? 'var(--card-shadow-hover, 0 20px 50px hsl(var(--glass-shadow) / 0.35), 0 6px 16px hsl(var(--glass-shadow) / 0.20))'
          : 'var(--card-shadow, 0 6px 20px hsl(var(--glass-shadow) / 0.18), 0 2px 6px hsl(var(--glass-shadow) / 0.10))',
        transform: isPressed
          ? 'translateY(-2px) scale(0.97)'
          : isHovered
          ? 'translateY(-6px) scale(1.02)'
          : 'translateY(0) scale(1)',
        animation: `slideTop 0.8s cubic-bezier(0.16, 1, 0.3, 1) ${_index * 0.04}s both`,
      }}
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onPointerDown={handlePointerDown}
    >
      {/* 封面层 — 铺满整张卡片 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transition: 'transform 0.6s cubic-bezier(0.16,1,0.3,1)',
          transform: isHovered ? 'scale(1.08)' : 'scale(1)',
        }}
      >
        <BookCover
          book={book}
          showFirstChar={true}
          style={{ width: '100%', height: '100%' }}
        />
      </div>

      {/* 顶部渐变遮罩 — 让 genre 标签和菜单按钮在亮色封面上也清晰 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 80,
          // ★ 2026-10-30（P5）：改走 token。原来这条是硬编码纯黑，
          //   会把封面顶部的色相一起洗掉；且与底部遮罩各自写死、无法统一调。
          background:
            'var(--cover-scrim-strong, linear-gradient(180deg, rgba(14,20,26,0.38) 0%, rgba(14,20,26,0) 100%))',
          pointerEvents: 'none',
          zIndex: 1,
        }}
      />

      {/* 底部渐变遮罩 — 让文字信息可读
          ★ 走变量（默认值 = 原硬编码渐变）—— 这是封面偏暗的**真凶**：
            它盖住封面下 55%，书名位置实际叠了约 0.55 的黑。
            之前只调 --cover-wash-scale / --cover-decor-alpha 都是在治标 ——
            隔离实验（封面底改纯红 → 渲染出上亮下暗的红渐变）才把它揪出来。
            详见 globals.css 的 --cover-scrim 注释。 */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: '55%',
          background:
            'var(--cover-scrim, linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.35) 50%, rgba(0,0,0,0.75) 100%))',
          pointerEvents: 'none',
          zIndex: 1,
          transition: 'opacity 0.3s ease',
          opacity: isHovered ? 1 : 'var(--cover-scrim-opacity, 0.92)',
        }}
      />

      {/* 顶部：genre 标签 + 更多按钮 */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          right: 12,
          zIndex: 3,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
        }}
      >
        <span
          style={{
            display: 'inline-block',
            padding: 'var(--space-1) var(--space-4)',
            borderRadius: 'var(--r-pill)',
            background: coverFg('--cover-chip-bg-alpha'),
            backdropFilter: 'blur(12px) saturate(180%)',
            WebkitBackdropFilter: 'blur(12px) saturate(180%)',
            border: '0.5px solid ' + coverFg('--cover-chip-border-alpha'),
            fontSize: 10,
            fontWeight: 500,
            color: coverFg('--cover-chip-fg-alpha'),
            fontFamily: "'Noto Serif SC', serif",
            maxWidth: '70%',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            letterSpacing: '0.04em',
          }}
        >
          {bookGenre}
        </span>
        <button
          onClick={handleMenuToggle}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: '50%',
            border: '0.5px solid ' + coverFg('--cover-chip-border-alpha'),
            background: 'rgba(0,0,0,0.25)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            color: coverFg('--cover-chip-fg-alpha'),
            cursor: 'pointer',
            opacity: isHovered ? 1 : 0,
            transition: 'opacity 0.25s ease, background 0.2s, transform 0.15s',
            transform: isHovered ? 'translateY(0)' : 'translateY(-4px)',
            flexShrink: 0,
          }}
          aria-label="更多操作"
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.4)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.25)'; }}
        >
          <MoreVertical size={13} />
        </button>
      </div>

      {/* 底部信息区 — 毛玻璃悬浮（haowallpaper 风格） */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 3,
          padding: 'var(--space-6)',
          transform: isHovered ? 'translateY(0)' : 'translateY(0)',
          transition: 'transform 0.35s cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        {/* 书名 */}
        <h3
          style={{
            fontSize: 15,
            fontWeight: 600,
            // ★ 走变量（默认值 = 原硬编码白）—— 主题才能接管。
            //   起因：封面改成暖调淡纸后，白字实测只有 4.42:1，
            //   低于项目 4.5:1 的 AA 门槛。详见 globals.css 的 --cover-title 注释。
            color: coverFg('--cover-title-alpha'),
            margin: 0,
            lineHeight: 1.3,
            fontFamily: "'Noto Serif SC', 'Source Han Serif SC', serif",
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            // 投影也要能撤 —— 换成墨字后深投影会把字糊掉
            textShadow: 'var(--cover-title-shadow, 0 1px 2px rgba(0,0,0,0.3))',
            letterSpacing: '0.02em',
          }}
        >
          {bookName}
        </h3>

        {/* 作者 */}
        {bookAuthor && (
          <p
            style={{
              fontSize: 11,
              color: coverFg('--cover-meta-alpha'),
              margin: 'var(--space-1) 0 0 0',
              fontFamily: "'Noto Serif SC', serif",
              letterSpacing: '0.06em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {bookAuthor}
          </p>
        )}

        {/* 统计行 — 毛玻璃胶囊 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            marginTop: 'var(--space-4)',
            padding: 'var(--space-2) var(--space-4)',
            borderRadius: 'var(--r-pill)',
            background: coverFg('--cover-stats-bg-alpha'),
            backdropFilter: 'blur(14px) saturate(180%)',
            WebkitBackdropFilter: 'blur(14px) saturate(180%)',
            border: '0.5px solid ' + coverFg('--cover-stats-border-alpha'),
            fontSize: 10,
            color: coverFg('--cover-stats-fg-alpha'),
            fontFamily: "'Noto Serif SC', serif",
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
            <BookOpen size={10} />
            {wordCountDisplay}
          </span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
            <FileText size={10} />
            {chapterCount} 章
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', opacity: 0.8 }}>
            <Clock size={10} />
            {formatDistanceToNow(updatedAt || Date.now())}
          </span>
        </div>
      </div>

      {/* Dropdown 菜单 — 液态玻璃 */}
      {showMenu && (
        <div
          ref={menuRef}
          style={{
            position: 'absolute',
            top: 44,
            right: 10,
            zIndex: 20,
            width: 140,
            borderRadius: 'var(--r-sm)',
            background: 'rgb(var(--glass-tint) / var(--glass-modal-bg))',
            backdropFilter: 'blur(40px) saturate(200%)',
            WebkitBackdropFilter: 'blur(40px) saturate(200%)',
            border: '0.5px solid rgb(var(--glass-highlight) / 0.3)',
            boxShadow: '0 24px 64px hsl(var(--glass-shadow) / 0.18), 0 8px 24px hsl(var(--glass-shadow) / 0.08), inset 0 1px 0 rgb(var(--glass-highlight) / 0.8)',
            padding: 'var(--space-1) 0',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit?.();
              setShowMenu(false);
            }}
            className="nm-menu-item hover:bg-[hsl(var(--secondary))]"
            style={{
              ...DROPDOWN_ITEM_BASE,
              color: 'hsl(var(--foreground) / 0.75)',
            }}
          >
            <Pencil size={14} />
            编辑
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete?.();
              setShowMenu(false);
            }}
            className="nm-menu-item hover:bg-destructive/10"
            style={{
              ...DROPDOWN_ITEM_BASE,
              color: 'hsl(var(--destructive))',
            }}
          >
            <Trash2 size={14} />
            删除
          </button>
        </div>
      )}
    </div>
  );
});

export { BookCard };
