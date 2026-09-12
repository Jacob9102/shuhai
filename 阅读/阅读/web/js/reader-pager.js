/**
 * reader-pager.js —— 翻页引擎
 *
 * 支持五种模式：
 *   scroll   上下连续滚动
 *   slide    左右滑动翻页（CSS 多栏 + transform 平移动画）
 *   cover    仿真覆盖翻页（新页从右侧盖住旧页，用克隆层实现）
 *   none     无动画瞬切（与 slide 相同布局，动画时长 0）
 *   vertical 上下翻页（整块 translateY）
 *
 * 排版数学：正文列宽 colW = min(视口宽 - 2*内边距, pageWidth)，
 * 列左偏移 left = (视口宽 - colW) / 2，列间距 gap = 视口宽 - colW。
 * 于是「左偏移 + 列宽 + 列间距 = 视口宽」，每翻一页 translateX 恰好等于一个视口宽，
 * 且每一页的正文都落在同一个居中位置。
 */

import { h, clear, clamp } from './ui.js';

/** 分页模式（非连续滚动） */
const PAGED_MODES = ['slide', 'cover', 'none'];

export class Pager {
  /**
   * @param {HTMLElement} viewport 阅读视口
   * @param {object} options { mode, duration, pageWidth, pagePadding, layoutMode, onTap, onSwipe, onBoundary, onProgress }
   */
  constructor(viewport, options = {}) {
    this.viewport = viewport;
    this.opts = Object.assign({
      mode: 'scroll',
      duration: 260,
      pageWidth: 720,
      pagePadding: 24,
      layoutMode: 'auto',
      onTap: null,
      onSwipe: null,
      onBoundary: null,
      onProgress: null,
    }, options);

    this.stage = null;
    this.frontLayer = null;
    this.backLayer = null;
    this.contentEl = null;

    this.pageIndex = 0;
    this.pageCount = 1;
    this.colWidth = 0;
    this.colLeft = 0;
    this.colTop = 0;
    this.colHeight = 0;
    this.step = 0;          // 单页滚动步长（竖向模式为对齐后的行高倍数）
    this.animating = false;
    this.destroyed = false;

    this._gestureDisposers = [];
    this._bindGestures();
  }

  /* ---------------- 基础属性 ---------------- */

  get mode() { return this.opts.mode; }
  get isPaged() { return PAGED_MODES.indexOf(this.opts.mode) >= 0 || this.opts.mode === 'vertical'; }

  /** 更新配置（模式变化会自动重挂载） */
  setOptions(patch) {
    const modeChanged = patch.mode && patch.mode !== this.opts.mode;
    Object.assign(this.opts, patch);
    if (modeChanged) {
      this._unmount();
      this._mount();
    }
    this.layout(false);
  }

  /** 设置当前章节正文节点（复用同一个节点，避免反复创建） */
  setContent(el, keepRatio = false) {
    const ratio = keepRatio ? this.getRatio() : 0;
    this.contentEl = el;
    this._unmount();
    this._mount();
    this.pageIndex = 0;
    this.layout(false);
    if (keepRatio) this.setRatio(ratio);
    else this.goToPage(0, false);
  }

  /* ---------------- DOM 挂载 ---------------- */

  _mount() {
    if (!this.viewport) return;
    clear(this.viewport);
    this.stage = null;
    this.frontLayer = null;
    this.backLayer = null;
    const mode = this.opts.mode;

    if (mode === 'scroll') {
      this.viewport.classList.remove('mode-paged');
      this.viewport.classList.add('mode-scroll');
      this.viewport.style.touchAction = 'pan-y';
      if (this.contentEl) {
        this.contentEl.classList.remove('paged');
        this.viewport.appendChild(this.contentEl);
      }
      return;
    }

    this.viewport.classList.remove('mode-scroll');
    this.viewport.classList.toggle('mode-vertical', mode === 'vertical');
    this.viewport.classList.add('mode-paged');
    // 分页模式下禁用浏览器横向手势，交给我们自己的手势判定
    this.viewport.style.touchAction = 'manipulation';

    this.stage = h('div', { class: 'pager-stage' });
    this.frontLayer = h('div', { class: 'pager-layer pager-front' });
    if (this.contentEl) {
      if (mode === 'vertical') this.contentEl.classList.remove('paged');
      else this.contentEl.classList.add('paged');
      this.frontLayer.appendChild(this.contentEl);
    }
    this.stage.appendChild(this.frontLayer);
    this.viewport.appendChild(this.stage);
  }

  _unmount() {
    if (this.contentEl && this.contentEl.parentNode) this.contentEl.parentNode.removeChild(this.contentEl);
    if (this.stage && this.stage.parentNode) this.stage.parentNode.removeChild(this.stage);
    this.stage = null;
    this.frontLayer = null;
    this.backLayer = null;
  }

  /* ---------------- 排版计算 ---------------- */

  /** 重新计算分页几何，keepRatio=true 时保持阅读进度比例 */
  layout(keepRatio = true) {
    if (this.destroyed || !this.contentEl) return;
    const ratio = keepRatio ? this.getRatio() : 0;
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    if (!vw || !vh) return;

    const pad = clamp(this.opts.pagePadding, 0, 80);
    const maxWidth = clamp(this.opts.pageWidth, 320, 1600);
    const mode = this.opts.mode;

    if (mode === 'scroll') {
      // 连续滚动：CSS 直接约束列宽并居中
      const width = this.opts.layoutMode === 'fixed' ? maxWidth + 'px' : 'min(100%, ' + maxWidth + 'px)';
      this.contentEl.style.width = width;
      this.contentEl.style.maxWidth = this.opts.layoutMode === 'fixed' ? '100%' : 'none';
      this.contentEl.style.margin = '0 auto';
      this.contentEl.style.padding = pad + 'px';
      this.contentEl.style.height = 'auto';
      this.contentEl.style.position = 'relative';
      this.contentEl.style.left = '0';
      this.contentEl.style.top = '0';
      this.contentEl.style.transform = '';
      this.pageCount = 1;
      this.step = vh;
      this.setRatio(ratio);
      this._emitProgress();
      return;
    }

    if (mode === 'vertical') {
      // 上下翻页：整块内容按视口高度切页，步长对齐行高避免切断文字
      this.colLeft = 0;
      this.colWidth = Math.min(vw - pad * 2, maxWidth);
      if (this.opts.layoutMode === 'fixed') this.colWidth = Math.min(maxWidth, vw);
      this.colWidth = Math.max(120, this.colWidth);
      const layer = this.frontLayer;
      layer.style.top = '0';
      layer.style.left = '0';
      layer.style.width = '100%';
      layer.style.transform = '';

      this.contentEl.classList.remove('paged');
      this.contentEl.style.position = 'relative';
      this.contentEl.style.left = '0';
      this.contentEl.style.top = '0';
      this.contentEl.style.width = this.colWidth + 'px';
      this.contentEl.style.maxWidth = '100%';
      this.contentEl.style.margin = '0 auto';
      this.contentEl.style.padding = pad + 'px 0';
      this.contentEl.style.height = 'auto';
      this.contentEl.style.columnWidth = 'auto';
      this.contentEl.style.columnGap = 'normal';

      const contentHeight = this.contentEl.scrollHeight;
      const cs = window.getComputedStyle(this.contentEl);
      const lineH = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.8) || 30;
      this.step = Math.max(lineH, Math.floor((vh - pad * 2) / lineH) * lineH);
      this.pageCount = Math.max(1, Math.ceil(contentHeight / this.step));
      this.pageIndex = Math.min(this.pageIndex, this.pageCount - 1);
      this.goToPage(this.pageIndex, false);
      return;
    }

    /* ---- slide / cover / none：CSS 多栏横向分页 ---- */
    this.colHeight = vh - pad * 2;
    this.colHeight = Math.max(80, this.colHeight);
    this.colTop = pad;
    this.colWidth = Math.min(vw - pad * 2, maxWidth);
    if (this.opts.layoutMode === 'fixed') this.colWidth = Math.min(maxWidth, vw - pad * 2);
    this.colWidth = Math.max(120, this.colWidth);
    this.colLeft = (vw - this.colWidth) / 2;

    const layer = this.frontLayer;
    layer.style.left = this.colLeft + 'px';
    layer.style.top = this.colTop + 'px';
    layer.style.width = this.colWidth + 'px';
    layer.style.height = this.colHeight + 'px';
    layer.style.transform = '';

    const el = this.contentEl;
    el.classList.add('paged');
    el.style.position = 'relative';
    el.style.left = '0';
    el.style.top = '0';
    el.style.margin = '0';
    el.style.padding = '0';
    el.style.width = this.colWidth + 'px';
    el.style.maxWidth = 'none';
    el.style.height = this.colHeight + 'px';
    el.style.columnFill = 'auto';
    el.style.columnWidth = this.colWidth + 'px';
    el.style.columnGap = (vw - this.colWidth) + 'px';

    this.pageCount = this._measurePageCount();
    this.pageIndex = Math.min(this.pageIndex, this.pageCount - 1);
    this.goToPage(this.pageIndex, false);
  }

  /**
   * 测量总页数。
   * 多栏容器会把溢出的内容排到右侧的「溢出列」，用 Range 的最右边界反推列数。
   */
  _measurePageCount() {
    const vw = this.viewport.clientWidth || 1;
    let maxRight = 0;
    try {
      const range = document.createRange();
      range.selectNodeContents(this.contentEl);
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (r.width > 0 || r.height > 0) {
          if (r.right > maxRight) maxRight = r.right;
        }
      }
    } catch (e) { /* 忽略测量异常 */ }

    if (maxRight <= 0) return 1;
    const stageRect = this.stage.getBoundingClientRect();
    const rel = maxRight - stageRect.left - this.colLeft;
    return Math.max(1, Math.floor((rel - 1) / vw) + 1);
  }

  /* ---------------- 翻页 ---------------- */

  /** 下一页；返回 false 表示已到本章末尾 */
  next() {
    if (this.opts.mode === 'scroll') {
      const vp = this.viewport;
      const atEnd = vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 4;
      if (atEnd) return false;
      this._smoothScrollTo(vp.scrollTop + vp.clientHeight - 24);
      return true;
    }
    if (this.pageIndex >= this.pageCount - 1) return false;
    const from = this.pageIndex;
    this.pageIndex += 1;
    this._animate(from, this.pageIndex, 1);
    return true;
  }

  /** 上一页；返回 false 表示已到本章开头 */
  prev() {
    if (this.opts.mode === 'scroll') {
      const vp = this.viewport;
      if (vp.scrollTop <= 2) return false;
      this._smoothScrollTo(vp.scrollTop - vp.clientHeight + 24);
      return true;
    }
    if (this.pageIndex <= 0) return false;
    const from = this.pageIndex;
    this.pageIndex -= 1;
    this._animate(from, this.pageIndex, -1);
    return true;
  }

  /** 直接跳页 */
  goToPage(index, animate = false) {
    if (this.opts.mode === 'scroll') return;
    const target = clamp(index, 0, this.pageCount - 1);
    const from = this.pageIndex;
    this.pageIndex = target;
    if (animate && Math.abs(target - from) === 1) {
      this._animate(from, target, target > from ? 1 : -1);
    } else {
      this._applyTransform();
      this._emitProgress();
    }
  }

  /**
   * 执行翻页动画
   * @param {number} from 原页
   * @param {number} to 目标页
   * @param {number} dir 1 向后 / -1 向前
   */
  _animate(from, to, dir) {
    const duration = clamp(this.opts.duration, 0, 600);
    const mode = this.opts.mode;

    if (mode === 'none' || duration === 0) {
      this._applyTransform();
      this._emitProgress();
      return;
    }

    if (mode === 'slide') {
      const layer = this.frontLayer;
      layer.classList.add('animating');
      layer.style.setProperty('--animate-duration', duration + 'ms');
      this._applyTransform();
      this._afterAnimation(duration, () => {
        layer.classList.remove('animating');
      });
      return;
    }

    if (mode === 'vertical') {
      const layer = this.frontLayer;
      layer.classList.add('animating');
      layer.style.setProperty('--animate-duration', duration + 'ms');
      this._applyTransform();
      this._afterAnimation(duration, () => layer.classList.remove('animating'));
      return;
    }

    /* cover：仿真覆盖
       —— 向后翻：新页（克隆）从右侧滑入盖住旧页；
       —— 向前翻：旧页（当前层）向右滑出，露出下方已就位的上一页。 */
    if (!this.contentEl) { this._applyTransform(); return; }
    const vw = this.viewport.clientWidth;
    const clone = this.contentEl.cloneNode(true);
    clone.classList.add('paged');
    const back = h('div', { class: 'pager-layer pager-back' });
    back.style.left = this.colLeft + 'px';
    back.style.top = this.colTop + 'px';
    back.style.width = this.colWidth + 'px';
    back.style.height = this.colHeight + 'px';
    back.style.transition = 'transform ' + duration + 'ms ease-out';
    back.style.zIndex = dir > 0 ? '4' : '2';
    back.appendChild(clone);
    this.stage.appendChild(back);
    this.backLayer = back;

    // 克隆层固定在目标页，主层保持在原页
    const targetOffset = -to * vw;
    clone.style.transform = 'translateX(' + targetOffset + 'px)';
    // 向后翻：克隆层先停在右侧视口外，再滑入覆盖当前页
    if (dir > 0) back.style.transform = 'translateX(' + vw + 'px)';

    const layer = this.frontLayer;
    layer.style.transition = 'transform ' + duration + 'ms ease-out';
    layer.classList.remove('animating');
    layer.style.zIndex = dir > 0 ? '3' : '5';

    // 先让浏览器确认初始状态，再触发过渡
    requestAnimationFrame(() => {
      if (this.destroyed) return;
      if (dir > 0) back.style.transform = 'translateX(0)';
      else layer.style.transform = 'translateX(' + vw + 'px)';
    });

    this._afterAnimation(duration, () => {
      if (back.parentNode) back.parentNode.removeChild(back);
      this.backLayer = null;
      layer.style.transition = '';
      layer.style.zIndex = '';
      this._applyTransform();
      this._emitProgress();
    });
  }

  /** 定时器封装，便于销毁时清理 */
  _afterAnimation(duration, fn) {
    this.animating = true;
    setTimeout(() => {
      this.animating = false;
      if (fn && !this.destroyed) fn();
      if (!this.destroyed) this._emitProgress();
    }, duration + 10);
  }

  /** 把当前页号写成 transform */
  _applyTransform() {
    if (!this.frontLayer) return;
    const vw = this.viewport.clientWidth;
    if (this.opts.mode === 'vertical') {
      this.frontLayer.style.transform = 'translateY(' + (-this.pageIndex * this.step) + 'px)';
    } else {
      this.frontLayer.style.transform = 'translateX(' + (-this.pageIndex * vw) + 'px)';
    }
  }

  /** 平滑滚动（无 rAF 依赖，滚动模式用） */
  _smoothScrollTo(top) {
    const vp = this.viewport;
    const max = vp.scrollHeight - vp.clientHeight;
    const target = clamp(top, 0, Math.max(0, max));
    try {
      vp.scrollTo({ top: target, behavior: this.opts.duration > 0 ? 'smooth' : 'auto' });
    } catch (e) {
      vp.scrollTop = target;
    }
  }

  /** 按像素滚动（自动阅读使用，无动画） */
  scrollByPixels(dy) {
    if (this.opts.mode === 'scroll') {
      const vp = this.viewport;
      const max = vp.scrollHeight - vp.clientHeight;
      if (vp.scrollTop >= max - 1) return false;
      vp.scrollTop = clamp(vp.scrollTop + dy, 0, max);
      this._emitProgress();
      return true;
    }
    return false;
  }

  /* ---------------- 进度 ---------------- */

  /** 0~1 阅读进度 */
  getRatio() {
    if (this.opts.mode === 'scroll') {
      const vp = this.viewport;
      const max = vp.scrollHeight - vp.clientHeight;
      if (max <= 0) return 0;
      return clamp(vp.scrollTop / max, 0, 1);
    }
    if (this.pageCount <= 1) return 0;
    return clamp(this.pageIndex / (this.pageCount - 1), 0, 1);
  }

  /** 恢复进度 */
  setRatio(ratio) {
    const r = clamp(Number(ratio) || 0, 0, 1);
    if (this.opts.mode === 'scroll') {
      const vp = this.viewport;
      const max = vp.scrollHeight - vp.clientHeight;
      if (max > 0) vp.scrollTop = r * max;
      this._emitProgress();
      return;
    }
    const page = this.pageCount <= 1 ? 0 : Math.round(r * (this.pageCount - 1));
    this.goToPage(page, false);
  }

  /** 当前页信息，供底部进度条展示 */
  getPageInfo() {
    return { index: this.pageIndex, total: this.pageCount, mode: this.opts.mode };
  }

  _emitProgress() {
    if (this.opts.onProgress && !this.destroyed) {
      this.opts.onProgress(this.getRatio(), this.getPageInfo());
    }
  }

  /* ---------------- 手势 ---------------- */

  _bindGestures() {
    const vp = this.viewport;
    let tracking = false;
    let moved = false;
    let sx = 0;
    let sy = 0;
    let st = 0;

    const onDown = (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      if (ev.target && ev.target.closest && ev.target.closest('.sel-menu')) return;
      tracking = true;
      moved = false;
      sx = ev.clientX;
      sy = ev.clientY;
      st = Date.now();
    };
    const onMove = (ev) => {
      if (!tracking) return;
      if (Math.abs(ev.clientX - sx) > 8 || Math.abs(ev.clientY - sy) > 8) moved = true;
    };
    const onUp = (ev) => {
      if (!tracking) return;
      tracking = false;
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      const dt = Date.now() - st;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);

      // 位移小于阈值且时间短 → 视为点击
      if (!moved && dt < 600) {
        if (this.opts.onTap) this.opts.onTap(ev.clientX, ev.clientY, ev);
        return;
      }
      // 横向滑动：优先判定为翻页/翻章
      if (absX > 45 && absX > absY * 1.2) {
        if (this.opts.onSwipe) this.opts.onSwipe(dx < 0 ? 1 : -1, 'x');
        return;
      }
      // 纵向滑动：竖向翻页模式 / 滚动模式下的翻章
      if (absY > 60 && absY > absX * 1.2) {
        if (this.opts.onSwipe) this.opts.onSwipe(dy < 0 ? 1 : -1, 'y');
      }
    };
    const onCancel = () => { tracking = false; };

    vp.addEventListener('pointerdown', onDown);
    vp.addEventListener('pointermove', onMove);
    vp.addEventListener('pointerup', onUp);
    vp.addEventListener('pointercancel', onCancel);

    // 滚动模式记录进度
    const onScroll = () => {
      if (this.opts.mode === 'scroll') this._emitProgress();
    };
    vp.addEventListener('scroll', onScroll, { passive: true });

    this._gestureDisposers.push(() => {
      vp.removeEventListener('pointerdown', onDown);
      vp.removeEventListener('pointermove', onMove);
      vp.removeEventListener('pointerup', onUp);
      vp.removeEventListener('pointercancel', onCancel);
      vp.removeEventListener('scroll', onScroll);
    });
  }

  /* ---------------- 销毁 ---------------- */

  destroy() {
    this.destroyed = true;
    this._gestureDisposers.forEach((fn) => { try { fn(); } catch (e) { /* 忽略 */ } });
    this._gestureDisposers = [];
    this._unmount();
    this.contentEl = null;
  }
}

export default Pager;
