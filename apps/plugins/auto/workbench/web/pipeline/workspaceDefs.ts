// ============================================================
// 分页工作区的公共定义（AI 写作模式专用）
//
// 为什么单独一个文件：气泡列、标签栏、分页区三处都要用同一份类型与尺寸常量，
// 散着写必然漂移（正文最小宽在一个文件里是 480、另一个文件里是 460，这种 bug 最难查）。
// ============================================================

import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';

// 各面板需要的实时 props 不一样（本章计划要 conclusion/stages、实体栏只要 projectId），
// 宿主统一从一份 `panelProps` 里按需取，这里用宽松签名收口 —— 与 ProjectLayout 对插件面板的做法一致。
export type PanelComponent = ComponentType<any>;

/**
 * 工作台面板定义。
 *
 * 注意与插件的 `FloatingPanelDef` 的区别：
 *   · 插件的面板（角色/地点/大纲…）由 `registerProjectPanel` 注册，渲染时**不接 props**
 *   · 这里的面板需要宿主把**实时状态**绑进去（本章计划要 conclusion/stages、实体栏要 projectId）
 * 所以 AI 模式用这套自带定义，而不是复用插件注册表 —— 也正好守住「AI 模式不挂手写面板」的既有约定。
 */
export interface WorkbenchPanel {
  key: string;
  label: string;
  icon: LucideIcon;
  /** 'live' = 写作中（实时运转的数据）/ 'data' = 资料 */
  group: 'live' | 'data';
  Component: PanelComponent;
}

/** 正文主视图的最小宽 —— 低于它就把分页区挪到下方（**任何情况都不覆盖正文**） */
export const BODY_MIN_WIDTH = 480;
/** 正文外框左右内边距合计。★ 布局预算必须带上它：漏算的话正文会实测比 BODY_MIN_WIDTH 还窄
 *  （实测过：阈值按 504 判定"放得下"，正文实测 472） */
export const BODY_PAD_X = 32;
/** 气泡列宽（= 气泡直径 30 + 两侧留白；改这里要同步 BubbleRail 里的气泡尺寸） */
export const RAIL_WIDTH = 44;
/** AI 交流栏在被让位时的最小宽 */
export const AI_MIN_WIDTH = 240;

/** 分页区在下方时的尺寸范围 */
export const PANE_H_MIN = 200;
export const PANE_H_MAX = 560;
export const PANE_H_DEFAULT = 300;

/** 右栏模式默认宽（与 workspaceStore 的取值范围一致） */
export const PANE_W_DEFAULT = 420;

/**
 * 空间紧张时允许把侧组压到多窄。
 * ★ 作者明确要求「点击气泡是在**正文旁边**打开页面」——所以宁可压窄侧组、也别把它甩到下方角落。
 *   低于这个宽度就真的不好用了，那时才退回"落到下方"（仍不覆盖正文）。
 */
export const PANE_W_MIN_SOFT = 280;

/** 正文的"软"最小宽：极窄时允许正文窄到这个数，换取"面板仍在旁边" */
export const BODY_MIN_SOFT = 400;

/**
 * 编辑器区底色。
 * ★ 单一来源：标签栏里**激活标签**的底色必须与它一致，才能"连成一片"（VSCode 的观感）。
 *   两处各写一个色值必然漂移（这个坑当天已经踩过一次：正文最小宽预算）。
 *
 * ★ 2026-09-16 0.9 → 0.72：让水墨背景在正文区透出来。
 *
 *   为什么必须降（实测）：`--card` 是 #fcfcfc，0.9 不透明度压在 AmbientBackdrop 的
 *   #f5f5f5 宣纸底上，合成 ≈ rgb(251)，与纯白只差 4 级 —— 等于给整幅山水盖了层白纸。
 *   取证方式：把 .ambient-backdrop 的 filter 拉到 contrast(6) 给背景"打光"，
 *   页面各处的竹叶/飞白/溅墨全都跳出来了，**唯独正文区那块仍是纯白**，一点不剩。
 *   改成 0.72 后同一位置叶片重新可见（呈浅灰、似有若无）。
 *
 *   为什么是 0.72 而不是 transparent：正文是长时间阅读区，山水太浓会干扰阅读；
 *   且 0.72 保留了三处分区（标签栏 / 正文 / 看板）之间那层极淡的底差，
 *   分区感不只靠边框撑。合成色 250 vs 245 肉眼几不可辨，真正的差别是
 *   **图案的可见与不可见**。
 */
export const EDITOR_BG = 'hsl(var(--card) / 0.72)';
