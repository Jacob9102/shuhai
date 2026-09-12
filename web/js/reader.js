/**
 * reader.js —— 阅读器核心
 *
 * 职责：加载书籍/目录/进度 → 渲染正文 → 驱动翻页引擎 → 手势/键盘交互 →
 *      书签笔记 → 自动阅读 → 阅读计时与进度上报。
 * 所有阅读外观都由 store 中的设置通过 CSS 变量注入，设置改变时零闪烁重绘。
 */

import { api, beaconProgress } from './api.js';
import { getSettings, updateSettings, subscribe, applyMetaTheme } from './store.js';
import {
  h, clear, icon, iconButton, toast, toastOk, toastErr, toastError,
  openModal, confirmDialog, promptDialog, loadingBlock, errorState, actionSheet,
  clamp, throttle, debounce, formatTime, hostOf,
} from './ui.js';
import { Pager } from './reader-pager.js';
import { renderReaderSettings, convertText } from './reader-settings.js';

/** 快捷键说明表（帮助面板与全局设置页共用） */
export const SHORTCUTS = [
  { keys: ['←', '→'], desc: '上一页 / 下一页' },
  { keys: ['↑', '↓'], desc: '向上滚动 / 向下滚动（翻页模式下为上一章 / 下一章）' },
  { keys: ['空格'], desc: '下一页' },
  { keys: ['Esc'], desc: '关闭设置面板 / 目录 / 菜单' },
  { keys: ['F'], desc: '切换全屏' },
  { keys: ['T'], desc: '打开目录' },
  { keys: ['S'], desc: '打开阅读设置' },
  { keys: ['B'], desc: '当前位置添加书签' },
  { keys: ['['], desc: '减小字号' },
  { keys: [']'], desc: '增大字号' },
  { keys: ['?'], desc: '显示 / 关闭本帮助' },
];

/** 预加载缓存上限（章节数） */
const PRELOAD_LIMIT = 3;

export class Reader {
  /**
   * @param {HTMLElement} root 路由容器
   * @param {object} params { id, chapter }
   */
  constructor(root, params) {
    this.root = root;
    this.params = params;
    this.bookId = Number(params.id);

    this.book = null;
    this.chapters = [];
    this.index = 0;
    this.chapterTitle = '';
    this.chapterText = '';      // 原始正文（未做简繁转换）

    this.pager = null;
    this.cache = new Map();     // index -> 章节内容
    this.bookmarks = [];
    this.readSeconds = 0;
    this.pendingSeconds = 0;
    this.lastTick = 0;
    this.destroyed = false;
    this.autoRead = { raf: null, acc: 0, last: 0 };
    this.saveTimer = null;
    this.clockTimer = null;
    this.wakeLock = null;
    this.battery = null;
    this.selMenu = null;
    this.chapterRenderLimit = 200;

    this.disposers = [];
    // 滚动过程中进度回调非常频繁，状态栏刷新做 250ms 节流
    this.throttledStatus = throttle((overall, ratio) => this.updateStatusBar(overall, ratio), 250);
    this.throttledRelayout = throttle(() => this.relayout(), 120);
    this.lastPageMode = null;
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onBeforeUnload = this._onBeforeUnload.bind(this);
  }

  /* ================= 生命周期 ================= */

  async mount() {
    this.buildDom();
    this.applyTheme();
    this.bindGlobalEvents();

    try {
      await this.loadBook();
    } catch (err) {
      this.showFatal(err);
      return this.dispose.bind(this);
    }

    // 目录拿不到时已经在 loadBook 里给了「刷新目录 / 换源」的出口，
    // 这里不要再硬请求第 0 章，否则会用一个 404 把提示盖掉
    if (!this.chapters.length) {
      this.startTimers();
      return this.dispose.bind(this);
    }

    await this.openChapter(this.index, { ratio: this.initialRatio, silent: true });
    this.restoreAutoRead();
    this.refreshBookmarks();
    this.startTimers();
    return this.dispose.bind(this);
  }

  dispose() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.saveProgress(true);
    this.stopAutoRead();
    this.releaseWakeLock();
    if (this.pager) this.pager.destroy();
    this.disposers.forEach((fn) => { try { fn(); } catch (e) { /* 忽略 */ } });
    this.disposers = [];
    if (this.saveTimer) clearInterval(this.saveTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    clear(this.root);
  }

  /* ================= DOM 构建 ================= */

  buildDom() {
    clear(this.root);

    this.bgImg = h('div', { class: 'reader-bg-img' });
    this.viewport = h('div', { class: 'reader-viewport' });
    this.contentEl = h('div', { class: 'reader-content' });
    this.dim = h('div', { class: 'reader-dim' });

    /* 顶部工具栏 */
    this.topBookName = h('div', { class: 'reader-book-name', text: '加载中…' });
    this.topChapterName = h('div', { class: 'reader-chapter-name', text: '' });
    this.topBar = h('div', { class: 'reader-bar reader-bar-top' },
      iconButton('back', '返回', () => this.goBack()),
      h('div', { class: 'reader-title-wrap' }, this.topBookName, this.topChapterName),
      iconButton('list', '目录 (T)', () => this.togglePanel('catalog')),
      iconButton('textSize', '设置 (S)', () => this.toggleSettings()),
      iconButton('more', '更多', (ev) => this.showMoreMenu(ev))
    );

    /* 底部工具栏 */
    this.progressRail = h('div', { class: 'reader-progress-rail' });
    this.progressFill = h('div', { class: 'reader-progress-fill' });
    this.progressKnob = h('div', { class: 'reader-progress-knob' });
    this.progressTip = h('div', {
      class: 'reader-progress-tip',
      style: { position: 'absolute', bottom: '26px', transform: 'translateX(-50%)', background: 'rgba(0,0,0,.8)', color: '#fff', padding: '2px 8px', borderRadius: '6px', fontSize: '11.5px', whiteSpace: 'nowrap', display: 'none', pointerEvents: 'none' },
    });
    this.progressTrack = h('div', { class: 'reader-progress-track' },
      this.progressRail, this.progressFill, this.progressKnob, this.progressTip);
    this.statusLeft = h('div', { class: 'left' });
    this.statusRight = h('div', { class: 'right' });
    this.bottomBar = h('div', { class: 'reader-bar reader-bar-bottom' },
      h('div', { class: 'reader-progress-row' },
        iconButton('left', '上一章', () => this.gotoChapter(this.index - 1), { size: 16 }),
        this.progressTrack,
        iconButton('right', '下一章', () => this.gotoChapter(this.index + 1), { size: 16 })
      ),
      h('div', { class: 'reader-status' }, this.statusLeft, this.statusRight)
    );

    /* 目录面板 */
    this.catalogList = h('div', { class: 'reader-panel-body' });
    this.catalogSearch = h('input', {
      class: 'input input-sm', type: 'search', placeholder: '搜索章节标题…',
      on: { input: debounce(() => this.searchChapters(this.catalogSearch.value.trim()), 260) },
    });
    this.catalogHead = h('div', { class: 'reader-panel-head' },
      h('h3', { text: '目录' }),
      h('span', { class: 'badge', id: 'chapter-total' }),
      iconButton('close', '关闭', () => this.closePanels())
    );
    this.catalogPanel = h('div', { class: 'reader-panel reader-panel-left' },
      this.catalogHead,
      h('div', { style: { padding: '8px 10px', borderBottom: '1px solid var(--ui-border)' } }, this.catalogSearch),
      this.catalogList
    );

    /* 书签面板 */
    this.bookmarkList = h('div', { class: 'reader-panel-body' });
    this.bookmarkPanel = h('div', { class: 'reader-panel reader-panel-right' },
      h('div', { class: 'reader-panel-head' },
        h('h3', { text: '书签与笔记' }),
        iconButton('close', '关闭', () => this.closePanels())
      ),
      this.bookmarkList
    );

    /* 设置抽屉 */
    this.settingsBody = h('div', { class: 'reader-settings-body' });
    this.settingsPanel = h('div', { class: 'reader-settings' },
      h('div', { class: 'reader-panel-head' },
        h('h3', { text: '阅读设置' }),
        iconButton('close', '关闭', () => this.closeSettings())
      ),
      this.settingsBody
    );

    this.mask = h('div', { class: 'reader-mask', on: { click: () => { this.closePanels(); this.closeSettings(); } } });

    this.el = h('div', { class: 'reader hide-bars' },
      h('div', { class: 'reader-bg' }, this.bgImg),
      this.viewport,
      this.dim,
      this.topBar,
      this.bottomBar,
      this.catalogPanel,
      this.bookmarkPanel,
      this.mask,
      this.settingsPanel
    );
    this.root.appendChild(this.el);

    // 设置面板内容（复用全局设置页的同一套控件）
    this.disposeSettingsPanel = renderReaderSettings(this.settingsBody, {
      onChange: () => this.onSettingsChanged(),
    });

    this.viewport.appendChild(this.contentEl);
    this.pager = new Pager(this.viewport, {
      mode: getSettings().pageMode,
      duration: getSettings().animateDuration,
      pageWidth: getSettings().pageWidth,
      pagePadding: getSettings().pagePadding,
      layoutMode: getSettings().layoutMode,
      onTap: (x, y, ev) => this.handleTap(x, y, ev),
      onSwipe: (dir, axis) => this.handleSwipe(dir, axis),
      onProgress: (ratio) => this.updateProgressUi(ratio),
      onBoundary: () => {},
    });
    this.pager.setContent(this.contentEl);

    this.bindBarsAndProgress();
  }

  /* ================= 数据加载 ================= */

  async loadBook() {
    const [book, chapters, progress] = await Promise.all([
      api.bookGet(this.bookId),
      api.bookChapters(this.bookId).catch(() => ({ items: [], total: 0 })),
      api.progressGet(this.bookId).catch(() => null),
    ]);

    this.book = book || {};
    this.chapters = (chapters && chapters.items) || [];
    this.progress = progress || {};

    // 目录拉不到（书源改版、目录地址过期）时自动强制刷新一次再试，
    // 避免用户一进来就只看到「HTTP 404 Not Found」
    if (!this.chapters.length) {
      try {
        const again = await api.bookChapters(this.bookId, true);
        this.chapters = (again && again.items) || [];
        if (this.chapters.length) toastOk('目录已重新加载');
      } catch (err) {
        this.tocError = err;
      }
    }

    this.topBookName.textContent = this.book.name || '未命名';
    document.title = (this.book.name || '阅读') + ' · 书海';

    // 起始章节：URL 参数 > 服务端进度 > 0
    let start = 0;
    if (this.params.chapter !== undefined && this.params.chapter !== null && this.params.chapter !== '') {
      start = Number(this.params.chapter) || 0;
    } else if (this.progress && Number.isFinite(Number(this.progress.chapterIndex))) {
      start = Number(this.progress.chapterIndex) || 0;
    }
    this.index = clamp(start, 0, Math.max(0, this.chapters.length - 1));
    this.initialRatio = (this.params.chapter === undefined || this.params.chapter === null || this.params.chapter === '')
      ? clamp(Number(this.progress && this.progress.chapterPos) || 0, 0, 1)
      : 0;
    this.readSeconds = Number(this.progress && this.progress.readSeconds) || 0;

    this.renderCatalog();
    this.updateChrome();

    if (!this.chapters.length) {
      clear(this.contentEl);
      this.contentEl.appendChild(h('div', { class: 'empty-state error-state' },
        h('div', { class: 'empty-icon' }, icon('info', 42)),
        h('h3', { class: 'empty-title', text: '拿不到章节目录' }),
        h('p', { class: 'empty-desc', text: (this.tocError && this.tocError.message) || '书源可能已失效或站点改版。' }),
        h('div', { class: 'empty-actions' },
          h('button', {
            class: 'btn btn-primary', type: 'button',
            on: { click: async () => { const n = await this.refreshChapters(); if (n) this.openChapter(this.index, { ratio: 0 }); } },
          }, icon('refresh', 16), h('span', { text: '刷新目录' })),
          h('a', { class: 'btn', href: '#/search?q=' + encodeURIComponent(this.book.name || ''), text: '重新搜索这本书' }),
          h('a', { class: 'btn btn-ghost', href: '#/book/' + this.bookId, text: '换一个书源' }),
          h('a', { class: 'btn btn-ghost', href: '#/shelf', text: '返回书架' })
        )
      ));
      return false;
    }
    return true;
  }

  /** 拉取章节内容（带缓存） */
  async fetchChapter(index) {
    if (this.cache.has(index)) return this.cache.get(index);
    const data = await api.bookContent(this.bookId, { index });
    // 缓存只保留有限条数，避免长时阅读内存膨胀
    if (this.cache.size >= PRELOAD_LIMIT + 2) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== index) this.cache.delete(firstKey);
    }
    this.cache.set(index, data);
    return data;
  }

  /** 预取相邻章节，切换零等待 */
  preloadNeighbors() {
    for (const offset of [1, -1, 2]) {
      const idx = this.index + offset;
      if (idx < 0 || idx >= this.chapters.length || this.cache.has(idx)) continue;
      this.fetchChapter(idx).catch(() => {});
    }
  }

  /**
   * 打开指定章节
   * @param {number} index
   * @param {object} opts { ratio, silent }
   */
  async openChapter(index, opts = {}) {
    if (index < 0 || (this.chapters.length && index >= this.chapters.length)) {
      toast('已经是' + (index < 0 ? '第一章' : '最后一章') + '了');
      return false;
    }
    const fromCache = this.cache.has(index);
    if (!fromCache) this.showChapterLoading();

    let data;
    try {
      data = await this.fetchChapter(index);
    } catch (err) {
      this.showChapterError(err, index);
      return false;
    }
    if (this.destroyed) return false;

    // 记录上一章进度
    if (!opts.silent) this.saveProgress(true);

    this.index = index;
    this.chapterTitle = data.title || ('第 ' + (index + 1) + ' 章');
    this.chapterText = data.content || '';
    this.renderChapterBody();
    this.pager.setOptions({
      mode: getSettings().pageMode,
      duration: getSettings().animateDuration,
      pageWidth: getSettings().pageWidth,
      pagePadding: this.effectivePadding(),
      layoutMode: getSettings().layoutMode,
    });
    const ratio = opts.ratio !== undefined ? opts.ratio : 0;
    if (ratio > 0) this.pager.setRatio(ratio);

    this.updateChrome();
    this.highlightCatalog();
    this.updateProgressUi(this.pager.getRatio());
    this.preloadNeighbors();
    this.saveProgress(true);
    return true;
  }

  /** 把纯文本渲染为段落 DOM（textContent，绝不拼接 HTML） */
  renderChapterBody() {
    clear(this.contentEl);
    this.contentEl.appendChild(h('h1', { class: 'reader-chapter-title', text: this.chapterTitle }));

    // 开启「简繁转换」时把繁体正文转为简体显示（字符级映射表见 reader-settings.js）
    const text = getSettings().simplify ? convertText(this.chapterText, false) : this.chapterText;
    const lines = String(text).split(/\n+/);
    const frag = document.createDocumentFragment();
    for (const raw of lines) {
      const line = raw.replace(/[\u3000\s]+$/g, '').trim();
      if (!line) continue;
      const p = document.createElement('p');
      p.textContent = line;
      if (/^第[一二三四五六七八九十百千万零〇\d]+[章节卷回]/.test(line) && line.length < 40) {
        p.className = 'reader-volume-title no-indent';
      }
      frag.appendChild(p);
    }
    if (!frag.childNodes.length) {
      frag.appendChild(h('p', { class: 'no-indent', text: '（本章正文为空，可尝试下一章或切换书源）' }));
    }
    this.contentEl.appendChild(frag);

    // 章节末尾的衔接入口
    const end = h('div', { class: 'chapter-end' },
      h('div', { class: 'tip', text: '本章完' }),
      h('div', { class: 'chapter-end-actions', style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' } },
        h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => this.gotoChapter(this.index - 1) } }, icon('left', 14), h('span', { text: '上一章' })),
        h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => this.togglePanel('catalog') } }, icon('list', 14), h('span', { text: '目录' })),
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', on: { click: () => this.gotoChapter(this.index + 1) } }, h('span', { text: '下一章' }), icon('right', 14))
      )
    );
    this.contentEl.appendChild(end);
  }

  /** 切换章节 */
  async gotoChapter(index) {
    if (index === this.index) return;
    if (index < 0) { toast('已经是第一章了'); return; }
    if (this.chapters.length && index >= this.chapters.length) { toast('已经是最后一章了'); return; }
    await this.openChapter(index, { ratio: 0 });
    this.viewport.scrollTop = 0;
  }

  /* ================= 外观 ================= */

  /** 移动端自动收窄内边距 */
  effectivePadding() {
    const base = getSettings().pagePadding;
    if (window.innerWidth <= 768) return Math.min(base, 16);
    return base;
  }

  /** 字号随视口缩放（可关） */
  effectiveFontSize() {
    const s = getSettings();
    if (!s.fontScaleWithWidth) return s.fontSize;
    const factor = clamp(window.innerWidth / 900, 0.78, 1);
    return Math.max(12, Math.round(s.fontSize * factor));
  }

  /** 把设置写入 CSS 变量 */
  applyTheme() {
    const s = getSettings();
    const el = this.el;
    const padding = this.effectivePadding();
    el.style.setProperty('--bg-color', s.bgColor);
    el.style.setProperty('--text-color', s.textColor);
    el.style.setProperty('--font-family', s.fontFamily || 'inherit');
    el.style.setProperty('--font-size', this.effectiveFontSize() + 'px');
    el.style.setProperty('--font-weight', String(s.fontWeight));
    el.style.setProperty('--line-height', String(s.lineHeight));
    el.style.setProperty('--letter-spacing', s.letterSpacing + 'px');
    el.style.setProperty('--paragraph-spacing', s.paragraphSpacing + 'em');
    el.style.setProperty('--text-indent', s.textIndent + 'em');
    el.style.setProperty('--text-align', s.textAlign);
    el.style.setProperty('--page-padding', padding + 'px');
    el.style.setProperty('--animate-duration', s.animateDuration + 'ms');
    // 亮度用遮罩层实现，避免 filter 造成整页重绘
    const dim = Math.round((100 - clamp(s.brightness, 20, 100)) / 100 * 85) / 100;
    el.style.setProperty('--dim-opacity', String(dim));
    el.style.setProperty('--bg-image-opacity', String(clamp(s.bgOpacity, 0, 100) / 100));
    this.bgImg.style.backgroundImage = s.bgImage ? 'url("' + String(s.bgImage).replace(/["'()]/g, '') + '")' : 'none';
    el.classList.toggle('hide-status', !!s.hideStatusBar);
    this.bottomBar.style.display = s.showProgress ? '' : 'none';
    applyMetaTheme(s.bgColor);
  }

  /** 重新排版（字号/列宽变化时调用，保持阅读位置） */
  relayout() {
    if (this.destroyed || !this.pager) return;
    const s = getSettings();
    this.pager.setOptions({
      mode: s.pageMode,
      duration: s.animateDuration,
      pageWidth: s.pageWidth,
      pagePadding: this.effectivePadding(),
      layoutMode: s.layoutMode,
    });
    this.pager.layout(true);
  }

  /** 设置变化后的响应 */
  onSettingsChanged() {
    const s = getSettings();
    this.applyTheme();
    // 翻页模式切换需要立刻重建分页结构，其余排版参数做节流即可
    if (s.pageMode !== this.lastPageMode) {
      this.lastPageMode = s.pageMode;
      this.relayout();
    } else {
      this.throttledRelayout();
    }
    if (s.autoRead.enabled) this.startAutoRead(); else this.stopAutoRead();
    this.applyFullscreen(!!s.fullscreen);
    this.applyWakeLock();
    this.updateStatusBar();
  }

  /* ================= 交互：点击 / 手势 ================= */

  handleTap(x, y, ev) {
    const target = ev && ev.target;
    if (target && target.closest && target.closest('button, a, input, textarea, select, .sel-menu')) return;
    this.hideSelMenu();

    const s = getSettings();
    const rect = this.viewport.getBoundingClientRect();
    const rx = x - rect.left;
    const ry = y - rect.top;

    if (s.clickArea === 'none') { this.toggleBars(); return; }

    if (s.clickArea === 'all') {
      if (ry < rect.height * 0.5) this.pagePrev(); else this.pageNext();
      return;
    }
    // left-right：左 1/3 上一页、右 1/3 下一页、中间呼出菜单
    if (rx < rect.width / 3) this.pagePrev();
    else if (rx > rect.width * 2 / 3) this.pageNext();
    else this.toggleBars();
  }

  handleSwipe(dir, axis) {
    if (axis === 'x') {
      if (dir > 0) this.pageNext(); else this.pagePrev();
      return;
    }
    // 纵向滑动：滚动模式交给浏览器，分页模式翻章
    if (this.pager.mode === 'scroll') {
      if (this.viewport.scrollTop <= 4 && dir < 0) this.gotoChapter(this.index - 1);
      else if (this.viewport.scrollTop + this.viewport.clientHeight >= this.viewport.scrollHeight - 4 && dir > 0) this.gotoChapter(this.index + 1);
      return;
    }
    if (dir > 0) this.pageNext(); else this.pagePrev();
  }

  /** 下一页，到边界自动进入下一章 */
  pageNext() {
    if (!this.pager.next()) {
      this.gotoChapter(this.index + 1);
    }
  }

  pagePrev() {
    if (!this.pager.prev()) {
      this.gotoChapter(this.index - 1);
    }
  }

  /** 工具栏显隐 */
  toggleBars(force) {
    const hide = force === undefined ? !this.el.classList.contains('hide-bars') : force;
    this.el.classList.toggle('hide-bars', hide);
  }

  /* ================= 工具栏 / 面板 ================= */

  bindBarsAndProgress() {
    // 进度条拖拽
    let dragging = false;
    const ratioFromEvent = (ev) => {
      const rect = this.progressTrack.getBoundingClientRect();
      return clamp((ev.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    };
    const preview = (ev) => {
      const r = ratioFromEvent(ev);
      const total = this.chapters.length;
      const idx = clamp(Math.round(r * (total - 1)), 0, Math.max(0, total - 1));
      const ch = this.chapters[idx];
      this.progressTip.style.display = 'block';
      this.progressTip.style.left = (r * 100) + '%';
      this.progressTip.textContent = (ch ? ch.title : '第 ' + (idx + 1) + ' 章');
      this.progressFill.style.width = (r * 100) + '%';
      this.progressKnob.style.left = (r * 100) + '%';
      return idx;
    };
    const onDown = (ev) => {
      dragging = true;
      this.progressTrack.setPointerCapture && this.progressTrack.setPointerCapture(ev.pointerId);
      preview(ev);
      ev.preventDefault();
    };
    const onMove = (ev) => { if (dragging) preview(ev); };
    const onUp = (ev) => {
      if (!dragging) return;
      dragging = false;
      this.progressTip.style.display = 'none';
      const r = ratioFromEvent(ev);
      const total = this.chapters.length;
      if (!total) return;
      const idx = clamp(Math.round(r * (total - 1)), 0, total - 1);
      if (idx !== this.index) this.openChapter(idx, { ratio: 0 });
      else this.pager.setRatio(0);
    };
    this.progressTrack.addEventListener('pointerdown', onDown);
    this.progressTrack.addEventListener('pointermove', onMove);
    this.progressTrack.addEventListener('pointerup', onUp);
    this.progressTrack.addEventListener('pointercancel', () => { dragging = false; this.progressTip.style.display = 'none'; });
    this.disposers.push(() => {
      this.progressTrack.removeEventListener('pointerdown', onDown);
      this.progressTrack.removeEventListener('pointermove', onMove);
      this.progressTrack.removeEventListener('pointerup', onUp);
    });

    // 选中文字 → 复制 / 高亮 / 写笔记
    const onSelection = debounce(() => this.maybeShowSelMenu(), 60);
    document.addEventListener('selectionchange', onSelection);
    this.viewport.addEventListener('scroll', () => this.hideSelMenu(), { passive: true });
    this.disposers.push(() => document.removeEventListener('selectionchange', onSelection));
  }

  togglePanel(name) {
    const isCatalog = name === 'catalog';
    const panel = isCatalog ? this.catalogPanel : this.bookmarkPanel;
    const other = isCatalog ? this.bookmarkPanel : this.catalogPanel;
    const willOpen = !panel.classList.contains('open');
    other.classList.remove('open');
    panel.classList.toggle('open', willOpen);
    this.mask.classList.toggle('show', willOpen || this.settingsPanel.classList.contains('open'));
    if (willOpen && !isCatalog) this.renderBookmarks();
  }

  closePanels() {
    this.catalogPanel.classList.remove('open');
    this.bookmarkPanel.classList.remove('open');
    if (!this.settingsPanel.classList.contains('open')) this.mask.classList.remove('show');
  }

  toggleSettings(force) {
    const open = force === undefined ? !this.settingsPanel.classList.contains('open') : force;
    this.settingsPanel.classList.toggle('open', open);
    if (open) this.closePanels();
    this.mask.classList.toggle('show', open);
  }

  closeSettings() { this.toggleSettings(false); }

  closeAll() {
    this.closePanels();
    this.closeSettings();
    this.hideSelMenu();
    const kbd = this.el.querySelector('.kbd-panel');
    if (kbd) kbd.parentNode.removeChild(kbd);
  }

  /** 更多菜单 */
  showMoreMenu() {
    const s = getSettings();
    actionSheet([
      { label: s.autoRead.enabled ? '暂停自动阅读' : '开始自动阅读', icon: s.autoRead.enabled ? 'pause' : 'play', onClick: () => { updateSettings({ autoRead: Object.assign({}, s.autoRead, { enabled: !s.autoRead.enabled }) }); } },
      { label: '添加书签 (B)', icon: 'bookmark', onClick: () => this.addBookmark() },
      { label: '书签与笔记', icon: 'note', onClick: () => this.togglePanel('bookmark') },
      { label: '全文搜索', icon: 'search', onClick: () => { this.togglePanel('catalog'); setTimeout(() => this.catalogSearch.focus(), 260); } },
      { label: '切换简繁转换', icon: 'textSize', onClick: () => { updateSettings({ simplify: !s.simplify }); this.renderChapterBody(); this.pager.layout(false); toastOk(s.simplify ? '已切换为繁体显示' : '已切换为简体显示'); } },
      { label: '快捷键说明 (?)', icon: 'keyboard', onClick: () => this.toggleKbdHelp(true) },
      { label: '返回书籍详情', icon: 'book', onClick: () => this.goBack() },
    ], { title: this.book ? this.book.name : '' });
  }

  goBack() {
    this.saveProgress(true);
    if (history.length > 1) history.back();
    else location.hash = '#/book/' + this.bookId;
  }

  /* ================= 目录 ================= */

  renderCatalog(filter) {
    const list = filter ? filter.items : this.chapters;
    const totalEl = this.catalogHead.querySelector('.badge');
    if (totalEl) totalEl.textContent = '共 ' + this.chapters.length + ' 章';
    clear(this.catalogList);

    if (!list.length) {
      this.catalogList.appendChild(h('div', { class: 'empty-state' },
        h('p', { class: 'empty-desc', text: filter ? '没有匹配的章节' : '目录为空，可尝试在书籍详情页刷新目录' })));
      return;
    }

    this.chapterRenderLimit = 200;
    const renderChunk = () => {
      const start = this.catalogList.querySelectorAll('.chapter-item').length;
      const end = Math.min(list.length, start + 200);
      const frag = document.createDocumentFragment();
      for (let i = start; i < end; i++) {
        const ch = list[i];
        const isCurrent = !filter && ch.index === this.index;
        const item = h('div', {
          class: 'chapter-item' + (isCurrent ? ' current' : ''),
          dataset: { index: String(ch.index) },
          on: { click: () => { this.closePanels(); this.openChapter(ch.index, { ratio: 0 }); } },
        },
          h('span', { class: 'idx', text: '#' + (ch.index + 1) }),
          h('span', { class: 'title', text: ch.title || ('第 ' + (ch.index + 1) + ' 章') }),
          ch.cached ? h('span', { class: 'cached', title: '已缓存' }, icon('check', 15)) : null
        );
        frag.appendChild(item);
      }
      // 哨兵用于滚动加载
      const sentinel = this.catalogList.querySelector('.cat-sentinel');
      if (sentinel) sentinel.remove();
      this.catalogList.appendChild(frag);
      if (end < list.length) {
        const sen = h('div', { class: 'cat-sentinel', style: { height: '1px' } });
        this.catalogList.appendChild(sen);
        if (this.catalogObserver) this.catalogObserver.disconnect();
        this.catalogObserver = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) renderChunk();
        }, { root: this.catalogList, rootMargin: '200px' });
        this.catalogObserver.observe(sen);
      }
    };
    renderChunk();
    this.highlightCatalog();
  }

  highlightCatalog() {
    const cur = this.catalogList.querySelector('.chapter-item.current');
    if (cur) cur.classList.add('current');
  }

  /** 章节标题搜索：优先走后端全书搜索，失败回退本地过滤 */
  async searchChapters(keyword) {
    if (!keyword) { this.renderCatalog(); return; }
    let items = null;
    try {
      const data = await api.bookSearch(this.bookId, keyword);
      items = (Array.isArray(data) ? data : (data && data.items) || []).map((it) => ({
        index: it.index, title: it.title, cached: (this.chapters[it.index] || {}).cached,
      }));
    } catch (e) {
      const kw = keyword.toLowerCase();
      items = this.chapters.filter((ch) => String(ch.title || '').toLowerCase().indexOf(kw) >= 0);
    }
    this.renderCatalog({ items });
  }

  /* ================= 书签 / 笔记 ================= */

  async refreshBookmarks() {
    try {
      const data = await api.bookmarkList(this.bookId);
      this.bookmarks = Array.isArray(data) ? data : [];
    } catch (e) {
      this.bookmarks = [];
    }
    if (this.bookmarkPanel.classList.contains('open')) this.renderBookmarks();
  }

  renderBookmarks() {
    clear(this.bookmarkList);
    if (!this.bookmarks.length) {
      this.bookmarkList.appendChild(h('div', { class: 'empty-state' },
        h('div', { class: 'empty-icon' }, icon('bookmark', 38)),
        h('h3', { class: 'empty-title', text: '还没有书签' }),
        h('p', { class: 'empty-desc', text: '阅读时点击右下角「更多 → 添加书签」，或按 B 键，即可记录当前位置。' })
      ));
      return;
    }
    for (const bm of this.bookmarks) {
      const isNote = !!(bm.note && String(bm.note).trim());
      this.bookmarkList.appendChild(h('div', { class: 'chapter-item' },
        h('div', { style: { flex: '1 1 auto', minWidth: '0' } },
          h('div', { style: { fontWeight: '600', fontSize: '13.5px' }, text: bm.chapterTitle || ('第 ' + (bm.chapterIndex + 1) + ' 章') }),
          isNote ? h('div', { class: 'small muted', style: { whiteSpace: 'pre-wrap' }, text: '笔记：' + bm.note }) : null,
          bm.text ? h('div', { class: 'small muted nowrap', text: bm.text }) : null,
          h('div', { class: 'small muted', text: formatTime(bm.createdAt) })
        ),
        iconButton('right', '跳转', () => { this.closePanels(); this.openChapter(bm.chapterIndex, { ratio: clamp(Number(bm.pos) || 0, 0, 1) }); }, { size: 16 }),
        iconButton('trash', '删除', async () => {
          const ok = await confirmDialog('确定删除这条书签吗？', { danger: true, okLabel: '删除' });
          if (!ok) return;
          try {
            await api.bookmarkDelete(bm.id);
            this.bookmarks = this.bookmarks.filter((x) => x.id !== bm.id);
            this.renderBookmarks();
            toastOk('已删除');
          } catch (err) { toastError(err, '删除失败'); }
        }, { size: 16 })
      ));
    }
  }

  /** 添加书签（note 为空则纯书签） */
  async addBookmark(note, text) {
    const payload = {
      bookId: this.bookId,
      chapterIndex: this.index,
      chapterTitle: this.chapterTitle,
      pos: this.pager ? this.pager.getRatio() : 0,
      text: text || this.currentSelectionText() || '',
      note: note || '',
    };
    try {
      const created = await api.bookmarkAdd(payload);
      if (created) this.bookmarks.unshift(created);
      else this.bookmarks.unshift(Object.assign({ id: Date.now(), createdAt: Date.now() }, payload));
      toastOk(note ? '笔记已保存' : '书签已添加');
      if (this.bookmarkPanel.classList.contains('open')) this.renderBookmarks();
      return true;
    } catch (err) {
      toastError(err, '添加失败');
      return false;
    }
  }

  /* ================= 选中文字菜单 ================= */

  currentSelectionText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    const text = String(sel.toString() || '').trim();
    return text.length > 600 ? text.slice(0, 600) : text;
  }

  maybeShowSelMenu() {
    if (this.destroyed) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { this.hideSelMenu(); return; }
    const text = String(sel.toString() || '').trim();
    if (!text) { this.hideSelMenu(); return; }
    const range = sel.getRangeAt(0);
    if (!this.contentEl.contains(range.commonAncestorContainer)) { this.hideSelMenu(); return; }

    const rect = range.getBoundingClientRect();
    const rootRect = this.el.getBoundingClientRect();
    this.showSelMenu(rect.left - rootRect.left + rect.width / 2, rect.top - rootRect.top, text);
  }

  showSelMenu(x, y, text) {
    this.hideSelMenu();
    const menu = h('div', { class: 'sel-menu', style: { left: x + 'px', top: Math.max(40, y) + 'px' } },
      h('button', { type: 'button', on: { click: () => this.copyText(text) } }, icon('copy', 15), h('span', { text: '复制' })),
      h('button', { type: 'button', on: { click: () => this.highlight(text) } }, icon('highlight', 15), h('span', { text: '高亮' })),
      h('button', { type: 'button', on: { click: () => this.writeNote(text) } }, icon('note', 15), h('span', { text: '写笔记' }))
    );
    this.el.appendChild(menu);
    this.selMenu = menu;
  }

  hideSelMenu() {
    if (this.selMenu && this.selMenu.parentNode) this.selMenu.parentNode.removeChild(this.selMenu);
    this.selMenu = null;
  }

  async copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0' } });
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.parentNode.removeChild(ta);
      }
      toastOk('已复制');
    } catch (e) {
      toastErr('复制失败，请手动选择复制');
    }
    this.hideSelMenu();
  }

  async highlight(text) {
    await this.addBookmark('', text);
    this.hideSelMenu();
  }

  async writeNote(text) {
    const note = await promptDialog({
      title: '写笔记',
      label: '笔记内容',
      value: '',
      placeholder: '写下你的想法…',
    });
    if (note === null) return;
    await this.addBookmark(note, text);
    this.hideSelMenu();
  }

  /* ================= 自动阅读 ================= */

  startAutoRead() {
    if (this.autoRead.raf) return;
    const speed = clamp(Number(getSettings().autoRead.speed) || 60, 10, 600);
    this.autoRead.last = 0;
    this.autoRead.acc = 0;
    const step = (ts) => {
      if (this.destroyed) return;
      if (!this.autoRead.last) this.autoRead.last = ts;
      const dt = Math.min(0.25, (ts - this.autoRead.last) / 1000);
      this.autoRead.last = ts;
      const dy = speed * dt;
      if (this.pager.mode === 'scroll') {
        if (!this.pager.scrollByPixels(dy)) {
          this.gotoChapter(this.index + 1).then((ok) => {
            if (ok === false) this.stopAutoRead();
          });
        }
      } else {
        this.autoRead.acc += dy;
        const pageH = this.viewport.clientHeight || 600;
        if (this.autoRead.acc >= pageH) {
          this.autoRead.acc = 0;
          if (!this.pager.next()) {
            this.gotoChapter(this.index + 1).then((ok) => { if (ok === false) this.stopAutoRead(); });
          }
        }
      }
      this.autoRead.raf = requestAnimationFrame(step);
    };
    this.autoRead.raf = requestAnimationFrame(step);
    toast('自动阅读已开启（' + speed + ' px/s）');
  }

  stopAutoRead() {
    if (this.autoRead.raf) cancelAnimationFrame(this.autoRead.raf);
    this.autoRead.raf = null;
    this.autoRead.acc = 0;
  }

  restoreAutoRead() {
    if (getSettings().autoRead.enabled) this.startAutoRead();
  }

  /* ================= 进度 / 计时 ================= */

  startTimers() {
    this.lastTick = Date.now();
    // 每 5 秒节流保存一次进度并上报阅读秒数
    this.saveTimer = setInterval(() => {
      this.accumulateSeconds();
      this.saveProgress(false);
    }, 5000);
    this.clockTimer = setInterval(() => this.updateStatusBar(), 20000);
    this.updateStatusBar();
    this.initBattery();
  }

  accumulateSeconds() {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    const delta = Math.max(0, Math.round((now - this.lastTick) / 1000));
    this.lastTick = now;
    if (delta > 0 && delta < 600) {
      this.readSeconds += delta;
      this.pendingSeconds += delta;
    }
  }

  /** 整体阅读百分比（按章节 + 章内位置） */
  overallPercent() {
    const total = this.chapters.length || 1;
    const pos = this.pager ? this.pager.getRatio() : 0;
    return clamp((this.index + pos) / total, 0, 1);
  }

  /**
   * 保存进度
   * @param {boolean} immediate true 时立即发请求（翻章/卸载）
   */
  saveProgress(immediate) {
    if (this.destroyed && !immediate) return;
    this.accumulateSeconds();
    const payload = {
      chapterIndex: this.index,
      chapterTitle: this.chapterTitle,
      chapterPos: this.pager ? this.pager.getRatio() : 0,
      percent: this.overallPercent(),
      addSeconds: this.pendingSeconds,
    };
    this.pendingSeconds = 0;
    // 静默失败：离线阅读不影响体验，恢复联网后会继续写入
    api.progressPut(this.bookId, payload).catch(() => {});
  }

  /** 卸载兜底：sendBeacon */
  beaconSave() {
    if (this.destroyed || !this.bookId) return;
    this.accumulateSeconds();
    beaconProgress(this.bookId, {
      chapterIndex: this.index,
      chapterTitle: this.chapterTitle,
      chapterPos: this.pager ? this.pager.getRatio() : 0,
      percent: this.overallPercent(),
      addSeconds: this.pendingSeconds,
    });
    this.pendingSeconds = 0;
  }

  /* ================= 顶部/底部信息 ================= */

  updateChrome() {
    this.topBookName.textContent = this.book ? (this.book.name || '未命名') : '加载中…';
    this.topChapterName.textContent = this.chapterTitle || '';
    document.title = (this.chapterTitle ? this.chapterTitle + ' · ' : '') + (this.book ? this.book.name : '阅读') + ' · 书海';
  }

  updateProgressUi(ratio) {
    const total = this.chapters.length || 1;
    const overall = clamp((this.index + clamp(ratio, 0, 1)) / total, 0, 1);
    if (getSettings().showProgress) {
      this.progressFill.style.width = (overall * 100) + '%';
      this.progressKnob.style.left = (overall * 100) + '%';
    }
    this.throttledStatus(overall, ratio);
  }

  updateStatusBar(overall, ratio) {
    const total = this.chapters.length || 1;
    const percent = overall === undefined ? this.overallPercent() : overall;
    const inChapter = ratio === undefined ? (this.pager ? this.pager.getRatio() : 0) : ratio;
    const pageInfo = this.pager ? this.pager.getPageInfo() : { index: 0, total: 1 };

    clear(this.statusLeft);
    this.statusLeft.appendChild(h('span', {
      text: '第 ' + (this.index + 1) + '/' + total + ' 章',
    }));
    if (this.pager && this.pager.isPaged) {
      this.statusLeft.appendChild(h('span', { text: '本页 ' + (pageInfo.index + 1) + '/' + pageInfo.total }));
    }
    this.statusLeft.appendChild(h('span', { text: (percent * 100).toFixed(1) + '%' }));
    if (this.book && this.book.sourceName) {
      this.statusLeft.appendChild(h('span', { text: this.book.sourceName }));
    }
    // 章内进度也直观展示
    this.statusLeft.appendChild(h('span', { text: '章内 ' + Math.round(inChapter * 100) + '%' }));

    clear(this.statusRight);
    const s = getSettings();
    if (s.showClock) {
      const d = new Date();
      const pad = (n) => (n < 10 ? '0' + n : String(n));
      this.statusRight.appendChild(h('span', {}, icon('clock', 13), h('span', { text: ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) })));
    }
    if (s.showBattery && this.battery) {
      this.statusRight.appendChild(h('span', {}, icon('battery', 13), h('span', { text: ' ' + Math.round(this.battery.level * 100) + '%' })));
    }
    // 缓存状态
    const ch = this.chapters[this.index];
    if (ch && ch.cached) {
      this.statusRight.appendChild(h('span', {}, icon('check', 13), h('span', { text: ' 已缓存' })));
    }
  }

  async initBattery() {
    try {
      if (navigator.getBattery) {
        this.battery = await navigator.getBattery();
        this.battery.addEventListener('levelchange', () => this.updateStatusBar());
        this.updateStatusBar();
      }
    } catch (e) { /* 浏览器不支持则忽略 */ }
  }

  /* ================= 全屏 / 常亮 ================= */

  applyFullscreen(on) {
    try {
      if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else if (!on && document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    } catch (e) { /* 用户未授权时忽略 */ }
  }

  async applyWakeLock() {
    const want = getSettings().keepScreenOn;
    try {
      if (want && !this.wakeLock && navigator.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
      } else if (!want) {
        this.releaseWakeLock();
      }
    } catch (e) { /* 忽略 */ }
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      try { this.wakeLock.release(); } catch (e) { /* 忽略 */ }
      this.wakeLock = null;
    }
  }

  /* ================= 快捷键 ================= */

  _onKeyDown(ev) {
    const tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ev.target && ev.target.isContentEditable)) return;
    const key = ev.key;
    const s = getSettings();

    switch (key) {
      case 'ArrowLeft': ev.preventDefault(); this.pagePrev(); break;
      case 'ArrowRight': ev.preventDefault(); this.pageNext(); break;
      case 'ArrowUp':
        ev.preventDefault();
        if (this.pager.mode === 'scroll') this.pager.scrollByPixels(-this.viewport.clientHeight * 0.9);
        else this.gotoChapter(this.index - 1);
        break;
      case 'ArrowDown':
        ev.preventDefault();
        if (this.pager.mode === 'scroll') this.pager.scrollByPixels(this.viewport.clientHeight * 0.9);
        else this.gotoChapter(this.index + 1);
        break;
      case ' ':
      case 'Spacebar':
        ev.preventDefault(); this.pageNext(); break;
      case 'PageDown': ev.preventDefault(); this.pageNext(); break;
      case 'PageUp': ev.preventDefault(); this.pagePrev(); break;
      case 'Escape': this.closeAll(); break;
      case '?': this.toggleKbdHelp(); break;
      case 'f': case 'F':
        updateSettings({ fullscreen: !s.fullscreen });
        this.applyFullscreen(!s.fullscreen);
        break;
      case 't': case 'T': this.togglePanel('catalog'); break;
      case 's': case 'S': this.toggleSettings(); break;
      case 'b': case 'B': this.addBookmark(); break;
      case '[':
        if (s.fontSizeShortcut) { updateSettings({ fontSize: clamp(s.fontSize - 1, 12, 40) }); toast('字号 ' + getSettings().fontSize); }
        break;
      case ']':
        if (s.fontSizeShortcut) { updateSettings({ fontSize: clamp(s.fontSize + 1, 12, 40) }); toast('字号 ' + getSettings().fontSize); }
        break;
      default: break;
    }
  }

  toggleKbdHelp(force) {
    const exist = this.el.querySelector('.kbd-panel');
    if (exist && force !== true) { exist.parentNode.removeChild(exist); return; }
    if (exist) return;
    const list = h('div', { class: 'kbd-list' });
    for (const item of SHORTCUTS) {
      list.appendChild(h('div', { class: 'kbd-row' },
        h('span', { style: { minWidth: '92px' } }, item.keys.map((k) => h('kbd', { text: k })),
        ),
        h('span', { text: item.desc })
      ));
    }
    const panel = h('div', { class: 'kbd-panel', on: { click: (ev) => { if (ev.target === panel) panel.remove(); } } },
      h('div', { class: 'kbd-panel-inner' },
        h('h3', { style: { marginBottom: '12px' }, text: '键盘快捷键' }),
        list,
        h('button', { class: 'btn btn-block', type: 'button', style: { marginTop: '14px' }, text: '知道了', on: { click: () => panel.remove() } })
      )
    );
    this.el.appendChild(panel);
  }

  /* ================= 全局事件 ================= */

  bindGlobalEvents() {
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('beforeunload', this._onBeforeUnload);
    window.addEventListener('pagehide', this._onBeforeUnload);
    this.disposers.push(() => {
      document.removeEventListener('keydown', this._onKeyDown);
      document.removeEventListener('visibilitychange', this._onVisibility);
      window.removeEventListener('beforeunload', this._onBeforeUnload);
      window.removeEventListener('pagehide', this._onBeforeUnload);
    });

    // 视口 / 旋转变化 → 重新分页
    const relayout = throttle(() => {
      if (this.destroyed) return;
      this.applyTheme();
      this.relayout();
    }, 150);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(relayout);
      ro.observe(this.viewport);
      this.disposers.push(() => ro.disconnect());
    } else {
      window.addEventListener('resize', relayout);
      this.disposers.push(() => window.removeEventListener('resize', relayout));
    }
    const mq = window.matchMedia('(orientation: portrait)');
    const onMq = () => relayout();
    if (mq.addEventListener) { mq.addEventListener('change', onMq); this.disposers.push(() => mq.removeEventListener('change', onMq)); }

    // 设置变化（来自全局设置页 / 面板 / 快捷键）实时生效
    const unsub = subscribe(() => { if (!this.destroyed) this.onSettingsChanged(); });
    this.disposers.push(unsub);
  }

  _onVisibility() {
    if (document.visibilityState === 'hidden') {
      this.beaconSave();
    } else {
      this.lastTick = Date.now();
      this.applyWakeLock();
    }
  }

  _onBeforeUnload() {
    this.beaconSave();
  }

  /* ================= 加载 / 错误态 ================= */

  showChapterLoading() {
    this.topChapterName.textContent = '加载中…';
    if (!this.contentEl.childNodes.length) {
      clear(this.contentEl);
      this.contentEl.appendChild(loadingBlock('正在加载正文…'));
    }
  }

  /** 强制刷新目录，并尽量停在原来的章节上 */
  async refreshChapters() {
    try {
      const r = await api.bookChapters(this.bookId, true);
      const items = (r && r.items) || [];
      if (!items.length) { toastWarn('目录仍为空，可能书源已失效，建议换源'); return 0; }
      this.chapters = items;
      this.cache.clear();
      this.renderCatalog();
      this.updateChrome();
      toastOk('目录已刷新（' + items.length + ' 章）');
      return items.length;
    } catch (err) {
      toastError(err, '刷新目录失败');
      return 0;
    }
  }

  showChapterError(err, index) {
    clear(this.contentEl);
    const msg = String((err && err.message) || '');
    const staleToc = /404|NOT_FOUND|目录|越界|章节不存在/.test(msg) || /404/i.test(String((err && err.code) || ''));
    this.contentEl.appendChild(h('div', { class: 'empty-state error-state' },
      h('div', { class: 'empty-icon' }, icon('info', 42)),
      h('h3', { class: 'empty-title', text: staleToc ? '这一章取不到' : '加载失败' }),
      h('p', { class: 'empty-desc', text: msg || '发生未知错误' }),
      staleToc ? h('p', { class: 'empty-desc', text: '常见原因：书源改版导致目录地址失效。可以先刷新目录，或换一个书源。' }) : null,
      h('div', { class: 'empty-actions' },
        h('button', {
          class: 'btn btn-primary', type: 'button',
          on: { click: () => { this.cache.delete(index); this.openChapter(index, { ratio: 0 }); } },
        }, icon('refresh', 16), h('span', { text: '重试本章' })),
        h('button', {
          class: 'btn', type: 'button',
          on: {
            click: async () => {
              const n = await this.refreshChapters();
              if (n) this.openChapter(Math.min(index, n - 1), { ratio: 0 });
            },
          },
        }, icon('refresh', 16), h('span', { text: '刷新目录' })),
        h('a', { class: 'btn btn-ghost', href: '#/book/' + this.bookId, text: '去换源' })
      )
    ));
  }

  showFatal(err) {
    clear(this.root);
    const broken = /损坏|404|NOT_FOUND/.test(String((err && err.message) || '') + String((err && err.code) || ''));
    this.root.appendChild(h('div', { style: { padding: '40px 16px', maxWidth: '640px', margin: '0 auto' } },
      errorState(err, () => { location.reload(); }),
      broken ? h('p', { class: 'empty-desc', style: { textAlign: 'center', marginTop: '12px' },
        text: '如果是「记录损坏」或持续 404，通常是这本书当初由有问题的书源规则写入的：重新搜索一次就能拿到可用地址。' }) : null,
      h('div', { style: { textAlign: 'center', marginTop: '10px', display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' } },
        broken ? h('a', { class: 'btn btn-primary', href: '#/search?q=' + encodeURIComponent((this.book && this.book.name) || ''), text: '重新搜索这本书' }) : null,
        h('a', { class: 'btn btn-ghost', href: '#/shelf', text: '返回书架' }))
    ));
  }
}

/**
 * 路由入口
 * @param {HTMLElement} root
 * @param {object} params { id, chapter }
 */
export async function render(root, params) {
  const reader = new Reader(root, params);
  const dispose = await reader.mount();
  return dispose;
}

export default render;
