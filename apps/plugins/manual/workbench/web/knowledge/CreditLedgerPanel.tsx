// ============================================================
// 系统积分面板（独立面板）
//
// 系统文的核心数据是「谁有多少积分、系统给过什么」。此前它挂在物品面板里
// 当第二个 tab —— 那有两个问题：
//   ① 找积分得先想到去「物品」里翻，不符合用户的检索直觉；
//   ② 物品面板的顶部控件（自动识别开关）与积分无关，混在一起容易误触。
//
// 现在拆成独立面板，并补上两件只有独立面板才好做的事：
//   · 绑定系统的人物优先排序（没绑定的折叠在后面）—— 系统文里通常只有
//     主角绑定了系统，其余角色不该占同样的视觉权重；
//   · 账目自检：负结余（含中途透支）直接标出来，那是流水记错的第一信号。
// ============================================================

import { useMemo } from 'react';
import { Coins } from 'lucide-react';
import { useCharacterStore, useCreditStore } from '@novel-plugins/data-core/stores';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import { auditCreditLedger } from './creditRecognition';
import { isSystemBound, systemNameOf } from './systemRecognition';
import { CreditLedger } from './CreditLedger';

export function CreditLedgerPanel() {
  const projectId = useCurrentProjectId();
  const characters = useCharacterStore((s) => s.characters);
  const transactions = useCreditStore((s) => s.creditTransactions);

  const projectChars = useMemo(
    () => characters.filter((c) => !projectId || c.projectId === projectId),
    [characters, projectId],
  );
  const projectTransactions = useMemo(
    () => transactions.filter((t) => !projectId || t.projectId === projectId),
    [transactions, projectId],
  );

  // 概览：几个角色有账目、总计透支的角色数
  const overview = useMemo(() => {
    const withLedger = projectChars.filter((c) =>
      projectTransactions.some((t) => t.characterId === c.id),
    );
    const overdrawn = withLedger.filter(
      (c) => auditCreditLedger(projectTransactions, c.id).negativeAtChapters.length > 0,
    );
    const bound = projectChars.filter((c) => isSystemBound(c));
    return { withLedger: withLedger.length, overdrawn: overdrawn.length, bound: bound.length };
  }, [projectChars, projectTransactions]);

  if (!projectId) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-muted-foreground font-medium">请先选择一个项目</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* 顶部：面板标题 + 概览。概览只放「值得一眼看到」的三个数：
          绑定系统的人数、有账目的人数、账目有问题的角色数（后者为 0 时不着色） */}
      <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground tracking-tight flex items-center gap-2">
          <Coins size={14} style={{ color: 'hsl(var(--ochre))' }} />
          系统积分
          <span className="text-[10px] font-normal text-muted-foreground">积分收支 / 系统赠予</span>
        </h2>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>
            绑定系统 <span className="font-semibold text-foreground">{overview.bound}</span>
          </span>
          <span>
            有账目 <span className="font-semibold text-foreground">{overview.withLedger}</span>
          </span>
          {overview.overdrawn > 0 && (
            <span className="text-red-500 font-medium">
              账目异常 {overview.overdrawn}
            </span>
          )}
        </div>
      </div>

      {/* 主体：沿用 CreditLedger 的三栏（人物 / 流水 / 详情表单）。
          它已经处理了「记一笔 / 记赠予 / 编辑 / 删除 / 物品持有联动」，
          这里只负责把它放进独立面板并加一层概览。 */}
      <div className="flex-1 overflow-hidden">
        <CreditLedger systemNameOf={systemNameOf} isSystemBound={isSystemBound} />
      </div>
    </div>
  );
}