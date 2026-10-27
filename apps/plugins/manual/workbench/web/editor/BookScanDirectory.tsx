// ============================================================
// BookScanDirectory — 参考书面板·书源导航（novel.bookscan 插件数据源）
// 多书源（晋江/番茄/七猫）榜单浏览，一键收藏进参考书；
// 收藏后可在 AI 对话面板发起拆书，拆完报告自动回存参考书。
// ============================================================
import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertCircle, Plus, Check, RefreshCw, Library } from 'lucide-react';
import { apiClient } from '@novel-plugins/data-core/api/apiClient';
import { useReferenceStore } from '@novel-plugins/data-core/stores';
import { useProjectStore } from '@novel-plugins/data-core/stores';
import { useToast } from '@novel-plugins/ui-kit';

const ACCENT = 'hsl(0 0% 20%)'; // 水墨化：原霁青 #2383C7 → 浓墨

interface ScanSource {
  id: string;
  label: string;
  boards: Array<{ key: string; label: string }>;
}

export interface ScanItem {
  rank: number;
  title: string;
  author: string;
  novelId: string;
  intro: string;
  category: string;
  status?: string;
  meta?: string;
  url: string;
}

export function BookScanDirectory({ onGoLibrary }: { onGoLibrary: () => void }) {
  const projectId = useProjectStore((s) => s.currentProject?.id);
  const books = useReferenceStore((s) => s.books);
  const addBook = useReferenceStore((s) => s.addBook);
  const processing = useReferenceStore((s) => s.processing);
  const toast = useToast();

  const [sources, setSources] = useState<ScanSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [board, setBoard] = useState('');
  const [items, setItems] = useState<ScanItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const [collecting, setCollecting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const source = sources.find((s) => s.id === sourceId);

  useEffect(() => {
    void (async () => {
      try {
        const data = await apiClient.get<{ sources?: ScanSource[] }>(
          '/plugins/bookscan/sources',
          undefined,
          { silent: true },
        );
        const list = data.sources ?? [];
        setSources(list);
        const first = list[0];
        if (first) {
          setSourceId((cur) => cur || first.id);
          setBoard((cur) => cur || first.boards[0]?.key || '');
        }
      } catch {
        setError('扫榜服务不可用（novel.bookscan 插件未启用或后端未启动）');
      }
    })();
  }, []);

  useEffect(() => {
    if (!sourceId || !board) return;
    void (async () => {
      setLoading(true);
      setError(null);
      setStale(false);
      try {
        const data = await apiClient.get<{ items?: ScanItem[]; fetchedAt?: number; stale?: boolean }>(
          '/plugins/bookscan/rankings',
          { source: sourceId, board },
          { silent: true },
        );
        setItems(data.items ?? []);
        setFetchedAt(data.fetchedAt ?? null);
        setStale(!!data.stale);
      } catch (e) {
        setError(e instanceof Error ? e.message : '榜单抓取失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [sourceId, board]);

  // 已收藏判定：参考书 source 记录了书目详情页 URL
  const isCollected = useCallback(
    (item: ScanItem) => books.some((b) => b.source?.includes(item.url)),
    [books],
  );

  const handleCollect = useCallback((item: ScanItem) => {
    if (!projectId) {
      toast.warning('请先选择或创建项目后再收藏');
      return;
    }
    const boardLabel = source?.boards.find((b) => b.key === board)?.label ?? '';
    const sourceLabel = source?.label ?? '';
    setCollecting(item.novelId);
    void (async () => {
      try {
        await addBook({
          projectId,
          title: item.title,
          author: item.author || undefined,
          content: item.intro || item.title,
          source: `扫榜（${sourceLabel}·${boardLabel}） ${item.url}`,
        });
        toast.success(`《${item.title}》已收藏进书架，可在 AI 对话中发起拆书`);
      } finally {
        setCollecting(null);
      }
    })();
  }, [projectId, source, board, addBook, toast]);

  return (
    <div className="flex flex-col h-full text-xs">
      {/* 书源切换 */}
      <div className="shrink-0 flex flex-wrap items-center gap-1 px-3 pt-2.5 pb-1.5">
        {sources.map((s) => (
          <button
            key={s.id}
            onClick={() => {
              setSourceId(s.id);
              setBoard(s.boards[0]?.key ?? '');
              setItems([]);
            }}
            className="px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors"
            style={sourceId === s.id
              ? { background: ACCENT, color: '#fff' }
              : { background: 'rgba(0,0,0,0.04)', color: 'rgba(55,53,47,0.6)' }}
          >
            {s.label}
          </button>
        ))}
        <button
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-1 opacity-60 hover:bg-black/5 hover:opacity-100"
          title="强制重新抓取"
          onClick={() => sourceId && board && void (async () => {
            setLoading(true);
            setError(null);
            try {
              const data = await apiClient.get<{ items?: ScanItem[]; fetchedAt?: number; stale?: boolean }>(
                '/plugins/bookscan/rankings',
                { source: sourceId, board, refresh: '1' },
                { silent: true },
              );
              setItems(data.items ?? []);
              setFetchedAt(data.fetchedAt ?? null);
              setStale(!!data.stale);
            } catch (e) {
              setError(e instanceof Error ? e.message : '榜单抓取失败');
            } finally {
              setLoading(false);
            }
          })()}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* 榜单切换 */}
      {source && source.boards.length > 0 && (
        <div className="shrink-0 flex flex-wrap items-center gap-1 px-3 pb-1.5">
          {source.boards.map((b) => (
            <button
              key={b.key}
              onClick={() => setBoard(b.key)}
              // ★ 选择控件（板块切换），选中态靠 border/bg 表达 → 加 aria-pressed 让选中态语义显式可读
              aria-pressed={board === b.key}
              className="px-2 py-0.5 rounded-full text-[10px] transition-colors"
              style={board === b.key
                ? { background: 'rgba(35,131,199,0.14)', color: ACCENT, border: `1px solid rgba(35,131,199,0.4)` }
                : { background: 'transparent', color: 'rgba(55,53,47,0.5)', border: '1px solid rgba(0,0,0,0.08)' }}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

      {/* 状态行 */}
      <div className="shrink-0 px-3 pb-1 text-[10px]" style={{ color: 'rgba(55,53,47,0.35)' }}>
        {loading && '抓取中…'}
        {!loading && stale && <span className="text-amber-600">缓存数据（站点抓取失败）</span>}
        {!loading && !stale && fetchedAt && `更新于 ${new Date(fetchedAt).toLocaleTimeString()}`}
        {!loading && !fetchedAt && '选择书源与榜单'}
      </div>
      {error && (
        <div className="shrink-0 mx-3 mb-1.5 flex items-start gap-1.5 rounded-lg px-2 py-1.5" style={{ background: 'hsl(0 0% 40% / 0.06)', color: 'hsl(0 0% 38%)' }}>
          <AlertCircle size={12} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* 榜单列表 */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1" style={{ scrollbarWidth: 'thin' }}>
        {items.map((item) => {
          const collected = isCollected(item);
          const isCollecting = collecting === item.novelId;
          const isOpen = expanded === item.novelId;
          return (
            <div key={item.novelId} className="rounded-xl border px-2.5 py-1.5 transition-colors" style={{ borderColor: 'rgba(0,0,0,0.07)' }}>
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="w-5 shrink-0 text-center font-semibold" style={{ color: 'rgba(55,53,47,0.3)' }}>{item.rank}</span>
                <span className="truncate font-medium text-[11px]" style={{ color: '#37352f' }} title={item.intro || item.title}>{item.title}</span>
                {item.status && <span className="shrink-0 px-1 rounded text-[10px]" style={{ background: 'rgba(0,0,0,0.05)', color: 'rgba(55,53,47,0.5)' }}>{item.status}</span>}
                {item.meta && <span className="shrink-0 text-[10px]" style={{ color: 'rgba(55,53,47,0.4)' }}>{item.meta}</span>}
                <span className="ml-auto shrink-0 truncate max-w-16 text-[10px]" style={{ color: 'rgba(55,53,47,0.4)' }}>{item.author}</span>
              </div>
              {item.intro && (
                <div
                  className={`mt-0.5 pl-6 leading-5 cursor-pointer ${isOpen ? '' : 'line-clamp-2'}`}
                  style={{ paddingLeft: 'var(--space-8)', color: 'rgba(55,53,47,0.6)' }}
                  onClick={() => setExpanded(isOpen ? null : item.novelId)}
                  title={isOpen ? '收起文案' : '展开文案'}
                >
                  {item.intro}
                </div>
              )}
              <div className="mt-1 flex items-center gap-1.5" style={{ paddingLeft: 'var(--space-8)' }}>
                <button
                  onClick={() => handleCollect(item)}
                  disabled={collected || isCollecting || processing}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] transition-all hover:scale-[1.02] active:scale-95 disabled:cursor-not-allowed disabled:opacity-90"
                  style={collected
                    ? { background: 'hsl(0 0% 32% / 0.08)', borderWidth: '1px', borderStyle: 'solid', borderColor: 'hsl(0 0% 32% / 0.22)', color: 'hsl(0 0% 30%)' }
                    : { background: 'rgba(35,131,199,0.08)', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgba(35,131,199,0.22)', color: ACCENT }}
                  title={collected ? '已收藏进书架' : `收藏《${item.title}》，之后在 AI 对话中拆书`}
                >
                  {collected ? <Check size={11} /> : isCollecting ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                  {collected ? '已收藏' : '收藏'}
                </button>
                {collected && (
                  <button
                    onClick={onGoLibrary}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] transition-colors hover:bg-black/5"
                    style={{ color: 'rgba(55,53,47,0.5)' }}
                    title="前往书架查看"
                  >
                    <Library size={11} /> 去书架
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {!loading && items.length === 0 && !error && (
          <div className="py-8 text-center" style={{ color: 'rgba(55,53,47,0.3)' }}>该榜单暂无数据</div>
        )}
      </div>

      <div className="shrink-0 px-3 py-1.5 border-t text-[10px] text-center" style={{ borderColor: 'rgba(0,0,0,0.06)', color: 'rgba(55,53,47,0.3)' }}>
        收藏后到「AI 对话」发起拆书，拆完的报告会回到书架，点击即可查看
      </div>
    </div>
  );
}
