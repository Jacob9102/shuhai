/**
 * page-settings.js —— 全局设置页
 * 默认阅读设置（与阅读器共用 store）/ 服务端同步 / 数据统计 / 清理 / 关于。
 */

import { api } from './api.js';
import {
  h, clear, icon, iconButton, toast, toastOk, toastError, toastWarn,
  openModal, confirmDialog, emptyState, errorState, loadingBlock,
  formatSeconds, formatBytes, formatTime, fromNow,
} from './ui.js';
import {
  getSettings, getUi, setUi, pullFromServer, pushToServer,
  clearLocalData, localUsage, pingServer, isServerReachable, applyMetaTheme, updateSettings,
} from './store.js';
import { renderReaderSettings } from './reader-settings.js';
import { SHORTCUTS } from './reader.js';

export async function render(root) {
  clear(root);

  root.appendChild(h('div', { class: 'page-head' },
    h('h1', { class: 'page-title' }, icon('gear', 20), h('span', { text: '设置' })),
    h('span', { class: 'page-sub', text: '阅读设置会同时作用于阅读器与全局默认值' }),
    h('span', { class: 'spacer' })
  ));

  /* ---------------- 1. 界面主题 ---------------- */
  const uiSection = h('section', { class: 'settings-section' },
    h('h3', {}, icon('palette', 16), h('span', { text: '界面外观' }))
  );
  const themeSeg = h('div', { class: 'segmented' });
  [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].forEach(([value, label]) => {
    const btn = h('button', {
      class: getUi().theme === value ? 'active' : '', type: 'button', text: label,
      on: {
        click: () => {
          setUi({ theme: value });
          Array.from(themeSeg.children).forEach((b) => b.classList.toggle('active', b.textContent === label));
          applyUiTheme(value);
        },
      },
    });
    themeSeg.appendChild(btn);
  });
  uiSection.appendChild(h('div', { class: 'setting-item' },
    h('div', { class: 'setting-label', text: '界面配色（仅影响应用界面，阅读背景由阅读设置决定）' }),
    themeSeg
  ));
  root.appendChild(uiSection);

  /* ---------------- 2. 默认阅读设置 ---------------- */
  const readSection = h('section', { class: 'settings-section' },
    h('h3', {}, icon('textSize', 16), h('span', { text: '默认阅读设置' })),
    h('p', { class: 'form-hint', style: { marginBottom: '12px' }, text: '这里修改的设置与阅读器内的设置面板是同一份数据，改动会立即同步。' })
  );
  const panelHost = h('div', { class: 'settings-grid' });
  readSection.appendChild(panelHost);
  root.appendChild(readSection);
  const disposePanel = renderReaderSettings(panelHost, { onChange: () => {} });

  /* ---------------- 3. 服务端同步 ---------------- */
  const syncSection = h('section', { class: 'settings-section' },
    h('h3', {}, icon('refresh', 16), h('span', { text: '设置同步' }))
  );
  const syncStatus = h('span', { class: 'badge', text: '未知' });
  const syncCard = h('div', { class: 'card card-pad' },
    h('p', { class: 'form-hint', style: { marginBottom: '12px' }, text: '本地设置优先于服务端设置。推送到服务端后，其他设备可用「从服务端拉取」获取同一份配置。' }),
    h('div', { class: 'form-inline' },
      h('button', {
        class: 'btn btn-primary', type: 'button',
        on: {
          click: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            try {
              await pushToServer();
              toastOk('已推送到服务端');
              syncStatus.textContent = '已同步 ' + formatTime(Date.now());
              syncStatus.className = 'badge badge-ok';
            } catch (err) { toastError(err, '推送失败'); }
            finally { btn.disabled = false; }
          },
        },
      }, icon('upload', 15), h('span', { text: '推送到服务端' })),
      h('button', {
        class: 'btn', type: 'button',
        on: {
          click: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            try {
              await pullFromServer();
              toastOk('已从服务端拉取');
              syncStatus.textContent = '已同步 ' + formatTime(Date.now());
              syncStatus.className = 'badge badge-ok';
              disposePanel();
              clear(panelHost);
              panelHost.__dispose = renderReaderSettings(panelHost, { onChange: () => {} });
            } catch (err) { toastError(err, '拉取失败'); }
            finally { btn.disabled = false; }
          },
        },
      }, icon('download', 15), h('span', { text: '从服务端拉取' })),
      h('button', {
        class: 'btn btn-ghost', type: 'button',
        on: {
          click: async () => {
            const ok = await pingServer();
            syncStatus.textContent = ok ? '连接正常' : '无法连接';
            syncStatus.className = 'badge ' + (ok ? 'badge-ok' : 'badge-err');
            toast(ok ? '后端连接正常' : '无法连接后端服务', { type: ok ? 'success' : 'error' });
          },
        },
      }, icon('wifi', 15), h('span', { text: '检测连接' })),
      syncStatus
    )
  );
  syncSection.appendChild(syncCard);
  root.appendChild(syncSection);

  /* ---------------- 4. 数据统计 ---------------- */
  const statSection = h('section', { class: 'settings-section' },
    h('h3', {}, icon('chart', 16), h('span', { text: '数据统计' })),
  );
  const statGrid = h('div', { class: 'stat-grid' });
  statSection.appendChild(statGrid);
  root.appendChild(statSection);

  async function loadStats() {
    clear(statGrid);
    statGrid.appendChild(loadingBlock('正在统计…'));
    try {
      const data = await api.stats();
      const d = data || {};
      clear(statGrid);
      statGrid.appendChild(statCard(d.sourceTotal || 0, '书源总数'));
      statGrid.appendChild(statCard(d.sourceEnabled || 0, '启用书源'));
      statGrid.appendChild(statCard(d.bookTotal || 0, '书籍总数'));
      statGrid.appendChild(statCard(d.chapterCached || 0, '已缓存章节'));
      statGrid.appendChild(statCard(formatSeconds(d.readSeconds || 0), '累计阅读时长'));
      statGrid.appendChild(statCard(d.bookmarkTotal || 0, '书签与笔记'));
    } catch (err) {
      clear(statGrid);
      statGrid.appendChild(errorState(err, () => loadStats()));
    }
  }
  function statCard(num, label) {
    return h('div', { class: 'stat-card' },
      h('div', { class: 'num', text: String(num) }),
      h('div', { class: 'lbl', text: label }));
  }

  /* ---------------- 5. 数据清理 ---------------- */
  const cleanSection = h('section', { class: 'settings-section' },
    h('h3', {}, icon('trash', 16), h('span', { text: '数据清理' }))
  );
  const usageLabel = h('span', { class: 'form-hint', text: '本地占用 ' + formatBytes(localUsage()) });
  cleanSection.appendChild(h('div', { class: 'card card-pad' },
    h('div', { class: 'form-inline' },
      h('button', {
        class: 'btn', type: 'button',
        on: {
          click: async () => {
            const ok = await confirmDialog('确定清空服务端保存的搜索历史吗？', { danger: true, okLabel: '清空' });
            if (!ok) return;
            try { await api.searchHistoryClear(); toastOk('搜索历史已清空'); }
            catch (err) { toastError(err, '清空失败'); }
          },
        },
      }, icon('search', 15), h('span', { text: '清空搜索历史' })),
      h('button', {
        class: 'btn btn-danger', type: 'button',
        on: {
          click: async () => {
            const ok = await confirmDialog('将清除本地保存的阅读设置、界面偏好等数据（服务端数据不受影响）。确定继续吗？', { danger: true, okLabel: '清除' });
            if (!ok) return;
            const n = clearLocalData();
            toastOk('已清除 ' + n + ' 项本地数据，即将刷新');
            setTimeout(() => location.reload(), 800);
          },
        },
      }, icon('trash', 15), h('span', { text: '清空本地缓存数据' })),
      usageLabel
    ),
    h('p', { class: 'form-hint', style: { marginTop: '10px' }, text: '说明：章节正文缓存由服务端管理，可在书籍详情页的「缓存」标签中查看进度。' })
  ));
  root.appendChild(cleanSection);

  /* ---------------- 6. 快捷键与关于 ---------------- */
  const aboutSection = h('section', { class: 'settings-section' },
    h('h3', {}, icon('keyboard', 16), h('span', { text: '快捷键' }))
  );
  const kbdList = h('div', { class: 'kbd-list card card-pad' });
  for (const item of SHORTCUTS) {
    kbdList.appendChild(h('div', { class: 'kbd-row' },
      h('span', { style: { minWidth: '96px' } }, item.keys.map((k) => h('kbd', { text: k }))),
      h('span', { text: item.desc })
    ));
  }
  aboutSection.appendChild(kbdList);
  root.appendChild(aboutSection);

  const aboutCard = h('div', { class: 'card card-pad' },
    h('p', {}, h('strong', { text: '书海 · 自托管全网小说搜索阅读服务' })),
    h('p', { class: 'form-hint', style: { marginTop: '6px' }, text: '纯静态前端：零构建、零外部依赖，所有资源均来自本服务自身。数据与书源规则由后端提供。' }),
    h('p', { class: 'form-hint', style: { marginTop: '6px' } }, h('span', { text: '后端连接状态：' }), h('span', { id: 'about-status', text: '检测中…' }))
  );
  root.appendChild(aboutCard);

  pingServer().then((ok) => {
    const el = aboutCard.querySelector('#about-status');
    if (el) el.textContent = ok ? '正常' : '无法连接（页面仍可正常浏览，数据接口不可用）';
    syncStatus.textContent = ok ? '连接正常' : '无法连接';
    syncStatus.className = 'badge ' + (ok ? 'badge-ok' : 'badge-err');
  });

  await loadStats();

  return function cleanup() {
    disposePanel();
    if (panelHost.__dispose) panelHost.__dispose();
  };
}

/** 应用界面深浅色 */
export function applyUiTheme(mode) {
  const root = document.documentElement;
  let theme = mode;
  if (mode === 'auto') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.setAttribute('data-ui-theme', theme);
  return theme;
}

export default render;
