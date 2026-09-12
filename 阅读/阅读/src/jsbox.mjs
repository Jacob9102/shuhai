/**
 * 书源 JS 沙箱 —— 让 legado 书源里的 {{ }} 与 @js: 表达式能够运行。
 *
 * 难点：legado 的 \`java.ajax(url)\` 是**同步**的，而 Node 的网络请求是异步的。
 * 解法是「两遍求值」：
 *   第一遍：用一个只记录 URL、返回空串的假 ajax 跑一次表达式，收集所有要请求的地址；
 *   第二遍：并发把这些地址取回来放进缓存，再用同步读缓存的真 ajax 跑第二遍。
 * 对绝大多数真实书源（URL 由字面量或简单拼接构成）这套方案完全等价。
 *
 * 安全：使用 node:vm 新建上下文，沙箱内不存在 process / require / global，
 * 且带执行超时。书源来自用户自己导入，但仍按「不可信代码」处理。
 *
 * 注意：vm 不是安全边界。本服务只应部署在可信内网，且只导入可信来源的书源。
 */

import vm from 'node:vm';
import crypto from 'node:crypto';
import { request, absUrl } from './net/http.mjs';
import { parseHtml, textOf, ownTextOf, attrOf, innerHtml, outerHtml } from './html/parser.mjs';
import { selectAll, selectFirst } from './html/selector.mjs';

const JS_TIMEOUT_MS = Number(process.env.SHUHAI_JS_TIMEOUT || 3000);
const MAX_AJAX_PER_EVAL = Number(process.env.SHUHAI_JS_MAX_AJAX || 8);

/* --------------------------- legado java.* 兼容 --------------------------- */

function b64encode(s) {
  const str = String(s ?? '');
  return Buffer.from(str, 'utf8').toString('base64');
}

function b64decode(s) {
  const str = String(s ?? '').replace(/\s+/g, '');
  if (!str) return '';
  // legado 的 base64Decode 按 UTF-8 还原；容错处理非法输入
  try { return Buffer.from(str, 'base64').toString('utf8'); }
  catch { return ''; }
}

function hexDecode(s) {
  const str = String(s ?? '').replace(/[^0-9a-fA-F]/g, '');
  try { return Buffer.from(str, 'hex').toString('utf8'); } catch { return ''; }
}

function hexEncode(s) {
  return Buffer.from(String(s ?? ''), 'utf8').toString('hex');
}

function timeFormat(ts, fmt) {
  const d = ts ? new Date(Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts)) : new Date();
  if (Number.isNaN(d.getTime())) return String(ts ?? '');
  const p = (n) => String(n).padStart(2, '0');
  const f = fmt || 'yyyy/MM/dd HH:mm';
  return f
    .replace(/yyyy/g, d.getFullYear())
    .replace(/MM/g, p(d.getMonth() + 1))
    .replace(/dd/g, p(d.getDate()))
    .replace(/HH/g, p(d.getHours()))
    .replace(/mm/g, p(d.getMinutes()))
    .replace(/ss/g, p(d.getSeconds()));
}

/** 把 legado 的 URL 选项 \`url,{...}\` 拆开 */
function toRequestOptions(urlWithOpts, ctx) {
  let url = String(urlWithOpts || '').trim();
  let opts = {};
  const at = url.lastIndexOf(',{');
  if (at !== -1) {
    try {
      const parsed = JSON.parse(url.slice(at + 1));
      if (parsed && typeof parsed === 'object') { opts = parsed; url = url.slice(0, at); }
    } catch { /* 不是选项，保持原样 */ }
  }
  const headers = {};
  for (const k in (ctx?.headers || {})) headers[k] = ctx.headers[k];
  if (opts.headers && typeof opts.headers === 'object') for (const k in opts.headers) headers[k] = opts.headers[k];
  return {
    url,
    method: (opts.method || 'GET').toUpperCase(),
    body: opts.body ?? null,
    charset: opts.charset || '',
    headers,
  };
}

/**
 * 构造一个 java 兼容对象。
 * @param {object} ctx 规则上下文
 * @param {Map<string,string>} cache 预取到的 URL -> 响应文本
 * @param {string[]} collector 第一遍收集到的待请求 URL
 */
function makeJava(ctx, cache, collector) {
  const vars = ctx.vars || (ctx.vars = new Map());

  const ajax = (urlWithOpts) => {
    const { url } = toRequestOptions(urlWithOpts, ctx);
    if (cache && cache.has(url)) return cache.get(url);
    if (collector) {
      collector.push(url);
      return '';
    }
    // 缓存缺失：返回空串而不是抛错，避免整条规则链崩掉
    ctx.log?.('warn', 'js 中 java.ajax 未预取到结果: ' + url);
    return '';
  };

  return {
    ajax,
    connect: ajax,
    head: ajax,
    post: (url, body) => ajax(url + (String(url).includes(',{') ? '' : ',{"method":"POST","body":' + JSON.stringify(String(body ?? '')) + '}')),
    ajaxAll: (urls) => (Array.isArray(urls) ? urls : [urls]).map((u) => ajax(u)),
    base64Encode: b64encode,
    base64Decode: b64decode,
    base64DecodeArray: (s) => Array.from(Buffer.from(String(s || '').replace(/\s+/g, ''), 'base64')),
    hexDecodeToString: hexDecode,
    hexEncodeToString: hexEncode,
    digestHex: (algo, s) => { try { return crypto.createHash(String(algo).replace('-', '').toLowerCase()).update(String(s ?? ''), 'utf8').digest('hex'); } catch { return ''; } },
    md5Encode: (s) => crypto.createHash('md5').update(String(s ?? ''), 'utf8').digest('hex'),
    md5: (s) => crypto.createHash('md5').update(String(s ?? ''), 'utf8').digest('hex'),
    sha1Encode: (s) => crypto.createHash('sha1').update(String(s ?? ''), 'utf8').digest('hex'),
    sha256Encode: (s) => crypto.createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex'),
    encodeURI: (s) => encodeURI(String(s ?? '')),
    timeFormat,
    randomUUID: () => crypto.randomUUID(),
    androidId: () => crypto.createHash('md5').update(String(ctx.source?.url || 'shuhai')).digest('hex').slice(0, 16),
    log: (m) => ctx.log?.('info', String(m)),
    toast: (m) => ctx.log?.('info', String(m)),
    longToast: (m) => ctx.log?.('info', String(m)),
    getString: (k) => (vars.get(String(k)) ?? ''),
    put: (k, v) => { vars.set(String(k), v); return v; },
    setContent: () => {},
    // 以下三个是书源 header/规则里常见的调用，给个合理默认值，避免整条规则链因报错中断
    getWebViewUA: () => 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    startBrowser: () => '',
    startBrowserAwait: async () => '',
    getCookie: (u) => (ctx.jar ? ctx.jar.header(absolute(u, ctx)) : ''),
    setCookie: (u, v) => { try { ctx.jar?.set(absolute(u, ctx), String(v ?? '')); } catch { /* 忽略 */ } return ''; },
    removeCookie: (u) => { try { ctx.jar?.set(absolute(u, ctx), ''); } catch { /* 忽略 */ } return ''; },
    refreshTocUrl: () => '',
    reLoginView: () => '',
    openUrl: () => '',
  };
}

/** 把可能相对的地址补成绝对地址（书源里 java.getCookie('/x') 这种写法很常见） */
function absolute(u, ctx) {
  const s = String(u ?? '').trim();
  if (!s) return String(ctx?.baseUrl || '');
  return /^https?:\/\//i.test(s) ? s : (absUrl(String(ctx?.baseUrl || ''), s) || s);
}

/**
 * 组装 java 对象。
 * legado 里 `java.get(x)` 有歧义：x 是 URL 时是网络请求，否则是读变量。
 * 社区通行做法是用「长得像不像 URL」来区分，这里沿用。
 */
function buildJava(ctx, cache, collector) {
  const j = makeJava(ctx, cache, collector);
  const vars = ctx.vars || (ctx.vars = new Map());
  const rawAjax = j.ajax;
  j.get = (arg) => {
    const a = String(arg ?? '');
    if (a === '') return '';
    if (/^https?:\/\//i.test(a)) return rawAjax(a);
    return vars.get(a) ?? '';
  };
  return j;
}

/* --------------------------- org.jsoup 最小实现 --------------------------- */

/** 把解析出来的节点包装成 Jsoup Element 的常用方法 */
function jsoupElement(node) {
  return {
    node,
    attr: (n) => attrOf(node, String(n)) || '',
    hasAttr: (n) => !!attrOf(node, String(n)),
    text: () => textOf(node),
    ownText: () => ownTextOf(node),
    html: () => innerHtml(node),
    outerHtml: () => outerHtml(node),
    tagName: () => String(node.tagName || ''),
    id: () => attrOf(node, 'id') || '',
    className: () => attrOf(node, 'class') || '',
    select: (sel) => jsoupSelection(selectAll(node, String(sel))),
    children: () => jsoupSelection(selectAll(node, '> *')),
    toString: () => outerHtml(node),
  };
}

/** Jsoup Elements 集合 */
function jsoupSelection(nodes) {
  const list = nodes.map(jsoupElement);
  return {
    size: () => list.length,
    length: list.length,
    isEmpty: () => list.length === 0,
    get: (i) => list[Number(i)] || null,
    first: () => list[0] || null,
    last: () => list[list.length - 1] || null,
    attr: (n) => (list[0] ? list[0].attr(n) : ''),
    text: () => list.map((e) => e.text()).join(' '),
    eachText: () => list.map((e) => e.text()),
    html: () => (list[0] ? list[0].html() : ''),
    outerHtml: () => (list[0] ? list[0].outerHtml() : ''),
    val: () => (list[0] ? list[0].attr('value') : ''),
    toArray: () => list,
    toString: () => list.map((e) => e.outerHtml()).join(''),
    [Symbol.iterator]: function* iter() { yield* list; },
  };
}

/** org.jsoup.Jsoup.parse(html) → Document（够书源用的子集） */
function jsoupParse(html) {
  const root = parseHtml(String(html ?? ''));
  return {
    select: (sel) => jsoupSelection(selectAll(root, String(sel))),
    getElementsByTag: (t) => jsoupSelection(selectAll(root, String(t))),
    getElementById: (id) => {
      const n = selectFirst(root, '#' + String(id));
      return n ? jsoupElement(n) : null;
    },
    title: () => {
      const n = selectFirst(root, 'title');
      return n ? textOf(n) : '';
    },
    text: () => textOf(root),
    html: () => innerHtml(root),
    outerHtml: () => outerHtml(root),
    body: () => jsoupSelection(selectAll(root, 'body')),
    head: () => jsoupSelection(selectAll(root, 'head')),
    toString: () => outerHtml(root),
  };
}

/* ------------------------------- 沙箱构造 ------------------------------- */

function buildSandbox(ctx, java) {
  const sourceRaw = ctx.source || {};
  const sourceUrl = String(sourceRaw.url || sourceRaw.bookSourceUrl || '');
  const source = {
    // legado 的 Source 对象是「属性 + 方法」混用：source.key / source.name 和 source.getKey() 都有源在用
    ...sourceRaw,
    key: sourceUrl,
    url: sourceUrl,
    getKey: () => sourceUrl,
    getName: () => String(sourceRaw.name || sourceRaw.bookSourceName || ''),
    getUrl: () => sourceUrl,
    getVariable: (k) => (ctx.vars?.get(String(k)) ?? ''),
    setVariable: (k, v) => { ctx.vars?.set(String(k), v); return ''; },
    getTag: () => String(sourceRaw.group || ''),
    getLoginInfo: () => ({}),
  };

  // legado 的 cookie 是对象（getCookie/setCookie/removeCookie），但历史模板里有 {{cookie}}
  // 直接当字符串用的写法，所以这里做成「对象 + toString/valueOf 返回当前 Cookie 头」的混合体。
  const jar = ctx.jar || null;
  const cookieUrl = (u) => {
    const s = String(u ?? '').trim();
    if (!s) return String(ctx.baseUrl || '');
    return /^https?:\/\//i.test(s) ? s : absUrl(String(ctx.baseUrl || ''), s) || s;
  };
  const cookieCurrent = () => (jar ? jar.header(String(ctx.baseUrl || '')) : '');
  const cookie = {
    getCookie: (u) => (jar ? jar.header(cookieUrl(u)) : ''),
    setCookie: (u, v) => { try { jar?.set(cookieUrl(u), String(v ?? '')); } catch { /* 忽略 */ } return ''; },
    replaceCookie: (u, v) => { try { jar?.set(cookieUrl(u), String(v ?? '')); } catch { /* 忽略 */ } return ''; },
    removeCookie: (u) => { try { jar?.set(cookieUrl(u), ''); } catch { /* 忽略 */ } return ''; },
    toString: cookieCurrent,
    valueOf: cookieCurrent,
  };

  const g = new Proxy({}, {
    get: (_, k) => (ctx.vars ? ctx.vars.get(String(k)) : undefined),
    set: (_, k, v) => { ctx.vars?.set(String(k), v); return true; },
    has: (_, k) => (ctx.vars ? ctx.vars.has(String(k)) : false),
  });

  return {
    java,
    source,
    org: { jsoup: { Jsoup: { parse: jsoupParse, connect: (u) => jsoupParse(java.ajax(String(u))) } } },
    book: ctx.book || {},
    chapter: ctx.chapter || {},
    baseUrl: String(ctx.baseUrl || ''),
    key: ctx.key ?? '',
    page: ctx.page ?? 1,
    cookie,
    result: ctx.result ?? '',
    // legado 里 {{$.xxx}} 的 $ 指向「当前对象」（JSON 接口书源的字段基本都是这么写的）
    $: ctx.jsonValue !== undefined && ctx.jsonValue !== null ? ctx.jsonValue : {},
    g,
    // 标准库（只暴露无副作用的部分）
    JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp, Error,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    escape, unescape,
    console: { log: (...a) => ctx.log?.('info', a.map(String).join(' ')) },
  };
}

function compile(code, libPrefix = '') {
  const head = libPrefix ? libPrefix + '\n;' : '';
  // 1) 先当作表达式（最常见：{{ $.data.name }}）
  try {
    return new vm.Script('(function(){ "use strict";\n' + head + 'return (' + code + '); })()', { filename: 'booksource.js' });
  } catch { /* 落到下一档 */ }

  // 2) 语句块：legado 的 <js>/@js: 块大多是「一串语句，最后一行是结果表达式」，
  //    例如 bookList 里的 String(result).replace(/<!--|-->/g, "") —— 没有 return。
  //    这种写法按表达式编译会失败，直接当语句执行又会返回 undefined，所以把最后一条语句改写成 return。
  //    注意先去掉结尾的分号/空行/注释，否则「最后一条语句」会被判成空串而匹配失败。
  const body = String(code)
    .replace(/\s*\/\/[^\n]*$/, '')   // 去掉结尾的行注释（可能跟在代码后面）
    .replace(/\s*\/\*[\s\S]*?\*\/\s*$/, '') // 去掉结尾的块注释
    .replace(/[;\s]+$/, '');        // 去掉结尾分号/空行
  if (body.trim()) {
    const tail = /([\s\S]*?)([^\s;][^;]*)$/.exec(body);
    if (tail) {
      try {
        return new vm.Script(
          '(function(){ "use strict";\n' + head + tail[1] + '\nreturn (' + tail[2] + '); })()',
          { filename: 'booksource.js' },
        );
      } catch { /* 最后一条不是表达式（if/for/声明），退回语句块 */ }
    }
  }

  // 3) 纯语句块
  return new vm.Script('(function(){ "use strict";\n' + head + code + '\n})()', { filename: 'booksource.js' });
}

export function stringifyResult(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/* ------------------------------- 对外接口 ------------------------------- */

/**
 * 求值一段书源 JS 表达式，返回**原始值**（数组/对象不做字符串化）。
 *
 * 规则引擎的 js 步骤必须用它：`@onclick@js:result.match(/.../)[1]` 这类写法的
 * 尾部下标要作用在 JS 返回的真数组上；若先 JSON 字符串化，下标就再也取不到了。
 *
 * @param {string} code   JS 源码（不含 {{ }} 包裹）
 * @param {object} ctx    规则上下文
 * @returns {Promise<unknown>} 求值结果；出错返回 ''（并把错误写进 ctx.errors）
 */
export async function evalJsRaw(code, ctx = {}) {
  if (!code || !String(code).trim()) return '';
  const src = String(code);

  let script;
  // 书源的 jsLib 作为前置库注入，让自定义函数在表达式里可用
  const lib = ctx && ctx.jsLib ? String(ctx.jsLib) : '';
  try { script = compile(src, lib); }
  catch (err) {
    ctx.errors?.push('JS 语法错误: ' + err.message + ' @ ' + src.slice(0, 120));
    return '';
  }

  // ---- 第一遍：收集 ajax 目标 ----
  const collector = [];
  let firstResult = '';
  try {
    const sandbox = buildSandbox(ctx, buildJava(ctx, new Map(), collector));
    firstResult = script.runInNewContext(sandbox, { timeout: JS_TIMEOUT_MS });
  } catch (err) {
    // 第一遍失败通常是因为 ajax 返回空串导致后续解析异常，属预期，继续预取
    ctx.log?.('debug', 'js 第一遍求值异常（通常可忽略）: ' + err.message);
  }

  const targets = [...new Set(collector.filter((u) => /^https?:\/\//i.test(u)))].slice(0, MAX_AJAX_PER_EVAL);
  if (targets.length === 0) return firstResult;

  // ---- 并发预取 ----
  const cache = new Map();
  await Promise.all(targets.map(async (rawUrl) => {
    const { url, method, body, charset, headers } = toRequestOptions(rawUrl, ctx);
    try {
      const res = await request(url, {
        method, body, charset, headers,
        jar: ctx.jar,
        timeout: ctx.timeout || 15000,
        retry: 0,
      });
      cache.set(rawUrl, res.text);
      cache.set(url, res.text);
    } catch (err) {
      cache.set(rawUrl, '');
      cache.set(url, '');
      ctx.errors?.push('js ajax 失败: ' + url + ' -> ' + err.message);
    }
  }));

  // ---- 第二遍：带缓存真求值 ----
  try {
    const sandbox = buildSandbox(ctx, buildJava(ctx, cache, null));
    return script.runInNewContext(sandbox, { timeout: JS_TIMEOUT_MS });
  } catch (err) {
    ctx.errors?.push('JS 运行错误: ' + err.message + ' @ ' + src.slice(0, 120));
    return firstResult;
  }
}

/** 求值并把结果字符串化（`{{ }}` 模板与 `@js:` 无下标时的默认行为） */
export async function evalJs(code, ctx = {}) {
  return stringifyResult(await evalJsRaw(code, ctx));
}
