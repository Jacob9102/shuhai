/**
 * REST API 路由层。接口定义见 docs/API.md（已冻结契约）。
 */

import { request } from './net/http.mjs';
import { stats as dbStats, run as dbRun, all } from './db.mjs';
import {
  listSources, getSource, getSourceRaw, importSources, updateSource, patchSource,
  deleteSources, exportSources, listSourceIds, parseImportText,
  normalizeSource, recordTestResult, listInvalidSourceIds, sourceTestStats,
} from './source.mjs';
import {
  searchAll, searchAllStream, searchSource, scoreMatch, aggregateResults, SourceError, fetchExplore,
  isExactMatch,
} from './engine.mjs';
import {
  resolveBook, getBook, refreshBookInfo, deleteBook, ensureChapters, getChapterContent,
  getChapters, startCacheJob, getCacheState, listShelf, addToShelf, removeFromShelf,
  patchShelf, getProgress, saveProgress, listBookmarks, addBookmark, updateBookmark,
  deleteBookmark, findAlternatives, findAlternativesStream, changeSource, searchChapters, addSearchHistory,
  listSearchHistory, clearSearchHistory, clearContentCache, loadSourceForBook,
} from './store.mjs';
import { loadSettings, saveSettings, resetSettings, PRESETS, DEFAULT_SETTINGS } from './settings.mjs';
import * as log from './log.mjs';

const VERSION = '1.0.0';
const STARTED_AT = Date.now();

/* ============================ 路由框架 ============================ */

const routes = [];

function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  }) + '$');
  routes.push({ method, regex, keys, handler, pattern });
}

class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const ok = (res, data, status = 200) => sendJson(res, status, { ok: true, data });

function fail(res, code, message, status = 400) {
  sendJson(res, status, { ok: false, error: { code, message: String(message || '') } });
}

function statusForCode(code) {
  switch (code) {
    case 'BAD_REQUEST': return 400;
    case 'NOT_FOUND': return 404;
    case 'CONFLICT': return 409;
    case 'BOOK_RECORD_BROKEN': return 409;
    case 'TIMEOUT': return 504;
    case 'UPSTREAM_ERROR': return 502;
    // 书源站点返回 404：是我们连不上上游，不是本服务没有这个接口，所以用 502 而不是 404
    case 'UPSTREAM_NOT_FOUND': return 502;
    // 目录已变化导致索引越界：属于可恢复冲突，不是「资源不存在」
    case 'CHAPTER_OUT_OF_RANGE': return 409;
    case 'RULE_ERROR': return 502;
    default: return 500;
  }
}

const toInt = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const toBool = (v, d = false) => {
  if (v === undefined || v === null || v === '') return d;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
};

/* ============================ 系统 ============================ */

route('GET', '/api/health', (c) => {
  const s = dbStats();
  ok(c.res, {
    status: 'ok',
    version: VERSION,
    uptime: Math.round((Date.now() - STARTED_AT) / 1000),
    sourceCount: s.sourceTotal,
    bookCount: s.bookTotal,
    node: process.version,
  });
});

route('GET', '/api/stats', (c) => {
  ok(c.res, dbStats());
});

route('GET', '/api/logs', (c) => {
  ok(c.res, log.tail(toInt(c.query.limit, 200)));
});

/* ============================ 书源 ============================ */

route('GET', '/api/sources', (c) => {
  const q = c.query.q || '';
  const group = c.query.group || '';
  const enabled = c.query.enabled === undefined || c.query.enabled === '' ? null : toBool(c.query.enabled);
  const status = String(c.query.status || '');
  const page = toInt(c.query.page, 1);
  const limit = toInt(c.query.limit, 20);
  ok(c.res, listSources({ q, group, enabled, status, page, limit }));
});

route('GET', '/api/sources/groups', (c) => {
  const r = listSources({ limit: 200 });
  ok(c.res, r.groups);
});

route('POST', '/api/sources/delete', (c) => {
  const ids = Array.isArray(c.body.ids) ? c.body.ids : [];
  if (!ids.length) throw new ApiError('BAD_REQUEST', '缺少 ids');
  const n = deleteSources(ids);
  log.warn('批量删除书源：' + n + ' 个（ids=' + ids.slice(0, 20).join(',') + (ids.length > 20 ? ',…' : '') + '）');
  ok(c.res, { deleted: n });
});

route('POST', '/api/sources/batch', (c) => {
  const ids = Array.isArray(c.body.ids) ? c.body.ids : [];
  const p = c.body.patch || {};
  if (!ids.length) throw new ApiError('BAD_REQUEST', '缺少 ids');
  let changed = 0;
  for (const id of ids) { if (patchSource(Number(id), p)) changed++; }
  // 批量改动是「一次性影响很多书源」的高危操作，留痕便于事后追查
  log.info('批量修改书源：' + changed + '/' + ids.length + ' 个，补丁 ' + JSON.stringify(p));
  ok(c.res, { changed });
});

/** 从 URL 抓取订阅内容再导入 */
async function importFromUrl(url, opts) {
  let res;
  try {
    res = await request(url, { timeout: 20000, retry: 1 });
  } catch (err) {
    // 「网络错误: fetch failed」这种提示对用户毫无意义——讲清楚原因和替代做法
    throw new ApiError(
      'BAD_REQUEST',
      '服务器访问不了这个地址（' + (err.message || '网络错误') + '）：' + url + '\n' +
      '常见原因：该域名在本机网络下不可达、需要代理，或被站点风控拦截。\n' +
      '替代做法：在你自己的浏览器里打开这个地址，全选复制 JSON 内容，' +
      '回到这里改用「粘贴文本」或保存成 .json 后用「本地文件」导入。',
    );
  }
  const parsed = parseImportText(res.text);
  if (parsed.error) throw new ApiError('BAD_REQUEST', '订阅地址内容解析失败：' + parsed.error);
  return importSources(parsed.sources, opts);
}

route('POST', '/api/sources/import', async (c) => {
  const { text, url, mode = 'append', group = '', enabled } = c.body || {};
  if (!text && !url) throw new ApiError('BAD_REQUEST', '需要提供 text 或 url');

  let parsed;
  if (text) {
    parsed = parseImportText(text);
    if (parsed.error) throw new ApiError('BAD_REQUEST', parsed.error);
  }
  const opts = { mode, group, enabled: enabled === undefined ? undefined : Boolean(enabled) };

  let result;
  if (url) {
    const r = await importFromUrl(url, opts);
    if (text) {
      const r2 = importSources(parsed.sources, opts);
      result = {
        added: r.added + r2.added, updated: r.updated + r2.updated,
        skipped: r.skipped + r2.skipped, failed: [...r.failed, ...r2.failed],
        total: r.total + r2.total,
      };
    } else result = r;
  } else {
    result = importSources(parsed.sources, opts);
  }

  log.info('导入书源：新增 ' + result.added + ' 更新 ' + result.updated + ' 跳过 ' + result.skipped + ' 失败 ' + result.failed.length);
  ok(c.res, result);
});

route('POST', '/api/sources/import-url', async (c) => {
  const { url, mode = 'append', group = '', enabled } = c.body || {};
  if (!url) throw new ApiError('BAD_REQUEST', '缺少 url');
  const result = await importFromUrl(String(url), { mode, group, enabled: enabled === undefined ? undefined : Boolean(enabled) });
  ok(c.res, result);
});

route('GET', '/api/sources/export', (c) => {
  const ids = c.query.ids ? String(c.query.ids).split(',').map((x) => Number(x.trim())).filter(Number.isFinite) : null;
  const list = listSourceIds({ ids, enabledOnly: toBool(c.query.enabledOnly, false) });
  const data = exportSources(list);
  if (toBool(c.query.download, false)) {
    const body = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    c.res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Content-Disposition': 'attachment; filename="shuhai-sources-' + new Date().toISOString().slice(0, 10) + '.json"',
    });
    c.res.end(body);
    return;
  }
  ok(c.res, data);
});

/** 用关键字真实跑一次搜索来验证书源 */
async function testSourceObject(sourceObj, keyword) {
  const kw = keyword || '斗破苍穹';
  const t0 = Date.now();
  const result = { ok: false, elapsed: 0, count: 0, samples: [], error: '', log: [] };
  try {
    const r = await searchSource({ ...sourceObj, id: sourceObj.id ?? 0, name: sourceObj.name || '(预览)' }, kw, 1, { timeout: 20000, limit: 10 });
    result.ok = r.items.length > 0;
    result.count = r.items.length;
    result.samples = r.items.slice(0, 3).map((i) => ({ name: i.name, author: i.author, bookUrl: i.bookUrl }));
    if (r.warnings?.length) result.log = r.warnings;
    if (!result.ok) result.error = '搜索成功但未解析出任何结果，请检查 bookList 及字段规则';
  } catch (err) {
    result.error = err.message;
    result.log.push(err.code || 'ERROR');
  }
  result.elapsed = Date.now() - t0;
  return result;
}

route('POST', '/api/sources/test', async (c) => {
  const id = Number(c.body?.id);
  if (!id) throw new ApiError('BAD_REQUEST', '缺少 id');
  const s = getSource(id);
  if (!s) throw new ApiError('NOT_FOUND', '书源不存在', 404);
  const sourceObj = loadSourceForBook(id);
  const result = await testSourceObject(sourceObj, c.body?.keyword);
  // 单源测试同样落库，前端列表才能显示「可用 / 失效」徽标
  recordTestResult(id, { ok: result.ok, count: result.count, elapsed: result.elapsed, error: result.error });
  ok(c.res, result);
});

/* ---------------- 批量体检（批量测试 / 一键删除失效源） ---------------- */

/** 按列表页同一套筛选条件圈定书源（分页取全，最多 20 页 / 4000 条） */
function collectFiltered({ q = '', group = '', status = '', enabled = null }) {
  const targets = [];
  for (let page = 1; page <= 20; page++) {
    const r = listSources({ q, group, status, enabled, page, limit: 200 });
    targets.push(...r.items);
    if (!r.items.length || targets.length >= r.total) break;
  }
  return targets;
}

/** 解析批量体检的目标范围：给了 ids 就用 ids，否则按筛选条件取（与列表页一致） */
function pickTestTargets(input = {}) {
  const rawIds = Array.isArray(input.ids) ? input.ids : (input.ids ? String(input.ids).split(',') : []);
  const ids = rawIds.map((x) => Number(String(x).trim())).filter(Number.isFinite);
  const q = String(input.q || '').trim();
  const group = String(input.group || '').trim();
  const status = ['ok', 'fail', 'untested'].includes(String(input.status || '')) ? String(input.status) : '';
  let enabled = null;
  if (input.enabled === '1' || input.enabled === 1 || input.enabled === true) enabled = true;
  else if (input.enabled === '0' || input.enabled === 0 || input.enabled === false) enabled = false;
  if (toBool(input.enabledOnly, false)) enabled = true; // 兼容旧参数
  const keyword = String(input.keyword || '').trim() || undefined;
  const concurrency = Math.min(Math.max(toInt(input.concurrency, 6), 1), 16);
  const targets = ids.length
    ? listSourceIds({ ids })
    : collectFiltered({ q, group, status, enabled });
  return { targets, ids, keyword, concurrency, q, group, status, enabled };
}

/**
 * 并发跑一批书源的体检，结果写回库。
 * @param {object[]} targets  书源行（至少含 id/name）
 * @param {(item:object, done:number, total:number)=>void} [onResult] 每完成一个回调（用于 SSE 推送）
 */
async function runBatchTest(targets, { keyword, concurrency = 6, onResult } = {}) {
  const started = Date.now();
  const results = new Array(targets.length);
  let cursor = 0;
  let done = 0;

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      const s = targets[i];
      let item;
      try {
        const sourceObj = loadSourceForBook(s.id);
        if (!sourceObj) throw new Error('书源不存在');
        const r = await testSourceObject(sourceObj, keyword);
        item = { id: s.id, name: s.name, ok: r.ok, count: r.count, elapsed: r.elapsed, error: r.error || '', samples: r.samples || [] };
      } catch (err) {
        item = { id: s.id, name: s.name, ok: false, count: 0, elapsed: 0, error: err.message || '测试失败', samples: [] };
      }
      recordTestResult(s.id, { ok: item.ok, count: item.count, elapsed: item.elapsed, error: item.error });
      results[i] = item;
      done += 1;
      if (onResult) { try { onResult(item, done, targets.length); } catch { /* 客户端断开时忽略 */ } }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, targets.length || 1)) }, worker));
  const list = results.filter(Boolean);
  return {
    total: list.length,
    ok: list.filter((x) => x.ok).length,
    fail: list.filter((x) => !x.ok).length,
    took: Date.now() - started,
    results: list,
    stats: sourceTestStats(),
  };
}

route('POST', '/api/sources/test-batch', async (c) => {
  const { targets, keyword, concurrency } = pickTestTargets(c.body || {});
  if (!targets.length) throw new ApiError('BAD_REQUEST', '没有需要测试的书源');
  const summary = await runBatchTest(targets, { keyword, concurrency });
  log.info('批量书源体检：' + summary.total + ' 个，可用 ' + summary.ok + ' 失效 ' + summary.fail + '，耗时 ' + summary.took + 'ms');
  ok(c.res, summary);
});

/** SSE 版批量体检：逐个推送结果，前端可显示实时进度 */
route('GET', '/api/sources/test-batch/stream', async (c) => {
  const { targets, keyword, concurrency } = pickTestTargets(c.query || {});
  if (!targets.length) throw new ApiError('BAD_REQUEST', '没有需要测试的书源');

  const res = c.res;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  let closed = false;
  c.req.on('close', () => { closed = true; });
  const ping = setInterval(() => {
    if (closed) return;
    try { res.write(': ping\n\n'); } catch { closed = true; }
  }, 15000);

  const send = (event, data) => {
    if (closed) return;
    try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch { closed = true; }
  };

  try {
    send('start', { total: targets.length, keyword: keyword || '斗破苍穹', concurrency });
    const summary = await runBatchTest(targets, {
      keyword, concurrency,
      onResult: (item, done, total) => send('result', { ...item, done, total }),
    });
    send('done', { total: summary.total, ok: summary.ok, fail: summary.fail, took: summary.took, stats: summary.stats });
    log.info('批量书源体检(SSE)：' + summary.total + ' 个，可用 ' + summary.ok + ' 失效 ' + summary.fail);
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    clearInterval(ping);
    if (!closed) res.end();
  }
});

/**
 * 一键删除失效书源。
 * 只删「测试过且失败」的（未测试的绝不动），retest=1 时先重新体检一遍再删。
 */
route('POST', '/api/sources/delete-invalid', async (c) => {
  const body = c.body || {};
  const retest = toBool(body.retest, false);
  const { targets, keyword, concurrency } = pickTestTargets(body);
  // 删除范围与测试范围保持一致：只在「本次圈定的书源」里删失效的，绝不越界
  const scopeIds = targets.map((t) => t.id);

  let tested = 0;
  if (retest && targets.length) {
    const summary = await runBatchTest(targets, { keyword, concurrency });
    tested = summary.total;
  }

  const invalidIds = scopeIds.length ? listInvalidSourceIds({ ids: scopeIds }) : [];
  const items = invalidIds.map((id) => {
    const s = getSource(id);
    return { id, name: s?.name || '', error: s?.lastTestError || '' };
  });
  const deleted = invalidIds.length ? deleteSources(invalidIds) : 0;
  log.warn('一键清理失效书源：范围 ' + scopeIds.length + ' 个，删除 ' + deleted + ' 个' + (retest ? '（重新体检 ' + tested + ' 个后）' : ''));
  ok(c.res, { tested, deleted, ids: invalidIds, items, scope: scopeIds.length, stats: sourceTestStats() });
});

route('POST', '/api/sources/preview', async (c) => {
  const raw = c.body?.raw;
  if (!raw || typeof raw !== 'object') throw new ApiError('BAD_REQUEST', '缺少 raw（书源对象）');
  const { source, issues } = normalizeSource(raw);
  const result = await testSourceObject({ ...source, id: 0 }, c.body?.keyword);
  ok(c.res, { ...result, issues });
});

route('GET', '/api/sources/:id', (c) => {
  const s = getSource(c.params.id);
  if (!s) throw new ApiError('NOT_FOUND', '书源不存在', 404);
  const { _raw, ...rest } = s;
  ok(c.res, { source: rest, raw: getSourceRaw(c.params.id) || {} });
});

route('POST', '/api/sources', (c) => {
  const raw = c.body;
  if (!raw || typeof raw !== 'object') throw new ApiError('BAD_REQUEST', '请求体必须是书源 JSON 对象');
  const result = importSources([raw], { mode: 'append' });
  if (result.failed.length) throw new ApiError('BAD_REQUEST', result.failed[0].error);
  if (result.skipped) throw new ApiError('CONFLICT', '同名同地址的书源已存在', 409);
  const id = result.added ? undefined : undefined;
  // 找到刚创建的那条
  const list = listSources({ q: '', limit: 200 });
  const created = list.items.find((x) => x.name === (raw.bookSourceName || raw.name) && x.url === normalizeSource(raw).source.url);
  const s = created ? getSource(created.id) : null;
  if (!s) throw new ApiError('INTERNAL', '创建后无法读取书源', 500);
  const { _raw, ...rest } = s;
  ok(c.res, { source: rest, raw: getSourceRaw(s.id) || {} }, 201);
});

route('PUT', '/api/sources/:id', (c) => {
  const s = updateSource(c.params.id, c.body);
  if (!s) throw new ApiError('NOT_FOUND', '书源不存在', 404);
  ok(c.res, s);
});

route('PATCH', '/api/sources/:id', (c) => {
  const s = patchSource(c.params.id, c.body || {});
  if (!s) throw new ApiError('NOT_FOUND', '书源不存在', 404);
  ok(c.res, s);
});

route('DELETE', '/api/sources/:id', (c) => {
  const n = deleteSources([Number(c.params.id)]);
  if (!n) throw new ApiError('NOT_FOUND', '书源不存在', 404);
  ok(c.res, { deleted: n });
});

/* ============================ 搜索 ============================ */

/**
 * 取出可参与搜索的书源 —— 必须是「引擎就绪」的规范化对象
 * （含 searchUrl / ruleSearch / header 等），不能用 API 展示用字段。
 */
function pickSourcesForSearch(c) {
  const { sources, groups } = c.query;

  let ids;
  if (sources) {
    ids = String(sources).split(',').map((x) => Number(x.trim())).filter(Number.isFinite);
  } else {
    ids = all('SELECT id FROM sources WHERE enabled = 1 ORDER BY weight DESC, sort_order ASC, id ASC').map((r) => r.id);
  }

  let objs = ids.map((id) => loadSourceForBook(id)).filter((s) => s && s.searchUrl);
  if (groups) {
    const wanted = String(groups).split(',').map((g) => g.trim()).filter(Boolean);
    objs = objs.filter((s) => {
      const mine = String(s.group || '').split(/[,;，；]/).map((x) => x.trim());
      return wanted.some((g) => mine.includes(g));
    });
  }
  return objs;
}

function relevance(item, query) {
  const n = String(item.name || '').toLowerCase();
  const a = String(item.author || '').toLowerCase();
  const k = String(query || '').toLowerCase().trim();
  if (!k) return 0;
  let s = 0;
  if (n === k) s += 100;
  else if (n.startsWith(k)) s += 82;
  else if (n.includes(k)) s += 62;
  else if (k.length > 1 && k.split('').every((ch) => n.includes(ch))) s += 28;
  if (a) {
    if (a === k) s += 95;
    else if (a.includes(k)) s += 52;
    else if (k.includes(a)) s += 30;
  }
  if (item.coverUrl) s += 2;
  if (item.intro) s += 2;
  if (item.lastChapter) s += 1;
  return Math.min(120, s);
}

/**
 * 打分排序 + 搜索模式过滤。
 * @param {'fuzzy'|'exact'} [opts.match] exact 只保留书名/作者与关键字完全一致的条目
 * @param {'all'|'name'|'author'} [opts.type]
 */
function finalizeSearch(items, query, sourceWeight, opts = {}) {
  const match = opts.match === 'exact' ? 'exact' : 'fuzzy';
  const type = opts.type || 'all';
  const list = match === 'exact' ? items.filter((it) => isExactMatch(it, query, type)) : items;
  const scored = list.map((it) => ({
    ...it,
    score: relevance(it, query) + Math.min(8, (sourceWeight?.get(it.sourceId) || 0) / 25),
  }));
  scored.sort((a, b) => b.score - a.score || a.sourceName.localeCompare(b.sourceName));
  return scored;
}

/** 解析搜索模式参数：match=exact 精确，其它（含缺省）为模糊 */
const parseMatch = (v) => (String(v || '').toLowerCase() === 'exact' ? 'exact' : 'fuzzy');

route('GET', '/api/search', async (c) => {
  const q = String(c.query.q || '').trim();
  if (!q) throw new ApiError('BAD_REQUEST', '缺少搜索关键字 q');
  const type = String(c.query.type || 'all');
  const sources = pickSourcesForSearch(c);
  if (!sources.length) throw new ApiError('BAD_REQUEST', '没有可用的书源，请先在「书源管理」中导入并启用书源');

  const limit = toInt(c.query.limit, 60);
  const timeout = toInt(c.query.timeout, 15000);
  const dedupe = toBool(c.query.dedupe, true);
  const match = parseMatch(c.query.match);

  const { results, took } = await searchAll(sources, q, { timeout, limit });
  const weight = new Map(sources.map((s) => [s.id, s.weight || 0]));

  const all = [];
  for (const r of results) all.push(...r.items);
  const merged = aggregateResults(all, { dedupe });
  const items = finalizeSearch(merged, q, weight, { match, type });
  // 只有主来源保留 origins 里的完整列表，避免响应过大
  for (const it of items) {
    if (it.origins && it.origins.length > 12) it.origins = it.origins.slice(0, 12);
  }

  addSearchHistory(q, type);
  ok(c.res, {
    items: items.slice(0, Math.min(limit * 4, 400)),
    total: items.length,
    took,
    match,
    sources: results.map((r) => ({
      id: r.source.id, name: r.source.name, ok: r.ok, count: r.items.length, elapsed: r.elapsed, error: r.error || '',
    })),
  });
});

route('GET', '/api/search/stream', async (c) => {
  const q = String(c.query.q || '').trim();
  if (!q) throw new ApiError('BAD_REQUEST', '缺少搜索关键字 q');
  const sources = pickSourcesForSearch(c);
  if (!sources.length) throw new ApiError('BAD_REQUEST', '没有可用的书源，请先导入并启用书源');

  const res = c.res;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  let closed = false;
  c.req.on('close', () => { closed = true; });
  const ping = setInterval(() => {
    if (closed) return;
    try { res.write(': ping\n\n'); } catch { closed = true; }
  }, 15000);

  const send = (event, data) => {
    if (closed) return;
    try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch { closed = true; }
  };

  const weight = new Map(sources.map((s) => [s.id, s.weight || 0]));
  const timeout = toInt(c.query.timeout, 15000);
  const limit = toInt(c.query.limit, 60);
  const match = parseMatch(c.query.match);

  try {
    const { took, total } = await searchAllStream(sources, q, { timeout, limit }, async (payload) => {
      const items = finalizeSearch(payload.items || [], q, weight, { match, type: String(c.query.type || 'all') });
      send('source', { ...payload, items });
    });
    send('done', { total, took, keyword: q });
    addSearchHistory(q, String(c.query.type || 'all'));
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    clearInterval(ping);
    if (!closed) res.end();
  }
});

route('GET', '/api/search/history', (c) => {
  ok(c.res, listSearchHistory(toInt(c.query.limit, 20)));
});

route('DELETE', '/api/search/history', (c) => {
  ok(c.res, { deleted: clearSearchHistory() });
});

route('GET', '/api/search/hot', async (c) => {
  // 对配置了 exploreUrl 的书源做 "尽力而为" 的榜单抓取：
  // 单个源失败只跳过它，不影响整体；一个都没有就返回空数组。
  const sources = pickSourcesForSearch(c);
  if (!sources.length) { ok(c.res, []); return; }
  const groups = await fetchExplore(sources, {
    maxSources: toInt(c.query.sources, 6),
    maxGroupsPerSource: toInt(c.query.groups, 3),
    limit: toInt(c.query.limit, 20),
    timeout: toInt(c.query.timeout, 12000),
  });
  ok(c.res, groups);
});

route('GET', '/api/sources/:id/search', async (c) => {
  const q = String(c.query.q || '').trim();
  if (!q) throw new ApiError('BAD_REQUEST', '缺少 q');
  const source = loadSourceForBook(c.params.id);
  if (!source) throw new ApiError('NOT_FOUND', '书源不存在', 404);
  const page = toInt(c.query.page, 1);
  const r = await searchSource(source, q, page, { timeout: toInt(c.query.timeout, 20000), limit: toInt(c.query.limit, 60) });
  const match = parseMatch(c.query.match);
  const items = match === 'exact'
    ? r.items.filter((it) => isExactMatch(it, q, String(c.query.type || 'all')))
    : r.items;
  ok(c.res, { items, page, match, hasMore: r.items.length >= 20 });
});

/* ============================ 书籍 ============================ */

route('GET', '/api/books/:id', async (c) => {
  const id = Number(c.params.id);
  let book = getBook(id);
  if (!book) throw new ApiError('NOT_FOUND', '书籍不存在', 404);
  if (toBool(c.query.refresh, false)) book = await refreshBookInfo(id, { timeout: toInt(c.query.timeout, 15000) });
  ok(c.res, book);
});

route('POST', '/api/books/resolve', async (c) => {
  const b = c.body || {};
  if (!b.sourceId || !b.bookUrl) throw new ApiError('BAD_REQUEST', '需要 sourceId 与 bookUrl');
  const book = await resolveBook(b, { timeout: toInt(b.timeout, 15000) });
  ok(c.res, book);
});

route('GET', '/api/books/:id/chapters', async (c) => {
  const id = Number(c.params.id);
  if (!getBook(id)) throw new ApiError('NOT_FOUND', '书籍不存在', 404);
  const r = await ensureChapters(id, { refresh: toBool(c.query.refresh, false), timeout: toInt(c.query.timeout, 25000) });
  ok(c.res, { items: r.items, total: r.items.length, fromCache: r.fromCache, pages: r.pages, warnings: r.warnings || [] });
});

route('GET', '/api/books/:id/content', async (c) => {
  const id = Number(c.params.id);
  if (!getBook(id)) throw new ApiError('NOT_FOUND', '书籍不存在', 404);

  let index = c.query.index === undefined ? null : toInt(c.query.index, null);
  if (index === null && c.query.url) {
    const row = get('SELECT idx FROM chapters WHERE book_id = ? AND url = ?', id, String(c.query.url));
    if (row) index = row.idx;
  }
  if (index === null) throw new ApiError('BAD_REQUEST', '需要 index 或 url 参数');

  const r = await getChapterContent(id, index, {
    refresh: toBool(c.query.refresh, false),
    timeout: toInt(c.query.timeout, 20000),
  });
  ok(c.res, r);
});

route('POST', '/api/books/:id/cache', (c) => {
  const id = Number(c.params.id);
  if (!getBook(id)) throw new ApiError('NOT_FOUND', '书籍不存在', 404);
  const total = getChapters(id).length;
  const from = c.body?.from === undefined ? 0 : toInt(c.body.from, 0);
  const to = c.body?.to === undefined ? total - 1 : toInt(c.body.to, total - 1);
  const r = startCacheJob(id, from, to, { concurrency: toInt(c.body?.concurrency, 3) });
  ok(c.res, r);
});

route('GET', '/api/books/:id/cache', (c) => {
  const id = Number(c.params.id);
  if (!getBook(id)) throw new ApiError('NOT_FOUND', '书籍不存在', 404);
  ok(c.res, getCacheState(id));
});

route('GET', '/api/books/:id/search', (c) => {
  const id = Number(c.params.id);
  if (!getBook(id)) throw new ApiError('NOT_FOUND', '书籍不存在', 404);
  ok(c.res, searchChapters(id, c.query.q));
});

// 流式换源：边搜边推，第一个候选通常 1~2 秒内就出现，
// 而不是让用户盯着转圈等十几秒（几百个书源时的核心体验问题）。
route('GET', '/api/books/:id/alternatives/stream', async (c) => {
  const id = Number(c.params.id);
  if (!getBook(id)) throw new ApiError('NOT_FOUND', '书籍不存在', 404);

  const res = c.res;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  let closed = false;
  c.req.on('close', () => { closed = true; });
  const ping = setInterval(() => {
    if (closed) return;
    try { res.write(': ping\n\n'); } catch { closed = true; }
  }, 15000);

  const send = (data) => {
    if (closed) return;
    try { res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch { closed = true; }
  };

  try {
    await findAlternativesStream(id, {
      timeout: toInt(c.query.timeout, 6000),
      limit: toInt(c.query.limit, 40),
      maxSources: toInt(c.query.maxSources, 40),
      noCache: toBool(c.query.refresh, false),
    }, send);
  } catch (err) {
    send({ type: 'error', code: err.code || 'INTERNAL', message: err.message });
  } finally {
    clearInterval(ping);
    if (!closed) res.end();
  }
});

route('GET', '/api/books/:id/alternatives', async (c) => {
  const id = Number(c.params.id);
  if (!getBook(id)) throw new ApiError('NOT_FOUND', '书籍不存在', 404);
  const r = await findAlternatives(id, {
    timeout: toInt(c.query.timeout, 8000),
    limit: toInt(c.query.limit, 40),
    maxSources: toInt(c.query.maxSources, 40),
    noCache: toBool(c.query.refresh, false),
  });
  // 契约就是 {items:SearchResult[]}；早期这里直接把数组塞进 data，
  // 前端按 data.items 读 → 永远拿不到候选，表现为「换源里一个来源都没有」
  ok(c.res, { items: r.items, total: r.items.length, searched: r.searched || 0, fromCache: !!r.fromCache });
});

route('POST', '/api/books/:id/change-source', async (c) => {
  const id = Number(c.params.id);
  const { sourceId, bookUrl, keepProgress } = c.body || {};
  if (!sourceId || !bookUrl) throw new ApiError('BAD_REQUEST', '需要 sourceId 与 bookUrl');
  const book = await changeSource(id, { sourceId, bookUrl, keepProgress: keepProgress !== false });
  ok(c.res, book);
});

route('DELETE', '/api/books/:id', (c) => {
  const n = deleteBook(c.params.id);
  if (!n) throw new ApiError('NOT_FOUND', '书籍不存在', 404);
  ok(c.res, { deleted: n });
});

/* ============================ 书架 ============================ */

route('GET', '/api/shelf', (c) => {
  ok(c.res, listShelf());
});

route('POST', '/api/shelf', (c) => {
  const b = c.body || {};
  let bookId = b.bookId ? Number(b.bookId) : 0;
  if (!bookId) {
    if (!b.sourceId || !b.bookUrl) throw new ApiError('BAD_REQUEST', '需要 bookId 或 sourceId+bookUrl');
    // 未落地过的书先创建一条最小记录
    const existing = get('SELECT id FROM books WHERE source_id = ? AND book_url = ?', Number(b.sourceId), String(b.bookUrl));
    if (existing) bookId = existing.id;
    else {
      const t = Date.now();
      const r = dbRun(
        'INSERT INTO books (source_id, book_url, name, author, cover, intro, kind, last_chapter, word_count, status, toc_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        Number(b.sourceId), String(b.bookUrl), String(b.name || ''), String(b.author || ''), String(b.cover || ''),
        String(b.intro || ''), String(b.kind || ''), String(b.lastChapter || ''), String(b.wordCount || ''), '',
        String(b.bookUrl), t, t,
      );
      bookId = r.lastInsertRowid;
    }
  }
  const book = addToShelf(bookId, b.group || '');
  if (!book) throw new ApiError('NOT_FOUND', '书籍不存在', 404);
  ok(c.res, book);
});

route('DELETE', '/api/shelf/:bookId', (c) => {
  ok(c.res, { removed: removeFromShelf(c.params.bookId) });
});

route('PATCH', '/api/shelf/:bookId', (c) => {
  const book = patchShelf(c.params.bookId, c.body || {});
  if (!book) throw new ApiError('NOT_FOUND', '书籍不存在', 404);
  ok(c.res, book);
});

/* ============================ 进度 / 书签 ============================ */

route('GET', '/api/progress/:bookId', (c) => {
  ok(c.res, getProgress(c.params.bookId));
});

route('PUT', '/api/progress/:bookId', (c) => {
  ok(c.res, saveProgress(c.params.bookId, c.body || {}));
});

// 浏览器 navigator.sendBeacon 只能发 POST，而页面卸载时的进度兜底上报正是用它。
// 这里提供等价的 POST 别名，保证"关页面也能存住阅读位置"。
route('POST', '/api/progress/:bookId', (c) => {
  ok(c.res, saveProgress(c.params.bookId, c.body || {}));
});

route('GET', '/api/bookmarks', (c) => {
  const list = listBookmarks(c.query.bookId ? Number(c.query.bookId) : null);
  ok(c.res, list);
});

route('GET', '/api/notes', (c) => {
  const list = listBookmarks(c.query.bookId ? Number(c.query.bookId) : null).filter((b) => b.note && b.note.trim());
  ok(c.res, list);
});

route('POST', '/api/bookmarks', (c) => {
  const b = c.body || {};
  if (!b.bookId) throw new ApiError('BAD_REQUEST', '缺少 bookId');
  ok(c.res, addBookmark(b), 201);
});

route('PATCH', '/api/bookmarks/:id', (c) => {
  const r = updateBookmark(c.params.id, c.body || {});
  if (!r) throw new ApiError('NOT_FOUND', '书签不存在', 404);
  ok(c.res, r);
});

route('DELETE', '/api/bookmarks/:id', (c) => {
  ok(c.res, { deleted: deleteBookmark(c.params.id) });
});

/* ============================ 设置 ============================ */

route('GET', '/api/settings', (c) => {
  ok(c.res, loadSettings());
});

route('PUT', '/api/settings', (c) => {
  ok(c.res, saveSettings(c.body || {}));
});

route('POST', '/api/settings/reset', (c) => {
  ok(c.res, resetSettings());
});

route('GET', '/api/settings/presets', (c) => {
  ok(c.res, PRESETS);
});

route('GET', '/api/settings/defaults', (c) => {
  ok(c.res, DEFAULT_SETTINGS);
});

route('POST', '/api/cache/clear', (c) => {
  ok(c.res, { cleared: clearContentCache() });
});

/* ============================ 请求入口 ============================ */

/**
 * 处理一个 API 请求。
 * @returns {Promise<boolean>} 是否已处理（未匹配任何路由返回 false）
 */
export async function handleApi(req, res, urlObj, body) {
  const pathname = urlObj.pathname;
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;

    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const query = Object.fromEntries(urlObj.searchParams.entries());

    try {
      await r.handler({ req, res, params, query, body, url: urlObj });
    } catch (err) {
      if (res.writableEnded) return true;
      const code = err instanceof ApiError ? err.code : (err.code || 'INTERNAL');
      const status = err instanceof ApiError ? err.status : statusForCode(code);
      if (status >= 500) log.error('API ' + r.pattern + ' 失败: ' + err.message);
      fail(res, code, err.message, status);
    }
    return true;
  }
  return false;
}

export { ApiError };
