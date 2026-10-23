import { useMemo, useEffect, useState } from 'react';
import { useChapterStore } from '@novel-plugins/data-core/stores';
import { LoadingPixels, SignalChip } from '@novel-plugins/ui-kit/primitives';

/**
 * 状态栏 —— 墨韵工艺层改造示范（2026-09-18）
 *
 * 改了什么：
 *   1. 原来整篇是 `style={{ color: 'hsl(var(--muted-foreground))' }}` 内联色。
 *      globals.css 自己写着「表单输入通用类 —— 替代内联 style 的反模式」，
 *      这里正是那类反模式，已全部换成 text-tone / text-tone-2 / text-tone-3 工具类。
 *   2. 数字（字数 / 阅读时长）加 mc-num 等宽对齐 —— 原来字数从 999 跳到 1000 时
 *      整行会横移一格。
 *   3. 「正在读取时间线」原来是一个转圈的 Loader2 + 主色文字；
 *      现改用 SignalChip(run) + 像素网格加载器 —— 这是全站唯一允许出现彩色的位置，
 *      且像素网格比转圈更符合"工序"调性。
 *   4. 分隔符从 `w-px h-3 bg-border/60` 换成一根墨线，粗细与其它面板统一。
 */

function formatRelativeTime(ts: number | undefined | null): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 30_000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const STATUS_TEXT: Record<string, string> = {
  draft: '草稿',
  revised: '已修订',
  final: '已完成',
  archived: '已归档',
};

interface StatusBarProps {
  /** 实时字数（编辑器输入即更新），null 表示未初始化，此时回退到 store 的 chapter.wordCount */
  liveWordCount?: number | null;
  /** 是否正在 AI 扫描时间线 */
  isScanning?: boolean;
}

/** 分隔符：一根 1px 墨线，与全站勾线同粗细 */
function Sep() {
  return <span className="h-3 w-px shrink-0 bg-paper-line" aria-hidden="true" />;
}

export function StatusBar({ liveWordCount, isScanning }: StatusBarProps) {
  // 拆 selector：仅订阅必要字段
  const chapter = useChapterStore((s) =>
    s.currentChapterId ? s.chapters.find((c) => c.id === s.currentChapterId) ?? null : null,
  );

  const display = useMemo(() => {
    if (!chapter) return null;
    return {
      title: chapter.title,
      // liveWordCount 为 null（未初始化）时回退到 store 的 chapter.wordCount
      wordCount: liveWordCount != null ? liveWordCount : chapter.wordCount,
      status: chapter.status,
      updatedAt: chapter.updatedAt,
    };
  }, [chapter, liveWordCount]);

  // 1 分钟刷新一次「相对时间」
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const shell =
    'h-7 nm-statusbar glass-frost fixed bottom-0 left-0 right-0 z-30 flex items-center gap-2 px-3 sm:gap-3 sm:px-4 text-2xs';

  if (!display) {
    return (
      <div className={shell} aria-label="写作状态">
        <span className="text-tone-3">未选择章节</span>
      </div>
    );
  }

  const wordCount = display.wordCount || 0;
  const readMinutes = wordCount === 0 ? 0 : Math.max(1, Math.ceil(wordCount / 300));

  return (
    <div className={shell} aria-label="写作状态">
      <span className="max-w-[140px] truncate font-medium text-tone font-[Noto_Serif_SC,serif] sm:max-w-[260px]">
        {display.title}
      </span>
      <Sep />

      <span className="mc-num shrink-0 text-tone-2">{wordCount.toLocaleString()} 字</span>
      {wordCount > 0 && (
        <span className="mc-num hidden shrink-0 text-tone-3 sm:inline">约 {readMinutes} 分钟</span>
      )}

      <Sep />
      <span className="shrink-0 text-tone-2">{STATUS_TEXT[display.status] ?? '已归档'}</span>

      <span className="flex-1" />

      {isScanning && (
        <>
          <SignalChip tone="run" className="nm-statusbar-secondary shrink-0">
            <LoadingPixels />
            正在读取时间线
          </SignalChip>
          <Sep />
        </>
      )}

      <span className="nm-statusbar-secondary mc-num shrink-0 text-tone-3">
        已自动保存 · {formatRelativeTime(display.updatedAt)}
      </span>
    </div>
  );
}
