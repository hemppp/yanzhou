import { useState, useEffect, useRef } from 'react';
import { X, Plus, Trash2, ChevronLeft, ChevronRight, Check } from 'lucide-react';
import type { GenreCategory, NovelBrief, Project, ProjectMode } from '@novel/shared';
import { GENRE_CATEGORIES, getGenreCategory, formatGenreLabel } from './novelGenres';
import { modalEnter, modalExit } from '@/utils/gsap';
import { dispatchToastEvent } from '@/utils/errors';

interface AddBookFormData {
  title: string;
  author: string;
  description?: string;
  cover?: string;
  targetWordCount?: number;
  /** 流派（展示名，如「系统流 · 末日求生」）—— 会被写进项目，也用于书卡标签 */
  genre?: string;
  /** 创作模式：决定该项目加载哪一套工作台（两套 UI 互斥） */
  mode?: ProjectMode;
  /** AI 写作的开书设定（仅 mode==='auto' 时有值） */
  brief?: NovelBrief;
}

interface AddBookModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: AddBookFormData) => Promise<void>;
  editBook?: Project | null;
}

/** AI 写作向导的第二步：流派选择 */
type AiStep = 'brief' | 'genre';

export function AddBookModal({ isOpen, onClose, onSubmit, editBook }: AddBookModalProps) {
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');
  const [targetWordCount, setTargetWordCount] = useState('');
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  /** 创作模式：新建默认「手写」，AI 写作需显式切换 */
  const [mode, setMode] = useState<ProjectMode>('manual');

  // ---- AI 写作向导（mode === 'auto' 时才用；手写分支完全不碰这些状态） ----
  /** 当前步骤：先填设定表单，填完再选流派 */
  const [aiStep, setAiStep] = useState<AiStep>('brief');
  const [opening, setOpening] = useState('');
  const [worldview, setWorldview] = useState('');
  const [style, setStyle] = useState('');
  const [protagonist, setProtagonist] = useState('');
  /** 是否多女主：关 → 只填一位；开 → 展开可增删的姓名列表 */
  const [multiHeroine, setMultiHeroine] = useState(false);
  const [heroines, setHeroines] = useState<string[]>(['']);
  const [genreCategory, setGenreCategory] = useState<GenreCategory>('system');
  const [genre, setGenre] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [focusedField, setFocusedField] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const prevIsOpenRef = useRef(false);
  const [shouldRender, setShouldRender] = useState(false);
  const isMountedRef = useRef(true);
  const animationRef = useRef<gsap.core.Timeline | null>(null);

  // Track mount status
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // Cleanup animation on unmount
      if (animationRef.current) {
        animationRef.current.kill();
        animationRef.current = null;
      }
    };
  }, []);

  // Handle 打开/关闭 animations
  useEffect(() => {
    const wasOpen = prevIsOpenRef.current;
    prevIsOpenRef.current = isOpen;

    // Kill any existing animation
    if (animationRef.current) {
      animationRef.current.kill();
      animationRef.current = null;
    }

    if (isOpen && !wasOpen) {
      setShouldRender(true);
      // 使用 useLayoutEffect 的时机确保 DOM 已更新
      // 但这里用 setTimeout 确保 React 完成渲染后再触发动画
      setTimeout(() => {
        if (!isMountedRef.current) return;
        if (modalRef.current) {
          animationRef.current = modalEnter(modalRef.current, backdropRef.current || undefined);
        }
      }, 0);
    } else if (!isOpen && wasOpen) {
      if (modalRef.current && isMountedRef.current) {
        animationRef.current = modalExit(modalRef.current, backdropRef.current || undefined);
        // Use a safe callback that checks mount status
        animationRef.current.then(() => {
          if (isMountedRef.current) {
            setShouldRender(false);
          }
        });
      } else {
        // If no modal ref or not mounted, just update state safely
        if (isMountedRef.current) {
          setShouldRender(false);
        }
      }
    }
  }, [isOpen]);

  useEffect(() => {
    if (editBook) {
      setTitle(editBook.name);
      setAuthor(editBook.penName || '');
      setDescription(editBook.description || '');
      setTargetWordCount(editBook.targetWordCount?.toString() || '');
      setCoverPreview(editBook.coverImage || null);
      setMode(editBook.mode ?? 'manual');
      // 回填开书设定：老项目（向导之前建的）没有 brief，就按空表单处理
      const b = editBook.brief;
      setAiStep('brief');
      setOpening(b?.opening || '');
      setWorldview(b?.worldview || '');
      setStyle(b?.style || '');
      setProtagonist(b?.protagonist || '');
      setMultiHeroine(b?.multipleHeroines ?? false);
      setHeroines(b?.heroines && b.heroines.length > 0 ? [...b.heroines] : ['']);
      setGenreCategory(b?.genreCategory ?? 'system');
      setGenre(b?.genre || '');
    } else {
      setTitle('');
      setAuthor('');
      setDescription('');
      setTargetWordCount('');
      setCoverPreview(null);
      setMode('manual');
      setAiStep('brief');
      setOpening('');
      setWorldview('');
      setStyle('');
      setProtagonist('');
      setMultiHeroine(false);
      setHeroines(['']);
      setGenreCategory('system');
      setGenre('');
    }
    setError('');
     
  }, [editBook?.id ?? 'new', isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  /** 去空后的女主名单 —— 空白行不算数，别把空字符串当名字存进设定 */
  const cleanHeroines = (): string[] => heroines.map(h => h.trim()).filter(Boolean);

  /** 设定表单的校验（流派在第二步单独校验） */
  const validateBrief = (): string => {
    if (!title.trim()) return '请输入书名';
    if (!opening.trim()) return '请填写开局：故事从哪一刻、哪个场景切入';
    if (!worldview.trim()) return '请填写世界观：时代、舞台与力量规则';
    if (!style.trim()) return '请填写笔风基调：叙事语气与节奏';
    if (!protagonist.trim()) return '请填写主角姓名';
    if (cleanHeroines().length === 0) return '请至少填写一位女主的姓名';
    return '';
  };

  const gotoGenreStep = () => {
    const msg = validateBrief();
    if (msg) {
      setError(msg);
      return;
    }
    setError('');
    setAiStep('genre');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('请输入书名');
      return;
    }

    // AI 写作：两步向导的数据一起交出去（brief + 流派展示名）
    let brief: NovelBrief | undefined;
    let genreLabel: string | undefined;
    if (mode === 'auto') {
      if (aiStep === 'brief') {
        // 在第一步按回车不该直接建书，先推进到流派选择
        gotoGenreStep();
        return;
      }
      const msg = validateBrief();
      if (msg) {
        setError(msg);
        setAiStep('brief');
        return;
      }
      if (!genre.trim()) {
        setError('请选择一个流派（或自己填一个）');
        return;
      }
      brief = {
        opening: opening.trim(),
        worldview: worldview.trim(),
        style: style.trim(),
        protagonist: protagonist.trim(),
        multipleHeroines: multiHeroine,
        heroines: cleanHeroines(),
        genreCategory,
        genre: genre.trim(),
      };
      genreLabel = formatGenreLabel(genreCategory, genre);
    }

    setIsSubmitting(true);
    try {
      await onSubmit({
        title: title.trim(),
        author: author.trim(),
        description: description.trim() || undefined,
        targetWordCount: targetWordCount ? parseInt(targetWordCount) : undefined,
        cover: coverPreview || undefined,
        genre: genreLabel,
        mode,
        brief,
      });
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : '提交失败，请重试';
      console.error('[AddBookModal] 提交失败:', message);
      setError(message);
      dispatchToastEvent({ type: 'error', message, duration: 4000 });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!shouldRender) return null;

  const isAuto = mode === 'auto';

  const inputBaseStyle: React.CSSProperties = {
    width: '100%',
    padding: 'var(--space-4) var(--space-5)',
    borderWidth: '0.5px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
    borderRadius: 'var(--r-xs)',
    fontSize: 13,
    color: 'hsl(var(--foreground))',
    background: 'rgb(var(--glass-tint) / 0.4)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    outline: 'none',
    transition: 'border-color 0.2s, background 0.2s',
    boxSizing: 'border-box',
  };

  // ★ 2026-10-11：原聚焦加 4px 光晕 + inset 高光（输入时整框泛光），按反馈移除 ——
  //   只保留边框变色 + 底色微亮，不再泛光。
  const inputFocusStyle: React.CSSProperties = {
    borderColor: 'hsl(var(--ring) / 0.7)',
    background: 'rgb(var(--glass-tint) / 0.6)',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 11,
    fontWeight: 500,
    color: 'hsl(var(--secondary-foreground))',
    marginBottom: 'var(--space-2)',
  };

  const req = <span style={{ color: 'hsl(var(--destructive))' }}>*</span>;

  const fieldStyle = (key: string): React.CSSProperties => ({
    ...inputBaseStyle,
    ...(focusedField === key ? inputFocusStyle : {}),
  });

  return (
    <div
      ref={backdropRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'hsl(var(--glass-shadow) / 0.32)',
        backdropFilter: 'blur(16px) saturate(120%)',
        WebkitBackdropFilter: 'blur(16px) saturate(120%)',
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={modalRef}
        className="addbook-modal-card glass-modal"
        style={{
          width: '100%',
          // 手写卡片维持原宽；AI 写作向导字段多，放宽一点
          maxWidth: isAuto ? 560 : 440,
          // ★ 高度必须封顶滚动：AI 向导字段多，长起来会超过视口 ——
          //   弹窗靠 flex 居中，没有 maxHeight 时上下两头一起溢出，
          //   底部「下一步 / 创建」会被顶到屏幕外且没有任何滚动容器，直接点不到（实测）。
          maxHeight: 'min(88vh, 780px)',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 'var(--r-lg)',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
          overflow: 'hidden',
          transition: 'max-width 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Header —— shrink-0：滚动交给下面的字段区，标题与按钮都固定住 */}
        <div style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--space-7) var(--space-8) 0 var(--space-8)',
        }}>
          <h2 style={{
            fontSize: 15,
            fontWeight: 600,
            color: 'hsl(var(--foreground))',
            margin: 0,
          }}>
            {editBook ? '编辑书籍' : '新建书籍'}
          </h2>
          <button
            onClick={onClose}
            className="addbook-modal-close"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 'var(--r-pill)',
              border: 'none',
              background: 'transparent',
              color: 'hsl(var(--muted-foreground))',
              cursor: 'pointer',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'hsl(var(--secondary))';
              e.currentTarget.style.color = 'hsl(var(--foreground))';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'hsl(var(--muted-foreground))';
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            padding: 'var(--space-7) var(--space-8) var(--space-8)',
          }}
          className="addbook-form"
        >
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)', paddingRight: 'var(--space-1)' }}>
            {/* 创作方式 —— 创建时的第一步决策：决定这个项目加载哪一套工作台（两套 UI 互斥） */}
            <div>
              <label style={{
                display: 'block',
                fontSize: 11,
                fontWeight: 500,
                color: 'hsl(var(--secondary-foreground))',
                marginBottom: 'var(--space-2)',
              }}>
                创作方式
              </label>
              <div
                role="radiogroup"
                aria-label="创作方式"
                style={{
                  position: 'relative',
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  padding: 'var(--space-1)',
                  borderRadius: 'var(--r-pill)',
                  background: 'rgb(var(--glass-tint) / 0.45)',
                  border: '0.5px solid hsl(var(--border) / 0.6)',
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                }}
              >
                {/* 滑动指示块：靠 translateX 在两项之间滑，而不是重新布局 */}
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: 'var(--space-1)',
                    bottom: 'var(--space-1)',
                    left: 'var(--space-1)',
                    width: 'calc(50% - var(--space-1))',
                    borderRadius: 'var(--r-pill)',
                    background: 'linear-gradient(160deg, hsl(var(--primary)), hsl(var(--primary) / 0.78))',
                    boxShadow: '0 2px 10px hsl(var(--primary) / 0.32), inset 0 1px 0 rgb(var(--glass-highlight) / 0.5)',
                    transform: mode === 'auto' ? 'translateX(100%)' : 'translateX(0)',
                    transition: 'transform 0.32s cubic-bezier(0.34, 1.4, 0.64, 1)',
                  }}
                />
                {([
                  { key: 'manual' as ProjectMode, label: '手写' },
                  { key: 'auto' as ProjectMode, label: 'AI 写作' },
                ]).map((opt) => {
                  const active = mode === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        if (mode === opt.key) return;
                        setMode(opt.key);
                        setError('');
                      }}
                      style={{
                        position: 'relative',
                        zIndex: 1,
                        padding: 'var(--space-3) 0',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 500,
                        color: active ? '#fff' : 'hsl(var(--muted-foreground))',
                        transition: 'color 0.2s',
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <p style={{
                fontSize: 10,
                lineHeight: 1.55,
                color: 'hsl(var(--muted-foreground))',
                margin: 'var(--space-2) var(--space-0) 0 var(--space-0)',
              }}>
                {mode === 'manual'
                  ? '自己执笔，AI 打辅助 —— 罗盘气泡 + 角色 / 地图 / 时间线等浮窗面板'
                  : 'AI 主笔、你审稿 —— 智能体交流流 + 流式写文，手写面板不加载'}
              </p>
            </div>

            {/* ==================== 手写：保持原有卡片表单完全不变 ==================== */}
            {mode === 'manual' && (
              <>
                {/* Title */}
                <div>
                  <label style={{
                    display: 'block',
                    fontSize: 11,
                    fontWeight: 500,
                    color: 'hsl(var(--secondary-foreground))',
                    marginBottom: 'var(--space-2)',
                  }}>
                    书名 <span style={{ color: 'hsl(var(--destructive))' }}>*</span>
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => { setTitle(e.target.value); setError(''); }}
                    onFocus={() => setFocusedField('title')}
                    onBlur={() => setFocusedField(null)}
                    placeholder="输入书名"
                    style={{
                      ...inputBaseStyle,
                      ...(focusedField === 'title' ? inputFocusStyle : {}),
                    }}
                    autoFocus
                  />
                  {error && (
                    <p style={{
                      fontSize: 11,
                      color: 'hsl(var(--destructive))',
                      margin: 'var(--space-2) 0 0 0',
                    }}>
                      {error}
                    </p>
                  )}
                </div>

                {/* Author */}
                <div>
                  <label style={{
                    display: 'block',
                    fontSize: 11,
                    fontWeight: 500,
                    color: 'hsl(var(--secondary-foreground))',
                    marginBottom: 'var(--space-2)',
                  }}>
                    作者
                  </label>
                  <input
                    type="text"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    onFocus={() => setFocusedField('author')}
                    onBlur={() => setFocusedField(null)}
                    placeholder="输入作者名"
                    style={{
                      ...inputBaseStyle,
                      ...(focusedField === 'author' ? inputFocusStyle : {}),
                    }}
                  />
                </div>

                {/* 描述 */}
                <div>
                  <label style={{
                    display: 'block',
                    fontSize: 11,
                    fontWeight: 500,
                    color: 'hsl(var(--secondary-foreground))',
                    marginBottom: 'var(--space-2)',
                  }}>
                    简介
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    onFocus={() => setFocusedField('description')}
                    onBlur={() => setFocusedField(null)}
                    placeholder="简要描述..."
                    rows={3}
                    style={{
                      ...inputBaseStyle,
                      resize: 'vertical',
                      minHeight: 72,
                      ...(focusedField === 'description' ? inputFocusStyle : {}),
                    }}
                  />
                </div>

                {/* Target word count */}
                <div>
                  <label style={{
                    display: 'block',
                    fontSize: 11,
                    fontWeight: 500,
                    color: 'hsl(var(--secondary-foreground))',
                    marginBottom: 'var(--space-2)',
                  }}>
                    目标字数
                  </label>
                  <input
                    type="number"
                    value={targetWordCount}
                    onChange={(e) => setTargetWordCount(e.target.value)}
                    onFocus={() => setFocusedField('targetWordCount')}
                    onBlur={() => setFocusedField(null)}
                    placeholder="例如：100000"
                    style={{
                      ...inputBaseStyle,
                      ...(focusedField === 'targetWordCount' ? inputFocusStyle : {}),
                    }}
                  />
                </div>
              </>
            )}

            {/* ==================== AI 写作：两步向导 ==================== */}
            {isAuto && (
              <>
                {/* 步骤指示 */}
                <div className="flex items-center gap-2" style={{ marginTop: 'calc(-1 * var(--space-0))' }}>
                  {([
                    { key: 'brief' as AiStep, n: 1, label: '开书设定' },
                    { key: 'genre' as AiStep, n: 2, label: '流派选择' },
                  ]).map((s, i) => {
                    const active = aiStep === s.key;
                    const done = s.key === 'brief' && aiStep === 'genre';
                    return (
                      <div key={s.key} className="flex items-center gap-2">
                        {i > 0 && (
                          <span
                            aria-hidden="true"
                            style={{
                              width: 18,
                              height: 1,
                              background: done || active ? 'hsl(var(--primary) / 0.5)' : 'hsl(var(--border))',
                            }}
                          />
                        )}
                        <div className="flex items-center gap-1.5">
                          <span
                            className="inline-flex items-center justify-center rounded-full"
                            style={{
                              width: 16,
                              height: 16,
                              fontSize: 9.5,
                              background: active || done ? 'hsl(var(--primary))' : 'rgb(var(--glass-tint) / 0.6)',
                              color: active || done ? '#fff' : 'hsl(var(--muted-foreground))',
                              border: active || done ? 'none' : '0.5px solid hsl(var(--border) / 0.8)',
                            }}
                          >
                            {done ? <Check size={10} strokeWidth={3} /> : s.n}
                          </span>
                          <span
                            style={{
                              fontSize: 10.5,
                              fontWeight: active ? 600 : 400,
                              color: active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                            }}
                          >
                            {s.label}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* ---- 第一步：开书设定 ---- */}
                {aiStep === 'brief' && (
                  <>
                    <div>
                      <label style={labelStyle}>书名 {req}</label>
                      <input
                        type="text"
                        value={title}
                        onChange={(e) => { setTitle(e.target.value); setError(''); }}
                        onFocus={() => setFocusedField('title')}
                        onBlur={() => setFocusedField(null)}
                        placeholder="输入书名"
                        style={fieldStyle('title')}
                        autoFocus
                      />
                    </div>

                    <div>
                      <label style={labelStyle}>开局 {req}</label>
                      <textarea
                        value={opening}
                        onChange={(e) => { setOpening(e.target.value); setError(''); }}
                        onFocus={() => setFocusedField('opening')}
                        onBlur={() => setFocusedField(null)}
                        placeholder="故事从哪一刻切入？例如：主角在末日前三小时醒来，手机里收到一条自己发来的短信"
                        rows={3}
                        style={{ ...fieldStyle('opening'), resize: 'vertical', minHeight: 68 }}
                      />
                    </div>

                    <div>
                      <label style={labelStyle}>世界观 {req}</label>
                      <textarea
                        value={worldview}
                        onChange={(e) => { setWorldview(e.target.value); setError(''); }}
                        onFocus={() => setFocusedField('worldview')}
                        onBlur={() => setFocusedField(null)}
                        placeholder="时代、舞台与力量规则。例如：近未来沿海都市，丧尸爆发后第三年，电力系统靠旧水电站维持"
                        rows={3}
                        style={{ ...fieldStyle('worldview'), resize: 'vertical', minHeight: 68 }}
                      />
                    </div>

                    <div>
                      <label style={labelStyle}>笔风基调 {req}</label>
                      <input
                        type="text"
                        value={style}
                        onChange={(e) => { setStyle(e.target.value); setError(''); }}
                        onFocus={() => setFocusedField('style')}
                        onBlur={() => setFocusedField(null)}
                        placeholder="例如：冷硬克制，短句为主，少用形容词"
                        style={fieldStyle('style')}
                      />
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-5)' }}>
                      <div>
                        <label style={labelStyle}>主角姓名 {req}</label>
                        <input
                          type="text"
                          value={protagonist}
                          onChange={(e) => { setProtagonist(e.target.value); setError(''); }}
                          onFocus={() => setFocusedField('protagonist')}
                          onBlur={() => setFocusedField(null)}
                          placeholder="例如：陈默"
                          style={fieldStyle('protagonist')}
                        />
                      </div>

                      {/* 单女主：一个输入框 */}
                      {!multiHeroine && (
                        <div>
                          <label style={labelStyle}>女主姓名 {req}</label>
                          <input
                            type="text"
                            value={heroines[0] ?? ''}
                            onChange={(e) => {
                              const v = e.target.value;
                              setHeroines(prev => [v, ...prev.slice(1)]);
                              setError('');
                            }}
                            onFocus={() => setFocusedField('heroine-0')}
                            onBlur={() => setFocusedField(null)}
                            placeholder="例如：苏晚"
                            style={fieldStyle('heroine-0')}
                          />
                        </div>
                      )}
                    </div>

                    {/* 是否多女主 —— 打开后展开可增删的姓名列表 */}
                    <div
                      className="rounded-xl"
                      style={{
                        padding: 'var(--space-4) var(--space-5)',
                        background: 'rgb(var(--glass-tint) / 0.35)',
                        border: '0.5px solid hsl(var(--border) / 0.6)',
                      }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div style={{ fontSize: 11.5, fontWeight: 500, color: 'hsl(var(--foreground))' }}>
                            是否多女主
                          </div>
                          <div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', marginTop: 'var(--space-0)' }}>
                            {multiHeroine
                              ? `已展开名单，可增删 —— 当前 ${cleanHeroines().length} 位`
                              : '关闭时只填一位女主'}
                          </div>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={multiHeroine}
                          aria-label="是否多女主"
                          onClick={() => {
                            const next = !multiHeroine;
                            setMultiHeroine(next);
                            setError('');
                            if (!next) setHeroines(prev => [prev[0] ?? '']);
                          }}
                          style={{
                            position: 'relative',
                            flexShrink: 0,
                            width: 44,
                            height: 24,
                            borderRadius: 'var(--r-pill)',
                            border: 'none',
                            cursor: 'pointer',
                            background: multiHeroine
                              ? 'linear-gradient(160deg, hsl(var(--primary)), hsl(var(--primary) / 0.78))'
                              : 'hsl(var(--border) / 0.9)',
                            boxShadow: multiHeroine
                              ? '0 2px 10px hsl(var(--primary) / 0.3), inset 0 1px 0 rgb(var(--glass-highlight) / 0.5)'
                              : 'inset 0 1px 2px hsl(var(--glass-shadow) / 0.15)',
                            transition: 'background 0.25s, box-shadow 0.25s',
                          }}
                        >
                          <span
                            aria-hidden="true"
                            style={{
                              position: 'absolute',
                              top: 3,
                              left: 3,
                              width: 18,
                              height: 18,
                              borderRadius: '50%',
                              background: '#fff',
                              boxShadow: '0 1px 3px hsl(var(--glass-shadow) / 0.35)',
                              transform: multiHeroine ? 'translateX(20px)' : 'translateX(0)',
                              transition: 'transform 0.28s cubic-bezier(0.34, 1.4, 0.64, 1)',
                            }}
                          />
                        </button>
                      </div>

                      {multiHeroine && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
                          {heroines.map((h, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <span
                                className="shrink-0 inline-flex items-center justify-center rounded-full"
                                style={{
                                  width: 20,
                                  height: 20,
                                  fontSize: 9.5,
                                  color: 'hsl(var(--muted-foreground))',
                                  background: 'rgb(var(--glass-tint) / 0.6)',
                                  border: '0.5px solid hsl(var(--border) / 0.7)',
                                }}
                                aria-hidden="true"
                              >
                                {i + 1}
                              </span>
                              <input
                                type="text"
                                value={h}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setHeroines(prev => prev.map((x, idx) => (idx === i ? v : x)));
                                  setError('');
                                }}
                                onFocus={() => setFocusedField(`heroine-${i}`)}
                                onBlur={() => setFocusedField(null)}
                                placeholder={`第 ${i + 1} 位女主姓名`}
                                style={{ ...fieldStyle(`heroine-${i}`), flex: 1 }}
                              />
                              <button
                                type="button"
                                onClick={() => setHeroines(prev => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)))}
                                disabled={heroines.length <= 1}
                                title={heroines.length <= 1 ? '至少保留一位' : '删除这一位'}
                                aria-label={`删除第 ${i + 1} 位女主`}
                                className="shrink-0 inline-flex items-center justify-center rounded-lg"
                                style={{
                                  width: 30,
                                  height: 30,
                                  borderWidth: '0.5px',
                                  borderStyle: 'solid',
                                  borderColor: 'hsl(var(--border) / 0.7)',
                                  background: 'transparent',
                                  color: heroines.length <= 1 ? 'hsl(var(--muted-foreground) / 0.4)' : 'hsl(var(--destructive))',
                                  cursor: heroines.length <= 1 ? 'not-allowed' : 'pointer',
                                }}
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => setHeroines(prev => [...prev, ''])}
                            className="self-start inline-flex items-center gap-1 rounded-full"
                            style={{
                              padding: 'var(--space-2) var(--space-5)',
                              fontSize: 10.5,
                              color: 'hsl(var(--primary))',
                              background: 'hsl(var(--primary) / 0.1)',
                              borderWidth: '0.5px',
                              borderStyle: 'solid',
                              borderColor: 'hsl(var(--primary) / 0.3)',
                              cursor: 'pointer',
                            }}
                          >
                            <Plus size={12} strokeWidth={2.5} />
                            添加一位女主
                          </button>
                        </div>
                      )}
                    </div>

                    {error && (
                      <p style={{ fontSize: 11, color: 'hsl(var(--destructive))', margin: 0 }}>
                        {error}
                      </p>
                    )}

                    <p style={{ fontSize: 10, lineHeight: 1.6, color: 'hsl(var(--muted-foreground))', margin: 0 }}>
                      这些设定会被注入每一章的讨论：设计角色与写作官都会按它来，不用每章重述。
                    </p>
                  </>
                )}

                {/* ---- 第二步：流派选择 ---- */}
                {aiStep === 'genre' && (
                  <>
                    {/* 两大分类 */}
                    <div
                      role="radiogroup"
                      aria-label="流派分类"
                      style={{
                        position: 'relative',
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        padding: 'var(--space-1)',
                        borderRadius: 'var(--r-pill)',
                        background: 'rgb(var(--glass-tint) / 0.45)',
                        border: '0.5px solid hsl(var(--border) / 0.6)',
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          position: 'absolute',
                          top: 'var(--space-1)',
                          bottom: 'var(--space-1)',
                          left: 'var(--space-1)',
                          width: 'calc(50% - var(--space-1))',
                          borderRadius: 'var(--r-pill)',
                          background: 'linear-gradient(160deg, hsl(var(--primary)), hsl(var(--primary) / 0.78))',
                          boxShadow: '0 2px 10px hsl(var(--primary) / 0.32)',
                          transform: genreCategory === 'none' ? 'translateX(100%)' : 'translateX(0)',
                          transition: 'transform 0.32s cubic-bezier(0.34, 1.4, 0.64, 1)',
                        }}
                      />
                      {GENRE_CATEGORIES.map((cat) => {
                        const active = genreCategory === cat.key;
                        return (
                          <button
                            key={cat.key}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => { setGenreCategory(cat.key); setError(''); }}
                            style={{
                              position: 'relative',
                              zIndex: 1,
                              padding: 'var(--space-3) 0',
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                              fontSize: 12,
                              fontWeight: 500,
                              color: active ? '#fff' : 'hsl(var(--muted-foreground))',
                              transition: 'color 0.2s',
                            }}
                          >
                            {cat.label}
                          </button>
                        );
                      })}
                    </div>

                    <p style={{ fontSize: 10, lineHeight: 1.6, color: 'hsl(var(--muted-foreground))', margin: 0 }}>
                      {getGenreCategory(genreCategory).desc}
                    </p>

                    {/* 分组流派清单（单选） */}
                    <div
                      style={{
                        maxHeight: 'min(46vh, 420px)',
                        overflowY: 'auto',
                        paddingRight: 'var(--space-1)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 'var(--space-5)',
                      }}
                    >
                      {getGenreCategory(genreCategory).groups.map((g) => (
                        <div key={g.group}>
                          <div style={{
                            fontSize: 10,
                            letterSpacing: '0.08em',
                            color: 'hsl(var(--muted-foreground))',
                            marginBottom: 'var(--space-2)',
                          }}>
                            {g.group}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {g.options.map((opt) => {
                              const active = genre === opt;
                              return (
                                <button
                                  key={opt}
                                  type="button"
                                  aria-pressed={active}
                                  onClick={() => { setGenre(opt); setError(''); }}
                                  className="rounded-full"
                                  style={{
                                    padding: 'var(--space-2) var(--space-4)',
                                    fontSize: 11,
                                    cursor: 'pointer',
                                    color: active ? '#fff' : 'hsl(var(--foreground) / 0.8)',
                                    background: active
                                      ? 'hsl(var(--primary) / 0.92)'
                                      : 'rgb(var(--glass-tint) / 0.5)',
                                    border: active
                                      ? '0.5px solid hsl(var(--primary))'
                                      : '0.5px solid hsl(var(--border) / 0.7)',
                                    boxShadow: active ? '0 2px 10px hsl(var(--primary) / 0.28)' : 'none',
                                    transition: 'background 0.18s, color 0.18s, box-shadow 0.18s',
                                  }}
                                >
                                  {opt}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* 兜底：清单里没有就自己填 */}
                    <div>
                      <label style={{ ...labelStyle, marginBottom: 'var(--space-1)' }}>
                        其他流派（清单里没有？自己填一个）{req}
                      </label>
                      <input
                        type="text"
                        value={genre}
                        onChange={(e) => { setGenre(e.target.value); setError(''); }}
                        onFocus={() => setFocusedField('genre')}
                        onBlur={() => setFocusedField(null)}
                        placeholder="也可以直接点上面的标签，或在这里写你自己的细分类型"
                        style={fieldStyle('genre')}
                      />
                    </div>

                    {error && (
                      <p style={{ fontSize: 11, color: 'hsl(var(--destructive))', margin: 0 }}>
                        {error}
                      </p>
                    )}

                    {genre.trim() && (
                      <p style={{ fontSize: 10.5, color: 'hsl(var(--muted-foreground))', margin: 0 }}>
                        将创建为：<span style={{ color: 'hsl(var(--primary))' }}>{formatGenreLabel(genreCategory, genre)}</span>
                      </p>
                    )}
                  </>
                )}
              </>
            )}
          </div>

          {/* Buttons —— 固定不滚动，永远看得见（字段区再长也不会把它顶出去） */}
          <div style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-4)',
            marginTop: 'var(--space-7)',
          }}>
            {/* AI 向导：第二步给一个「上一步」，别让作者只能关掉重来 */}
            {isAuto && aiStep === 'genre' && (
              <button
                type="button"
                onClick={() => { setAiStep('brief'); setError(''); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-1)',
                  padding: 'var(--space-3) var(--space-5)',
                  borderRadius: 'var(--r-pill)',
                  borderWidth: '0.5px',
                  borderStyle: 'solid',
                  borderColor: 'hsl(var(--border) / 0.6)',
                  background: 'rgb(var(--glass-tint) / 0.5)',
                  color: 'hsl(var(--foreground))',
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                <ChevronLeft size={14} />
                上一步
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="addbook-modal-cancel"
              style={{
                marginLeft: 'auto',
                padding: 'var(--space-3) var(--space-6)',
                borderRadius: 'var(--r-pill)',
                // ★ 拆长写：`border` 简写会重置 border-image 相关长写属性
                //   （2026-09-18 由弹窗扫描抓出）
                borderWidth: '0.5px',
                borderStyle: 'solid',
                borderColor: 'hsl(var(--border) / 0.6)',
                background: 'rgb(var(--glass-tint) / 0.5)',
                backdropFilter: 'blur(12px) saturate(150%)',
                WebkitBackdropFilter: 'blur(12px) saturate(150%)',
                color: 'hsl(var(--foreground))',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'background 0.2s, border-color 0.2s, transform 0.2s',
                boxShadow: 'inset 0 1px 0 rgb(var(--glass-highlight) / 0.5)',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'rgb(var(--glass-tint) / 0.7)';
                e.currentTarget.style.borderColor = 'hsl(var(--border) / 0.9)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'rgb(var(--glass-tint) / 0.5)';
                e.currentTarget.style.borderColor = 'hsl(var(--border) / 0.6)';
              }}
            >
              取消
            </button>

            {/* 主按钮：**始终 type="submit"**，行为由 handleSubmit 按当前步骤分流。
                ★ 别写成「两个分支各渲染一个不同的按钮」：点击的默认动作在 React 同步换完 DOM
                  之后才执行，Chrome 会按**换上去的那个节点**解析 —— 于是点「下一步」会连带提交表单，
                  刚进第二步就冒「请选择一个流派」并弹回第一步（实测事件序列：
                  click:下一步 → submit 表单，间隔 39ms）。按钮类型保持不变，这个坑就不存在。 */}
            <button
              type="submit"
              className="nm-btn-apple-primary"
              style={{ width: isAuto && aiStep === 'brief' ? 96 : 80, height: 34, padding: 0, fontSize: 12 }}
              disabled={isSubmitting}
            >
              {isAuto && aiStep === 'brief' ? (
                <>
                  下一步
                  <ChevronRight size={14} />
                </>
              ) : (
                editBook ? '保存' : '创建'
              )}
            </button>
          </div>
        </form>

        <style>{`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    </div>
  );
}
