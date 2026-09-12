/**
 * ui.js —— 通用 UI 组件与工具
 * 只暴露安全的 DOM 构造方式（h 函数统一走 textContent），避免 innerHTML 拼接上游数据导致 XSS。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------------ *
 * 1. DOM 构造
 * ------------------------------------------------------------------ */

/**
 * 创建元素
 * @param {string} tag
 * @param {object} props 支持 class/text/style/dataset/on/html(仅内置可信 SVG)/其余作为属性
 * @param {...any} children 字符串、节点、数组、null
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const key of Object.keys(props)) {
      const val = props[key];
      if (val === null || val === undefined || val === false) continue;
      if (key === 'class') el.className = val;
      else if (key === 'text') el.textContent = String(val);
      else if (key === 'style') {
        if (typeof val === 'object') Object.assign(el.style, val);
        else el.setAttribute('style', String(val));
      } else if (key === 'dataset') Object.assign(el.dataset, val);
      else if (key === 'on') {
        for (const evt of Object.keys(val)) el.addEventListener(evt, val[evt]);
      } else if (key === 'html') {
        el.innerHTML = String(val); // 仅用于本文件内置的常量图标
      } else if (key === 'for') {
        el.setAttribute('for', String(val));
      } else if (key in el && typeof val !== 'object') {
        try { el[key] = val; } catch (e) { el.setAttribute(key, String(val)); }
      } else {
        el.setAttribute(key, val === true ? '' : String(val));
      }
    }
  }
  append(el, children);
  return el;
}

/** 递归挂载子节点，字符串一律走 textContent */
export function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) { append(parent, child); continue; }
    if (child instanceof Node) { parent.appendChild(child); continue; }
    parent.appendChild(document.createTextNode(String(child)));
  }
  return parent;
}

/** 清空元素 */
export function clear(el) {
  while (el && el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** HTML 转义（需要在 innerHTML 场景下使用时的保险） */
export function escapeHtml(str) {
  return String(str === null || str === undefined ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ *
 * 2. 内联 SVG 图标（全部为内置常量，无任何外链）
 * ------------------------------------------------------------------ */

const ICONS = {
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M16.2 16.2 21 21'],
  shelf: ['M4 5h4v14H4z', 'M10 5h4v14h-4z', 'M16.5 5.6l3.2 13.2-1.9.5L14.6 6.1z'],
  source: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3.5 9h17', 'M3.5 15h17', 'M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z'],
  gear: ['M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z', 'M19.4 15a1.7 1.7 0 0 0 .33 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.33 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.88.33l-.06.06A2 2 0 1 1 3.2 16.9l.06-.06a1.7 1.7 0 0 0 .33-1.87 1.7 1.7 0 0 0-1.55-1H2a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.33-1.88L3.26 6.9A2 2 0 1 1 6.1 4.07l.06.06a1.7 1.7 0 0 0 1.87.33H8.1a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.33 1.87v.05a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  back: ['M15 5l-7 7 7 7'],
  forward: ['M9 5l7 7-7 7'],
  left: ['M15 5l-7 7 7 7'],
  right: ['M9 5l7 7-7 7'],
  up: ['M5 15l7-7 7 7'],
  down: ['M5 9l7 7 7-7'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  list: ['M4 6h2', 'M4 12h2', 'M4 18h2', 'M9 6h11', 'M9 12h11', 'M9 18h11'],
  star: ['M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z'],
  bookmark: ['M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  trash: ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M5 13l4 4L19 7'],
  refresh: ['M20 11a8 8 0 1 0-1.2 5.2', 'M20 5v6h-6'],
  download: ['M12 4v11', 'M7 11l5 5 5-5', 'M5 20h14'],
  upload: ['M12 20V9', 'M7 13l5-5 5 5', 'M5 4h14'],
  book: ['M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 0-3 3z', 'M17 20h2'],
  cloudOff: ['M6.5 18h10a3.5 3.5 0 0 0 .6-6.95A5.5 5.5 0 0 0 8.2 8.4', 'M3 3l18 18'],
  sun: ['M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z', 'M12 2v2', 'M12 20v2', 'M2 12h2', 'M20 12h2', 'M5 5l1.5 1.5', 'M17.5 17.5L19 19', 'M19 5l-1.5 1.5', 'M6.5 17.5L5 19'],
  moon: ['M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z'],
  play: ['M7 4l12 8-12 8z'],
  pause: ['M8 4h3v16H8z', 'M13 4h3v16h-3z'],
  textSize: ['M4 19l5-14 5 14', 'M5.8 14h6.4', 'M15 19l3-8 3 8', 'M16 16.5h4.6'],
  more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  link: ['M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1', 'M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1'],
  edit: ['M4 20h4l10-10-4-4L4 16z', 'M14 6l4 4'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
  battery: ['M3 8h14v8H3z', 'M19 11v2'],
  fullscreen: ['M4 9V4h5', 'M20 15v5h-5', 'M15 4h5v5', 'M9 20H4v-5'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v5', 'M12 8h.01'],
  folder: ['M3 6h6l2 2h10v10H3z'],
  filter: ['M3 5h18l-7 8v6l-4-2v-4z'],
  sort: ['M7 4v16', 'M4 17l3 3 3-3', 'M14 7h6', 'M14 12h4', 'M14 17h2'],
  layers: ['M12 4l8 4-8 4-8-4z', 'M4 12l8 4 8-4', 'M4 16l8 4 8-4'],
  keyboard: ['M3 6h18v12H3z', 'M7 10h.01', 'M11 10h.01', 'M15 10h.01', 'M8 14h8'],
  note: ['M5 4h14v16H5z', 'M9 8h6', 'M9 12h6', 'M9 16h3'],
  copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
  highlight: ['M4 20h6', 'M9 16l8-8-4-4-8 8z', 'M14 5l4 4'],
  palette: ['M12 3a9 9 0 1 0 0 18c1.7 0 2-1 1.5-2-.6-1.2.3-2.5 1.7-2.5H17a4 4 0 0 0 4-4c0-5-4-9.5-9-9.5z', 'M7.5 10h.01', 'M12 7.5h.01', 'M16.5 10h.01'],
  layout: ['M3 5h18v14H3z', 'M3 10h18'],
  wifi: ['M5 12.5a10 10 0 0 1 14 0', 'M8.5 16a5.5 5.5 0 0 1 7 0', 'M12 19h.01'],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  dot: ['M12 12h.01'],
};

/**
 * 生成内联 SVG 图标
 * @param {string} name ICONS 中的键名
 * @param {number} size 像素尺寸
 */
export function icon(name, size = 20) {
  const paths = ICONS[name] || ICONS.dot;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ic');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

/** 带文字的图标按钮 */
export function iconButton(name, label, onClick, opts = {}) {
  return h('button', {
    class: 'btn icon-btn' + (opts.class ? ' ' + opts.class : ''),
    type: 'button',
    title: label,
    'aria-label': label,
    on: { click: onClick },
  }, icon(name, opts.size || 18), opts.showLabel ? h('span', { text: label }) : null);
}

/* ------------------------------------------------------------------ *
 * 3. Toast
 * ------------------------------------------------------------------ */

let toastRoot = null;
function ensureToastRoot() {
  if (!toastRoot) {
    toastRoot = document.getElementById('toast-root');
    if (!toastRoot) {
      toastRoot = h('div', { id: 'toast-root', class: 'toast-root' });
      document.body.appendChild(toastRoot);
    }
  }
  return toastRoot;
}

const TOAST_ICON = { info: 'info', success: 'check', error: 'close', warn: 'info' };

/**
 * 轻提示
 * @param {string|Error} message
 * @param {object} opts { type:'info'|'success'|'error'|'warn', duration:number }
 */
export function toast(message, opts = {}) {
  const root = ensureToastRoot();
  const type = opts.type || 'info';
  const text = message instanceof Error ? message.message || '操作失败' : String(message === undefined ? '' : message);
  const duration = opts.duration === undefined ? (type === 'error' ? 4200 : 2200) : opts.duration;

  const node = h('div', { class: 'toast toast-' + type, role: 'status' },
    icon(TOAST_ICON[type] || 'info', 16),
    h('span', { class: 'toast-text', text })
  );
  root.appendChild(node);
  // 最多同时显示 4 条
  while (root.children.length > 4) root.removeChild(root.firstChild);

  const remove = () => {
    if (!node.parentNode) return;
    node.classList.add('toast-out');
    setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, 180);
  };
  node.addEventListener('click', remove);
  if (duration > 0) setTimeout(remove, duration);
  return remove;
}

export const toastOk = (msg, opts) => toast(msg, Object.assign({ type: 'success' }, opts));
export const toastErr = (msg, opts) => toast(msg, Object.assign({ type: 'error' }, opts));
export const toastWarn = (msg, opts) => toast(msg, Object.assign({ type: 'warn' }, opts));

/** 统一的异常提示（ApiError 自带中文文案） */
export function toastError(err, fallback = '操作失败') {
  const msg = err && err.message ? err.message : fallback;
  return toastErr(msg);
}

/* ------------------------------------------------------------------ *
 * 4. Modal / Confirm / Prompt
 * ------------------------------------------------------------------ */

let modalRoot = null;
function ensureModalRoot() {
  if (!modalRoot) {
    modalRoot = document.getElementById('modal-root');
    if (!modalRoot) {
      modalRoot = h('div', { id: 'modal-root' });
      document.body.appendChild(modalRoot);
    }
  }
  return modalRoot;
}

const modalStack = [];

/**
 * 打开模态框
 * @param {object} opts { title, body:Node, footer:Node[], size:'sm'|'md'|'lg', onClose, closeOnBackdrop }
 * @returns {{close:Function, el:HTMLElement}}
 */
export function openModal(opts = {}) {
  const root = ensureModalRoot();
  const mask = h('div', { class: 'modal-mask' });
  const panel = h('div', { class: 'modal-panel modal-' + (opts.size || 'md'), role: 'dialog', 'aria-modal': 'true' });
  const header = h('div', { class: 'modal-head' },
    h('h3', { class: 'modal-title', text: opts.title || '' }),
    h('button', { class: 'modal-close btn-ghost', type: 'button', 'aria-label': '关闭', on: { click: () => close() } }, icon('close', 18))
  );
  const body = h('div', { class: 'modal-body' });
  if (opts.body) append(body, [opts.body]);
  const footer = h('div', { class: 'modal-foot' });
  if (opts.footer && opts.footer.length) append(footer, opts.footer);

  append(panel, [opts.title ? header : null, body, (opts.footer && opts.footer.length) ? footer : null]);
  mask.appendChild(panel);
  root.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('modal-in'));

  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    const idx = modalStack.indexOf(handle);
    if (idx >= 0) modalStack.splice(idx, 1);
    mask.classList.remove('modal-in');
    setTimeout(() => { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 160);
    if (opts.onClose) opts.onClose(result);
  }
  const handle = { close, el: panel, body };

  if (opts.closeOnBackdrop !== false) {
    mask.addEventListener('click', (ev) => { if (ev.target === mask) close(null); });
  }
  modalStack.push(handle);
  // 焦点落到第一个可聚焦元素
  setTimeout(() => {
    const focusable = panel.querySelector('input, textarea, select, button:not(.modal-close)');
    if (focusable) focusable.focus({ preventScroll: true });
  }, 60);

  return handle;
}

/** 关闭最上层模态框（供 Esc 使用） */
export function closeTopModal() {
  const top = modalStack[modalStack.length - 1];
  if (top) { top.close(null); return true; }
  return false;
}

/** 是否有模态框打开 */
export function hasModal() {
  return modalStack.length > 0;
}

/**
 * 确认对话框
 * @returns {Promise<boolean>}
 */
export function confirmDialog(message, opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    const okBtn = h('button', {
      class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'),
      type: 'button',
      text: opts.okLabel || '确定',
      on: { click: () => { finish(true); handle.close(); } },
    });
    const cancelBtn = h('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: opts.cancelLabel || '取消',
      on: { click: () => { finish(false); handle.close(); } },
    });
    const handle = openModal({
      title: opts.title || '请确认',
      size: 'sm',
      body: h('p', { class: 'modal-text', text: message }),
      footer: [cancelBtn, okBtn],
      onClose: () => finish(false),
    });
  });
}

/**
 * 单行输入对话框
 * @returns {Promise<string|null>}
 */
export function promptDialog(opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    const listId = opts.datalist && opts.datalist.length ? 'dl-' + Math.random().toString(36).slice(2, 8) : '';
    const input = h('input', {
      class: 'input',
      type: 'text',
      value: opts.value || '',
      placeholder: opts.placeholder || '',
      list: listId || undefined,
    });
    const submit = () => { const v = input.value.trim(); finish(v); handle.close(); };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
      ev.stopPropagation();
    });
    const body = h('div', { class: 'form-row' },
      opts.label ? h('label', { class: 'form-label', text: opts.label }) : null,
      input,
      opts.hint ? h('p', { class: 'form-hint', text: opts.hint }) : null,
      listId ? datalistNode(listId, opts.datalist) : null
    );
    const handle = openModal({
      title: opts.title || '输入',
      size: 'sm',
      body,
      footer: [
        h('button', { class: 'btn btn-ghost', type: 'button', text: '取消', on: { click: () => { finish(null); handle.close(); } } }),
        h('button', { class: 'btn btn-primary', type: 'button', text: opts.okLabel || '确定', on: { click: submit } }),
      ],
      onClose: () => finish(null),
    });
  });
}

/** 生成 datalist（id 与输入框的 list 属性一致） */
function datalistNode(id, items) {
  const dl = h('datalist', { id });
  for (const it of items) dl.appendChild(h('option', { value: it }));
  return dl;
}

/* ------------------------------------------------------------------ *
 * 5. Loading / 占位 / 错误态
 * ------------------------------------------------------------------ */

/** 局部 loading 遮罩 */
export function loadingBlock(text = '加载中…') {
  return h('div', { class: 'loading-block' },
    h('div', { class: 'spinner' }),
    h('span', { text })
  );
}

/** 骨架屏 */
export function skeleton(count = 6) {
  const wrap = h('div', { class: 'skeleton-grid' });
  for (let i = 0; i < count; i++) {
    wrap.appendChild(h('div', { class: 'skeleton-card' },
      h('div', { class: 'sk-cover' }),
      h('div', { class: 'sk-line sk-60' }),
      h('div', { class: 'sk-line sk-40' })
    ));
  }
  return wrap;
}

/** 空状态 */
export function emptyState(opts = {}) {
  return h('div', { class: 'empty-state' },
    h('div', { class: 'empty-icon' }, icon(opts.icon || 'folder', 42)),
    h('h3', { class: 'empty-title', text: opts.title || '这里空空如也' }),
    opts.desc ? h('p', { class: 'empty-desc', text: opts.desc }) : null,
    opts.actionLabel ? h('button', {
      class: 'btn btn-primary', type: 'button', text: opts.actionLabel,
      on: { click: opts.onAction || (() => {}) },
    }) : null
  );
}

/**
 * 统一错误态：后端未启动时也要给出友好提示，而不是白屏
 * @param {Error} err
 * @param {Function} onRetry
 */
export function errorState(err, onRetry) {
  const offline = !err || err.offline || err.code === 'NETWORK' || !navigator.onLine;
  const title = offline ? '无法连接后端服务' : '加载失败';
  const desc = offline
    ? '当前页面是纯静态前端，需要后端服务提供数据。请确认服务已启动后点击重试。'
    : (err && err.message) || '发生未知错误';
  return h('div', { class: 'empty-state error-state' },
    h('div', { class: 'empty-icon' }, icon(offline ? 'cloudOff' : 'info', 42)),
    h('h3', { class: 'empty-title', text: title }),
    h('p', { class: 'empty-desc', text: desc }),
    h('div', { class: 'empty-actions' },
      h('button', {
        class: 'btn btn-primary', type: 'button',
        on: { click: () => { if (onRetry) onRetry(); } },
      }, icon('refresh', 16), h('span', { text: '重试' }))
    )
  );
}

/* ------------------------------------------------------------------ *
 * 6. 长按菜单（移动端）/ 右键菜单（桌面端）
 * ------------------------------------------------------------------ */

/**
 * 绑定长按手势
 * @param {HTMLElement} el
 * @param {Function} handler 长按回调
 * @param {object} opts { duration:number, moveTolerance:number }
 * @returns {Function} 解绑函数
 */
export function longPress(el, handler, opts = {}) {
  const duration = opts.duration || 500;
  const tol = opts.moveTolerance || 12;
  let timer = null;
  let startX = 0;
  let startY = 0;
  let fired = false;

  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };
  const onDown = (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    fired = false;
    startX = ev.clientX;
    startY = ev.clientY;
    cancel();
    timer = setTimeout(() => {
      fired = true;
      timer = null;
      handler(ev);
    }, duration);
  };
  const onMove = (ev) => {
    if (!timer) return;
    if (Math.abs(ev.clientX - startX) > tol || Math.abs(ev.clientY - startY) > tol) cancel();
  };
  const onUp = () => cancel();

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('pointerleave', onUp);
  el.addEventListener('contextmenu', (ev) => {
    // 移动端长按会触发 contextmenu，统一交给长按逻辑
    if (fired) { ev.preventDefault(); return; }
    if (opts.contextMenu !== false) { ev.preventDefault(); handler(ev); }
  });

  return () => {
    cancel();
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('pointerleave', onUp);
  };
}

/**
 * 弹出操作菜单
 * @param {Array} items [{ label, icon, danger, onClick }]
 * @param {object} opts { x, y, title }
 */
export function actionSheet(items, opts = {}) {
  const list = h('div', { class: 'sheet-list' });
  if (opts.title) list.appendChild(h('div', { class: 'sheet-title', text: opts.title }));
  const handle = openModal({
    title: '',
    size: 'sm',
    body: list,
    footer: [],
  });
  for (const item of items) {
    list.appendChild(h('button', {
      class: 'sheet-item' + (item.danger ? ' danger' : ''),
      type: 'button',
      on: { click: () => { handle.close(); if (item.onClick) item.onClick(); } },
    }, item.icon ? icon(item.icon, 18) : null, h('span', { text: item.label })));
  }
  return handle;
}

/* ------------------------------------------------------------------ *
 * 7. 工具函数
 * ------------------------------------------------------------------ */

/** 节流 */
export function throttle(fn, wait = 200) {
  let last = 0;
  let timer = null;
  return function throttled(...args) {
    const now = Date.now();
    const remain = wait - (now - last);
    if (remain <= 0) {
      last = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn.apply(this, args);
      }, remain);
    }
  };
}

/** 防抖 */
export function debounce(fn, wait = 300) {
  let timer = null;
  return function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(this, args); }, wait);
  };
}

/** 数值收敛 */
export function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

/** 时间戳 → 本地时间字符串 */
export function formatTime(ts, withTime = true) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '—';
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  const date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  if (!withTime) return date;
  return date + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 相对时间：刚刚 / N分钟前 */
export function fromNow(ts) {
  if (!ts) return '从未';
  const diff = Date.now() - Number(ts);
  if (diff < 0) return formatTime(ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + ' 小时前';
  const day = Math.floor(hour / 24);
  if (day < 30) return day + ' 天前';
  return formatTime(ts, false);
}

/** 毫秒 → 可读耗时 */
export function formatDuration(ms) {
  const num = Number(ms);
  if (!Number.isFinite(num) || num < 0) return '—';
  if (num < 1000) return Math.round(num) + ' ms';
  if (num < 60000) return (num / 1000).toFixed(1) + ' s';
  const min = Math.floor(num / 60000);
  return min + ' 分 ' + Math.round((num % 60000) / 1000) + ' 秒';
}

/** 秒 → 可读时长 */
export function formatSeconds(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const hour = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  if (hour > 0) return hour + ' 小时 ' + min + ' 分钟';
  if (min > 0) return min + ' 分钟';
  return s + ' 秒';
}

/** 字节 → 可读大小 */
export function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

/** 从 URL 中提取主机名 */
export function hostOf(url) {
  if (!url) return '—';
  try {
    return new URL(url, location.origin).host;
  } catch (e) {
    return String(url).replace(/^https?:\/\//, '').split('/')[0] || '—';
  }
}

/** 高亮关键词（返回 DocumentFragment，安全） */
export function highlightText(text, keyword) {
  const frag = document.createDocumentFragment();
  const src = String(text === null || text === undefined ? '' : text);
  const kw = String(keyword || '').trim();
  if (!kw) { frag.appendChild(document.createTextNode(src)); return frag; }
  const lower = src.toLowerCase();
  const target = kw.toLowerCase();
  let pos = 0;
  while (pos < src.length) {
    const idx = lower.indexOf(target, pos);
    if (idx < 0) { frag.appendChild(document.createTextNode(src.slice(pos))); break; }
    if (idx > pos) frag.appendChild(document.createTextNode(src.slice(pos, idx)));
    frag.appendChild(h('mark', { class: 'hl', text: src.slice(idx, idx + kw.length) }));
    pos = idx + kw.length;
  }
  return frag;
}

/** 生成稳定的去重键：书名 + 作者 */
export function dedupeKey(name, author) {
  const norm = (s) => String(s || '').replace(/[\s\[\]【】《》〈〉「」『』()（）·、,，.。:：!！?？"'"'—-]/g, '').toLowerCase();
  return norm(name) + '::' + norm(author);
}

/** 向下取整的安全数字 */
export function toInt(val, def = 0) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : def;
}
