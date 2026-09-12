/**
 * main.js —— 应用入口
 * 职责：hash 路由、外壳导航、界面主题、后端连接状态、全局错误兜底、初始化。
 */

import { h, clear, icon, toast, toastError, errorState, openModal } from './ui.js';
import { getUi, setUi, loadPresets, pingServer, SETTINGS_KEY } from './store.js';
import { api } from './api.js';
import { applyUiTheme } from './page-settings.js';

import * as pageSearch from './page-search.js';
import * as pageShelf from './page-shelf.js';
import * as pageSources from './page-sources.js';
import * as pageBook from './page-book.js';
import * as pageSettings from './page-settings.js';
import * as pageReader from './reader.js';

/* ------------------------------------------------------------------ *
 * 路由表
 * ------------------------------------------------------------------ */
const ROUTES = [
  { name: 'search', pattern: /^\/?$/, render: pageSearch.render },
  { name: 'search', pattern: /^\/search\/?$/, render: pageSearch.render },
  { name: 'shelf', pattern: /^\/shelf\/?$/, render: pageShelf.render },
  { name: 'sources', pattern: /^\/sources\/?$/, render: pageSources.render },
  { name: 'settings', pattern: /^\/settings\/?$/, render: pageSettings.render },
  { name: 'book', pattern: /^\/book\/([^/?#]+)\/?$/, render: pageBook.render, keys: ['id'] },
  { name: 'read', pattern: /^\/read\/([^/?#]+)\/?$/, render: pageReader.render, keys: ['id'] },
];

const view = document.getElementById('view');
let currentCleanup = null;
let currentRoute = null;

/** 解析 location.hash */
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const qIndex = raw.indexOf('?');
  const path = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const queryStr = qIndex >= 0 ? raw.slice(qIndex + 1) : '';
  const query = {};
  if (queryStr) {
    for (const pair of queryStr.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq));
      const v = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
      query[k] = v;
    }
  }
  for (const route of ROUTES) {
    const m = route.pattern.exec(path);
    if (m) {
      const params = Object.assign({}, query);
      if (route.keys) route.keys.forEach((key, i) => { params[key] = m[i + 1]; });
      return { route, params, path };
    }
  }
  return { route: null, params: {}, path };
}

/** 更新导航高亮 */
function syncNav(name) {
  document.querySelectorAll('.nav-link').forEach((link) => {
    const target = link.dataset.nav;
    const active = target === name || (name === 'book' && target === 'search') || (name === 'read' && target === 'shelf');
    link.classList.toggle('active', active);
  });
}

/** 渲染快捷键帮助 */
function showShortcutHelp() {
  import('./reader.js').then((mod) => {
    const list = h('div', { class: 'kbd-list' });
    for (const item of mod.SHORTCUTS) {
      list.appendChild(h('div', { class: 'kbd-row' },
        h('span', { style: { minWidth: '96px' } }, item.keys.map((k) => h('kbd', { text: k }))),
        h('span', { text: item.desc })));
    }
    openModal({ title: '快捷键说明（阅读器内可用）', size: 'sm', body: list });
  }).catch(() => { toast('快捷键说明加载失败', { type: 'error' }); });
}

/** 路由分发 */
async function handleRoute() {
  const { route, params } = parseHash();

  // 清理上一个页面
  if (typeof currentCleanup === 'function') {
    try { currentCleanup(); } catch (e) { console.warn('[router] 清理失败', e); }
  }
  currentCleanup = null;

  if (!route) {
    document.body.dataset.route = 'search';
    syncNav('search');
    clear(view);
    view.appendChild(h('div', { class: 'empty-state' },
      h('div', { class: 'empty-icon' }, icon('info', 40)),
      h('h3', { class: 'empty-title', text: '页面不存在' }),
      h('p', { class: 'empty-desc', text: '找不到路由 ' + location.hash + '，返回搜索页继续使用。' }),
      h('a', { class: 'btn btn-primary', href: '#/search', text: '回到搜索' })
    ));
    return;
  }

  currentRoute = route;
  document.body.dataset.route = route.name;
  syncNav(route.name);

  try {
    window.scrollTo(0, 0);
    const cleanup = await route.render(view, params);
    currentCleanup = typeof cleanup === 'function' ? cleanup : null;
  } catch (err) {
    console.error('[router] 页面渲染失败', err);
    clear(view);
    view.appendChild(errorState(err, () => handleRoute()));
  }
}

/* ------------------------------------------------------------------ *
 * 外壳交互
 * ------------------------------------------------------------------ */

function bindShell() {
  // 界面主题按钮
  const toggle = document.getElementById('theme-toggle');
  function renderToggleIcon() {
    const mode = getUi().theme;
    clear(toggle);
    const isDark = document.documentElement.getAttribute('data-ui-theme') === 'dark';
    toggle.appendChild(icon(isDark ? 'sun' : 'moon', 18));
    toggle.title = '界面主题：' + (mode === 'auto' ? '跟随系统' : mode === 'light' ? '浅色' : '深色') + '（点击切换）';
  }
  toggle.addEventListener('click', () => {
    const cur = getUi().theme;
    const next = cur === 'auto' ? 'dark' : cur === 'dark' ? 'light' : 'auto';
    setUi({ theme: next });
    applyUiTheme(next);
    renderToggleIcon();
    toast('界面主题：' + (next === 'auto' ? '跟随系统' : next === 'dark' ? '深色' : '浅色'));
  });
  renderToggleIcon();
  window.__renderThemeToggleIcon = renderToggleIcon;

  // 跟随系统主题变化
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (getUi().theme === 'auto') { applyUiTheme('auto'); renderToggleIcon(); }
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  // 全局快捷键：? 打开帮助（阅读器内部另有更完整的处理）
  document.addEventListener('keydown', (ev) => {
    const tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ev.target && ev.target.isContentEditable)) return;
    if (ev.key === '?' && document.body.dataset.route !== 'read') {
      ev.preventDefault();
      showShortcutHelp();
    }
  });

  // 未捕获异常兜底，避免白屏
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    if (reason && reason.name === 'ApiError') {
      toastError(reason);
    } else {
      console.warn('[未处理的 Promise 异常]', reason);
    }
  });
}

/** 后端连接状态徽标 */
function initServerBadge() {
  const badge = document.getElementById('server-badge');
  const text = badge ? badge.querySelector('.server-text') : null;
  async function check() {
    const ok = await pingServer();
    if (!badge) return;
    badge.classList.toggle('ok', !!ok);
    badge.classList.toggle('bad', !ok);
    if (text) text.textContent = ok ? '服务正常' : '未连接';
    badge.title = ok ? '后端服务连接正常' : '无法连接后端服务，请确认服务已启动';
  }
  check();
  setInterval(check, 60000);
  window.addEventListener('online', check);
  window.addEventListener('offline', () => {
    if (badge) { badge.classList.remove('ok'); badge.classList.add('bad'); }
    if (text) text.textContent = '离线';
  });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

async function boot() {
  applyUiTheme(getUi().theme);
  bindShell();
  initServerBadge();
  // 主题预设（失败自动回退内置）
  loadPresets();

  window.addEventListener('hashchange', handleRoute);
  if (!location.hash) location.hash = '#/search';
  await handleRoute();

  // 首次进入预热：探测服务端设置（若本地已有设置则以本地为准，不覆盖）
  try {
    const local = localStorage.getItem(SETTINGS_KEY);
    if (!local) {
      const { pullFromServer } = await import('./store.js');
      await pullFromServer();
    }
  } catch (e) {
    // 后端未启动时忽略，使用默认设置
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
