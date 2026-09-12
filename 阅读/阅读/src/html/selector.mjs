/**
 * CSS 选择器引擎 —— 零依赖，服务于 legado 书源规则的 \`css:\` 前缀与
 * \`class.xxx\` / \`id.xxx\` / \`tag.xxx\` 的糖衣语法。
 *
 * 支持：标签、*、.class、#id、[attr]、[attr=v]、[attr^=v]、[attr\$=v]、
 *       [attr*=v]、[attr~=v]、[attr|=v]、[attr!=v]、
 *       :first-child :last-child :only-child :nth-child(n) :nth-of-type(n)
 *       :first :last :eq(n) :lt(n) :gt(n) :not(s) :has(s) :contains(t) :empty
 *       组合器：后代(空格) > + ~ ，以及逗号分组。
 */

import { attrOf, descendants, elementIndex, textOf } from './parser.mjs';

const COMPOUND_CACHE = new Map();
const GROUP_CACHE = new Map();
const MAX_CACHE = 500;

/* ----------------------------- 选择器解析 ----------------------------- */

/**
 * 把一个复合选择器字符串解析为条件数组。
 * 例："div.foo#bar[href^=x]:eq(1)"  ->
 *   [{t:'tag',v:'div'},{t:'class',v:'foo'},{t:'id',v:'bar'},
 *    {t:'attr',name:'href',op:'^=',value:'x'},{t:'pseudo',name:'eq',arg:'1'}]
 */
function parseCompound(str) {
  const cached = COMPOUND_CACHE.get(str);
  if (cached) return cached;

  const parts = [];
  let i = 0;
  const s = str;
  const len = s.length;

  while (i < len) {
    const c = s[i];

    if (c === '*') { parts.push({ t: 'universal' }); i++; continue; }

    if (c === '.') {
      let j = i + 1;
      while (j < len && /[-\w\u00a0-\uffff]/.test(s[j])) j++;
      if (j === i + 1) throw new SelectorError('无效的类选择器: ' + str);
      parts.push({ t: 'class', v: s.slice(i + 1, j) });
      i = j;
      continue;
    }

    if (c === '#') {
      let j = i + 1;
      while (j < len && /[-\w\u00a0-\uffff]/.test(s[j])) j++;
      if (j === i + 1) throw new SelectorError('无效的 ID 选择器: ' + str);
      parts.push({ t: 'id', v: s.slice(i + 1, j) });
      i = j;
      continue;
    }

    if (c === '[') {
      const close = findClosing(s, i, '[', ']');
      if (close === -1) throw new SelectorError('未闭合的属性选择器: ' + str);
      parts.push(parseAttrSelector(s.slice(i + 1, close), str));
      i = close + 1;
      continue;
    }

    if (c === ':') {
      if (s[i + 1] === ':') {
        // ::text 之类的伪元素，legado 不用，忽略但消费掉
        let j = i + 2;
        while (j < len && /[-\w]/.test(s[j])) j++;
        parts.push({ t: 'pseudo-element', name: s.slice(i + 2, j).toLowerCase() });
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < len && /[-\w]/.test(s[j])) j++;
      const name = s.slice(i + 1, j).toLowerCase();
      let arg = null;
      if (s[j] === '(') {
        const close = findClosing(s, j, '(', ')');
        if (close === -1) throw new SelectorError('未闭合的伪类: ' + str);
        arg = s.slice(j + 1, close).trim();
        j = close + 1;
      }
      parts.push({ t: 'pseudo', name, arg });
      i = j;
      continue;
    }

    // 标签名（含 legado 里常见的下划线、数字，如 h1）
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < len && /[-a-zA-Z0-9_]/.test(s[j])) j++;
      parts.push({ t: 'tag', v: s.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }

    // 未识别的字符（真实站点里偶尔混入 \\ 等），跳过以免整体失败
    i++;
  }

  if (parts.length === 0) parts.push({ t: 'universal' });
  if (COMPOUND_CACHE.size < MAX_CACHE) COMPOUND_CACHE.set(str, parts);
  return parts;
}

function findClosing(s, open, oc, cc) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = s.indexOf(c, i + 1);
      if (q === -1) return -1;
      i = q;
      continue;
    }
    if (c === oc) depth++;
    else if (c === cc) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function parseAttrSelector(body, whole) {
  const m = /^\s*([-\w:]+)\s*(?:([~^$*|!]?=)\s*(.*?)\s*)?$/.exec(body);
  if (!m) throw new SelectorError('无效的属性选择器: [' + body + '] in ' + whole);
  let value = m[3];
  if (value === undefined) value = null;
  else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { t: 'attr', name: (m[1] || '').toLowerCase(), op: m[2] || null, value };
}

/** 解析完整选择器为分组数组；每组是 [{combinator, compound}] */
function parseSelector(selector) {
  const cached = GROUP_CACHE.get(selector);
  if (cached) return cached;

  const groups = [];
  for (const rawGroup of splitTopLevel(selector, ',')) {
    const g = rawGroup.trim();
    if (!g) continue;
    const steps = [];
    let buf = '';
    let combinator = ' ';
    let i = 0;
    const pushBuf = () => {
      if (buf.trim()) { steps.push({ combinator, compound: parseCompound(buf.trim()) }); }
      buf = '';
    };
    while (i < g.length) {
      const c = g[i];
      if (c === '"' || c === "'") { const q = g.indexOf(c, i + 1); if (q === -1) { buf += g.slice(i); i = g.length; } else { buf += g.slice(i, q + 1); i = q + 1; } continue; }
      if (c === '[' || c === '(') {
        const close = findClosing(g, i, c, c === '[' ? ']' : ')');
        if (close === -1) { buf += g.slice(i); i = g.length; }
        else { buf += g.slice(i, close + 1); i = close + 1; }
        continue;
      }
      if (c === '>' || c === '+' || c === '~') {
        pushBuf();
        combinator = c;
        i++;
        while (i < g.length && /\s/.test(g[i])) i++;
        continue;
      }
      if (/\s/.test(c)) {
        // 空白可能是后代组合器
        let j = i;
        while (j < g.length && /\s/.test(g[j])) j++;
        if (buf.trim() && j < g.length) { pushBuf(); combinator = ' '; }
        i = j;
        continue;
      }
      buf += c;
      i++;
    }
    pushBuf();
    if (steps.length) groups.push(steps);
  }
  if (GROUP_CACHE.size < MAX_CACHE) GROUP_CACHE.set(selector, groups);
  return groups;
}

function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { const q = s.indexOf(c, i + 1); if (q === -1) break; i = q; continue; }
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

export class SelectorError extends Error {
  constructor(msg) { super(msg); this.name = 'SelectorError'; }
}

/* ----------------------------- 匹配逻辑 ----------------------------- */

function hasClass(node, cls) {
  const c = node.attrs.class;
  if (!c) return false;
  if (c === cls) return true;
  // 用 split 而非正则，避免类名里的特殊字符
  const list = c.split(/\s+/);
  for (let i = 0; i < list.length; i++) if (list[i] === cls) return true;
  return false;
}

function matchAttr(node, sel) {
  const actual = attrOf(node, sel.name);
  if (sel.op === null) {
    // 存在性：HTML 布尔属性值为空串，但属性存在即算命中
    return Object.prototype.hasOwnProperty.call(node.attrs, sel.name);
  }
  const v = sel.value;
  switch (sel.op) {
    case '=': return actual === v;
    case '!=': return actual !== v;
    case '^=': return v !== '' && actual.startsWith(v);
    case '$=': return v !== '' && actual.endsWith(v);
    case '*=': return v !== '' && actual.includes(v);
    case '~=': return v !== '' && actual.split(/\s+/).includes(v);
    case '|=': return actual === v || actual.startsWith(v + '-');
    default: return false;
  }
}

function nthMatch(spec, idx) {
  const s = spec.trim().toLowerCase();
  if (s === 'odd') return idx % 2 === 1;
  if (s === 'even') return idx % 2 === 0;
  const m = /^([+-]?\d*)n\s*([+-]\s*\d+)?$/.exec(s.replace(/\s+/g, ''));
  if (m) {
    const aRaw = m[1];
    const a = aRaw === '' || aRaw === '+' ? 1 : aRaw === '-' ? -1 : parseInt(aRaw, 10);
    const b = m[2] ? parseInt(m[2].replace(/\s+/g, ''), 10) : 0;
    if (a === 0) return idx === b;
    const k = (idx - b) / a;
    return Number.isInteger(k) && k >= 0;
  }
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? idx === n : false;
}

function matchPseudo(node, sel) {
  const name = sel.name;
  switch (name) {
    case 'first-child': return elementIndex(node) === 0 && node.parent && node.parent.children.some((c) => c.type === 'element');
    case 'last-child': {
      const p = node.parent;
      if (!p) return false;
      const elems = p.children.filter((c) => c.type === 'element');
      return elems[elems.length - 1] === node;
    }
    case 'only-child': {
      const p = node.parent;
      if (!p) return false;
      return p.children.filter((c) => c.type === 'element').length === 1;
    }
    case 'empty': return !node.children.some((c) => c.type === 'element' || (c.type === 'text' && c.data.trim()));
    case 'nth-child': return nthMatch(sel.arg || '', elementIndex(node) + 1);
    case 'nth-last-child': {
      const p = node.parent;
      if (!p) return false;
      const elems = p.children.filter((c) => c.type === 'element');
      return nthMatch(sel.arg || '', elems.length - elementIndex(node));
    }
    case 'first-of-type': case 'last-of-type': case 'nth-of-type': case 'nth-last-of-type': {
      const p = node.parent;
      if (!p) return false;
      const same = p.children.filter((c) => c.type === 'element' && c.tag === node.tag);
      const at = same.indexOf(node);
      if (at === -1) return false;
      if (name === 'first-of-type') return at === 0;
      if (name === 'last-of-type') return at === same.length - 1;
      if (name === 'nth-of-type') return nthMatch(sel.arg || '', at + 1);
      return nthMatch(sel.arg || '', same.length - at);
    }
    case 'not': {
      const inner = parseCompound((sel.arg || '').trim());
      return !matchCompound(node, inner);
    }
    case 'has': {
      const list = selectAll(node, sel.arg || '');
      return list.length > 0;
    }
    case 'contains': {
      const needle = (sel.arg || '').replace(/^["']|["']$/g, '');
      return textOf(node).includes(needle);
    }
    // :eq/:lt/:gt/:first/:last 需要集合上下文，在 selectAll 里后置处理
    case 'eq': case 'lt': case 'gt': case 'first': case 'last': case 'even': case 'odd':
      return true;
    case 'root': return node.tag === '#document' || !node.parent || node.parent.tag === '#document';
    case 'enabled': case 'disabled': case 'checked': case 'selected': case 'hover': case 'focus': case 'active': case 'link': case 'visited':
      return true;
    default:
      return true; // 未知伪类宽容放行，避免整条规则失效
  }
}

function matchCompound(node, parts) {
  if (!node || node.type !== 'element') return false;
  for (const p of parts) {
    switch (p.t) {
      case 'universal': break;
      case 'tag': if (node.tag !== p.v) return false; break;
      case 'class': if (!hasClass(node, p.v)) return false; break;
      case 'id': if (attrOf(node, 'id') !== p.v) return false; break;
      case 'attr': if (!matchAttr(node, p)) return false; break;
      case 'pseudo': if (!matchPseudo(node, p)) return false; break;
      case 'pseudo-element': break;
      default: break;
    }
  }
  return true;
}

/** 应用 :eq/:lt/:gt/:first/:last 等需要集合上下文的伪类 */
function applySetPseudos(nodes, steps) {
  const last = steps[steps.length - 1];
  if (!last) return nodes;
  let out = nodes;
  const ops = last.compound.filter((p) => p.t === 'pseudo' && ['eq', 'lt', 'gt', 'first', 'last', 'even', 'odd'].includes(p.name));
  for (const op of ops) {
    switch (op.name) {
      case 'eq': { const n = parseInt(op.arg, 10); out = Number.isFinite(n) ? [out[n < 0 ? out.length + n : n]].filter(Boolean) : out; break; }
      case 'lt': { const n = parseInt(op.arg, 10); out = Number.isFinite(n) ? out.slice(0, Math.max(0, n)) : out; break; }
      case 'gt': { const n = parseInt(op.arg, 10); out = Number.isFinite(n) ? out.slice(n + 1) : out; break; }
      case 'first': out = out.slice(0, 1); break;
      case 'last': out = out.slice(-1); break;
      case 'even': out = out.filter((_, i) => i % 2 === 0); break;
      case 'odd': out = out.filter((_, i) => i % 2 === 1); break;
      default: break;
    }
  }
  return out;
}

function nextElementSibling(node) {
  const p = node.parent;
  if (!p) return null;
  const ch = p.children;
  const at = ch.indexOf(node);
  for (let i = at + 1; i < ch.length; i++) if (ch[i].type === 'element') return ch[i];
  return null;
}

function followingSiblings(node) {
  const out = [];
  let n = nextElementSibling(node);
  while (n) { out.push(n); n = nextElementSibling(n); }
  return out;
}

/**
 * 在 root 的后代中查询所有匹配元素（不含 root 自身，与 CSS/legado 一致）。
 * @returns {Array<object>}
 */
export function selectAll(root, selector) {
  if (!root || !selector) return [];
  const groups = parseSelector(String(selector));
  if (!groups.length) return [];

  const collected = [];
  const seen = new Set();

  for (const steps of groups) {
    let current = [root];
    for (let si = 0; si < steps.length; si++) {
      const { combinator, compound } = steps[si];
      const next = [];
      if (si === 0) {
        for (const node of current) {
          for (const d of descendants(node)) if (matchCompound(d, compound)) next.push(d);
        }
      } else if (combinator === '>') {
        for (const node of current) {
          for (const c of node.children || []) {
            if (c.type === 'element' && matchCompound(c, compound)) next.push(c);
          }
        }
      } else if (combinator === '+') {
        for (const node of current) {
          const s = nextElementSibling(node);
          if (s && matchCompound(s, compound)) next.push(s);
        }
      } else if (combinator === '~') {
        for (const node of current) {
          for (const s of followingSiblings(node)) if (matchCompound(s, compound)) next.push(s);
        }
      } else {
        for (const node of current) {
          for (const d of descendants(node)) if (matchCompound(d, compound)) next.push(d);
        }
      }
      const filtered = applySetPseudos(next, [{ compound }]);
      current = filtered;
      if (!current.length) break;
    }
    for (const n of current) {
      if (seen.has(n)) continue;
      seen.add(n);
      collected.push(n);
    }
  }

  // 恢复文档顺序，保证 legado 的索引语义稳定
  if (collected.length > 1) {
    const order = new Map();
    let counter = 0;
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      order.set(n, counter++);
      const ch = n.children;
      if (ch) for (let k = ch.length - 1; k >= 0; k--) stack.push(ch[k]);
    }
    collected.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }
  return collected;
}

/** 查询第一个匹配元素，未命中返回 null */
export function selectFirst(root, selector) {
  const list = selectAll(root, selector);
  return list.length ? list[0] : null;
}

/** 判断单个元素是否匹配选择器（不含集合伪类） */
export function matches(node, selector) {
  if (!node || node.type !== 'element') return false;
  try {
    const groups = parseSelector(String(selector));
    for (const steps of groups) {
      if (steps.length === 1 && matchCompound(node, steps[0].compound)) return true;
    }
  } catch { return false; }
  return false;
}
