/**
 * 书籍数据层 —— 书籍落地、目录缓存、正文缓存、书架、进度、书签。
 *
 * 缓存策略：
 *  - 目录（chapters）持久化，除非显式 refresh；
 *  - 正文（contents）读时缓存，命中即不再回源；
 *  - 缓存任务在后台并发执行，进度可查询。
 */

import { run, get, all, now } from './db.mjs';
import {
  fetchBookInfo, fetchToc, fetchContent, searchSource, searchAll, searchAllStream,
  scoreMatch, mapLimit, SourceError,
} from './engine.mjs';
import { getSourceRow } from './source.mjs';
import { normalizeSource } from './source.mjs';
import { absUrl } from './net/http.mjs';
import * as log from './log.mjs';

/* ------------------------------ 工具 ------------------------------ */

function bookmarkCount(bookId) {
  return Number(get('SELECT COUNT(*) c FROM bookmarks WHERE book_id = ?', bookId)?.c || 0);
}

function chapterCount(bookId) {
  return Number(get('SELECT COUNT(*) c FROM chapters WHERE book_id = ?', bookId)?.c || 0);
}

function rowToBook(row) {
  if (!row) return null;
  const src = get('SELECT name FROM sources WHERE id = ?', row.source_id);
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceName: src?.name || '(书源已删除)',
    bookUrl: row.book_url,
    name: row.name,
    author: row.author,
    cover: row.cover,
    intro: row.intro,
    kind: row.kind,
    lastChapter: row.last_chapter,
    wordCount: row.word_count,
    status: row.status,
    tocUrl: row.toc_url,
    chapterCount: chapterCount(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    inShelf: Boolean(get('SELECT 1 x FROM shelf WHERE book_id = ?', row.id)),
  };
}

/** 读取书源（规范化后的完整对象，供引擎使用） */
export function loadSourceForBook(sourceId) {
  const row = getSourceRow(sourceId);
  if (!row) return null;
  let raw = {};
  try { raw = JSON.parse(row.raw); } catch { /* 忽略 */ }
  const { source } = normalizeSource(raw);
  return { ...source, id: row.id, enabled: Boolean(row.enabled), weight: row.weight };
}

/* ------------------------------ 书籍 ------------------------------ */

export function getBook(id) {
  return rowToBook(get('SELECT * FROM books WHERE id = ?', Number(id)));
}

export function findBook(sourceId, bookUrl) {
  return rowToBook(get('SELECT * FROM books WHERE source_id = ? AND book_url = ?', Number(sourceId), String(bookUrl)));
}

function insertBook(sourceId, bookUrl, fields) {
  const t = now();
  const r = run(
    'INSERT INTO books (source_id, book_url, name, author, cover, intro, kind, last_chapter, word_count, status, toc_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    Number(sourceId), String(bookUrl),
    fields.name || '', fields.author || '', fields.cover || '', fields.intro || '',
    fields.kind || '', fields.lastChapter || '', fields.wordCount || '', fields.status || '',
    fields.tocUrl || '', t, t,
  );
  return r.lastInsertRowid;
}

function updateBookFields(id, fields) {
  const map = {
    name: 'name', author: 'author', cover: 'cover', intro: 'intro', kind: 'kind',
    lastChapter: 'last_chapter', wordCount: 'word_count', status: 'status', tocUrl: 'toc_url',
  };
  const sets = [];
  const params = [];
  for (const k in map) {
    if (fields[k] !== undefined && fields[k] !== null && String(fields[k]).trim() !== '') {
      sets.push(map[k] + ' = ?');
      params.push(String(fields[k]));
    }
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  params.push(now(), Number(id));
  run('UPDATE books SET ' + sets.join(', ') + ' WHERE id = ?', ...params);
}

/**
 * 把一次搜索结果落地成书籍记录，并尽力补全详情。
 * @param {{sourceId:number, bookUrl:string, name?:string, author?:string, cover?:string, intro?:string, kind?:string, lastChapter?:string, wordCount?:string}} input
 * @param {{refresh?:boolean, timeout?:number}} [opts]
 */
export async function resolveBook(input, opts = {}) {
  const sourceId = Number(input.sourceId);
  const rawBookUrl = String(input.bookUrl || '').trim();
  if (!sourceId || !rawBookUrl) throw new SourceError('缺少 sourceId 或 bookUrl', 'BAD_REQUEST');

  const source = loadSourceForBook(sourceId);
  if (!source) throw new SourceError('书源不存在（可能已被删除）', 'NOT_FOUND');

  // 搜索结果里的相对路径必须先补全，否则入库后点「阅读」拿它去请求必然失败
  const bookUrl = normalizeBookUrl(rawBookUrl, source.url);

  let book = findBook(sourceId, bookUrl);
  if (!book && bookUrl !== rawBookUrl) {
    // 兼容历史脏数据：早期版本把相对地址原样入库了，这里顺手迁移成绝对地址
    const legacy = findBook(sourceId, rawBookUrl);
    if (legacy) {
      run('UPDATE books SET book_url = ?, updated_at = ? WHERE id = ?', bookUrl, now(), legacy.id);
      book = getBook(legacy.id);
      log.info('书籍地址已从相对路径修正为绝对地址: ' + rawBookUrl + ' → ' + bookUrl);
    }
  }
  if (!book) {
    const id = insertBook(sourceId, bookUrl, {
      name: input.name || '', author: input.author || '', cover: input.cover || '',
      intro: input.intro || '', kind: input.kind || '', lastChapter: input.lastChapter || '',
      wordCount: input.wordCount || '',
    });
    book = rowToBook(get('SELECT * FROM books WHERE id = ?', id));
  }

  // 补全详情：详情页信息通常比搜索结果全（简介、封面、tocUrl 都在这）
  const needsInfo = opts.refresh || !book.tocUrl || !book.intro || !book.cover;
  if (needsInfo) {
    try {
      const info = await fetchBookInfo(source, bookUrl, { timeout: opts.timeout });
      updateBookFields(book.id, {
        name: info.name || book.name,
        author: info.author || book.author,
        cover: info.cover || book.cover,
        intro: info.intro || book.intro,
        kind: info.kind || book.kind,
        lastChapter: info.lastChapter || book.lastChapter,
        wordCount: info.wordCount || book.wordCount,
        status: info.status || book.status,
        tocUrl: info.tocUrl || bookUrl,
      });
      book = getBook(book.id);
    } catch (err) {
      log.warn('补全书籍详情失败 [' + source.name + '] ' + bookUrl + ': ' + err.message);
      if (!book.tocUrl) {
        run('UPDATE books SET toc_url = ?, updated_at = ? WHERE id = ?', bookUrl, now(), book.id);
        book = getBook(book.id);
      }
      book.infoError = err.message;
    }
  }
  return book;
}

export async function refreshBookInfo(bookId, opts = {}) {
  const book = getBook(bookId);
  if (!book) throw new SourceError('书籍不存在', 'NOT_FOUND');
  const source = loadSourceForBook(book.sourceId);
  if (!source) throw new SourceError('书源不存在', 'NOT_FOUND');
  const info = await fetchBookInfo(source, book.bookUrl, opts);
  updateBookFields(bookId, {
    name: info.name, author: info.author, cover: info.cover, intro: info.intro,
    kind: info.kind, lastChapter: info.lastChapter, wordCount: info.wordCount,
    status: info.status, tocUrl: info.tocUrl || book.bookUrl,
  });
  return getBook(bookId);
}

export function deleteBook(bookId) {
  const id = Number(bookId);
  run('DELETE FROM chapters WHERE book_id = ?', id);
  run('DELETE FROM contents WHERE book_id = ?', id);
  run('DELETE FROM shelf WHERE book_id = ?', id);
  run('DELETE FROM progress WHERE book_id = ?', id);
  run('DELETE FROM bookmarks WHERE book_id = ?', id);
  return run('DELETE FROM books WHERE id = ?', id).changes;
}

/* ------------------------------ 目录 ------------------------------ */

export function getChapters(bookId) {
  const rows = all('SELECT idx, title, url, is_volume FROM chapters WHERE book_id = ? ORDER BY idx ASC', Number(bookId));
  const cached = new Set(
    all('SELECT idx FROM contents WHERE book_id = ?', Number(bookId)).map((r) => r.idx),
  );
  return rows.map((r) => ({
    index: r.idx,
    title: r.title,
    url: r.url,
    isVolume: Boolean(r.is_volume),
    cached: cached.has(r.idx),
  }));
}

export function saveChapters(bookId, chapters) {
  const id = Number(bookId);
  run('DELETE FROM chapters WHERE book_id = ?', id);
  const stmt = 'INSERT INTO chapters (book_id, idx, title, url, is_volume) VALUES (?,?,?,?,?)';
  let i = 0;
  for (const ch of chapters) {
    run(stmt, id, i++, ch.title || '', ch.url || '', ch.isVolume ? 1 : 0);
  }
  return i;
}

/**
 * 确保目录存在；refresh 或缓存为空时回源。
 * @returns {Promise<{items:Array, fromCache:boolean, pages?:number, warnings?:string[]}>}
 */
/**
 * 判断存下来的目录地址是否可用。
 *
 * 为什么需要：书源的 tocUrl 规则可能解析出脏数据（例如早期规则引擎的 bug 把
 * `@js:` 的返回值 JSON 化了，存成 `["('/b/1.html', '', '')","/b/1.html"]`），
 * 这种地址拿去请求必然 404，而书一旦入库就会一直 404——表现出来就是
 * 「点阅读提示 HTTP 404 Not Found」。这里主动识别并在加载时自愈。
 */
export function absoluteUrlLooksValid(url) {
  const s = String(url || '').trim();
  if (!s) return false;
  if (!/^https?:\/\//i.test(s)) return false;      // 必须是绝对地址
  if (/[\[\]"'()\s]/.test(s)) return false;        // 不能含引号/括号/空格等脏字符
  try { new URL(s); } catch { return false; }
  return true;
}

/** 兼容旧调用名 */
export const tocUrlLooksValid = absoluteUrlLooksValid;

/**
 * 把书籍地址规范成可直接请求的绝对地址。
 *
 * 只对「明显是站内路径」的值做补全（以 / ./ ../ 开头）——
 * 因为有些书源的 bookUrl 本身就是站点内部 ID（例如 "1159212932"），
 * 那种值必须原样保留，由书源自己的 tocUrl 规则去拼完整地址。
 */
export function normalizeBookUrl(url, sourceUrl) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) {
    return absUrl(sourceUrl, s) || s;
  }
  return s;
}

/**
 * 生成目录地址候选链（按优先级），用于「一个地址拿不到目录就换下一个」的自愈。
 * 顺序：已存的 tocUrl → 书籍地址 → 刷新详情后拿到的新 tocUrl（由调用方追加）。
 */
function buildTocCandidates(book, source) {
  const out = [];
  const push = (u) => {
    const v = normalizeBookUrl(u, source.url);
    if (v && !out.includes(v)) out.push(v);
  };
  if (absoluteUrlLooksValid(book.tocUrl)) push(book.tocUrl);
  push(book.bookUrl);
  return out;
}

export async function ensureChapters(bookId, { refresh = false, timeout } = {}) {
  const book = getBook(bookId);
  if (!book) throw new SourceError('书籍不存在', 'NOT_FOUND');

  if (!refresh) {
    const cached = getChapters(bookId);
    if (cached.length > 0) return { items: cached, fromCache: true };
  }

  const source = loadSourceForBook(book.sourceId);
  if (!source) throw new SourceError('书源不存在', 'NOT_FOUND');

  // 候选地址链：一次拿不到就换下一个，最后再刷新一次书籍详情。
  // 为什么不再「失败就直接抛」：书一旦入库，脏的 tocUrl 会让它永远打不开；
  // 用户点「阅读」看到的就是「HTTP 404 Not Found」这种莫名其妙的提示。
  const candidates = buildTocCandidates(book, source);
  // 一个可用地址都没有（早期书源 bug 把 "[\"broken\"]" 这种值写进了库）：
  // 这种情况没法自愈，直接告诉用户重新搜索，比拿脏地址去请求后报 404 清楚得多。
  if (!candidates.some((u) => /^https?:\/\//i.test(u))) {
    throw new SourceError('这本书的记录已损坏（地址无效），请重新搜索这本书后再打开', 'BOOK_RECORD_BROKEN');
  }
  let result = null;
  let usedUrl = '';
  let lastError = null;

  for (const url of candidates) {
    try {
      const r = await fetchToc(source, url, url, { timeout });
      if (r.chapters.length > 0) { result = r; usedUrl = url; break; }
      lastError = new SourceError('该地址没有解析出任何章节（规则可能已失效）', 'RULE_ERROR');
      log.warn('目录为空，尝试下一个候选地址: ' + url);
    } catch (err) {
      lastError = err;
      log.warn('目录拉取失败（' + url + '）: ' + err.message);
    }
  }

  // 候选都用完还不行：回源刷新一次书籍详情，拿新解析出的 tocUrl 再试最后一把
  if (!result) {
    const fresh = await refreshBookInfo(bookId, { timeout }).catch(() => null);
    const freshUrl = fresh && fresh.tocUrl ? normalizeBookUrl(fresh.tocUrl, source.url) : '';
    if (freshUrl && !candidates.includes(freshUrl)) {
      try {
        const r = await fetchToc(source, freshUrl, freshUrl, { timeout });
        if (r.chapters.length > 0) { result = r; usedUrl = freshUrl; }
        else lastError = new SourceError('刷新后仍然解析不到章节', 'RULE_ERROR');
      } catch (err) { lastError = err; }
    }
  }

  if (!result) {
    const gone = lastError && lastError.code === 'UPSTREAM_NOT_FOUND';
    const reason = lastError ? lastError.message : '目录规则未匹配到任何章节';
    throw new SourceError(
      (gone
        ? '这本书在当前书源已经打不开了（站点返回 404，地址可能已失效）。'
        : '这本书在当前书源拿不到目录（' + reason + '）。')
      + '建议点「换源」换一个书源继续阅读。',
      gone ? 'UPSTREAM_NOT_FOUND' : 'RULE_ERROR',
    );
  }

  const { chapters, pages, warnings } = result;
  saveChapters(bookId, chapters);
  // 把这次真正可用的地址固化下来，下次直接命中，避免每次阅读都重试一遍候选链
  if (usedUrl && usedUrl !== book.tocUrl) {
    run('UPDATE books SET toc_url = ?, updated_at = ? WHERE id = ?', usedUrl, now(), Number(bookId));
    log.info('书籍「' + (book.name || bookId) + '」的目录地址已更新为 ' + usedUrl);
  }
  // 章节数变化后旧正文缓存可能错位，清掉更安全
  if (refresh) run('DELETE FROM contents WHERE book_id = ?', Number(bookId));
  return { items: getChapters(bookId), fromCache: false, pages, warnings };
}

/* ------------------------------ 正文 ------------------------------ */

export function getStoredContent(bookId, index) {
  const row = get('SELECT content, cached_at FROM contents WHERE book_id = ? AND idx = ?', Number(bookId), Number(index));
  return row ? { content: row.content, cachedAt: row.cached_at } : null;
}

/**
 * 取正文：优先缓存，未命中则回源并写入缓存。
 */
export async function getChapterContent(bookId, index, { refresh = false, timeout } = {}) {
  const id = Number(bookId);
  const idx = Number(index);
  const book = getBook(id);
  if (!book) throw new SourceError('书籍不存在', 'NOT_FOUND');

  if (!refresh) {
    const hit = getStoredContent(id, idx);
    if (hit) {
      return { index: idx, title: chapterTitle(id, idx), content: hit.content, cached: true, fromCache: true, ...neighbors(id, idx) };
    }
  }

  const chapters = getChapters(id);
  if (chapters.length === 0) await ensureChapters(id);
  const list = getChapters(id);
  const chapter = list[idx];
  if (!chapter) {
    // 能走到这里说明目录是存在的、只是索引对不上（书源改版后章节数变了）
    throw new SourceError(
      '这本书的目录已经变化（当前共 ' + list.length + ' 章，请求第 ' + (idx + 1) + ' 章），请刷新目录后重试',
      'CHAPTER_OUT_OF_RANGE',
    );
  }
  if (!chapter.url) throw new SourceError('该条目是分卷标题，没有正文', 'BAD_REQUEST');

  const source = loadSourceForBook(book.sourceId);
  if (!source) throw new SourceError('书源不存在', 'NOT_FOUND');

  const r = await fetchContent(source, chapter.url, { book, chapter, opts: { timeout } });
  run(
    'INSERT INTO contents (book_id, idx, content, cached_at) VALUES (?,?,?,?) ON CONFLICT(book_id, idx) DO UPDATE SET content = excluded.content, cached_at = excluded.cached_at',
    id, idx, r.content, now(),
  );

  return {
    index: idx,
    title: chapter.title,
    content: r.content,
    words: r.words,
    cached: true,
    fromCache: false,
    pages: r.pages,
    warnings: r.warnings,
    ...neighbors(id, idx),
  };
}

function chapterTitle(bookId, idx) {
  return get('SELECT title FROM chapters WHERE book_id = ? AND idx = ?', Number(bookId), Number(idx))?.title || '';
}

function neighbors(bookId, idx) {
  const total = chapterCount(bookId);
  return {
    prevIndex: idx > 0 ? idx - 1 : -1,
    nextIndex: idx + 1 < total ? idx + 1 : -1,
    total,
  };
}

/* ---------------------------- 后台缓存任务 ---------------------------- */

const cacheJobs = new Map();
let cacheJobSeq = 0;

export function getCacheState(bookId) {
  const id = Number(bookId);
  const total = chapterCount(id);
  const cached = Number(get('SELECT COUNT(*) c FROM contents WHERE book_id = ?', id)?.c || 0);
  const job = cacheJobs.get(id);
  // 任务结束后还会在表里留 30 秒供前端读取最终状态，
  // 所以 running 必须看 pending 而不是"表里有没有"
  const running = Boolean(job && job.pending > 0 && !job.finishedAt);
  return {
    cached,
    total,
    queued: job ? job.pending : 0,
    running,
    failed: job ? job.failed.length : 0,
    finished: Boolean(job && job.finishedAt),
  };
}

/**
 * 后台批量缓存正文。
 * @returns {{jobId:number, queued:number}}
 */
export function startCacheJob(bookId, from, to, { concurrency = 3 } = {}) {
  const id = Number(bookId);
  const total = chapterCount(id);
  const start = Math.max(0, Math.min(Number(from) || 0, Math.max(0, total - 1)));
  const end = Math.max(start, Math.min(Number(to) ?? total - 1, total - 1));

  const existing = cacheJobs.get(id);
  if (existing) return { jobId: existing.jobId, queued: existing.pending, alreadyRunning: true };

  const indices = [];
  const cachedSet = new Set(all('SELECT idx FROM contents WHERE book_id = ?', id).map((r) => r.idx));
  for (let i = start; i <= end; i++) {
    const ch = get('SELECT url FROM chapters WHERE book_id = ? AND idx = ?', id, i);
    if (!ch || !ch.url) continue;
    if (cachedSet.has(i)) continue;
    indices.push(i);
  }

  const job = { jobId: ++cacheJobSeq, pending: indices.length, failed: [], startedAt: now() };
  cacheJobs.set(id, job);

  (async () => {
    try {
      await mapLimit(indices, concurrency, async (i) => {
        try {
          await getChapterContent(id, i, { refresh: true });
        } catch (err) {
          job.failed.push({ index: i, error: err.message });
        } finally {
          job.pending--;
        }
      });
      log.info('缓存任务完成 book=' + id + ' 成功=' + (indices.length - job.failed.length) + ' 失败=' + job.failed.length);
    } catch (err) {
      log.error('缓存任务异常 book=' + id + ': ' + err.message);
    } finally {
      job.finishedAt = now();
      setTimeout(() => cacheJobs.delete(id), 30000).unref?.();
    }
  })();

  return { jobId: job.jobId, queued: indices.length };
}

/* ------------------------------ 书架 ------------------------------ */

export function listShelf() {
  const rows = all('SELECT * FROM shelf ORDER BY sort_order ASC, added_at DESC');
  const items = [];
  for (const r of rows) {
    const book = rowToBook(get('SELECT * FROM books WHERE id = ?', r.book_id));
    if (!book) continue;
    const p = get('SELECT * FROM progress WHERE book_id = ?', r.book_id);
    items.push({
      ...book,
      shelf: { group: r.group_name, sortOrder: r.sort_order, addedAt: r.added_at },
      progress: p ? {
        chapterIndex: p.chapter_index,
        chapterTitle: p.chapter_title,
        percent: p.percent,
        updatedAt: p.updated_at,
      } : null,
    });
  }
  const groups = [...new Set(rows.map((r) => r.group_name).filter(Boolean))].sort();
  return { items, groups };
}

export function addToShelf(bookId, group = '') {
  const id = Number(bookId);
  const exists = get('SELECT 1 x FROM shelf WHERE book_id = ?', id);
  if (exists) {
    if (group !== '') run('UPDATE shelf SET group_name = ? WHERE book_id = ?', String(group), id);
    return getBook(id);
  }
  const maxOrder = Number(get('SELECT COALESCE(MAX(sort_order),0) m FROM shelf')?.m || 0);
  run('INSERT INTO shelf (book_id, group_name, sort_order, added_at) VALUES (?,?,?,?)', id, String(group || ''), maxOrder + 1, now());
  return getBook(id);
}

export function removeFromShelf(bookId) {
  return run('DELETE FROM shelf WHERE book_id = ?', Number(bookId)).changes;
}

export function patchShelf(bookId, { group, sortOrder } = {}) {
  const id = Number(bookId);
  const sets = [];
  const params = [];
  if (group !== undefined) { sets.push('group_name = ?'); params.push(String(group)); }
  if (sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(Number(sortOrder) || 0); }
  if (!sets.length) return getBook(id);
  params.push(id);
  run('UPDATE shelf SET ' + sets.join(', ') + ' WHERE book_id = ?', ...params);
  return getBook(id);
}

/* ------------------------------ 进度 ------------------------------ */

export function getProgress(bookId) {
  const p = get('SELECT * FROM progress WHERE book_id = ?', Number(bookId));
  if (!p) {
    return { chapterIndex: 0, chapterTitle: '', chapterPos: 0, percent: 0, updatedAt: 0, readSeconds: 0 };
  }
  return {
    chapterIndex: p.chapter_index,
    chapterTitle: p.chapter_title,
    chapterPos: p.chapter_pos,
    percent: p.percent,
    updatedAt: p.updated_at,
    readSeconds: p.read_seconds,
  };
}

export function saveProgress(bookId, patch = {}) {
  const id = Number(bookId);
  const cur = getProgress(id);
  const chapterIndex = patch.chapterIndex !== undefined ? Number(patch.chapterIndex) || 0 : cur.chapterIndex;
  const chapterTitle = patch.chapterTitle !== undefined ? String(patch.chapterTitle) : (cur.chapterTitle || chapterTitle2(id, chapterIndex));
  const chapterPos = patch.chapterPos !== undefined ? Number(patch.chapterPos) || 0 : cur.chapterPos;
  const percent = patch.percent !== undefined ? Number(patch.percent) || 0 : cur.percent;
  const addSeconds = Number(patch.addSeconds) || 0;
  const readSeconds = cur.readSeconds + (addSeconds > 0 && addSeconds < 3600 ? addSeconds : 0);
  const t = now();

  run(
    'INSERT INTO progress (book_id, chapter_index, chapter_title, chapter_pos, percent, read_seconds, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET chapter_index=excluded.chapter_index, chapter_title=excluded.chapter_title, chapter_pos=excluded.chapter_pos, percent=excluded.percent, read_seconds=excluded.read_seconds, updated_at=excluded.updated_at',
    id, chapterIndex, chapterTitle, chapterPos, percent, readSeconds, t,
  );
  return getProgress(id);
}

function chapterTitle2(bookId, idx) {
  return get('SELECT title FROM chapters WHERE book_id = ? AND idx = ?', Number(bookId), Number(idx))?.title || '';
}

/* ------------------------------ 书签 ------------------------------ */

export function listBookmarks(bookId = null) {
  const rows = bookId
    ? all('SELECT * FROM bookmarks WHERE book_id = ? ORDER BY chapter_index ASC, pos ASC', Number(bookId))
    : all('SELECT * FROM bookmarks ORDER BY created_at DESC LIMIT 500');
  return rows.map((r) => ({
    id: r.id,
    bookId: r.book_id,
    chapterIndex: r.chapter_index,
    chapterTitle: r.chapter_title,
    pos: r.pos,
    text: r.text,
    note: r.note,
    createdAt: r.created_at,
  }));
}

export function addBookmark(input) {
  const r = run(
    'INSERT INTO bookmarks (book_id, chapter_index, chapter_title, pos, text, note, created_at) VALUES (?,?,?,?,?,?,?)',
    Number(input.bookId), Number(input.chapterIndex) || 0, String(input.chapterTitle || ''),
    Number(input.pos) || 0, String(input.text || ''), String(input.note || ''), now(),
  );
  const row = get('SELECT * FROM bookmarks WHERE id = ?', r.lastInsertRowid);
  return {
    id: row.id, bookId: row.book_id, chapterIndex: row.chapter_index, chapterTitle: row.chapter_title,
    pos: row.pos, text: row.text, note: row.note, createdAt: row.created_at,
  };
}

export function updateBookmark(id, patch = {}) {
  const sets = [];
  const params = [];
  if (patch.note !== undefined) { sets.push('note = ?'); params.push(String(patch.note)); }
  if (patch.text !== undefined) { sets.push('text = ?'); params.push(String(patch.text)); }
  if (!sets.length) return null;
  params.push(Number(id));
  run('UPDATE bookmarks SET ' + sets.join(', ') + ' WHERE id = ?', ...params);
  return listBookmarks().find((b) => b.id === Number(id)) || null;
}

export function deleteBookmark(id) {
  return run('DELETE FROM bookmarks WHERE id = ?', Number(id)).changes;
}

/* ---------------------------- 换源 / 章节搜索 ---------------------------- */

/** 全库范围搜索同名书，作为换源候选 */
const altCache = new Map();          // 书名+作者 -> { at, items }
const ALT_TTL = Number(process.env.SHUHAI_ALT_TTL || 180000);   // 3 分钟

/**
 * 找同名书的其它书源（换源候选）。
 *
 * 性能提示：早期实现会对**全部**启用书源并发搜一遍——书源一多（几百个）就要等
 * 40~60 秒，前端看起来就是「换源卡顿 / 多次加载失败」。现在：
 *   · 只挑最可能出结果的 N 个源（默认 40）：先排除体检失败的，再按权重与历史响应速度排
 *   · 单源超时降到 8 秒、并发提到 10
 *   · 结果缓存 3 分钟，来回切页签不重复搜
 */
/** 换源参数归一化（非流式与流式共用） */
function altOptions(opts = {}) {
  return {
    maxSources: Math.min(Math.max(Number(opts.maxSources) || 40, 4), 120),
    timeout: Number(opts.timeout) || 6000,
    concurrency: Math.min(Math.max(Number(opts.concurrency) || 20, 1), 24),
    limit: Number(opts.limit) || 40,
    threshold: Number(opts.threshold) || 45,
  };
}

function altCacheKey(book) {
  return (book.name || '') + '\u0000' + (book.author || '') + '\u0000' + book.sourceId;
}

/** 挑出最可能出结果的候选书源：体检失败的靠后，权重高的、历史上响应快的靠前 */
function pickAlternativeSources(book, o) {
  const rows = all(
    `SELECT * FROM sources WHERE enabled = 1 AND id <> ?
     ORDER BY (CASE WHEN last_test_at > 0 AND last_test_ok = 0 THEN 1 ELSE 0 END) ASC,
              weight DESC,
              (respond_time > 0 AND respond_time < 1500) DESC,
              respond_time ASC,
              id ASC
     LIMIT ?`,
    Number(book.sourceId), o.maxSources,
  );
  const sources = [];
  for (const row of rows) {
    let raw = {};
    try { raw = JSON.parse(row.raw); } catch { /* 忽略 */ }
    const { source } = normalizeSource(raw);
    if (!source.searchUrl) continue;
    sources.push({ ...source, id: row.id });
  }
  return sources;
}

/** 把某个书源返回的条目打分、过滤；返回通过阈值的候选 */
function acceptCandidates(items, book, o) {
  const out = [];
  for (const item of items || []) {
    item.score = scoreMatch(item, book);
    if (item.score >= o.threshold) out.push(item);
  }
  return out;
}

/** 候选排序 + 按 sourceId|bookUrl 去重（同一本书在同一书源只留一条） */
function finalizeCandidates(list, limit) {
  const seen = new Map();
  for (const it of list) {
    const k = it.sourceId + '|' + it.bookUrl;
    const prev = seen.get(k);
    if (!prev || (it.score || 0) > (prev.score || 0)) seen.set(k, it);
  }
  return [...seen.values()]
    .sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.sourceName).localeCompare(String(b.sourceName)))
    .slice(0, limit);
}

function rememberAlternatives(book, items, searched) {
  altCache.set(altCacheKey(book), { at: Date.now(), items, searched });
  if (altCache.size > 50) altCache.delete(altCache.keys().next().value);
}

export async function findAlternatives(bookId, opts = {}) {
  const book = getBook(bookId);
  if (!book) throw new SourceError('书籍不存在', 'NOT_FOUND');
  const o = altOptions(opts);

  const hit = altCache.get(altCacheKey(book));
  if (!opts.noCache && hit && Date.now() - hit.at < ALT_TTL) {
    return { book, items: hit.items, fromCache: true, searched: hit.searched };
  }

  const sources = pickAlternativeSources(book, o);
  const { results } = await searchAll(sources, book.name, { concurrency: o.concurrency, timeout: o.timeout, limit: 20 });

  const candidates = [];
  for (const r of results) if (r.ok) candidates.push(...acceptCandidates(r.items, book, o));
  const items = finalizeCandidates(candidates, o.limit);
  rememberAlternatives(book, items, sources.length);
  log.info('换源候选：搜了 ' + sources.length + ' 个源，命中 ' + items.length + ' 个（书名：' + book.name + '）');
  return { book, items, fromCache: false, searched: sources.length };
}

/**
 * 流式版换源：每搜完一个书源就把新候选推给调用方。
 *
 * 为什么需要它：几百个书源时，一次性等全部搜完要十几秒，用户看到的就是「换源卡顿」。
 * 流式之后第一个候选通常 1~2 秒内就出现了，剩下的慢慢补齐，观感完全不同。
 *
 * @param {number} bookId
 * @param {object} opts
 * @param {(evt:object)=>any} onEvent 事件回调（cached / source / done）
 */
export async function findAlternativesStream(bookId, opts = {}, onEvent = () => {}) {
  const book = getBook(bookId);
  if (!book) throw new SourceError('书籍不存在', 'NOT_FOUND');
  const o = altOptions(opts);
  const started = Date.now();

  const hit = altCache.get(altCacheKey(book));
  if (!opts.noCache && hit && Date.now() - hit.at < ALT_TTL) {
    await onEvent({ type: 'cached', items: hit.items, searched: hit.searched });
    await onEvent({ type: 'done', total: hit.items.length, searched: hit.searched, fromCache: true, took: Date.now() - started });
    return { book, items: hit.items, fromCache: true, searched: hit.searched };
  }

  const sources = pickAlternativeSources(book, o);
  if (!sources.length) {
    await onEvent({ type: 'done', total: 0, searched: 0, took: Date.now() - started });
    return { book, items: [], fromCache: false, searched: 0 };
  }

  const collected = [];
  let responded = 0;
  let succeeded = 0;
  const failures = [];

  await searchAllStream(sources, book.name, { concurrency: o.concurrency, timeout: o.timeout, limit: 20 }, async (payload) => {
    responded++;
    const fresh = payload.ok ? acceptCandidates(payload.items, book, o) : [];
    if (payload.ok) succeeded++;
    else if (failures.length < 50) failures.push({ sourceName: payload.sourceName, error: payload.error });
    collected.push(...fresh);
    await onEvent({
      type: 'source',
      sourceId: payload.sourceId,
      sourceName: payload.sourceName,
      ok: payload.ok,
      error: payload.error || '',
      found: fresh.length,
      items: fresh,
      progress: { responded, total: sources.length, succeeded, failed: responded - succeeded },
    });
  });

  const items = finalizeCandidates(collected, o.limit);
  rememberAlternatives(book, items, sources.length);
  log.info('换源候选(流式)：搜了 ' + sources.length + ' 个源，命中 ' + items.length + ' 个，用时 ' + (Date.now() - started) + 'ms');
  await onEvent({
    type: 'done', total: items.length, searched: sources.length,
    succeeded, failed: sources.length - succeeded, failures,
    fromCache: false, took: Date.now() - started,
  });
  return { book, items, fromCache: false, searched: sources.length };
}

/** 换源：改绑书源与地址，清空目录/正文缓存，保留进度百分比 */
export async function changeSource(bookId, { sourceId, bookUrl, keepProgress = true }) {
  const id = Number(bookId);
  const book = getBook(id);
  if (!book) throw new SourceError('书籍不存在', 'NOT_FOUND');
  const source = loadSourceForBook(sourceId);
  if (!source) throw new SourceError('目标书源不存在', 'NOT_FOUND');

  const oldProgress = getProgress(id);

  run('UPDATE books SET source_id = ?, book_url = ?, toc_url = ?, updated_at = ? WHERE id = ?',
    Number(sourceId), String(bookUrl), String(bookUrl), now(), id);
  run('DELETE FROM chapters WHERE book_id = ?', id);
  run('DELETE FROM contents WHERE book_id = ?', id);

  let updated = getBook(id);
  try {
    updated = await resolveBook({ sourceId, bookUrl, name: book.name, author: book.author }, { refresh: true });
    await ensureChapters(id, { refresh: true });
    const list = getChapters(id);
    if (keepProgress && list.length && oldProgress.percent > 0) {
      const target = Math.min(list.length - 1, Math.floor((oldProgress.percent / 100) * list.length));
      run('UPDATE progress SET chapter_index = ?, chapter_title = ?, chapter_pos = 0, updated_at = ? WHERE book_id = ?',
        target, list[target].title, now(), id);
    }
  } catch (err) {
    log.warn('换源后刷新失败 book=' + id + ': ' + err.message);
    updated = getBook(id);
    updated.warning = err.message;
  }
  return updated;
}

/** 在当前书已缓存的目录里搜章节标题 */
export function searchChapters(bookId, q) {
  const kw = String(q || '').trim();
  if (!kw) return [];
  const like = '%' + kw + '%';
  return all('SELECT idx, title FROM chapters WHERE book_id = ? AND title LIKE ? ORDER BY idx ASC LIMIT 300', Number(bookId), like)
    .map((r) => ({ index: r.idx, title: r.title }));
}

/* ---------------------------- 搜索历史 ---------------------------- */

export function addSearchHistory(keyword, type = 'all') {
  const kw = String(keyword || '').trim();
  if (!kw) return;
  run('DELETE FROM search_history WHERE keyword = ? AND type = ?', kw, String(type));
  run('INSERT INTO search_history (keyword, type, created_at) VALUES (?,?,?)', kw, String(type), now());
  // 只保留最近 200 条
  run('DELETE FROM search_history WHERE id NOT IN (SELECT id FROM search_history ORDER BY created_at DESC LIMIT 200)');
}

export function listSearchHistory(limit = 20) {
  return all('SELECT * FROM search_history ORDER BY created_at DESC LIMIT ?', Math.min(Number(limit) || 20, 200))
    .map((r) => ({ id: r.id, keyword: r.keyword, type: r.type, createdAt: r.created_at }));
}

export function clearSearchHistory() {
  return run('DELETE FROM search_history').changes;
}

/** 清空所有正文缓存 */
export function clearContentCache() {
  return run('DELETE FROM contents').changes;
}
