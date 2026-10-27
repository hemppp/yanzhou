import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from './utils';

/**
 * 代码块（Code Block）
 *
 * 带行号 + 复制。行号用独立的等宽槽（不是把行号拼进文本），
 * 这样复制出来的内容是干净的代码，不带行号 —— 这是很多实现踩过的坑。
 *
 * diff 模式：行首 `+` / `-` 着色走 sig 令牌（新增=done 色，删除=stop 色），
 * 单色体系下这是极少数允许出现彩色的地方 —— 因为增删必须一眼分清。
 */

export type CodeLineKind = 'add' | 'del' | 'context';

export function CodeBlock({
  code,
  language,
  filename,
  className,
  /** 最大高度，超出滚动。默认不限 */
  maxHeight,
}: {
  code: string;
  language?: string;
  filename?: string;
  className?: string;
  maxHeight?: number;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const lines = useMemo(() => code.replace(/\n$/, '').split('\n'), [code]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, [code]);

  return (
    <figure className={cn('overflow-hidden rounded-card bg-paper shadow-hairline', className)}>
      <figcaption className="flex items-center gap-2 border-b border-paper-line px-2.5 py-1.5">
        {filename && <span className="truncate text-[10.5px] font-medium text-tone-2">{filename}</span>}
        {language && <span className="mc-eyebrow">{language}</span>}
        <button
          type="button"
          onClick={handleCopy}
          title="复制代码"
          aria-label="复制代码"
          className={cn(
            'mc-press mc-focus ml-auto rounded-control p-1 text-tone-3',
            'transition-colors duration-150 ease-out hover:bg-paper-hover hover:text-tone-2',
          )}
        >
          {copied ? (
            <Check size={12} className="text-sig-done" aria-hidden="true" />
          ) : (
            <Copy size={12} aria-hidden="true" />
          )}
        </button>
      </figcaption>

      <div
        className="mc-scroll overflow-auto"
        style={maxHeight ? { maxHeight } : undefined}
      >
        <pre className="m-0 flex min-w-full text-[10.5px] leading-[1.55]">
          {/* 行号槽：select-none，避免被一起选中复制 */}
          <span
            aria-hidden="true"
            className="mc-num shrink-0 select-none border-r border-paper-line bg-paper-inset px-2 py-1.5 text-right text-tone-3"
          >
            {lines.map((_, i) => (
              <span key={i} className="block">
                {i + 1}
              </span>
            ))}
          </span>
          <code className="block flex-1 whitespace-pre px-2.5 py-1.5 font-mono text-tone">
            {lines.map((line, i) => {
              const kind: CodeLineKind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'context';
              return (
                <span
                  key={i}
                  className={cn(
                    'block',
                    kind === 'add' && 'bg-sig-done-tint text-sig-done',
                    kind === 'del' && 'bg-sig-stop-tint text-sig-stop',
                  )}
                >
                  {line || ' '}
                </span>
              );
            })}
          </code>
        </pre>
      </div>
    </figure>
  );
}
