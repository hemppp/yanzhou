// ============================================================
// 实体识别偏好（自动识别开关）
//
// 为什么是 localStorage 而不是服务端设置：本构建没有客户端红石开关来源
// （见 ai/aiCapabilityProvider.ts 头注：服务端 user_settings 既无读写 API 也无面板 UI）。
// 这是一个**本机偏好**：关掉物品识别的人通常是因为这本书不写系统/装备流，
// 换台机器不该被同步走。
//
// 唯一一项：物品自动识别。关闭后扫描仍会输出物品行，但客户端不再新建物品，
// 只对**已有物品**做类型补全；物品流转也只匹配已有物品（不会因为关了开关
// 就丢掉已有装备的归属变化）。
// ============================================================

import { create } from 'zustand';

const ITEM_AUTO_DETECT_KEY = 'nm.manual.entityDetection.itemAutoDetect';

function readItemAutoDetect(): boolean {
  try {
    const raw = window.localStorage.getItem(ITEM_AUTO_DETECT_KEY);
    // 缺省开启：新用户不该先看到「什么都没识别出来」
    return raw === null ? true : raw === '1';
  } catch {
    // 隐私模式/配额异常：降级为开启（会话内仍可切）
    return true;
  }
}

function writeItemAutoDetect(enabled: boolean): void {
  try {
    window.localStorage.setItem(ITEM_AUTO_DETECT_KEY, enabled ? '1' : '0');
  } catch {
    // 存不下就只保留会话内状态
  }
}

interface EntityDetectionPrefsState {
  /** 是否允许自动扫描新建物品 */
  itemAutoDetect: boolean;
  setItemAutoDetect: (enabled: boolean) => void;
  toggleItemAutoDetect: () => void;
}

export const useEntityDetectionPrefs = create<EntityDetectionPrefsState>((set, get) => ({
  itemAutoDetect: readItemAutoDetect(),
  setItemAutoDetect: (enabled) => {
    writeItemAutoDetect(enabled);
    set({ itemAutoDetect: enabled });
  },
  toggleItemAutoDetect: () => {
    get().setItemAutoDetect(!get().itemAutoDetect);
  },
}));

/** 供非 React 代码（扫描回调）读取当前值 */
export function isItemAutoDetectEnabled(): boolean {
  return useEntityDetectionPrefs.getState().itemAutoDetect;
}