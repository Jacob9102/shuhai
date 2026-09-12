#!/usr/bin/env node
/**
 * 离线 mock 书源站点（零依赖，仅使用 Node 内置模块）。
 *
 * 用途：为“阅读(Legado) 3.0 书源规则引擎”提供可控的端到端测试靶站，
 * 覆盖 搜索 -> 书籍详情 -> 目录(含分页) -> 正文(含广告清洗/长章节分页) 全链路。
 *
 * 启动： node test/mock-site/server.mjs
 *       MOCK_PORT=18081 node test/mock-site/server.mjs
 *
 * 重要约束：
 *  - 不访问任何外部网络，页面里的图片一律由本机 /img/:id.jpg 提供；
 *  - 内容完全确定性生成（不使用 Math.random、不依赖当前时间），重复请求结果一致。
 *
 * 编码规则：
 *  - /search 与 /gbk-search 默认 text/html; charset=gbk（真实 GBK 字节输出）；
 *  - 其它页面默认 UTF-8；
 *  - 任意 HTML 路由都可用 ?charset=gbk|utf8 覆盖；
 *  - 页面内的链接会把“当前生效编码”向后传递，保证同一条数据流编码一致
 *    （例如 GBK 源从 /gbk-search 进入后，后续详情/目录/正文链接都会带上 ?charset=gbk）。
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { gbkEncode, gbkDecode, percentEncodeGBK } from './gbk.mjs';
import {
  BOOKS,
  SEARCH_PAGE_SIZE,
  TOC_PAGE_SIZE,
  CHAPTERS_PER_BOOK,
  chapterTitle,
  lastChapterTitle,
  chapterPart,
  isLongChapter,
  searchBooks,
  findBook,
} from './books.mjs';

const PORT = Number(process.env.MOCK_PORT || 18080);
const HOST = process.env.MOCK_HOST || '127.0.0.1';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return HTML_ESCAPES[c]; });
}

/** 某条路径“默认”使用什么编码 */
function defaultCharsetFor(pathname) {
  return (pathname === '/search' || pathname === '/gbk-search') ? 'gbk' : 'utf8';
}

/** 解析 ?charset= 参数 */
function resolveCharset(getParam, fallback) {
  const c = String(getParam('charset') || '').toLowerCase();
  if (c === 'utf8' || c === 'utf-8') return 'utf8';
  if (c === 'gbk' || c === 'gb18030' || c === 'gb2312') return 'gbk';
  return fallback;
}

/** 生成链接：仅当目标页默认编码与当前编码不一致时才显式带上 charset，保持 URL 干净 */
function withCharset(path, charset, force) {
  const i = path.indexOf('?');
  const pure = i < 0 ? path : path.slice(0, i);
  const pairs = i < 0 ? [] : path.slice(i + 1).split('&');
  const keep = [];
  for (let j = 0; j < pairs.length; j++) {
    if (!pairs[j]) continue;
    const eq = pairs[j].indexOf('=');
    const k = eq < 0 ? pairs[j] : pairs[j].slice(0, eq);
    if (decodeComponent(k, 'utf8') === 'charset') continue;
    keep.push(pairs[j]);
  }
  const need = force ? true : charset !== defaultCharsetFor(pure);
  if (need) keep.push('charset=' + charset);
  const qs = keep.join('&');
  return qs ? pure + '?' + qs : pure;
}

/** 对外输出的 MIME charset 名称统一用 utf-8 / gbk */
function mimeName(charset) {
  return charset === 'gbk' ? 'gbk' : 'utf-8';
}

/**
 * 按指定编码解码一个 URL 组件（百分号编码 / '+' / 裸字节）。
 * 关键点：真实 GBK 源站会要求客户端用 GBK 对 {{key}} 做百分号编码，
 * 所以这里必须用“页面生效编码”来解码查询串，而不是一律 UTF-8。
 */
function decodeComponent(s, charset) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '+') { bytes.push(0x20); continue; }
    if (c === '%' && i + 2 < s.length + 1) {
      const b = Number.parseInt(s.slice(i + 1, i + 3), 16);
      if (Number.isFinite(b)) { bytes.push(b); i += 2; continue; }
    }
    const code = c.charCodeAt(0);
    // GBK 页面：< 0x100 的字符视为原样透传的单个字节（Node 把请求行按 latin1 解出的裸字节）
    if (charset === 'gbk' && code < 0x100) { bytes.push(code); continue; }
    const enc = charset === 'gbk' ? gbkEncode(c) : Buffer.from(c, 'utf8');
    for (let j = 0; j < enc.length; j++) bytes.push(enc[j]);
  }
  const buf = Buffer.from(bytes);
  return charset === 'gbk' ? gbkDecode(buf) : buf.toString('utf8');
}

/** 解析 x-www-form-urlencoded 串（含 keyword 编码处理） */
function parseForm(raw, charset) {
  const out = {};
  const s = String(raw || '');
  if (!s) return out;
  const pairs = s.split('&');
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? '' : pair.slice(eq + 1);
    out[decodeComponent(k, charset)] = decodeComponent(v, charset);
  }
  return out;
}

/** 生成与页面编码一致的关键字参数值 */
function urlEncodeKey(keyword, charset) {
  return charset === 'gbk' ? percentEncodeGBK(keyword) : encodeURIComponent(keyword);
}

function pageOf(raw, totalPages) {
  let p = Number.parseInt(String(raw == null ? '' : raw), 10);
  if (!Number.isFinite(p) || p < 1) p = 1;
  if (p > totalPages) p = totalPages;
  return p;
}

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

function sendBuffer(res, status, buf, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

function sendHtml(req, res, status, html, charset) {
  const buf = charset === 'gbk' ? gbkEncode(html) : Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=' + mimeName(charset),
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  if (req.method === 'HEAD') res.end(); else res.end(buf);
}

function sendJson(res, status, obj) {
  sendBuffer(res, status, Buffer.from(JSON.stringify(obj, null, 2), 'utf8'), 'application/json; charset=utf-8');
}

// ---------------------------------------------------------------------------
// 页面外壳（导航 / 页脚 / 内联样式，全部本地，无任何外链资源）
// ---------------------------------------------------------------------------

const CSS = [
  '*{box-sizing:border-box}',
  'body{margin:0;font-family:"Microsoft YaHei","PingFang SC",SimSun,sans-serif;background:#f5f1e8;color:#2b2b2b;line-height:1.8}',
  'a{color:#8b5a2b;text-decoration:none}a:hover{text-decoration:underline}',
  '.wrap{max-width:960px;margin:0 auto;padding:0 16px}',
  '.site-header{background:#4a3728;color:#f5f1e8;padding:12px 0}',
  '.site-header a{color:#f0e2c8}',
  '.site-header .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:12px}',
  '.logo{font-size:20px;font-weight:700}',
  '.site-nav a{margin-right:12px;font-size:14px}',
  '.search-form{margin-left:auto;display:flex;gap:6px}',
  '.search-form input{padding:5px 8px;border:1px solid #b9a68a;border-radius:3px;min-width:180px}',
  '.search-form button{padding:5px 12px;border:0;border-radius:3px;background:#c8a15a;color:#3a2a18;cursor:pointer}',
  'main{padding:20px 16px 40px;min-height:60vh}',
  '.book-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}',
  '.book-item{background:#fffdf7;border:1px solid #e2d8c3;border-radius:6px;padding:12px;display:grid;grid-template-columns:76px 1fr;gap:10px}',
  '.book-item .cover img{width:76px;height:100px;object-fit:cover;border:1px solid #ddd;background:#eee}',
  '.book-item h3{margin:0 0 6px;font-size:17px}',
  '.book-item p{margin:2px 0;font-size:13px;color:#57534e}',
  '.book-item .intro{color:#6b6257;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
  '.book-item .last-chapter{color:#8b5a2b}',
  '.pager{margin:22px 0;display:flex;gap:10px;align-items:center;font-size:14px}',
  '.pager a{padding:4px 10px;border:1px solid #cbb894;border-radius:3px;background:#fffdf7}',
  '.book-detail{display:grid;grid-template-columns:180px 1fr;gap:18px;background:#fffdf7;border:1px solid #e2d8c3;border-radius:6px;padding:16px}',
  '.book-cover{width:180px;height:240px;object-fit:cover;border:1px solid #ddd;background:#eee}',
  '.book-title{font-size:24px;margin:0 0 10px}',
  '.book-detail .meta-line{margin:4px 0;color:#57534e;font-size:14px}',
  '.book-intro{margin-top:18px;background:#fffdf7;border:1px solid #e2d8c3;border-radius:6px;padding:16px}',
  '.book-intro h2{font-size:16px;margin:0 0 8px}',
  '#intro{color:#3f3a34;font-size:14px}',
  '.book-actions{margin-top:16px;display:flex;gap:12px}',
  '.book-actions a{padding:8px 18px;border-radius:4px;background:#4a3728;color:#f5f1e8}',
  '.chapter-list ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:6px}',
  '.chapter-list li{border-bottom:1px dashed #e2d8c3;padding:4px 0;font-size:14px}',
  '.chapter-title{font-size:22px;margin:0 0 6px}',
  '.chapter-info{color:#8a8073;font-size:13px;margin-bottom:14px}',
  '#content{background:#fffdf7;border:1px solid #e2d8c3;border-radius:6px;padding:18px 20px;font-size:17px}',
  '#content p{margin:0 0 14px;text-indent:2em}',
  '#content p.ad{color:#a89c86;text-indent:0;text-align:center;font-size:13px}',
  '.chapter-nav{margin-top:18px;display:flex;gap:12px;font-size:14px}',
  '.site-footer{background:#eae2d2;color:#6b6257;font-size:13px;padding:16px 0;border-top:1px solid #ddd0b6}',
  '.hot-list{list-style:none;margin:0;padding:0}',
  '.hot-item{padding:8px 0;border-bottom:1px dashed #e2d8c3;font-size:15px}',
  '.hot-item .hot-author,.hot-item .hot-kind{color:#8a8073;font-size:13px;margin-left:10px}',
].join('\n');

/**
 * 渲染完整 HTML 文档。
 * opts: { title, charset, body, keyword, selfPath }
 */
function renderDoc(opts) {
  const charset = opts.charset;
  const mime = mimeName(charset);
  const other = charset === 'gbk' ? 'utf8' : 'gbk';
  const L = function (p) { return withCharset(p, charset); };
  const switchHref = withCharset(opts.selfPath || '/', other, true);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="${mime}">
<meta http-equiv="Content-Type" content="text/html; charset=${mime}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} - 书海模拟书源站</title>
<style>${CSS}</style>
</head>
<body>
<header class="site-header">
  <div class="wrap">
    <a class="logo" href="${L('/')}">书海模拟书源站</a>
    <nav class="site-nav">
      <a href="${L('/')}">首页</a>
      <a href="${L('/search?q=&page=1')}">全部书籍</a>
      <a href="${L('/search?q=玄幻&page=1')}">玄幻分类</a>
      <a href="${L('/gbk-search?q=&page=1')}">GBK 搜索</a>
    </nav>
    <form class="search-form" action="${L('/search')}" method="get">
      <input type="hidden" name="charset" value="${charset}">
      <input type="text" name="q" value="${esc(opts.keyword || '')}" placeholder="输入书名或作者">
      <button type="submit">搜索</button>
    </form>
  </div>
</header>
<main class="wrap">
${opts.body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <p>书海模拟书源站 · 纯本地离线测试站点，全部书籍、作者与章节均为虚构内容，与任何真实网站无关。</p>
    <p>当前页面编码：${mime.toUpperCase()} · <a href="${switchHref}">切换到 ${mimeName(other).toUpperCase()}</a> · 模拟站点版本 v1.0</p>
  </div>
</footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// 各页面
// ---------------------------------------------------------------------------

function renderHomeBody(charset) {
  const L = function (p) { return withCharset(p, charset); };
  const hot = BOOKS.map(function (b) {
    return [
      '    <li class="hot-item">',
      '      <a class="hot-name" href="' + L('/book/' + b.id) + '">' + esc(b.name) + '</a>',
      '      <span class="hot-author">' + esc(b.author) + '</span>',
      '      <span class="hot-kind">' + esc(b.kind) + '</span>',
      '      <span class="hot-word">' + esc(b.wordCount) + '</span>',
      '    </li>',
    ].join('\n');
  }).join('\n');
  return [
    '  <h1 class="hot-title">热门书籍推荐</h1>',
    '  <p class="site-desc">共收录 ' + BOOKS.length + ' 本测试书籍，支持按书名或作者模糊搜索。</p>',
    '  <ul class="hot-list">',
    hot,
    '  </ul>',
  ].join('\n');
}

function renderSearchBody(charset, keyword, page, meta) {
  const info = meta || {};
  const L = function (p) { return withCharset(p, charset); };
  const all = searchBooks(keyword);
  const totalPages = Math.max(1, Math.ceil(all.length / SEARCH_PAGE_SIZE));
  const p = pageOf(page, totalPages);
  const slice = all.slice((p - 1) * SEARCH_PAGE_SIZE, p * SEARCH_PAGE_SIZE);

  const items = slice.map(function (b) {
    const url = L('/book/' + b.id);
    return [
      '  <div class="book-item">',
      '    <a class="cover" href="' + url + '"><img src="/img/' + b.id + '.jpg" alt="封面"></a>',
      '    <h3 class="book-name"><a href="' + url + '">' + esc(b.name) + '</a></h3>',
      '    <p class="author">作者：' + esc(b.author) + '</p>',
      '    <p class="kind">分类：' + esc(b.kind) + '</p>',
      '    <p class="word-count">字数：' + esc(b.wordCount) + '</p>',
      '    <p class="intro">' + esc(b.intro) + '</p>',
      '    <p class="last-chapter"><a href="' + L('/book/' + b.id + '/chapter/' + CHAPTERS_PER_BOOK) + '">最新章节：' + esc(lastChapterTitle(b)) + '</a></p>',
      '  </div>',
    ].join('\n');
  }).join('\n');

  const kw = urlEncodeKey(keyword == null ? '' : keyword, charset);
  const base = '/search?q=' + kw + '&page=';
  const prev = p > 1 ? '<a class="prev" href="' + L(base + (p - 1)) + '">上一页</a>' : '<span class="prev disabled">上一页</span>';
  const next = p < totalPages ? '<a class="next" href="' + L(base + (p + 1)) + '">下一页</a>' : '<span class="next disabled">下一页</span>';

  return [
    '  <h1 class="search-title">搜索结果</h1>',
    '  <p class="search-summary">关键字：<em class="keyword">' + esc(keyword || '（全部）') + '</em> · 共 ' + all.length + ' 条结果 · 第 ' + p + ' / ' + totalPages + ' 页</p>',
    '  <p class="encoding-note">页面编码：' + mimeName(charset).toUpperCase() + ' · 收到查询串：<code>' + esc(info.rawQuery || '') + '</code> · 按该编码解码后的关键字：<em>' + esc(keyword || '（空=全部）') + '</em></p>',
    info.laxWarning ? '  <p class="warn">编码容错：关键字无法按 GBK 正确解码（请求端疑似未按书源 charset 编码），已回退 UTF-8 匹配，结果可能不准。</p>' : '',
    '  <div class="book-list">',
    items || '  <p class="empty">没有找到相关书籍。</p>',
    '  </div>',
    '  <div class="pager">' + prev + '<span class="page-now">第 ' + p + ' / ' + totalPages + ' 页</span>' + next + '</div>',
  ].filter(function (line) { return line !== ''; }).join('\n');
}

function renderBookBody(charset, book) {
  const L = function (p) { return withCharset(p, charset); };
  const lastUrl = L('/book/' + book.id + '/chapter/' + CHAPTERS_PER_BOOK);
  return [
    '  <div class="book-detail">',
    '    <div class="book-cover-box">',
    '      <img class="book-cover" src="/img/' + book.id + '.jpg" alt="' + esc(book.name) + '">',
    '    </div>',
    '    <div class="book-meta">',
    '      <h1 class="book-title">' + esc(book.name) + '</h1>',
    '      <p class="meta-line">作者：<span class="author">' + esc(book.author) + '</span></p>',
    '      <p class="meta-line">分类：<span class="kind">' + esc(book.kind) + '</span></p>',
    '      <p class="meta-line">字数：<span class="word-count">' + esc(book.wordCount) + '</span></p>',
    '      <p class="meta-line">状态：<span class="status">' + esc(book.status) + '</span></p>',
    '      <p class="meta-line">最新章节：<span class="last-chapter"><a href="' + lastUrl + '">' + esc(lastChapterTitle(book)) + '</a></span></p>',
    '      <p class="meta-line">章节数：<span class="chapter-count">' + CHAPTERS_PER_BOOK + '</span></p>',
    '    </div>',
    '  </div>',
    '  <div class="book-intro">',
    '    <h2>内容简介</h2>',
    '    <div id="intro">' + esc(book.intro) + '</div>',
    '  </div>',
    '  <div class="book-actions">',
    '    <a class="toc" href="' + L('/book/' + book.id + '/chapters') + '">查看目录</a>',
    '    <a class="start-read" href="' + L('/book/' + book.id + '/chapter/1') + '">开始阅读</a>',
    '  </div>',
  ].join('\n');
}

function renderTocBody(charset, book, page) {
  const L = function (p) { return withCharset(p, charset); };
  const totalPages = Math.max(1, Math.ceil(CHAPTERS_PER_BOOK / TOC_PAGE_SIZE));
  const p = pageOf(page, totalPages);
  const from = (p - 1) * TOC_PAGE_SIZE + 1;
  const to = Math.min(CHAPTERS_PER_BOOK, p * TOC_PAGE_SIZE);
  const lis = [];
  for (let n = from; n <= to; n++) {
    lis.push('      <li><a href="' + L('/book/' + book.id + '/chapter/' + n) + '">' + esc(chapterTitle(book, n)) + '</a></li>');
  }
  const base = '/book/' + book.id + '/chapters?page=';
  const prev = p > 1 ? '<a class="prev" href="' + L(base + (p - 1)) + '">上一页</a>' : '<span class="prev disabled">上一页</span>';
  const next = p < totalPages ? '<a class="next" href="' + L(base + (p + 1)) + '">下一页</a>' : '<span class="next disabled">下一页</span>';
  return [
    '  <h1 class="book-title">' + esc(book.name) + '</h1>',
    '  <p class="toc-summary">作者：' + esc(book.author) + ' · 共 ' + CHAPTERS_PER_BOOK + ' 章 · 第 ' + p + ' / ' + totalPages + ' 页</p>',
    '  <div class="chapter-list">',
    '    <ul>',
    lis.join('\n'),
    '    </ul>',
    '  </div>',
    '  <div class="pager">' + prev + '<span class="page-now">第 ' + p + ' / ' + totalPages + ' 页</span>' + next + '</div>',
  ].join('\n');
}

function renderChapterBody(charset, book, n, part) {
  const L = function (p) { return withCharset(p, charset); };
  const paras = chapterPart(book, n, part);
  const title = chapterTitle(book, n);
  const body = paras.map(function (item) {
    if (item.type === 'ad') {
      const cls = item.text.indexOf('笔趣阁') >= 0 ? ' class="ad"' : '';
      return '    <p' + cls + '>' + esc(item.text) + '</p>';
    }
    return '    <p>' + esc(item.text) + '</p>';
  }).join('\n');

  const prevChapter = n > 1 ? '<a class="prev" href="' + L('/book/' + book.id + '/chapter/' + (n - 1)) + '">上一章</a>' : '<span class="prev disabled">上一章</span>';
  const nextChapter = n < CHAPTERS_PER_BOOK ? '<a class="next-chapter" href="' + L('/book/' + book.id + '/chapter/' + (n + 1)) + '">下一章</a>' : '<span class="next-chapter disabled">下一章</span>';
  const nextPage = (part === 1 && isLongChapter(n))
    ? '  <div class="page-nav"><a id="next" href="' + L('/book/' + book.id + '/chapter/' + n + '/next') + '">下一页</a></div>'
    : '';

  const intro = part === 2
    ? '  <p class="chapter-info">' + esc(book.name) + ' · ' + esc(book.author) + ' · 本章续页</p>'
    : '  <p class="chapter-info">' + esc(book.name) + ' · ' + esc(book.author) + ' · 本章共 ' + (isLongChapter(n) ? '2' : '1') + ' 页</p>';

  return [
    '  <h1 class="chapter-title">' + esc(title) + (part === 2 ? '（续）' : '') + '</h1>',
    intro,
    '  <div id="content">',
    body,
    '  </div>',
    nextPage,
    '  <div class="chapter-nav">' + prevChapter + '<a class="catalog" href="' + L('/book/' + book.id + '/chapters') + '">目录</a>' + nextChapter + '</div>',
  ].filter(function (line) { return line !== ''; }).join('\n');
}

// ---------------------------------------------------------------------------
// 1x1 合法 JPEG（内嵌 base64，不依赖任何外部资源）
// ---------------------------------------------------------------------------
const PIXEL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

// ---------------------------------------------------------------------------
// 请求分发
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise(function (resolve) {
    const chunks = [];
    let size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > 1e6) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', function () { resolve(''); });
  });
}

const ROUTES = [
  ['GET', '/', '首页：热门书籍链接列表（默认 UTF-8，可 ?charset=gbk）'],
  ['GET', '/search?q=&page=1', '搜索结果页（默认 GBK 真实字节，?charset=utf8 切 UTF-8）'],
  ['POST', '/search', '同 /search，body 表单 q=&page=&charset='],
  ['GET', '/gbk-search?q=&page=1', '强制 GBK 的搜索结果页'],
  ['GET', '/book/:id', '书籍详情页（书名/作者/封面/分类/字数/状态/简介/目录链接）'],
  ['GET', '/book/:id/chapters?page=1', '目录页，每页 20 章，共 30 章'],
  ['GET', '/book/:id/chapter/:n', '正文页，含广告行，每章 >=1200 字'],
  ['GET', '/book/:id/chapter/:n/next', '长章节（每 5 章）正文续页'],
  ['GET', '/img/:id.jpg', '1x1 合法 JPEG'],
  ['GET', '/slow?ms=3000', '故意延迟，测试超时'],
  ['GET', '/broken', '返回 500，测试错误处理'],
  ['GET', '/__routes', '本清单（JSON）'],
];

async function handle(req, res) {
  const url = new URL(req.url, 'http://' + HOST + ':' + PORT);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const seg = pathname.split('/').filter(Boolean);
  const q = function (k) { return url.searchParams.get(k); };

  // ---- 静态 JSON：路由清单 ----
  if (pathname === '/__routes') {
    return sendJson(res, 200, { mock: 'shuhai-mock-source-site', base: 'http://' + HOST + ':' + PORT, routes: ROUTES });
  }

  // ---- 1x1 JPEG ----
  if (seg[0] === 'img' && seg.length === 2 && seg[1].slice(-4) === '.jpg') {
    return sendBuffer(res, 200, PIXEL_JPEG, 'image/jpeg');
  }

  // ---- 故障注入 ----
  if (pathname === '/broken') {
    const charset = resolveCharset(q, 'utf8');
    return sendHtml(req, res, 500, renderDoc({
      title: '服务器内部错误',
      charset: charset,
      selfPath: '/broken',
      body: '  <h1>500 Internal Server Error</h1>\n  <p>模拟站点故障页：用于验证书源引擎在源站返回 5xx 时的错误处理（不得崩溃、需返回可读错误）。</p>',
    }), charset);
  }

  if (pathname === '/slow') {
    let ms = Number.parseInt(String(q('ms') || '3000'), 10);
    if (!Number.isFinite(ms) || ms < 0) ms = 3000;
    if (ms > 60000) ms = 60000;
    await new Promise(function (r) { setTimeout(r, ms); });
    const charset = resolveCharset(q, 'utf8');
    return sendHtml(req, res, 200, renderDoc({
      title: '慢响应页面',
      charset: charset,
      selfPath: '/slow?ms=' + ms,
      body: '  <h1>慢响应测试页</h1>\n  <p>本页面延迟了 ' + ms + ' 毫秒后返回，用于验证请求超时（TIMEOUT）处理。</p>',
    }), charset);
  }

  // ---- 搜索 ----
  if (pathname === '/search' || pathname === '/gbk-search') {
    const forcedGbk = pathname === '/gbk-search';
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      return sendHtml(req, res, 405, renderDoc({ title: '405', charset: 'utf8', selfPath: pathname, body: '  <h1>405 Method Not Allowed</h1>' }), 'utf8');
    }

    const qmark = req.url.indexOf('?');
    const rawQuery = qmark < 0 ? '' : req.url.slice(qmark + 1);
    let rawBody = '';
    if (req.method === 'POST') {
      rawBody = await readBody(req);
      const ctype = String(req.headers['content-type'] || '');
      if (ctype.indexOf('application/json') >= 0 && rawBody) {
        try {
          const obj = JSON.parse(rawBody);
          rawBody = Object.keys(obj).map(function (k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(String(obj[k]));
          }).join('&');
        } catch { rawBody = ''; }
      }
    }

    // 第一遍：按 UTF-8 取出 charset / page 等 ASCII 参数，确定本页生效编码
    const probe = Object.assign({}, parseForm(rawQuery, 'utf8'), parseForm(rawBody, 'utf8'));
    const charset = resolveCharset(function (k) { return probe[k]; }, forcedGbk ? 'gbk' : defaultCharsetFor(pathname));

    // 第二遍：用生效编码重新解码（真实 GBK 源会用 GBK 对 {{key}} 做百分号编码）
    const params = charset === 'gbk'
      ? Object.assign({}, parseForm(rawQuery, 'gbk'), parseForm(rawBody, 'gbk'))
      : probe;

    let keyword = params.q || '';
    let laxWarning = false;
    if (charset === 'gbk' && keyword && searchBooks(keyword).length === 0 &&
        probe.q && probe.q !== keyword && searchBooks(probe.q).length > 0) {
      keyword = probe.q;
      laxWarning = true;
    }

    const page = params.page || '1';
    const totalPages = Math.max(1, Math.ceil(searchBooks(keyword).length / SEARCH_PAGE_SIZE));
    const body = renderSearchBody(charset, keyword, page, {
      rawQuery: rawQuery + (rawBody ? '&' + rawBody : ''),
      laxWarning: laxWarning,
    });
    const selfPath = pathname + '?q=' + urlEncodeKey(keyword, charset) + '&page=' + pageOf(page, totalPages);
    return sendHtml(req, res, 200, renderDoc({ title: '搜索：' + (keyword || '全部'), charset: charset, body: body, keyword: keyword, selfPath: selfPath }), charset);
  }

  // ---- 首页 ----
  if (pathname === '/' || pathname === '/index.html') {
    const charset = resolveCharset(q, 'utf8');
    return sendHtml(req, res, 200, renderDoc({
      title: '首页',
      charset: charset,
      selfPath: '/',
      body: renderHomeBody(charset),
    }), charset);
  }

  // ---- 书籍相关 ----
  if (seg[0] === 'book' && seg.length >= 2) {
    const book = findBook(seg[1]);
    if (!book) {
      const charset = resolveCharset(q, 'utf8');
      return sendHtml(req, res, 404, renderDoc({
        title: '书籍不存在',
        charset: charset,
        selfPath: pathname,
        body: '  <h1>404 未找到该书籍</h1>\n  <p>书籍 ID：' + esc(seg[1]) + '</p>',
      }), charset);
    }

    if (seg.length === 2) {
      const charset = resolveCharset(q, 'utf8');
      return sendHtml(req, res, 200, renderDoc({
        title: book.name, charset: charset, selfPath: '/book/' + book.id,
        body: renderBookBody(charset, book),
      }), charset);
    }

    if (seg.length === 3 && seg[2] === 'chapters') {
      const charset = resolveCharset(q, 'utf8');
      const page = q('page') || '1';
      return sendHtml(req, res, 200, renderDoc({
        title: book.name + ' 目录', charset: charset, selfPath: '/book/' + book.id + '/chapters?page=' + page,
        body: renderTocBody(charset, book, page),
      }), charset);
    }

    if ((seg.length === 4 || seg.length === 5) && seg[2] === 'chapter') {
      const n = Number.parseInt(seg[3], 10);
      const isNext = seg.length === 5 && seg[4] === 'next';
      if (!Number.isFinite(n) || n < 1 || n > CHAPTERS_PER_BOOK) {
        const charset = resolveCharset(q, 'utf8');
        return sendHtml(req, res, 404, renderDoc({
          title: '章节不存在', charset: charset, selfPath: pathname,
          body: '  <h1>404 未找到该章节</h1>\n  <p>章节号：' + esc(seg[3]) + '（本书共 ' + CHAPTERS_PER_BOOK + ' 章）</p>',
        }), charset);
      }
      const charset = resolveCharset(q, 'utf8');
      const part = isNext ? 2 : 1;
      return sendHtml(req, res, 200, renderDoc({
        title: chapterTitle(book, n) + (isNext ? '（续）' : ''),
        charset: charset,
        selfPath: pathname + (isNext ? '' : ''),
        body: renderChapterBody(charset, book, n, part),
      }), charset);
    }
  }

  // ---- 404 ----
  const charset = resolveCharset(q, 'utf8');
  return sendHtml(req, res, 404, renderDoc({
    title: '页面不存在',
    charset: charset,
    selfPath: pathname,
    body: '  <h1>404 Not Found</h1>\n  <p>路径 ' + esc(pathname) + ' 不存在，可访问 <a href="/__routes">/__routes</a> 查看全部可用路由。</p>',
  }), charset);
}

const server = http.createServer(function (req, res) {
  handle(req, res).catch(function (err) {
    try {
      sendHtml(req, res, 500, renderDoc({
        title: '内部错误', charset: 'utf8', selfPath: '/',
        body: '  <h1>500 内部错误</h1>\n  <pre>' + esc(err && err.stack ? err.stack : String(err)) + '</pre>',
      }), 'utf8');
    } catch { /* 响应已发出，忽略 */ }
  });
});

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  server.listen(PORT, HOST, function () {
    process.stdout.write('[mock-site] listening on http://' + HOST + ':' + PORT + '\n');
    process.stdout.write('[mock-site] books=' + BOOKS.length + ' chapters/book=' + CHAPTERS_PER_BOOK + ' default-gbk=/search,/gbk-search\n');
  });
}

export { server, handle, PIXEL_JPEG };
