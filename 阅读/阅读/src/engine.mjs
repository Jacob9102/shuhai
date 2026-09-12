/**
 * 书源引擎 —— 把「规则引擎」接到真实站点上：
 * 搜索、书籍详情、目录（含分页目录）、正文（含正文分页）、换源。
 *
 * 所有网络访问都经过 net/http.mjs 的统一限速、Cookie 罐与编码嗅探。
 */

import { makeContent, getString, getStringList, getItemCursors, getContentHtml, evalRule, renderTemplate, cursorToString } from './rule.mjs';
import { evalJs } from './jsbox.mjs';
import { needsTranscode, encodeURIComponentInCharset } from './net/charset.mjs';
import { request, absUrl, CookieJar, HttpError } from './net/http.mjs';
import { cleanContent, countWords } from './content.mjs';
import { normalizeSource } from './source.mjs';
import * as log from './log.mjs';

export class SourceError extends Error {
  constructor(message, code = 'UPSTREAM_ERROR') {
    super(message);
    this.name = 'SourceError';
    this.code = code;
  }
}

const DEFAULT_TIMEOUT = Number(process.env.SHUHAI_TIMEOUT || 15000);
const MAX_TOC_PAGES = Number(process.env.SHUHAI_MAX_TOC_PAGES || 30);
const MAX_CONTENT_PAGES = Number(process.env.SHUHAI_MAX_CONTENT_PAGES || 6);

/** 每个书源一个 Cookie 罐（进程内），保证会话型站点能正常翻页 */
const jars = new Map();
function jarFor(source) {
  const key = String(source?.id ?? source?.url ?? 'anon');
  let j = jars.get(key);
  if (!j) { j = new CookieJar(); jars.set(key, j); }
  return j;
}

export function clearJars() { jars.clear(); }

/* ---------------------------- URL 选项解析 ---------------------------- */

/**
 * 拆分 legado 的「URL + 选项」写法：
 *   https://a.com/s,{"method":"POST","body":"q={{key}}","charset":"gbk"}
 * 选项是非法的就整体当作普通 URL，避免误伤带逗号的正常地址。
 */
export function splitUrlOptions(raw) {
  const s = String(raw ?? '').trim();
  const at = s.lastIndexOf(',{');
  if (at === -1) return { url: s, options: {} };
  const tail = s.slice(at + 1);
  const attempts = [tail, tail.replace(/'/g, '"')];
  for (const a of attempts) {
    try {
      const opts = JSON.parse(a);
      if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
        return { url: s.slice(0, at), options: opts };
      }
    } catch { /* 下一个 */ }
  }
  return { url: s, options: {} };
}

/* ------------------------------ 上下文 ------------------------------ */

function parseVariable(v) {
  const map = new Map();
  if (!v) return map;
  const s = String(v).trim();
  const attempts = [s, s.replace(/'/g, '"')];
  for (const a of attempts) {
    try {
      const o = JSON.parse(a);
      if (o && typeof o === 'object') { for (const k in o) map.set(k, o[k]); return map; }
    } catch { /* 下一个 */ }
  }
  // 老式写法：每行 key=value 或 //key=value
  for (const line of s.split(/\r?\n/)) {
    const m = /^\s*(?:\/\/)?\s*([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
}

function makeCtx(source, extra = {}) {
  const ctx = {
    baseUrl: source.url,
    pageUrl: source.url,
    source,
    jar: jarFor(source),
    vars: parseVariable(source.variable),
    headers: source.header || {},
    jsLib: source.jsLib || '',
    timeout: DEFAULT_TIMEOUT,
    errors: [],
    log: (level, msg) => log.push(level, msg, source.name || source.url),
  };
  return Object.assign(ctx, extra);
}

/* ------------------------------- 请求 ------------------------------- */

function guessContentType(body) {
  const s = String(body || '').trim();
  if (s.startsWith('{') || s.startsWith('[')) return 'application/json;charset=UTF-8';
  return 'application/x-www-form-urlencoded;charset=UTF-8';
}

/**
 * URL 规则可能是动态算出来的（真实书源里很常见）：
 *   searchUrl: "@js:\"https://a.com/s?q={{key}},\"+JSON.stringify({charset:'gbk'})"
 *   searchUrl: "<js>return server + '/api/search?q=' + key;</js>"
 * 这里把它求值成普通字符串，后面照常走「URL + JSON 选项」和 {{ }} 模板处理。
 */
async function resolveUrlRule(raw, ctx) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const block = /^<js>([\s\S]*?)<\/js>$/i.exec(s);
  if (block) {
    const v = await evalJs(block[1], { ...ctx, result: '' });
    return String(v ?? '').trim();
  }
  if (/^@?js:/i.test(s)) {
    const v = await evalJs(s.replace(/^@?js:/i, ''), { ...ctx, result: '' });
    return String(v ?? '').trim();
  }
  return s;
}

/**
 * 递归渲染对象/数组里所有字符串中的 {{ }} 模板。
 * 现代 JSON API 书源（QQ浏览器 / 番茄 / 微信读书那类）的 POST body 常写成对象，
 * 里面还嵌着模板，例如：
 *   "body": { "Scene": "chapter", "ContentAnchorBatch": [{ "BookID": "{{baseUrl.match(/bookId=(\\d+)/)[1]}}", "ChapterSeqNo": [{{$.serialID}}] }] }
 * 只处理字符串 body 的实现会把它变成 "[object Object]" 发出去，接口自然不认。
 */
async function renderDeep(value, ctx) {
  if (typeof value === 'string') return value.includes('{{') ? await renderTemplate(value, ctx) : value;
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) out.push(await renderDeep(v, ctx));
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = await renderDeep(value[k], ctx);
    return out;
  }
  return value;
}

/** header 可以是对象、JSON 字符串，也可以是 @js:/<js> 动态算出来的 */
async function resolveHeaderObject(source, ctx, extra) {
  let h = source.header;
  if (typeof h === 'string' && h.trim()) {
    let s = h.trim();
    const block = /^<js>([\s\S]*?)<\/js>$/i.exec(s);
    if (block) s = String(await evalJs(block[1], { ...ctx, result: '' }) ?? '');
    else if (/^@?js:/i.test(s)) s = String(await evalJs(s.replace(/^@?js:/i, ''), { ...ctx, result: '' }) ?? '');
    else if (s.includes('{{')) s = await renderTemplate(s, ctx);
    h = parseHeaderString(s);
  }
  const out = {};
  if (h && typeof h === 'object') for (const k in h) out[k] = h[k];
  for (const k in (extra || {})) out[k] = extra[k];
  // 过滤掉 JS 求值失败留下的空值/非字符串，避免把非法请求头发出去
  for (const k of Object.keys(out)) {
    if (out[k] === undefined || out[k] === null || out[k] === '') delete out[k];
    else out[k] = String(out[k]);
  }
  return out;
}

/** 解析 header 字符串：标准 JSON、单引号 JSON、每行 Key: Value */
function parseHeaderString(s) {
  const t = String(s ?? '').trim();
  if (!t) return {};
  for (const a of [t, t.replace(/'/g, '"')]) {
    try {
      const o = JSON.parse(a);
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch { /* 下一个 */ }
  }
  const out = {};
  for (const line of t.split(/\r?\n/)) {
    const m = /^\s*["']?([\w-]+)["']?\s*[:=]\s*["']?([^"',]*?)["']?\s*,?\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * 按书源配置发起一次请求。
 * @param {object} source 规范化后的书源
 * @param {string} url 目标地址（可为 URL+选项 形式）
 * @param {object} ctx 规则上下文
 * @param {object} [override] { method, body, charset, headers, timeout }
 */
export async function fetchWithSource(source, url, ctx, override = {}) {
  let rawUrl = await resolveUrlRule(url, ctx);

  // 目标编码：优先 override，其次「URL,{选项}」里的 charset，最后书源自带 charset
  const preOptions = splitUrlOptions(rawUrl).options || {};
  const charset = String(override.charset || preOptions.charset || source.charset || '');

  // 关键字按站点编码做 percent-encoding。
  // GBK 站点用 UTF-8 发关键字会「查得到页面但一条结果都没有」，必须按站点编码发。
  const encodeKey = (s) => (needsTranscode(charset) && ctx.key !== undefined && ctx.key !== null && ctx.key !== ''
    ? String(s).replace(/\{\{\s*key\s*\}\}/g, encodeURIComponentInCharset(ctx.key, charset))
    : String(s));
  rawUrl = encodeKey(rawUrl);

  const { url: plainUrl, options } = splitUrlOptions(rawUrl);

  // 模板渲染必须在 absUrl 之前：URL 路径里的 {{key}} 一旦先过 URL 解析器，
  // 会被 percent-encoding 成 %7B%7Bkey%7D%7D，模板就再也匹配不上了。
  let urlStr = String(plainUrl).trim();
  if (urlStr.includes('{{')) urlStr = await renderTemplate(urlStr, ctx);
  let finalUrl = absUrl(source.url, urlStr);
  if (!finalUrl) throw new SourceError('书源规则没有产生有效地址', 'RULE_ERROR');
  if (finalUrl.includes('{{')) {
    finalUrl = await renderTemplate(finalUrl, ctx);
    finalUrl = absUrl(source.url, finalUrl);
  }

  let body = override.body ?? options.body ?? null;
  if (body !== null && body !== undefined) {
    if (typeof body === 'object') {
      // 对象体：先递归渲染模板，再序列化成 JSON
      body = JSON.stringify(await renderDeep(body, ctx));
    } else if (String(body).includes('{{')) {
      body = await renderTemplate(encodeKey(body), ctx);
    }
  }
  const method = String(override.method || options.method || (body ? 'POST' : 'GET')).toUpperCase();
  const headers = await resolveHeaderObject(source, ctx, { ...(options.headers || {}), ...(override.headers || {}) });
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = guessContentType(body);
  }

  return await request(finalUrl, {
    method,
    body,
    charset,
    headers,
    jar: ctx.jar,
    timeout: override.timeout || options.timeout || ctx.timeout || DEFAULT_TIMEOUT,
    retry: options.retry !== undefined ? Number(options.retry) : 1,
  });
}

/* ------------------------------- 搜索 ------------------------------- */

function pickRule(rules, ...names) {
  for (const n of names) {
    const v = rules?.[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
  }
  return '';
}

/**
 * 按「先算不带 @get 的字段 → 再算带 @get 的字段」的两轮顺序求值。
 *
 * @get 读的是别的字段（常见是 ruleBookInfo.init）用 @put 写进 ctx.vars 的变量，
 * 如果所有字段一起 Promise.all 并行求值，`@get:{u}` 必然读到空值——
 * 这是真实书源里非常常见的写法（例：name 里 @put:{u:"a.0@href"}，bookUrl 里 @get:{u}）。
 */
async function evalFieldGroup(spec, content, ctx) {
  const out = {};
  const keys = Object.keys(spec).filter((k) => spec[k]);
  const dependsOnVars = (k) => String(spec[k]).includes('@get:') || String(spec[k]).includes('@get:');
  for (const pass of [keys.filter((k) => !dependsOnVars(k)), keys.filter(dependsOnVars)]) {
    await Promise.all(pass.map(async (k) => { out[k] = await getString(spec[k], content, ctx); }));
  }
  return out;
}

function toSearchResult(source, fields, pageUrl) {
  const name = String(fields.name || '').trim();
  if (!name) return null;
  const rawBookUrl = String(fields.bookUrl || '').trim();
  // 有些书源的 bookUrl 规则给出的是站内相对路径（例如 /b/229093.html）。
  // 这种值一旦原样入库，点「阅读」就会拿相对地址去请求，必然失败（用户看到的 404 之一）。
  // 只对「明显是路径」的值补全；纯 ID 形式（例如 1159212932）必须原样保留，
  // 那类书源靠自己的 tocUrl 规则去拼完整地址。
  const bookUrl = /^(\.{0,2}\/|\/)/.test(rawBookUrl)
    ? (absUrl(pageUrl, rawBookUrl) || rawBookUrl)
    : rawBookUrl;
  const coverUrl = String(fields.coverUrl || '').trim();
  return {
    key: source.id + '|' + bookUrl,
    sourceId: source.id,
    sourceName: source.name,
    name,
    author: cleanAuthor(fields.author),
    kind: String(fields.kind || '').trim(),
    intro: String(fields.intro || '').trim(),
    coverUrl: absUrl(pageUrl, coverUrl) || coverUrl,
    bookUrl: bookUrl || pageUrl,
    wordCount: String(fields.wordCount || '').trim(),
    lastChapter: String(fields.lastChapter || '').trim(),
    score: 0,
  };
}

/**
 * 从 searchUrl 里取出「第一条搜索地址」。
 *
 * 两种坑：
 *   1. 多行确实可能是「多个搜索地址」，但更常见的是**一个地址被折行了**——
 *      尤其 `路径,{"method":"POST","body":"..."}` 的 JSON 选项经常写成多行，
 *      天真的「取第一行」会把 JSON 截断，请求就发到一个带 `,{` 的假地址上（书书小说就是这么挂的）。
 *   2. `{{ }}` 模板内部也可能换行，同样不能在那里断开。
 */
function firstSearchAddress(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  // 情形 1：整体就是一条「URL,{选项}」（选项可跨行）→ 不按行切
  if (splitUrlOptions(s).url !== s) return s;
  // 情形 2：按行取第一条，但不在 {{ }} 内部断开
  let depth = 0;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{' && s[i + 1] === '{') { depth++; out += '{{'; i++; continue; }
    if (c === '}' && s[i + 1] === '}' && depth > 0) { depth--; out += '}}'; i++; continue; }
    if ((c === '\n' || c === '\r') && depth === 0) break;
    out += c;
  }
  return out.trim();
}

/**
 * 用单个书源搜索。
 * @returns {Promise<{items:object[], elapsed:number, url:string}>}
 */
export async function searchSource(source, keyword, page = 1, opts = {}) {
  if (!source || !source.name) throw new SourceError('书源无效', 'BAD_REQUEST');
  const rules = source.ruleSearch || {};
  const rawSearchUrl = String(source.searchUrl || rules.searchUrl || '').trim();
  if (!rawSearchUrl) throw new SourceError('书源「' + source.name + '」没有配置搜索地址', 'RULE_ERROR');

  const ctx = makeCtx(source, { key: keyword, page: Number(page) || 1, timeout: opts.timeout || DEFAULT_TIMEOUT });
  // searchUrl 可能是 @js:/<js> 动态算出来的，先求值再按「多行 = 多搜索页」取第一条
  const resolvedSearchUrl = await resolveUrlRule(rawSearchUrl, ctx);
  const firstLine = firstSearchAddress(resolvedSearchUrl);
  if (!firstLine) throw new SourceError('书源「' + source.name + '」的搜索地址求值为空', 'RULE_ERROR');
  const started = Date.now();

  const res = await fetchWithSource(source, firstLine, ctx, { timeout: opts.timeout });
  const content = makeContent(res.text);
  ctx.pageUrl = res.finalUrl;

  const bookListRule = pickRule(rules, 'bookList', 'booklist', 'list');
  if (!bookListRule) throw new SourceError('书源「' + source.name + '」没有配置搜索列表规则(bookList)', 'RULE_ERROR');

  const cursors = await getItemCursors(bookListRule, content, ctx);
  const items = [];

  const nameRule = pickRule(rules, 'name', 'bookName');
  const authorRule = pickRule(rules, 'author');
  const kindRule = pickRule(rules, 'kind', 'category', 'class');
  const wordCountRule = pickRule(rules, 'wordCount');
  const lastChapterRule = pickRule(rules, 'lastChapter');
  const introRule = pickRule(rules, 'intro', 'desc', 'description');
  const coverRule = pickRule(rules, 'coverUrl', 'cover');
  const bookUrlRule = pickRule(rules, 'bookUrl', 'url');

  for (const cursor of cursors) {
    if (items.length >= (opts.limit || 60)) break;
    // 字段顺序敏感：name 等字段可能通过 @put 提供 bookUrl 需要的变量
    const f = await evalFieldGroup({
      name: nameRule, author: authorRule, kind: kindRule, wordCount: wordCountRule,
      lastChapter: lastChapterRule, intro: introRule, coverUrl: coverRule, bookUrl: bookUrlRule,
    }, cursor, ctx);
    const item = toSearchResult(source, f, res.finalUrl);
    if (item) items.push(item);
  }

  return { items, elapsed: Date.now() - started, url: res.finalUrl, warnings: ctx.errors };
}

/* ----------------------------- 书籍详情 ----------------------------- */

/**
 * 抓取书籍详情。
 * @returns {Promise<object>} 归一化后的书籍字段
 */
export async function fetchBookInfo(source, bookUrl, opts = {}) {
  const rules = source.ruleBookInfo || {};
  const ctx = makeCtx(source, { timeout: opts.timeout || DEFAULT_TIMEOUT });
  const res = await fetchWithSource(source, bookUrl, ctx, { timeout: opts.timeout });
  ctx.pageUrl = res.finalUrl;
  const content = makeContent(res.text);

  // init 规则（legado 语义）：既用于初始化变量，**它的结果还是后续字段的求值基准**。
  // 现代 JSON API 书源常把信息嵌在 data.bookInfo 里，然后 init 指向它、字段写 $.resourceID 这类相对路径；
  // 忽略 init 的返回值就会像 QQ浏览器源那样「详情全空、目录地址没有 bookId」。
  const initRule = pickRule(rules, 'init');
  let infoBase = content;
  if (initRule) {
    try {
      const initCursor = await evalRule(initRule, content, ctx);
      if (initCursor && initCursor.kind !== 'empty') infoBase = initCursor;
    } catch (err) { log.warn('书源 init 规则执行失败: ' + err.message, source.name); }
  }

  const info = await evalFieldGroup({
    name: pickRule(rules, 'name', 'bookName'),
    author: pickRule(rules, 'author'),
    kind: pickRule(rules, 'kind', 'category'),
    lastChapter: pickRule(rules, 'lastChapter'),
    intro: pickRule(rules, 'intro', 'desc', 'description'),
    coverUrl: pickRule(rules, 'coverUrl', 'cover'),
    tocUrl: pickRule(rules, 'tocUrl', 'catalogUrl', 'chapterUrl'),
    wordCount: pickRule(rules, 'wordCount'),
    status: pickRule(rules, 'status'),
  }, infoBase, ctx);
  const { name, author, kind, lastChapter, intro, coverUrl, tocUrl, wordCount, status } = info;

  return {
    name: (name || '').trim(),
    author: (author || '').trim(),
    kind: (kind || '').trim(),
    lastChapter: (lastChapter || '').trim(),
    intro: (intro || '').trim(),
    cover: absUrl(res.finalUrl, (coverUrl || '').trim()),
    tocUrl: absUrl(res.finalUrl, (tocUrl || '').trim()) || res.finalUrl,
    wordCount: (wordCount || '').trim(),
    status: (status || '').trim(),
    pageUrl: res.finalUrl,
    raw: res.text,
  };
}

/* ------------------------------- 目录 ------------------------------- */

/**
 * 抓取章节目录，自动跟进分页目录（nextTocUrl）。
 * @returns {Promise<{chapters:Array, pages:number, warnings:string[]}>}
 */
export async function fetchToc(source, bookUrl, tocUrl, opts = {}) {
  const rules = source.ruleToc || {};
  const ctx = makeCtx(source, { timeout: opts.timeout || DEFAULT_TIMEOUT });
  const chapterListRule = pickRule(rules, 'chapterList', 'list');
  if (!chapterListRule) {
    throw new SourceError('书源「' + source.name + '」没有配置目录规则(ruleToc.chapterList)', 'RULE_ERROR');
  }

  const nameRule = pickRule(rules, 'chapterName', 'name');
  const urlRule = pickRule(rules, 'chapterUrl', 'url');
  const isVolumeRule = pickRule(rules, 'isVolume');
  const nextTocRule = pickRule(rules, 'nextTocUrl');

  const chapters = [];
  const seenUrls = new Set();
  const warnings = [];
  let currentUrl = tocUrl || bookUrl;
  let pages = 0;

  while (currentUrl && pages < MAX_TOC_PAGES) {
    pages++;
    const res = await fetchWithSource(source, currentUrl, ctx, { timeout: opts.timeout });
    ctx.pageUrl = res.finalUrl;
    const content = makeContent(res.text);

    const cursors = await getItemCursors(chapterListRule, content, ctx);
    if (cursors.length === 0 && pages === 1) {
      warnings.push('目录规则未匹配到任何章节，请检查 chapterList 规则');
    }

    for (const cursor of cursors) {
      const [t, u] = await Promise.all([
        getString(nameRule, cursor, ctx),
        getString(urlRule, cursor, ctx),
      ]);
      const title = String(t || '').trim();
      const url = absUrl(res.finalUrl, String(u || '').trim());
      if (!title) continue;
      // 卷标题（没有链接的分卷行）
      if (!url) {
        chapters.push({ title, url: '', isVolume: true });
        continue;
      }
      const dedupeKey = url;
      if (seenUrls.has(dedupeKey)) continue;
      seenUrls.add(dedupeKey);
      let isVolume = false;
      if (isVolumeRule) {
        const v = await getString(isVolumeRule, cursor, ctx);
        isVolume = /^(true|1|是|yes)$/i.test(String(v).trim());
      }
      chapters.push({ title, url, isVolume });
    }

    // 下一页目录
    if (!nextTocRule) break;
    let next = '';
    try {
      if (nextTocRule.includes('{{') || /^@?js:/.test(nextTocRule)) {
        const rendered = /^\{\{[\s\S]*\}\}$/.test(nextTocRule.trim())
          ? await renderTemplate(nextTocRule, ctx)
          : await getString(nextTocRule, content, ctx);
        next = String(rendered || '').trim();
      } else {
        next = String(await getString(nextTocRule, content, ctx) || '').trim();
      }
    } catch (err) {
      warnings.push('nextTocUrl 解析失败: ' + err.message);
      break;
    }
    if (!next) break;
    const nextAbs = absUrl(res.finalUrl, next);
    if (!nextAbs || nextAbs === currentUrl || seenUrls.has('TOC:' + nextAbs)) break;
    seenUrls.add('TOC:' + nextAbs);
    currentUrl = nextAbs;
  }

  // 去掉纯卷标题导致的重复：若某卷标题与其后章节同名则丢弃
  return { chapters, pages, warnings };
}

/* ------------------------------- 正文 ------------------------------- */

/**
 * 抓取并清洗正文。
 * @returns {Promise<{content:string, title:string, words:number, pages:number, warnings:string[]}>}
 */
export async function fetchContent(source, chapterUrl, { book = null, chapter = null, opts = {} } = {}) {
  const rules = source.ruleContent || {};
  const ctx = makeCtx(source, {
    book: book || {},
    chapter: chapter || {},
    timeout: opts.timeout || DEFAULT_TIMEOUT,
  });
  const contentRule = pickRule(rules, 'content', 'text');
  if (!contentRule) {
    throw new SourceError('书源「' + source.name + '」没有配置正文规则(ruleContent.content)', 'RULE_ERROR');
  }

  const replaceRegex = pickRule(rules, 'replaceRegex');
  const nextContentRule = pickRule(rules, 'nextContentUrl');

  let pieces = [];
  let currentUrl = chapterUrl;
  let pages = 0;
  let firstPageUrl = chapterUrl;
  let extractedTitle = '';
  const warnings = [];
  const visited = new Set();

  while (currentUrl && pages < MAX_CONTENT_PAGES) {
    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);
    pages++;

    const res = await fetchWithSource(source, currentUrl, ctx, { timeout: opts.timeout });
    ctx.pageUrl = res.finalUrl;
    if (pages === 1) firstPageUrl = res.finalUrl;
    const content = makeContent(res.text);

    let html;
    try {
      html = await getContentHtml(contentRule, content, ctx);
    } catch (err) {
      warnings.push('正文规则求值失败: ' + err.message);
      html = '';
    }

    if (!extractedTitle) {
      // 有些源的正文规则里含标题，用 textNodes 首行猜一下
      const t = await getString(pickRule(rules, 'title', 'chapterName'), content, ctx).catch(() => '');
      extractedTitle = String(t || '').trim();
    }

    if (html && html.trim()) pieces.push(html);

    if (!nextContentRule) break;
    let next = '';
    try {
      next = String(await getString(nextContentRule, content, ctx) || '').trim();
    } catch (err) {
      warnings.push('nextContentUrl 解析失败: ' + err.message);
      break;
    }
    if (!next) break;
    const nextAbs = absUrl(res.finalUrl, next);
    if (!nextAbs) break;
    currentUrl = nextAbs;
  }

  if (pieces.length === 0) {
    throw new SourceError('正文规则未匹配到内容（可能是站点结构变化或需要登录）', 'RULE_ERROR');
  }

  const aliases = [chapter?.title, extractedTitle, book?.name].filter(Boolean);
  const text = cleanContent(pieces.join('\n'), { replaceRegex, titleAliases: aliases });

  if (!text.trim()) {
    throw new SourceError('正文清洗后为空，可能被站点反爬或规则失效', 'RULE_ERROR');
  }

  return {
    content: text,
    title: extractedTitle,
    words: countWords(text),
    pages,
    url: firstPageUrl,
    warnings,
  };
}

/* --------------------------- 并发调度工具 --------------------------- */

/** 限制并发的 map */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(Math.max(1, limit), items.length)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 并发搜索多个书源。
 * @param {object[]} sources
 * @param {string} keyword
 * @param {{page?:number, timeout?:number, concurrency?:number, limit?:number}} opts
 * @returns {Promise<{results:Array<{source:object, ok:boolean, items:object[], elapsed:number, error:string}>, took:number}>}
 */
export async function searchAll(sources, keyword, opts = {}) {
  const started = Date.now();
  const concurrency = opts.concurrency || Number(process.env.SHUHAI_SEARCH_CONCURRENCY || 16);

  const results = await mapLimit(sources, concurrency, async (source) => {
    const t0 = Date.now();
    try {
      const r = await searchSource(source, keyword, opts.page || 1, opts);
      return { source, ok: true, items: r.items, elapsed: r.elapsed, error: '' };
    } catch (err) {
      log.warn('搜索失败 [' + source.name + ']: ' + err.message);
      return { source, ok: false, items: [], elapsed: Date.now() - t0, error: err.message, code: err.code || 'UPSTREAM_ERROR' };
    }
  });

  return { results, took: Date.now() - started };
}

/**
 * 流式搜索：每完成一个书源就通过 onSource 回调推送，供 SSE 使用。
 */
export async function searchAllStream(sources, keyword, opts = {}, onSource = async () => {}) {
  const started = Date.now();
  const concurrency = opts.concurrency || Number(process.env.SHUHAI_SEARCH_CONCURRENCY || 16);
  let done = 0;

  await mapLimit(sources, concurrency, async (source) => {
    const t0 = Date.now();
    let payload;
    try {
      const r = await searchSource(source, keyword, opts.page || 1, opts);
      payload = { sourceId: source.id, sourceName: source.name, ok: true, count: r.items.length, elapsed: r.elapsed, error: '', items: r.items };
    } catch (err) {
      log.warn('搜索失败 [' + source.name + ']: ' + err.message);
      payload = { sourceId: source.id, sourceName: source.name, ok: false, count: 0, elapsed: Date.now() - t0, error: err.message, items: [] };
    }
    done++;
    payload.progress = { done, total: sources.length };
    try { await onSource(payload); } catch { /* 客户端断开，忽略 */ }
  });

  return { took: Date.now() - started, total: sources.length };
}

/* ------------------------------ 换源 ------------------------------ */

/**
 * 相关度打分：用于聚合搜索结果排序与换源匹配。
 * 完全同名 100 分，包含关系次之，作者相同加权。
 */
/**
 * 搜索关键字归一化：全角转半角、去掉空白与常见标点、转小写。
 * 用于「精确搜索」的比对——用户输「斗破苍穹」时不应该匹配到「斗破苍穹之秋雨」。
 */
export function normalizeKeyword(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000《》<>【】\[\]()（）［］{}:：·.,，、!！?？'"“”‘’\-_—/\\|~]/g, '')
    .toLowerCase();
}

/**
 * 精确匹配判定。
 * @param {object} item 搜索结果
 * @param {string} query 关键字
 * @param {'all'|'name'|'author'} type
 */
export function isExactMatch(item, query, type = 'all') {
  const q = normalizeKeyword(query);
  if (!q) return true;
  const name = normalizeKeyword(item.name);
  const author = normalizeKeyword(item.author);
  if (type === 'author') return author === q;
  if (type === 'name') return name === q;
  return name === q || author === q;
}

export function scoreMatch(candidate, target) {
  const norm = normalizeKeyword;
  const cn = norm(candidate.name);
  const tn = norm(target.name);
  const ca = norm(candidate.author);
  const ta = norm(target.author);

  let score = 0;
  if (cn && tn) {
    if (cn === tn) score += 70;
    else if (cn.includes(tn) || tn.includes(cn)) score += 48;
    else {
      // 字符重合率
      const set = new Set(tn.split(''));
      let hit = 0;
      for (const ch of cn) if (set.has(ch)) hit++;
      score += Math.round(30 * (hit / Math.max(tn.length, 1)));
    }
  }
  if (ca && ta) {
    if (ca === ta) score += 25;
    else if (ca.includes(ta) || ta.includes(ca)) score += 12;
  }
  if (candidate.coverUrl) score += 3;
  if (candidate.intro) score += 2;
  return Math.max(0, Math.min(100, score));
}

/**
 * 作者字段清洗。
 * 各书源的 author 规则五花八门，常见脏数据：`作者：天蚕土豆`、`天蚕土豆 著`、
 * 换行里还夹着漫画改编组……不清掉的话「同一本书」会因为作者字符串不同而无法合并。
 */
export function cleanAuthor(raw) {
  return String(raw || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/^\s*作\s*者\s*[:：]\s*/, '')
    .replace(/^\s*著\s*者\s*[:：]\s*/, '')
    .replace(/\s*[著作]$/, '')
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
}

/** 书名归一化：去掉《》〈〉「」等包裹与空白，用于聚合键 */
export function normalizeBookName(raw) {
  return String(raw || '')
    .replace(/[《》〈〉「」『』【】\[\]]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase();
}

/** 聚合去重：同名同作者的多来源合并，保留得分最高的作为主来源 */
export function aggregateResults(items, { dedupe = true } = {}) {
  if (!dedupe) return items.map((i) => ({ ...i, origins: [i] }));

  // 先按「归一化书名」分组，再在组内按作者兼容性合并。
  // 只用 name+author 做键是不够的：各书源的作者字段写法差异很大
  // （`天蚕土豆` / `作者：天蚕土豆` / `天蚕土豆 著` / 空），
  // 结果同一本书会被列成好几条——这正是用户抱怨的「同一本书刷屏」。
  const byName = new Map();
  for (const it of items) {
    const nk = normalizeBookName(it.name);
    if (!nk) continue;
    if (!byName.has(nk)) byName.set(nk, []);
    byName.get(nk).push(it);
  }

  const out = [];
  for (const list of byName.values()) {
    const groups = [];
    for (const it of list) {
      const ak = normalizeKeyword(cleanAuthor(it.author));
      let g = groups.find((x) => sameAuthor(x.key, ak));
      if (!g) { g = { key: ak, items: [] }; groups.push(g); }
      if (!g.key && ak) g.key = ak;
      g.items.push(it);
    }
    for (const g of groups) out.push(buildAggEntry(g.items));
  }
  return out;
}

/** 作者是否算同一人：任一方为空、互为子串（「天蚕土豆」vs「天蚕土豆 漫画组」）都算 */
function sameAuthor(a, b) {
  if (!a || !b) return true;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

/** 同一本书的多个来源合成一条，选信息最全的作代表 */
function buildAggEntry(list) {
  const richness = (x) => (x.intro ? 1 : 0) + (x.coverUrl ? 1 : 0) + (x.lastChapter ? 1 : 0) + (x.kind ? 1 : 0);
  let rep = list[0];
  for (const it of list) if (richness(it) > richness(rep)) rep = it;
  return { ...rep, origins: list };
}

/* ------------------------------ 榜单 / 分类发现 ------------------------------ */

/**
 * 解析 legado 的 exploreUrl。真实世界里有三种写法：
 *   1. JSON 数组：[{"title":"玄幻","url":"/list/1"}, ...]
 *   2. 每行一条：标题::地址
 *   3. 单个地址（无分组名）
 * @returns {Array<{title:string,url:string}>}
 */
export function parseExploreGroups(exploreUrl) {
  const s = String(exploreUrl || '').trim();
  if (!s) return [];

  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) {
      return arr
        .map((x) => ({ title: String(x?.title ?? x?.name ?? '').trim(), url: String(x?.url ?? '').trim() }))
        .filter((g) => g.url);
    }
  } catch { /* 不是 JSON，走行格式 */ }

  const out = [];
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = /^(.*?)::(.*)$/.exec(t);
    if (m && m[2].trim()) out.push({ title: m[1].trim() || '分类', url: m[2].trim() });
    else out.push({ title: '分类', url: t });
  }
  return out;
}

/**
 * 抓取一个分类分组的书单。
 * 优先用 ruleExplore 的字段规则，缺失时回退到 ruleSearch 的同名字段
 * —— 这是社区里很常见的书源写法。
 */
export async function fetchExploreGroup(source, group, opts = {}) {
  const exploreRules = source.ruleExplore || {};
  const searchRules = source.ruleSearch || {};
  const ctx = makeCtx(source, { page: opts.page || 1, timeout: opts.timeout || DEFAULT_TIMEOUT });

  const bookListRule = pickRule(exploreRules, 'bookList') || pickRule(searchRules, 'bookList');
  if (!bookListRule) throw new SourceError('书源「' + source.name + '」没有配置列表规则', 'RULE_ERROR');

  const res = await fetchWithSource(source, group.url, ctx, { timeout: opts.timeout });
  ctx.pageUrl = res.finalUrl;
  const content = makeContent(res.text);

  const cursors = await getItemCursors(bookListRule, content, ctx);
  const field = (name) => pickRule(exploreRules, name) || pickRule(searchRules, name);

  const fieldRules = {
    name: field('name') || field('bookName'),
    author: field('author'),
    kind: field('kind') || field('category'),
    wordCount: field('wordCount'),
    lastChapter: field('lastChapter'),
    intro: field('intro'),
    coverUrl: field('coverUrl') || field('cover'),
    bookUrl: field('bookUrl') || field('url'),
  };

  const items = [];
  for (const cursor of cursors) {
    if (items.length >= (opts.limit || 30)) break;
    const [n, a, k, w, l, i, c, u] = await Promise.all([
      getString(fieldRules.name, cursor, ctx),
      getString(fieldRules.author, cursor, ctx),
      getString(fieldRules.kind, cursor, ctx),
      getString(fieldRules.wordCount, cursor, ctx),
      getString(fieldRules.lastChapter, cursor, ctx),
      getString(fieldRules.intro, cursor, ctx),
      getString(fieldRules.coverUrl, cursor, ctx),
      getString(fieldRules.bookUrl, cursor, ctx),
    ]);
    const item = toSearchResult(source, {
      name: n, author: a, kind: k, wordCount: w, lastChapter: l, intro: i, coverUrl: c, bookUrl: u,
    }, res.finalUrl);
    if (item) items.push(item);
  }
  return { group: group.title, items, url: res.finalUrl };
}

/**
 * 聚合多个书源的榜单。任何一个源失败都只跳过它，不影响整体。
 */
export async function fetchExplore(sources, opts = {}) {
  const maxSources = opts.maxSources || 6;
  const maxGroups = opts.maxGroupsPerSource || 3;
  const picked = [];
  for (const s of sources) {
    const groups = parseExploreGroups(s.exploreUrl);
    if (groups.length) picked.push({ source: s, groups: groups.slice(0, maxGroups) });
    if (picked.length >= maxSources) break;
  }

  const tasks = [];
  for (const { source, groups } of picked) {
    for (const g of groups) tasks.push({ source, group: g });
  }

  const results = await mapLimit(tasks, opts.concurrency || 6, async ({ source, group }) => {
    try {
      const r = await fetchExploreGroup(source, group, { timeout: opts.timeout, limit: opts.limit || 20 });
      return { sourceId: source.id, sourceName: source.name, title: r.group, items: r.items, ok: true, error: '' };
    } catch (err) {
      log.warn('榜单抓取失败 [' + source.name + '/' + group.title + ']: ' + err.message);
      return { sourceId: source.id, sourceName: source.name, title: group.title, items: [], ok: false, error: err.message };
    }
  });

  return results.filter((r) => r.ok && r.items.length > 0);
}

