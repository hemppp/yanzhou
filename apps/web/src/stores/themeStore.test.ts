// ============================================================
// themeStore.test.ts —— 主题档 / 字体偏好的运行时自证（2026-11-09 加档）
//
// 测的是**store 的行为契约**，不是配色本身（配色由 themes.css 与
//   scripts/verify/verify-theme-single-source.mjs 各自把关）。
//
// 为什么每个用例都要 resetModules + 动态 import：
//   themeStore 的 `const initial = readStored()` 是**模块加载时**求值的，
//   静态 import 会让所有用例共用第一次加载时读到的初值 ⇒ 测不到「首屏读存储」。
//
// ⚠️ 这里通过 `@/stores/themeStore` 这个**转发壳**引入（它就是 ui-kit 的
//   `export *`）—— 与真实消费方走同一条路径，避免测试绕过薄壳自证。
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const THEME_KEY = 'novelmuse:theme';
const FONT_KEY = 'novelmuse:fonts';

/** 重新加载 store 模块（读取当前 localStorage 作为初值） */
async function loadStore() {
  vi.resetModules();
  return await import('./themeStore');
}

function html() {
  return document.documentElement;
}

beforeEach(() => {
  window.localStorage.clear();
  html().removeAttribute('data-theme');
  html().classList.remove('dark');
  html().removeAttribute('style');
});

afterEach(() => {
  vi.resetModules();
});

describe('主题档：默认与回落', () => {
  it('无存储时落到默认档（VS Code Modern / 亮色）', async () => {
    const { useThemeStore, DEFAULT_THEME, DEFAULT_MODE } = await loadStore();
    expect(useThemeStore.getState().theme).toBe(DEFAULT_THEME);
    expect(useThemeStore.getState().mode).toBe(DEFAULT_MODE);
  });

  it('存的是未知主题名 ⇒ 静默回落到默认档（不抛错、不写回）', async () => {
    // 旧的「三档水墨」主题名与任意垃圾值走同一条分支
    window.localStorage.setItem(THEME_KEY, JSON.stringify({ theme: 'soot', mode: 'dark' }));
    const { useThemeStore, DEFAULT_THEME, DEFAULT_MODE } = await loadStore();
    expect(useThemeStore.getState().theme).toBe(DEFAULT_THEME);
    expect(useThemeStore.getState().mode).toBe(DEFAULT_MODE);
    // 回落的判定不靠「读时改写存储」—— 存储值原样留着
    expect(window.localStorage.getItem(THEME_KEY)).toBe(JSON.stringify({ theme: 'soot', mode: 'dark' }));
  });

  it('存储损坏（非 JSON）不抛错，回落默认档', async () => {
    window.localStorage.setItem(THEME_KEY, '{不是 JSON');
    const { useThemeStore, DEFAULT_THEME } = await loadStore();
    expect(useThemeStore.getState().theme).toBe(DEFAULT_THEME);
  });

  it('存的新档位被接受并落到 <html>（data-theme / .dark / color-scheme 三者同时）', async () => {
    window.localStorage.setItem(THEME_KEY, JSON.stringify({ theme: 'qingci', mode: 'dark' }));
    const { useThemeStore, applyStoredTheme } = await loadStore();
    applyStoredTheme();
    expect(useThemeStore.getState().theme).toBe('qingci');
    expect(html().dataset.theme).toBe('qingci');
    expect(html().classList.contains('dark')).toBe(true);
    expect(html().style.colorScheme).toBe('dark');
  });
});

describe('主题档：切档与锁定明暗', () => {
  it('setTheme 写 data-theme、持久化，并保留当前明暗档', async () => {
    const { useThemeStore, applyStoredTheme } = await loadStore();
    applyStoredTheme();
    useThemeStore.getState().setMode('dark');
    useThemeStore.getState().setTheme('sujian');
    expect(html().dataset.theme).toBe('sujian');
    expect(html().classList.contains('dark')).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(THEME_KEY)!)).toEqual({ theme: 'sujian', mode: 'dark' });
  });

  it('未知主题 id 不被接受（不写存储、不改 DOM）', async () => {
    const { useThemeStore, applyStoredTheme } = await loadStore();
    applyStoredTheme();
    // @ts-expect-error 故意传非法值，验证运行时守卫
    useThemeStore.getState().setTheme('nope');
    expect(useThemeStore.getState().theme).toBe('vscode-dark-modern');
    expect(html().dataset.theme).toBe('vscode-dark-modern');
  });

  it('「夜航」锁定暗色：切档即暗色，且 setMode("light") 被忽略', async () => {
    const { useThemeStore, applyStoredTheme } = await loadStore();
    applyStoredTheme();
    useThemeStore.getState().setTheme('yehang');
    expect(useThemeStore.getState().mode).toBe('dark');
    expect(html().classList.contains('dark')).toBe(true);
    expect(html().style.colorScheme).toBe('dark');

    useThemeStore.getState().setMode('light');
    // 三项都不动 —— 「不写存储、不改 DOM」是本 store 的一贯纪律
    expect(useThemeStore.getState().mode).toBe('dark');
    expect(html().classList.contains('dark')).toBe(true);
    expect(html().style.colorScheme).toBe('dark');
    expect(JSON.parse(window.localStorage.getItem(THEME_KEY)!)).toEqual({ theme: 'yehang', mode: 'dark' });
  });

  it('从锁定档切回普通档：明暗解冻可切', async () => {
    const { useThemeStore, applyStoredTheme } = await loadStore();
    applyStoredTheme();
    useThemeStore.getState().setTheme('yehang');
    useThemeStore.getState().setTheme('xuanzhi');
    useThemeStore.getState().setMode('light');
    expect(useThemeStore.getState().mode).toBe('light');
    expect(html().classList.contains('dark')).toBe(false);
    expect(html().style.colorScheme).toBe('light');
  });
});

describe('字体偏好：覆盖主题档', () => {
  it('默认无覆盖：不写行内自定义属性（= 跟随主题档）', async () => {
    const { useThemeStore, applyStoredFonts } = await loadStore();
    applyStoredFonts();
    expect(useThemeStore.getState().fonts).toEqual({});
    expect(html().style.getPropertyValue('--yz-font-reading')).toBe('');
  });

  it('setFont 写**行内**自定义属性并持久化（行内才能压过主题档的 (0,2,1)）', async () => {
    const { useThemeStore } = await loadStore();
    useThemeStore.getState().setFont('reading', 'kai');
    expect(html().style.getPropertyValue('--yz-font-reading')).toContain('KaiTi');
    expect(JSON.parse(window.localStorage.getItem(FONT_KEY)!)).toEqual({ reading: 'kai' });
  });

  it('setFont(kind, undefined) 清除覆盖 ⇒ 回落到主题档', async () => {
    const { useThemeStore } = await loadStore();
    useThemeStore.getState().setFont('reading', 'kai');
    useThemeStore.getState().setFont('reading', undefined);
    expect(html().style.getPropertyValue('--yz-font-reading')).toBe('');
    expect(JSON.parse(window.localStorage.getItem(FONT_KEY)!)).toEqual({});
  });

  it('未注册的字体 id 不接受；该字族不允许的字体也不接受', async () => {
    const { useThemeStore } = await loadStore();
    // @ts-expect-error 未注册 id
    useThemeStore.getState().setFont('reading', 'comic-sans');
    expect(html().style.getPropertyValue('--yz-font-reading')).toBe('');
    // 'kai' 只允许用在 reading / display，界面字体不接受它
    useThemeStore.getState().setFont('ui', 'kai');
    expect(html().style.getPropertyValue('--yz-font-ui')).toBe('');
    expect(window.localStorage.getItem(FONT_KEY)).toBeNull();
  });

  it('读存储时丢弃非法项，合法项保留；损坏 JSON 回落空', async () => {
    window.localStorage.setItem(FONT_KEY, JSON.stringify({ ui: 'kai', reading: 'song', display: '不存在' }));
    const { useThemeStore, applyStoredFonts } = await loadStore();
    applyStoredFonts();
    // ui:'kai' 非法（该族不允许）、display 非法（未注册）⇒ 都被丢弃
    expect(useThemeStore.getState().fonts).toEqual({ reading: 'song' });

    window.localStorage.setItem(FONT_KEY, '不是 JSON');
    const again = await loadStore();
    expect(again.readStoredFonts()).toEqual({});
  });

  it('字体与主题的存储键彼此独立', async () => {
    const { useThemeStore } = await loadStore();
    useThemeStore.getState().setTheme('xuanzhi');
    useThemeStore.getState().setFont('reading', 'song');
    expect(JSON.parse(window.localStorage.getItem(THEME_KEY)!).theme).toBe('xuanzhi');
    expect(JSON.parse(window.localStorage.getItem(FONT_KEY)!)).toEqual({ reading: 'song' });
  });
});
