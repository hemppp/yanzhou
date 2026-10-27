import { AlertCircle, Check, ChevronDown, ChevronRight, Loader2, Minus } from 'lucide-react';
import { useState } from 'react';
import { Collapse } from './Signal';
import { cn, TONE_TEXT, type SignalTone } from './utils';

/**
 * 任务行（Task Row）—— 实时展示 Agent 的一条任务及其状态。
 *
 * 该库的做法：每行 44px 高（也是舒服的触控尺寸），左侧一列 24px 放状态点，
 * 点之间用一根 1px 墨线连起来，形成"进度轨"。
 *
 * 为什么不做成卡片：多智能体流水线一次会跑 6–10 步，
 * 卡片会让面板被撑爆；行式布局能在同样高度里多塞一倍信息。
 */

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'skipped';

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  /** 右对齐的元信息，如「3 步 · 4.2s」。数字请自带单位，这里只负责等宽对齐。 */
  meta?: string;
  /** 展开后的细节 */
  detail?: string;
  substeps?: TaskItem[];
}

const STATUS_TONE: Record<TaskStatus, SignalTone> = {
  pending: 'idle',
  running: 'run',
  done: 'done',
  failed: 'stop',
  blocked: 'warn',
  skipped: 'idle',
};

const STATUS_TEXT: Record<TaskStatus, string> = {
  pending: '待开始',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  blocked: '受阻',
  skipped: '已跳过',
};

function StatusGlyph({ status }: { status: TaskStatus }) {
  const tone = STATUS_TONE[status];
  if (status === 'running') {
    return <Loader2 size={12} className={cn(TONE_TEXT[tone], 'animate-spin')} aria-hidden="true" />;
  }
  if (status === 'done') return <Check size={12} className={TONE_TEXT[tone]} aria-hidden="true" />;
  if (status === 'failed') return <AlertCircle size={12} className={TONE_TEXT[tone]} aria-hidden="true" />;
  if (status === 'skipped') return <Minus size={12} className={TONE_TEXT[tone]} aria-hidden="true" />;
  // pending / blocked：一个空心墨圈，最轻的视觉重量
  return (
    <span
      className={cn('block size-[7px] rounded-full bg-paper shadow-hairline', status === 'blocked' && 'bg-sig-warn-tint')}
      aria-hidden="true"
    />
  );
}

export function TaskRow({
  task,
  /** 是不是最后一个 —— false 时向下画连接线 */
  connected = true,
  className,
}: {
  task: TaskItem;
  connected?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(task.detail?.trim()) || Boolean(task.substeps?.length);
  const tone = STATUS_TONE[task.status];

  return (
    <div className={className}>
      <div className="grid grid-cols-[24px_minmax(0,1fr)]">
        {/* 左列：状态点 + 连接线 */}
        <div className="relative flex justify-center">
          {connected && (
            <span className="absolute bottom-0 left-1/2 top-[26px] w-px -translate-x-1/2 bg-paper-line" aria-hidden="true" />
          )}
          <span className="relative z-10 flex h-[26px] items-center justify-center">
            <StatusGlyph status={task.status} />
          </span>
        </div>

        {/* 右列：标题 + 元信息 */}
        <button
          type="button"
          onClick={() => hasDetail && setOpen((v) => !v)}
          disabled={!hasDetail}
          aria-expanded={hasDetail ? open : undefined}
          className={cn(
            'mc-press flex min-h-[44px] w-full items-center gap-2 rounded-card px-2 text-left',
            'transition-colors duration-150 ease-out',
            hasDetail ? 'hover:bg-paper-inset mc-focus' : 'cursor-default',
          )}
        >
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block truncate text-[11.5px] leading-tight',
                task.status === 'pending' || task.status === 'skipped' ? 'text-tone-2' : 'font-medium text-tone',
              )}
            >
              {task.title}
            </span>
            {task.meta && <span className="mc-num mt-0.5 block truncate text-[10px] text-tone-3">{task.meta}</span>}
          </span>

          <span className={cn('mc-num shrink-0 text-[10px]', task.status === 'pending' || task.status === 'skipped' ? 'text-tone-3' : TONE_TEXT[tone])}>
            {STATUS_TEXT[task.status]}
          </span>

          {hasDetail && (
            <span className="shrink-0 text-tone-3" aria-hidden="true">
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          )}
        </button>
      </div>

      {hasDetail && (
        <Collapse open={open}>
          <div className="grid grid-cols-[24px_minmax(0,1fr)] pb-1">
            <span className="flex justify-center" aria-hidden="true">
              <span className="w-px bg-paper-line" />
            </span>
            <div className="pl-2">
              {task.detail && (
                <div className="whitespace-pre-wrap break-words rounded-card bg-paper-inset px-2.5 py-2 text-[10.5px] leading-relaxed text-tone-2">
                  {task.detail}
                </div>
              )}
              {task.substeps?.length ? (
                <div className="mt-1">
                  {task.substeps.map((sub, i) => (
                    <TaskRow key={sub.id} task={sub} connected={i < task.substeps!.length - 1} />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </Collapse>
      )}
    </div>
  );
}

/** 一组任务，自动处理最后一行的连接线收尾。 */
export function TaskList({ tasks, className }: { tasks: TaskItem[]; className?: string }) {
  return (
    <div className={cn('w-full', className)} role="list" aria-label="任务进度">
      {tasks.map((t, i) => (
        <div key={t.id} role="listitem">
          <TaskRow task={t} connected={i < tasks.length - 1} />
        </div>
      ))}
    </div>
  );
}
