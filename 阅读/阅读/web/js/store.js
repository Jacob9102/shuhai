/**
 * store.js —— 本地状态（localStorage）与服务端设置同步
 *
 * 设计约定：localStorage 里保存的键名与 /api/settings 返回对象的键名完全一致，
 * 因此「拉取覆盖本地 / 推送覆盖服务端」都只是浅拷贝，不需要字段映射。
 * 优先级：本地 localStorage > 服务端 settings（契约第 6 节）。
 */

import { api } from './api.js';

/** 阅读设置的本地存储键 */
export const SETTINGS_KEY = 'shuhai:settings';
/** UI 偏好的本地存储键（不参与服务端同步） */
export const UI_KEY = 'shuhai:ui';

/** 主题预设内置兜底（与 /api/settings/presets 完全一致，接口失败时使用） */
export const FALLBACK_PRESETS = [
  { id: 'light', name: '默认白', patch: { theme: 'light', bgColor: '#ffffff', textColor: '#2c2c2c' } },
  { id: 'sepia', name: '羊皮纸', patch: { theme: 'sepia', bgColor: '#f5ecd9', textColor: '#4a3f35' } },
  { id: 'green', name: '护眼绿', patch: { theme: 'green', bgColor: '#cce8cf', textColor: '#26352a' } },
  { id: 'dark', name: '夜间灰', patch: { theme: 'dark', bgColor: '#1f1f1f', textColor: '#b8b8b8' } },
  { id: 'black', name: '纯黑 OLED', patch: { theme: 'black', bgColor: '#000000', textColor: '#8f8f8f' } },
  { id: 'night', name: '深蓝夜读', patch: { theme: 'night', bgColor: '#12202b', textColor: '#9fb3c8' } },
];

/** 默认设置：字段与契约中的设置对象一一对应 */
export const DEFAULT_SETTINGS = {
  theme: 'light',
  // 背景
  bgColor: '#ffffff',
  bgImage: '',
  bgOpacity: 30,
  textColor: '#2c2c2c',
  // 字体
  fontFamily: '',
  fontSize: 18,
  fontWeight: 400,
  lineHeight: 1.8,
  letterSpacing: 0,
  paragraphSpacing: 0.6,
  textIndent: 2,
  textAlign: 'justify',
  // 排版 / 自适应
  layoutMode: 'auto',
  pageWidth: 720,
  pagePadding: 24,
  fontScaleWithWidth: false,
  // 翻页
  pageMode: 'scroll',
  animateDuration: 260,
  clickArea: 'left-right',
  // 其他
  autoRead: { enabled: false, speed: 60 },
  keepScreenOn: false,
  showProgress: true,
  showClock: true,
  showBattery: true,
  fullscreen: false,
  brightness: 100,
  simplify: false,
  fontSizeShortcut: true,
  hideStatusBar: false,
  pageAnim: '',
};

/** 默认 UI 偏好 */
export const DEFAULT_UI = {
  theme: 'auto',          // auto | light | dark —— 仅影响应用外壳配色
  searchType: 'all',
  searchView: 'agg',      // group | agg —— 默认按书去重，避免同一本书被各书源重复列出
  searchMatch: 'fuzzy',   // fuzzy 模糊 | exact 精确
  searchSort: 'relevance',
  sourcePageSize: 20,
  defaultGroup: '',
};

/** UI 偏好版本号：改动默认展示方式时 +1，用于把老用户存下来的旧偏好迁移到新默认 */
const UI_VERSION = 2;

/** 老版本偏好迁移（只做一次，之后仍然尊重用户自己的选择） */
function migrateUi(ui) {
  if (ui.uiVersion === UI_VERSION) return ui;
  const next = Object.assign({}, ui, { uiVersion: UI_VERSION });
  if (!ui.uiVersion) {
    // v1 的默认是「按书源」逐条列出，会让人以为结果刷屏；升级后默认改成聚合去重
    next.searchView = 'agg';
    if (next.searchMatch === undefined) next.searchMatch = 'fuzzy';
  }
  try { writeJSON(UI_KEY, next); } catch { /* 忽略 */ }
  return next;
}

/** 简单的类型校验：数字型字段做范围收敛，避免脏数据把界面搞坏 */
const NUMBER_RANGES = {
  fontSize: [12, 40],
  fontWeight: [300, 700],
  lineHeight: [1.2, 3.0],
  letterSpacing: [0, 5],
  paragraphSpacing: [0, 3],
  textIndent: [0, 4],
  pageWidth: [320, 1600],
  pagePadding: [0, 80],
  animateDuration: [0, 600],
  bgOpacity: [0, 100],
  brightness: [20, 100],
};
const ENUMS = {
  theme: ['light', 'sepia', 'green', 'dark', 'black', 'night', 'custom'],
  textAlign: ['left', 'justify'],
  layoutMode: ['auto', 'fixed'],
  pageMode: ['scroll', 'slide', 'cover', 'none', 'vertical'],
  clickArea: ['none', 'left-right', 'all'],
};

/** 安全读取 JSON */
function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    return parsed;
  } catch (e) {
    return fallback;
  }
}

/** 安全写入 JSON（配额满时静默失败） */
function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

/** 规范化设置对象：补齐默认值 + 收敛越界值 */
export function normalizeSettings(input) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const def = DEFAULT_SETTINGS[key];
    let val = src[key];
    if (val === undefined || val === null) val = def;
    if (typeof def === 'number') {
      val = Number(val);
      if (!Number.isFinite(val)) val = def;
      const range = NUMBER_RANGES[key];
      if (range) val = Math.min(range[1], Math.max(range[0], val));
    } else if (typeof def === 'boolean') {
      val = val === true || val === 'true' || val === 1 || val === '1';
    } else if (typeof def === 'string') {
      val = String(val);
      if (ENUMS[key] && ENUMS[key].indexOf(val) < 0) val = def;
    }
    out[key] = val;
  }
  // autoRead 是嵌套对象，单独处理
  const ar = src.autoRead && typeof src.autoRead === 'object' ? src.autoRead : DEFAULT_SETTINGS.autoRead;
  out.autoRead = {
    // 兼容服务端可能返回的 "true"/1 等松散写法
    enabled: ar.enabled === true || ar.enabled === 'true' || ar.enabled === 1 || ar.enabled === '1',
    speed: Math.min(600, Math.max(10, Number(ar.speed) || DEFAULT_SETTINGS.autoRead.speed)),
  };
  // 允许服务端带回额外字段（如 pageAnim），原样保留
  for (const key of Object.keys(src)) {
    if (!(key in out)) out[key] = src[key];
  }
  return out;
}

/** 状态容器 */
const state = {
  settings: normalizeSettings(readJSON(SETTINGS_KEY, {})),
  ui: migrateUi(Object.assign({}, DEFAULT_UI, readJSON(UI_KEY, {}))),
  serverReachable: null,   // null 未知 / true 通 / false 不通
  presets: FALLBACK_PRESETS.slice(),
};

const listeners = new Set();

/** 订阅设置变化，返回取消订阅函数 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 派发变化 */
function emit(patch, source) {
  for (const fn of Array.from(listeners)) {
    try { fn(getSettings(), patch, source); } catch (e) { console.warn('[store] 监听器异常', e); }
  }
}

/** 取当前设置的副本 */
export function getSettings() {
  return Object.assign({}, state.settings, { autoRead: Object.assign({}, state.settings.autoRead) });
}

/** 取单个设置项 */
export function getSetting(key) {
  return state.settings[key];
}

/**
 * 更新设置
 * @param {object} patch 需要合并的字段
 * @param {object} options { persist:boolean, silent:boolean }
 */
export function updateSettings(patch, options = {}) {
  const next = normalizeSettings(Object.assign({}, state.settings, patch));
  state.settings = next;
  if (options.persist !== false) writeJSON(SETTINGS_KEY, next);
  if (!options.silent) emit(patch, options.source || 'local');
  return getSettings();
}

/** 恢复默认设置 */
export function resetSettings() {
  state.settings = normalizeSettings({});
  writeJSON(SETTINGS_KEY, state.settings);
  emit(null, 'reset');
  return getSettings();
}

/** UI 偏好读写 */
export function getUi() {
  return Object.assign({}, state.ui);
}
export function setUi(patch) {
  state.ui = Object.assign({}, state.ui, patch);
  writeJSON(UI_KEY, state.ui);
  return getUi();
}

/** 主题预设：优先服务端，失败回退内置 */
export function getPresets() {
  return state.presets.slice();
}

/** 拉取服务端主题预设（失败静默回退） */
export async function loadPresets() {
  try {
    const data = await api.settingsPresets();
    if (Array.isArray(data) && data.length) {
      state.presets = data;
      state.serverReachable = true;
    }
  } catch (e) {
    state.presets = FALLBACK_PRESETS.slice();
  }
  return getPresets();
}

/** 从服务端拉取设置并覆盖本地 */
export async function pullFromServer() {
  const data = await api.settingsGet();
  state.serverReachable = true;
  state.settings = normalizeSettings(Object.assign({}, state.settings, data || {}));
  writeJSON(SETTINGS_KEY, state.settings);
  emit(null, 'server-pull');
  return getSettings();
}

/** 把本地设置推送到服务端 */
export async function pushToServer() {
  const data = await api.settingsPut(getSettings());
  state.serverReachable = true;
  if (data && typeof data === 'object') {
    state.settings = normalizeSettings(Object.assign({}, state.settings, data));
    writeJSON(SETTINGS_KEY, state.settings);
    emit(null, 'server-push');
  }
  return getSettings();
}

/** 探测后端是否可用（不抛异常） */
export async function pingServer() {
  try {
    await api.health();
    state.serverReachable = true;
  } catch (e) {
    state.serverReachable = false;
  }
  return state.serverReachable;
}

/** 服务端可达状态 */
export function isServerReachable() {
  return state.serverReachable;
}

/** 更新浏览器地址栏主题色，让移动端状态栏跟随阅读背景 */
export function applyMetaTheme(color) {
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', color || '#ffffff');
}

/** 清空本应用写入的所有本地数据 */
export function clearLocalData() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.indexOf('shuhai:') === 0) keys.push(key);
  }
  keys.forEach((key) => localStorage.removeItem(key));
  return keys.length;
}

/** 估算本地占用（字节） */
export function localUsage() {
  let bytes = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.indexOf('shuhai:') === 0) {
      bytes += (localStorage.getItem(key) || '').length * 2;
    }
  }
  return bytes;
}

export const store = {
  state,
  getSettings,
  getSetting,
  updateSettings,
  resetSettings,
  subscribe,
  getUi,
  setUi,
  getPresets,
  loadPresets,
  pullFromServer,
  pushToServer,
  pingServer,
  isServerReachable,
  clearLocalData,
  localUsage,
  normalizeSettings,
};

export default store;
