// ============================================================
// 技能汇总 —— 一技能一文件，此处一行一 export
// 新增技能 = 加一个文件 + 在下面数组加一项
// ============================================================

import { characterAnalyst } from './character-analyst.js';
import { foreshadowTracker } from './foreshadow-tracker.js';
import { rhythmDoctor } from './rhythm-doctor.js';
import { worldbuilder } from './worldbuilder.js';
import { dialoguePolisher } from './dialogue-polisher.js';
import { plotArchitect } from './plot-architect.js';
import { continueWriter } from './continue-writer.js';
import { outlineArchitect } from './outline-architect.js';
import { plotAdvanceReview } from './plot-advance-review.js';
import { voiceDupReview } from './voice-dup-review.js';
// ★ 2026-10-29：从 danjdewhurst/story-skills 提取方法论改写（去掉 CLI/文件系统依赖）
import { sceneOutcome } from './scene-outcome.js';
import { chapterOpening } from './chapter-opening.js';
import { deAiProse } from './de-ai-prose.js';
// ★ 2026-10-31：从 Wooooooooood/ai-fiction-writer 提取方法论改写。
//   统一改写口径：去掉 `.novel/` 文件工作区与文件 I/O；把原版的**硬阻塞**
//   （"不填微逻辑卡不许写正文"）降级为**判据**（真正的门禁在 gate-rules.ts / gates.ts）；
//   去掉写作阶段无法测量的**伪量化权重**（如平台读完率/留存率）。
import { logicPrevention } from './logic-prevention.js';
import { eraAuthenticity } from './era-authenticity.js';
import { chapterQualityAudit } from './chapter-quality-audit.js';
import { fourPerspectiveReview } from './four-perspective-review.js';
import { hookEmotionCurve } from './hook-emotion-curve.js';
import { characterCraft } from './character-craft.js';
import { worldbuildingLayers } from './worldbuilding-layers.js';
import { proseDiscipline } from './prose-discipline.js';

export const CHAT_SKILLS = [
  characterAnalyst,
  foreshadowTracker,
  rhythmDoctor,
  worldbuilder,
  dialoguePolisher,
  plotArchitect,
  continueWriter,
  outlineArchitect,
  // ★ 2026-10-23：监工的两个审阅帮手各带一门**审阅技能**（见 pipeline/supervise-review.ts）
  plotAdvanceReview,
  voiceDupReview,
  // ★ 2026-10-29：从 story-skills 提取的两门方法论技能
  //   · sceneOutcome —— 治「平缓日常章」（场景结局必须是 yes-but / no-and）
  //   · chapterOpening —— 治「开头重复」（enter late，六种起手轮换）
  sceneOutcome,
  chapterOpening,
  // ★ 2026-10-29：去 AI 味（内容体检测出来却没药可开的那个缺口）
  deAiProse,
  // ★ 2026-10-31：从 ai-fiction-writer 提取的 8 门方法论技能，按职责分派到对应智能体
  //   · logicPrevention       → 设定管家（唯一必须查库的角色）
  //   · eraAuthenticity       → 设定管家
  //   · chapterQualityAudit   → 写作监工（交付后逐章巡检，缺的那把尺子）
  //   · fourPerspectiveReview → 写作监工·终审（交付前放行/打回的判据库）
  //   · hookEmotionCurve      → 剧情设计师
  //   · characterCraft        → 角色设计师
  //   · worldbuildingLayers   → 策划官
  //   · proseDiscipline       → 写作官
  logicPrevention,
  eraAuthenticity,
  chapterQualityAudit,
  fourPerspectiveReview,
  hookEmotionCurve,
  characterCraft,
  worldbuildingLayers,
  proseDiscipline,
];
