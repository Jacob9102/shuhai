/**
 * page-search.js —— 搜索页
 * SSE 流式聚合搜索 + 书源范围筛选 + 排序筛选 + 搜索历史。
 * 说明：结果只保留「聚合去重」一种视图——338 个书源逐个铺开卡片会让页面又长又卡，
 * 因此搜索过程只给「一行进度 + 失败源折叠」，书源维度只通过「书源范围」这一个筛选项参与。
 */

import { api, openSearchStream } from './api.js';
import {
  h, clear, icon, iconButton, toast, toastOk, toastErr, toastError, toastWarn,
  openModal, confirmDialog, emptyState, errorState, skeleton, loadingBlock,
  debounce, formatDuration, dedupeKey, highlightText,
} from './ui.js';
import { getUi, setUi } from './store.js';

/** 页面级状态（每次进入重置） */
function createState() {
  return {
    q: '',
    type: 'all',
    match: 'fuzzy',   // fuzzy 模糊（默认） / exact 精确
    sort: 'relevance',
    coverOnly: false,
    sourceIds: null,        // 搜索范围：null = 全部启用书源；数组 = 只搜这些
    sourceNames: new Map(), // sourceId -> 源名（「书源范围」chip 需要显示名字）
    enabledTotal: 0,        // 启用中的书源数量（按钮文案「全部启用(N)」）
    groups: new Map(),      // sourceId -> { sourceId, sourceName, ok, count, elapsed, error, items }
    sources: [],            // 书源元数据（用于权重排序）
    stream: null,
    done: false,
    aggregate: [],
    progress: { done: 0, total: 0 },  // 搜索进度（取自每个源 SSE 推送里的 progress 字段）
    failedOpen: false,                // 失败源清单是否展开
  };
}

export async function render(root, params) {
  const state = createState();
  const ui = getUi();
  state.type = ui.searchType || 'all';
  // 固定「聚合去重」：同一本书只出现一条，来源细节收进卡片上的「N 个来源」入口
  state.sort = ui.searchSort || 'relevance';
  state.match = ui.searchMatch === 'exact' ? 'exact' : 'fuzzy';
  state.sourceIds = Array.isArray(ui.searchSources) && ui.searchSources.length ? ui.searchSources.slice() : null;

  clear(root);

  /* ---------------- 顶部搜索区 ---------------- */
  const input = h('input', {
    class: 'input', type: 'search', placeholder: '输入书名或作者，回车搜索',
    value: params && params.q ? params.q : '',
    autocomplete: 'off',
    on: {
      keydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doSearch(input.value.trim()); } },
    },
  });

  const typeSeg = h('div', { class: 'segmented' });
  const TYPE_LABELS = [['name', '书名'], ['author', '作者'], ['all', '综合']];
  const typeButtons = TYPE_LABELS.map(([value, label]) => {
    const btn = h('button', { type: 'button', text: label, on: { click: () => { state.type = value; setUi({ searchType: value }); syncType(); } } });
    btn.dataset.value = value;
    typeSeg.appendChild(btn);
    return btn;
  });
  function syncType() { typeButtons.forEach((b) => b.classList.toggle('active', b.dataset.value === state.type)); }
  syncType();

  // 搜索模式：模糊 / 精确
  const matchSeg = h('div', { class: 'segmented' });
  const MATCH_LABELS = [['fuzzy', '模糊'], ['exact', '精确']];
  const matchButtons = MATCH_LABELS.map(([value, label]) => {
    const btn = h('button', {
      type: 'button', text: label,
      title: value === 'exact' ? '只要书名或作者与关键词完全一致的书' : '包含关键词的都算，按相关度排序',
      on: { click: () => { state.match = value; setUi({ searchMatch: value }); syncMatch(); if (state.q) doSearch(state.q); } },
    });
    btn.dataset.value = value;
    matchSeg.appendChild(btn);
    return btn;
  });
  function syncMatch() { matchButtons.forEach((b) => b.classList.toggle('active', b.dataset.value === state.match)); }
  syncMatch();

  const searchBtn = h('button', { class: 'btn btn-primary', type: 'button', on: { click: () => doSearch(input.value.trim()) } },
    icon('search', 17), h('span', { text: '搜索' }));

  const hero = h('div', { class: 'search-hero' },
    h('div', { class: 'search-bar' },
      h('div', { class: 'search-box' }, icon('search', 18), input),
      searchBtn
    ),
    h('div', { class: 'search-meta' },
      h('span', { text: '搜索范围' }), typeSeg,
      h('span', { style: { marginLeft: '10px' }, text: '匹配方式' }), matchSeg,
      h('span', { class: 'spacer', style: { flex: '1 1 auto' } }),
      h('span', { class: 'small', id: 'search-tip', text: '结果按书去重，边搜边出' })
    )
  );
  root.appendChild(hero);

  /* ---------------- 历史记录 ---------------- */
  const historyBox = h('div', { class: 'card card-pad history-panel' });
  root.appendChild(historyBox);

  async function loadHistory() {
    clear(historyBox);
    let items = [];
    try {
      const data = await api.searchHistory(20);
      items = Array.isArray(data) ? data : [];
    } catch (err) {
      historyBox.style.display = 'none';
      return;
    }
    if (!items.length) { historyBox.style.display = 'none'; return; }
    historyBox.style.display = '';
    const chips = h('div', { class: 'chips' });
    for (const item of items) {
      chips.appendChild(h('button', {
        class: 'chip', type: 'button',
        on: { click: () => { input.value = item.keyword; if (item.type) { state.type = item.type; syncType(); } doSearch(item.keyword); } },
      }, icon('clock', 13), h('span', { text: item.keyword })));
    }
    historyBox.appendChild(h('div', { class: 'history-head' },
      h('h3', {}, icon('clock', 15), h('span', { text: '搜索历史' })),
      h('button', {
        class: 'btn btn-sm btn-ghost', type: 'button',
        on: {
          click: async () => {
            const ok = await confirmDialog('确定清空全部搜索历史吗？', { danger: true, okLabel: '清空' });
            if (!ok) return;
            try { await api.searchHistoryClear(); historyBox.style.display = 'none'; toastOk('搜索历史已清空'); }
            catch (err) { toastError(err, '清空失败'); }
          },
        },
      }, icon('trash', 14), h('span', { text: '清空' }))
    ));
    historyBox.appendChild(chips);
  }

  /* ---------------- 结果区 ---------------- */
  const filterBar = h('div', { class: 'toolbar', style: { display: 'none' } });
  const resultBox = h('div', { id: 'search-results' });
  root.appendChild(filterBar);
  root.appendChild(resultBox);

  /* ---------------- 工具栏 ---------------- */
  // 不再提供「视图」切换：搜索只输出聚合去重视图，书源维度交给下面的「书源范围」决定
  const sortSelect = h('select', {
    class: 'select input-sm', style: { width: 'auto' },
    on: { change: () => { state.sort = sortSelect.value; setUi({ searchSort: sortSelect.value }); renderResults(); } },
  });
  [['relevance', '按相关度'], ['name', '按书名'], ['weight', '按书源权重']].forEach(([v, l]) => sortSelect.appendChild(h('option', { value: v, text: l })));
  sortSelect.value = state.sort;

  const coverOnly = h('label', { class: 'chip' }, h('input', {
    type: 'checkbox', style: { marginRight: '6px' },
    on: { change: () => { state.coverOnly = coverOnly.querySelector('input').checked; renderResults(); } },
  }), h('span', { text: '仅有封面' }));

  // 已选书源的 chip：最多展示前 3 个 + “+N”，每个都能单独关掉并触发重搜
  const scopeChipsBox = h('div', { class: 'chips scope-chips' });

  // 「书源范围」：搜索时不再把每个书源的结果都摊开，只用一个筛选项决定搜哪些源
  const scopeBtn = h('button', {
    class: 'btn btn-sm', type: 'button', title: '选择这次搜索使用哪些书源',
    on: { click: () => openSourcePicker() },
  }, icon('source', 14), h('span', { text: '书源范围' }));

  function syncScope() {
    const ids = state.sourceIds;
    const label = (ids && ids.length)
      ? ('书源：已选 ' + ids.length + ' 个')
      : ('书源：全部启用' + (state.enabledTotal ? '(' + state.enabledTotal + ')' : ''));
    const span = scopeBtn.querySelector('span');
    if (span) span.textContent = label;
    scopeBtn.classList.toggle('btn-primary', !!(ids && ids.length));
    renderScopeChips();
  }

  function renderScopeChips() {
    clear(scopeChipsBox);
    const ids = state.sourceIds;
    if (!ids || ids.length < 2) return;   // 只选了一个源时按钮文案已经说清楚了，不必再放 chip
    ids.slice(0, 3).forEach((id) => {
      const name = state.sourceNames.get(id) || ('#' + id);
      scopeChipsBox.appendChild(h('button', {
        class: 'chip chip-sm chip-removable', type: 'button',
        title: '移除「' + name + '」并重新搜索',
        on: { click: () => removeSourceFromScope(id) },
      }, h('span', { class: 'nowrap', text: name }), icon('close', 12)));
    });
    if (ids.length > 3) scopeChipsBox.appendChild(h('span', { class: 'chip chip-sm chip-more', text: '+' + (ids.length - 3) }));
  }

  /** 从搜索范围里去掉一个源：全部去完就回到「全部启用」 */
  function removeSourceFromScope(id) {
    if (!state.sourceIds) return;
    state.sourceIds = state.sourceIds.filter((x) => x !== id);
    if (!state.sourceIds.length) state.sourceIds = null;
    setUi({ searchSources: state.sourceIds || [] });
    syncScope();
    if (state.q) doSearch(state.q);
  }

  filterBar.appendChild(scopeBtn);
  filterBar.appendChild(h('span', { class: 'small muted', text: '排序' }));
  filterBar.appendChild(sortSelect);
  filterBar.appendChild(coverOnly);
  filterBar.appendChild(scopeChipsBox);
  syncScope();

  /* ---------------- 搜索主流程 ---------------- */

  let aggWrap = null;     // 聚合去重视图容器（现在只有这一种视图）

  function closeStream() {
    if (state.stream) { try { state.stream.close(); } catch (e) { /* 忽略 */ } state.stream = null; }
  }

  async function doSearch(keyword) {
    const q = String(keyword || '').trim();
    if (!q) { toastWarn('请输入搜索关键词'); input.focus(); return; }
    state.q = q;
    input.value = q;
    closeStream();
    state.groups.clear();
    state.done = false;
    state.aggregate = [];
    state.progress = { done: 0, total: 0 };
    state.failedOpen = false;

    historyBox.style.display = 'none';
    filterBar.style.display = '';
    clear(resultBox);
    aggWrap = h('div', { class: 'agg-box' });
    // 结果区顶部只放一行进度（搜索中）/ 一行摘要（完成后），不再逐源铺开卡片
    resultBox.appendChild(buildProgressRow());
    resultBox.appendChild(aggWrap);

    const params2 = { q, type: state.type, match: state.match, limit: 60 };
    if (state.sourceIds && state.sourceIds.length) params2.sources = state.sourceIds.join(',');
    state.stream = openSearchStream(params2, {
      onSource: (payload) => { onSourceResult(payload); },
      onDone: (payload) => {
        state.done = true;
        onDone(payload);
      },
      onError: (err) => {
        onStreamError(err);
      },
    });
  }

  /* ---------------- 书源范围选择 ---------------- */

  async function loadAllSources() {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const d = await api.sourceList({ page, limit: 200 });
      const items = (d && d.items) || [];
      out.push(...items);
      if (!items.length || out.length >= (d.total || 0)) break;
    }
    return out;
  }

  async function openSourcePicker() {
    const body = h('div', {}, loadingBlock('正在读取书源列表…'));
    const footerBox = h('div', { style: { display: 'flex', gap: '8px' } });
    let observer = null;   // 分块渲染的触底观察器（弹窗关闭时必须断开，否则会泄漏）
    const handle = openModal({
      title: '选择搜索使用的书源', size: 'lg', body,
      footer: [footerBox],
      onClose: () => { if (observer) { observer.disconnect(); observer = null; } },
    });

    let list = [];
    try { list = await loadAllSources(); } catch (err) {
      clear(body);
      body.appendChild(errorState(err, () => { handle.close(); openSourcePicker(); }));
      return;
    }
    if (!list.length) {
      clear(body);
      body.appendChild(emptyState({ icon: 'source', title: '还没有书源', desc: '先去「书源管理」导入书源。' }));
      return;
    }
    // 顺便把源名登记进 state，工具栏上的已选 chip 才能显示名字而不是 #id
    for (const s of list) state.sourceNames.set(s.id, s.name || ('#' + s.id));

    const chosen = new Set(state.sourceIds || list.filter((x) => x.enabled !== false).map((x) => x.id));
    const keyword = h('input', { class: 'input input-sm', type: 'search', placeholder: '按名称 / 分组过滤…' });
    const listBox = h('div', { class: 'picker-list' });
    const countEl = h('span', { class: 'page-sub' });
    const sentinel = h('div', { class: 'picker-sentinel' });   // 滚动到底时触发下一块
    const CHUNK = 50;   // 每块 50 条：338 个源一次性建 DOM 会明显卡顿，滚到哪渲染到哪
    let rows = [];      // 过滤后的扁平渲染序列（分组标题 + 书源行）
    let rendered = 0;

    function buildRows(filtered) {
      const out = [];
      const byGroup = new Map();
      for (const s of filtered) {
        const g = s.group || '未分组';
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(s);
      }
      for (const [group, items] of byGroup) {
        out.push({ type: 'group', text: group + '（' + items.length + '）' });
        for (const s of items) out.push({ type: 'src', src: s });
      }
      return out;
    }

    function rowNode(entry) {
      if (entry.type === 'group') return h('div', { class: 'picker-group', text: entry.text });
      const s = entry.src;
      const cb = h('input', {
        type: 'checkbox', class: 'source-check',
        on: { change: () => { if (cb.checked) chosen.add(s.id); else chosen.delete(s.id); updateCount(); syncGroupQuick(); } },
      });
      cb.checked = chosen.has(s.id);
      return h('label', { class: 'picker-row' + (s.enabled === false ? ' off' : '') },
        cb,
        h('span', { class: 'picker-name', text: s.name || ('#' + s.id) }),
        s.enabled === false ? h('span', { class: 'badge', text: '未启用' }) : null,
        s.testStatus === 'fail' ? h('span', { class: 'badge badge-err', text: '体检失效' }) : null
      );
    }

    function renderChunk() {
      const slice = rows.slice(rendered, rendered + CHUNK);
      if (!slice.length) return;
      rendered += slice.length;
      const frag = document.createDocumentFragment();
      for (const entry of slice) frag.appendChild(rowNode(entry));
      if (sentinel.parentNode === listBox) listBox.insertBefore(frag, sentinel);
      else listBox.appendChild(frag);
    }

    function maybeObserve() {
      if (rendered >= rows.length) {
        if (observer) { observer.disconnect(); observer = null; }
        return;
      }
      if (!observer) {
        observer = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) { renderChunk(); maybeObserve(); }
        }, { root: listBox, rootMargin: '200px' });
        observer.observe(sentinel);
      }
    }

    function paint() {
      const kw = keyword.value.trim().toLowerCase();
      const filtered = list.filter((s) => {
        if (!kw) return true;
        return String(s.name || '').toLowerCase().includes(kw) || String(s.group || '').toLowerCase().includes(kw);
      });
      rows = buildRows(filtered);
      rendered = 0;
      // 只清已渲染的行，哨兵保留；分块从头再来
      for (const node of Array.from(listBox.children)) { if (node !== sentinel) node.remove(); }
      if (observer) { observer.disconnect(); observer = null; }
      if (!rows.length) {
        listBox.appendChild(h('div', { class: 'picker-empty small muted', text: '没有匹配的书源' }));
      } else {
        listBox.appendChild(sentinel);
        renderChunk();
        maybeObserve();
      }
      updateCount();
      syncGroupQuick();
    }

    function updateCount() {
      countEl.textContent = '已选 ' + chosen.size + ' / 共 ' + list.length + ' 个书源';
    }

    const quick = h('div', { class: 'chips', style: { margin: '8px 0' } });
    const mk = (label, fn, title) => h('button', { class: 'chip', type: 'button', text: label, title: title || '', on: { click: () => { fn(); paint(); } } });
    quick.appendChild(mk('全部启用', () => { chosen.clear(); list.filter((s) => s.enabled !== false).forEach((s) => chosen.add(s.id)); }));
    quick.appendChild(mk('全部', () => { chosen.clear(); list.forEach((s) => chosen.add(s.id)); }));
    quick.appendChild(mk('清空', () => chosen.clear()));
    quick.appendChild(mk('反选', () => { const all = list.map((s) => s.id); all.forEach((id) => { if (chosen.has(id)) chosen.delete(id); else chosen.add(id); }); }));
    quick.appendChild(mk('仅体检可用', () => { chosen.clear(); list.filter((s) => s.testStatus === 'ok').forEach((s) => chosen.add(s.id)); }, '只选上次体检通过的书源'));
    quick.appendChild(mk('排除体检失效', () => { list.filter((s) => s.testStatus === 'fail').forEach((s) => chosen.delete(s.id)); }));

    // 按分组快速勾选：点一下整组加入，再点一下整组移出
    const groupMembers = new Map();   // 分组名 -> 该书源的 id 数组
    for (const s of list) {
      const g = s.group || '';
      if (!groupMembers.has(g)) groupMembers.set(g, []);
      groupMembers.get(g).push(s.id);
    }
    const groupQuick = h('div', { class: 'chips picker-groups' });
    const groupChipEls = new Map();
    for (const [g, ids] of groupMembers) {
      const label = g || '未分组';
      const chip = h('button', {
        class: 'chip chip-sm', type: 'button',
        title: '勾选 / 取消「' + label + '」整组（' + ids.length + ' 个）',
        on: {
          click: () => {
            const allIn = ids.every((id) => chosen.has(id));
            for (const id of ids) { if (allIn) chosen.delete(id); else chosen.add(id); }
            paint();
          },
        },
      }, h('span', { class: 'nowrap', text: label + '（' + ids.length + '）' }));
      groupChipEls.set(g, chip);
      groupQuick.appendChild(chip);
    }
    /** 分组 chip 的选中态：整组都选了才算 active */
    function syncGroupQuick() {
      groupChipEls.forEach((chip, g) => {
        const ids = groupMembers.get(g) || [];
        chip.classList.toggle('active', ids.length > 0 && ids.every((id) => chosen.has(id)));
      });
    }

    keyword.addEventListener('input', debounce(paint, 200));
    clear(body);
    body.appendChild(h('p', { class: 'form-hint', text: '只勾选需要参与搜索的书源：书源越多搜得越慢（每个源都要单独请求一次）。不勾选任何源时表示「全部启用」。' }));
    body.appendChild(h('div', { class: 'picker-tools' }, keyword, countEl));
    body.appendChild(quick);
    body.appendChild(groupQuick);
    body.appendChild(listBox);
    paint();

    footerBox.appendChild(h('button', {
      class: 'btn btn-ghost', type: 'button', text: '恢复为全部启用',
      on: {
        click: () => {
          state.sourceIds = null;
          setUi({ searchSources: [] });
          syncScope();
          handle.close();
          if (state.q) doSearch(state.q);
          toastOk('搜索范围已恢复为全部启用书源');
        },
      },
    }));
    footerBox.appendChild(h('span', { style: { flex: '1 1 auto' } }));
    footerBox.appendChild(h('button', { class: 'btn', type: 'button', text: '取消', on: { click: () => handle.close() } }));
    footerBox.appendChild(h('button', {
      class: 'btn btn-primary', type: 'button', text: '应用',
      on: {
        click: () => {
          const ids = [...chosen];
          const enabledIds = list.filter((s) => s.enabled !== false).map((s) => s.id);
          const isAllEnabled = ids.length === enabledIds.length && enabledIds.every((id) => chosen.has(id));
          state.sourceIds = (isAllEnabled || !ids.length) ? null : ids;
          setUi({ searchSources: state.sourceIds || [] });
          syncScope();
          handle.close();
          if (state.q) doSearch(state.q);
          toastOk(state.sourceIds ? ('搜索范围：' + state.sourceIds.length + ' 个书源') : '搜索范围：全部启用书源');
        },
      },
    }));
  }

  /* ---------------- 搜索进度行（搜索中一行进度，完成后一行摘要） ---------------- */

  let progressRoot = null;   // { box, spinner, text, bar, failToggle, failList }
  let failPaintKey = '';     // 失败清单重绘标记：数量/展开状态没变就不重建 DOM

  function buildProgressRow() {
    const spinner = h('span', { class: 'spinner sm' });
    const text = h('span', { class: 'sp-text', text: '正在准备搜索…' });
    const bar = h('div', { class: 'progress-bar sp-bar' }, h('i', { style: { width: '0%' } }));
    const failToggle = h('button', { class: 'sp-fail-toggle', type: 'button', style: { display: 'none' } });
    const failList = h('div', { class: 'sp-fail-list', style: { display: 'none' } });
    const box = h('div', { class: 'search-progress' },
      h('div', { class: 'sp-head' }, spinner, text),
      bar, failToggle, failList
    );
    failToggle.addEventListener('click', () => { state.failedOpen = !state.failedOpen; paintFailList(); });
    failPaintKey = '';
    progressRoot = { box, spinner, text, bar, failToggle, failList };
    return box;
  }

  /** 失败的书源（成功的源一个都不列出来——这正是「不要把书源全铺开」的要求） */
  function failedGroups() {
    const out = [];
    state.groups.forEach((g) => { if (g.ok === false) out.push(g); });
    return out;
  }

  function paintProgress() {
    if (!progressRoot) return;
    const total = state.progress.total || 0;
    const done = state.progress.done || state.groups.size;
    const fails = failedGroups().length;
    const hits = totalCount();
    if (!state.done) {
      progressRoot.spinner.style.display = '';
      progressRoot.bar.style.display = '';
      progressRoot.text.textContent = '正在搜索 ' + done + '/' + (total || '?') + ' 个书源 · 已命中 ' + hits + ' 条';
      progressRoot.bar.firstChild.style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
    } else {
      // 搜索结束后收起进度条，只留一行摘要，不长期占版面
      progressRoot.spinner.style.display = 'none';
      progressRoot.bar.style.display = 'none';
      progressRoot.text.textContent = '已搜索 ' + (total || state.groups.size) + ' 个书源：'
        + (state.groups.size - fails) + ' 个成功 · 命中 ' + hits + ' 条';
    }
    paintFailList();
  }

  function paintFailList() {
    if (!progressRoot) return;
    const fails = failedGroups();
    const { failToggle, failList } = progressRoot;
    if (!fails.length) {
      // 全部源都成功：入口与清单一起收掉，并把上面建过的节点清干净
      failToggle.style.display = 'none';
      failList.style.display = 'none';
      clear(failList);
      failPaintKey = '';
      return;
    }
    failToggle.style.display = '';
    // 每个源回来都会调一次这里：数量与展开状态没变就跳过重建（338 个源也不会卡）
    const key = fails.length + '|' + (state.failedOpen ? '1' : '0');
    if (key === failPaintKey) return;
    failPaintKey = key;
    clear(failToggle);
    failToggle.appendChild(icon(state.failedOpen ? 'up' : 'down', 13));
    failToggle.appendChild(h('span', { text: fails.length + ' 个书源搜索失败，点击' + (state.failedOpen ? '收起' : '查看原因') }));
    failList.style.display = state.failedOpen ? '' : 'none';
    clear(failList);
    if (!state.failedOpen) return;   // 收起时不建 DOM，省下几百行节点的开销
    // 最多列 50 条：几百个源同时挂掉时也不能把页面撑爆
    for (const g of fails.slice(0, 50)) {
      failList.appendChild(h('div', { class: 'sp-fail-row' },
        h('span', { class: 'sp-fail-name', text: g.sourceName }),
        h('span', { class: 'sp-fail-msg', text: g.error || '未知错误' }),
        h('button', {
          class: 'btn btn-sm btn-ghost', type: 'button', title: '只重试这个书源',
          on: { click: () => retrySource(g.sourceId) },
        }, icon('refresh', 13), h('span', { text: '重试' }))
      ));
    }
    if (fails.length > 50) {
      failList.appendChild(h('div', { class: 'sp-fail-more small muted', text: '仅显示前 50 条，共 ' + fails.length + ' 个书源失败' }));
    }
  }

  /** 每完成一个书源：只记录状态与结果，不再渲染逐源卡片 */
  function onSourceResult(payload) {
    const data = payload || {};
    const id = data.sourceId;
    if (id === undefined || id === null) return;
    let group = state.groups.get(id);
    if (!group) {
      group = { sourceId: id, sourceName: data.sourceName || ('书源 #' + id), items: [], ok: null, count: 0, elapsed: 0, error: '' };
      state.groups.set(id, group);
    }
    group.sourceName = data.sourceName || group.sourceName;
    group.ok = data.ok !== false;
    group.count = Number(data.count) || (Array.isArray(data.items) ? data.items.length : 0);
    group.elapsed = Number(data.elapsed) || 0;
    group.error = data.error || '';
    group.items = Array.isArray(data.items) ? data.items : [];

    // 后端在每个源的推送里带了 progress{done,total}，直接拿来画进度条
    const p = data.progress;
    if (p && p.total) state.progress = { done: Number(p.done) || 0, total: Number(p.total) || 0 };
    else state.progress = { done: state.groups.size, total: state.progress.total || state.groups.size };

    refreshAggregate();
    paintProgress();
    scheduleAggRender();
  }

  /** 单源重试（入口只在失败源清单里） */
  async function retrySource(sourceId) {
    const group = state.groups.get(sourceId);
    if (!group || group.retrying) return;
    group.retrying = true;
    try {
      const data = await api.searchSource(sourceId, { q: state.q, page: 1 });
      const items = (data && data.items) || [];
      group.items = items;
      group.count = items.length;
      group.ok = true;
      group.error = '';
      group.elapsed = 0;
      toastOk('「' + group.sourceName + '」重试成功，命中 ' + items.length + ' 条');
    } catch (err) {
      group.error = err.message || '重试失败';
      toastError(err, '重试失败');
    } finally {
      group.retrying = false;
    }
    failPaintKey = '';   // 重试后失败原因/数量可能变了，强制重绘一次清单
    refreshAggregate();
    paintProgress();
    scheduleAggRender();
  }

  function onDone(payload) {
    const data = payload || {};
    if (data.total) state.progress.total = Number(data.total) || state.progress.total;
    if (state.progress.done < state.progress.total) state.progress.done = state.progress.total;
    paintProgress();   // 进度条收起，换成一行摘要
    if (!state.groups.size) {
      resultBox.appendChild(emptyState({
        icon: 'search',
        title: '没有找到「' + state.q + '」',
        desc: '可以换个关键词、切换搜索范围（书名/作者），或检查书源是否可用。',
      }));
      return;
    }
    const tip = hero.querySelector('#search-tip');
    if (tip) tip.textContent = '共 ' + state.groups.size + ' 个书源响应，用时 ' + formatDuration(data.took || 0) + '，合计 ' + totalCount() + ' 条';
    renderResults();
  }

  function onStreamError(err) {
    state.done = true;
    if (state.groups.size) {
      paintProgress();
      toastError(err, '搜索中断');
      renderResults();
      return;
    }
    // 一个源都没回来：进度行没有意义，换成错误态
    if (progressRoot && progressRoot.box.parentNode) progressRoot.box.remove();
    progressRoot = null;
    resultBox.appendChild(errorState(err, () => doSearch(state.q)));
  }

  function totalCount() {
    let n = 0;
    state.groups.forEach((g) => { n += g.items.length; });
    return n;
  }

  /* ---------------- 聚合 ---------------- */

  function refreshAggregate() {
    const map = new Map();
    state.groups.forEach((group) => {
      for (const item of group.items) {
        const key = dedupeKey(item.name, item.author);
        let entry = map.get(key);
        if (!entry) {
          entry = { key, name: item.name, author: item.author, items: [], best: item };
          map.set(key, entry);
        }
        entry.items.push(item);
        if ((Number(item.score) || 0) > (Number(entry.best.score) || 0)) entry.best = item;
      }
    });
    state.aggregate = Array.from(map.values());
  }

  // 边搜边出：把 150ms 内的多次推送合并成一次渲染，避免每个源回来都全量重绘
  const scheduleAggRender = debounce(() => { renderResults(); }, 150);

  /* ---------------- 渲染结果 ---------------- */

  function passFilter(item) {
    if (state.coverOnly && !item.coverUrl) return false;
    return true;
  }

  function weightOf(sourceId) {
    const meta = state.sources.find((s) => s.id === sourceId);
    return meta ? Number(meta.weight) || 0 : 0;
  }

  function sortAggregate(list) {
    const arr = list.slice();
    if (state.sort === 'name') {
      arr.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'));
    } else if (state.sort === 'weight') {
      arr.sort((a, b) => weightOf(b.best.sourceId) - weightOf(a.best.sourceId));
    } else {
      arr.sort((a, b) => (Number(b.best.score) || 0) - (Number(a.best.score) || 0));
    }
    return arr;
  }

  function renderResults() {
    if (!aggWrap) return;
    clear(aggWrap);

    const list = sortAggregate(state.aggregate.filter((entry) => entry.items.some(passFilter)));
    if (!list.length) {
      aggWrap.appendChild(emptyState({ icon: 'search', title: '没有符合筛选条件的结果', desc: '试试关闭「仅有封面」，或换个关键词 / 调整书源范围。' }));
      return;
    }
    const grid = h('div', { class: 'result-list' });
    for (const entry of list) {
      // origins = 同一本书在各书源里的全部结果，默认折叠在「N 个来源」里
      grid.appendChild(buildResultCard(entry.best, { origins: entry.items }));
    }
    aggWrap.appendChild(grid);
  }

  /* ---------------- 结果卡片 ---------------- */

  /**
   * 结果卡片
   * @param {object} item 聚合后相关度最高的那个来源
   * @param {object} opts { origins: 同一本书的全部来源（含 item 自身） }
   */
  function buildResultCard(item, opts = {}) {
    const origins = Array.isArray(opts.origins) && opts.origins.length ? opts.origins : [item];
    const srcCount = origins.length;

    const coverBox = h('div', { class: 'cover' });
    if (item.coverUrl) {
      const img = h('img', {
        alt: item.name || '封面', loading: 'lazy', decoding: 'async', src: item.coverUrl,
        on: {
          error: () => { img.remove(); coverBox.appendChild(coverPlaceholder(item.name)); },
        },
      });
      coverBox.appendChild(img);
    } else {
      coverBox.appendChild(coverPlaceholder(item.name));
    }

    const title = h('div', { class: 'result-title' },
      h('span', { class: 'name' }, highlightText(item.name || '未知书名', state.q)));
    const lines = [];
    if (item.author) lines.push(h('div', { class: 'result-author' }, icon('edit', 12), h('span', { text: ' ' + item.author })));

    // 来源明细默认收起：多个来源时点「N 个来源」才展开，避免一屏全是来源名
    const originsBox = h('div', { class: 'origins-box', style: { display: 'none' } });
    let originsPainted = false;

    function paintOrigins() {
      for (const src of origins) {
        originsBox.appendChild(h('div', { class: 'origin-row' },
          h('span', { class: 'origin-name nowrap', text: src.sourceName || ('书源 #' + src.sourceId) }),
          h('span', { class: 'score-bar', title: '相关度 ' + Math.round(Number(src.score) || 0) },
            h('i', { style: { width: Math.round(Number(src.score) || 0) + '%' } })),
          h('button', {
            class: 'btn btn-sm', type: 'button', text: '用此来源',
            on: { click: (ev) => { ev.stopPropagation(); resolveAndOpen(src); } },
          })
        ));
      }
    }

    const originsToggle = h('button', {
      class: 'badge badge-primary origins-toggle', type: 'button', 'aria-expanded': 'false',
      title: '这本书在 ' + srcCount + ' 个书源里能搜到，点开看具体来源',
      on: { click: (ev) => { ev.stopPropagation(); toggleOrigins(); } },
    }, h('span', { text: srcCount + ' 个来源' }), icon('down', 12));

    function toggleOrigins() {
      const open = originsBox.style.display === 'none';
      if (open && !originsPainted) { paintOrigins(); originsPainted = true; }   // 首次展开才建节点
      originsBox.style.display = open ? '' : 'none';
      originsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    const tags = h('div', { class: 'result-tags' },
      srcCount > 1
        ? originsToggle
        : h('span', { class: 'badge badge-primary', text: item.sourceName || ('书源 #' + item.sourceId) }),
      h('span', { class: 'badge', text: '匹配 ' + Math.round(Number(item.score) || 0) })
    );

    const actions = h('div', { class: 'result-actions' },
      h('button', {
        class: 'btn btn-sm', type: 'button',
        on: { click: (ev) => { ev.stopPropagation(); addToShelf(item); } },
      }, icon('plus', 14), h('span', { text: '加入书架' })),
      h('button', {
        class: 'btn btn-sm', type: 'button',
        title: '这本书在多个书源里都有，点这里挑一个',
        on: { click: (ev) => { ev.stopPropagation(); compareSources(item, origins); } },
      }, icon('link', 14), h('span', { text: srcCount > 1 ? ('换源（' + srcCount + '）') : '换源对比' }))
    );

    const card = h('div', {
      class: 'result-card',
      role: 'button', tabindex: '0',
      on: {
        click: () => resolveAndOpen(item),
        // 只响应卡片自身的回车，避免卡片内按钮的回车被当成「打开这本书」
        keydown: (ev) => { if (ev.key === 'Enter' && ev.target === card) resolveAndOpen(item); },
      },
    },
      coverBox,
      h('div', { class: 'result-main' }, title, lines, tags, originsBox, actions)
    );
    return card;
  }

  function coverPlaceholder(name) {
    return h('div', { class: 'cover-ph', text: String(name || '书').slice(0, 2) });
  }

  async function resolveAndOpen(item) {
    toast('正在打开《' + (item.name || '') + '》…');
    try {
      const book = await api.resolveBook({
        sourceId: item.sourceId,
        bookUrl: item.bookUrl,
        name: item.name,
        author: item.author,
      });
      if (book && book.id) location.hash = '#/book/' + book.id;
      else toastErr('无法解析该书籍');
    } catch (err) {
      toastError(err, '打开失败');
    }
  }

  async function addToShelf(item) {
    try {
      await api.shelfAdd({
        sourceId: item.sourceId,
        bookUrl: item.bookUrl,
        name: item.name,
        author: item.author,
      });
      toastOk('已加入书架');
    } catch (err) {
      toastError(err, '加入书架失败');
    }
  }

  /** 换源对比：列出同名书的全部来源 */
  function compareSources(item, origins) {
    const list = origins && origins.length ? origins : [item];
    const body = h('div', {},
      h('p', { class: 'form-hint', style: { marginBottom: '10px' }, text: '以下为同名书籍在不同书源的结果，选择其一即可开始阅读。' }),
      h('div', {}, list.map((src) => h('div', { class: 'alt-item' },
        h('div', { class: 'alt-main' },
          h('div', { style: { fontWeight: '600' }, text: src.sourceName || ('书源 #' + src.sourceId) }),
          h('div', { class: 'small muted nowrap', text: (src.author ? src.author + ' · ' : '') + (src.lastChapter || '暂无最新章节信息') })
        ),
        h('div', { class: 'score-bar', title: '相关度 ' + Math.round(Number(src.score) || 0) },
          h('i', { style: { width: Math.round(Number(src.score) || 0) + '%' } })),
        h('button', {
          class: 'btn btn-sm btn-primary', type: 'button', text: '用此来源',
          on: { click: () => { handle.close(); resolveAndOpen(src); } },
        })
      )))
    );
    const handle = openModal({ title: '换源对比 · ' + (item.name || ''), size: 'md', body });
  }

  /* ---------------- 初始化 ---------------- */

  // 一次拉全书源元数据（分页 200/页）：权重排序、「全部启用(N)」文案、已选源名 chip 都要用。
  // 失败不影响搜索，只是少一点元信息。
  loadAllSources().then((list) => {
    state.sources = list;
    state.enabledTotal = list.filter((s) => s.enabled !== false).length;
    for (const s of list) state.sourceNames.set(s.id, s.name || ('#' + s.id));
    syncScope();
  }).catch(() => {});

  loadHistory();

  // URL 中带关键词时自动搜索
  if (params && params.q) doSearch(params.q);
  else input.focus();

  // 页面卸载时关闭 SSE
  return function cleanup() {
    closeStream();
  };
}

export default render;
