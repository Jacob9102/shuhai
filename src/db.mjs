/**
 * 数据层 —— 使用 Node 24 内置的 node:sqlite，零外部依赖。
 * 所有数据落在 data/shuhai.db，Docker 里挂载为卷即可持久化。
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    group_name TEXT NOT NULL DEFAULT '',
    type INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    weight INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    comment TEXT NOT NULL DEFAULT '',
    raw TEXT NOT NULL,
    last_update_time INTEGER NOT NULL DEFAULT 0,
    respond_time INTEGER NOT NULL DEFAULT 0,
    -- 书源体检结果（批量测试 / 一键删除失效源依赖这几列）
    last_test_at INTEGER NOT NULL DEFAULT 0,
    last_test_ok INTEGER NOT NULL DEFAULT 0,
    last_test_count INTEGER NOT NULL DEFAULT 0,
    last_test_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_key ON sources(name, url)`,
  `CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources(enabled, sort_order)`,

  `CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    book_url TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    cover TEXT NOT NULL DEFAULT '',
    intro TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    last_chapter TEXT NOT NULL DEFAULT '',
    word_count TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    toc_url TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_books_key ON books(source_id, book_url)`,

  `CREATE TABLE IF NOT EXISTS chapters (
    book_id INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    is_volume INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (book_id, idx)
  )`,

  `CREATE TABLE IF NOT EXISTS contents (
    book_id INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    cached_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (book_id, idx)
  )`,

  `CREATE TABLE IF NOT EXISTS shelf (
    book_id INTEGER PRIMARY KEY,
    group_name TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS progress (
    book_id INTEGER PRIMARY KEY,
    chapter_index INTEGER NOT NULL DEFAULT 0,
    chapter_title TEXT NOT NULL DEFAULT '',
    chapter_pos REAL NOT NULL DEFAULT 0,
    percent REAL NOT NULL DEFAULT 0,
    read_seconds INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL,
    chapter_index INTEGER NOT NULL DEFAULT 0,
    chapter_title TEXT NOT NULL DEFAULT '',
    pos REAL NOT NULL DEFAULT 0,
    text TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bookmarks_book ON bookmarks(book_id, chapter_index)`,

  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS search_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'all',
    created_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_history_time ON search_history(created_at DESC)`,
];

/**
 * 增量迁移：给**已存在**的库补列 / 补索引。
 * 旧版本升级上来的库没有体检相关的列，这里用 PRAGMA table_info 判断后再 ALTER，
 * 幂等且可重复执行（容器重启不会报错）。
 */
const COLUMN_MIGRATIONS = [
  ['sources', 'last_test_at', "INTEGER NOT NULL DEFAULT 0"],
  ['sources', 'last_test_ok', "INTEGER NOT NULL DEFAULT 0"],
  ['sources', 'last_test_count', "INTEGER NOT NULL DEFAULT 0"],
  ['sources', 'last_test_error', "TEXT NOT NULL DEFAULT ''"],
];

const INDEX_MIGRATIONS = [
  'CREATE INDEX IF NOT EXISTS idx_sources_test ON sources(last_test_at, last_test_ok)',
];

function migrate(d) {
  for (const [table, column, decl] of COLUMN_MIGRATIONS) {
    let cols = [];
    try { cols = d.prepare('PRAGMA table_info(' + table + ')').all(); } catch { continue; }
    if (cols.some((c) => String(c.name) === column)) continue;
    try { d.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + decl); } catch { /* 已存在则忽略 */ }
  }
  for (const sql of INDEX_MIGRATIONS) {
    try { d.exec(sql); } catch { /* 索引依赖的列缺失时忽略 */ }
  }
}

let db = null;

/** 打开（或创建）数据库 */
export function openDb(file) {
  const target = file || process.env.SHUHAI_DB || path.join(process.cwd(), 'data', 'shuhai.db');
  const dir = path.dirname(target);
  if (target !== ':memory:' && dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(target);
  // WAL 更适合"读多写少 + 后台缓存任务"的场景
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
  } catch { /* 某些文件系统不支持 WAL，忽略 */ }
  for (const sql of SCHEMA) db.exec(sql);
  migrate(db);
  return db;
}

export function getDb() {
  if (!db) throw new Error('数据库尚未初始化，请先调用 openDb()');
  return db;
}

export function closeDb() {
  try { db?.close(); } catch { /* 忽略 */ }
  db = null;
}

/* ------------------------------ 便捷封装 ------------------------------ */

export function run(sql, ...params) {
  const r = getDb().prepare(sql).run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

export function get(sql, ...params) {
  return getDb().prepare(sql).get(...params);
}

export function all(sql, ...params) {
  return getDb().prepare(sql).all(...params);
}

/** 简单事务包装 */
export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw err;
  }
}

export const now = () => Date.now();

/** 设置项：读写（JSON 序列化） */
export function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setSetting(key, value) {
  const json = JSON.stringify(value ?? null);
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key, json, now(),
  );
  return value;
}

/** 统计信息，供 /api/stats 使用 */
export function stats() {
  const one = (sql) => Number(get(sql)?.c ?? 0);
  return {
    sourceTotal: one('SELECT COUNT(*) c FROM sources'),
    sourceEnabled: one('SELECT COUNT(*) c FROM sources WHERE enabled = 1'),
    bookTotal: one('SELECT COUNT(*) c FROM books'),
    shelfTotal: one('SELECT COUNT(*) c FROM shelf'),
    chapterCached: one('SELECT COUNT(*) c FROM contents'),
    bookmarkTotal: one('SELECT COUNT(*) c FROM bookmarks'),
    readSeconds: one('SELECT COALESCE(SUM(read_seconds),0) c FROM progress'),
    searchTotal: one('SELECT COUNT(*) c FROM search_history'),
  };
}
