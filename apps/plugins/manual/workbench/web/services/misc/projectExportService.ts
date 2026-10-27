import {
  useProjectStore,
  useChapterStore,
  useCharacterStore,
  useItemStore,
  useLocationStore,
  useForeshadowStore,
  useEarmarkStore,
  useOutlineStore,
  useTimelineStore,
  useNoteStore,
} from '@novel-plugins/data-core/stores';
import type {
  Character,
  CharacterRelation,
  Item,
  ItemHolder,
  ItemRelation,
  Location,
  Foreshadow,
  ForeshadowHint,
  Earmark,
  OutlineNode,
  TimelineEvent,
  Note,
  EntityState,
} from '@novel/shared';
import DOMPurify from 'dompurify';

// ============================================================
// 砚舟 项目打包格式
// ============================================================

/** 最大文件大小: 50MB */
const MAX_FILE_SIZE = 50 * 1024 * 1024;

/** 导入包必须包含的顶层字段 */
const REQUIRED_FIELDS = [
  'projects',
  'chapters',
  'characters',
  'items',
  'locations',
  'storyEvents',
  'foreshadows',
  'earmarks',
  'annotations',
  'outlineNodes',
  'timelineEvents',
  'notes',
] as const;

export interface 砚舟Package {
  version: '1.0';
  exportedAt: number;
  project: {
    name: string;
    description?: string;
    penName?: string;
    genre?: string;
    targetWordCount?: number;
  };
  chapters: Array<{
    id: string;
    title: string;
    content: string;
    order: number;
    status: string;
    summary?: string;
  }>;
  characters: Array<{
    id: string;
    name: string;
    aliases: string[];
    desire?: string;
    fear?: string;
    belief?: string;
    weakness?: string;
    appearance?: string;
    personality?: string;
    backstory?: string;
    speechStyle?: string;
    states: EntityState[];
    relations: CharacterRelation[];
    chapters: number[];
    tags: string[];
    color?: string;
  }>;
  items: Array<{
    id: string;
    name: string;
    type?: string;
    description?: string;
    states: EntityState[];
    holders: ItemHolder[];
    currentHolders?: string[];
    relations?: ItemRelation[];
    chapters: number[];
    tags: string[];
  }>;
  locations: Array<{
    id: string;
    name: string;
    description?: string;
    states: EntityState[];
    chapters: number[];
    tags: string[];
  }>;
  foreshadows: Array<{
    id: string;
    description: string;
    type: string;
    status: string;
    seedChapter: number;
    seedText?: string;
    hints: ForeshadowHint[];
    payoffChapter?: number;
    relatedCharacters: string[];
    relatedItems: string[];
    relatedEvents: string[];
    earmarks: string[];
    tags: string[];
  }>;
  earmarks: Array<{
    id: string;
    chapterId: string;
    type: string;
    foreshadowId?: string;
    description?: string;
    outcome?: string;
    probability?: number;
    relatedCharacters: string[];
    relatedItems: string[];
    tags: string[];
  }>;
  outlineNodes: Array<{
    id: string;
    parentId?: string;
    type: string;
    title: string;
    description?: string;
    order: number;
    linkedChapterIds: string[];
    tags: string[];
  }>;
  timelineEvents: Array<{
    id: string;
    title: string;
    description?: string;
    chapter?: number;
    timestamp?: string;
    order: number;
    characterIds: string[];
    type: string;
    color?: string;
  }>;
  notes: Array<{
    id: string;
    title?: string;
    content: string;
    tags: string[];
    pinned: boolean;
    linkedChapterId?: string;
  }>;
}

/**
 * 净化字符串内容，防止 XSS
 */
function sanitizeString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return DOMPurify.sanitize(value, { ALLOWED_TAGS: [] });
}

/**
 * 递归净化对象中的字符串字段
 */
function sanitizeStringsDeep<T>(obj: T): T {
  if (typeof obj === 'string') {
    return sanitizeString(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeStringsDeep(item)) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      sanitized[key] = sanitizeStringsDeep((obj as Record<string, unknown>)[key]);
    }
    return sanitized as unknown as T;
  }
  return obj;
}

/**
 * 验证导入包的基本结构
 */
function validatePackageStructure(pkg: unknown): pkg is 砚舟Package {
  if (!pkg || typeof pkg !== 'object') return false;

  const obj = pkg as Record<string, unknown>;

  // 检查版本
  if (obj.version !== '1.0') return false;

  // 检查必需字段
  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) return false;
  }

  // 检查是否是数组类型
  const arrayFields = ['chapters', 'characters', 'items', 'locations', 'foreshadows', 'earmarks', 'outlineNodes', 'timelineEvents', 'notes'];
  for (const field of arrayFields) {
    if (!Array.isArray(obj[field])) return false;
  }

  // 检查 project 字段
  if (!obj.project || typeof obj.project !== 'object') return false;

  return true;
}

/**
 * 从当前所有 stores 中导出完整项目数据
 */
export function export砚舟Package(): 砚舟Package {
  const project = useProjectStore.getState().currentProject;
  const chapters = useChapterStore.getState().chapters;
  const characters = useCharacterStore.getState().characters;
  const items = useItemStore.getState().items;
  const locations = useLocationStore.getState().locations;
  const foreshadows = useForeshadowStore.getState().foreshadows;
  const earmarks = useEarmarkStore.getState().earmarks;
  const outlineNodes = useOutlineStore.getState().nodes;
  const timelineEvents = useTimelineStore.getState().events;
  const notes = useNoteStore.getState().notes;

  const pkg: 砚舟Package = {
    version: '1.0',
    exportedAt: Date.now(),
    project: project
      ? {
          name: project.name,
          description: project.description,
          penName: project.penName,
          genre: project.genre,
          targetWordCount: project.targetWordCount,
        }
      : { name: '未命名项目' },
    chapters: chapters.map((ch) => ({
      id: ch.id,
      title: ch.title,
      content: ch.content,
      order: ch.order,
      status: ch.status,
      summary: ch.summary,
    })),
    characters: characters.map((ch) => ({
      id: ch.id,
      name: ch.name,
      aliases: ch.aliases,
      desire: ch.desire,
      fear: ch.fear,
      belief: ch.belief,
      weakness: ch.weakness,
      appearance: ch.appearance,
      personality: ch.personality,
      backstory: ch.backstory,
      speechStyle: ch.speechStyle,
      states: ch.states,
      relations: ch.relations,
      chapters: ch.chapters,
      tags: ch.tags,
      color: ch.color,
    })),
    items: items.map((it) => ({
      id: it.id,
      name: it.name,
      type: it.type,
      description: it.description,
      states: it.states,
      holders: it.holders,
      currentHolders: it.currentHolders ?? [],
      relations: it.relations ?? [],
      chapters: it.chapters,
      tags: it.tags,
    })),
    locations: locations.map((loc) => ({
      id: loc.id,
      name: loc.name,
      description: loc.description,
      states: loc.states,
      chapters: loc.chapters,
      tags: loc.tags,
    })),
    foreshadows: foreshadows.map((fs) => ({
      id: fs.id,
      description: fs.description,
      type: fs.type,
      status: fs.status,
      seedChapter: fs.seedChapter,
      seedText: fs.seedText,
      hints: fs.hints,
      payoffChapter: fs.payoffChapter ?? undefined,
      relatedCharacters: fs.relatedCharacters,
      relatedItems: fs.relatedItems,
      relatedEvents: fs.relatedEvents,
      earmarks: fs.earmarks,
      tags: fs.tags,
    })),
    earmarks: earmarks.map((em) => ({
      id: em.id,
      chapterId: em.chapterId,
      type: em.type,
      foreshadowId: em.foreshadowId,
      description: em.description,
      outcome: em.outcome,
      probability: em.probability,
      relatedCharacters: em.relatedCharacters,
      relatedItems: em.relatedItems,
      tags: em.tags,
    })),
    outlineNodes: outlineNodes.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      type: node.type,
      title: node.title,
      description: node.description,
      order: node.order,
      linkedChapterIds: node.linkedChapterIds,
      tags: node.tags,
    })),
    timelineEvents: timelineEvents.map((ev) => ({
      id: ev.id,
      title: ev.title,
      description: ev.description,
      chapter: ev.chapter ?? undefined,
      timestamp: ev.timestamp,
      order: ev.order,
      characterIds: ev.characterIds,
      type: ev.type,
      color: ev.color,
    })),
    notes: notes.map((n) => ({
      id: n.id,
      title: n.title,
      content: n.content,
      tags: n.tags,
      pinned: n.pinned,
      linkedChapterId: n.linkedChapterId,
    })),
  };

  return pkg;
}

/**
 * 安全处理导出文件名，防止路径遍历攻击
 */
function sanitizeFilename(name: string): string {
  // 移除路径遍历字符和文件系统非法字符
  const sanitized = name.replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/^\.+/, '_')
    .trim()
    .slice(0, 255); // 限制文件名长度
  return sanitized || 'export';
}

/**
 * 下载 .novelmuse 文件
 */
export function download砚舟Package(
  pkg: 砚舟Package,
  filename?: string,
) {
  const json = JSON.stringify(pkg, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safeName = sanitizeFilename(filename || `${pkg.project.name}.novelmuse`);
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 从文件读取并解析 .novelmuse 项目包
 */
export function import砚舟Package(file: File): Promise<砚舟Package> {
  return new Promise((resolve, reject) => {
    // 文件大小限制检查
    if (file.size > MAX_FILE_SIZE) {
      reject(new Error(`文件过大，最大允许 ${MAX_FILE_SIZE / 1024 / 1024}MB`));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result as string);

        // 结构验证
        if (!validatePackageStructure(raw)) {
          throw new Error('项目文件格式不兼容或结构已损坏');
        }

        // 净化字符串内容，防止 XSS
        const pkg = sanitizeStringsDeep(raw) as 砚舟Package;

        resolve(pkg);
      } catch (e) {
        reject(e instanceof Error ? e : new Error('文件解析失败'));
      }
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file);
  });
}

// 重新导出租用的类型以便 ImportDialog 使用
export type { Character, CharacterRelation, Item, ItemHolder, Location, Foreshadow, ForeshadowHint, Earmark, OutlineNode, TimelineEvent, Note, EntityState };