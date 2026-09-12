/**
 * api.js —— 网络请求层
 * 严格遵循 docs/API.md v1 契约：
 *   成功 { ok:true, data:any } / 失败 { ok:false, error:{code,message} }
 * 所有失败统一抛出 ApiError，调用方只需 try/catch + toast 即可降级。
 */

const BASE = '/api';

/** 统一错误对象 */
export class ApiError extends Error {
  constructor(message, code = 'INTERNAL', status = 0, detail = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;      // 业务错误码
    this.status = status;  // HTTP 状态码
    this.detail = detail;
  }
  /** 是否属于「连不上后端」类错误 */
  get offline() {
    return this.code === 'NETWORK' || this.status === 0;
  }
}

/** 错误码对应的中文描述 */
const CODE_TEXT = {
  BAD_REQUEST: '请求参数有误',
  NOT_FOUND: '未找到对应内容',
  UPSTREAM_ERROR: '上游书源返回异常',
  TIMEOUT: '请求超时',
  RULE_ERROR: '书源规则解析失败',
  CONFLICT: '数据冲突（同名书源已存在）',
  INTERNAL: '服务内部错误',
};

/** 把错误码翻译成用户能看懂的话 */
function friendly(code, message) {
  if (code === 'NETWORK') return '无法连接服务，请确认后端服务已启动';
  if (message && String(message).trim()) return String(message);
  return CODE_TEXT[code] || '请求失败';
}

/** 拼接查询串，自动跳过空值 */
export function buildQuery(query) {
  if (!query) return '';
  const parts = [];
  for (const key of Object.keys(query)) {
    const val = query[key];
    if (val === undefined || val === null || val === '') continue;
    if (Array.isArray(val)) {
      if (!val.length) continue;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(val.join(',')));
    } else {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(val)));
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

/**
 * 核心请求方法
 * @param {string} path  以 / 开头的接口路径（不含 /api 前缀）
 * @param {object} options { method, body, query, timeout, signal, raw }
 */
export async function request(path, options = {}) {
  const {
    method = 'GET',
    body,
    query,
    timeout = 30000,
    signal,
    raw = false, // true 时返回 Response，用于下载等场景
  } = options;

  const url = BASE + path + buildQuery(query);
  const ctrl = new AbortController();
  let timedOut = false;
  let timer = null;

  if (timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeout);
  }
  // 外部 signal 与内部超时合并
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  const init = {
    method,
    signal: ctrl.signal,
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json; charset=utf-8';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (timedOut) throw new ApiError('请求超时（' + Math.round(timeout / 1000) + 's），书源可能响应过慢', 'TIMEOUT', 504);
    if (err && err.name === 'AbortError') throw new ApiError('请求已取消', 'ABORTED', 0);
    throw new ApiError(friendly('NETWORK'), 'NETWORK', 0, err);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (raw) return res;

  const text = await res.text().catch(() => '');
  if (res.status === 204 || !text) {
    if (!res.ok) throw new ApiError('服务返回 HTTP ' + res.status, 'INTERNAL', res.status);
    return null;
  }

  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    // 典型场景：后端未启动时被反代/网关返回了 HTML 错误页
    throw new ApiError(
      res.ok ? '服务返回了非 JSON 内容，接口可能未实现' : '服务返回异常（HTTP ' + res.status + '）',
      'SERVER',
      res.status
    );
  }

  if (payload && typeof payload === 'object' && 'ok' in payload) {
    if (payload.ok) return payload.data;
    const code = (payload.error && payload.error.code) || 'INTERNAL';
    throw new ApiError(friendly(code, payload.error && payload.error.message), code, res.status, payload.error);
  }
  // 未按契约包装时兜底
  if (!res.ok) throw new ApiError('服务返回异常（HTTP ' + res.status + '）', 'INTERNAL', res.status);
  return payload;
}

/** GET 快捷方法 */
export const get = (path, query, opts) => request(path, Object.assign({ query }, opts));
/** POST 快捷方法 */
export const post = (path, body, opts) => request(path, Object.assign({ method: 'POST', body }, opts));
/** PUT 快捷方法 */
export const put = (path, body, opts) => request(path, Object.assign({ method: 'PUT', body }, opts));
/** PATCH 快捷方法 */
export const patch = (path, body, opts) => request(path, Object.assign({ method: 'PATCH', body }, opts));
/** DELETE 快捷方法 */
export const del = (path, body, opts) => request(path, Object.assign({ method: 'DELETE', body }, opts));

/**
 * 打开搜索 SSE 流
 * @param {object} params  与 /api/search 相同：q/type/sources/groups/limit/timeout
 * @param {object} handlers { onSource(payload), onDone(payload), onError(ApiError) }
 * @returns {{close:Function}}
 */
export function openSearchStream(params, handlers = {}) {
  const url = BASE + '/search/stream' + buildQuery(params);
  let closed = false;
  let es = null;
  let errored = false;

  const close = () => {
    closed = true;
    if (es) {
      try { es.close(); } catch (e) { /* 忽略 */ }
      es = null;
    }
  };

  try {
    es = new EventSource(url);
  } catch (err) {
    if (handlers.onError) handlers.onError(new ApiError('浏览器不支持流式搜索，请改用普通搜索', 'INTERNAL', 0, err));
    return { close };
  }

  es.addEventListener('source', (ev) => {
    if (closed) return;
    let data = null;
    try { data = JSON.parse(ev.data); } catch (e) { return; }
    if (handlers.onSource) handlers.onSource(data);
  });

  es.addEventListener('done', (ev) => {
    if (closed) return;
    let data = null;
    try { data = JSON.parse(ev.data); } catch (e) { data = {}; }
    close();
    if (handlers.onDone) handlers.onDone(data);
  });

  // 后端会把业务错误也走 error 事件；EventSource 自身网络错误会触发 readyState=CLOSED
  es.addEventListener('error', (ev) => {
    if (closed) return;
    if (ev && ev.data) {
      let payload = null;
      try { payload = JSON.parse(ev.data); } catch (e) { payload = null; }
      if (payload) {
        errored = true;
        close();
        if (handlers.onError) {
          const code = (payload.error && payload.error.code) || 'UPSTREAM_ERROR';
          if (handlers.onSource) {
            // 业务错误按「整体失败」处理
          }
          handlers.onError(new ApiError(friendly(code, payload.error && payload.error.message), code, 0, payload));
        }
        return;
      }
    }
    // 原生连接错误：EventSource 会自动重连，这里只提示一次并关闭
    if (es && es.readyState === EventSource.CLOSED) {
      errored = true;
      close();
      if (handlers.onError) handlers.onError(new ApiError(friendly('NETWORK'), 'NETWORK', 0));
    }
  });

  return { close, get errored() { return errored; } };
}

/**
 * 打开批量体检 SSE 流（实时逐个推送书源测试结果，用于进度条与结果列表）
 * @param {object} params   { ids?, keyword?, q?, group?, status?, enabled?, enabledOnly?, concurrency? }
 * @param {object} handlers { onStart, onResult, onDone, onError }
 * @returns {{close:Function}}
 */
export function openSourceTestStream(params = {}, handlers = {}) {
  const url = BASE + '/sources/test-batch/stream' + buildQuery({
    ids: params.ids && params.ids.length ? params.ids.join(',') : undefined,
    keyword: params.keyword,
    q: params.q,
    group: params.group,
    status: params.status,
    enabled: params.enabled,
    enabledOnly: params.enabledOnly ? 1 : undefined,
    concurrency: params.concurrency,
  });
  let closed = false;
  let es = null;

  const close = () => {
    closed = true;
    if (es) {
      try { es.close(); } catch (e) { /* 忽略 */ }
      es = null;
    }
  };

  try {
    es = new EventSource(url);
  } catch (err) {
    if (handlers.onError) handlers.onError(new ApiError('浏览器不支持流式体检，请改用一次性批量测试', 'INTERNAL', 0, err));
    return { close };
  }

  const bind = (event, key) => {
    es.addEventListener(event, (ev) => {
      if (closed) return;
      let data = null;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (handlers[key]) handlers[key](data);
    });
  };
  bind('start', 'onStart');
  bind('result', 'onResult');
  bind('done', 'onDone');
  // 再注册一个 done 监听用于收尾关闭；注册顺序保证它在 onDone 之后执行
  es.addEventListener('done', () => close());

  es.addEventListener('error', (ev) => {
    if (closed) return;
    if (ev && ev.data) {
      let payload = null;
      try { payload = JSON.parse(ev.data); } catch (e) { payload = null; }
      if (payload) {
        close();
        if (handlers.onError) {
          const code = payload.code || 'UPSTREAM_ERROR';
          handlers.onError(new ApiError(friendly(code, payload.message), code, 0, payload));
        }
        return;
      }
    }
    if (es && es.readyState === EventSource.CLOSED) {
      close();
      if (handlers.onError) handlers.onError(new ApiError(friendly('NETWORK'), 'NETWORK', 0));
    }
  });

  return { close };
}

/**
 * 流式换源的 SSE 地址。
 * 换源要并发问几十上百个书源，一次性等全部返回就是用户说的「换源卡顿」；
 * 走 SSE 可以边搜边出候选，第一个结果通常 1~2 秒就到。
 */
export function bookAlternativesStreamUrl(bookId, query) {
  return BASE + '/books/' + bookId + '/alternatives/stream' + buildQuery(query);
}

/** 接口集合：全部按 docs/API.md 定义 */
export const api = {
  // —— 系统 ——
  health: () => get('/health', null, { timeout: 8000 }),
  stats: () => get('/stats', null, { timeout: 10000 }),
  logs: (limit = 200) => get('/logs', { limit }),

  // —— 书源 ——
  sourceList: (query) => get('/sources', query),
  sourceGet: (id) => get('/sources/' + id),
  sourceCreate: (raw) => post('/sources', raw),
  sourceUpdate: (id, raw) => put('/sources/' + id, raw),
  sourcePatch: (id, patchBody) => patch('/sources/' + id, patchBody),
  sourceDelete: (id) => del('/sources/' + id),
  sourceBatchDelete: (ids) => post('/sources/delete', { ids }),
  sourceBatch: (ids, patchBody) => post('/sources/batch', { ids, patch: patchBody }),
  sourceImport: (payload) => post('/sources/import', payload, { timeout: 120000 }),
  sourceImportUrl: (payload) => post('/sources/import-url', payload, { timeout: 120000 }),
  sourceTest: (id, keyword) => post('/sources/test', { id, keyword }, { timeout: 60000 }),
  sourceTestBatch: (payload) => post('/sources/test-batch', payload || {}, { timeout: 300000 }),
  sourceDeleteInvalid: (payload) => post('/sources/delete-invalid', payload || {}, { timeout: 300000 }),
  sourcePreview: (raw, keyword) => post('/sources/preview', { raw, keyword }, { timeout: 60000 }),
  sourceGroups: () => get('/sources/groups'),
  /** 导出下载地址（浏览器直接跳转触发下载） */
  sourceExportUrl: (ids, enabledOnly) => BASE + '/sources/export' + buildQuery({ ids: ids && ids.length ? ids.join(',') : undefined, enabledOnly: enabledOnly ? 1 : undefined, download: 1 }),

  // —— 搜索 ——
  search: (query) => get('/search', query, { timeout: 60000 }),
  searchSource: (id, query) => get('/sources/' + id + '/search', query),
  searchHistory: (limit = 20) => get('/search/history', { limit }),
  searchHistoryClear: () => del('/search/history'),
  searchHot: () => get('/search/hot', null, { timeout: 20000 }),

  // —— 书籍 ——
  resolveBook: (payload) => post('/books/resolve', payload, { timeout: 60000 }),
  bookGet: (id, refresh) => get('/books/' + id, { refresh: refresh ? 1 : undefined }, { timeout: 60000 }),
  bookChapters: (id, refresh) => get('/books/' + id + '/chapters', { refresh: refresh ? 1 : undefined }, { timeout: 120000 }),
  bookContent: (id, query) => get('/books/' + id + '/content', query, { timeout: 60000 }),
  bookCacheStart: (id, payload) => post('/books/' + id + '/cache', payload, { timeout: 30000 }),
  bookCacheStatus: (id) => get('/books/' + id + '/cache'),
  bookSearch: (id, q) => get('/books/' + id + '/search', { q }, { timeout: 30000 }),
  bookAlternatives: (id, force) => get('/books/' + id + '/alternatives', force ? { refresh: 1 } : null, { timeout: 60000 }),
  bookChangeSource: (id, payload) => post('/books/' + id + '/change-source', payload, { timeout: 90000 }),
  bookDelete: (id) => del('/books/' + id),

  // —— 书架 ——
  shelf: () => get('/shelf', null, { timeout: 30000 }),
  shelfAdd: (payload) => post('/shelf', payload),
  shelfRemove: (bookId) => del('/shelf/' + bookId),
  shelfPatch: (bookId, payload) => patch('/shelf/' + bookId, payload),

  // —— 进度 ——
  progressGet: (bookId) => get('/progress/' + bookId),
  progressPut: (bookId, payload, opts) => put('/progress/' + bookId, payload, opts),

  // —— 书签 / 笔记 ——
  bookmarkList: (bookId) => get('/bookmarks', { bookId }),
  bookmarkAdd: (payload) => post('/bookmarks', payload),
  bookmarkDelete: (id) => del('/bookmarks/' + id),
  noteList: (bookId) => get('/notes', { bookId }),

  // —— 设置 ——
  settingsGet: () => get('/settings'),
  settingsPut: (payload) => put('/settings', payload),
  settingsPresets: () => get('/settings/presets', null, { timeout: 10000 }),
};

/** 进度兜底上报（页面卸载时使用，失败静默） */
export function beaconProgress(bookId, payload) {
  const url = BASE + '/progress/' + bookId;
  const data = JSON.stringify(payload);
  if (navigator.sendBeacon) {
    try {
      const blob = new Blob([data], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) return true;
    } catch (e) { /* 落到 fetch 分支 */ }
  }
  try {
    fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: data,
      keepalive: true,
    }).catch(() => {});
    return true;
  } catch (e) {
    return false;
  }
}

export default api;
