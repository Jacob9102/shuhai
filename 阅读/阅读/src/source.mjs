/**
 * 书源管理 —— 阅读(Legado) 3.0 书源格式的归一化、校验、导入与导出。
 *
 * 兼容策略：真实流传的书源五花八门（3.0 新版、2.x 老版、别人二次打包的
 * 变体、字段名大小写不一致），所以这里做「宽容归一化」：
 * 只要求能认出名字和地址，其余规则缺失就标为不可用，而不是直接拒绝导入。
 */

import { run, get, all, now, tx } from './db.mjs';

/** 字段别名表：原始字段名（小写） -> 规范字段 */
const FIELD_ALIASES = {
  name: ['booksourcename', 'name', 'sourcename', 'title', 'bookname'],
  url: ['booksourceurl', 'url', 'sourceurl', 'host', 'site', 'baseurl'],
  group: ['booksourcegroup', 'group', 'groups', 'category', 'tag'],
  type: ['booksourcetype', 'type', 'sourcetype'],
  comment: ['booksourcecomment', 'comment', 'desc', 'description', 'remark'],
  enabled: ['enabled', 'enable', 'isenabled', 'status'],
  weight: ['weight', 'priority', 'order'],
  searchUrl: ['searchurl', 'search_url', 'search', 'searchuri'],
  exploreUrl: ['exploreurl', 'explore_url', 'explore', 'findurl'],
  header: ['header', 'headers', 'httpheader'],
  loginUrl: ['loginurl', 'login_url'],
  variable: ['variable', 'variables', 'varlist'],
  jsLib: ['jslib', 'js_lib'],
  ruleSearch: ['rulesearch', 'rule_search', 'searchrule', 'search_rule'],
  ruleExplore: ['ruleexplore', 'rule_explore', 'explorerule'],
  ruleBookInfo: ['rulebookinfo', 'rule_book_info', 'bookinforule', 'bookrule'],
  ruleToc: ['ruletoc', 'rule_toc', 'tocrule', 'chapterrule'],
  ruleContent: ['rulecontent', 'rule_content', 'contentrule', 'content'],
  lastUpdateTime: ['lastupdatetime', 'updatetime', 'last_update_time'],
  respondTime: ['respondtime', 'responsetime', 'respond_time'],
  concurrentRate: ['concurrentrate', 'concurrent_rate'],
  enabledExplore: ['enabledexplore'],
};

function pick(obj, field) {
  const aliases = FIELD_ALIASES[field] || [field];
  for (const key of Object.keys(obj)) {
    const k = key.toLowerCase().replace(/[_\s-]/g, '');
    for (const a of aliases) {
      if (k === a.replace(/[_\s-]/g, '')) return obj[key];
    }
  }
  return undefined;
}

/** 把可能是 JSON 字符串的字段转成对象 */
export function asObject(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  if (typeof v !== 'string') return {};
  const s = v.trim();
  if (!s) return {};
  // 书源里 header 常写成单引号 JSON
  const attempts = [s, s.replace(/'/g, '"')];
  for (const a of attempts) {
    try {
      const parsed = JSON.parse(a);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 下一个 */ }
  }
  return {};
}

function asBool(v, dflt = true) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (['false', '0', 'no', 'off', 'disabled'].includes(s)) return false;
  if (['true', '1', 'yes', 'on', 'enabled'].includes(s)) return true;
  return dflt;
}

function asInt(v, dflt = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

/** 站点根地址归一化：补协议、去尾部斜杠、去路径（保留文件名前的部分） */
export function normalizeBaseUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    return u.origin;
  } catch {
    return s.replace(/\/+$/, '');
  }
}

/**
 * 归一化一个原始书源对象。
 * @returns {{source:object, raw:object, issues:string[], usable:boolean}}
 */
export function normalizeSource(input) {
  const raw = (input && typeof input === 'object') ? input : {};
  const issues = [];

  const name = String(pick(raw, 'name') ?? '').trim();
  const url = normalizeBaseUrl(pick(raw, 'url'));
  if (!name) issues.push('缺少书源名称(bookSourceName)');
  if (!url) issues.push('缺少书源地址(bookSourceUrl)');

  const ruleSearch = asObject(pick(raw, 'ruleSearch'));
  const ruleBookInfo = asObject(pick(raw, 'ruleBookInfo'));
  const ruleToc = asObject(pick(raw, 'ruleToc'));
  const ruleContent = asObject(pick(raw, 'ruleContent'));
  const ruleExplore = asObject(pick(raw, 'ruleExplore'));

  const searchUrl = String(pick(raw, 'searchUrl') ?? (ruleSearch.searchUrl || '')).trim();
  const exploreUrl = String(pick(raw, 'exploreUrl') ?? '').trim();
  const header = pick(raw, 'header');
  const headerObj = asObject(header);

  if (!searchUrl && !exploreUrl) issues.push('既没有 searchUrl 也没有 exploreUrl，无法搜索');

  const capability = {
    search: Boolean(searchUrl),
    bookInfo: Object.keys(ruleBookInfo).length > 0,
    toc: Object.keys(ruleToc).length > 0,
    content: Object.keys(ruleContent).length > 0,
  };
  // 老版书源有时把章节/正文规则写在 ruleSearch 里，做一次兜底
  if (!capability.content && ruleSearch.content) { ruleContent.content = ruleSearch.content; capability.content = true; }
  if (!capability.toc && ruleSearch.chapterList) { ruleToc.chapterList = ruleSearch.chapterList; capability.toc = true; }

  if (!capability.toc) issues.push('缺少目录规则(ruleToc)，无法获取章节列表');
  if (!capability.content) issues.push('缺少正文规则(ruleContent)，无法阅读');

  const source = {
    name,
    url,
    group: String(pick(raw, 'group') ?? '').trim(),
    type: asInt(pick(raw, 'type'), 0),
    comment: String(pick(raw, 'comment') ?? '').trim(),
    enabled: asBool(pick(raw, 'enabled'), true),
    weight: asInt(pick(raw, 'weight'), 0),
    searchUrl,
    exploreUrl,
    header: headerObj,
    loginUrl: String(pick(raw, 'loginUrl') ?? '').trim(),
    variable: String(pick(raw, 'variable') ?? '').trim(),
    jsLib: String(pick(raw, 'jsLib') ?? '').trim(),
    ruleSearch,
    ruleExplore,
    ruleBookInfo,
    ruleToc,
    ruleContent,
    lastUpdateTime: asInt(pick(raw, 'lastUpdateTime'), 0),
    respondTime: asInt(pick(raw, 'respondTime'), 0),
    concurrentRate: String(pick(raw, 'concurrentRate') ?? '').trim(),
    enabledExplore: asBool(pick(raw, 'enabledExplore'), true),
    capability,
  };

  return { source, raw, issues, usable: Boolean(name && url && (capability.search || exploreUrl)) };
}

/**
 * 从任意文本中解析出书源数组。
 * 支持：单个对象 / 数组 / {"bookSources":[...]} / 夹带说明文字的分享文本。
 */
export function parseImportText(text) {
  let s = String(text ?? '').trim();
  if (!s) return { sources: [], error: '导入内容为空' };

  // 去掉 BOM
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  const tryParse = (str) => {
    try { return JSON.parse(str); } catch { return undefined; }
  };

  let data = tryParse(s);

  if (data === undefined) {
    // 截取首个 [ 或 { 到最后一个 ] 或 }
    const firstBracket = s.indexOf('[');
    const firstBrace = s.indexOf('{');
    let from = -1;
    if (firstBracket === -1) from = firstBrace;
    else if (firstBrace === -1) from = firstBracket;
    else from = Math.min(firstBracket, firstBrace);

    if (from !== -1) {
      const lastBracket = s.lastIndexOf(']');
      const lastBrace = s.lastIndexOf('}');
      const to = Math.max(lastBracket, lastBrace);
      if (to > from) data = tryParse(s.slice(from, to + 1));
      if (data === undefined) {
        // 常见：每行一个书源 JSON
        const lines = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'));
        if (lines.length) {
          const arr = [];
          for (const l of lines) {
            const o = tryParse(l.replace(/,\s*$/, ''));
            if (o) arr.push(o);
          }
          if (arr.length) data = arr;
        }
      }
    }
  }

  if (data === undefined) return { sources: [], error: '无法解析为 JSON，请确认是阅读(Legado)书源格式' };

  // 摊平成数组
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object') {
    const wrapped = data.bookSources || data.sources || data.data || data.list || data.items;
    if (Array.isArray(wrapped)) list = wrapped;
    else list = [data];
  }

  const sources = list.filter((x) => x && typeof x === 'object');
  if (!sources.length) return { sources: [], error: '未在内容中找到任何书源对象' };
  return { sources, error: '' };
}

/* ---------------------------- 数据库操作 ---------------------------- */

function rowToSource(row) {
  if (!row) return null;
  let raw = {};
  try { raw = JSON.parse(row.raw); } catch { /* 忽略 */ }
  const { source } = normalizeSource(raw);
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    group: row.group_name,
    type: row.type,
    enabled: Boolean(row.enabled),
    weight: row.weight,
    sortOrder: row.sort_order,
    comment: row.comment,
    lastUpdateTime: row.last_update_time,
    respondTime: row.respond_time,
    // 体检结果：lastTestAt=0 表示从未测试过
    lastTestAt: row.last_test_at || 0,
    lastTestOk: Boolean(row.last_test_ok),
    lastTestCount: row.last_test_count || 0,
    lastTestError: row.last_test_error || '',
    testStatus: !row.last_test_at ? 'untested' : (row.last_test_ok ? 'ok' : 'fail'),
    searchable: Boolean(source.searchUrl),
    ruleStats: {
      hasSearch: source.capability.search,
      hasBookInfo: source.capability.bookInfo,
      hasToc: source.capability.toc,
      hasContent: source.capability.content,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    _raw: raw,
  };
}

/**
 * 书源列表。
 * @param {object} opts
 * @param {string} opts.status 体检状态筛选：'' 全部 / 'ok' 可用 / 'fail' 失效 / 'untested' 未测试
 */
export function listSources({ q = '', group = '', enabled = null, status = '', page = 1, limit = 20 } = {}) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(name LIKE ? OR url LIKE ? OR comment LIKE ? OR group_name LIKE ?)');
    const like = '%' + q + '%';
    params.push(like, like, like, like);
  }
  if (group) { where.push('group_name LIKE ?'); params.push('%' + group + '%'); }
  if (enabled !== null && enabled !== undefined) { where.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (status === 'ok') where.push('last_test_at > 0 AND last_test_ok = 1');
  else if (status === 'fail') where.push('last_test_at > 0 AND last_test_ok = 0');
  else if (status === 'untested') where.push('last_test_at = 0');

  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = Number(get('SELECT COUNT(*) c FROM sources ' + clause, ...params)?.c || 0);
  const lim = Math.min(Math.max(asInt(limit, 20), 1), 200);
  const off = Math.max(0, (Math.max(asInt(page, 1), 1) - 1) * lim);

  const rows = all(
    'SELECT * FROM sources ' + clause + ' ORDER BY weight DESC, sort_order ASC, id ASC LIMIT ? OFFSET ?',
    ...params, lim, off,
  );

  const groups = all("SELECT DISTINCT group_name FROM sources WHERE group_name <> '' ORDER BY group_name")
    .flatMap((r) => String(r.group_name).split(/[,;，；]/))
    .map((g) => g.trim())
    .filter(Boolean);

  return {
    items: rows.map(rowToSource).map(({ _raw, ...s }) => s),
    total,
    page: Math.max(asInt(page, 1), 1),
    limit: lim,
    groups: [...new Set(groups)],
    testStats: sourceTestStats(),
  };
}

/** 体检总览：全部 / 可用 / 失效 / 未测试（不受筛选条件影响，用于页面顶部统计） */
export function sourceTestStats() {
  const one = (sql) => Number(get(sql)?.c || 0);
  return {
    total: one('SELECT COUNT(*) c FROM sources'),
    ok: one('SELECT COUNT(*) c FROM sources WHERE last_test_at > 0 AND last_test_ok = 1'),
    fail: one('SELECT COUNT(*) c FROM sources WHERE last_test_at > 0 AND last_test_ok = 0'),
    untested: one('SELECT COUNT(*) c FROM sources WHERE last_test_at = 0'),
  };
}

/**
 * 记录一次书源体检结果。
 * @param {number} id
 * @param {{ok:boolean, count?:number, elapsed?:number, error?:string}} result
 */
export function recordTestResult(id, { ok = false, count = 0, elapsed = 0, error = '' } = {}) {
  try {
    run(
      'UPDATE sources SET last_test_at = ?, last_test_ok = ?, last_test_count = ?, last_test_error = ?, respond_time = ? WHERE id = ?',
      now(), ok ? 1 : 0, asInt(count), String(error || '').slice(0, 500), Math.round(Number(elapsed) || 0), Number(id),
    );
    return true;
  } catch {
    return false; // 统计失败不影响主流程
  }
}

/** 已被判定为失效的书源 id（只认"测试过且失败"的，未测试的不算） */
export function listInvalidSourceIds({ ids = null, enabledOnly = false } = {}) {
  const where = ['last_test_at > 0', 'last_test_ok = 0'];
  const params = [];
  if (Array.isArray(ids) && ids.length) {
    where.push('id IN (' + ids.map(() => '?').join(',') + ')');
    params.push(...ids.map(Number));
  }
  if (enabledOnly) where.push('enabled = 1');
  const rows = all('SELECT id FROM sources WHERE ' + where.join(' AND '), ...params);
  return rows.map((r) => Number(r.id));
}

export function getSourceRow(id) {
  return get('SELECT * FROM sources WHERE id = ?', Number(id));
}

export function getSource(id) {
  const row = getSourceRow(id);
  if (!row) return null;
  const s = rowToSource(row);
  return s;
}

export function getSourceRaw(id) {
  const row = getSourceRow(id);
  if (!row) return null;
  try { return JSON.parse(row.raw); } catch { return {}; }
}

/** 启用中的书源（引擎就绪形态：含 searchUrl 与各项规则） */
export function listEnabledSources({ limit = 500 } = {}) {
  const rows = all(
    'SELECT * FROM sources WHERE enabled = 1 ORDER BY weight DESC, sort_order ASC, id ASC LIMIT ?',
    Math.min(asInt(limit, 500), 2000),
  );
  return rows.map(rowToSource).filter((s) => s.searchable);
}

export function listSourceIds({ ids = null, enabledOnly = false } = {}) {
  if (Array.isArray(ids) && ids.length) {
    const rows = all(
      'SELECT * FROM sources WHERE id IN (' + ids.map(() => '?').join(',') + ')',
      ...ids.map(Number),
    );
    return rows.map(rowToSource);
  }
  const rows = enabledOnly
    ? all('SELECT * FROM sources WHERE enabled = 1 ORDER BY weight DESC, id ASC')
    : all('SELECT * FROM sources ORDER BY weight DESC, id ASC');
  return rows.map(rowToSource);
}

/** 新增或更新一个书源。以 name+url 作为唯一键。 */
export function upsertSource(rawSource, { mode = 'append', group = '' } = {}) {
  const { source, issues, usable } = normalizeSource(rawSource);
  if (!source.name && !source.url) {
    return { action: 'failed', error: '书源缺少名称与地址', issues };
  }
  if (!source.url) return { action: 'failed', error: '书源缺少地址', issues };

  const finalGroup = group ? group : source.group;
  const existing = get('SELECT * FROM sources WHERE name = ? AND url = ?', source.name, source.url);

  if (existing) {
    if (mode === 'append') {
      return { action: 'skipped', id: existing.id, name: source.name, issues };
    }
    run(
      'UPDATE sources SET name=?, url=?, group_name=?, type=?, enabled=?, weight=?, comment=?, raw=?, last_update_time=?, updated_at=? WHERE id=?',
      source.name, source.url, finalGroup, source.type, source.enabled ? 1 : 0, source.weight,
      source.comment, JSON.stringify(rawSource), source.lastUpdateTime, now(), existing.id,
    );
    return { action: 'updated', id: existing.id, name: source.name, issues, usable };
  }

  const r = run(
    'INSERT INTO sources (name, url, group_name, type, enabled, weight, sort_order, comment, raw, last_update_time, respond_time, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)',
    source.name, source.url, finalGroup, source.type, source.enabled ? 1 : 0, source.weight, 0,
    source.comment, JSON.stringify(rawSource), source.lastUpdateTime, now(), now(),
  );
  return { action: 'added', id: r.lastInsertRowid, name: source.name, issues, usable };
}

export function updateSource(id, patchRaw) {
  const row = getSourceRow(id);
  if (!row) return null;
  let current = {};
  try { current = JSON.parse(row.raw); } catch { /* 忽略 */ }
  const merged = { ...current, ...(patchRaw || {}) };
  const { source, issues } = normalizeSource(merged);
  run(
    'UPDATE sources SET name=?, url=?, group_name=?, type=?, enabled=?, weight=?, comment=?, raw=?, last_update_time=?, updated_at=? WHERE id=?',
    source.name, source.url, source.group, source.type, source.enabled ? 1 : 0, source.weight,
    source.comment, JSON.stringify(merged), source.lastUpdateTime, now(), id,
  );
  return { source: getSource(id), issues };
}

export function patchSource(id, patch = {}) {
  const row = getSourceRow(id);
  if (!row) return null;
  const fields = [];
  const params = [];
  if (patch.enabled !== undefined) { fields.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }
  if (patch.weight !== undefined) { fields.push('weight = ?'); params.push(asInt(patch.weight)); }
  if (patch.group !== undefined) { fields.push('group_name = ?'); params.push(String(patch.group)); }
  if (patch.sortOrder !== undefined) { fields.push('sort_order = ?'); params.push(asInt(patch.sortOrder)); }
  if (!fields.length) return getSource(id);
  fields.push('updated_at = ?'); params.push(now());
  params.push(Number(id));
  run('UPDATE sources SET ' + fields.join(', ') + ' WHERE id = ?', ...params);
  return getSource(id);
}

export function deleteSources(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
  if (!list.length) return 0;
  const placeholders = list.map(() => '?').join(',');
  const r = run('DELETE FROM sources WHERE id IN (' + placeholders + ')', ...list);
  return r.changes;
}

export function recordRespondTime(id, ms) {
  try {
    run('UPDATE sources SET respond_time = ? WHERE id = ?', Math.round(ms), Number(id));
  } catch { /* 统计失败不影响主流程 */ }
}

/**
 * 导入书源。
 * @param {object[]} rawList 原始书源对象数组
 * @param {{mode?:string, group?:string, enabled?:boolean}} opts
 */
export function importSources(rawList, opts = {}) {
  const mode = opts.mode || 'append';
  const result = { added: 0, updated: 0, skipped: 0, failed: [], total: rawList.length };

  if (mode === 'replace') {
    // 只清空"将被导入"的部分会让人困惑，这里清空全部，符合"替换"的直觉
    tx(() => { run('DELETE FROM sources'); });
  }

  for (const raw of rawList) {
    try {
      const cloned = { ...raw };
      if (opts.enabled !== undefined && opts.enabled !== null) {
        // 显式指定启用状态时覆盖书源自带值
        cloned.enabled = opts.enabled;
        cloned.enabledExplore = opts.enabled;
      }
      const r = upsertSource(cloned, { mode: mode === 'replace' ? 'append' : mode, group: opts.group });
      if (r.action === 'added') result.added++;
      else if (r.action === 'updated') result.updated++;
      else if (r.action === 'skipped') result.skipped++;
      else result.failed.push({ name: r.name || '(无名)', error: r.error || '导入失败' });
    } catch (err) {
      result.failed.push({ name: raw?.bookSourceName || '(无名)', error: err.message });
    }
  }
  return result;
}

/** 导出为 legado 兼容的 JSON 数组 */
export function exportSources(sources) {
  return sources.map((s) => {
    const raw = s._raw || {};
    // 保证关键字段存在且为规范命名，这样导回"阅读"APP 也能用
    return {
      bookSourceComment: s.comment || raw.bookSourceComment || '',
      bookSourceGroup: s.group || raw.bookSourceGroup || '',
      bookSourceName: s.name,
      bookSourceType: s.type ?? 0,
      bookSourceUrl: s.url,
      customOrder: raw.customOrder ?? s.sortOrder ?? 0,
      enabled: s.enabled !== false,
      enabledExplore: raw.enabledExplore !== false,
      header: raw.header || '',
      loginUrl: raw.loginUrl || '',
      weight: s.weight ?? 0,
      variable: raw.variable || '',
      lastUpdateTime: s.lastUpdateTime || 0,
      respondTime: s.respondTime || 180000,
      searchUrl: raw.searchUrl || '',
      exploreUrl: raw.exploreUrl || '',
      ruleSearch: raw.ruleSearch || {},
      ruleExplore: raw.ruleExplore || {},
      ruleBookInfo: raw.ruleBookInfo || {},
      ruleToc: raw.ruleToc || {},
      ruleContent: raw.ruleContent || {},
    };
  });
}
