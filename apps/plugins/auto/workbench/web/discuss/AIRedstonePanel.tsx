import { useAIRedstoneStore } from '../../stores/aiRedstoneStore';
import type { AIFeature } from '../../stores/aiRedstoneStore';
import {
  Snowflake,
  MessageSquare,
  ScanLine,
  ShieldCheck,
  Palette,
  Power,
  PowerOff,
  Radar,
  Drama,
  Activity,
  Zap,
} from 'lucide-react';

const FEATURE_CONFIG: Record<AIFeature, { label: string; icon: React.ReactNode; description: string }> = {
  chat: {
    label: 'AI 对话',
    icon: <MessageSquare size={16} />,
    description: '与 AI 助手对话讨论创作',
  },
  extract: {
    label: '实体提取',
    icon: <ScanLine size={16} />,
    description: '后台轮询扫描最新章节，自动识别角色、地点、物品',
  },
  scanner: {
    label: '章节扫描',
    icon: <Radar size={16} />,
    description: '编辑章节时实时扫描，自动提取角色/物品/地点/时间线',
  },
  consistency: {
    label: '一致性检查',
    icon: <ShieldCheck size={16} />,
    description: '检测剧情、角色设定冲突',
  },
  style: {
    label: '风格分析',
    icon: <Palette size={16} />,
    description: '分析写作风格并提供指导',
  },
  rhythm: {
    label: '节奏分析',
    icon: <Activity size={16} />,
    description: '分析章节叙事节奏，给出快慢建议',
  },
  timeline: {
    label: '时间线分析',
    icon: <ScanLine size={16} />,
    description: '分析时间线事件并发掘剧情缺口',
  },
  plot: {
    label: '剧情生成',
    icon: <Drama size={16} />,
    description: 'AI 生成角色设定与剧情走向',
  },
  'quick-phrases': {
    label: '快捷短语',
    icon: <Zap size={16} />,
    description: '常用写作短语快速插入',
  },
};

interface AIRedstonePanelProps {
  open?: boolean;
  onClose?: () => void;
}

export function AIRedstonePanel({ open }: AIRedstonePanelProps) {
  const { features, allFrozen, toggleFeature, freezeAll, unfreezeAll } = useAIRedstoneStore();

  if (!open) return null;

  const featureEntries = Object.entries(FEATURE_CONFIG) as [AIFeature, typeof FEATURE_CONFIG[AIFeature]][];

  return (
    <div className="absolute right-4 top-14 z-50 w-80 rounded-2xl border bg-background shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30 rounded-t-lg">
        <div className="flex items-center gap-2">
          <Snowflake size={18} className="text-primary" />
          <span className="font-semibold text-sm">AI 功能开关</span>
        </div>

        {/* Global Toggle */}
        <button
          onClick={() => (allFrozen ? unfreezeAll() : freezeAll())}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-medium transition-all ${
            allFrozen
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
          }`}
          title={allFrozen ? '全部解冻' : '全部冻结'}
        >
          {allFrozen ? (
            <>
              <Power size={12} />
              全部开启
            </>
          ) : (
            <>
              <PowerOff size={12} />
              全部冻结
            </>
          )}
        </button>
      </div>

      {/* Feature List */}
      <div className="p-3 space-y-1 max-h-[400px] overflow-y-auto">
        {featureEntries.map(([feature, config]) => (
          <div
            key={feature}
            className={`flex items-center justify-between px-3 py-2.5 rounded-md transition-colors hover:bg-muted/50 ${
              !features[feature] ? 'opacity-50' : ''
            }`}
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className={`shrink-0 ${features[feature] ? 'text-primary' : 'text-muted-foreground'}`}>
                {config.icon}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{config.label}</div>
                <div className="text-xs text-muted-foreground truncate">{config.description}</div>
              </div>
            </div>

            {/* Individual Toggle */}
            <button
              onClick={() => toggleFeature(feature)}
              role="switch"
              aria-checked={features[feature]}
              aria-label={`切换${config.label}`}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                features[feature]
                  ? 'bg-primary'
                  : 'bg-input'
              }`}
            >
              <span
                className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${
                  features[feature] ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t bg-muted/20 rounded-b-lg text-xs text-muted-foreground text-center">
        {allFrozen
          ? '所有 AI 功能已冻结，将不会自动触发'
          : `${Object.values(features).filter(Boolean).length}/${Object.keys(features).length} 个功能已启用`}
      </div>
    </div>
  );
}

/** 触发按钮 - 用于在工具栏中打开面板 */
export function AIRedstoneTrigger({ onClick }: { onClick: () => void }) {
  const { allFrozen } = useAIRedstoneStore();

  return (
    <button
      onClick={onClick}
      className={`relative inline-flex items-center justify-center w-8 h-8 rounded-xl transition-colors hover:bg-muted ${
        allFrozen ? 'text-muted-foreground' : 'text-primary hover:text-primary'
      }`}
      title="AI 功能开关"
      aria-label="打开 AI 功能开关面板"
    >
      <Snowflake size={16} />
      {allFrozen && (
        <span className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-destructive" />
      )}
    </button>
  );
}
