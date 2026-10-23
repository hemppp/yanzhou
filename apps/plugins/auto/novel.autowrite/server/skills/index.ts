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

export const CHAT_SKILLS = [
  characterAnalyst,
  foreshadowTracker,
  rhythmDoctor,
  worldbuilder,
  dialoguePolisher,
  plotArchitect,
  continueWriter,
  outlineArchitect,
];
