// ============================================================
// WorkbenchMissing — 工作台未安装占位（kernel 壳）
//
// 三层拆分后，工作台根组件由各模块经 ctx.registerWorkbench 注册
// （manual → 手写台，auto → AI 写作台）。当某模式对应的模块被关闭 /
// 分离（未注册工作台）时，kernel 渲染本占位而非报错或空白 —— 保证
// 「关闭任一模块后另一模块仍完全可用」时，被移除的那侧有明确提示。
// ============================================================

import { ArrowLeft, Puzzle } from 'lucide-react';
import type { ProjectMode } from '@novel/core/web';

export interface WorkbenchMissingProps {
  /** 缺失工作台对应的创作模式（用于文案区分） */
  mode?: ProjectMode;
  /**
   * ★ 用户口径（m04040）：「点击 UI 之后要有一个小返回键」。
   *   auto 分支在渲染顶栏之前就提前 return（见 ProjectLayout 的 `mode === 'auto'` 分支），
   *   这条路径上没有任何顶栏返回入口 —— 占位自己必须提供一个。
   */
  onBack?: () => void;
}

const MODE_LABEL: Record<string, string> = {
  manual: '手写台',
  auto: 'AI 写作台',
};

export function WorkbenchMissing({ mode, onBack }: WorkbenchMissingProps) {
  const label = mode ? MODE_LABEL[mode] ?? '工作台' : '工作台';
  return (
    <div
      className="relative h-full w-full flex flex-col items-center justify-center gap-3 px-6 text-center"
      role="status"
      aria-label="工作台未安装"
    >
      {/* ★ 小返回键（m04040）：与外壳顶栏的返回键同款，固定在外框左上角 */}
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="nm-btn-apple-icon-sm absolute left-2 top-2"
          title="返回书架"
          aria-label="返回书架"
        >
          <ArrowLeft size={15} aria-hidden="true" />
        </button>
      ) : null}
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center"
        style={{ background: 'rgba(120,120,128,0.12)' }}
      >
        <Puzzle size={26} style={{ color: '#aeaeb2' }} />
      </div>
      <div className="text-[14px] font-medium" style={{ color: 'var(--nm-text-primary, #1d1d1f)' }}>
        {label}未安装
      </div>
      <div className="text-[12px] max-w-[280px]" style={{ color: '#8e8e93' }}>
        该创作模式对应的模块未启用。启用后刷新即可使用。
      </div>
    </div>
  );
}

export default WorkbenchMissing;
