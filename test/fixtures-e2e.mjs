/**
 * 夹具联调测试：使用 test/fixtures/sources.json（由独立流程按 legado 规范编写）
 * + test/mock-site 模拟站点，验证后端规则引擎能正确解析第三方书源。
 *
 *   node test/fixtures-e2e.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 允许把「被测应用」指向别处（例如只含容器内文件集的暂存目录），用于容器等价验证
const APP_DIR = process.env.SHUHAI_APP_DIR ? path.resolve(process.env.SHUHAI_APP_DIR) : ROOT;
// 夹具里的书源地址硬编码了 18080（mock 站点默认端口），这里必须保持一致
const MOCK_PORT = Number(process.env.MOCK_PORT || 18080);
const SHUHAI_PORT = 18290;
const base = 'http://127.0.0.1:' + SHUHAI_PORT;
const mockBase = 'http://127.0.0.1:' + MOCK_PORT;

let pass = 0;
const failures = [];
const check = (n, cond, extra) => { if (cond) pass++; else { failures.push(n + (extra ? ' → ' + extra : '')); console.log('  x ' + n + (extra ? ' → ' + extra : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, json: { raw: t } }; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shuhai-fx-'));
const mockProc = spawn(process.execPath, [path.join(ROOT, 'test/mock-site/server.mjs')], {
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
const srvProc = spawn(process.execPath, [path.join(APP_DIR, 'src/server.mjs')], {
  // 刻意把 cwd 设到别处，模拟容器中「工作目录 ≠ 代码目录」的情形
  cwd: tmp,
  env: { ...process.env, SHUHAI_PORT: String(SHUHAI_PORT), SHUHAI_DB: path.join(tmp, 'data', 'fx.db'), SHUHAI_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srvProc.stdout.on('data', (d) => { srvLog += d; });
srvProc.stderr.on('data', (d) => { srvLog += d; });

const cleanup = () => {
  for (const p of [mockProc, srvProc]) { try { p.kill('SIGKILL'); } catch { /* 忽略 */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
};
process.on('exit', cleanup);

async function waitUrl(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* 重试 */ }
    await sleep(200);
  }
  return false;
}

try {
  check('夹具站点启动', await waitUrl(mockBase + '/__routes'));
  check('书海服务启动', await waitUrl(base + '/api/health'));
  if (failures.length) throw new Error('前置服务未就绪');

  const sourcesRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/sources.json'), 'utf8'));
  check('夹具书源文件是数组且含 4+ 个源', Array.isArray(sourcesRaw) && sourcesRaw.length >= 4, 'len=' + sourcesRaw.length);

  // 用订阅包裹格式导入，顺带验证该格式
  const sub = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/legado-subscription.json'), 'utf8'));
  let r = await api('POST', '/api/sources/import', { text: JSON.stringify(sourcesRaw), mode: 'append' });
  check('导入夹具书源成功', r.json.ok && r.json.data.added >= 4, JSON.stringify(r.json.data));
  r = await api('POST', '/api/sources/import', { text: JSON.stringify(sub), mode: 'append' });
  check('订阅包裹格式可导入（已存在则跳过）', r.json.ok, JSON.stringify(r.json.data));

  const list = (await api('GET', '/api/sources?limit=50')).json.data.items;
  const byName = (kw) => list.find((s) => s.name.includes(kw));
  const utf8Src = byName('UTF8') || byName('UTF-8') || list.find((s) => s.enabled && s.searchable);
  check('找到 UTF-8 测试源', Boolean(utf8Src), JSON.stringify(list.map((s) => s.name)));

  /* ---------- 单源真实搜索 ---------- */
  r = await api('POST', '/api/sources/test', { id: utf8Src.id, keyword: '斗破' });
  check('书源自检通过（真实命中）', r.json.data?.ok === true && r.json.data.count >= 1, JSON.stringify(r.json.data).slice(0, 400));

  r = await api('GET', '/api/sources/' + utf8Src.id + '/search?q=' + encodeURIComponent('天'));
  const fuzzy = r.json.data?.items || [];
  check('模糊搜索命中多本', fuzzy.length >= 2, JSON.stringify(fuzzy.map((x) => x.name)));

  r = await api('GET', '/api/sources/' + utf8Src.id + '/search?q=' + encodeURIComponent('忘语'));
  check('按作者名搜索命中', (r.json.data?.items || []).some((x) => x.author === '忘语'), JSON.stringify((r.json.data?.items || []).map((x) => [x.name, x.author])));

  /* ---------- 完整阅读链路（UTF-8 源） ---------- */
  r = await api('GET', '/api/sources/' + utf8Src.id + '/search?q=' + encodeURIComponent('斗破'));
  const hit = (r.json.data?.items || [])[0];
  check('搜索结果字段完整', hit && hit.name && hit.author && hit.bookUrl, JSON.stringify(hit));

  r = await api('POST', '/api/books/resolve', { sourceId: utf8Src.id, bookUrl: hit.bookUrl });
  const bookId = r.json.data?.id;
  check('书籍落地成功', Boolean(bookId), JSON.stringify(r.json).slice(0, 300));
  check('书籍简介已抓取', (r.json.data?.intro || '').length > 10, r.json.data?.intro?.slice(0, 60));

  r = await api('GET', '/api/books/' + bookId + '/chapters');
  const chapters = r.json.data?.items || [];
  check('目录抓取成功（含分页目录 30 章）', chapters.length === 30, 'got ' + chapters.length);
  check('章节有标题与地址', chapters[0]?.title?.includes('章') && chapters[0]?.url?.startsWith('http'), JSON.stringify(chapters[0]));

  r = await api('GET', '/api/books/' + bookId + '/content?index=0');
  const text = r.json.data?.content || '';
  check('正文抓取成功', text.length > 800, 'len=' + text.length);
  check('正文无站点广告残留', !/请记住|天才一秒|www\./i.test(text), text.slice(0, 150));
  check('正文段落数充足', text.split('\n').length >= 8, 'lines=' + text.split('\n').length);

  /* ---------- 正文分页（nextContentUrl） ---------- */
  r = await api('GET', '/api/books/' + bookId + '/content?index=4');
  check('正文分页章节可读', r.json.ok && (r.json.data?.content || '').length > 100, JSON.stringify(r.json).slice(0, 200));

  /* ---------- GBK 源 ---------- */
  const gbkSrc = byName('GBK');
  if (gbkSrc) {
    r = await api('GET', '/api/sources/' + gbkSrc.id + '/search?q=' + encodeURIComponent('斗破'));
    const gh = r.json.data?.items || [];
    check('GBK 源中文解码正确', gh.some((x) => x.name === '斗破苍穹' && x.author === '天蚕土豆'), JSON.stringify(gh.map((x) => [x.name, x.author])));
    if (gh[0]) {
      r = await api('POST', '/api/books/resolve', { sourceId: gbkSrc.id, bookUrl: gh[0].bookUrl });
      const gbId = r.json.data?.id;
      check('GBK 源书籍落地成功', Boolean(gbId), JSON.stringify(r.json).slice(0, 200));
      r = await api('GET', '/api/books/' + gbId + '/chapters');
      check('GBK 源目录抓取成功', (r.json.data?.items || []).length >= 20, 'got ' + (r.json.data?.items || []).length);
      r = await api('GET', '/api/books/' + gbId + '/content?index=0');
      const gt = r.json.data?.content || '';
      check('GBK 源正文解码正确（中文可读、无乱码）', gt.length > 500 && !/\uFFFD/.test(gt) && /[\u4e00-\u9fff]{10,}/.test(gt), 'len=' + gt.length);
    }
  } else {
    check('找到 GBK 测试源', false, JSON.stringify(list.map((s) => s.name)));
  }

  /* ---------- POST 搜索源 ---------- */
  const postSrc = byName('POST');
  if (postSrc) {
    r = await api('GET', '/api/sources/' + postSrc.id + '/search?q=' + encodeURIComponent('斗破'));
    check('POST 方式搜索源可用', (r.json.data?.items || []).length >= 1, JSON.stringify(r.json).slice(0, 300));
  }

  /* ---------- 坏规则源不应拖垮整体 ---------- */
  const broken = byName('坏规则');
  if (broken) {
    r = await api('GET', '/api/search?q=' + encodeURIComponent('斗破'));
    const bs = (r.json.data?.sources || []).find((s) => s.id === broken.id);
    check('坏规则源被隔离且整体搜索成功', r.json.ok && bs && bs.count === 0 && r.json.data.items.length >= 1, JSON.stringify(bs));
  }

  /* ---------- 聚合搜索 & 去重 ---------- */
  r = await api('GET', '/api/search?q=' + encodeURIComponent('斗破'));
  check('多源聚合搜索有结果', (r.json.data?.items || []).length >= 1, JSON.stringify(r.json.data).slice(0, 300));
  const withOrigins = (r.json.data?.items || []).find((x) => (x.origins || []).length >= 2);
  check('同名书跨源聚合（origins 含多个来源）', Boolean(withOrigins), JSON.stringify((r.json.data?.items || []).map((x) => [x.name, (x.origins || []).length])));

  /* ---------- 换源：流式渐进返回（解决「换源卡顿」） ---------- */
  {
    const t0 = Date.now();
    const res = await fetch(base + '/api/books/' + bookId + '/alternatives/stream?refresh=1&maxSources=8&timeout=4000');
    check('流式换源返回 text/event-stream',
      String(res.headers.get('content-type')).includes('text/event-stream'),
      String(res.headers.get('content-type')));

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const events = [];
    let firstSourceAt = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          const obj = JSON.parse(line.slice(6));
          obj._at = Date.now() - t0;
          if (obj.type === 'source' && firstSourceAt < 0) firstSourceAt = obj._at;
          events.push(obj);
        } catch { /* 忽略心跳等非 JSON 行 */ }
      }
    }

    const sourceEvents = events.filter((e) => e.type === 'source');
    const doneEvt = events.find((e) => e.type === 'done');
    check('流式换源逐源推送事件', sourceEvents.length >= 1, JSON.stringify(events.map((e) => e.type)));
    check('流式换源以 done 收尾并带统计',
      Boolean(doneEvt) && typeof doneEvt.searched === 'number' && typeof doneEvt.succeeded === 'number',
      JSON.stringify(doneEvt));
    check('每个 source 事件都带进度信息',
      sourceEvents.every((e) => e.progress && typeof e.progress.responded === 'number' && typeof e.progress.total === 'number'),
      JSON.stringify(sourceEvents[0] && sourceEvents[0].progress));
    check('首个书源响应足够快（< 5s，体现渐进式体验）', firstSourceAt >= 0 && firstSourceAt < 5000, 'firstSourceAt=' + firstSourceAt + 'ms');
  }

  /* ---------- 换源：非流式接口仍然可用（向后兼容） ---------- */
  {
    r = await api('GET', '/api/books/' + bookId + '/alternatives?refresh=1&maxSources=8&timeout=4000');
    check('非流式换源接口仍返回 {items,...}', r.json.ok && Array.isArray(r.json.data.items) && typeof r.json.data.searched === 'number',
      JSON.stringify(r.json).slice(0, 200));
  }

  /* ---------- sendBeacon 兜底路径（POST 别名） ---------- */
  r = await api('POST', '/api/progress/' + bookId, { chapterIndex: 3, chapterTitle: '第3章', percent: 10 });
  check('POST 进度的 sendBeacon 兜底可用', r.json.ok && r.json.data.chapterIndex === 3, JSON.stringify(r.json));

} catch (err) {
  failures.push('异常中断: ' + err.message);
  console.log('  x 异常中断: ' + err.stack);
} finally {
  console.log('\n============================');
  console.log('夹具联调：通过 ' + pass + ' 项，失败 ' + failures.length + ' 项');
  if (failures.length) { console.log('\n失败清单：'); for (const f of failures) console.log('  - ' + f); }
  else console.log('全部通过 ✅');
  if (failures.length && srvLog) console.log('\n服务端日志尾部:\n' + srvLog.split('\n').slice(-20).join('\n'));
  cleanup();
  process.exit(failures.length ? 1 : 0);
}
