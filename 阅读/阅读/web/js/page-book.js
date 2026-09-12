/**
 * page-book.js —— 书籍详情页
 * 详情 / 目录（分页渲染 + 搜索 + 正倒序 + 缓存标记）/ 换源 / 缓存下载。
 */

import { api, bookAlternativesStreamUrl } from './api.js';
import {
  h, clear, icon, iconButton, toast, toastOk, toastError, toastWarn,
  openModal, confirmDialog, emptyState, errorState, loadingBlock,
  longPress, debounce, fromNow, formatTime, hostOf,
} from './ui.js';

const CHUNK = 200;

export async function render(root, params) {
  const bookId = Number(params.id);
  const state = {
    book: null,
    chapters: [],
    progress: null,
    order: 'asc',
    filter: '',
    cachePoll: null,
    observer: null,
    destroyed: false,
    altItems: null,     // 换源候选缓存
    altAt: 0,
    altSearched: 0,
  };

  clear(root);
  const headBox = h('div', {});
  const tabsBox = h('div', {});
  const panelBox = h('div', {});
  root.appendChild(headBox);
  root.appendChild(tabsBox);
  root.appendChild(panelBox);
  headBox.appendChild(loadingBlock('正在加载书籍信息…'));

  /* ---------------- 加载 ---------------- */

  async function loadAll() {
    try {
      const [book, progress] = await Promise.all([
        api.bookGet(bookId, true),
        api.progressGet(bookId).catch(() => null),
      ]);
      state.book = book || {};
      state.progress = progress;
      renderHead();
      renderTabs();
      // 目录异步加载，避免阻塞详情展示
      loadChapters();
    } catch (err) {
      clear(headBox);
      headBox.appendChild(errorState(err, () => { clear(headBox); headBox.appendChild(loadingBlock('正在重新加载…')); loadAll(); }));
    }
  }

  async function loadChapters(refresh) {
    panelBox.dataset.pending = '1';
    try {
      const data = await api.bookChapters(bookId, refresh);
      state.chapters = (data && data.items) || [];
      state.book.chapterCount = state.chapters.length;
      renderTabs();
      renderPanel();
    } catch (err) {
      if (state.book) {
        toastError(err, '目录加载失败');
        panelBox.dataset.pending = '0';
      }
    }
  }

  /* ---------------- 详情头部 ---------------- */

  function renderHead() {
    const book = state.book || {};
    const progress = state.progress || {};
    const hasProgress = Number(progress.chapterIndex) > 0 || Number(progress.percent) > 0;

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

    const introText = h('div', { class: 'intro-text clamped', text: book.intro || '暂无简介' });
    const introToggle = h('button', {
      class: 'btn btn-sm btn-ghost', type: 'button', text: '展开全部',
      on: {
        click: () => {
          const clamped = introText.classList.toggle('clamped');
          introToggle.textContent = clamped ? '展开全部' : '收起';
        },
      },
    });
    if (!book.intro || book.intro.length < 120) introToggle.style.display = 'none';

    const metaChips = h('div', { class: 'book-meta' },
      book.sourceName ? h('span', { class: 'badge badge-primary', text: book.sourceName }) : null,
      book.kind ? h('span', { class: 'badge', text: book.kind }) : null,
      book.status ? h('span', { class: 'badge', text: book.status }) : null,
      book.wordCount ? h('span', { class: 'badge', text: book.wordCount }) : null,
      book.chapterCount ? h('span', { class: 'badge', text: '共 ' + book.chapterCount + ' 章' }) : null,
      hasProgress ? h('span', { class: 'badge badge-ok', text: '已读至 ' + Math.round((Number(progress.percent) || 0) * 100) + '%' }) : null
    );

    const readBtn = h('button', {
      class: 'btn btn-primary', type: 'button',
      on: { click: () => startReading() },
    }, icon('play', 16), h('span', { text: hasProgress ? '继续阅读（第 ' + (Number(progress.chapterIndex) + 1) + ' 章）' : '开始阅读' }));

    const shelfBtn = h('button', {
      class: 'btn', type: 'button',
      on: {
        click: async () => {
          try {
            if (book.inShelf) {
              await api.shelfRemove(book.id);
              book.inShelf = false;
              toastOk('已移出书架');
            } else {
              await api.shelfAdd({ bookId: book.id });
              book.inShelf = true;
              toastOk('已加入书架');
            }
            renderHead();
          } catch (err) { toastError(err, '操作失败'); }
        },
      },
    }, icon(book.inShelf ? 'check' : 'plus', 16), h('span', { text: book.inShelf ? '已在书架' : '加入书架' }));

    const actions = h('div', { class: 'book-actions' },
      readBtn,
      shelfBtn,
      h('button', { class: 'btn', type: 'button', on: { click: () => switchTab('alt') } }, icon('link', 16), h('span', { text: '换源' })),
      h('button', { class: 'btn', type: 'button', on: { click: () => { switchTab('cache'); cacheAll(); } } }, icon('download', 16), h('span', { text: '缓存全部' })),
      h('button', { class: 'btn btn-ghost', type: 'button', on: { click: () => deleteBook() } }, icon('trash', 16), h('span', { text: '删除' }))
    );

    clear(headBox);
    headBox.appendChild(h('div', { class: 'card book-hero' },
      coverBox,
      h('div', { class: 'book-info' },
        h('h1', { class: 'book-name', text: book.name || '未命名' }),
        h('div', { class: 'small muted', text: (book.author || '佚名') + (book.lastChapter ? ' · 最新：' + book.lastChapter : '') }),
        metaChips,
        actions,
        h('div', {}, h('div', { class: 'form-label', text: '简介' }), introText, introToggle)
      )
    ));
  }

  async function deleteBook() {
    const ok = await confirmDialog('确定删除《' + (state.book.name || '') + '》及其缓存吗？此操作不可恢复。', { danger: true, okLabel: '删除' });
    if (!ok) return;
    try {
      await api.bookDelete(bookId);
      toastOk('已删除');
      location.hash = '#/shelf';
    } catch (err) { toastError(err, '删除失败'); }
  }

  function startReading() {
    const idx = Number(state.progress && state.progress.chapterIndex) || 0;
    location.hash = '#/read/' + bookId + '?chapter=' + idx;
  }

  /* ---------------- 标签页 ---------------- */

  let activeTab = 'toc';
  function renderTabs() {
    clear(tabsBox);
    const tabs = [
      ['toc', '目录' + (state.chapters.length ? '（' + state.chapters.length + '）' : '')],
      ['alt', '换源'],
      ['cache', '缓存'],
    ];
    const bar = h('div', { class: 'tabs' });
    for (const [key, label] of tabs) {
      bar.appendChild(h('button', {
        class: 'tab' + (activeTab === key ? ' active' : ''),
        type: 'button', text: label,
        on: { click: () => switchTab(key) },
      }));
    }
    tabsBox.appendChild(bar);
  }

  function switchTab(key) {
    // 离开换源页时断掉 SSE，避免后台继续占用连接
    if (key !== 'alt') closeAltStream();
    activeTab = key;
    renderTabs();
    renderPanel();
  }

  function renderPanel() {
    clear(panelBox);
    if (activeTab === 'toc') renderToc();
    else if (activeTab === 'alt') renderAlt();
    else renderCache();
  }

  /* ---------------- 目录 ---------------- */

  function renderToc() {
    if (!state.chapters.length) {
      panelBox.appendChild(loadingBlock('正在加载目录…'));
      return;
    }
    const searchInput = h('input', {
      class: 'input input-sm', type: 'search', placeholder: '搜索章节标题…',
      value: state.filter,
      on: { input: debounce(() => { state.filter = searchInput.value.trim(); renderTocList(listBox); }, 250) },
    });
    const orderBtn = h('button', {
      class: 'btn btn-sm', type: 'button',
      on: { click: () => { state.order = state.order === 'asc' ? 'desc' : 'asc'; renderPanel(); } },
    }, icon('sort', 14), h('span', { text: state.order === 'asc' ? '正序' : '倒序' }));
    const refreshBtn = h('button', {
      class: 'btn btn-sm', type: 'button',
      on: { click: () => { toast('正在刷新目录…'); loadChapters(true); } },
    }, icon('refresh', 14), h('span', { text: '刷新目录' }));

    panelBox.appendChild(h('div', { class: 'toolbar' },
      h('div', { class: 'search-box', style: { maxWidth: '300px' } }, icon('search', 16), searchInput),
      orderBtn, refreshBtn
    ));

    const listBox = h('div', { class: 'card chapter-list' });
    panelBox.appendChild(listBox);
    renderTocList(listBox);
  }

  function renderTocList(listBox) {
    clear(listBox);
    const cur = Number(state.progress && state.progress.chapterIndex);
    let list = state.chapters.slice();
    if (state.filter) {
      const kw = state.filter.toLowerCase();
      list = list.filter((ch) => String(ch.title || '').toLowerCase().indexOf(kw) >= 0);
    }
    if (state.order === 'desc') list.reverse();

    if (!list.length) {
      listBox.appendChild(emptyState({ icon: 'list', title: state.filter ? '没有匹配的章节' : '目录为空', desc: state.filter ? '换个关键词试试' : '可点击「刷新目录」重新抓取' }));
      return;
    }

    let rendered = 0;
    const renderChunk = () => {
      const end = Math.min(list.length, rendered + CHUNK);
      const frag = document.createDocumentFragment();
      for (let i = rendered; i < end; i++) {
        const ch = list[i];
        frag.appendChild(h('div', {
          class: 'chapter-item' + (ch.index === cur ? ' current' : ''),
          on: { click: () => { location.hash = '#/read/' + bookId + '?chapter=' + ch.index; } },
        },
          h('span', { class: 'idx', text: '#' + (ch.index + 1) }),
          h('span', { class: 'title', text: ch.title || ('第 ' + (ch.index + 1) + ' 章') }),
          ch.cached ? h('span', { class: 'cached', title: '已缓存' }, icon('check', 15)) : null
        ));
      }
      rendered = end;
      const old = listBox.querySelector('.toc-sentinel');
      if (old) old.remove();
      listBox.appendChild(frag);
      if (rendered < list.length) {
        const sen = h('div', { class: 'toc-sentinel', style: { height: '2px' } });
        listBox.appendChild(sen);
        if (state.observer) state.observer.disconnect();
        state.observer = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) renderChunk();
        }, { rootMargin: '400px' });
        state.observer.observe(sen);
      }
    };
    renderChunk();
  }

  /* ---------------- 换源 ---------------- */

  let altStream = null;

  function closeAltStream() {
    if (altStream) {
      try { altStream.close(); } catch (e) { /* 忽略 */ }
      altStream = null;
    }
  }

  /** 合并候选：按「书源 + 书籍地址」去重，按匹配度倒序 */
  function mergeAlt(current, incoming) {
    const map = new Map();
    for (const it of [].concat(current || [], incoming || [])) {
      if (!it) continue;
      const k = it.sourceId + '|' + it.bookUrl;
      const prev = map.get(k);
      if (!prev || (Number(it.score) || 0) > (Number(prev.score) || 0)) map.set(k, it);
    }
    return Array.from(map.values()).sort((a, b) =>
      (Number(b.score) || 0) - (Number(a.score) || 0)
      || String(a.sourceName || '').localeCompare(String(b.sourceName || '')));
  }

  /**
   * 换源：走 SSE 边搜边出结果。
   *
   * 为什么不再用一次性请求：候选要并发问几十上百个书源，
   * 全部跑完再返回就是十几秒白屏 —— 这正是用户反馈的「换源卡顿」。
   * 改成流式后第一个候选通常 1~2 秒就出现，用户可以先挑起来。
   */
  function renderAlt(force = false) {
    // 3 分钟内的结果直接复用，来回切页签不重搜
    if (!force && state.altItems && Date.now() - (state.altAt || 0) < 180000) {
      paintAlt(state.altItems, state.altSearched, { done: true, fromCache: true, responded: state.altSearched, total: state.altSearched });
      return;
    }
    closeAltStream();
    state.altItems = [];
    state.altAt = 0;
    state.altSearched = 0;

    const live = { responded: 0, total: 0, succeeded: 0, failed: 0, done: false, fromCache: false, startedAt: Date.now(), took: 0, error: '' };
    paintAlt(state.altItems, 0, live);

    let es;
    try {
      es = new EventSource(bookAlternativesStreamUrl(bookId, { limit: 40, maxSources: 40 }));
    } catch (err) {
      clear(panelBox);
      panelBox.appendChild(errorState(err, () => renderAlt(true)));
      return;
    }
    altStream = es;

    es.onmessage = (e) => {
      let evt;
      try { evt = JSON.parse(e.data); } catch (err) { return; }

      if (evt.type === 'cached') {
        state.altItems = mergeAlt([], evt.items);
        state.altSearched = evt.searched || 0;
        state.altAt = Date.now();
        live.fromCache = true;
        live.done = true;
        paintAlt(state.altItems, state.altSearched, live);
        closeAltStream();
        return;
      }

      if (evt.type === 'source') {
        if (evt.progress) {
          live.responded = evt.progress.responded || live.responded;
          live.total = evt.progress.total || live.total;
          live.succeeded = evt.progress.succeeded || live.succeeded;
          live.failed = evt.progress.failed || live.failed;
        }
        if (evt.items && evt.items.length) state.altItems = mergeAlt(state.altItems, evt.items);
        paintAlt(state.altItems, live.total, live);
        return;
      }

      if (evt.type === 'done') {
        live.done = true;
        live.took = evt.took || (Date.now() - live.startedAt);
        live.succeeded = typeof evt.succeeded === 'number' ? evt.succeeded : live.succeeded;
        live.failed = typeof evt.failed === 'number' ? evt.failed : live.failed;
        state.altSearched = evt.searched || live.total || 0;
        state.altItems = mergeAlt(state.altItems, []);
        state.altAt = Date.now();
        closeAltStream();
        paintAlt(state.altItems, state.altSearched, live);
        return;
      }

      if (evt.type === 'error') {
        live.error = evt.message || '换源失败';
        closeAltStream();
        clear(panelBox);
        panelBox.appendChild(errorState(new Error(live.error), () => renderAlt(true)));
      }
    };

    es.onerror = () => {
      // EventSource 断线会自动重连，而重连意味着重新搜一遍所有书源 —— 必须主动关掉
      closeAltStream();
      if (live.done) return;
      clear(panelBox);
      panelBox.appendChild(errorState(new Error('换源连接中断，请重试'), () => renderAlt(true)));
    };
  }

  /**
   * 渲染换源面板。
   * live.done=false 时是「搜索中」：显示进度条 + 已经到手的候选；
   * live.done=true 时收尾：显示最终统计。
   */
  function paintAlt(items, searched, live) {
    live = live || {};
    clear(panelBox);

    const total = Number(live.total) || 0;
    const responded = Number(live.responded) || 0;
    const pct = total ? Math.min(100, Math.round((responded / total) * 100)) : 0;
    const headline = live.done
      ? ('已检查 ' + (total || searched || 0) + ' 个书源，找到 ' + items.length + ' 个候选'
         + (live.took ? ' · 用时 ' + (live.took / 1000).toFixed(1) + ' 秒' : '')
         + (live.failed ? ' · ' + live.failed + ' 个源无响应' : ''))
      : ('正在查找同名书… 已检查 ' + responded + (total ? '/' + total : '') + ' 个书源' + (items.length ? '，已找到 ' + items.length + ' 个' : ''));

    panelBox.appendChild(h('div', { class: 'card card-pad', style: { marginBottom: '10px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h('strong', { text: headline }),
        h('button', {
          class: 'btn btn-sm btn-ghost', type: 'button',
          text: live.done ? '重新查找' : '停止',
          on: {
            click: () => {
              if (live.done) { renderAlt(true); return; }
              closeAltStream();
              paintAlt(state.altItems, state.altSearched, Object.assign({}, live, { done: true, took: Date.now() - (live.startedAt || Date.now()) }));
            },
          },
        })),
      live.done ? null : h('div', { class: 'progress-bar', style: { marginTop: '8px' } }, h('i', { style: { width: pct + '%' } })),
      h('p', { class: 'form-hint', text: live.done
        ? '换源会保留当前阅读进度百分比。'
        : '结果边搜边出，不用等全部书源跑完。' })));

    if (!items.length) {
      if (!live.done) { panelBox.appendChild(loadingBlock('正在搜索同名书籍…')); return; }
      panelBox.appendChild(emptyState({
        icon: 'link',
        title: '没有找到可替换的来源',
        desc: '已检查 ' + (searched || 0) + ' 个书源。可能是这些书源都没收录这本书，或它们的搜索规则已失效——可以去「书源管理」跑一次体检看看。',
        actionLabel: '重新查找',
        onAction: () => renderAlt(true),
      }));
      return;
    }
    {
      const card = h('div', { class: 'card' });
      for (const item of items) {
        const score = Math.round(Number(item.score) || 0);
        card.appendChild(h('div', { class: 'alt-item' },
          h('div', { class: 'alt-main' },
            h('div', { style: { fontWeight: '600' }, text: item.name || '未命名' }),
            h('div', { class: 'small muted nowrap', text: (item.author || '佚名') + ' · ' + (item.sourceName || '') }),
            h('div', { class: 'small muted nowrap', text: item.lastChapter || '暂无最新章节' })
          ),
          h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', flex: 'none' } },
            h('span', { class: 'score-bar' }, h('i', { style: { width: score + '%' } })),
            h('span', { class: 'small muted', text: score + '%' })),
          h('button', {
            class: 'btn btn-sm btn-primary', type: 'button', text: '切换',
            on: { click: () => changeSource(item) },
          })
        ));
      }
      panelBox.appendChild(card);
    }
  }

  async function changeSource(item) {
    const ok = await confirmDialog('确定切换到该书源吗？\n\n书名：' + (item.name || '') + '\n来源：' + (item.sourceName || ''), { okLabel: '切换' });
    if (!ok) return;
    try {
      const book = await api.bookChangeSource(bookId, { sourceId: item.sourceId, bookUrl: item.bookUrl, keepProgress: 1 });
      toastOk('换源成功');
      if (book && book.id && book.id !== bookId) location.hash = '#/book/' + book.id;
      else location.reload();
    } catch (err) { toastError(err, '换源失败'); }
  }

  /* ---------------- 缓存 ---------------- */

  function renderCache() {
    const card = h('div', { class: 'card card-pad cache-panel' });
    const total = state.chapters.length || state.book.chapterCount || 0;
    const fromInput = h('input', { class: 'input input-sm', type: 'number', min: '1', value: '1', style: { width: '110px' } });
    const toInput = h('input', { class: 'input input-sm', type: 'number', min: '1', value: String(total || 1), style: { width: '110px' } });
    const statBox = h('div', { class: 'cache-stat', id: 'cache-stat' });
    const bar = h('div', { class: 'progress-bar' }, h('i', { style: { width: '0%' } }));
    const barLabel = h('div', { class: 'small muted' });

    card.appendChild(h('div', { class: 'form-label', text: '缓存范围（章节序号，从 1 开始）' }));
    card.appendChild(h('div', { class: 'form-inline' },
      h('span', { class: 'small muted', text: '从' }), fromInput,
      h('span', { class: 'small muted', text: '到' }), toInput,
      h('button', {
        class: 'btn btn-sm btn-primary', type: 'button',
        on: { click: () => startCache(Number(fromInput.value), Number(toInput.value)) },
      }, icon('download', 14), h('span', { text: '开始缓存' })),
      h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => startCache(1, total) } }, h('span', { text: '缓存全书' }))
    ));
    card.appendChild(statBox);
    card.appendChild(bar);
    card.appendChild(barLabel);
    card.appendChild(h('p', { class: 'form-hint', text: '缓存由服务端后台执行，可随时离开本页面，回来后进度会自动刷新。' }));
    panelBox.appendChild(card);

    refreshCacheStat(statBox, bar, barLabel);
  }

  async function refreshCacheStat(statBox, bar, barLabel) {
    try {
      const data = await api.bookCacheStatus(bookId);
      const cached = Number(data && data.cached) || 0;
      const total = Number(data && data.total) || state.chapters.length || 1;
      const percent = total ? Math.round(cached / total * 100) : 0;
      clear(statBox);
      statBox.appendChild(statItem(String(cached), '已缓存'));
      statBox.appendChild(statItem(String(total), '总章节'));
      statBox.appendChild(statItem(String((data && data.queued) || 0), '排队中'));
      statBox.appendChild(statItem(data && data.running ? '进行中' : '空闲', '状态'));
      bar.firstChild.style.width = percent + '%';
      barLabel.textContent = '已完成 ' + percent + '%';
      if (data && data.running) schedulePoll(statBox, bar, barLabel);
      else if (state.cachePoll) { clearTimeout(state.cachePoll); state.cachePoll = null; }
    } catch (err) {
      clear(statBox);
      statBox.appendChild(h('span', { class: 'small muted', text: '缓存状态获取失败：' + (err.message || '') }));
    }
  }

  function schedulePoll(statBox, bar, barLabel) {
    if (state.destroyed) return;
    if (state.cachePoll) clearTimeout(state.cachePoll);
    state.cachePoll = setTimeout(() => refreshCacheStat(statBox, bar, barLabel), 1500);
  }

  function statItem(num, label) {
    return h('div', { class: 'item' }, h('span', { class: 'num', text: num }), h('span', { class: 'lbl', text: label }));
  }

  async function startCache(from, to) {
    const total = state.chapters.length || state.book.chapterCount || 0;
    if (!total) { toastWarn('目录尚未加载，无法缓存'); return; }
    const f = Math.max(0, (from || 1) - 1);
    const t = Math.min(total - 1, (to || total) - 1);
    if (t < f) { toastWarn('结束章节不能小于起始章节'); return; }
    try {
      const data = await api.bookCacheStart(bookId, { from: f, to: t });
      toastOk('已加入缓存队列（' + ((data && data.queued) || (t - f + 1)) + ' 章）');
      switchTab('cache');
      cacheAllTriggered = true;
    } catch (err) { toastError(err, '缓存失败'); }
  }

  let cacheAllTriggered = false;
  function cacheAll() {
    // 由「缓存全部」按钮触发：切到缓存页并自动开始
    setTimeout(() => {
      if (!state.chapters.length) { toastWarn('目录尚未加载完成，请在缓存页手动开始'); return; }
      startCache(1, state.chapters.length);
      cacheAllTriggered = false;
    }, 60);
  }

  await loadAll();

  return function cleanup() {
    state.destroyed = true;
    if (state.cachePoll) clearTimeout(state.cachePoll);
    if (state.observer) state.observer.disconnect();
  };
}

export default render;
