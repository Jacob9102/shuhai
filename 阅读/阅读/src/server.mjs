/**
 * HTTP 服务器 —— 零依赖。
 *  - /api/*  交给 api.mjs 处理
 *  - 其余路径优先命中 web/ 下的静态文件，未命中回退到 index.html（hash 路由的 SPA）
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { handleApi } from './api.mjs';
import { openDb, closeDb } from './db.mjs';
import * as log from './log.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');

const PORT = Number(process.env.SHUHAI_PORT || process.env.PORT || 8080);
const HOST = process.env.SHUHAI_HOST || '0.0.0.0';
const MAX_BODY = Number(process.env.SHUHAI_MAX_BODY || 32 * 1024 * 1024); // 书源包可能很大

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)|image\/svg)/;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { code: 'BAD_REQUEST', status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(buf, contentType) {
  const text = buf.toString('utf8').trim();
  if (!text) return {};
  if (contentType.includes('application/json') || text.startsWith('{') || text.startsWith('[')) {
    try { return JSON.parse(text); }
    catch (err) { throw Object.assign(new Error('JSON 解析失败: ' + err.message), { code: 'BAD_REQUEST', status: 400 }); }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text).entries());
  }
  return { text };
}

/** 安全地解析静态文件路径，阻止目录穿越 */
function safeJoin(base, target) {
  const p = path.normalize(path.join(base, target));
  if (!p.startsWith(base)) return null;
  return p;
}

async function serveStatic(req, res, urlObj) {
  let rel = decodeURIComponent(urlObj.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  let filePath = safeJoin(WEB_DIR, rel);
  if (!filePath) { res.writeHead(403); res.end('Forbidden'); return; }

  let stat = null;
  try { stat = await fsp.stat(filePath); } catch { stat = null; }

  // 目录 → index.html；未命中 → SPA 回退
  if (stat && stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    try { stat = await fsp.stat(filePath); } catch { stat = null; }
  }
  if (!stat || !stat.isFile()) {
    // 带扩展名的资源找不到就 404（避免把 .js 请求喂成 HTML，引发奇怪的 MIME 报错）
    if (path.extname(rel)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found: ' + rel);
      return;
    }
    filePath = path.join(WEB_DIR, 'index.html');
    try { stat = await fsp.stat(filePath); } catch { stat = null; }
    if (!stat) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('web/index.html 缺失，前端资源未就绪');
      return;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = 'W/"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }

  const headers = {
    'Content-Type': type,
    ETag: etag,
    // HTML 永远要新鲜（否则用户拿到旧壳子配新资源），其余资源短缓存
    // 一律 no-cache（= 每次带 ETag 回源校验，未变则 304）。
    // 本项目前端没有构建步骤、文件名不带内容哈希，一旦用 max-age 缓存，
    // 更新代码后浏览器会继续用旧 JS，「改了却看不到效果」的坑就是这么来的。
    'Cache-Control': 'no-cache',
  };

  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  const wantGzip = COMPRESSIBLE.test(type) && /\bgzip\b/.test(acceptEncoding) && stat.size > 1024;

  if (wantGzip) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(filePath).pipe(zlib.createGzip({ level: 6 })).pipe(res);
    return;
  }

  headers['Content-Length'] = String(stat.size);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(filePath).pipe(res);
}

/* ------------------------------ 服务器 ------------------------------ */

export async function createServer() {
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const urlObj = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

    // 宽松 CORS：方便其它客户端/脚本直接调用 API
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (urlObj.pathname.startsWith('/api/')) {
      let body = {};
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const buf = await readBody(req);
          body = parseBody(buf, String(req.headers['content-type'] || ''));
        }
      } catch (err) {
        res.writeHead(err.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: { code: err.code || 'BAD_REQUEST', message: err.message } }));
        return;
      }

      let handled = false;
      try {
        handled = await handleApi(req, res, urlObj, body);
      } catch (err) {
        log.error('API 未捕获异常 ' + urlObj.pathname + ': ' + err.stack);
        if (!res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: err.message } }));
        }
        handled = true;
      }
      if (!handled && !res.writableEnded) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: '接口不存在: ' + urlObj.pathname } }));
      }
      if (handled && Date.now() - started > 3000 && !urlObj.pathname.includes('/stream')) {
        log.debug('慢接口 ' + req.method + ' ' + urlObj.pathname + ' ' + (Date.now() - started) + 'ms');
      }
      return;
    }

    try {
      await serveStatic(req, res, urlObj);
    } catch (err) {
      log.error('静态资源错误 ' + urlObj.pathname + ': ' + err.message);
      if (!res.writableEnded) { res.writeHead(500); res.end('Internal Error'); }
    }
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  // 搜索/缓存可能跑很久，取消默认的请求超时
  server.requestTimeout = 0;
  return server;
}

export async function start() {
  openDb();
  const server = await createServer();
  await new Promise((resolve) => server.listen(PORT, HOST, resolve));
  log.info('书海已启动 http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT + '  （Node ' + process.version + '）');

  const shutdown = (signal) => {
    log.info('收到 ' + signal + '，正在关闭…');
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

// 直接运行本文件时启动服务
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  start().catch((err) => {
    console.error('启动失败:', err);
    process.exit(1);
  });
}
