/**
 * 阅读设置：默认值、主题预设、深合并与持久化。
 * 设置对象的结构与 docs/API.md 中的契约严格一致（前端 store 使用同一份结构）。
 */

import { getSetting, setSetting } from './db.mjs';

export const DEFAULT_SETTINGS = {
  theme: 'light',

  // —— 背景 ——
  bgColor: '#ffffff',
  bgImage: '',
  bgOpacity: 100,
  textColor: '#2c2c2c',

  // —— 字体 ——
  fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Source Han Sans SC", sans-serif',
  fontSize: 19,
  fontWeight: 400,
  lineHeight: 1.8,
  letterSpacing: 0,
  paragraphSpacing: 0.8,
  textIndent: 2,
  textAlign: 'justify',

  // —— 排版 / 自适应 ——
  layoutMode: 'auto',
  pageWidth: 820,
  pagePadding: 24,
  fontScaleWithWidth: true,

  // —— 翻页 ——
  pageMode: 'scroll',
  animateDuration: 260,
  clickArea: 'left-right',

  // —— 其他 ——
  autoRead: { enabled: false, speed: 40 },
  keepScreenOn: false,
  showProgress: true,
  showClock: true,
  showBattery: true,
  fullscreen: false,
  brightness: 100,
  simplify: false,
  fontSizeShortcut: true,
  hideStatusBar: false,
  pageAnim: 'slide',
};

/** 主题预设：patch 会与当前设置深合并 */
export const PRESETS = [
  { id: 'light', name: '默认白', patch: { theme: 'light', bgColor: '#ffffff', textColor: '#2c2c2c', bgImage: '' } },
  { id: 'sepia', name: '羊皮纸', patch: { theme: 'sepia', bgColor: '#f5ecd9', textColor: '#4a3f35', bgImage: '' } },
  { id: 'green', name: '护眼绿', patch: { theme: 'green', bgColor: '#cce8cf', textColor: '#26352a', bgImage: '' } },
  { id: 'dark', name: '夜间灰', patch: { theme: 'dark', bgColor: '#1f1f1f', textColor: '#b8b8b8', bgImage: '' } },
  { id: 'black', name: '纯黑 OLED', patch: { theme: 'black', bgColor: '#000000', textColor: '#8f8f8f', bgImage: '' } },
  { id: 'night', name: '深蓝夜读', patch: { theme: 'night', bgColor: '#12202b', textColor: '#9fb3c8', bgImage: '' } },
  { id: 'parchment', name: '牛皮纸', patch: { theme: 'sepia', bgColor: '#e8d8b7', textColor: '#3d3226', bgImage: '' } },
  { id: 'blue', name: '淡蓝', patch: { theme: 'custom', bgColor: '#dce9f5', textColor: '#20303f', bgImage: '' } },
];

const SETTINGS_KEY = 'reader';

/** 深合并（只合并普通对象，数组与标量直接覆盖） */
export function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch) || typeof patch !== 'object') return patch;
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {};
  for (const k in patch) {
    const pv = patch[k];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], pv);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out;
}

/** 读取设置（与默认值合并，保证新版本新增字段也有值） */
export function loadSettings() {
  const stored = getSetting(SETTINGS_KEY, {});
  return deepMerge(DEFAULT_SETTINGS, stored || {});
}

export function saveSettings(patch) {
  const current = loadSettings();
  const merged = deepMerge(current, patch || {});
  setSetting(SETTINGS_KEY, merged);
  return merged;
}

export function resetSettings() {
  setSetting(SETTINGS_KEY, {});
  return { ...DEFAULT_SETTINGS };
}
