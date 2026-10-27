import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type {
  Project,
  Chapter,
  Character,
  CharacterRelation,
  Item,
  ItemRelation,
  CreditTransaction,
  Location,
  StoryEvent,
  Foreshadow,
  ForeshadowType,
  Annotation,
  OutlineNode,
  TimelineEvent as TimelineEventType,
  Note,
  Earmark,
  EarmarkType,
} from '@novel/shared';

// ============================================================
// 砚舟 - 全局状态管理 (Zustand)
// ============================================================

// ---- 伏笔类型阈值配置 ----

// 伏笔类型对应的默认阈值（章节数）
const DEFAULT_THRESHOLDS: Record<ForeshadowType, { overdue: number; warning: number }> = {
  // 身份揭露需要更长铺垫
  identity: { overdue: 7, warning: 4 },
  // 动机变化居中
  motivation: { overdue: 6, warning: 3 },
  // 关系转变需要时间
  relation: { overdue: 6, warning: 3 },
  // 创伤需要更多铺垫
  trauma: { overdue: 8, warning: 5 },
  // 转折可以较快
  turning: { overdue: 5, warning: 3 },
  // 命运结局需要完整铺垫
  fate: { overdue: 8, warning: 5 },
};

// 获取指定类型的阈值
export function getForeshadowThreshold(type: ForeshadowType): { overdue: number; warning: number } {
  // DEFAULT_THRESHOLDS 是完整的 Record<ForeshadowType, ...>，但 noUncheckedIndexedAccess 下索引访问可能返回 undefined
  return DEFAULT_THRESHOLDS[type] ?? { overdue: 5, warning: 3 };
}

// ---- 项目状态 ----

interface ProjectState {
  currentProject: Project | null;
  projects: Project[];
  setProject: (project: Project) => void;
  setProjects: (projects: Project[]) => void;
  updateProject: (updates: Partial<Project>) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  currentProject: null,
  projects: [],
  setProject: (project) => set({ currentProject: project }),
  setProjects: (projects) => set({ projects }),
  updateProject: (updates) =>
    set((state) => ({
      currentProject: state.currentProject
        ? { ...state.currentProject, ...updates }
        : null,
    })),
}));

// ---- 章节状态 ----

interface ChapterState {
  chapters: Chapter[];
  currentChapterId: string | null;
  /** 实时字数（编辑器每次按键即更新），独立于 chapters 数组，不触发 useEntitySync PUT */
  liveWordCount: { chapterId: string; wordCount: number } | null;
  setChapters: (chapters: Chapter[]) => void;
  setCurrentChapter: (id: string | null) => void;
  setLiveWordCount: (chapterId: string, wordCount: number) => void;
  addChapter: (chapter: Chapter) => void;
  updateChapter: (id: string, updates: Partial<Chapter>) => void;
  deleteChapter: (id: string) => void;
  reorderChapters: (ids: string[]) => void;
  getCurrentChapter: () => Chapter | undefined;
}

export const useChapterStore = create<ChapterState>((set, get) => ({
  chapters: [],
  currentChapterId: null,
  liveWordCount: null,
  setChapters: (chapters) => set({ chapters }),
  setCurrentChapter: (id) => set({ currentChapterId: id }),
  setLiveWordCount: (chapterId, wordCount) => set({ liveWordCount: { chapterId, wordCount } }),
  addChapter: (chapter) =>
    set((state) => ({ chapters: [...state.chapters, chapter] })),
  updateChapter: (id, updates) =>
    set((state) => ({
      chapters: state.chapters.map((ch) =>
        ch.id === id ? { ...ch, ...updates } : ch
      ),
    })),
  deleteChapter: (id) =>
    set((state) => ({
      chapters: state.chapters.filter((ch) => ch.id !== id),
      currentChapterId:
        state.currentChapterId === id ? null : state.currentChapterId,
    })),
  reorderChapters: (ids) =>
    set((state) => {
      const map = new Map(state.chapters.map((ch) => [ch.id, ch]));
      const reordered: Chapter[] = [];
      for (const id of ids) {
        const found = map.get(id);
        if (found) reordered.push(found);
      }
      return { chapters: reordered.map((ch, i) => ({ ...ch, order: i + 1 })) };
    }),
  getCurrentChapter: () => {
    const state = get();
    return state.chapters.find((ch) => ch.id === state.currentChapterId);
  },
}));

// ---- 角色状态 ----

interface CharacterState {
  characters: Character[];
  setCharacters: (characters: Character[]) => void;
  addCharacter: (character: Character) => void;
  updateCharacter: (id: string, updates: Partial<Character>) => void;
  deleteCharacter: (id: string) => void;
  getCharacterById: (id: string) => Character | undefined;
  addRelation: (characterId: string, relation: CharacterRelation) => void;
  updateRelation: (characterId: string, targetId: string, updates: Partial<CharacterRelation>) => void;
  removeRelation: (characterId: string, targetId: string) => void;
}

export const useCharacterStore = create<CharacterState>((set, get) => ({
  characters: [],
  setCharacters: (characters) => set({ characters }),
  addCharacter: (character) =>
    set((state) => ({ characters: [...state.characters, character] })),
  updateCharacter: (id, updates) =>
    set((state) => ({
      characters: state.characters.map((ch) =>
        ch.id === id ? { ...ch, ...updates, updatedAt: Date.now() } : ch
      ),
    })),
  deleteCharacter: (id) =>
    set((state) => ({
      characters: state.characters.filter((ch) => ch.id !== id),
    })),
  getCharacterById: (id) => get().characters.find((ch) => ch.id === id),
  addRelation: (characterId, relation) =>
    set((state) => ({
      characters: state.characters.map((ch) =>
        ch.id === characterId
          ? { ...ch, relations: [...ch.relations, { ...relation, targetId: relation.targetId || nanoid() }] }
          : ch
      ),
    })),
  updateRelation: (characterId, targetId, updates) =>
    set((state) => ({
      characters: state.characters.map((ch) =>
        ch.id === characterId
          ? {
              ...ch,
              relations: ch.relations.map((rel) =>
                rel.targetId === targetId ? { ...rel, ...updates } : rel
              ),
            }
          : ch
      ),
    })),
  removeRelation: (characterId, targetId) =>
    set((state) => ({
      characters: state.characters.map((ch) =>
        ch.id === characterId
          ? { ...ch, relations: ch.relations.filter((rel) => rel.targetId !== targetId) }
          : ch
      ),
    })),
}));

// ---- 物品状态 ----

interface ItemState {
  items: Item[];
  setItems: (items: Item[]) => void;
  addItem: (item: Item) => void;
  updateItem: (id: string, updates: Partial<Item>) => void;
  deleteItem: (id: string) => void;
  addItemRelation: (itemId: string, relation: ItemRelation) => void;
  removeItemRelation: (itemId: string, targetItemId: string, type?: string) => void;
}

export const useItemStore = create<ItemState>((set) => ({
  items: [],
  setItems: (items) => set({ items }),
  addItem: (item) => set((state) => ({ items: [...state.items, item] })),
  updateItem: (id, updates) =>
    set((state) => ({
      items: state.items.map((it) =>
        it.id === id ? { ...it, ...updates, updatedAt: Date.now() } : it
      ),
    })),
  deleteItem: (id) =>
    set((state) => ({ items: state.items.filter((it) => it.id !== id) })),
  addItemRelation: (itemId, relation) =>
    set((state) => ({
      items: state.items.map((it) =>
        it.id === itemId
          ? { ...it, relations: [...(it.relations || []), relation], updatedAt: Date.now() }
          : it
      ),
    })),
  removeItemRelation: (itemId, targetItemId, type) =>
    set((state) => ({
      items: state.items.map((it) =>
        it.id === itemId
          ? {
              ...it,
              relations: (it.relations || []).filter(
                (rel) => !(rel.targetItemId === targetItemId && (type === undefined || rel.type === type))
              ),
              updatedAt: Date.now(),
            }
          : it
      ),
    })),
}));

// ---- 系统积分流水状态（系统文：积分使用结余追踪） ----

interface CreditState {
  creditTransactions: CreditTransaction[];
  setCreditTransactions: (transactions: CreditTransaction[]) => void;
  addCreditTransaction: (tx: CreditTransaction) => void;
  updateCreditTransaction: (id: string, updates: Partial<CreditTransaction>) => void;
  deleteCreditTransaction: (id: string) => void;
}

export const useCreditStore = create<CreditState>((set) => ({
  creditTransactions: [],
  setCreditTransactions: (creditTransactions) => set({ creditTransactions }),
  addCreditTransaction: (tx) =>
    set((state) => ({ creditTransactions: [...state.creditTransactions, tx] })),
  updateCreditTransaction: (id, updates) =>
    set((state) => ({
      creditTransactions: state.creditTransactions.map((t) =>
        t.id === id ? { ...t, ...updates, updatedAt: Date.now() } : t
      ),
    })),
  deleteCreditTransaction: (id) =>
    set((state) => ({
      creditTransactions: state.creditTransactions.filter((t) => t.id !== id),
    })),
}));

// ---- 地点状态 ----

interface LocationState {
  locations: Location[];
  setLocations: (locations: Location[]) => void;
  addLocation: (location: Location) => void;
  updateLocation: (id: string, updates: Partial<Location>) => void;
  deleteLocation: (id: string) => void;
}

export const useLocationStore = create<LocationState>((set) => ({
  locations: [],
  setLocations: (locations) => set({ locations }),
  addLocation: (location) =>
    set((state) => ({ locations: [...state.locations, location] })),
  updateLocation: (id, updates) =>
    set((state) => ({
      locations: state.locations.map((loc) =>
        loc.id === id ? { ...loc, ...updates } : loc
      ),
    })),
  deleteLocation: (id) =>
    set((state) => ({
      locations: state.locations.filter((loc) => loc.id !== id),
    })),
}));

// ---- 事件状态 ----

interface EventState {
  events: StoryEvent[];
  setEvents: (events: StoryEvent[]) => void;
  addEvent: (event: StoryEvent) => void;
  updateEvent: (id: string, updates: Partial<StoryEvent>) => void;
  deleteEvent: (id: string) => void;
}

export const useEventStore = create<EventState>((set) => ({
  events: [],
  setEvents: (events) => set({ events }),
  addEvent: (event) =>
    set((state) => ({ events: [...state.events, event] })),
  updateEvent: (id, updates) =>
    set((state) => ({
      events: state.events.map((ev) =>
        ev.id === id ? { ...ev, ...updates } : ev
      ),
    })),
  deleteEvent: (id) =>
    set((state) => ({ events: state.events.filter((ev) => ev.id !== id) })),
}));

// ---- 伏笔状态 ----

interface ForeshadowState {
  foreshadows: Foreshadow[];
  setForeshadows: (foreshadows: Foreshadow[]) => void;
  addForeshadow: (foreshadow: Foreshadow) => void;
  updateForeshadow: (id: string, updates: Partial<Foreshadow>) => void;
  deleteForeshadow: (id: string) => void;
  getActiveForeshadows: () => Foreshadow[];
  getOverdueForeshadows: (currentChapter: number, threshold?: number) => Foreshadow[];
  getWarningForeshadows: (currentChapter: number) => Foreshadow[];
}

export const useForeshadowStore = create<ForeshadowState>((set, get) => ({
  foreshadows: [],
  setForeshadows: (foreshadows) => set({ foreshadows }),
  addForeshadow: (foreshadow) =>
    set((state) => ({ foreshadows: [...state.foreshadows, foreshadow] })),
  updateForeshadow: (id, updates) =>
    set((state) => ({
      foreshadows: state.foreshadows.map((fs) =>
        fs.id === id ? { ...fs, ...updates } : fs
      ),
    })),
  deleteForeshadow: (id) =>
    set((state) => ({
      foreshadows: state.foreshadows.filter((fs) => fs.id !== id),
    })),
  getActiveForeshadows: () =>
    get().foreshadows.filter(
      (fs) => fs.status === 'planted' || fs.status === 'hinted'
    ),
  getOverdueForeshadows: (currentChapter, threshold) =>
    get().foreshadows.filter(
      (fs) =>
        (fs.status === 'planted' || fs.status === 'hinted') &&
        fs.seedChapter != null &&
        currentChapter >= fs.seedChapter &&
        currentChapter - fs.seedChapter >= (threshold ?? getForeshadowThreshold(fs.type).overdue)
    ),
  getWarningForeshadows: (currentChapter) =>
    get().foreshadows.filter(
      (fs) =>
        (fs.status === 'planted' || fs.status === 'hinted') &&
        fs.seedChapter != null &&
        currentChapter >= fs.seedChapter &&
        currentChapter - fs.seedChapter >= getForeshadowThreshold(fs.type).warning &&
        currentChapter - fs.seedChapter < getForeshadowThreshold(fs.type).overdue
    ),
}));

// ---- 书角标记状态 ----

interface EarmarkState {
  earmarks: Earmark[];
  setEarmarks: (earmarks: Earmark[]) => void;
  addEarmark: (earmark: Earmark) => void;
  updateEarmark: (id: string, updates: Partial<Earmark>) => void;
  deleteEarmark: (id: string) => void;
  
  // 查询方法
  getEarmarksByChapter: (chapterId: string) => Earmark[];
  getEarmarksByForeshadow: (foreshadowId: string) => Earmark[];
  getEarmarksByType: (type: EarmarkType) => Earmark[];
  
  // 工具方法
  linkToForeshadow: (earmarkId: string, foreshadowId: string) => void;
  unlinkFromForeshadow: (earmarkId: string) => void;
}

export const useEarmarkStore = create<EarmarkState>((set, get) => ({
  earmarks: [],
  setEarmarks: (earmarks) => set({ earmarks }),
  addEarmark: (earmark) =>
    set((state) => ({ earmarks: [...state.earmarks, earmark] })),
  updateEarmark: (id, updates) =>
    set((state) => ({
      earmarks: state.earmarks.map((em) =>
        em.id === id ? { ...em, ...updates, updatedAt: Date.now() } : em
      ),
    })),
  deleteEarmark: (id) =>
    set((state) => ({
      earmarks: state.earmarks.filter((em) => em.id !== id),
    })),
  getEarmarksByChapter: (chapterId) =>
    get().earmarks.filter((em) => em.chapterId === chapterId),
  getEarmarksByForeshadow: (foreshadowId) =>
    get().earmarks.filter((em) => em.foreshadowId === foreshadowId),
  getEarmarksByType: (type) =>
    get().earmarks.filter((em) => em.type === type),
  linkToForeshadow: (earmarkId, foreshadowId) =>
    set((state) => ({
      earmarks: state.earmarks.map((em) =>
        em.id === earmarkId
          ? { ...em, foreshadowId, updatedAt: Date.now() }
          : em
      ),
    })),
  unlinkFromForeshadow: (earmarkId) =>
    set((state) => ({
      earmarks: state.earmarks.map((em) =>
        em.id === earmarkId
          ? { ...em, foreshadowId: undefined, updatedAt: Date.now() }
          : em
      ),
    })),
}));

// ---- 标注状态 ----

interface AnnotationState {
  annotations: Annotation[];
  setAnnotations: (annotations: Annotation[]) => void;
  addAnnotation: (annotation: Annotation) => void;
  updateAnnotation: (id: string, updates: Partial<Annotation>) => void;
  deleteAnnotation: (id: string) => void;
  getByChapter: (chapterId: string) => Annotation[];
}

export const useAnnotationStore = create<AnnotationState>((set, get) => ({
  annotations: [],
  setAnnotations: (annotations) => set({ annotations }),
  addAnnotation: (annotation) =>
    set((state) => ({ annotations: [...state.annotations, annotation] })),
  updateAnnotation: (id, updates) =>
    set((state) => ({
      annotations: state.annotations.map((ann) =>
        ann.id === id ? { ...ann, ...updates } : ann
      ),
    })),
  deleteAnnotation: (id) =>
    set((state) => ({
      annotations: state.annotations.filter((ann) => ann.id !== id),
    })),
  getByChapter: (chapterId) =>
    get().annotations.filter((ann) => ann.chapterId === chapterId),
}));

// ---- 大纲状态 ----

interface OutlineState {
  nodes: OutlineNode[];
  setNodes: (nodes: OutlineNode[]) => void;
  addNode: (node: OutlineNode) => void;
  updateNode: (id: string, updates: Partial<OutlineNode>) => void;
  deleteNode: (id: string) => void;
  getTree: () => OutlineNode[];
}

export const useOutlineStore = create<OutlineState>((set, get) => ({
  nodes: [],
  setNodes: (nodes) => set({ nodes }),
  addNode: (node) =>
    set((state) => ({ nodes: [...state.nodes, node] })),
  updateNode: (id, updates) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, ...updates } : n
      ),
    })),
  deleteNode: (id) =>
    set((state) => ({ nodes: state.nodes.filter((n) => n.id !== id) })),
  getTree: () => {
    const nodes = get().nodes;
    const root = nodes.filter((n) => !n.parentId);
    return root.sort((a, b) => a.order - b.order);
  },
}));

// ---- 时间线状态 ----

interface TimelineState {
  events: TimelineEventType[];
  setEvents: (events: TimelineEventType[]) => void;
  addEvent: (event: TimelineEventType) => void;
  updateEvent: (id: string, updates: Partial<TimelineEventType>) => void;
  deleteEvent: (id: string) => void;
}

export const useTimelineStore = create<TimelineState>((set) => ({
  events: [],
  setEvents: (events) => set({ events }),
  addEvent: (event) =>
    set((state) => ({ events: [...state.events, event] })),
  updateEvent: (id, updates) =>
    set((state) => ({
      events: state.events.map((ev) =>
        ev.id === id ? { ...ev, ...updates } : ev
      ),
    })),
  deleteEvent: (id) =>
    set((state) => ({ events: state.events.filter((ev) => ev.id !== id) })),
}));

// ---- 笔记状态 ----

interface NoteState {
  notes: Note[];
  setNotes: (notes: Note[]) => void;
  addNote: (note: Note) => void;
  updateNote: (id: string, updates: Partial<Note>) => void;
  deleteNote: (id: string) => void;
}

export const useNoteStore = create<NoteState>((set) => ({
  notes: [],
  setNotes: (notes) => set({ notes }),
  addNote: (note) =>
    set((state) => ({ notes: [...state.notes, note] })),
  updateNote: (id, updates) =>
    set((state) => ({
      notes: state.notes.map((n) =>
        n.id === id ? { ...n, ...updates } : n
      ),
    })),
  deleteNote: (id) =>
    set((state) => ({ notes: state.notes.filter((n) => n.id !== id) })),
}));

