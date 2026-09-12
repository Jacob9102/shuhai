/**
 * 容错 HTML 解析器 —— 零依赖。
 *
 * 设计目标：面对真实小说站点的「脏 HTML」（未闭合标签、属性无引号、
 * 大小写混乱、GBK 解码后的乱码字符）也能构建出可用的 DOM 树，
 * 并且对几千个节点的目录页保持线性复杂度。
 *
 * 节点形态：
 *   element: { type:'element', tag, attrs:{}, children:[], parent }
 *   text:    { type:'text', data, parent }
 *   comment: { type:'comment', data, parent }
 */

/** 自闭合 / 空元素：不需要闭合标签 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr', 'basefont', 'frame',
]);

/** 内容为原始文本的元素（内部不做标签解析） */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'iframe']);

/**
 * HTML 隐式闭合规则：给定「即将开始的新标签」和「当前栈顶的开标签」，
 * 判断是否应先自动闭合栈顶元素。
 *
 * 方向很关键：是「新标签关闭旧标签」，不是反过来。
 * 例如 <p> 遇到 <div> 时 p 被关闭；而 <div> 遇到 <p> 时 div 不受影响。
 */
const BLOCK_LEVEL = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'ul', 'li', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'center',
  'dir', 'listing', 'plaintext', 'xmp', 'summary',
]);

/** 同标签自闭合的（新的同类标签会关闭旧的） */
const SELF_CLOSING_PAIRS = new Set([
  'li', 'p', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody',
  'tfoot', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'rt', 'rp', 'colgroup', 'caption',
]);

function implicitlyCloses(newTag, openTag) {
  if (newTag === openTag) return SELF_CLOSING_PAIRS.has(newTag);
  // 任何块级标签都会关闭未闭合的 <p>
  if (openTag === 'p') return BLOCK_LEVEL.has(newTag);
  // 表格结构
  if (openTag === 'td' || openTag === 'th') return newTag === 'tr' || newTag === 'thead' || newTag === 'tbody' || newTag === 'tfoot';
  if (openTag === 'tr') return newTag === 'tr' || newTag === 'thead' || newTag === 'tbody' || newTag === 'tfoot';
  if (openTag === 'thead' || openTag === 'tbody') return newTag === 'tbody' || newTag === 'tfoot';
  if (openTag === 'tfoot') return newTag === 'tbody';
  if (openTag === 'dt') return newTag === 'dd';
  if (openTag === 'dd') return newTag === 'dt';
  if (openTag === 'option') return newTag === 'optgroup';
  return false;
}

/** 常见具名实体表（覆盖小说站 99% 场景） */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', middot: '\u00b7',
  times: '\u00d7', divide: '\u00f7', laquo: '\u00ab', raquo: '\u00bb',
  deg: '\u00b0', plusmn: '\u00b1', sect: '\u00a7', para: '\u00b6',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
  larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193',
  ensp: ' ', emsp: ' ', thinsp: ' ', shy: '\u00ad', zwnj: '\u200c', zwj: '\u200d',
};

const ENTITY_RE = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/** 解码 HTML 实体（具名 + 十进制 + 十六进制） */
export function decodeEntities(str) {
  if (str.indexOf('&') === -1) return str;
  return str.replace(ENTITY_RE, (whole, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return whole;
      try { return String.fromCodePoint(cp); } catch { return whole; }
    }
    const named = ENTITIES[body] ?? ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : whole;
  });
}

/** 反转义后重新转义，用于安全输出 */
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function makeElement(tag, attrs, parent) {
  const node = { type: 'element', tag, attrs: attrs || {}, children: [], parent: parent || null };
  return node;
}

function makeText(data, parent) {
  return { type: 'text', data, parent: parent || null };
}

function appendChild(parent, node) {
  node.parent = parent;
  parent.children.push(node);
}

/**
 * 从 pos（指向 '<'）开始读取一个开始标签，正确处理引号内的 '>'。
 * 返回 { end, tag, attrs, selfClosing }；解析失败返回 null。
 */
function readStartTag(html, pos) {
  const len = html.length;
  let i = pos + 1;
  // 标签名
  const nameStart = i;
  while (i < len) {
    const c = html.charCodeAt(i);
    // 空白 / '/' / '>'
    if (c === 32 || c === 9 || c === 10 || c === 12 || c === 13 || c === 47 || c === 62) break;
    i++;
  }
  if (i === nameStart) return null;
  const tag = html.slice(nameStart, i).toLowerCase();
  if (!/^[a-z][a-z0-9]*$/.test(tag)) return null;

  const attrs = {};
  let selfClosing = false;
  const MAX = Math.min(len, pos + 200000); // 防御性上限

  while (i < MAX) {
    // 跳过空白
    while (i < len && (html.charCodeAt(i) === 32 || html.charCodeAt(i) === 9 || html.charCodeAt(i) === 10 || html.charCodeAt(i) === 12 || html.charCodeAt(i) === 13)) i++;
    if (i >= len) break;
    let c = html[i];
    if (c === '>') { i++; break; }
    if (c === '/') {
      // 可能是 '/>' 也可能是属性名里的杂字符
      let j = i + 1;
      while (j < len && /\s/.test(html[j])) j++;
      if (html[j] === '>') { selfClosing = true; i = j + 1; break; }
      i++;
      continue;
    }
    // 属性名
    const attrStart = i;
    while (i < len) {
      const cc = html[i];
      if (cc === '=' || cc === '>' || cc === '/' || cc === ' ' || cc === '\t' || cc === '\n' || cc === '\r' || cc === '\f') break;
      i++;
    }
    if (i === attrStart) { i++; continue; }
    const attrName = html.slice(attrStart, i).toLowerCase();
    // 跳过空白
    while (i < len && /\s/.test(html[i])) i++;
    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < len && /\s/.test(html[i])) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        if (close === -1) { value = html.slice(i + 1); i = len; }
        else { value = html.slice(i + 1, close); i = close + 1; }
      } else {
        const vStart = i;
        while (i < len) {
          const cc = html[i];
          if (cc === '>' || /\s/.test(cc)) break;
          i++;
        }
        value = html.slice(vStart, i);
      }
      value = decodeEntities(value);
    } else {
      value = '';
    }
    if (attrName && !(attrName in attrs)) attrs[attrName] = value;
  }
  if (i >= len && html[len - 1] !== '>') {
    // 到达文末仍未闭合，视为到文末
    i = len;
  }
  return { end: i, tag, attrs, selfClosing };
}

/**
 * 解析 HTML，返回文档根节点。
 * @param {string} html
 * @param {{lowerCaseTags?:boolean}} [opts]
 */
export function parseHtml(html, opts = {}) {
  if (typeof html !== 'string') html = String(html ?? '');
  const root = makeElement('#document', {}, null);
  const stack = [root];
  const len = html.length;
  let i = 0;

  const top = () => stack[stack.length - 1];

  const addText = (raw) => {
    if (!raw) return;
    const p = top();
    if (p.tag === '#document' && !raw.trim()) return;
    appendChild(p, makeText(decodeEntities(raw), p));
  };

  const closeTag = (tag) => {
    for (let d = stack.length - 1; d >= 1; d--) {
      if (stack[d].tag === tag) {
        stack.length = d;
        return true;
      }
    }
    return false; // 没有匹配的开始标签，忽略
  };

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { addText(html.slice(i)); break; }
    if (lt > i) addText(html.slice(i, lt));

    const next = html[lt + 1];

    // 注释
    if (next === '!') {
      if (html.startsWith('<!--', lt)) {
        const end = html.indexOf('-->', lt + 4);
        const stop = end === -1 ? len : end + 3;
        const data = html.slice(lt + 4, end === -1 ? len : end);
        if (data.length < 4096) appendChild(top(), { type: 'comment', data, parent: null });
        i = stop;
        continue;
      }
      // <!DOCTYPE ...> 或 <![CDATA[...]]>
      if (html.startsWith('<![CDATA[', lt)) {
        const end = html.indexOf(']]>', lt + 9);
        addText(html.slice(lt + 9, end === -1 ? len : end));
        i = end === -1 ? len : end + 3;
        continue;
      }
      const end = html.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }

    // 处理指令 / XML 声明
    if (next === '?') {
      const end = html.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }

    // 结束标签
    if (next === '/') {
      const end = html.indexOf('>', lt);
      if (end === -1) { addText(html.slice(lt)); break; }
      const raw = html.slice(lt + 2, end).trim();
      const tag = raw.split(/[\s/]/)[0].toLowerCase();
      if (tag) closeTag(tag);
      i = end + 1;
      continue;
    }

    // 开始标签
    if (next && /[a-zA-Z]/.test(next)) {
      const st = readStartTag(html, lt);
      if (!st) { addText('<'); i = lt + 1; continue; }
      const { tag, attrs, selfClosing, end } = st;

      // 隐式闭合：新标签可能关闭栈顶（甚至连续多个）未显式闭合的旧标签
      for (let guard = 0; guard < 8 && stack.length > 1; guard++) {
        const t = stack[stack.length - 1];
        if (!t || !implicitlyCloses(tag, t.tag)) break;
        stack.pop();
      }

      const node = makeElement(tag, attrs, top());
      appendChild(top(), node);
      i = end;

      if (selfClosing || VOID_TAGS.has(tag)) continue;

      // 原始文本元素：直接扫到闭合标签
      if (RAW_TEXT_TAGS.has(tag)) {
        const closeRe = new RegExp('</' + tag + '\\s*>', 'i');
        const rest = html.slice(i);
        const m = closeRe.exec(rest);
        const raw = m ? rest.slice(0, m.index) : rest;
        if (raw) appendChild(node, makeText(raw, node));
        i = m ? i + m.index + m[0].length : len;
        continue;
      }

      if (stack.length < 800) stack.push(node);
      continue;
    }

    // 孤立的 '<'
    addText('<');
    i = lt + 1;
  }

  return root;
}

/* ------------------------------------------------------------------ */
/* DOM 辅助                                                            */
/* ------------------------------------------------------------------ */

const COLLAPSE_WS_RE = /[\t\n\r\f\v\u00a0\u3000]+/g;

/** 该元素是否参与文本提取 */
function textBearing(node) {
  return node.tag !== 'script' && node.tag !== 'style' && node.tag !== 'noscript' && node.tag !== 'template';
}

/**
 * 取文本，语义对齐 Jsoup 的 Element.text()：
 * 合并全部后代文本节点、把连续空白折叠成单个空格、首尾去空白。
 */
export function textOf(node) {
  if (!node) return '';
  if (node.type === 'text') return node.data;
  let out = '';
  const walk = (n) => {
    if (!textBearing(n)) return;
    for (const c of n.children || []) {
      if (c.type === 'text') out += c.data;
      else if (c.type === 'element') { walk(c); out += ' '; }
    }
  };
  walk(node);
  return out.replace(COLLAPSE_WS_RE, ' ').replace(/ {2,}/g, ' ').trim();
}

/** 直接子文本节点（不含后代元素内的文本），对齐 legado ownText */
export function ownTextOf(node) {
  if (!node) return '';
  if (node.type === 'text') return node.data;
  let out = '';
  for (const c of node.children || []) if (c.type === 'text') out += c.data;
  return out.replace(COLLAPSE_WS_RE, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * 每个直接文本节点/块级子元素一行，对齐 legado textNodes。
 * 这是正文提取最常用的语义。
 */
export function textNodesOf(node) {
  if (!node) return '';
  if (node.type === 'text') return node.data.trim();
  if (node.type !== 'element') return '';
  const parts = [];
  for (const c of node.children || []) {
    if (c.type === 'text') {
      const s = c.data.replace(COLLAPSE_WS_RE, ' ').trim();
      if (s) parts.push(s);
    } else if (c.type === 'element' && textBearing(c)) {
      const s = textOf(c);
      if (s) parts.push(s);
    }
  }
  return parts.join('\n');
}

/** 取属性（大小写不敏感） */
export function attrOf(node, name) {
  if (!node || node.type !== 'element') return '';
  const v = node.attrs[name.toLowerCase()];
  return v === undefined ? '' : v;
}

/** 拼接 innerHTML */
export function innerHtml(node) {
  if (!node || !node.children) return '';
  let out = '';
  for (const c of node.children) out += outerHtml(c);
  return out;
}

/** 拼接 outerHTML */
export function outerHtml(node) {
  if (!node) return '';
  if (node.type === 'text') return escapeHtml(node.data);
  if (node.type === 'comment') return '<!--' + node.data + '-->';
  if (node.type !== 'element') return '';
  if (node.tag === '#document') return innerHtml(node);
  let s = '<' + node.tag;
  for (const k in node.attrs) {
    const v = node.attrs[k];
    s += v === '' ? ' ' + k : ' ' + k + '="' + escapeHtml(v) + '"';
  }
  if (VOID_TAGS.has(node.tag)) return s + '>';
  s += '>';
  s += innerHtml(node);
  return s + '</' + node.tag + '>';
}

/** 深度优先遍历（前序），fn 返回 false 可剪枝 */
export function walk(node, fn) {
  if (!node) return;
  const stack = [node];
  const childFirst = [];
  while (stack.length) {
    const n = stack.pop();
    if (n !== node) {
      if (fn(n) === false) continue;
    }
    const ch = n.children;
    if (ch && ch.length) {
      childFirst.length = 0;
      for (let k = ch.length - 1; k >= 0; k--) childFirst.push(ch[k]);
      for (const c of childFirst) stack.push(c);
    }
  }
}

/** 收集全部后代元素 */
export function descendants(node, out = []) {
  if (!node || !node.children) return out;
  for (const c of node.children) {
    if (c.type === 'element') { out.push(c); descendants(c, out); }
  }
  return out;
}

/** 元素在父节点中的元素序号（0 基） */
export function elementIndex(node) {
  const p = node.parent;
  if (!p) return 0;
  let idx = 0;
  for (const c of p.children) {
    if (c === node) return idx;
    if (c.type === 'element') idx++;
  }
  return idx;
}

export const HTML_VOID_TAGS = VOID_TAGS;
