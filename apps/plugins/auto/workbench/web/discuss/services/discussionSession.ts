// ============================================================
// 讨论回看 —— 前端客户端
//
// 对接插件路由：`GET /api/plugins/autowrite/pipeline/turns?stage=<段>|chapter=<章号>`
//
// 干什么用：讨论**早就落库了**（agent_memory 的 `exp.stage.<段>.turn<N>`），
// 但一直只有实时 SSE 能看到 —— 跑完就没了。脚本跑的书（run-novel.mjs）更是从头到尾
// 没人看见讨论过程。这条面把它捞回来给作者看：**剧情到底是谁、怎么讨论出来的**。
// ============================================================

import { apiClient } from '@novel-plugins/data-core/api/apiClient';

export interface DiscussionTurn {
  /** 角色 id（如 plot-designer） */
  agent: string;
  name: string;
  short: string;
  color: string;
  /** 本轮第几条发言（1 起）——决定展示顺序 */
  turn: number;
  text: string;
  at: number;
}

export interface DiscussionScope {
  stage: string | null;
  chapter: number | null;
}

export interface DiscussionView {
  scope: DiscussionScope;
  turns: DiscussionTurn[];
}

/** 取某段（stage）或某章（chapter）的逐条发言；二者给一个。 */
export async function fetchDiscussion(
  q: { stage?: string; chapter?: number },
): Promise<DiscussionView> {
  const params: Record<string, string> = {};
  if (q.stage) params.stage = q.stage;
  if (q.chapter != null) params.chapter = String(q.chapter);
  return apiClient.get<DiscussionView>('plugins/autowrite/pipeline/turns', params);
}
