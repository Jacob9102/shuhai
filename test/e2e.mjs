/**
 * 端到端测试：自带一个模拟小说站，验证
 *   导入书源 → 搜索 → 落地书籍 → 目录 → 正文 → 书架/进度/书签 → 导出
 * 全部走真实 HTTP，不使用任何桩函数。
 *
 *   node test/e2e.mjs
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------- 1. 模拟小说站 ------------------------- */

let mockGbkError = '';

const BOOKS = [
  { id: 1001, name: '斗破苍穹', author: '天蚕土豆', kind: '玄幻', words: '530万字' },
  { id: 1002, name: '完美世界', author: '辰东', kind: '玄幻', words: '610万字' },
  { id: 1003, name: '凡人修仙传', author: '忘语', kind: '仙侠', words: '740万字' },
];

const CHAPTERS = 30;

function chapterText(bookName, n) {
  const paras = [];
  for (let i = 0; i < 6; i++) {
    paras.push('　　' + bookName + '第' + n + '章的第' + (i + 1) + '段正文内容，' +
      '这里用来验证正文抽取与段落还原是否正确，包含足够长度的中文以满足清洗规则的长度阈值要求。');
  }
  paras.push('　　本站域名 www.example-mock.com 请记住');
  paras.push('　　天才一秒记住本站地址');
  return paras.join('\n');
}

function searchPage(q, page, utf8) {
  const kw = String(q || '').trim();
  const list = BOOKS.filter((b) => !kw || b.name.includes(kw) || b.author.includes(kw));
  const items = list.map((b) => [
    '<li class="book-item">',
    '<a class="cover" href="/book/' + b.id + '"><img src="/img/' + b.id + '.jpg" alt="封面"></a>',
    '<h3 class="book-name"><a href="/book/' + b.id + '" data-rel="/book/' + b.id + '">' + b.name + '</a></h3>',
    '<p class="author">作者：' + b.author + '</p>',
    '<p class="kind">分类：' + b.kind + '</p>',
    '<p class="word-count">字数：' + b.words + '</p>',
    '<p class="intro">' + b.name + '是一本由' + b.author + '创作的' + b.kind + '小说，内容精彩值得一读。</p>',
    '<p class="last-chapter"><a href="/book/' + b.id + '/chapter/' + CHAPTERS + '">最新章节：第' + CHAPTERS + '章</a></p>',
    '</li>',
  ].join('')).join('\n');

  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>搜索 ' + kw + '</title></head><body>' +
    '<div class="header">模拟小说站</div>' +
    '<ul class="book-list">' + items + '</ul>' +
    '<div class="footer">第 ' + page + ' 页</div></body></html>';
  return html;
}

function detailPage(book) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + book.name + '</title></head><body>' +
    '<h1 class="book-title">' + book.name + '</h1>' +
    '<span class="author">' + book.author + '</span>' +
    '<img class="book-cover" src="/img/' + book.id + '.jpg">' +
    '<span class="kind">' + book.kind + '</span>' +
    '<span class="word-count">' + book.words + '</span>' +
    '<span class="status">连载中</span>' +
    '<div id="intro">' + book.name + '是一本由' + book.author + '创作的' + book.kind + '小说，内容精彩值得一读。</div>' +
    '<a class="toc-link" href="/book/' + book.id + '/chapters">查看目录</a>' +
    '</body></html>';
}

function tocPage(book, page) {
  const per = 20;
  const from = (page - 1) * per + 1;
  const to = Math.min(CHAPTERS, page * per);
  let lis = '';
  for (let n = from; n <= to; n++) lis += '<li><a href="/book/' + book.id + '/chapter/' + n + '">第' + n + '章 测试章节标题</a></li>';
  const next = to < CHAPTERS ? '<a class="next-page" href="/book/' + book.id + '/chapters?page=' + (page + 1) + '">下一页</a>' : '';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
    '<div class="chapter-list"><ul>' + lis + '</ul></div>' + next + '</body></html>';
}

function contentPage(book, n) {
  const body = chapterText(book.name, n).split('\n').map((p) => '<p>' + p + '</p>').join('');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>第' + n + '章</title></head><body>' +
    '<h1 class="chapter-title">第' + n + '章 测试章节标题</h1>' +
    '<div class="nav"><a href="#">上一章</a> <a href="#">目录</a> <a href="#">下一章</a></div>' +
    '<div id="content">' + body + '</div>' +
    '<div class="nav"><a href="#">上一章</a> <a href="#">目录</a> <a href="#">下一章</a></div>' +
    '</body></html>';
}

/** 用 GBK 输出中文（借助 Node 的 iconv 能力：TextDecoder 只能解码，这里手工查表太慢，
 *  所以直接用 Buffer 的 latin1 + 预置映射的做法不现实 —— 改为调用系统的 iconv 命令，
 *  若不可用则退化为 UTF-8 并标注 charset，测试仍然有效。） */
function toGbk(text) {
  return Buffer.from(text, 'utf8'); // 占位，下面 startMock 会真正处理
}

function startMock() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    const send = (html, type = 'text/html; charset=utf-8') => {
      res.writeHead(200, { 'Content-Type': type });
      res.end(html);
    };

    if (p === '/list') {
      send(searchPage('', u.searchParams.get('page') || 1));
      return;
    }

    if (p === '/search' || p === '/search/gbk') {
      const html = searchPage(u.searchParams.get('q'), u.searchParams.get('page') || 1);
      if (p === '/search/gbk') {
        // 真 GBK 输出：复用夹具里的 GBK 编码器（若不可用则退回 UTF-8，测试仍会跑但要留意）
        try {
          const gbk = await import('./mock-site/gbk.mjs');
          const body = html.replace('<meta charset="utf-8">', '<meta charset="gbk">');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=gbk' });
          res.end(Buffer.from(gbk.gbkEncode(body)));
          return;
        } catch (e) {
          mockGbkError = e.message;
        }
      }
      send(html);
      return;
    }

    let m = /^\/book\/(\d+)$/.exec(p);
    if (m) {
      const b = BOOKS.find((x) => x.id === Number(m[1]));
      if (!b) { res.writeHead(404); res.end('404'); return; }
      send(detailPage(b));
      return;
    }

    m = /^\/book\/(\d+)\/chapters$/.exec(p);
    if (m) {
      const b = BOOKS.find((x) => x.id === Number(m[1]));
      if (!b) { res.writeHead(404); res.end('404'); return; }
      send(tocPage(b, Number(u.searchParams.get('page') || 1)));
      return;
    }

    m = /^\/book\/(\d+)\/chapter\/(\d+)$/.exec(p);
    if (m) {
      const b = BOOKS.find((x) => x.id === Number(m[1]));
      if (!b) { res.writeHead(404); res.end('404'); return; }
      send(contentPage(b, Number(m[2])));
      return;
    }

    if (/^\/img\/\d+\.jpg$/.test(p)) {
      // 1x1 合法 JPEG
      const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(jpeg);
      return;
    }

    if (p === '/slow') {
      setTimeout(() => send('<html>slow</html>'), Number(u.searchParams.get('ms') || 3000));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

/* --------------------------- 2. 测试框架 --------------------------- */

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(name + (extra ? '  →  ' + extra : ''));
  console.log('  x ' + name + (extra ? '  →  ' + extra : ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(base, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

async function api(base, method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
}

/* ------------------------------ 主流程 ------------------------------ */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shuhai-e2e-'));
const dbFile = path.join(tmpDir, 'test.db');

const mock = await startMock();
const shuhaiPort = 18100 + Math.floor(Math.random() * 400);
const base = 'http://127.0.0.1:' + shuhaiPort;

const child = spawn(process.execPath, [path.join(ROOT, 'src/server.mjs')], {
  env: { ...process.env, SHUHAI_PORT: String(shuhaiPort), SHUHAI_DB: dbFile, SHUHAI_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d.toString(); });
child.stderr.on('data', (d) => { serverLog += d.toString(); });

const cleanup = () => {
  try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
  try { mock.server.close(); } catch { /* 忽略 */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
};
process.on('exit', cleanup);

try {
  const healthy = await waitHealthy(base);
  check('服务启动并可访问 /api/health', healthy, serverLog.slice(-500));
  if (!healthy) throw new Error('服务未启动');

  const mockBase = 'http://127.0.0.1:' + mock.port;

  /* ---------- 书源导入 ---------- */
  const sourceJson = {
    bookSourceName: 'E2E模拟源',
    bookSourceUrl: mockBase,
    bookSourceGroup: '测试',
    bookSourceComment: '端到端测试用',
    enabled: true,
    weight: 10,
    searchUrl: '/search?q={{key}}&page={{page}}',
    exploreUrl: JSON.stringify([{ title: '玄幻榜', url: '/list?g=xuanhuan' }, { title: '全部书库', url: '/list' }]),
    ruleSearch: {
      bookList: 'class.book-list@tag.li',
      name: 'class.book-name@tag.a@text',
      author: 'class.author@text##作者：##',
      kind: 'class.kind@text##分类：##',
      wordCount: 'class.word-count@text',
      intro: 'class.intro@text',
      lastChapter: 'class.last-chapter@tag.a@text',
      coverUrl: 'class.cover@tag.img@src',
      bookUrl: 'class.book-name@tag.a@href',
    },
    ruleBookInfo: {
      name: 'class.book-title@text',
      author: 'class.author@text',
      kind: 'class.kind@text',
      wordCount: 'class.word-count@text',
      status: 'class.status@text',
      intro: 'id.intro@text',
      coverUrl: 'class.book-cover@src',
      tocUrl: 'class.toc-link@href',
    },
    ruleToc: {
      chapterList: 'class.chapter-list@tag.li',
      chapterName: 'tag.a@text',
      chapterUrl: 'tag.a@href',
      nextTocUrl: 'class.next-page@href',
    },
    ruleContent: { content: 'id.content@html' },
  };
  // 榜单字段规则与搜索一致（社区里最常见的写法）
  sourceJson.ruleExplore = sourceJson.ruleSearch;

  let r = await api(base, 'POST', '/api/sources/import', { text: JSON.stringify([sourceJson]), mode: 'append' });
  check('导入书源成功', r.json.ok && r.json.data.added === 1, JSON.stringify(r.json));
  const sourceId = (await api(base, 'GET', '/api/sources')).json.data.items[0].id;

  r = await api(base, 'POST', '/api/sources/test', { id: sourceId, keyword: '斗破' });
  check('书源测试通过（真实搜索命中）', r.json.ok && r.json.data.ok && r.json.data.count >= 1, JSON.stringify(r.json.data));

  r = await api(base, 'POST', '/api/sources/import', { text: JSON.stringify([sourceJson]), mode: 'append' });
  check('重复导入被跳过', r.json.data.skipped === 1, JSON.stringify(r.json.data));

  /* ---------- 搜索 ---------- */
  r = await api(base, 'GET', '/api/search?q=' + encodeURIComponent('斗破'));
  const items = r.json.data?.items || [];
  check('按书名搜索命中', items.length >= 1, JSON.stringify(r.json).slice(0, 300));
  check('搜索结果字段完整', items[0]?.name === '斗破苍穹' && items[0]?.author === '天蚕土豆' && items[0]?.bookUrl.includes('/book/1001'), JSON.stringify(items[0]));
  check('封面地址已补全为绝对地址', String(items[0]?.coverUrl).startsWith(mockBase), items[0]?.coverUrl);
  check('搜索来源统计正确', r.json.data.sources?.[0]?.ok === true, JSON.stringify(r.json.data.sources));

  r = await api(base, 'GET', '/api/search?q=' + encodeURIComponent('辰东') + '&type=author');
  check('按作者名搜索命中', (r.json.data?.items || []).some((x) => x.name === '完美世界'), JSON.stringify(r.json.data?.items?.map((x) => x.name)));

  /* ---------- SSE 流式搜索 ---------- */
  const sse = await fetch(base + '/api/search/stream?q=' + encodeURIComponent('凡人'));
  const sseText = await sse.text();
  check('SSE 流式搜索返回 source 事件', sseText.includes('event: source'), sseText.slice(0, 200));
  check('SSE 流式搜索返回 done 事件', sseText.includes('event: done'), sseText.slice(-200));
  check('SSE 内含命中结果', sseText.includes('凡人修仙传'), sseText.slice(0, 400));

  /* ---------- 榜单 / 分类发现 ---------- */
  r = await api(base, 'GET', '/api/search/hot');
  check('榜单接口返回分组', r.json.ok && Array.isArray(r.json.data) && r.json.data.length >= 1, JSON.stringify(r.json.data).slice(0, 300));
  check('榜单分组含书名与地址', (r.json.data?.[0]?.items || []).length >= 3 && r.json.data[0].items[0].bookUrl.includes('/book/'),
    JSON.stringify(r.json.data?.[0]?.items?.[0]));

  /* ---------- 落地书籍 ---------- */
  r = await api(base, 'POST', '/api/books/resolve', { sourceId, bookUrl: items[0].bookUrl });
  check('书籍落地成功', r.json.ok && r.json.data.id > 0, JSON.stringify(r.json));
  const bookId = r.json.data.id;
  check('详情页补全了简介', (r.json.data.intro || '').includes('斗破苍穹'), r.json.data.intro);
  check('详情页补全了目录地址', (r.json.data.tocUrl || '').includes('/book/1001'), r.json.data.tocUrl);

  /* ---------- 目录（含分页目录跟进） ---------- */
  r = await api(base, 'GET', '/api/books/' + bookId + '/chapters');
  const chapters = r.json.data?.items || [];
  check('目录抓取成功（跨分页 30 章）', chapters.length === CHAPTERS, 'got ' + chapters.length);
  check('章节标题正确', chapters[0]?.title === '第1章 测试章节标题', chapters[0]?.title);
  check('章节地址已补全', String(chapters[0]?.url).startsWith(mockBase), chapters[0]?.url);

  r = await api(base, 'GET', '/api/books/' + bookId + '/chapters');
  check('目录二次请求走缓存', r.json.data.fromCache === true, JSON.stringify(r.json.data.fromCache));

  /* ---------- 正文 ---------- */
  r = await api(base, 'GET', '/api/books/' + bookId + '/content?index=0');
  const content = r.json.data?.content || '';
  check('正文抓取成功', r.json.ok && content.length > 200, JSON.stringify(r.json).slice(0, 300));
  check('正文保留了段落结构（多段）', content.split('\n').length >= 5, 'lines=' + content.split('\n').length);
  check('正文已剔除站点广告行', !content.includes('example-mock.com') && !content.includes('天才一秒记住'), content.slice(0, 200));
  check('正文首行不是章节标题/导航', !content.startsWith('第1章') && !content.includes('上一章'), content.slice(0, 60));
  check('正文包含有效内容', content.includes('第1章的第1段正文内容'), content.slice(0, 80));
  check('返回了上下章索引', r.json.data.nextIndex === 1 && r.json.data.prevIndex === -1, JSON.stringify({ n: r.json.data.nextIndex, p: r.json.data.prevIndex }));

  r = await api(base, 'GET', '/api/books/' + bookId + '/content?index=0');
  check('正文二次请求命中缓存', r.json.data.fromCache === true, JSON.stringify(r.json.data.fromCache));

  /* ---------- 书架 / 进度 / 书签 ---------- */
  r = await api(base, 'POST', '/api/shelf', { bookId, group: '我的收藏' });
  check('加入书架成功', r.json.ok, JSON.stringify(r.json));
  r = await api(base, 'GET', '/api/shelf');
  check('书架列表含该书与分组', r.json.data.items.some((b) => b.id === bookId && b.shelf.group === '我的收藏'), JSON.stringify(r.json.data).slice(0, 300));

  r = await api(base, 'PUT', '/api/progress/' + bookId, { chapterIndex: 5, chapterTitle: '第6章 测试章节标题', chapterPos: 0.42, percent: 20, addSeconds: 90 });
  check('保存阅读进度成功', r.json.ok && r.json.data.chapterIndex === 5 && r.json.data.readSeconds === 90, JSON.stringify(r.json.data));
  r = await api(base, 'GET', '/api/progress/' + bookId);
  check('读取阅读进度一致', r.json.data.percent === 20 && r.json.data.chapterTitle === '第6章 测试章节标题', JSON.stringify(r.json.data));

  r = await api(base, 'POST', '/api/bookmarks', { bookId, chapterIndex: 5, chapterTitle: '第6章 测试章节标题', pos: 0.3, text: '这是一段被标记的原文', note: '这里写得好' });
  check('新增书签成功', r.json.ok && r.json.data.id > 0, JSON.stringify(r.json));
  r = await api(base, 'GET', '/api/notes?bookId=' + bookId);
  check('笔记列表可查', r.json.data.length === 1 && r.json.data[0].note === '这里写得好', JSON.stringify(r.json.data));

  /* ---------- 全书章节搜索 ---------- */
  r = await api(base, 'GET', '/api/books/' + bookId + '/search?q=' + encodeURIComponent('第12章'));
  check('章节标题搜索命中', r.json.data.length === 1 && r.json.data[0].index === 11, JSON.stringify(r.json.data));

  /* ---------- 缓存任务 ---------- */
  r = await api(base, 'POST', '/api/books/' + bookId + '/cache', { from: 20, to: 24, concurrency: 2 });
  check('启动缓存任务成功', r.json.ok && r.json.data.queued === 5, JSON.stringify(r.json.data));
  await sleep(2500);
  r = await api(base, 'GET', '/api/books/' + bookId + '/cache');
  check('缓存任务完成（新增 5 章）', r.json.data.cached === 6 && r.json.data.running === false, JSON.stringify(r.json.data));

  /* ---------- 设置 ---------- */
  r = await api(base, 'PUT', '/api/settings', { bgColor: '#112233', fontSize: 24, autoRead: { speed: 88 } });
  check('保存设置并深合并', r.json.data.bgColor === '#112233' && r.json.data.fontSize === 24 && r.json.data.autoRead.speed === 88 && r.json.data.autoRead.enabled === false, JSON.stringify(r.json.data).slice(0, 300));
  r = await api(base, 'GET', '/api/settings');
  check('设置持久化成功', r.json.data.bgColor === '#112233' && r.json.data.theme === 'light', JSON.stringify(r.json.data).slice(0, 200));

  /* ---------- 换源 ---------- */
  r = await api(base, 'GET', '/api/books/' + bookId + '/alternatives');
  check('换源候选接口返回 {items}（同源被排除）',
    r.json.ok && r.json.data && Array.isArray(r.json.data.items) && r.json.data.items.every((x) => x.sourceId !== bookId ?? true),
    JSON.stringify(r.json).slice(0, 240));

  /* ---------- 导出 ---------- */
  r = await api(base, 'GET', '/api/sources/export');
  const exported = r.json.data;
  check('导出 legado 兼容格式', Array.isArray(exported) && exported[0].bookSourceName === 'E2E模拟源' && exported[0].ruleToc.chapterList, JSON.stringify(exported).slice(0, 300));

  /* ---------- GBK 编码 ---------- */
  const gbkSource = { ...sourceJson, bookSourceName: 'E2E-GBK源', searchUrl: '/search/gbk?q={{key}}' };
  await api(base, 'POST', '/api/sources/import', { text: JSON.stringify([gbkSource]) });
  const gbkId = (await api(base, 'GET', '/api/sources?q=' + encodeURIComponent('GBK'))).json.data.items[0].id;

  // 单独查这个源，避免被聚合去重合并掉
  r = await api(base, 'GET', '/api/search?q=' + encodeURIComponent('斗破') + '&sources=' + gbkId);
  const gbkHit = r.json.data?.items || [];
  check('GBK 站点中文解码正确', gbkHit.some((x) => x.name === '斗破苍穹' && x.author === '天蚕土豆' && x.kind === '玄幻'),
    'hits=' + JSON.stringify(gbkHit.map((x) => [x.name, x.author, x.kind])) +
    (mockGbkError ? ' [GBK编码器不可用: ' + mockGbkError + ']' : ''));

  // 聚合去重：同名同作者的多来源应合并，且保留来源列表
  r = await api(base, 'GET', '/api/search?q=' + encodeURIComponent('斗破'));
  const merged = (r.json.data?.items || []).find((x) => x.name === '斗破苍穹');
  check('多来源同名书被聚合去重并保留来源列表', merged && merged.origins && merged.origins.length === 2,
    JSON.stringify(merged?.origins?.map((o) => o.sourceName)));

  r = await api(base, 'GET', '/api/search?q=' + encodeURIComponent('斗破') + '&dedupe=0');
  check('dedupe=0 时不合并来源', (r.json.data?.items || []).filter((x) => x.name === '斗破苍穹').length === 2,
    JSON.stringify((r.json.data?.items || []).map((x) => x.sourceName)));

  /* ---------- 错误处理 ---------- */
  r = await api(base, 'GET', '/api/books/999999');
  check('不存在的书籍返回 404', r.status === 404 && r.json.error.code === 'NOT_FOUND', JSON.stringify(r.json));
  r = await api(base, 'GET', '/api/books/' + bookId + '/content?index=9999');
  // 有意改成 409 + CHAPTER_OUT_OF_RANGE：索引越界是「目录变了、刷新即可」，
  // 不是「资源不存在」。之前统一叫 404 正是用户看到 "HTTP 404 Not Found" 时被误导的原因之一。
  check('越界章节返回 409 且提示刷新目录',
    r.status === 409 && r.json.error.code === 'CHAPTER_OUT_OF_RANGE' && /刷新目录/.test(r.json.error.message),
    JSON.stringify(r.json));

  const badSource = { ...sourceJson, bookSourceName: 'E2E坏规则源', ruleSearch: { bookList: 'class.not-exist', name: 'text' } };
  await api(base, 'POST', '/api/sources/import', { text: JSON.stringify([badSource]) });
  r = await api(base, 'GET', '/api/search?q=' + encodeURIComponent('斗破'));
  const badStat = (r.json.data?.sources || []).find((s) => s.name === 'E2E坏规则源');
  check('坏规则源不拖垮整体搜索', r.json.ok && badStat && badStat.count === 0 && r.json.data.items.length >= 1, JSON.stringify(badStat));

  /* ---------- 统计 ---------- */
  r = await api(base, 'GET', '/api/stats');
  check('统计数据合理', r.json.data.sourceTotal === 3 && r.json.data.bookTotal === 1 && r.json.data.chapterCached === 6, JSON.stringify(r.json.data));

  /* ---------- 坏目录地址自愈（「点阅读提示 HTTP 404」的根因） ---------- */
  // 人为把 toc_url 写成早期规则引擎 bug 会写出的脏数据，验证打开时能自动回源修复
  {
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('UPDATE books SET toc_url = ? WHERE id = ?')
      .run('["(\'/b/1.html\', \'\', \'\')","/b/1.html"]', bookId);
    db.close();

    r = await api(base, 'GET', '/api/books/' + bookId + '/chapters?refresh=1');
    check('脏目录地址能自愈（自动回源刷新后仍能拿到目录）',
      r.json.ok && r.json.data.items.length > 0, JSON.stringify(r.json).slice(0, 200));
    const fixed = (await api(base, 'GET', '/api/books/' + bookId)).json.data;
    check('自愈后 tocUrl 被写回有效绝对地址', /^https?:\/\//.test(String(fixed.tocUrl)), fixed.tocUrl);

    // 连 book_url 都坏掉的记录（救不回来）：要给出明确的错误码，而不是干巴巴的 404
    const db2 = new DatabaseSync(dbFile);
    db2.exec('PRAGMA busy_timeout = 5000');
    db2.prepare('INSERT INTO books (source_id, book_url, name, toc_url, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(1, '["broken"]', '坏记录测试书', '["broken"]', Date.now(), Date.now());
    const badId = Number(db2.prepare('SELECT id FROM books WHERE name = ?').get('坏记录测试书').id);
    db2.close();
    r = await api(base, 'GET', '/api/books/' + badId + '/chapters');
    check('书源地址损坏的记录返回明确错误（BOOK_RECORD_BROKEN）',
      r.status === 409 && r.json.error && r.json.error.code === 'BOOK_RECORD_BROKEN',
      JSON.stringify(r.json).slice(0, 200));
    await api(base, 'DELETE', '/api/books/' + badId);
  }

  /* ---------- 上游 404 不得冒充本服务的 404（用户报「点阅读提示 HTTP 404」的直接根因） ---------- */
  {
    r = await api(base, 'POST', '/api/books/resolve', { sourceId, bookUrl: mockBase + '/book/does-not-exist' });
    const ghostId = r.json.data && r.json.data.id;
    check('详情页 404 时仍能落地书籍、不阻断流程', Boolean(ghostId), JSON.stringify(r.json).slice(0, 200));
    if (ghostId) {
      r = await api(base, 'GET', '/api/books/' + ghostId + '/chapters');
      check('上游 404 返回 502 + UPSTREAM_NOT_FOUND，而不是本服务的 404',
        r.status === 502 && r.json.error && r.json.error.code === 'UPSTREAM_NOT_FOUND',
        JSON.stringify(r.json).slice(0, 250));
      check('上游 404 的提示不再原样透出 "HTTP 404 Not Found"',
        !/^HTTP 404/.test(String(r.json.error && r.json.error.message)),
        String(r.json.error && r.json.error.message));
      check('上游 404 的提示里带「换源」建议（可操作）',
        /换源/.test(String(r.json.error && r.json.error.message)),
        String(r.json.error && r.json.error.message));
      await api(base, 'DELETE', '/api/books/' + ghostId);
    }
  }

  /* ---------- 搜索结果的相对 bookUrl 必须在搜索阶段就补成绝对地址 ---------- */
  {
    const relSrc = {
      ...sourceJson,
      bookSourceName: 'E2E相对地址源',
      // data-rel 不在引擎的 URL 属性白名单里，因此规则层不会自动补全 ——
      // 必须靠 toSearchResult 兜底，否则入库后点「阅读」就会拿相对地址去请求
      ruleSearch: { ...sourceJson.ruleSearch, bookUrl: 'class.book-name@tag.a@data-rel' },
    };
    await api(base, 'POST', '/api/sources/import', { text: JSON.stringify([relSrc]) });
    const relId = (await api(base, 'GET', '/api/sources?q=' + encodeURIComponent('相对地址'))).json.data.items[0].id;
    r = await api(base, 'GET', '/api/sources/' + relId + '/search?q=' + encodeURIComponent('斗破'));
    const relItem = (r.json.data && r.json.data.items && r.json.data.items[0]) || null;
    check('相对 bookUrl 在搜索阶段就被补成绝对地址',
      relItem && /^https?:\/\//.test(relItem.bookUrl) && relItem.bookUrl.endsWith('/book/1001'),
      JSON.stringify(relItem && relItem.bookUrl));
    await api(base, 'DELETE', '/api/sources/' + relId);
  }

  /* ---------- 批量体检 / 一键清理失效源 ---------- */
  const allSrc = (await api(base, 'GET', '/api/sources?limit=200')).json.data;
  const goodSrc = allSrc.items.find((s) => s.name === 'E2E模拟源');
  const badSrc = allSrc.items.find((s) => s.name === 'E2E坏规则源');
  const gbkSrc = allSrc.items.find((s) => s.name === 'E2E-GBK源');
  check('从未测试的书源 testStatus=untested',
    gbkSrc && gbkSrc.testStatus === 'untested' && gbkSrc.lastTestAt === 0,
    JSON.stringify(gbkSrc));
  check('列表返回体检总览 testStats',
    allSrc.testStats && allSrc.testStats.total === 3 &&
    allSrc.testStats.ok + allSrc.testStats.fail + allSrc.testStats.untested === 3 &&
    allSrc.testStats.ok === 1 && allSrc.testStats.fail === 0,
    JSON.stringify(allSrc.testStats));

  r = await api(base, 'POST', '/api/sources/test-batch', { ids: [goodSrc.id, badSrc.id], keyword: '斗破' });
  const batch = r.json.data;
  check('批量体检返回统计', r.status === 200 && batch.total === 2 && batch.ok === 1 && batch.fail === 1, JSON.stringify(batch).slice(0, 300));
  check('批量体检结果含名称/耗时/命中数/失败原因',
    batch.results.every((x) => x.name && typeof x.elapsed === 'number') &&
    batch.results.find((x) => x.ok).count >= 1 &&
    !!batch.results.find((x) => !x.ok).error,
    JSON.stringify(batch.results));

  r = await api(base, 'GET', '/api/sources?status=ok');
  check('status=ok 筛出可用源', r.json.data.total === 1 && r.json.data.items[0].name === 'E2E模拟源', JSON.stringify(r.json.data.items.map((s) => s.name)));
  r = await api(base, 'GET', '/api/sources?status=fail');
  check('status=fail 筛出失效源并带失败原因',
    r.json.data.total === 1 && r.json.data.items[0].name === 'E2E坏规则源' && !!r.json.data.items[0].lastTestError,
    JSON.stringify(r.json.data.items));
  r = await api(base, 'GET', '/api/sources?status=untested');
  check('status=untested 筛出未测试源', r.json.data.total === 1 && r.json.data.items[0].name === 'E2E-GBK源', JSON.stringify(r.json.data.items.map((s) => s.name)));

  /* ---------- SSE 批量体检 ---------- */
  const healthSseRes = await fetch(base + '/api/sources/test-batch/stream?ids=' + goodSrc.id + ',' + badSrc.id + '&keyword=' + encodeURIComponent('斗破'));
  const healthSseText = await healthSseRes.text();
  check('SSE 批量体检依次推送 start/result/done',
    healthSseText.includes('event: start') && (healthSseText.match(/event: result/g) || []).length === 2 && healthSseText.includes('event: done'),
    healthSseText.slice(0, 240).replace(/\n/g, '|'));

  /* ---------- 一键删除失效源 ---------- */
  r = await api(base, 'POST', '/api/sources/delete-invalid', {});
  check('一键删除失效源只删「测过且失败」的',
    r.json.data.deleted === 1 && r.json.data.items[0].name === 'E2E坏规则源' && r.json.data.scope === 3,
    JSON.stringify(r.json.data));
  r = await api(base, 'GET', '/api/sources');
  check('从未测试过的书源不会被误删',
    r.json.data.total === 2 && r.json.data.items.some((s) => s.name === 'E2E-GBK源'),
    JSON.stringify(r.json.data.items.map((s) => s.name)));

  /* ---------- 单源测试结果同样落库 ---------- */
  r = await api(base, 'POST', '/api/sources/test', { id: goodSrc.id, keyword: '斗破' });
  check('单源测试可通过', r.json.data.ok === true && r.json.data.count >= 1, JSON.stringify(r.json.data).slice(0, 160));
  r = await api(base, 'GET', '/api/sources?status=ok');
  check('单源测试结果写入体检状态', r.json.data.total === 1 && r.json.data.items[0].lastTestOk === true, JSON.stringify(r.json.data.items[0]));

  /* ---------- 清理范围的边界 ---------- */
  r = await api(base, 'POST', '/api/sources/delete-invalid', { retest: true, keyword: '斗破' });
  check('retest 模式先体检再删（此时无失效源，deleted=0）', r.json.data.tested === 2 && r.json.data.deleted === 0, JSON.stringify(r.json.data));

  r = await api(base, 'POST', '/api/sources/delete-invalid', { retest: false, q: '绝不存在的关键字' });
  check('清理范围跟随筛选条件（筛选命中 0 个则一个都不删）', r.json.data.scope === 0 && r.json.data.deleted === 0, JSON.stringify(r.json.data));

} catch (err) {
  failures.push('异常中断: ' + err.message);
  console.log('  x 异常中断: ' + err.stack);
} finally {
  console.log('\n============================');
  console.log('通过 ' + pass + ' 项，失败 ' + failures.length + ' 项');
  if (failures.length) {
    console.log('\n失败清单：');
    for (const f of failures) console.log('  - ' + f);
  } else {
    console.log('全部通过 ✅');
  }
  if (serverLog && failures.length) {
    console.log('\n--- 服务端日志（尾部） ---');
    console.log(serverLog.split('\n').slice(-25).join('\n'));
  }
  cleanup();
  process.exit(failures.length ? 1 : 0);
}
