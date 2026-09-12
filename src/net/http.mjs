/**
 * HTTP 客户端 —— 基于 Node 内置 fetch（undici），零外部依赖。
 *
 * 小说站点的真实痛点都在这里：
 *  1. 中文站点大量使用 GBK / GB2312 / Big5，且经常不声明 charset；
 *  2. 需要按书源维护 Cookie 会话（有些站点靠 cookie 放行正文）；
 *  3. 需要超时、重试、限速，否则并发搜索会被封；
 *  4. 需要识别 Cloudflare 之类的挡板页并给出可读错误。
 */

import { setTimeout as sleep } from 'node:timers/promises';

export const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Mobile Safari/537.36';

export class HttpError extends Error {
  constructor(message, { code = 'UPSTREAM_ERROR', status = 0, url = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
    this.url = url;
  }
}

/* --------------------------- 字符集处理 --------------------------- */

const CHARSET_ALIAS = {
  gb2312: 'gbk', gb_2312: 'gbk', 'gb-2312': 'gbk', gb18030: 'gb18030',
  'x-gbk': 'gbk', cp936: 'gbk', ms936: 'gbk',
  'utf8': 'utf-8', utf8mb4: 'utf-8',
  big5: 'big5', 'big5-hkscs': 'big5', cp950: 'big5',
  'iso-8859-1': 'windows-1252', latin1: 'windows-1252',
};

function normalizeCharset(cs) {
  if (!cs) return '';
  const k = String(cs).trim().toLowerCase().replace(/["'\s]/g, '');
  return CHARSET_ALIAS[k] || k;
}

function charsetFromContentType(ct) {
  if (!ct) return '';
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(ct);
  return m ? normalizeCharset(m[1]) : '';
}

/** 从 HTML 头部嗅探 charset（meta charset / meta http-equiv / BOM） */
export function charsetFromHtml(head) {
  // BOM
  if (head.charCodeAt(0) === 0xfeff) return 'utf-8';
  let m = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
  if (m) return normalizeCharset(m[1]);
  m = /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(head);
  if (m) return normalizeCharset(m[1]);
  return '';
}

function tryDecode(buf, charset) {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * 把响应字节解码为字符串，按优先级：
 * 显式 charset > HTTP 头 > BOM/HTML meta > UTF-8 严格试解 > GBK
 */
export function decodeBody(buf, { contentType = '', charset = '' } = {}) {
  if (!buf || buf.length === 0) return '';
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);

  // BOM 优先
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }

  const explicit = normalizeCharset(charset);
  if (explicit) {
    const out = tryDecode(bytes, explicit);
    if (out !== null) return out;
  }

  const fromHeader = charsetFromContentType(contentType);
  if (fromHeader) {
    const out = tryDecode(bytes, fromHeader);
    if (out !== null) return out;
  }

  // 从字节头嗅探 meta（ASCII 兼容，直接 latin1 读前 4KB 不会破坏结构）
  const headLen = Math.min(bytes.length, 4096);
  let head = '';
  for (let i = 0; i < headLen; i++) head += String.fromCharCode(bytes[i]);
  const fromMeta = charsetFromHtml(head);
  if (fromMeta) {
    const out = tryDecode(bytes, fromMeta);
    if (out !== null) return out;
  }

  // 严格 UTF-8 试解：成功说明确实是 UTF-8
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { /* 落到 GBK */ }

  const gbk = tryDecode(bytes, 'gbk');
  if (gbk !== null) return gbk;
  return new TextDecoder('utf-8').decode(bytes);
}

/* ----------------------------- Cookie 罐 ----------------------------- */

/** 按 host 维护的简易 Cookie 罐（进程内，不落盘） */
export class CookieJar {
  constructor() { this.hosts = new Map(); }

  store(url, setCookieHeaders) {
    if (!setCookieHeaders || !setCookieHeaders.length) return;
    let host;
    try { host = new URL(url).host; } catch { return; }
    let jar = this.hosts.get(host);
    if (!jar) { jar = new Map(); this.hosts.set(host, jar); }
    for (const line of setCookieHeaders) {
      const first = String(line).split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      // 忽略立即过期的 cookie
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(String(line))) jar.delete(name);
      else jar.set(name, value);
    }
  }

  header(url) {
    let host;
    try { host = new URL(url).host; } catch { return ''; }
    const jar = this.hosts.get(host);
    if (!jar || jar.size === 0) return '';
    return [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
  }

  set(url, cookieString) {
    let host;
    try { host = new URL(url).host; } catch { return; }
    let jar = this.hosts.get(host);
    if (!jar) { jar = new Map(); this.hosts.set(host, jar); }
    for (const part of String(cookieString).split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
  }

  all() {
    const out = [];
    for (const [host, jar] of this.hosts) {
      for (const [k, v] of jar) out.push({ host, name: k, value: v });
    }
    return out;
  }

  clear() { this.hosts.clear(); }
}

/* ------------------------------ 请求 ------------------------------ */

/** 全局限速：按 host 串行化最小间隔，避免把对方站点打挂 */
const hostLastHit = new Map();
const HOST_MIN_INTERVAL = Number(process.env.SHUHAI_HOST_INTERVAL_MS || 120);

async function throttle(url) {
  let host;
  try { host = new URL(url).host; } catch { return; }
  const now = Date.now();
  const last = hostLastHit.get(host) || 0;
  const wait = last + HOST_MIN_INTERVAL - now;
  if (wait > 0) await sleep(wait);
  hostLastHit.set(host, Date.now());
}

/** 常见反爬/拦截页特征 */
const BLOCK_PATTERNS = [
  /just a moment\.\.\./i,
  /cf-browser-verification/i,
  /enable javascript and cookies to continue/i,
  /访问过于频繁|请求过于频繁|访问频繁/,
  /您的访问出现异常|安全验证|滑动验证|人机验证/,
  /403 Forbidden/i,
];

export function detectBlockPage(text, status, headers) {
  if (status === 403 && /cloudflare/i.test(headers?.get?.('server') || '')) return '站点启用了 Cloudflare 防护，服务器 IP 被拦截';
  if (status === 429) return '请求过于频繁（HTTP 429），请降低并发或稍后重试';
  if (!text) return '';
  const head = text.slice(0, 3000);
  for (const p of BLOCK_PATTERNS) {
    if (p.test(head)) return '疑似被站点风控拦截：' + head.replace(/\s+/g, ' ').slice(0, 80).trim();
  }
  return '';
}

/**
 * 发起一次 HTTP 请求。
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method] GET/POST...
 * @param {object} [opts.headers]
 * @param {string|object} [opts.body]
 * @param {string} [opts.charset] 强制字符集
 * @param {number} [opts.timeout] 毫秒，默认 15000
 * @param {number} [opts.retry] 重试次数，默认 1
 * @param {CookieJar} [opts.jar]
 * @param {boolean} [opts.allowStatus] 非 2xx 不抛错
 */
export async function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    charset = '',
    timeout = 15000,
    retry = 1,
    jar = null,
    allowStatus = false,
    redirect = 'follow',
  } = opts;

  if (!/^https?:\/\//i.test(url)) {
    throw new HttpError('非法的 URL（书源里的地址必须是 http/https 绝对地址）: ' + url, { code: 'BAD_REQUEST', url });
  }

  const finalHeaders = {
    'User-Agent': DEFAULT_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
  };
  for (const k in headers) {
    if (headers[k] === undefined || headers[k] === null) continue;
    // 允许书源覆盖默认 UA
    const key = Object.keys(finalHeaders).find((h) => h.toLowerCase() === String(k).toLowerCase()) || k;
    finalHeaders[key] = String(headers[k]);
  }
  if (jar) {
    const c = jar.header(url);
    if (c && !finalHeaders.Cookie && !finalHeaders.cookie) finalHeaders.Cookie = c;
  }

  let payload = body;
  if (payload && typeof payload === 'object' && !(payload instanceof Uint8Array) && !(payload instanceof ArrayBuffer)) {
    payload = new URLSearchParams(payload).toString();
    if (!finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  let lastErr = null;
  const attempts = Math.max(1, retry + 1);

  for (let attempt = 0; attempt < attempts; attempt++) {
    await throttle(url);
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: method === 'GET' || method === 'HEAD' ? undefined : payload,
        redirect,
        signal: ac.signal,
      });
      clearTimeout(timer);

      if (jar) {
        const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : null;
        if (sc) jar.store(url, sc);
        else {
          const one = res.headers.get('set-cookie');
          if (one) jar.store(url, [one]);
        }
      }

      const buf = new Uint8Array(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') || '';
      const text = decodeBody(buf, { contentType, charset });

      if (!res.ok && !allowStatus) {
        const blocked = detectBlockPage(text, res.status, res.headers);
        // 关键：上游站点的 404 是「书源地址失效」，绝不能和「我们自己的接口不存在」共用一个错误码。
        // 早期版本把上游 404 标成 NOT_FOUND，前端就显示 "HTTP 404 Not Found"，
        // 看起来像本服务的接口挂了，实际是书源站点那一页没了。这里单独用 UPSTREAM_NOT_FOUND。
        const upstreamGone = res.status === 404 || res.status === 410;
        const message = blocked
          ? blocked
          : (upstreamGone
            ? '书源站点返回 ' + res.status + '：该页面不存在或已失效（' + url + '）'
            : 'HTTP ' + res.status + ' ' + (res.statusText || ''));
        throw new HttpError(message, {
          code: blocked ? 'UPSTREAM_ERROR' : (upstreamGone ? 'UPSTREAM_NOT_FOUND' : 'UPSTREAM_ERROR'),
          status: res.status,
          url,
        });
      }

      return {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        contentType,
        text,
        bytes: buf.length,
        finalUrl: res.url || url,
        elapsed: Date.now() - started,
      };
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err && (err.name === 'AbortError' || /timeout/i.test(err.message || ''));
      lastErr = isAbort
        ? new HttpError('请求超时（' + timeout + 'ms）: ' + url, { code: 'TIMEOUT', url })
        : (err instanceof HttpError ? err : new HttpError('网络错误: ' + (err?.message || err), { code: 'UPSTREAM_ERROR', url }));
      // 4xx 业务错误不重试
      if (lastErr.code === 'UPSTREAM_NOT_FOUND' || lastErr.code === 'NOT_FOUND'
        || (lastErr.status >= 400 && lastErr.status < 500 && lastErr.status !== 429)) break;
      if (attempt < attempts - 1) await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr || new HttpError('请求失败: ' + url, { code: 'UPSTREAM_ERROR', url });
}

/** 便捷封装：直接拿文本 */
export async function getText(url, opts) {
  const r = await request(url, opts);
  return r.text;
}

/** URL 解析：把相对地址补全为绝对地址，兼容 //host/path 与 javascript: 等脏数据 */
export function absUrl(base, href) {
  if (!href) return '';
  const s = String(href).trim();
  if (!s || s === '#' || s.startsWith('javascript:') || s.startsWith('void(')) return '';
  if (/^(data|blob|mailto|tel):/i.test(s)) return '';
  try {
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('//')) return new URL(base).protocol + s;
    return new URL(s, base).toString();
  } catch {
    return s;
  }
}

/** 从字符串里抽出第一个 http(s) 链接（书源里常见 JSON 内嵌） */
export function firstUrl(text) {
  const m = /https?:\/\/[^\s"'<>\\]+/.exec(String(text || ''));
  return m ? m[0] : '';
}

/** 把 JSON 里的转义 \\/ 还原，legado 书源里极常见 */
export function unescapeSlashes(s) {
  return String(s || '').replace(/\\\//g, '/');
}
