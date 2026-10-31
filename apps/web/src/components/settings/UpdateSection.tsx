// ============================================================
// 设置 → 更新 栏目 —— 远程更新（仅桌面端可用）
//
// 依赖 preload 暴露的 window.desktopAPI.updater*（Electron 环境）。
// 浏览器环境（web dev）隐藏或提示仅桌面端支持。
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { Download, RefreshCw, Plug, MonitorUp, Globe, ExternalLink } from 'lucide-react';

interface UpdaterState {
  appVersion: string;
  baseUrl: string;
  pluginsDir: string;
  plugins: Array<{ id: string; version: string | null; dir: string }>;
}

interface PluginUpdateInfo {
  id: string;
  name: string;
  version: string;
  url: string;
  sha256: string;
  notes?: string;
}

interface CheckResult {
  ok: boolean;
  appOutdated?: boolean;
  pluginUpdates?: PluginUpdateInfo[];
  error?: string;
}

export function UpdateSection() {
  const isDesktop = typeof window !== 'undefined' && !!window.desktopAPI?.updaterGetState;
  const [state, setState] = useState<UpdaterState | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  // 初始化：读取更新器状态
  useEffect(() => {
    const api = window.desktopAPI;
    if (!api) return;
    void api.updaterGetState().then((s) => {
      setState(s);
      setBaseUrl(s.baseUrl);
    });
  }, [isDesktop]);

  const doCheck = useCallback(async () => {
    const api = window.desktopAPI;
    if (!api) return;
    setChecking(true);
    setNotice('');
    try {
      const r = await api.updaterCheck();
      setCheckResult(r as CheckResult);
    } catch (err) {
      setNotice(`检查失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setChecking(false);
    }
  }, [isDesktop]);

  const saveBaseUrl = async () => {
    const api = window.desktopAPI;
    if (!api) return;
    const r = await api.updaterSetBaseUrl(baseUrl);
    setState((s) => (s ? { ...s, baseUrl: r.baseUrl } : s));
    setNotice(`更新源已保存: ${r.baseUrl || '（空，更新已关闭）'}`);
    setCheckResult(null);
  };

  const applyApp = async () => {
    const api = window.desktopAPI;
    if (!api) return;
    setBusy('app');
    setNotice('');
    try {
      const r = await api.updaterApplyApp();
      if (!r.ok) {
        setNotice(`应用更新失败: ${r.error ?? ''}`);
      } else {
        setNotice(`✅ 应用已更新到 v${r.version}，即将重启...`);
        setTimeout(() => void api.updaterRelaunch(), 1200);
      }
    } catch (err) {
      setNotice(`应用更新失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const installPlugin = async (id: string) => {
    const api = window.desktopAPI;
    if (!api) return;
    setBusy(`plugin:${id}`);
    setNotice('');
    try {
      const r = await api.updaterInstallPlugin(id);
      if (!r.ok) {
        setNotice(`插件更新失败: ${r.error ?? ''}`);
      } else {
        setNotice(`✅ 插件「${id}」已更新到 v${r.version}。重启应用后生效（插件重新扫描加载）。`);
      }
      void doCheck();
    } catch (err) {
      setNotice(`插件更新失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  if (!isDesktop) {
    return (
      <div className="text-sm p-3 rounded-md" style={{ background: 'rgb(var(--glass-tint) / 0.4)', color: 'hsl(var(--ink-light))' }}>
        远程更新仅桌面端可用（当前为浏览器模式）。桌面端在「设置 → 更新」中配置更新源后即可在线更新应用与插件。
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* 更新源配置 */}
      <div>
        <label className="nm-label text-sm flex items-center gap-1.5">
          <Globe size={13} /> 更新源地址（manifest.json 所在目录 URL）
        </label>
        <div className="flex gap-2 mt-1.5">
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://example.com/novelmuse-updates"
            className="nm-input-sm flex-1 px-3 py-1.5 text-sm font-mono"
          />
          <button onClick={() => void saveBaseUrl()} className="nm-btn-mist-primary px-3 py-1.5 text-sm rounded-md">
            保存
          </button>
          <button onClick={() => void doCheck()} disabled={checking || !state?.baseUrl}
            className="nm-btn-mist-soft px-3 py-1.5 text-sm rounded-md flex items-center gap-1">
            <RefreshCw size={13} className={checking ? 'animate-spin' : ''} />
            检查更新
          </button>
        </div>
        {state?.pluginsDir && (
          <div className="text-xs mt-1.5" style={{ color: 'hsl(var(--ink-light) / 0.5)' }}>
            插件目录: <code className="font-mono">{state.pluginsDir}</code>
          </div>
        )}
      </div>

      {/* 检查结果 */}
      {checkResult && !checkResult.ok && (
        <div className="text-sm p-3 rounded-md" style={{ background: 'color-mix(in srgb, hsl(var(--state-blocked, 0 84% 60%)) 10%, transparent)', color: 'hsl(var(--state-blocked, 0 84% 60%))' }}>
          {checkResult.error}
        </div>
      )}

      {notice && (
        <div className="text-sm p-3 rounded-md" style={{ background: 'rgb(var(--glass-tint) / 0.4)', color: 'hsl(var(--ink-light))' }}>
          {notice}
        </div>
      )}

      {/* 应用更新 */}
      {checkResult?.ok && (
        <div className="rounded-lg border p-4" style={{ borderColor: 'hsl(var(--border) / 0.5)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <MonitorUp size={15} />
                <span className="font-medium text-sm">应用本体（后端 + 前端）</span>
                <span className="text-xs font-mono" style={{ color: 'hsl(var(--ink-light) / 0.6)' }}>
                  当前 v{state?.appVersion}
                </span>
              </div>
              {checkResult.appOutdated ? (
                <div className="text-sm mt-1.5" style={{ color: 'hsl(var(--state-done, 142 71% 45%))' }}>
                  🎉 发现新版本（更新后重启生效）
                </div>
              ) : (
                <div className="text-sm mt-1.5" style={{ color: 'hsl(var(--ink-light) / 0.6)' }}>
                  已是最新版本
                </div>
              )}
            </div>
            {checkResult.appOutdated && (
              <button onClick={() => void applyApp()} disabled={busy === 'app'}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium"
                style={{ background: 'color-mix(in srgb, hsl(var(--state-done, 142 71% 45%)) 12%, transparent)', color: 'hsl(var(--state-done, 142 71% 45%))', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'color-mix(in srgb, hsl(var(--state-done, 142 71% 45%)) 35%, transparent)' }}>
                <Download size={13} />
                {busy === 'app' ? '下载并应用...' : '一键更新'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* 插件更新 */}
      {checkResult?.ok && (checkResult.pluginUpdates?.length ?? 0) > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
            <Plug size={14} /> 插件更新（{(checkResult.pluginUpdates ?? []).length} 个）
          </h3>
          <div className="space-y-2">
            {(checkResult.pluginUpdates ?? []).map((p) => (
              <div key={p.id} className="rounded-lg border p-3" style={{ borderColor: 'hsl(var(--border) / 0.5)' }}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{p.name || p.id}</span>
                      <span className="text-xs font-mono" style={{ color: 'hsl(var(--ink-light) / 0.5)' }}>{p.id}</span>
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: 'hsl(var(--ink-light) / 0.6)' }}>
                      新版本 v{p.version}
                      {p.notes ? ` — ${p.notes}` : ''}
                    </div>
                  </div>
                  <button onClick={() => void installPlugin(p.id)} disabled={busy === `plugin:${p.id}`}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium"
                    style={{ background: 'color-mix(in srgb, hsl(var(--state-done, 142 71% 45%)) 12%, transparent)', color: 'hsl(var(--state-done, 142 71% 45%))', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'color-mix(in srgb, hsl(var(--state-done, 142 71% 45%)) 35%, transparent)' }}>
                    <Download size={13} />
                    {busy === `plugin:${p.id}` ? '安装中...' : '更新'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 已安装插件 */}
      {state && state.plugins.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
            <Plug size={14} /> 已安装本地插件（{state.plugins.length}）
          </h3>
          <div className="space-y-1.5">
            {state.plugins.map((p) => (
              <div key={p.id} className="text-sm flex items-center gap-2 py-1">
                <span className="font-medium">{p.id}</span>
                <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgb(var(--glass-tint) / 0.4)', color: 'hsl(var(--ink-light))' }}>
                  v{p.version ?? '未知'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 说明 */}
      <div className="text-xs p-3 rounded-md" style={{ background: 'rgb(var(--glass-tint) / 0.3)', color: 'hsl(var(--ink-light) / 0.65)' }}>
        <ExternalLink size={11} className="inline mr-1" />
        更新源需提供 manifest.json（应用版本 + SHA-256 + 插件清单）。发布工具：<code className="font-mono">node apps/desktop/scripts/build-update.mjs</code>，
        生成的 release/updates/ 目录即为更新源。安全：下载后校验 SHA-256，解压防路径穿越，旧版本自动备份。
      </div>
    </div>
  );
}
