// ============================================================
// recognizeLocations — 地图面板的「AI 识别地点」托底
// 逐章调用 ai.scan，只采纳 location 实体：
//   · 新地点落库并补上出现章节
//   · 已有地点补「出现章节」与空描述，让关系连线更完整
// 每章结束立刻分配地图坐标，标记能逐个出现，而不是最后一起堆到中心。
//
// 2026-11 优化（地点识别算法）：
//   · 落库前统一走 locationRecognition 的确定性校验（归一化/非地点过滤/
//     角色物品同名/原文接地/方位前缀变体合并），不再只看「长度 + 标点」
//   · 章节选择改为**全书均匀抽样**（原来永远只扫前 30 章，长篇后半程的地点
//     一次也发现不了）；MAX 章内同时覆盖首章与末章
//   · 单章失败不再立即终止整轮：连续失败达到阈值才停，偶发失败跳过继续
//   · 描述优先取 AI 的简短描述，缺失时才退回原文证据片段（截断 160 字）
//   · 已有地点按 projectId 过滤（原来只看 store 里的全部地点）
//   · 角色/物品在本次扫描中不会新增，提示词素材只取一次（原来每章重复 filter）
// ============================================================

import { nanoid } from 'nanoid';
import {
  useChapterStore,
  useCharacterStore,
  useItemStore,
  useLocationStore,
} from '@novel-plugins/data-core/stores';
import { htmlToText } from '@novel-plugins/data-core/editor/entityDetector';
import { getCapability } from '@/plugin/registry';
import type { Location } from '@novel/shared';
import { ScanSkippedError } from '../hooks/aiScanCapability';
import type { AIScanCapability, StreamEntity } from '../hooks/aiScanCapability';
import { applyLocationCandidate, prepareLocationContext } from './locationRecognition';
import { assignAutoCoords } from './locationCoords';

/** 一次最多扫多少章：扫描是逐章一次 AI 调用，避免超长书一次点出几百次请求 */
export const MAX_LOCATION_SCAN_CHAPTERS = 30;

/** 连续失败多少章后终止本轮（偶发单章失败只跳过，不再整轮作废） */
const MAX_CONSECUTIVE_FAILURES = 3;

/** 少于这个纯文本长度不扫（与自动检测的触发阈值一致） */
const MIN_CHAPTER_TEXT = 20;

export interface LocationScanProgress {
  done: number;
  total: number;
}

export interface LocationScanResult {
  /** 新建地点数 */
  created: number;
  /** 为已有地点补上的出现章节次数 */
  linked: number;
  /** 实际扫描成功的章节数 */
  chapters: number;
  /** 扫描失败但被跳过的章节数 */
  failed: number;
  /** 用户中途停止 */
  aborted: boolean;
  /** 提前终止的原因（已识别部分仍然生效） */
  error?: string;
}

function getScan(): AIScanCapability | null {
  return getCapability<AIScanCapability>('ai.scan');
}

/**
 * 从全部章节中选出至多 max 章：
 * - 不超过 max 时全扫
 * - 超过时**均匀抽样**（含首章与末章），而不是只截前 max 章 ——
 *   30 章的预算要覆盖整本书的时间线，否则后半程的地点永远发现不了。
 */
export function pickScanChapters<T extends { order: number }>(
  chapters: T[],
  max = MAX_LOCATION_SCAN_CHAPTERS,
): T[] {
  const sorted = [...chapters].sort((a, b) => a.order - b.order);
  const limit = Math.max(1, Math.floor(max));
  if (sorted.length <= limit) return sorted;
  if (limit === 1) {
    const first = sorted[0];
    return first ? [first] : [];
  }

  const picked: T[] = [];
  const step = (sorted.length - 1) / (limit - 1);
  for (let i = 0; i < limit; i++) {
    const item = sorted[Math.round(i * step)];
    if (item) picked.push(item);
  }

  // 四舍五入可能把相邻索引取成同一章；按 order 去重但保持顺序
  const seen = new Set<number>();
  return picked.filter((chapter) => {
    if (seen.has(chapter.order)) return false;
    seen.add(chapter.order);
    return true;
  });
}

function projectLocations(projectId: string): Location[] {
  return useLocationStore
    .getState()
    .locations.filter((l) => l.projectId === projectId);
}

function projectItems(projectId: string): Array<{ name: string }> {
  return useItemStore
    .getState()
    .items.filter((i) => i.projectId === projectId)
    .map((i) => ({ name: i.name }));
}

function existingCharacterEntities(projectId: string): Array<{ name: string; aliases: string[] }> {
  return useCharacterStore
    .getState()
    .characters.filter((c) => c.projectId === projectId)
    .map((c) => ({ name: c.name, aliases: c.aliases ?? [] }));
}

/**
 * 扫描项目章节，补齐地图地点。
 * 能力缺失 / 红石开关关闭时抛出错误（调用方提示用户）；
 * 单章失败跳过，连续失败 MAX_CONSECUTIVE_FAILURES 次才终止。
 */
export async function recognizeLocations(opts: {
  projectId: string;
  signal?: AbortSignal;
  onProgress?: (progress: LocationScanProgress) => void;
}): Promise<LocationScanResult> {
  const { projectId, signal, onProgress } = opts;
  const scan = getScan();
  if (!scan) throw new Error('AI 能力未注册');
  if (!scan.isScannerEnabled()) throw new Error('章节扫描开关已关闭');

  const allChapters = useChapterStore
    .getState()
    .chapters.filter((c) => c.projectId === projectId)
    .map((c) => ({ order: c.order, plain: htmlToText(c.content ?? '').trim() }))
    .filter((c) => c.plain.length >= MIN_CHAPTER_TEXT);

  const chapters = pickScanChapters(allChapters);
  if (chapters.length === 0) {
    return { created: 0, linked: 0, chapters: 0, failed: 0, aborted: false };
  }

  // 本次扫描只处理 location，不会新增角色/物品 —— 提示词素材与撞名索引只取一次。
  // 已有地点会随扫描增长，所以每章重新取。
  const characterEntities = existingCharacterEntities(projectId);
  const itemEntities = projectItems(projectId);
  const itemNames = itemEntities.map((item) => item.name);

  onProgress?.({ done: 0, total: chapters.length });

  let created = 0;
  let linked = 0;
  let failed = 0;
  let done = 0;
  let aborted = false;
  let error: string | undefined;
  let consecutiveFailures = 0;

  for (const chapter of chapters) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }

    // 每章重建地点索引：本章新建的地点要立刻参与后续候选去重
    const chapterLocations = projectLocations(projectId);
    const locationCtx = prepareLocationContext({
      chapterContent: chapter.plain,
      existingLocations: chapterLocations,
      existingCharacters: characterEntities,
      existingItems: itemEntities,
    });
    const locationNames = [...new Set(chapterLocations.map((l) => l.name))];

    const handleEntity = (entity: StreamEntity) => {
      if (signal?.aborted) return;
      if (entity.entityType !== 'location') return;

      const result = applyLocationCandidate(entity, chapter.order, locationCtx);
      if (result.kind === 'reject') {
        console.debug(
          `[recognizeLocations] 跳过第 ${chapter.order} 章疑似非地点「${entity.name}」：${result.reason}`,
        );
        return;
      }

      if (result.kind === 'create') {
        const now = Date.now();
        const newLocation: Location = {
          id: nanoid(),
          projectId,
          name: result.name,
          description: result.description,
          states: [],
          chapters: [chapter.order],
          tags: [],
          createdAt: now,
          updatedAt: now,
        };
        useLocationStore.getState().addLocation(newLocation);
        locationCtx.addLocation(newLocation);
        created++;
        return;
      }

      // link：已有地点（含方位前缀变体）只补章节/空描述
      if (!result.changed) return;
      const updates = {
        chapters: result.chapters,
        ...(result.description !== undefined ? { description: result.description } : {}),
        updatedAt: Date.now(),
      };
      useLocationStore.getState().updateLocation(result.location.id, updates);
      locationCtx.addLocation({ ...result.location, ...updates });
      linked++;
    };

    try {
      await scan.scanTimelineStream(
        chapter.plain,
        chapter.order,
        {
          characters: characterEntities,
          items: itemNames,
          locations: locationNames,
        },
        () => {}, // 地图只关心地点：事件 / 流转 / 别名一律忽略
        handleEntity,
        undefined,
        undefined,
        signal,
        projectId,
      );
      consecutiveFailures = 0;
    } catch (e) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      // 扫描开关关闭 / 能力缺失属于整轮不可用，重试没有意义
      if (e instanceof ScanSkippedError) {
        error = e.message;
        break;
      }
      failed++;
      consecutiveFailures++;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[recognizeLocations] 第 ${chapter.order} 章识别失败：${msg}`);
      // 已识别部分仍然生效；偶发失败跳过，连续失败才终止
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        error = msg;
        break;
      }
      continue;
    }

    // 每章结束就落坐标：新标记按章节区域逐个出现在地图上
    assignAutoCoords(
      useLocationStore.getState().locations,
      useLocationStore.getState().updateLocation,
    );
    done++;
    onProgress?.({ done, total: chapters.length });
  }

  // 中途停止/失败时，把已经识别出的地点也补上坐标
  assignAutoCoords(
    useLocationStore.getState().locations,
    useLocationStore.getState().updateLocation,
  );

  return { created, linked, chapters: done, failed, aborted, error };
}
