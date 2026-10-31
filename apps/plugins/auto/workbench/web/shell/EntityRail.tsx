// ============================================================
// ⚠️ 已停用（2026-09-15）—— 不要再往这里加功能
//
// AI 写作工作台的「实体与设定」看板现在直接挂手写模式的关系图谱
// （`components/knowledge/RelationGraph`），卡片式存量列表不再被挂载。
//
// 是否物理删除**待拍板**（先标注、不擅自删）。
// ============================================================
//
// EntityRail — AI 写作工作台的**右列实体栏**
//
// 布局角色：三列里的最右一列，窄而高，把知识库类数据竖着堆起来，
//   与中下侧的数据面板一起"包围"中间的正文方块。
//
// 与 WorldStateBoard 的分工：
//   WorldStateBoard（中下）  —— 需要宽度的**流式**信息：本章计划、最近变动
//   EntityRail（右）         —— 并列的**存量**信息：知识库 / 地点 / 物品 / 伏笔
//
// 数据全部来自项目 store；配色一律走语义变量（`--entity-*`），换肤自动跟随。
// ============================================================

import { useMemo } from 'react';
import { BookMarked, Lightbulb, MapPin, Package, Users } from 'lucide-react';
import type { Foreshadow, Item, Location, Character } from '@novel/shared';
import {
  useCharacterStore,
  useForeshadowStore,
  useItemStore,
  useLocationStore,
} from '@novel-plugins/data-core/stores';

interface EntityRailProps {
  projectId: string;
}

/**
 * 实体栏卡片：图标 + 标题 + 计数，内容区可滚。
 * ★ 2026-09-15 重做：原样式是为**窄侧栏**调的（背景 `card/0.5` 几乎透明、
 *   字号 10–11px、内边距 `px-2.5`）。看板改成「页面切换、占满」后这块区域变宽了，
 *   那套参数就表现为「一片平铺的文本、看不出分区」。现在：
 *   · 背景改为**不透明** card —— 卡片边界才立得住
 *   · 边框 1px、加极轻投影 —— 在纸白底上给一层"浮起"
 *   · 标题栏加浅底 + 字号 12.5px、内边距 px-3 py-3
 */
function RailCard({ icon: Icon, title, count, color, children }: {
  icon: typeof Users;
  title: string;
  count?: number;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="rounded-xl overflow-hidden flex flex-col"
      style={{
        background: 'hsl(var(--card))',
        border: '1px solid hsl(var(--border) / 0.7)',
        boxShadow: '0 1px 3px hsl(var(--ink) / 0.04)',
      }}
    >
      <header
        className="flex items-center gap-2 px-3 py-2.5"
        style={{
          borderBottom: '1px solid hsl(var(--border) / 0.5)',
          background: 'hsl(var(--muted) / 0.5)',
        }}
      >
        <Icon size={13} style={{ color }} aria-hidden="true" />
        <span className="text-[11.5px] font-medium" style={{ color: 'hsl(var(--ink))' }}>
          {title}
        </span>
        {typeof count === 'number' && (
          <span className="ml-auto text-[11px] tabular-nums" style={{ color: 'hsl(var(--muted-foreground))' }}>
            {count}
          </span>
        )}
      </header>
      <div className="px-3 py-3">{children}</div>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
      {text}
    </div>
  );
}

export function EntityRail({ projectId }: EntityRailProps) {
  const items = useItemStore((s) => s.items);
  const foreshadows = useForeshadowStore((s) => s.foreshadows);
  const characters = useCharacterStore((s) => s.characters);
  const locations = useLocationStore((s) => s.locations);

  const pItems = useMemo(() => items.filter((i) => i.projectId === projectId) as Item[], [items, projectId]);
  const pFsh = useMemo(() => foreshadows.filter((f) => f.projectId === projectId) as Foreshadow[], [foreshadows, projectId]);
  const pChars = useMemo(() => characters.filter((c) => c.projectId === projectId) as Character[], [characters, projectId]);
  const pLocs = useMemo(() => locations.filter((l) => l.projectId === projectId) as Location[], [locations, projectId]);

  /** 知识库汇总：角色 / 地点 / 物品 / 伏笔 四项存量 */
  const libTotal = pChars.length + pLocs.length + pItems.length + pFsh.length;
  const openFsh = pFsh.filter((f) => f.status !== 'payed_off' && f.status !== 'abandoned').length;

  return (
    <div className="h-full overflow-y-auto">
      {/* ★ 2026-09-15：宽屏改为**多列网格**。5 张存量卡片并排陈列，「结构」才一眼看得出来 ——
          原来一长条垂直堆叠，在变宽后的区域里既浪费横向空间、又读不出分区。
          「知识库」是汇总卡排第一；伏笔、角色是写作时查得最勤的，紧随其后。 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3">

      <RailCard icon={BookMarked} title="知识库" count={libTotal} color="hsl(var(--primary))">
        <ul className="space-y-1">
          {[
            { label: '角色', n: pChars.length, c: 'hsl(var(--entity-character))' },
            { label: '地点', n: pLocs.length, c: 'hsl(var(--entity-location))' },
            { label: '物品', n: pItems.length, c: 'hsl(var(--entity-item))' },
            { label: '伏笔', n: pFsh.length, c: 'hsl(var(--entity-foreshadow))' },
          ].map((row) => (
            <li key={row.label} className="flex items-center gap-1.5 text-[11px]">
              <span
                className="rounded-full"
                style={{ width: 5, height: 5, background: `hsl(${row.c})` }}
                aria-hidden="true"
              />
              <span style={{ color: 'hsl(var(--ink-light))' }}>{row.label}</span>
              <span className="ml-auto tabular-nums" style={{ color: 'hsl(var(--muted-foreground))' }}>
                {row.n}
              </span>
            </li>
          ))}
        </ul>
      </RailCard>

      <RailCard icon={MapPin} title="地点" count={pLocs.length} color="hsl(var(--entity-location))">
        {pLocs.length === 0 ? (
          <Empty text="暂无地点" />
        ) : (
          <ul className="space-y-1">
            {pLocs.slice(0, 8).map((l) => (
              <li key={l.id} className="text-[11px] truncate" style={{ color: 'hsl(var(--ink-light))' }} title={l.name}>
                {l.name}
              </li>
            ))}
            {pLocs.length > 8 && (
              <li className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                还有 {pLocs.length - 8} 处…
              </li>
            )}
          </ul>
        )}
      </RailCard>

      <RailCard icon={Package} title="物品" count={pItems.length} color="hsl(var(--entity-item))">
        {pItems.length === 0 ? (
          <Empty text="暂无物品" />
        ) : (
          <ul className="space-y-1">
            {pItems.slice(0, 6).map((it) => {
              const last = (it.states ?? []).slice().sort((a, b) => b.chapter - a.chapter)[0];
              return (
                <li key={it.id} className="text-[11px] truncate" style={{ color: 'hsl(var(--ink-light))' }} title={`${it.name}${last ? ` · Ch${last.chapter} ${last.newValue}` : ''}`}>
                  {it.name}
                  {last && (
                    <span className="text-[10px] ml-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      {last.newValue}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </RailCard>

      <RailCard
        icon={Lightbulb}
        title="伏笔"
        count={pFsh.length}
        color="hsl(var(--entity-foreshadow))"
      >
        {pFsh.length === 0 ? (
          <Empty text="暂无伏笔" />
        ) : (
          <>
            {openFsh > 0 && (
              <div className="text-[10px] mb-1.5" style={{ color: 'hsl(var(--state-running))' }}>
                {openFsh} 条未回收
              </div>
            )}
            <ul className="space-y-1">
              {pFsh.slice(0, 6).map((f) => {
                const open = f.status !== 'payed_off' && f.status !== 'abandoned';
                return (
                  <li key={f.id} className="flex items-baseline gap-1 text-[11px]">
                    <span className="truncate" style={{ color: 'hsl(var(--ink-light))' }} title={f.description}>
                      {f.description}
                    </span>
                    <span
                      className="ml-auto shrink-0 text-[10px]"
                      style={{ color: open ? 'hsl(var(--state-running))' : 'hsl(var(--state-done))' }}
                    >
                      {open ? `Ch${f.seedChapter}` : '✓'}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </RailCard>

      {/* 角色卡：与"知识库"汇总有重叠，但角色是写作最常查的，值得单列 */}
      <RailCard icon={Users} title="角色" count={pChars.length} color="hsl(var(--entity-character))">
        {pChars.length === 0 ? (
          <Empty text="暂无角色" />
        ) : (
          <ul className="space-y-1">
            {pChars.slice(0, 6).map((c) => (
              <li key={c.id} className="flex items-baseline gap-1 text-[11px]">
                <span className="truncate" style={{ color: 'hsl(var(--ink-light))' }}>{c.name}</span>
                {c.role && (
                  <span className="ml-auto shrink-0 text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {c.role === 'protagonist' ? '主角' : c.role === 'femaleLead' ? '女主' : c.role === 'supporting' ? '配角' : '路人'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </RailCard>
      </div>
    </div>
  );
}
