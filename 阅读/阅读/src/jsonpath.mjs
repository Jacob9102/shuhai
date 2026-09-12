/**
 * 轻量 JSONPath —— 覆盖 legado 书源里实际会用到的子集。
 *
 * 支持：
 *   $                  根
 *   .key  /  ['key']   取字段（字段名含 - . 空格时用括号形式）
 *   [0]  [-1]          下标（负数从末尾数）
 *   [0:5]              切片
 *   [*]                通配（展开为数组）
 *   ..key              递归下降
 *   [?(...)]           过滤，支持 == != > >= < <= 与 && ，值可为数字/字符串/true/false/null
 *   [1,3]              多下标
 *
 * 未命中一律返回 undefined（与 JSONPath 的「无结果」语义一致），
 * 由上层决定是当作空字符串还是跳过。
 */

export class JsonPathError extends Error {
  constructor(msg) { super(msg); this.name = 'JsonPathError'; }
}

/** 把路径字符串切成段 */
function tokenize(path) {
  const segs = [];
  let i = 0;
  const s = path.trim();
  if (s[0] === '$') i = 1;
  else if (s[0] === '@') i = 1;

  while (i < s.length) {
    const c = s[i];
    if (c === '.') {
      if (s[i + 1] === '.') {
        // 递归下降
        i += 2;
        if (s[i] === '[') { segs.push({ t: 'recursiveAny' }); continue; }
        let j = i;
        while (j < s.length && /[^.[\]]/.test(s[j])) j++;
        const name = s.slice(i, j);
        if (!name) throw new JsonPathError('递归下降后缺少字段名: ' + path);
        segs.push({ t: 'recursive', name });
        i = j;
        continue;
      }
      i++;
      if (s[i] === '*') { segs.push({ t: 'wildcard' }); i++; continue; }
      let j = i;
      while (j < s.length && /[^.[\]]/.test(s[j])) j++;
      const name = s.slice(i, j);
      if (name) segs.push({ t: 'key', name });
      i = j;
      continue;
    }
    if (c === '[') {
      const close = matchBracket(s, i);
      if (close === -1) throw new JsonPathError('未闭合的 [ : ' + path);
      const body = s.slice(i + 1, close).trim();
      segs.push(parseBracket(body, path));
      i = close + 1;
      continue;
    }
    // 不以 . 开头的裸字段（如 "$data" 这种脏写法）
    let j = i;
    while (j < s.length && /[^.[\]]/.test(s[j])) j++;
    const name = s.slice(i, j);
    if (name) segs.push({ t: 'key', name });
    i = j;
  }
  return segs;
}

function matchBracket(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { const q = s.indexOf(c, i + 1); if (q === -1) return -1; i = q; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function parseBracket(body, path) {
  if (body === '*') return { t: 'wildcard' };
  if (body.startsWith('?(') && body.endsWith(')')) return { t: 'filter', expr: body.slice(2, -1) };
  if (body.startsWith('?') ) return { t: 'filter', expr: body.slice(1).replace(/^\(|\)$/g, '') };
  // 引号字符串 key
  const q = /^(['"])([\s\S]*)\1$/.exec(body);
  if (q) return { t: 'key', name: q[2] };
  // 切片
  if (body.includes(':')) {
    const [a, b] = body.split(':');
    return { t: 'slice', from: a.trim() === '' ? null : parseInt(a, 10), to: b?.trim() === '' ? null : parseInt(b, 10) };
  }
  // 多下标
  if (body.includes(',')) {
    const idx = body.split(',').map((x) => parseInt(x.trim(), 10)).filter(Number.isFinite);
    return { t: 'union', idx };
  }
  const n = parseInt(body, 10);
  if (Number.isFinite(n)) return { t: 'index', n };
  return { t: 'key', name: body };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function recursiveCollect(value, name, out) {
  if (Array.isArray(value)) {
    for (const v of value) recursiveCollect(v, name, out);
  } else if (isPlainObject(value)) {
    for (const k in value) {
      const v = value[k];
      if (k === name) out.push(v);
      recursiveCollect(v, name, out);
    }
  }
  return out;
}

/* --------------------------- 过滤器求值 --------------------------- */

function parseLiteral(raw) {
  const s = raw.trim();
  if (/^(['"])([\s\S]*)\1$/.test(s)) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === 'undefined') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}

function looseEq(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b || Number(b) === a;
  if (typeof b === 'number' && typeof a === 'string') return String(b) === a || Number(a) === b;
  return String(a) === String(b);
}

function compare(a, op, b) {
  switch (op) {
    case '==': case '=': return looseEq(a, b);
    case '!=': case '<>': return !looseEq(a, b);
    case '>': return Number(a) > Number(b);
    case '>=': return Number(a) >= Number(b);
    case '<': return Number(a) < Number(b);
    case '<=': return Number(a) <= Number(b);
    case '=~': try { return new RegExp(String(b).replace(/^\/|\/$/g, '')).test(String(a)); } catch { return false; }
    default: return false;
  }
}

function testPredicate(item, path, expr) {
  // 支持 && 和 ||
  if (/&&/.test(expr)) return expr.split('&&').every((e) => testPredicate(item, path, e));
  if (/\|\|/.test(expr)) return expr.split('||').some((e) => testPredicate(item, path, e));
  const not = /^\s*!/.test(expr) && !/!=/.test(expr);
  const body = not ? expr.replace(/^\s*!\s*/, '') : expr;
  const m = /^(.+?)\s*(==|!=|<>|>=|<=|=~|>|<|=)\s*(.+)$/.exec(body.trim());
  if (!m) {
    // 纯字段存在性判断
    const v = evalOperand(item, body.trim());
    const truthy = Array.isArray(v) ? v.length > 0 : Boolean(v);
    return not ? !truthy : truthy;
  }
  const left = evalOperand(item, m[1].trim());
  const right = parseLiteral(m[3]);
  const r = compare(left, m[2], right);
  return not ? !r : r;
}

function evalOperand(item, raw) {
  let cur = item;
  let expr = raw.trim();
  if (expr.startsWith('@')) expr = expr.slice(1);
  else if (expr.startsWith('$')) expr = expr.slice(1);
  if (!expr || expr === '.') return cur;
  const segs = tokenize('$' + expr);
  for (const seg of segs) {
    if (cur === undefined || cur === null) return undefined;
    if (seg.t === 'key') cur = isPlainObject(cur) || Array.isArray(cur) ? cur[seg.name] : undefined;
    else if (seg.t === 'index') cur = Array.isArray(cur) ? cur[seg.n < 0 ? cur.length + seg.n : seg.n] : undefined;
    else if (seg.t === 'wildcard') cur = Array.isArray(cur) ? cur : undefined;
    else return undefined;
  }
  return cur;
}

/* ------------------------------ 主流程 ------------------------------ */

/**
 * 对 JSON 值求值一个 JSONPath。
 * @returns {*} 命中返回对应值；通配/递归下降返回数组；未命中返回 undefined
 */
export function jsonPath(root, path) {
  if (path === undefined || path === null) return undefined;
  const s = String(path).trim();
  if (s === '' || s === '$' || s === '@' || s === '.') return root;
  const segs = tokenize(s);
  let current = [root];
  for (const seg of segs) {
    const next = [];
    for (const node of current) {
      if (node === undefined || node === null) continue;
      switch (seg.t) {
        case 'key': {
          if (Array.isArray(node)) {
            for (const it of node) if (isPlainObject(it) && seg.name in it) next.push(it[seg.name]);
          } else if (isPlainObject(node)) {
            if (seg.name in node) next.push(node[seg.name]);
          }
          break;
        }
        case 'index': {
          if (Array.isArray(node)) {
            const idx = seg.n < 0 ? node.length + seg.n : seg.n;
            if (idx >= 0 && idx < node.length) next.push(node[idx]);
          } else if (isPlainObject(node)) {
            // 对对象用下标：取第 n 个值（legado 偶见）
            const vals = Object.values(node);
            const idx = seg.n < 0 ? vals.length + seg.n : seg.n;
            if (idx >= 0 && idx < vals.length) next.push(vals[idx]);
          }
          break;
        }
        case 'slice': {
          if (Array.isArray(node)) {
            const from = seg.from === null ? 0 : (seg.from < 0 ? node.length + seg.from : seg.from);
            const to = seg.to === null ? node.length : (seg.to < 0 ? node.length + seg.to : seg.to);
            next.push(...node.slice(from, to));
          }
          break;
        }
        case 'union': {
          if (Array.isArray(node)) for (const n of seg.idx) {
            const idx = n < 0 ? node.length + n : n;
            if (idx >= 0 && idx < node.length) next.push(node[idx]);
          }
          break;
        }
        case 'wildcard': {
          if (Array.isArray(node)) next.push(...node);
          else if (isPlainObject(node)) next.push(...Object.values(node));
          break;
        }
        case 'recursive': {
          recursiveCollect(node, seg.name, next);
          break;
        }
        case 'filter': {
          const arr = Array.isArray(node) ? node : (isPlainObject(node) ? Object.values(node) : []);
          for (const it of arr) if (testPredicate(it, path, seg.expr)) next.push(it);
          break;
        }
        default: break;
      }
    }
    current = next;
    if (!current.length) return undefined;
  }
  if (current.length === 1) return current[0];
  return current;
}

/** 该字符串看起来像不像 JSONPath（用来决定按 JSON 还是 HTML 解析） */
export function looksLikeJsonPath(rule) {
  const s = String(rule || '').trim();
  return s.startsWith('$') || s.startsWith('@.');
}
