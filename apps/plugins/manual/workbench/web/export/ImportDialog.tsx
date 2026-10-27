import { useState, useRef } from 'react';
import { Upload, Loader2 } from 'lucide-react';
import { nanoid } from 'nanoid';
import { import砚舟Package } from '../services/misc/projectExportService';
import { htmlToText } from '@novel-plugins/data-core/editor/entityDetector';
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

export function ImportDialog() {
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setMessage('');

    try {
      const pkg = await import砚舟Package(file);

      const projectId = nanoid();
      const now = Date.now();

      useProjectStore.getState().setProject({
        id: projectId,
        userId: 'local-user',
        name: pkg.project.name,
        description: pkg.project.description,
        penName: pkg.project.penName,
        genre: pkg.project.genre,
        targetWordCount: pkg.project.targetWordCount,
        currentWordCount: pkg.chapters.reduce((s, ch) => s + htmlToText(ch.content || '').length, 0),
        createdAt: now,
        updatedAt: now,
      });

      const chapterIdMap = new Map<string, string>();
      pkg.chapters.forEach((ch) => {
        const newId = nanoid();
        chapterIdMap.set(ch.id, newId);
        const chapterWordCount = htmlToText(ch.content || '').length;
        useChapterStore.getState().addChapter({
          id: newId, projectId, title: ch.title, content: ch.content || '',
          order: ch.order + 1, wordCount: chapterWordCount,
          status: (ch.status as 'draft' | 'revised' | 'final' | 'archived') || 'draft',
          summary: ch.summary, createdAt: now, updatedAt: now,
        });
      });

      pkg.characters.forEach((ch) => {
        useCharacterStore.getState().addCharacter({ ...ch, projectId, thumbnail: undefined, createdAt: now, updatedAt: now });
      });

      pkg.items.forEach((it) => {
        useItemStore.getState().addItem({ ...it, projectId, thumbnail: undefined, color: undefined, currentHolders: it.currentHolders ?? [], relations: it.relations ?? [], createdAt: now, updatedAt: now });
      });

      pkg.locations.forEach((loc) => {
        useLocationStore.getState().addLocation({ ...loc, projectId, thumbnail: undefined, color: undefined, createdAt: now, updatedAt: now });
      });

      pkg.foreshadows.forEach((fs) => {
        useForeshadowStore.getState().addForeshadow({
          ...fs, projectId, type: fs.type as never, status: fs.status as never,
          seedAnnotationId: undefined, payoffText: undefined, payoffAnnotationId: undefined,
          createdAt: now, updatedAt: now,
        });
      });

      pkg.earmarks.forEach((em) => {
        const mappedChapterId = chapterIdMap.get(em.chapterId) || em.chapterId;
        useEarmarkStore.getState().addEarmark({
          ...em, projectId, chapterId: mappedChapterId, type: em.type as never, createdAt: now, updatedAt: now,
        });
      });

      pkg.outlineNodes.forEach((node) => {
        const mappedLinkedChapterIds = node.linkedChapterIds.map((cid) => chapterIdMap.get(cid) || cid);
        useOutlineStore.getState().addNode({
          ...node, projectId, linkedChapterIds: mappedLinkedChapterIds, type: node.type as never, createdAt: now, updatedAt: now,
        });
      });

      pkg.timelineEvents.forEach((ev) => {
        useTimelineStore.getState().addEvent({ ...ev, projectId, type: ev.type as never, createdAt: now, updatedAt: now });
      });

      pkg.notes.forEach((n) => {
        const mappedLinkedChapterId = n.linkedChapterId ? chapterIdMap.get(n.linkedChapterId) || n.linkedChapterId : undefined;
        useNoteStore.getState().addNote({ ...n, projectId, linkedChapterId: mappedLinkedChapterId, createdAt: now, updatedAt: now });
      });

      setMessage(`成功导入 ${pkg.chapters.length}章 ${pkg.characters.length}角色 ${pkg.foreshadows.length}伏笔 ${pkg.items.length}物品 ${pkg.locations.length}地点`);
    } catch (err) {
      setMessage(`导入失败: ${err instanceof Error ? err.message : '未知错误'}`);
    }

    setImporting(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="mc-modal h-full overflow-y-auto p-4 space-y-4 mc-scrollbar">
      <h2 className="mc-title flex items-center gap-2">
        <Upload size={20} />
        导入项目
      </h2>

      <div
        onClick={() => fileRef.current?.click()}
        className={`mc-card border-2 border-dashed p-8 text-center cursor-pointer ${importing ? 'animate-mc-place' : ''}`}
      >
        {importing ? (
          <Loader2 size={32} className="mx-auto mb-2 animate-spin text-muted-foreground" />
        ) : (
          <Upload size={32} className="mx-auto mb-2 text-muted-foreground" />
        )}
        <p className="mc-title-sm">
          {importing ? '导入中...' : '点击选择 .novelmuse 文件'}
        </p>
        <input ref={fileRef} type="file" accept=".novelmuse,.json" onChange={handleFile} className="hidden" />
      </div>

      {message && (
        <div className={`mc-text-sm p-3 rounded-2xl ${message.startsWith('成功') ? 'mc-auth-success' : 'mc-auth-error'}`}>
          {message}
        </div>
      )}
    </div>
  );
}
