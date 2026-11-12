import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { useParams } from 'react-router-dom';
import { CustomHighlight } from '../extensions/CustomHighlight';
import Underline from '@tiptap/extension-underline';
import { htmlToText } from '@novel-plugins/data-core/editor/entityDetector';
import CharacterCount from '@tiptap/extension-character-count';
import { useEffect, useRef, useCallback, useMemo, useState, useLayoutEffect } from 'react';
import { nanoid } from 'nanoid';
import { AnnotationExtension } from '../extensions/AnnotationExtension';
import { AnnotationBlockExtension } from '../extensions/AnnotationBlockExtension';
import { LeadCharacterHighlight } from '../extensions/LeadCharacterHighlight';
import { JumpHighlightExtension } from '../extensions/JumpHighlightExtension';
import { useChapterStore, useStatsStore, useForeshadowStore, useAnnotationStore, useCharacterStore, cascadeCleanChapterClient } from '@novel-plugins/data-core/stores';
import { useEditorStore } from '@novel-plugins/data-core/stores';
import { saveSnapshot } from '@novel-plugins/data-core/data/databaseService';
import { cacheChapterContent } from '@novel-plugins/data-core/data/chapterLocalCache';
import { getToken, getCurrentProjectId, resolveApiUrl } from '@novel-plugins/data-core/api/apiClient';
import { analyzeLocalStyle } from '../panels/StyleAdvisor';
import { usePluginRegistry, useProjectMode, filterByProjectMode } from '@/plugin/registry';
import type { StyleProfile } from '@novel-plugins/data-core/editor/styleService';
import type { AnyExtension } from '@tiptap/core';
import type { Snapshot } from '@novel/shared';

declare module '@tiptap/core' {
  interface Storage {
    characterCount?: {
      characters(): number;
      words(): number;
      charactersExcludingSpaces(): number;
    };
  }
}

interface UseEditorInstanceOptions {
  initialContent?: string;
  styleProfile: StyleProfile | null;
}

export function useEditorInstance({ initialContent, styleProfile }: UseEditorInstanceOptions) {
  // 使用独立 selector，避免订阅整个 store 导致不必要的重渲染
  const currentChapterId = useChapterStore(s => s.currentChapterId);
  // ★ URL 里的 bookId：冷开（直接刷新深层链接）时 store 尚未恢复，
  //   而它是同步可用的，作为 projectId 的兜底来源（见 flushToBackend）。
  const { bookId: urlBookId } = useParams<{ bookId?: string }>();
  const updateChapter = useChapterStore(s => s.updateChapter);
  const setStoreLiveWordCount = useChapterStore(s => s.setLiveWordCount);
  const addWords = useStatsStore(s => s.addWords);
  const deleteForeshadow = useForeshadowStore(s => s.deleteForeshadow);
  const characters = useCharacterStore(s => s.characters);
  const prevWordCount = useRef(0);
  // ★ 实时字数 state：null 表示未初始化，0 表示空章节
  const [liveWordCount, setLiveWordCount] = useState<number | null>(null);
  const styleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentChapterIdRef = useRef(currentChapterId);
  // flushToBackend 在 effect 里闭包引用，URL 变化必须走 ref 才能拿到最新值
  const urlBookIdRef = useRef(urlBookId);
  const updateChapterRef = useRef(updateChapter);
  const addWordsRef = useRef(addWords);
  const styleProfileRef = useRef(styleProfile);
  const deleteForeshadowRef = useRef(deleteForeshadow);

  useEffect(() => {
    currentChapterIdRef.current = currentChapterId;
  }, [currentChapterId]);

  useEffect(() => {
    urlBookIdRef.current = urlBookId;
  }, [urlBookId]);

  useEffect(() => {
    updateChapterRef.current = updateChapter;
  }, [updateChapter]);

  useEffect(() => {
    addWordsRef.current = addWords;
  }, [addWords]);

  useEffect(() => {
    deleteForeshadowRef.current = deleteForeshadow;
  }, [deleteForeshadow]);

  useEffect(() => {
    styleProfileRef.current = styleProfile;
  }, [styleProfile]);

  // 防抖定时器：合并短时间内的连续 onUpdate
  // 性能：用户连续输入时（如中文 1 字、英文 1 字符），每 100-300ms 才落一次 store。
  // 太低会丢字，太高会卡。200ms 是中文输入法的舒适区。
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingContentRef = useRef<string | null>(null);
  const pendingWordCountRef = useRef<number>(0);
  // ★ 缓冲所属章节 ID：防止 200ms 防抖窗口内切换章节后，
  // 旧章节内容被 flushPersist 写入 currentChapterIdRef 指向的新章节。
  const pendingChapterIdRef = useRef<string | null>(null);
  // ★ 标记本次 flush 是否是从"有真实内容"变为"空"，用于触发 cascade clean
  // 不能依赖 store 中的 oldWc（可能已被中间状态覆盖），必须在 handleEditorUpdate 中捕获边界
  const pendingFromFullToEmptyRef = useRef<boolean>(false);

  // 自动快照：每 N 次 flush 后 / 切换章节时触发，避免大改后无法回退
  const flushCountRef = useRef(0);
  const lastAutoSnapshotAtRef = useRef(0);
  const lastAutoSnapshotWordCountRef = useRef(0);
  const AUTO_SNAPSHOT_INTERVAL_FLUSHES = 30; // 每 ~30 次落盘（约 6 秒连续输入）一次自动快照
  const AUTO_SNAPSHOT_MIN_INTERVAL_MS = 5 * 60 * 1000; // 同一章至少间隔 5 分钟
  const AUTO_SNAPSHOT_MIN_WORD_DELTA = 200; // 字数变化至少 200 字才创建快照（避免空改触发）

  // 创建自动快照（带节流和增量校验）
  const maybeCreateAutoSnapshot = useCallback(async (chapterId: string, content: string, wordCount: number, label?: string) => {
    const now = Date.now();
    const timeDelta = now - lastAutoSnapshotAtRef.current;
    const wordDelta = Math.abs(wordCount - lastAutoSnapshotWordCountRef.current);
    if (timeDelta < AUTO_SNAPSHOT_MIN_INTERVAL_MS && wordDelta < AUTO_SNAPSHOT_MIN_WORD_DELTA) {
      return; // 节流：太近 + 字数变化太小，跳过
    }
    try {
      const snap: Snapshot = {
        id: nanoid(),
        chapterId,
        content,
        wordCount,
        label: label ?? `自动快照 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
        auto: true,
        createdAt: now,
        updatedAt: now,
      };
      await saveSnapshot(snap);
      lastAutoSnapshotAtRef.current = now;
      lastAutoSnapshotWordCountRef.current = wordCount;
    } catch (e) {
      console.warn('[useEditorInstance] 自动快照失败:', e);
    }
  }, []);

  // 切换章节前为旧章节创建一个快照（在 useEditorInstance 内监听 chapterId 变化）
  useEffect(() => {
    return () => {
      // 组件卸载时不再触发自动快照（避免闭包陈旧数据），由 EditorPage 的章节切换逻辑负责
    };
  }, []);

  const flushPersist = useCallback(() => {
    // ★ 使用缓冲所属的 chapterId，而非 currentChapterIdRef.current
    // 防止：用户输入后 200ms 内切换章节，此时 currentChapterIdRef 已指向新章节，
    // 但 pendingContentRef 仍是旧章节内容，使用当前 ref 会导致旧内容污染新章节。
    const cid = pendingChapterIdRef.current;
    const content = pendingContentRef.current;
    if (cid && content !== null) {
      const wc = pendingWordCountRef.current;
      const now = Date.now();
      const chapterOrder = useChapterStore.getState().chapters.find(c => c.id === cid)?.order;

      // 检测内容是否从有字变空：触发前端联动清理
      // 使用 pendingFromFullToEmptyRef 而不是 store 中的 oldWc，
      // 因为中间状态（如 1 字）可能已经把 store 覆盖，导致 oldWc<=20 无法触发清理
      if (pendingFromFullToEmptyRef.current && chapterOrder != null) {
        console.debug(`[flushPersist] 章节 id=${cid} 从有真实内容变为空（${wc} 字），联动清理前端 store`);
        cascadeCleanChapterClient(chapterOrder);
        pendingFromFullToEmptyRef.current = false;
      }

      updateChapterRef.current(cid, {
        content,
        wordCount: wc,
        updatedAt: now,
      });
      // ★ 同步本地缓存兜底：用户主动清空时也缓存空内容，避免刷新后旧内容回归
      // （mount 竞态已被上面的 guard 阻止，不会写入空缓存）
      cacheChapterContent(cid, { content, wordCount: wc, updatedAt: now });
      // 自动快照节流计数
      flushCountRef.current += 1;
      if (flushCountRef.current >= AUTO_SNAPSHOT_INTERVAL_FLUSHES) {
        flushCountRef.current = 0;
        // 异步触发，不阻塞输入
        void maybeCreateAutoSnapshot(cid, content, wc);
      }
    }
    pendingContentRef.current = null;
    pendingChapterIdRef.current = null;
    persistTimerRef.current = null;
  }, [maybeCreateAutoSnapshot]);

  // ★ 插件扩展：Tiptap 不支持给活着的实例追加扩展，只能重建编辑器。
  //   扩展数组作为 useEditor 的 deps —— 插件挂载/卸载时重建，首次渲染不会触发
  //   （useEditor 内部 previousDeps 为 null 时复用实例）。
  //   用 create() 工厂而非共享实例：每个编辑器实例必须持有自己的扩展状态。
  // ★ 按当前项目创作模式过滤：不适用于本模式的插件扩展不挂到编辑器上
  const editorMode = useProjectMode();
  // ★ 必须 memo：filterByProjectMode 每次都返回**新数组**，直接内联会让
  //   pluginEditorExtensions 每轮渲染都是新引用 → 下方 `extensions` 的 useMemo
  //   （deps: [pluginEditorExtensions]）随之失效 → useEditor 的 deps 每轮都"变了"。
  //   TipTap 的 refreshEditorInstance 按 `dep === deps[index]`（引用比较）判等，
  //   于是每轮都 destroy + createEditor + setEditor → setState → 再渲染 → 无限循环
  //   （实测报 "Maximum update depth exceeded"，栈落在 @tiptap/react 的 forceStoreRerender）。
  //   写法与 ProjectLayout.tsx 的 floatingPanels 一致：先原子订阅，再 useMemo 派生。
  const allEditorExtensions = usePluginRegistry((s) => s.editorExtensions);
  const pluginEditorExtensions = useMemo(
    () => filterByProjectMode(allEditorExtensions, editorMode),
    [allEditorExtensions, editorMode],
  );

  // Memoize extensions to avoid recreating on every render
  const extensions = useMemo<AnyExtension[]>(() => {
    const base: AnyExtension[] = [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: { HTMLAttributes: { class: 'code-block' } },
        // 禁用分隔线节点：避免正文误插入 <hr> 产生突兀横杠（含 Markdown "---" 快捷输入）
        horizontalRule: false,
      }),
      Placeholder.configure({
        placeholder: ({ node }) => {
          if (node.type.name === 'heading') return '章节标题...';
          return '开始写作...';
        },
      }),
      CustomHighlight.configure({ multicolor: true }),
      AnnotationExtension,
      // 块级内嵌批注块（浅灰底 + 左强调条 + 类型徽标 + 自由文本）
      AnnotationBlockExtension,
      Underline,
      CharacterCount,
      LeadCharacterHighlight.configure({ names: [] }),
      // 时间线跳转后的正文片段高亮（Decoration 驱动，见编辑器扩展注释）
      JumpHighlightExtension,
    ];
    // 单个插件扩展构造失败只跳过该扩展，不能让整个编辑器起不来
    for (const def of pluginEditorExtensions) {
      try {
        base.push(def.create());
      } catch (err) {
        console.warn(`[plugin] 编辑器扩展 ${def.key} 构造失败（已跳过）:`, err);
      }
    }
    return base;
  }, [pluginEditorExtensions]);

  // ★ 重建前抢先落盘：编辑器重建会丢弃防抖队列里未提交的内容。
  //   本 layout effect 声明在 useEditor 之前，因此先于 useEditor 内部的
  //   layout effect（重建实例的那一步）执行；首次挂载跳过。
  const extensionsRef = useRef(extensions);
  useLayoutEffect(() => {
    if (extensionsRef.current === extensions) return;
    extensionsRef.current = extensions;
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      flushPersist();
    }
  }, [extensions, flushPersist]);

  // Memoize onBlur callback
  const handleBlur = useCallback(() => {
    // 失焦时强制落盘，避免快速切章节丢字
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      flushPersist();
    }
  }, [flushPersist]);

  const editor = useEditor({
    extensions,
    content: initialContent || '',
    editorProps: {
      attributes: {
        class: 'ProseMirror',
      },
    },
    // ★ onUpdate 不写业务逻辑：TipTap useEditor 的 onUpdate callback 存在闭包陈旧问题，
    // 某些场景下不会触发最新的 stableOnUpdate。所有 update 逻辑统一在下方
    // useEffect 的 editor.on('update', handleEditorUpdate) 中处理，确保可靠触发。
    onUpdate: () => {},
    onBlur: handleBlur,
  // ★ deps：扩展数组变化（插件注册/注销编辑器扩展）时重建实例。
  //   重建后 EditorPage 的 [currentChapterId, editor] effect 会从 store/本地缓存
  //   重新注入正文，配合上方的抢先落盘不会丢字。
  }, [extensions]);

  // 将 editor 实例写入全局 store，供兄弟组件（如 ChatPanel）读取
  const setGlobalEditor = useEditorStore(s => s.setEditor);
  useEffect(() => {
    setGlobalEditor(editor);
    return () => setGlobalEditor(null);
  }, [editor, setGlobalEditor]);

  // ★ 实时字数 + 持久化：直接监听 editor 的 'update' 事件，每次按键即触发
  // 不依赖 useEditor 的 onUpdate callback（某些 TipTap 版本不会更新闭包，导致持久化失效）
  // ★ 性能优化：字数计算与 store 下发均加防抖，避免每次按键都同步序列化全文 + 连锁重渲染
  //   - liveWordCount 本地下发：80ms 防抖（输入流畅，UI 更新及时）
  //   - store 下发：200ms 防抖（切断 LeftSidebar/WritingDashboard/ChapterStats 每按键重渲染）
  const liveWcTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const storeWcTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!editor) return;
    const handleEditorUpdate = () => {
      const cid = currentChapterIdRef.current;
      if (!cid) return;

      // ★ 使用 htmlToText 计算字数，与 resetWordCount 保持一致（避免切换章节后首次按键字数跳变）
      const content = editor.getHTML();
      const wc = htmlToText(content).length;

      // ★ 本地字数显示防抖 80ms：用户连续输入时只更新 UI，不阻塞主线程
      if (liveWcTimerRef.current) clearTimeout(liveWcTimerRef.current);
      liveWcTimerRef.current = setTimeout(() => {
        setLiveWordCount(wc);
      }, 80);

      // ★ store 下发防抖 200ms：切断 LeftSidebar 章节列表 + WritingDashboard + ChapterStats 的连锁重渲染
      // 之前每次按键都下发，导致所有订阅 liveWordCount 的组件重渲染，严重影响输入流畅度
      if (storeWcTimerRef.current) clearTimeout(storeWcTimerRef.current);
      storeWcTimerRef.current = setTimeout(() => {
        setStoreLiveWordCount(cid, wc);
      }, 200);

      // ★ 空编辑器默认内容：区分 mount 竞态与用户主动清空
      // mount 竞态：编辑器刚 mount 时空内容，且 store 中该章节也无真实内容 → 跳过
      // 用户主动清空：编辑器之前有真实内容（prevWordCount>20），即使现在为空也要 flush
      const isEmptyDefault = content === '<p></p>' || content === '' || content === '<p><br></p>';
      if (isEmptyDefault) {
        const storeWc = useChapterStore.getState().chapters.find(c => c.id === cid)?.wordCount ?? 0;
        if (storeWc <= 20 && prevWordCount.current <= 20) {
          // mount 竞态或本来就是空章节：不调度 flush，避免覆盖真实数据
          return;
        }
      }

      // 字数统计
      const diff = wc - prevWordCount.current;
      if (diff > 0) addWordsRef.current(diff);

      // 检测从有到无的边界：之前 >20 字，现在 ≤20 字
      // 在更新 prevWordCount 之前捕获，避免被中间状态覆盖
      if (prevWordCount.current > 20 && wc <= 20) {
        pendingFromFullToEmptyRef.current = true;
      }
      // ★ 反向重置：用户从 ≤20 字恢复到 >20 字时撤销清理标记
      // 防止场景：100字→15字（标记true）→100ms内输回50字，下一次 flushPersist 仍误触发 cascadeClean
      if (wc > 20) {
        pendingFromFullToEmptyRef.current = false;
      }
      prevWordCount.current = wc;

      // 持久化防抖缓冲
      pendingContentRef.current = content;
      pendingWordCountRef.current = wc;
      pendingChapterIdRef.current = cid;
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(flushPersist, 100);

      // 孤立伏笔清理 + 样式分析（编辑器停 200ms 才跑）
      if (styleTimerRef.current) clearTimeout(styleTimerRef.current);
      styleTimerRef.current = setTimeout(() => {
        try {
          const allForeshadows = useForeshadowStore.getState().foreshadows;
          const currentAnnotations = useAnnotationStore.getState().annotations;
          const annotationIdSet = new Set(currentAnnotations.map((a) => a.id));
          const orphaned = allForeshadows.filter(
            (f) => f.seedAnnotationId && !annotationIdSet.has(f.seedAnnotationId),
          );
          if (orphaned.length > 0) {
            const deleteFn = deleteForeshadowRef.current;
            orphaned.forEach((f) => deleteFn(f.id));
          }
        } catch (e) {
          console.warn('[useEditorInstance] 清理孤立伏笔失败:', e);
        }
        const c = pendingContentRef.current;
        if (c) {
          const suggestion = analyzeLocalStyle(c, styleProfileRef.current);
          if (suggestion) {
            // 当前没有 setState 出口，预留位
          }
        }
      }, 300);
    };

    // ★ 不在 mount 时立即调用 handleEditorUpdate()：
    // editor 刚创建时内容为 <p></p>，立即调用会把空内容（wordCount=1）
    // 调度 flushPersist，覆盖 store 和后端的真实内容。
    // 真实内容由 EditorPage 的 setContent 注入，后续用户输入才触发 flush。
    editor.on('update', handleEditorUpdate);
    // ★ selectionUpdate 不再重算字数：光标移动时内容不变，重新序列化全文（getHTML+htmlToText）
    //   是 O(n) 主线程同步任务，长章节下连续移动光标会明显卡顿。
    //   字数已由 update 事件负责维护，selectionUpdate 无需重复计算。
    //   仅保留事件监听以便未来扩展（如光标位置 UI），但不再执行重计算。
    const handleSelectionUpdate = () => {
      // no-op: 字数由 update 事件维护，光标移动不触发重算
    };
    editor.on('selectionUpdate', handleSelectionUpdate);
    return () => {
      editor.off('update', handleEditorUpdate);
      editor.off('selectionUpdate', handleSelectionUpdate);
      // ★ 清理字数防抖定时器，防止卸载后仍 setState
      if (liveWcTimerRef.current) {
        clearTimeout(liveWcTimerRef.current);
        liveWcTimerRef.current = null;
      }
      if (storeWcTimerRef.current) {
        clearTimeout(storeWcTimerRef.current);
        storeWcTimerRef.current = null;
      }
    };
  }, [editor, flushPersist]);

  // 主角 / 女主角名字高亮：角色数据变化时更新扩展的 names 并重建 decoration
  useEffect(() => {
    if (!editor) return;
    const leadNames = characters
      .filter(c => c.role === 'protagonist' || c.role === 'femaleLead')
      .flatMap(c => [c.name, ...(c.aliases ?? [])])
      .filter(Boolean);
    // 直接更新扩展 options，再派发空 transaction 让 plugin 重建 decoration
    const ext = editor.extensionManager.extensions.find(e => e.name === 'leadCharacterHighlight');
    if (ext) ext.options.names = leadNames;
    const { state, view } = editor;
    const tr = state.tr;
    tr.setMeta('leadCharacterHighlightUpdate', true);
    view.dispatch(tr);
  }, [editor, characters]);

  // ★ editor ref：供 beforeunload/visibilitychange 回调读取最新编辑器实例
  // （事件回调闭包捕获的 editor 可能为 null，因为 useEditor 首次渲染返回 null）
  const editorRef = useRef(editor);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    return () => {
      if (styleTimerRef.current) {
        clearTimeout(styleTimerRef.current);
        styleTimerRef.current = null;
      }
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        flushPersist();
      }
      // 清理标志，避免下一次 flush 误触发 cascade clean
      pendingFromFullToEmptyRef.current = false;
    };
  }, [flushPersist]);

  // ★ 页面隐藏/卸载前强制落盘，防止刷新或关闭导致编辑器缓冲区内容丢失。
  // 1. 先 flushPersist 把 debounce 缓冲区内容写入 store（同步，HMR 场景下有用）
  // 2. 再用 fetch keepalive 兜底发送 PUT 到后端（页面卸载场景，syncService 的异步 fetch 会被 abort）
  useEffect(() => {
    const flushToBackend = () => {
      const ed = editorRef.current;
      const cid = currentChapterIdRef.current;
      if (!ed || !cid) return;

      // 1. 先 flush 缓冲区到 store（同步操作）
      if (pendingContentRef.current !== null && pendingChapterIdRef.current) {
        flushPersist();
      }

      // 2. 使用 keepalive fetch 兜底发送到后端
      // keepalive: true 确保请求在页面卸载后仍能完成（最多 64KB body）
      const content = ed.getHTML();
      const wordCount = htmlToText(content).length;
      const token = getToken();
      // ★ 断言 C：API base 只由 data-core 的 apiClient 决定（resolveApiUrl），
      //   此处不再读 import.meta.env.VITE_API_BASE_URL / 硬编码 '/api'。
      const baseUrl = resolveApiUrl('');
      const body = JSON.stringify({ content, wordCount, updatedAt: Date.now() });

      // ★ keepalive body 限制 64KB，长章节（约 1.5 万字以上）超限时浏览器静默丢弃。
      // 此处本地缓存（cacheChapterContent）已在 flushPersist 中落盘兜底，
      // 超限请求不发送，下次加载时从缓存恢复。避免无意义的失败请求。
      if (body.length > 60000) {
        console.warn(`[flushToBackend] 章节 ${cid} body ${body.length}B 超 60KB，跳过 keepalive PUT，依赖本地缓存恢复`);
        return;
      }

      // ★ 本项目所有项目级路由（含 PUT /api/chapters/:id）都靠 requireProjectScope
      // 从 X-Project-Id 头（或 URL :projectId）取 projectId，缺失直接 400。
      // 这里用原生 fetch 绕过了 apiClient，必须手工补上该头 —— 否则这道
      // 「防丢稿」最后防线每次都是 400 静默失败（实测抓包：headerKeys 只有
      // Content-Type，无 X-Project-Id）。
      //
      // ★ 冷开竞态：直接刷新 /project/:bookId/:chapterId 时 store 是空的，
      //   ProjectLayout 需要一次异步往返才能把项目元数据写回 store。在这个窗口内
      //   getCurrentProjectId() 返回 undefined —— 只靠它会漏掉头而 400。
      //   而 URL 里的 bookId 是**同步可用**的，故优先 store、兜底 URL。
      const projectId = getCurrentProjectId() || urlBookIdRef.current;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (projectId) headers['X-Project-Id'] = projectId;

      fetch(`${baseUrl}/chapters/${cid}`, {
        method: 'PUT',
        headers,
        body,
        keepalive: true,
      }).catch(() => { /* silent: 页面正在卸载，错误无法告知用户 */ });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushToBackend();
      }
    };

    const handlePageHide = () => {
      flushToBackend();
    };

    // ★ beforeunload：与 pagehide 互补，覆盖「刷新/关页」场景。
    // flushToBackend 内部会先同步 flushPersist（写入 store + 本地缓存），
    // 再用 keepalive 兜底发后端，最大限度避免未落库内容丢失。
    const handleBeforeUnload = () => {
      flushToBackend();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [flushPersist]);

  // 手动重置字数（切换章节时调用，避免 liveWordCount 停留在上一章的值）
  const resetWordCount = useCallback((wc: number) => {
    setLiveWordCount(wc);
    prevWordCount.current = wc;
    // ★ 同步到 store，切换章节时 LeftSidebar 立即显示新章节的字数
    const cid = currentChapterIdRef.current;
    if (cid) setStoreLiveWordCount(cid, wc);
  }, [setStoreLiveWordCount]);

  return { editor, prevWordCount, liveWordCount, resetWordCount };
}

export function useIndependentEditor(initialContent?: string) {
  return useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: '写吧...',
      }),
      CustomHighlight.configure({ multicolor: true }),
      CharacterCount,
    ],
    content: initialContent || '',
    editorProps: {
      attributes: {
        class: 'ProseMirror',
      },
    },
  });
}
