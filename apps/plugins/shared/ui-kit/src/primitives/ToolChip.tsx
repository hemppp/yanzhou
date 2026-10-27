import { useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, Loader2, Wrench } from 'lucide-react';
import { Collapse } from './Signal';
import { cn, TONE_TEXT, type SignalTone } from './utils';

/**
 * 工具调用标签（Tool Chip）
 *
 * 该库的做法：把一次工具调用压成**一行**（图标 + 动词 + 对象名），
 * 而不是像早期实现那样给每条调用开一个气泡框。
 * 理由：一次 Agent 回合常有 5–15 次工具调用，气泡会让对话流碎成一地方块。
 *
 * 结果/错误详情按需展开 —— 默认收起，只在失败时自动展开（失败必须被看见）。
 */

export type ToolStatus = 'calling' | 'success' | 'error';

export interface ToolCallLike {
  id: string;
  name: string;
  status: ToolStatus;
  result?: string;
  entity?: { type: string; action: string; name?: string };
}

const STATUS_TONE: Record<ToolStatus, SignalTone> = {
  calling: 'run',
  success: 'done',
  error: 'stop',
};

export function ToolChip({
  event,
  /** 中文动词，如「生成了角色」——由调用方从工具名映射，原语不猜业务语义 */
  label,
  className,
}: {
  event: ToolCallLike;
  label?: string;
  className?: string;
}) {
  // 失败默认展开：错误被折叠起来等于没报
  const [open, setOpen] = useState(event.status === 'error');
  const tone = STATUS_TONE[event.status];
  const title = label ?? event.name;
  const entityName = event.entity?.name;
  const hasDetail = Boolean(event.result?.trim());

  const Icon = event.status === 'calling' ? Loader2 : event.status === 'error' ? AlertCircle : Wrench;

  const head = (
    <>
      <Icon
        size={12}
        className={cn(TONE_TEXT[tone], event.status === 'calling' && 'animate-spin')}
        aria-hidden="true"
      />
      <span className="text-tone-2">
        {event.status === 'calling' ? `正在${title}…` : event.status === 'error' ? `${title}失败` : `${title}成功`}
      </span>
      {entityName && <span className="truncate font-medium text-tone">{entityName}</span>}
    </>
  );

  return (
    <div className={cn('-mx-1.5 w-fit max-w-full', className)}>
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        disabled={!hasDetail}
        aria-expanded={hasDetail ? open : undefined}
        className={cn(
          'mc-press inline-flex max-w-full items-center gap-1.5 rounded-control px-1.5 py-1',
          'text-[10.5px] transition-colors duration-150 ease-out',
          hasDetail ? 'hover:bg-paper-hover mc-focus' : 'cursor-default',
        )}
      >
        {head}
        {hasDetail && (
          <span className="text-tone-3" aria-hidden="true">
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        )}
      </button>

      {hasDetail && (
        <Collapse open={open} className="mt-0.5">
          <div
            className={cn(
              'mc-scroll ml-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-card',
              'bg-paper-inset px-2.5 py-2 text-[10.5px] leading-relaxed text-tone-2',
            )}
          >
            {event.result}
          </div>
        </Collapse>
      )}
    </div>
  );
}
