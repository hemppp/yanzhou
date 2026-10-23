/**
 * @fileoverview PipelinePanel —— 流水线进度与闸门
 *
 * 这个组件之前只有"真机点过一遍"，没有单测。这里补上最容易写歪的几处：
 *   · 状态 → 界面的映射（未启动 / 可跑 / 等确认 / 未实现 / 失败）
 *   · 闸门三态按钮：**打回必须带批注**（没批注时按钮禁用），通过要走 approve
 *   · 落库统计要反馈给作者，并触发宿主刷新
 *   · 基线变更（设定改过）要标"过期"
 *   · 收起态（有章节时默认收起）仍能看出走到哪了
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PipelinePanel } from '../PipelinePanel';
import type { PipelineStageView, PipelineStatus, PipelineView } from '../services/pipelineSession';

const mockFetch = vi.fn();
const mockStart = vi.fn();
const mockDecide = vi.fn();
const mockRun = vi.fn();
const mockToast = vi.fn();

vi.mock('../services/pipelineSession', () => ({
  fetchPipeline: (...a: unknown[]) => mockFetch(...a),
  startPipeline: (...a: unknown[]) => mockStart(...a),
  decidePipeline: (...a: unknown[]) => mockDecide(...a),
  runPipelineStage: (...a: unknown[]) => mockRun(...a),
}));

vi.mock('@novel-plugins/ui-kit/errors', () => ({
  dispatchToastEvent: (...a: unknown[]) => mockToast(...a),
}));

const GATED = ['cast', 'bible', 'plot', 'pilot'];
const IMPLEMENTED = ['brief', 'cast', 'bible', 'plot', 'drift', 'pilot'];

function stage(key: PipelineStageView['key'], label: string, over: Partial<PipelineStageView> = {}): PipelineStageView {
  return {
    key,
    label,
    status: 'idle',
    revision: 0,
    gated: GATED.includes(key),
    implemented: IMPLEMENTED.includes(key),
    ...over,
  };
}

const ALL_STAGES: PipelineStageView[] = [
  stage('brief', '开书信息', { status: 'approved' }),
  stage('cast', '角色与节奏宪章'),
  stage('bible', '世界圣经'),
  stage('plot', '剧情总纲'),
  stage('drift', '偏离核查'),
  stage('pilot', '前三章试写'),
  stage('production', '长跑与监工'),
];

function makeView(over: Partial<PipelineView> = {}): PipelineView {
  return {
    projectId: 'p1',
    stage: 'cast',
    stageLabel: '角色与节奏宪章',
    briefHash: 'h1',
    staleStages: [],
    stages: ALL_STAGES,
    decisions: [],
    reviewEvery: 3,
    lastDelivered: 0,
    updatedAt: 0,
    ...over,
  };
}

function makeStatus(over: Partial<PipelineStatus> = {}): PipelineStatus {
  return { started: true, hasBrief: true, view: makeView(), ...over };
}

function setup(props: Partial<React.ComponentProps<typeof PipelinePanel>> = {}) {
  return render(
    <PipelinePanel projectId="p1" {...props} />,
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  mockStart.mockReset();
  mockDecide.mockReset();
  mockRun.mockReset();
  mockToast.mockReset();
});

describe('PipelinePanel', () => {
  it('未启动：给启动入口，并把成本量级说清楚', async () => {
    mockFetch.mockResolvedValue(makeStatus({ started: false, view: null }));
    setup();
    expect(await screen.findByText('开始立设定')).toBeInTheDocument();
    expect(screen.getByText(/三段设定跑完约 15–20 次模型调用/)).toBeInTheDocument();
    // 未启动时不该出现步进条
    expect(screen.queryByText('长跑与监工')).toBeNull();
  });

  it('没有开书设定：直接告诉作者去哪儿补，不给启动按钮', async () => {
    mockFetch.mockResolvedValue(makeStatus({ started: false, hasBrief: false, view: null }));
    setup();
    expect(await screen.findByText(/还没有开书设定/)).toBeInTheDocument();
    expect(screen.queryByText('开始立设定')).toBeNull();
  });

  it('已启动：步进条 7 段，当前段的按钮带成本提示', async () => {
    mockFetch.mockResolvedValue(makeStatus());
    setup();
    expect(await screen.findByText('角色与节奏宪章')).toBeInTheDocument();
    expect(screen.getByText('偏离核查')).toBeInTheDocument();
    const runBtn = screen.getByRole('button', { name: /跑「角色与节奏宪章」/ });
    expect(runBtn).toHaveAttribute('title', expect.stringContaining('模型调用'));
  });

  it('未实现的段：按钮禁用并明说尚未实现（不假装能跑）', async () => {
    mockFetch.mockResolvedValue(makeStatus({ view: makeView({ stage: 'production' }) }));
    setup();
    const btn = await screen.findByRole('button', { name: /跑「长跑与监工」/ });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/这一段（长跑与监工）尚未实现/)).toBeInTheDocument();
  });

  it('等确认：三态按钮齐备，**打回在没批注时禁用**', async () => {
    mockFetch.mockResolvedValue(makeStatus({
      view: makeView({ stages: ALL_STAGES.map((s) => (s.key === 'cast' ? { ...s, status: 'awaiting_user' as const, artifact: '主角弧光：陈默……' } : s)) }),
    }));
    setup();
    expect(await screen.findByText('通过并落库')).toBeInTheDocument();
    expect(screen.getByText('退回上一段')).toBeInTheDocument();
    expect(screen.getByText('主角弧光：陈默……')).toBeInTheDocument();

    const revise = screen.getByRole('button', { name: /打回重跑/ });
    expect(revise).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/要打回就写清楚哪里不对/), { target: { value: '女主写得太工具人' } });
    await waitFor(() => expect(revise).toBeEnabled());
  });

  it('点打回：带着批注调用 decidePipeline(stage, revise, note)', async () => {
    mockFetch.mockResolvedValue(makeStatus({
      view: makeView({ stages: ALL_STAGES.map((s) => (s.key === 'cast' ? { ...s, status: 'awaiting_user' as const } : s)) }),
    }));
    mockDecide.mockResolvedValue({ view: makeView(), movedTo: 'cast', invalidated: [], stats: null, revisionLimit: 3, hitRevisionLimit: false });
    setup();
    fireEvent.change(await screen.findByPlaceholderText(/要打回就写清楚哪里不对/), { target: { value: '节奏太快' } });
    fireEvent.click(screen.getByRole('button', { name: /打回重跑/ }));
    await waitFor(() => expect(mockDecide).toHaveBeenCalledWith('cast', 'revise', '节奏太快'));
  });

  it('点通过：走 approve，把落库统计反馈给作者并触发宿主刷新', async () => {
    const onProjectDataChanged = vi.fn();
    mockFetch.mockResolvedValue(makeStatus({
      view: makeView({ stages: ALL_STAGES.map((s) => (s.key === 'cast' ? { ...s, status: 'awaiting_user' as const } : s)) }),
    }));
    mockDecide.mockResolvedValue({
      view: makeView({ stage: 'bible' }),
      movedTo: 'bible',
      invalidated: [],
      stats: { characters: { created: 3, updated: 1 }, outline: 0, foreshadows: 0, skipped: 0, notes: [] },
      revisionLimit: 3,
      hitRevisionLimit: false,
    });
    setup({ onProjectDataChanged });
    fireEvent.click(await screen.findByRole('button', { name: /通过并落库/ }));

    await waitFor(() => expect(mockDecide).toHaveBeenCalledWith('cast', 'approve', undefined));
    await waitFor(() => expect(onProjectDataChanged).toHaveBeenCalled());
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('角色 +3') }));
  });

  it('落库有告警时（抽取失败）必须提示出来，不能静默', async () => {
    const onProjectDataChanged = vi.fn();
    mockFetch.mockResolvedValue(makeStatus({
      view: makeView({ stages: ALL_STAGES.map((s) => (s.key === 'cast' ? { ...s, status: 'awaiting_user' as const } : s)) }),
    }));
    mockDecide.mockResolvedValue({
      view: makeView(),
      movedTo: 'bible',
      invalidated: [],
      stats: { characters: { created: 0, updated: 0 }, outline: 0, foreshadows: 0, skipped: 0, notes: ['结构化抽取失败，本次未落库'] },
      revisionLimit: 3,
      hitRevisionLimit: false,
    });
    setup({ onProjectDataChanged });
    fireEvent.click(await screen.findByRole('button', { name: /通过并落库/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', message: expect.stringContaining('未落库') }),
    ));
  });

  it('基线改过：已定稿的段标「过期」，收起态也提醒建议重跑', async () => {
    mockFetch.mockResolvedValue(makeStatus({ view: makeView({ staleStages: ['brief', 'cast'] }) }));
    setup({ hasChapters: true });
    expect(await screen.findByText(/设定已改，建议重跑/)).toBeInTheDocument();
  });

  it('有章节时默认收起，但仍能看出停在哪一段', async () => {
    mockFetch.mockResolvedValue(makeStatus());
    setup({ hasChapters: true });
    // 收起态：只有一条窄条
    expect(await screen.findByText('设定流水线')).toBeInTheDocument();
    expect(screen.getByText(/角色与节奏宪章/)).toBeInTheDocument();
    expect(screen.queryByText('通过并落库')).toBeNull();
  });

  it('最近决策：把批注显示出来（台账不再只是接口）', async () => {
    mockFetch.mockResolvedValue(makeStatus({
      view: makeView({
        stage: 'bible',
        decisions: [
          { stage: 'bible', at: Date.now(), by: 'u1', action: 'revise', note: '势力写得太单薄' },
          { stage: 'brief', at: Date.now() - 86400000, by: 'u1', action: 'approve' },
        ],
      }),
    }));
    setup();
    expect(await screen.findByText('最近决策')).toBeInTheDocument();
    expect(screen.getByText(/势力写得太单薄/)).toBeInTheDocument();
    expect(screen.getByText('打回')).toBeInTheDocument();
  });

  it('跑一段失败会弹错误（不静默）', async () => {
    mockFetch.mockResolvedValue(makeStatus());
    mockRun.mockRejectedValue(new Error('HTTP 500'));
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /跑「角色与节奏宪章」/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'HTTP 500' }),
    ));
  });

  it('试写三章：每章交稿都报一条进度，没落库的章必须显眼', async () => {
    const onTurn = vi.fn();
    mockFetch.mockResolvedValue(makeStatus({ view: makeView({ stage: 'pilot' }) }));
    mockRun.mockImplementation((_stage: unknown, _opts: unknown, onEvent: (e: unknown) => void) => {
      onEvent({ type: 'pilot_chapter', index: 1, total: 3, order: 1, phase: 'start' });
      onEvent({ type: 'pilot_chapter', index: 1, total: 3, order: 1, phase: 'done', delivered: true, wordCount: 3120 });
      onEvent({ type: 'pilot_chapter', index: 2, total: 3, order: 2, phase: 'done', delivered: false, wordCount: 0, warnings: ['意图门未通过（打回 2 次）'] });
      return Promise.resolve();
    });
    setup({ onTurn });
    fireEvent.click(await screen.findByRole('button', { name: /跑「前三章试写」/ }));

    await waitFor(() => expect(onTurn).toHaveBeenCalledWith(
      expect.objectContaining({ name: '第 1 章', text: expect.stringContaining('已入项目库（3120 字）'), tone: 'ok' }),
    ));
    expect(onTurn).toHaveBeenCalledWith(
      expect.objectContaining({ name: '第 2 章', text: expect.stringContaining('未入项目库'), tone: 'warn' }),
    );
  });

  it('跨章审阅：原文进交流流；判 major 时弹错误提醒（这是唯一"停下重写"的判定）', async () => {
    const onTurn = vi.fn();
    mockFetch.mockResolvedValue(makeStatus({ view: makeView({ stage: 'pilot' }) }));
    mockRun.mockImplementation((_stage: unknown, _opts: unknown, onEvent: (e: unknown) => void) => {
      onEvent({ type: 'premiere_review', text: '【前三章跨章审阅】判定：建议停下重写', verdict: 'major', issues: 3 });
      return Promise.resolve();
    });
    setup({ onTurn });
    fireEvent.click(await screen.findByRole('button', { name: /跑「前三章试写」/ }));

    await waitFor(() => expect(onTurn).toHaveBeenCalledWith(
      expect.objectContaining({ name: '《前三章审阅报告》', text: expect.stringContaining('建议停下重写'), tone: 'warn' }),
    ));
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('3 处问题') }));
  });
});
