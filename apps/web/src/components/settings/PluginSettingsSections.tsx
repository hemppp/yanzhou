// ============================================================
// 插件设置区宿主 —— 渲染插件通过 ctx.registerSettingsSection 注册的配置区
//
// 宿主提供 nm-card 外壳、标题、说明与渲染边界；插件只交一个无 props 的内容组件，
// 自行通过 ctx.api 读写配置。放在各设置分类的原生区块之后。
// ============================================================

import React, { Suspense, useState } from 'react';
import { AlertTriangle, Puzzle } from 'lucide-react';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { usePluginRegistry, useProjectMode, filterByProjectMode } from '@/plugin/registry';
import type { SettingsCategory, SettingsSectionDef } from '@/plugin/types';

/** 区块级渲染边界：插件设置区抛错只隔离在本卡片内，重试 = 换 key 重挂 */
function SectionGuard({ title, children }: { title: string; children: React.ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ErrorBoundary
      key={attempt}
      fallback={
        <div className="flex flex-col items-start gap-2 py-3">
          <div className="flex items-center gap-2 text-[11px]" style={{ color: 'hsl(var(--ink-light) / 0.75)' }}>
            <AlertTriangle size={14} style={{ color: 'var(--state-running, #f59e0b)' }} />
            「{title}」设置区运行出错，已隔离
          </div>
          <button
            type="button"
            className="nm-btn-mist-soft px-3 py-1 rounded-md text-xs"
            onClick={() => setAttempt((a) => a + 1)}
          >
            重试
          </button>
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  );
}

function SectionCard({ def }: { def: SettingsSectionDef }) {
  const Icon = def.icon ?? Puzzle;
  const Component = def.Component;
  return (
    <section className="nm-card p-6">
      <h2 className="nm-section-title flex items-center gap-2">
        <Icon size={14} />
        {def.title}
      </h2>
      {def.description && (
        <p className="text-sm mb-5" style={{ color: 'hsl(var(--ink-light) / 0.65)' }}>
          {def.description}
        </p>
      )}
      <SectionGuard title={def.title}>
        <Suspense fallback={<div className="text-xs opacity-60">加载中...</div>}>
          <Component />
        </Suspense>
      </SectionGuard>
    </section>
  );
}

/**
 * 渲染挂在指定分类下的所有插件设置区。
 * @param category 设置分类；插件未声明 category 时默认归入 'plugins'
 */
export function PluginSettingsSections({ category }: { category: SettingsCategory }) {
  // ★ 按当前项目创作模式过滤：不适用于本模式的插件设置区不显示
  const mode = useProjectMode();
  const sections = filterByProjectMode(usePluginRegistry((s) => s.settingsSections), mode);
  const mine = sections.filter((s) => (s.category ?? 'plugins') === category);
  if (mine.length === 0) return null;
  return (
    <>
      {mine.map((def) => (
        <SectionCard key={def.key} def={def} />
      ))}
    </>
  );
}
