/**
 * legado（阅读 3.0）书源规则引擎。
 *
 * ── 支持的规则语法 ──────────────────────────────────────────────
 *   ||        或：按顺序求值，取第一个非空结果
 *   &&        与：全部求值后拼接
 *   %%        交叉合并（逐字符交替）
 *   ##正则##替换   字符串正则替换；只有 \`##正则\` 时表示删除匹配内容
 *   @         步骤链：class.x@tag.a@text
 *   {{ }}     JS 表达式（支持 java.ajax 等，见 jsbox.mjs）
 *   @js:xxx   该步骤的结果由 JS 计算
 *
 * ── 步骤（@ 分隔的每一段）───────────────────────────────────────
 *   css:.a > .b     原生 CSS 选择器
 *   class.foo       → .foo        （foo 里的空格自动转成 .，兼容 class.a b 写法）
 *   id.content      → #content
 *   tag.a           → a
 *   text.关键字      → 文本包含关键字的元素
 *   children        直接子元素
 *   [n] [-1] [a:b] [!n]   下标 / 切片 / 排除
 *   !class.ad       从当前集合中排除
 *   -class.list     反转结果顺序
 *   text / textNodes / ownText / all / html   取值步骤
 *   href / src / content / value / title / alt / data-* …  取属性（自动补全为绝对地址）
 *   $.data.list[*]  JSONPath（对 JSON 接口的书源）
 *
 * 内容（HTML）与 JSON 两种模式按步骤前缀自动切换，和 legado 一致：
 * 步骤以 $ 开头走 JSON，否则走 HTML。
 */

import {
  parseHtml, textOf, ownTextOf, textNodesOf, attrOf, innerHtml, outerHtml, descendants,
} from './html/parser.mjs';
import { selectAll, matches } from './html/selector.mjs';
import { jsonPath } from './jsonpath.mjs';
import { evalJs, evalJsRaw, stringifyResult } from './jsbox.mjs';
import { absUrl } from './net/http.mjs';

/* ============================ 顶层切分 ============================ */

/**
 * 按分隔符切分规则字符串，跳过 {{ }} / [] / () 内部与引号内部。
 */
function splitTopLevel(str, sep) {
  const out = [];
  const s = String(str);
  const sepLen = sep.length;
  let depthBracket = 0;
  let depthParen = 0;
  let brace = 0;
  let start = 0;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    // JS 表达式区块整体跳过
    if (c === '{' && s[i + 1] === '{') {
      const end = s.indexOf('}}', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = s.indexOf(c, i + 1);
      if (q === -1) break;
      i = q;
      continue;
    }
    if (c === '[') { depthBracket++; continue; }
    if (c === ']') { if (depthBracket > 0) depthBracket--; continue; }
    if (c === '(') { depthParen++; continue; }
    if (c === ')') { if (depthParen > 0) depthParen--; continue; }
    if (c === '{') { brace++; continue; }
    if (c === '}') { if (brace > 0) brace--; continue; }

    if (depthBracket === 0 && depthParen === 0 && brace === 0) {
      if (s.startsWith(sep, i)) {
        out.push(s.slice(start, i));
        i += sepLen - 1;
        start = i + 1;
      }
    }
  }
  out.push(s.slice(start));
  return out;
}

/** 取出字符串里所有 {{ }} 表达式，返回 [{start,end,expr}] */
function findJsBlocks(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf('{{', i);
    if (at === -1) break;
    const end = s.indexOf('}}', at + 2);
    if (end === -1) break;
    out.push({ start: at, end: end + 2, expr: s.slice(at + 2, end) });
    i = end + 2;
  }
  return out;
}

/**
 * 把一条规则切成「步骤」序列。
 *
 * legado 里步骤边界不只 `@` 一种，`<js>…</js>` 本身就是一个 JS 步骤，
 * 例如真实书源的 bookList 写法：
 *   <js>\nString(result).replace(/<!--|-->/g, "");\n</js>\n#book_list li
 * 这里必须先把 `<js>` 块抠出来再按 `@` 切，否则块内的 `@`（邮箱、字符串）
 * 会被误当成步骤分隔符。
 *
 * @returns {{kind:'text'|'js', raw?:string, code?:string}[]}
 */
function tokenizeSteps(str) {
  const s = String(str ?? '');
  if (!s.includes('<js>')) {
    return splitTopLevel(s, '@').map((x) => x.trim()).filter(Boolean).map((raw) => ({ kind: 'text', raw }));
  }
  const blocks = [];
  const MASK = '\u0000';
  const masked = s.replace(/<js>([\s\S]*?)<\/js>/gi, (_, code) => {
    blocks.push(code);
    return MASK + 'JS' + (blocks.length - 1) + MASK;
  });
  const steps = [];
  for (const part of splitTopLevel(masked, '@')) {
    const re = new RegExp(MASK + 'JS(\\d+)' + MASK, 'g');
    let last = 0;
    let m;
    while ((m = re.exec(part))) {
      const before = part.slice(last, m.index).trim();
      if (before) steps.push({ kind: 'text', raw: before });
      steps.push({ kind: 'js', code: blocks[Number(m[1])] });
      last = m.index + m[0].length;
    }
    const after = part.slice(last).trim();
    if (after) steps.push({ kind: 'text', raw: after });
  }
  return steps;
}

/**
 * 模板渲染：把 {{key}} {{page}} 直接替换，其余 {{表达式}} 交给 JS 沙箱。
 * 用于 searchUrl / exploreUrl 等 URL 模板。
 */
export async function renderTemplate(tpl, ctx = {}) {
  const s = String(tpl ?? '');
  if (!s.includes('{{')) return s;
  const blocks = findJsBlocks(s);
  if (!blocks.length) return s;

  const results = await Promise.all(blocks.map(async (b) => {
    const expr = b.expr.trim();
    if (expr === 'key') return String(ctx.key ?? '');
    if (expr === 'page') return String(ctx.page ?? 1);
    if (expr === 'baseUrl' || expr === 'sourceUrl') return String(ctx.baseUrl ?? '');
    if (expr === 'searchKey') return String(ctx.key ?? '');
    return await evalJs(expr, ctx);
  }));

  let out = '';
  let last = 0;
  for (let i = 0; i < blocks.length; i++) {
    out += s.slice(last, blocks[i].start) + results[i];
    last = blocks[i].end;
  }
  out += s.slice(last);
  return out;
}

/* ============================ 规则解析 ============================ */

/**
 * 解析一条规则字符串为可执行的树。
 * 优先顺序：|| → && → %% → ## → @
 */
export function parseRule(rule) {
  const raw = String(rule ?? '').trim();
  if (!raw) return { empty: true };

  const alternatives = splitTopLevel(raw, '||').map((altRaw) => {
    const alt = altRaw.trim();
    let reverse = false;
    let negative = false;
    let body = alt;
    // 整条规则以 - 开头 = 反转；以 ! 开头 = 取反（排除）
    if (/^-/.test(body) && !/^-\d/.test(body)) { reverse = true; body = body.slice(1); }
    if (body.startsWith('!')) { negative = true; body = body.slice(1); }

    const conjunctions = splitTopLevel(body, '&&').map((cj) => {
      const interleaves = splitTopLevel(cj, '%%').map((piece) => {
        const segs = splitTopLevel(piece, '##');
        const main = segs[0].trim();
        const regexes = [];
        for (let i = 1; i < segs.length; i += 2) {
          const pattern = segs[i];
          const replacement = i + 1 < segs.length ? segs[i + 1] : '';
          if (pattern) regexes.push([pattern, replacement]);
        }
        return { main, regexes };
      });
      return { interleaves };
    });
    return { reverse, negative, conjunctions };
  });

  return { empty: false, alternatives, raw };
}

/** 是否是一个"元素型"规则（用于 bookList / chapterList 判定） */
export function isRuleEmpty(rule) {
  return !rule || !String(rule).trim();
}

/* ============================ 步骤解析 ============================ */

const VALUE_STEPS = new Set([
  'text', 'textnodes', 'owntext', 'all', 'html', 'outerhtml', 'innerhtml',
  'content', 'value', 'href', 'src', 'url', 'title', 'alt', 'data-src',
  'data-original', 'data-lazy-src', 'poster', 'action', 'srcset',
]);

const URL_ATTRS = new Set(['href', 'src', 'url', 'data-src', 'data-original', 'data-lazy-src', 'poster', 'action', 'srcset']);

const KNOWN_TAGS = new Set([
  'a', 'abbr', 'article', 'aside', 'b', 'blockquote', 'body', 'br', 'button', 'caption',
  'center', 'code', 'col', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'fieldset',
  'figcaption', 'figure', 'font', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'head', 'header', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'label', 'legend',
  'li', 'link', 'main', 'map', 'mark', 'meta', 'nav', 'ol', 'option', 'p', 'pre', 'q',
  's', 'section', 'select', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'video',
]);

/**
 * 解析 @put:{key:"子规则"} 的正文，支持一次 put 多个（逗号分隔）。
 * key 可以带引号，值通常是带引号的规则字符串，也容忍不带引号。
 */
function parsePutBody(body) {
  const out = [];
  for (const seg of splitTopLevel(String(body), ',')) {
    const i = seg.indexOf(':');
    if (i <= 0) continue;
    const key = seg.slice(0, i).trim().replace(/^["']|["']$/g, '');
    let val = seg.slice(i + 1).trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (key) out.push({ key, rule: val });
  }
  return out;
}

/**
 * 解析单个步骤。
 * @returns {{kind:'selector'|'attr'|'json'|'children'|'self', ...}}
 */
export function parseStep(rawStep) {
  let s = String(rawStep ?? '').trim();
  const step = { negative: false, reverse: false, index: null, kind: 'selector', selector: '', attr: '', contains: '' };

  if (!s) return { kind: 'noop' };

  if (s.startsWith('!') && s.length > 1) { step.negative = true; s = s.slice(1).trim(); }
  else if (/^-/.test(s) && !/^-\d/.test(s)) { step.reverse = true; s = s.slice(1).trim(); }

  // 尾部下标：[0] [-1] [0:2] [!0] —— 只认纯数字形式，避免和 a[href] 冲突
  const idxMatch = /^(.*)\[\s*(!?\s*-?\d+\s*(?::\s*-?\d+\s*)?)\]\s*$/.exec(s);
  if (idxMatch && idxMatch[1]) {
    step.index = idxMatch[2].replace(/\s+/g, '');
    s = idxMatch[1].trim();
  } else {
    // legado 也允许省略方括号：a.1 / a.-1 / td.-1:-2 / tr!0 / class.even.0
    // 只认「点号或感叹号开头的纯数字尾部」，不会误伤 .book / col-2 / tag.a.b 这类正常选择器
    const bare = /^(.*?)(?:\.(-?\d+)(?::(-?\d+))?|!(\d+)(?::(-?\d+))?)$/.exec(s);
    if (bare && bare[1]) {
      if (bare[4] !== undefined) {
        // tr!0:-1 这种「排除第 0 个之后再切到 -1」的写法（去掉表头和表尾）
        // tr!0:-1 / tag.ul!0:1 —— 实测语义是「排除这两个下标」：
        //   书书小说搜索页 6 个 tr，!0:-1 要去掉表头和表尾 → 4 条结果
        //   奇塔小说目录 13 个 ul，!0:1 要去掉「最新章节」那两个 ul → 完整目录
        step.index = '!' + bare[4];
        if (bare[5] !== undefined) step.index2 = '!' + bare[5];
      } else {
        step.index = bare[3] !== undefined ? bare[2] + ':' + bare[3] : bare[2];
      }
      s = bare[1].trim();
    }
  }

  // JS 步骤
  if (s.startsWith('@js:') || s.startsWith('js:')) {
    step.kind = 'js';
    step.selector = s.replace(/^@?js:/, '');
    return step;
  }
  // 变量步骤：@get:{key} / @put:{key:"子规则"}
  const getM = /^@?get:\s*\{([^}]*)\}\s*$/.exec(s);
  if (getM) {
    step.kind = 'get';
    step.varKey = getM[1].trim().replace(/^["']|["']$/g, '');
    return step;
  }
  const putM = /^@?put:\s*\{([\s\S]*)\}\s*$/.exec(s);
  if (putM) {
    const pairs = parsePutBody(putM[1]);
    if (pairs.length) {
      step.kind = 'put';
      step.puts = pairs;
      return step;
    }
  }
  // 字面量 / 模板步骤：必须放在下面的 CSS 启发式**之前**——
  // `路径,{"method":"POST","body":{…}}` 这种写法里带空格和逗号，会被 `[\s>+~]` 误判成 CSS 选择器，
  // 于是整段 JSON 被拿去当选择器解析（QQ浏览器源的目录就是这么炸的）。
  if (
    /^https?:\/\//i.test(s)                       // 裸 URL
    || /^\{\{/.test(s)                             // 以模板开头的地址
    || /,\s*\{[\s\S]*\}\s*$/.test(s)                // 「URL,{选项}」写法
    || /^["'][\s\S]*["']$/.test(s)                 // 被引号包起来的字符串
  ) {
    step.kind = 'literal';
    step.selector = s;
    return step;
  }

  if (s.startsWith('@') && s.length > 1) { s = s.slice(1).trim(); }

  // CSS 前缀
  if (/^css:/i.test(s)) {
    step.kind = 'selector';
    step.selector = s.slice(4).trim();
    return step;
  }
  if (/^xpath:/i.test(s)) {
    // 本引擎不实现 XPath；退化成"把 xpath 当 css"的尽力而为模式并记录
    step.kind = 'selector';
    step.selector = s.slice(6).trim();
    step.unsupported = 'xpath';
    return step;
  }
  if (/^json:/i.test(s) || s.startsWith('$')) {
    step.kind = 'json';
    step.selector = s.replace(/^json:/i, '').trim();
    return step;
  }

  if (/^class\./i.test(s)) {
    const body = s.slice(6).trim();
    step.selector = body.split(/\s+/).filter(Boolean).map((c) => (c.startsWith('.') ? c : '.' + c)).join('');
    return step;
  }
  if (/^id\./i.test(s)) {
    const body = s.slice(3).trim();
    step.selector = body.split(/\s+/).filter(Boolean).map((c) => (c.startsWith('#') ? c : '#' + c)).join('');
    return step;
  }
  if (/^tag\./i.test(s)) {
    const body = s.slice(4).trim();
    // tag.a.b -> a.b （类名跟在标签后）
    step.selector = body.replace(/\s+/g, '').replace(/^\./, '');
    if (step.selector.startsWith('.')) step.selector = '*' + step.selector;
    return step;
  }
  if (/^text\./i.test(s)) {
    step.kind = 'selector';
    const body = s.slice(5).trim();
    // 文本包含：用 :contains 伪类；引号与括号需要转义
    step.selector = '*:contains(' + JSON.stringify(body) + ')';
    return step;
  }
  if (/^children$/i.test(s) || /^child$/i.test(s)) { step.kind = 'children'; return step; }
  if (s === '.' || s === 'self' || s === '自身') { step.kind = 'self'; return step; }

  // 取值 / 属性步骤
  const lower = s.toLowerCase();
  if (VALUE_STEPS.has(lower)) {
    step.kind = 'attr';
    step.attr = lower;
    return step;
  }
  if (/^data-[\w-]+$/i.test(s) || /^aria-[\w-]+$/i.test(s)) {
    step.kind = 'attr';
    step.attr = lower;
    return step;
  }

  // 裸 CSS 选择器（.foo / #foo / * / [attr] / 含组合器 / 标签+类：p.author、div#id）
  if (/^[.#*\[]/.test(s) || /[\s>+~]/.test(s) || /^[a-zA-Z][\w-]*[.#\[]/.test(s)) {
    step.kind = 'selector';
    step.selector = s;
    return step;
  }

  // 已知标签名 → CSS；否则当作属性名
  if (KNOWN_TAGS.has(lower)) {
    step.kind = 'selector';
    step.selector = lower;
    return step;
  }

  step.kind = 'attr';
  step.attr = s;
  return step;
}

/* ============================ 游标模型 ============================ */

const emptyCursor = () => ({ kind: 'empty', value: null });

function isCursorEmpty(cur) {
  if (!cur || cur.kind === 'empty') return true;
  if (cur.kind === 'elements') return cur.value.length === 0;
  if (cur.kind === 'strings') return cur.value.length === 0 || cur.value.every((x) => !String(x).trim());
  if (cur.kind === 'string') return String(cur.value).trim() === '';
  if (cur.kind === 'json') return cur.value === undefined || cur.value === null;
  return false;
}

const COLLAPSE = /[\t\n\r\f\v\u00a0\u3000]+/g;

/** 元素集合 → 字符串（对齐 legado：单个取 text，多个用换行连接） */
function elementsToString(list) {
  if (!list.length) return '';
  if (list.length === 1) return textOf(list[0]);
  return list.map((e) => textOf(e)).filter(Boolean).join('\n');
}

/** 把结果字符串统一做一次「折叠空白 + trim」，避免脏 HTML 带出大量空白 */
export function tidy(s) {
  return String(s ?? '').replace(COLLAPSE, ' ').replace(/[ ]{2,}/g, ' ').trim();
}

/** 游标 → 单个字符串 */
export function cursorToString(cur) {
  if (!cur || cur.kind === 'empty') return '';
  switch (cur.kind) {
    case 'string': return cur.value;
    case 'strings': return cur.value.filter((x) => x !== '').join('\n');
    case 'elements': return elementsToString(cur.value);
    case 'json': {
      if (cur.value === undefined || cur.value === null) return '';
      if (typeof cur.value === 'string') return cur.value;
      if (typeof cur.value === 'number' || typeof cur.value === 'boolean') return String(cur.value);
      return JSON.stringify(cur.value);
    }
    case 'raw': return cur.value;
    default: return '';
  }
}

/** 游标 → 字符串数组（保留列表语义，供 bookList 等使用） */
export function cursorToStrings(cur) {
  if (!cur || cur.kind === 'empty') return [];
  switch (cur.kind) {
    case 'string': return [cur.value];
    case 'strings': return cur.value.slice();
    case 'elements': return cur.value.map((e) => textOf(e));
    case 'json': {
      if (Array.isArray(cur.value)) return cur.value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
      if (cur.value === undefined || cur.value === null) return [];
      return [typeof cur.value === 'string' ? cur.value : JSON.stringify(cur.value)];
    }
    case 'raw': return [cur.value];
    default: return [];
  }
}

/** 取元素列表 */
export function cursorToElements(cur) {
  if (!cur) return [];
  if (cur.kind === 'elements') return cur.value;
  if (cur.kind === 'raw' || cur.kind === 'html') {
    const doc = cur.kind === 'html' ? cur.value : parseHtml(String(cur.value ?? ''));
    return descendants(doc);
  }
  return [];
}

/* ============================ 步骤执行 ============================ */

function applyIndex(list, indexSpec) {
  if (!indexSpec) return list;
  const spec = String(indexSpec);
  if (spec.startsWith('!')) {
    const n = parseInt(spec.slice(1), 10);
    if (!Number.isFinite(n)) return list;
    const at = n < 0 ? list.length + n : n;
    return list.filter((_, i) => i !== at);
  }
  if (spec.includes(':')) {
    const [a, b] = spec.split(':');
    const from = a === '' ? 0 : parseInt(a, 10);
    const to = b === '' ? list.length : parseInt(b, 10);
    // 真实书源里常见 td.-1:-2 这种「两个端点都是负数」的写法：
    // 它表达的是「从倒数第 N 个开始取」，不是 JS 的 slice(-1,-2)（那永远是空）。
    if (Number.isFinite(from) && Number.isFinite(to) && from < 0 && to < 0 && from > to) {
      return list.slice(to);
    }
    return list.slice(from, to);
  }
  const n = parseInt(spec, 10);
  if (!Number.isFinite(n)) return list;
  const at = n < 0 ? list.length + n : n;
  if (at < 0 || at >= list.length) return [];
  return [list[at]];
}

/** 在当前元素集合内查询选择器（Jsoup 语义：包含自身若自身匹配） */
function selectWithin(elements, selector, doc) {
  const out = [];
  const seen = new Set();
  for (const el of elements) {
    if (el.type === 'element' && matches(el, selector) && !seen.has(el)) { seen.add(el); out.push(el); }
    for (const d of selectAll(el, selector)) if (!seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
}

async function applyStep(step, cur, ctx, baseCur = null) {
  if (!step || step.kind === 'noop') return cur;

  // ---- 变量步骤：@get:{k} / @put:{k:"规则"} ----
  if (step.kind === 'get') {
    const v = ctx?.vars?.get(step.varKey);
    if (v === undefined || v === null || v === '') return emptyCursor();
    return { kind: 'string', value: String(v) };
  }
  if (step.kind === 'put') {
    // 副作用步骤：把子规则结果写进变量，本步骤返回「上一步的值」（legado 语义，
    // 例：name 用 "@put:{u:...}" 暂存 href，bookUrl 再用 "@get:{u}" 取回）。
    // 子规则要在**本链条的起始游标**（如搜索结果的 <li> 元素）上求值，
    // 而不是在上一步产生的中间值（文本）上求值。
    const scope = baseCur || cur;
    for (const p of step.puts) {
      try {
        const sub = await evalRule(p.rule, scope, ctx);
        ctx?.vars?.set(p.key, cursorToString(sub));
      } catch (err) {
        ctx?.errors?.push('put 规则求值失败（' + p.key + '）: ' + err.message);
      }
    }
    return cur;
  }

  // ---- 字面量 / 模板步骤 ----
  if (step.kind === 'literal') {
    let tpl = String(step.selector || '');
    if (tpl.length >= 2 && ((tpl.startsWith('"') && tpl.endsWith('"')) || (tpl.startsWith("'") && tpl.endsWith("'")))) {
      tpl = tpl.slice(1, -1);
    }
    const rendered = tpl.includes('{{')
      ? await renderTemplate(tpl, {
        ...ctx,
        result: cursorToString(cur),
        jsonValue: cur && cur.kind === 'json' ? cur.value : undefined,
      })
      : tpl;
    return { kind: 'string', value: String(rendered ?? '').trim() };
  }

  if (step.kind === 'js') {
    // 用 Raw 版本拿原始值：尾部下标（`@js:result.match(/.../)[1]`、`[0:2]`）必须作用在
    // JS 返回的真数组上。若先经过 evalJs 的 JSON 字符串化，下标就会落到字符串上而失效，
    // 于是 bookUrl 变成 '["(/b/1.html, , )","/b/1.html"]' 这种垃圾值，后续目录请求必然 404。
    const raw = await evalJsRaw(step.selector, { ...ctx, result: cursorToString(cur) });
    if (step.index != null) {
      const picked = applyStepIndexToValue(raw, step);
      if (Array.isArray(picked)) return { kind: 'json', value: picked };
      return { kind: 'string', value: stringifyResult(picked) };
    }
    return { kind: 'string', value: stringifyResult(raw) };
  }

  // ---- JSON 步骤 ----
  if (step.kind === 'json') {
    let base = cur;
    if (cur.kind === 'raw' || cur.kind === 'string' || cur.kind === 'html') {
      const parsed = ctx.parseJson ? ctx.parseJson(cursorToString(cur)) : safeParseJson(cursorToString(cur));
      if (parsed === undefined) return emptyCursor();
      base = { kind: 'json', value: parsed };
    }
    if (base.kind !== 'json') return emptyCursor();

    const pathStr = step.selector;
    // JSONPath 里嵌套的 {{ }} 先渲染
    const resolvedPath = pathStr.includes('{{') ? await renderTemplate(pathStr, ctx) : pathStr;
    let value = jsonPath(base.value, resolvedPath);
    value = applyStepIndexToValue(value, step);
    return { kind: 'json', value };
  }

  // ---- 直接取属性 / 文本 ----
  if (step.kind === 'attr') {
    const attr = step.attr;
    let list = cur.kind === 'elements' ? cur.value : null;

    if (!list) {
      // 从原始 HTML / 字符串里取
      if (cur.kind === 'raw' || cur.kind === 'html') {
        const doc = cur.kind === 'html' ? cur.value : parseHtml(String(cur.value ?? ''));
        list = descendants(doc);
      } else if (cur.kind === 'json') {
        // 对 JSON 用 text 取值
        const v = cur.value;
        if (v === undefined || v === null) return emptyCursor();
        return { kind: 'string', value: typeof v === 'string' ? v : String(v) };
      } else if (cur.kind === 'strings' || cur.kind === 'string') {
        return cur;
      } else return emptyCursor();
    }

    list = applyStepIndex(list, step);
    if (step.negative) return emptyCursor();

    const values = list.map((el) => extractFromElement(el, attr, ctx));
    const urlAttr = URL_ATTRS.has(attr) ? { urlAttr: true } : null;
    if (values.length === 1) return { kind: 'string', value: values[0], ...(urlAttr || {}) };
    return { kind: 'strings', value: values, ...(urlAttr || {}) };
  }

  // ---- 直接子元素 ----
  if (step.kind === 'children') {
    const src = cur.kind === 'elements' ? cur.value : cursorToElements(cur);
    let out = [];
    for (const el of src) for (const c of el.children || []) if (c.type === 'element') out.push(c);
    out = applyStepIndex(out, step);
    if (step.negative) out = [];
    return { kind: 'elements', value: out };
  }

  if (step.kind === 'self') return cur;

  // ---- CSS 选择器 ----
  const selector = step.selector;
  if (!selector) return emptyCursor();

  let base = cur;
  if (cur.kind === 'raw') {
    base = { kind: 'html', value: parseHtml(String(cur.value ?? '')) };
  } else if (cur.kind === 'string' || cur.kind === 'strings') {
    // 字符串再走 HTML 步骤：当作 HTML 重新解析（legado 也这么干）
    const raw = cursorToString(cur);
    if (!raw) return emptyCursor();
    base = { kind: 'html', value: parseHtml(raw) };
  } else if (cur.kind === 'json') {
    // JSON 值里取字符串再按 HTML 解析
    const raw = cursorToString(cur);
    if (!raw || raw[0] !== '<') {
      // JSON 里存储的通常是 HTML 片段字符串
      if (!raw) return emptyCursor();
    }
    base = { kind: 'html', value: parseHtml(raw) };
  }

  if (base.kind !== 'elements' && base.kind !== 'html') return emptyCursor();

  let elements;
  if (base.kind === 'html') {
    elements = selectAll(base.value, selector);
  } else {
    elements = ctx.includeSelf === false
      ? base.value.flatMap((el) => selectAll(el, selector))
      : selectWithin(base.value, selector, base.value);
  }

  if (step.negative) {
    const exclude = new Set(elements);
    const source = base.kind === 'elements' ? base.value : descendants(base.value);
    elements = source.filter((e) => !exclude.has(e));
  }

  elements = applyStepIndex(elements, step);
  if (step.reverse) elements = elements.slice().reverse();

  return { kind: 'elements', value: elements };
}

/**
 * 依次应用步骤上的下标。
 * legado 允许「先排除再取下标」的组合写法（例：tag.ul!0:1 = 排除第 0 个 ul，再取第 1 个），
 * 这时不能把两步压成一次切片（!0:1 会算成空），必须按顺序作用两次。
 */
function applyStepIndex(list, step) {
  let out = applyIndex(list, step.index);
  if (step.index2 !== undefined && step.index2 !== null) out = applyIndex(out, step.index2);
  return out;
}

function applyStepIndexToValue(value, step) {
  let v = applyIndexToValue(value, step.index);
  if (step.index2 !== undefined && step.index2 !== null) v = applyIndexToValue(v, step.index2);
  return v;
}

function applyIndexToValue(value, indexSpec) {
  if (!indexSpec || value === undefined || value === null) return value;
  const arr = Array.isArray(value) ? value : [value];
  const picked = applyIndex(arr, indexSpec);
  return picked.length === 1 ? picked[0] : picked;
}

function extractFromElement(el, attr, ctx) {
  switch (attr) {
    case 'text': return textOf(el);
    case 'textnodes': return textNodesOf(el);
    case 'owntext': return ownTextOf(el);
    case 'all': return innerHtml(el);
    case 'html': return innerHtml(el);
    case 'innerhtml': return innerHtml(el);
    case 'outerhtml': return outerHtml(el);
    case 'content': {
      const v = attrOf(el, 'content');
      return v || innerHtml(el);
    }
    default: {
      const v = attrOf(el, attr);
      if (!v) return '';
      // URL 属性先原样返回（legado 语义）：书源里大量存在 `@href##正则` 的写法，
      // 正则必须作用在**原始属性值**上。若提前补成绝对地址，`.*` 之类的正则会
      // 把域名前缀一起吃掉（奇塔小说的目录就是这么变成一条的），绝对化改到最后做。
      if (URL_ATTRS.has(attr)) return v;
      return tidy(v);
    }
  }
}

function safeParseJson(text) {
  const s = String(text ?? '').trim();
  if (!s) return undefined;
  // 常见脏数据：前置 JSONP 包裹 / 尾部多余字符
  const candidates = [s];
  const firstBrace = s.search(/[[{]/);
  if (firstBrace > 0) candidates.push(s.slice(firstBrace));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* 下一个 */ }
    const lastBrace = Math.max(c.lastIndexOf('}'), c.lastIndexOf(']'));
    if (lastBrace > 0) { try { return JSON.parse(c.slice(0, lastBrace + 1)); } catch { /* 下一个 */ } }
  }
  return undefined;
}

/** 应用 ##正则##替换 */
function applyRegexesToCursor(cur, regexes, ctx) {
  if (!regexes.length) return cur;
  const apply = (s) => {
    let out = String(s ?? '');
    for (const [pattern, replacement] of regexes) {
      if (!pattern) continue;
      try {
        const flags = pattern.startsWith('(?i)') ? 'gi' : 'g';
        const p = pattern.startsWith('(?i)') ? pattern.slice(4) : pattern;
        const re = new RegExp(p, flags);
        out = out.replace(re, replacement === undefined || replacement === null ? '' : replacement);
      } catch (err) {
        ctx?.errors?.push('正则无效 [' + pattern + ']: ' + err.message);
      }
    }
    return out;
  };

  if (cur.kind === 'elements') {
    // 元素集合：对每个元素的文本做替换后返回字符串
    return { kind: 'strings', value: cur.value.map((e) => apply(textOf(e))) };
  }
  if (cur.kind === 'strings') return { kind: 'strings', value: cur.value.map(apply), ...(cur.urlAttr ? { urlAttr: true } : {}) };
  if (cur.kind === 'json') {
    const s = cursorToString(cur);
    return { kind: 'string', value: apply(s) };
  }
  return { kind: 'string', value: apply(cursorToString(cur)), ...(cur.urlAttr ? { urlAttr: true } : {}) };
}

/* ============================ 规则求值 ============================ */

async function evalChain(piece, cur, ctx) {
  let main = piece.main;
  // 整条是 {{expr}} → 直接作为 JS 结果
  const whole = /^\{\{([\s\S]*)\}\}$/.exec(main.trim());
  if (whole) {
    const v = await evalJs(whole[1], {
      ...ctx,
      result: cursorToString(cur),
      jsonValue: cur && cur.kind === 'json' ? cur.value : undefined,
    });
    return applyRegexesToCursor({ kind: 'string', value: v }, piece.regexes, ctx);
  }
  const steps = tokenizeSteps(main);
  if (!steps.length) return emptyCursor();

  let c = cur;
  for (const item of steps) {
    let raw = item.raw;
    // 模板 {{ }} 按「步骤」渲染，而不是在整条规则上提前渲染：
    //   · 普通步骤（选择器/属性/JSONPath）里的模板用外层上下文（key/page/baseUrl…）
    //   · 字面量步骤里的模板要留到执行时渲染，因为它常用上一步的 result，
    //     例如 bookUrl: "$.bid\n<js>…</js>\nhttps://…/intro?bookid={{result}}"
    //     提前渲染会把 {{result}} 变成空串（QQ浏览器源的目录取不到就是这个原因）。
    if (item.kind !== 'js' && raw && raw.includes('{{') && parseStep(raw).kind !== 'literal') {
      raw = await renderTemplate(raw, {
        ...ctx,
        jsonValue: c && c.kind === 'json' ? c.value : undefined,
      });
    }
    // <js>…</js> 内联块：整块就是一个 JS 步骤（result = 当前游标字符串）
    const step = item.kind === 'js'
      ? { kind: 'js', selector: item.code, index: null, negative: false, reverse: false }
      : parseStep(raw);
    if (step.unsupported === 'xpath') ctx?.errors?.push('XPath 规则不受支持，已降级为 CSS 选择器: ' + (item.raw || ''));
    c = await applyStep(step, c, ctx, cur);
    if (c.kind === 'empty') break;
  }
  // URL 属性在这一步才补成绝对地址：正则已经作用在原始属性值上了（legado 语义）
  const out = applyRegexesToCursor(c, piece.regexes, ctx);
  if (out.urlAttr) {
    const base = ctx?.pageUrl || ctx?.baseUrl || '';
    const fix = (s) => (String(s || '').trim() ? (absUrl(base, String(s).trim()) || String(s)) : s);
    if (out.kind === 'strings') return { kind: 'strings', value: out.value.map(fix) };
    const { urlAttr, ...rest } = out;
    return { ...rest, value: fix(cursorToString(out)) };
  }
  return out;
}

function interleaveStrings(a, b) {
  const A = String(a), B = String(b);
  const [x, y] = A.length >= B.length ? [A, B] : [B, A];
  let out = '';
  for (let i = 0; i < x.length; i++) {
    out += x[i];
    if (i < y.length) out += y[i];
  }
  return out;
}

/**
 * 求值一条完整规则。
 * @param {string} rule
 * @param {{kind:string,value:*}} content 起始游标
 * @param {object} ctx
 * @returns {Promise<{kind:string,value:*}>}
 */
export async function evalRule(rule, content, ctx = {}) {
  const parsed = parseRule(rule);
  if (parsed.empty) return emptyCursor();

  for (const alt of parsed.alternatives) {
    let altCursor = null;

    for (const cj of alt.conjunctions) {
      let cjCursor = null;

      for (const piece of cj.interleaves) {
        const c = await evalChain(piece, content, ctx);
        if (cjCursor === null) cjCursor = c;
        else if (cj.interleaves.length > 1) {
          cjCursor = { kind: 'string', value: interleaveStrings(cursorToString(cjCursor), cursorToString(c)) };
        } else {
          // && 串联：拼接
          const a = cursorToString(cjCursor);
          const b = cursorToString(c);
          cjCursor = { kind: 'string', value: [a, b].filter(Boolean).join('\n') };
        }
      }

      if (altCursor === null) altCursor = cjCursor || emptyCursor();
      else if (cj !== alt.conjunctions[0] || alt.conjunctions.length > 1) {
        const a = cursorToString(altCursor);
        const b = cursorToString(cjCursor || emptyCursor());
        altCursor = { kind: 'string', value: [a, b].filter(Boolean).join('\n') };
      }
    }

    if (!altCursor) continue;
    if (alt.reverse) {
      if (altCursor.kind === 'elements') altCursor = { kind: 'elements', value: altCursor.value.slice().reverse() };
      else if (altCursor.kind === 'strings') altCursor = { kind: 'strings', value: altCursor.value.slice().reverse() };
    }
    if (alt.negative) {
      if (altCursor.kind === 'elements') altCursor = { kind: 'elements', value: [] };
    }

    if (!isCursorEmpty(altCursor)) return altCursor;
  }
  return emptyCursor();
}

/* ============================ 对外便捷 API ============================ */

/** 构造起始游标 */
export function makeContent(text, forceJson = false) {
  if (text === undefined || text === null) return emptyCursor();
  if (typeof text === 'object') return { kind: 'json', value: text };
  const s = String(text);
  if (forceJson) return { kind: 'json', value: safeParseJson(s) };
  return { kind: 'raw', value: s };
}

/** 求值并返回字符串 */
export async function getString(rule, content, ctx = {}) {
  if (isRuleEmpty(rule)) return '';
  const cur = await evalRule(rule, content, ctx);
  if (cur.kind === 'elements') {
    // 元素型规则取字符串时，多元素用换行连接
    return cur.value.map((e) => textOf(e)).filter(Boolean).join('\n');
  }
  return cursorToString(cur);
}

/** 求值并返回字符串数组 */
export async function getStringList(rule, content, ctx = {}) {
  if (isRuleEmpty(rule)) return [];
  const cur = await evalRule(rule, content, ctx);
  const list = cursorToStrings(cur).map((s) => tidy(s)).filter(Boolean);
  if (list.length === 0) {
    const one = cursorToString(cur);
    return one ? [one] : [];
  }
  return list;
}

/** 求值并返回元素数组 */
export async function getElements(rule, content, ctx = {}) {
  if (isRuleEmpty(rule)) return [];
  const cur = await evalRule(rule, content, ctx);
  return cursorToElements(cur);
}

/** 求值并返回 JSON 值 */
export async function getJson(rule, content, ctx = {}) {
  if (isRuleEmpty(rule)) return undefined;
  const cur = await evalRule(rule, content, ctx);
  if (cur.kind === 'json') return cur.value;
  const s = cursorToString(cur);
  return safeParseJson(s);
}

/** 求值并返回"每一项"的游标（书源里 bookList / chapterList 用） */
export async function getItemCursors(rule, content, ctx = {}) {
  if (isRuleEmpty(rule)) return [];
  const cur = await evalRule(rule, content, ctx);
  if (cur.kind === 'elements') return cur.value.map((el) => ({ kind: 'elements', value: [el] }));
  if (cur.kind === 'json') {
    const v = cur.value;
    if (Array.isArray(v)) return v.map((item) => ({ kind: 'json', value: item }));
    if (v === undefined || v === null) return [];
    return [{ kind: 'json', value: v }];
  }
  if (cur.kind === 'strings') return cur.value.map((s) => ({ kind: 'string', value: s }));
  if (cur.kind === 'string') return [{ kind: 'string', value: cur.value }];
  return [];
}

/** 内容型规则：优先返回 HTML，便于保留段落结构 */
export async function getContentHtml(rule, content, ctx = {}) {
  if (isRuleEmpty(rule)) return '';
  const cur = await evalRule(rule, content, ctx);
  if (cur.kind === 'elements') {
    if (cur.value.length === 1) return innerHtml(cur.value[0]);
    return cur.value.map((e) => outerHtml(e)).join('\n');
  }
  if (cur.kind === 'strings') return cur.value.join('\n');
  if (cur.kind === 'json') return cursorToString(cur);
  return cursorToString(cur);
}

export { safeParseJson, splitTopLevel, findJsBlocks };
