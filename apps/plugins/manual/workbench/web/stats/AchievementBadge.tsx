import { Award, Flame, Target, BookOpen, PenTool, TrendingUp, Clock, Star } from 'lucide-react';

export type BadgeId = 
  | 'first_chapter'
  | 'ten_thousand_words'
  | 'fifty_thousand_words'
  | 'hundred_thousand_words'
  | 'seven_day_streak'
  | 'thirty_day_streak'
  | 'all_chapters_outlined'
  | 'character_complete'
  | 'foreshadow_resolved'
  | 'first_export'
  | 'night_owl'
  | 'early_bird';

export interface Achievement {
  id: BadgeId;
  title: string;
  description: string;
  icon: typeof Award;
  color: string;
  bgColor: string;
  unlockedAt?: number;
}

// 所有徽章定义
export const ALL_ACHIEVEMENTS: Achievement[] = [
  { id: 'first_chapter', title: '开篇之作', description: '完成第一个章节', icon: BookOpen, color: 'text-blue-500', bgColor: 'bg-blue-500/10' },
  { id: 'ten_thousand_words', title: '初露锋芒', description: '累计写作达到 1 万字', icon: PenTool, color: 'text-cyan-500', bgColor: 'bg-cyan-500/10' },
  { id: 'fifty_thousand_words', title: '渐入佳境', description: '累计写作达到 5 万字', icon: TrendingUp, color: 'text-teal-500', bgColor: 'bg-teal-500/10' },
  { id: 'hundred_thousand_words', title: '大作已成', description: '累计写作达到 10 万字', icon: Star, color: 'text-amber-500', bgColor: 'bg-amber-500/10' },
  { id: 'seven_day_streak', title: '一周坚持', description: '连续写作 7 天', icon: Flame, color: 'text-orange-500', bgColor: 'bg-orange-500/10' },
  { id: 'thirty_day_streak', title: '月度写手', description: '连续写作 30 天', icon: Flame, color: 'text-red-500', bgColor: 'bg-red-500/10' },
  { id: 'all_chapters_outlined', title: '胸有成竹', description: '所有章节都已关联大纲节点', icon: Target, color: 'text-emerald-500', bgColor: 'bg-emerald-500/10' },
  { id: 'character_complete', title: '人物档案馆', description: '创建 5 个角色档案', icon: Award, color: 'text-violet-500', bgColor: 'bg-violet-500/10' },
  { id: 'foreshadow_resolved', title: '伏笔大师', description: '回收了 3 个伏笔', icon: Award, color: 'text-purple-500', bgColor: 'bg-purple-500/10' },
  { id: 'first_export', title: '初次导出', description: '首次导出项目', icon: BookOpen, color: 'text-pink-500', bgColor: 'bg-pink-500/10' },
  { id: 'night_owl', title: '深夜写手', description: '在凌晨 0-4 点间完成写作', icon: Clock, color: 'text-indigo-500', bgColor: 'bg-indigo-500/10' },
  { id: 'early_bird', title: '早起鸟', description: '在早上 5-7 点间完成写作', icon: Clock, color: 'text-yellow-500', bgColor: 'bg-yellow-500/10' },
];

interface AchievementBadgeProps {
  achievement: Achievement;
  unlocked?: boolean;
}

export function AchievementBadge({ achievement, unlocked = false }: AchievementBadgeProps) {
  const Icon = achievement.icon;
  
  return (
    <div className={`flex flex-col items-center gap-1 p-2 rounded-2xl transition-all ${
      unlocked ? 'opacity-100' : 'opacity-30 grayscale'
    }`}>
      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${achievement.bgColor}`}>
        <Icon size={20} className={achievement.color} />
      </div>
      <span className="text-[10px] font-medium text-center leading-tight">{achievement.title}</span>
    </div>
  );
}
