// ============================================================
// Electron preload 暴露的桌面端 API 类型（浏览器侧声明）
// 运行时由 apps/desktop/src/preload.ts 的 contextBridge 注入
// ============================================================

export {};

declare global {
  interface Window {
    desktopAPI?: {
      getVersion: () => Promise<string>;
      getDataPath: () => Promise<string>;
      relaunch: () => Promise<void>;
      updaterGetState: () => Promise<{
        appVersion: string;
        baseUrl: string;
        pluginsDir: string;
        plugins: Array<{ id: string; version: string | null; dir: string }>;
        progress: {
          phase: string;
          receivedBytes: number;
          totalBytes: number;
          percent: number;
          message: string;
        };
      }>;
      updaterSetBaseUrl: (baseUrl: string) => Promise<{ ok: boolean; baseUrl: string }>;
      updaterCheck: () => Promise<{
        ok: boolean;
        manifest?: unknown;
        appOutdated?: boolean;
        pluginUpdates?: unknown[];
        error?: string;
      }>;
      updaterApplyApp: () => Promise<{ ok: boolean; version?: string; notes?: string; error?: string }>;
      updaterInstallPlugin: (pluginId: string) => Promise<{ ok: boolean; id?: string; version?: string; notes?: string; error?: string }>;
      updaterRelaunch: () => Promise<{ ok: boolean }>;
    };
  }
}
