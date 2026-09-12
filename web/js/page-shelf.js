/**
 * page-shelf.js —— 书架页
 * 网格卡片 + 分组筛选 + 批量管理 + 继续阅读。
 */

import { api } from './api.js';
import {
  h, clear, icon, iconButton, toast, toastOk, toastError, toastWarn,
  openModal, confirmDialog, promptDialog, actionSheet, emptyState, errorState,
  loadingBlock, longPress, fromNow, formatSeconds,
} from './ui.js';

export async function render(root) {
  const state = {
    items: [],
    groups: [],
    group: '',
    batch: false,
    selected: new Set(),
    loading: false,
  };

  clear(root);
  root.appendChild(h('div', { class: 'page-head' },
    h('h1', { class: 'page-title' }, icon('shelf', 20), h('span', { text: '我的书架' })),
    h('span', { class: 'page-sub', id: 'shelf-count' }),
    h('span', { class: 'spacer' })
  ));

  const toolbar = h('div', { class: 'toolbar' });
  const chipsBox = h('div', { class: 'chips', style: { flex: '1 1 100%' } });
  const gridBox = h('div', { class: 'grid grid-books' });
  const batchBar = h('div', { class: 'batch-bar', style: { display: 'none' } });
  root.appendChild(toolbar);
  root.appendChild(chipsBox);
  root.appendChild(gridBox);
  root.appendChild(batchBar);

  const batchToggle = h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => toggleBatch() } },
    icon('check', 14), h('span', { text: '批量管理' }));
  const refreshBtn = iconButton('refresh', '刷新书架', () => load(), { size: 16 });
  toolbar.appendChild(h('span', { class: 'small muted', text: '分组' }));
  toolbar.appendChild(chipsBox);
  toolbar.appendChild(h('span', { class: 'spacer' }));
  toolbar.appendChild(batchToggle);
  toolbar.appendChild(refreshBtn);
  toolbar.style.flexWrap = 'wrap';

  /* ---------------- 数据 ---------------- */

  async function load() {
    if (state.loading) return;
    state.loading = true;
    clear(gridBox);
    gridBox.appendChild(loadingBlock('正在加载书架…'));
    try {
      const data = await api.shelf();
      state.items = (data && data.items) || [];
      state.groups = (data && data.groups) || [];
      renderAll();
    } catch (err) {
      clear(gridBox);
      gridBox.appendChild(errorState(err, () => load()));
    } finally {
      state.loading = false;
    }
  }

  function renderAll() {
    renderChips();
    renderGrid();
    updateCount();
    updateBatchBar();
  }

  function updateCount() {
    const el = root.querySelector('#shelf-count');
    if (el) el.textContent = state.items.length ? '共 ' + state.items.length + ' 本书' : '';
  }

  function renderChips() {
    clear(chipsBox);
    const list = [['', '全部'], ['__none__', '未分组']].concat(state.groups.map((g) => [g, g]));
    const counts = new Map();
    counts.set('', state.items.length);
    for (const it of state.items) {
      const g = (it.shelf && it.shelf.group) || '';
      counts.set(g || '__none__', (counts.get(g || '__none__') || 0) + 1);
    }
    for (const [value, label] of list) {
      if (value !== '' && value !== '__none__' && !counts.get(value)) continue;
      chipsBox.appendChild(h('button', {
        class: 'chip' + (state.group === value ? ' active' : ''),
        type: 'button',
        on: { click: () => { state.group = value; renderAll(); } },
      }, h('span', { text: label }), h('span', { class: 'count', text: String(counts.get(value) || 0) })));
    }
  }

  function visibleItems() {
    if (!state.group) return state.items;
    if (state.group === '__none__') return state.items.filter((it) => !(it.shelf && it.shelf.group));
    return state.items.filter((it) => it.shelf && it.shelf.group === state.group);
  }

  function renderGrid() {
    clear(gridBox);
    const list = visibleItems();
    if (!state.items.length) {
      gridBox.style.display = 'block';
      gridBox.appendChild(emptyState({
        icon: 'shelf',
        title: '书架还是空的',
        desc: '去搜索一本想看的书，加入书架后就能在这里继续阅读。',
        actionLabel: '去搜索',
        onAction: () => { location.hash = '#/search'; },
      }));
      return;
    }
    if (!list.length) {
      gridBox.appendChild(emptyState({ icon: 'folder', title: '该分组下没有书籍', desc: '切换其他分组，或把书移动到当前分组。' }));
      return;
    }
    for (const book of list) gridBox.appendChild(buildCard(book));
  }

  /* ---------------- 卡片 ---------------- */

  function buildCard(book) {
    const progress = book.progress || {};
    const percent = Math.max(0, Math.min(1, Number(progress.percent) || 0));
    const chapterIndex = Number(progress.chapterIndex) || 0;

    const coverBox = h('div', { class: 'cover' });
    if (book.cover) {
      const img = h('img', {
        alt: book.name || '封面', loading: 'lazy', decoding: 'async', src: book.cover,
        on: { error: () => { img.remove(); coverBox.appendChild(h('div', { class: 'cover-ph', text: String(book.name || '书').slice(0, 2) })); } },
      });
      coverBox.appendChild(img);
    } else {
      coverBox.appendChild(h('div', { class: 'cover-ph', text: String(book.name || '书').slice(0, 2) }));
    }

    const check = h('input', {
      class: 'shelf-check', type: 'checkbox',
      on: {
        change: (ev) => {
          ev.stopPropagation();
          if (check.checked) state.selected.add(book.id);
          else state.selected.delete(book.id);
          updateBatchBar();
        },
      },
    });
    check.style.display = state.batch ? '' : 'none';
    check.checked = state.selected.has(book.id);

    const ring = buildRing(percent);

    const progressText = progress.chapterTitle
      ? '读到 第' + (chapterIndex + 1) + '章 ' + String(progress.chapterTitle).slice(0, 18)
      : (percent > 0 ? '进度 ' + Math.round(percent * 100) + '%' : '尚未开始阅读');

    const card = h('div', { class: 'card shelf-card' },
      h('div', { class: 'cover-wrap', style: { position: 'relative' } }, coverBox, ring, check),
      h('div', { class: 'shelf-body' },
        h('div', { class: 'shelf-name nowrap', title: book.name, text: book.name || '未命名' }),
        h('div', { class: 'small muted nowrap', text: (book.author || '佚名') + (book.sourceName ? ' · ' + book.sourceName : '') }),
        h('div', { class: 'shelf-progress nowrap', title: progressText, text: progressText }),
        h('div', { class: 'progress-bar' }, h('i', { style: { width: (percent * 100) + '%' } })),
        h('div', { class: 'shelf-actions' },
          h('button', {
            class: 'btn btn-sm btn-primary', type: 'button',
            on: { click: (ev) => { ev.stopPropagation(); continueRead(book); } },
          }, icon('play', 13), h('span', { text: percent > 0 ? '继续' : '开始' })),
          h('button', {
            class: 'btn btn-sm', type: 'button',
            on: { click: (ev) => { ev.stopPropagation(); location.hash = '#/book/' + book.id; } },
          }, h('span', { text: '详情' })),
          h('button', {
            class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '更多',
            on: { click: (ev) => { ev.stopPropagation(); bookMenu(book); } },
          }, icon('more', 15))
        )
      )
    );

    longPress(card, () => bookMenu(book));
    card.addEventListener('click', () => {
      if (state.batch) {
        check.checked = !check.checked;
        check.dispatchEvent(new Event('change'));
      }
    });
    return card;
  }

  /** 进度环 */
  function buildRing(percent) {
    const r = 15;
    const c = 2 * Math.PI * r;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ring');
    svg.setAttribute('width', '42');
    svg.setAttribute('height', '42');
    svg.setAttribute('viewBox', '0 0 38 38');
    const bg = document.createElementNS(NS, 'circle');
    bg.setAttribute('class', 'bg');
    bg.setAttribute('cx', '19'); bg.setAttribute('cy', '19'); bg.setAttribute('r', String(r));
    const fg = document.createElementNS(NS, 'circle');
    fg.setAttribute('class', 'fg');
    fg.setAttribute('cx', '19'); fg.setAttribute('cy', '19'); fg.setAttribute('r', String(r));
    fg.setAttribute('stroke-dasharray', String(c));
    fg.setAttribute('stroke-dashoffset', String(c * (1 - percent)));
    fg.setAttribute('stroke', '#ffffff');
    bg.setAttribute('stroke', 'rgba(255,255,255,.35)');
    svg.appendChild(bg);
    svg.appendChild(fg);
    return h('div', { class: 'ring-wrap progress-ring', title: '阅读进度 ' + Math.round(percent * 100) + '%' },
      svg, h('span', { class: 'ring-text', text: Math.round(percent * 100) + '%' }));
  }

  function continueRead(book) {
    const idx = Number(book.progress && book.progress.chapterIndex) || 0;
    location.hash = '#/read/' + book.id + '?chapter=' + idx;
  }

  /* ---------------- 单本操作 ---------------- */

  function bookMenu(book) {
    actionSheet([
      { label: '继续阅读', icon: 'play', onClick: () => continueRead(book) },
      { label: '书籍详情', icon: 'book', onClick: () => { location.hash = '#/book/' + book.id; } },
      { label: '修改分组', icon: 'folder', onClick: () => moveGroup([book.id], (book.shelf && book.shelf.group) || '') },
      { label: '移出书架', icon: 'trash', danger: true, onClick: () => removeBooks([book.id], book.name) },
    ], { title: book.name });
  }

  async function moveGroup(ids, current) {
    const val = await promptDialog({
      title: '移动到分组',
      label: '分组名称（留空表示移出分组）',
      value: current || '',
      placeholder: '例如：在看',
      datalist: state.groups,
    });
    if (val === null) return;
    try {
      for (const id of ids) await api.shelfPatch(id, { group: val });
      toastOk('已移动 ' + ids.length + ' 本');
      state.selected.clear();
      await load();
    } catch (err) {
      toastError(err, '移动失败');
    }
  }

  async function removeBooks(ids, name) {
    const ok = await confirmDialog(name ? '确定把《' + name + '》移出书架吗？（阅读进度会保留）' : '确定把选中的 ' + ids.length + ' 本书移出书架吗？（阅读进度会保留）', { danger: true, okLabel: '移出' });
    if (!ok) return;
    try {
      for (const id of ids) await api.shelfRemove(id);
      toastOk('已移出书架');
      state.selected.clear();
      await load();
    } catch (err) {
      toastError(err, '操作失败');
    }
  }

  /* ---------------- 批量管理 ---------------- */

  function toggleBatch() {
    state.batch = !state.batch;
    state.selected.clear();
    batchToggle.classList.toggle('btn-primary', state.batch);
    batchToggle.querySelector('span').textContent = state.batch ? '退出批量' : '批量管理';
    renderGrid();
    updateBatchBar();
  }

  function updateBatchBar() {
    clear(batchBar);
    const n = state.selected.size;
    batchBar.style.display = state.batch ? '' : 'none';
    if (!state.batch) return;
    batchBar.appendChild(h('strong', { text: '已选 ' + n + ' 本' }));
    batchBar.appendChild(h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => moveGroup(Array.from(state.selected), '') } }, icon('folder', 14), h('span', { text: '改分组' })));
    batchBar.appendChild(h('button', { class: 'btn btn-sm btn-danger', type: 'button', on: { click: () => removeBooks(Array.from(state.selected)) } }, icon('trash', 14), h('span', { text: '移出书架' })));
    batchBar.appendChild(h('span', { class: 'spacer' }));
    batchBar.appendChild(h('button', {
      class: 'btn btn-sm btn-ghost', type: 'button',
      text: state.selected.size === visibleItems().length ? '取消全选' : '全选',
      on: {
        click: () => {
          if (state.selected.size === visibleItems().length) state.selected.clear();
          else visibleItems().forEach((b) => state.selected.add(b.id));
          renderGrid();
          updateBatchBar();
        },
      },
    }));
  }

  await load();

  return function cleanup() { /* 书架页无常驻监听 */ };
}

export default render;
