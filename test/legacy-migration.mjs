/**
 * 老库迁移 + 批量体检接口 测试
 *
 * 覆盖两件在其它测试里覆盖不到的事：
 *   1) 用「旧版本 schema」的库启动服务，验证 ALTER TABLE 增量迁移不丢数据；
 *   2) 批量体检 / 一键清理失效源的完整语义，尤其是
 *      **从未测试过的书源绝不能被删除**（这是最危险的误删路径）。
 *
 *   node test/legacy-migration.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shuhai-legacy-'));
const dbFile = path.join(tmpDir, 'old.db');

/* ---------- 1. 造一个旧版本 schema 的库（没有体检相关的列） ---------- */

const legacy = new DatabaseSync(dbFile);
legacy.exec(`CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', group_name TEXT NOT NULL DEFAULT '',
  type INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, weight INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0, comment TEXT NOT NULL DEFAULT '', raw TEXT NOT NULL,
  last_update_time INTEGER NOT NULL DEFAULT 0, respond_time INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`);
const legacyRaw = JSON.stringify({
  bookSourceName: '老库遗留源',
  bookSourceUrl: 'http://127.0.0.1:1/',
  searchUrl: '/s?q={{key}}',
  ruleSearch: { bookList: '.item', name: 'text' },
  enabled: true,
});
legacy.prepare('INSERT INTO sources (name,url,raw,created_at,updated_at) VALUES (?,?,?,?,?)')
  .run('老库遗留源', 'http://127.0.0.1:1/', legacyRaw, Date.now(), Date.now());
legacy.close();

/* ---------- 2. 起服务 ---------- */

const port = 18600 + Math.floor(Math.random() * 300);
const base = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, [path.join(ROOT, 'src/server.mjs')], {
  env: { ...process.env, SHUHAI_PORT: String(port), SHUHAI_DB: dbFile, SHUHAI_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d.toString(); });
child.stderr.on('data', (d) => { serverLog += d.toString(); });

const cleanup = () => {
  try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
};
process.on('exit', cleanup);

const pass = [];
const fail = [];
const check = (name, cond, extra) => {
  if (cond) pass.push(name);
  else fail.push(name + (extra === undefined ? '' : ' → ' + String(extra).slice(0, 300)));
};
const api = async (method, p, body) => {
  const r = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* 忽略 */ }
  return { status: r.status, json };
};

try {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch { /* 重试 */ }
    await new Promise((r) => setTimeout(r, 150));
  }

  /* ---------- 3. 迁移 ---------- */
  let r = await api('GET', '/api/sources');
  const s0 = r.json?.data?.items?.[0];
  check('旧库启动后数据不丢', r.status === 200 && r.json.data.total === 1 && s0.name === '老库遗留源', JSON.stringify(r.json).slice(0, 200));
  check('补齐的体检字段默认「未测试」', s0 && s0.testStatus === 'untested' && s0.lastTestAt === 0 && s0.lastTestOk === false, JSON.stringify(s0));
  check('返回体检总览 testStats', r.json?.data?.testStats?.total === 1 && r.json.data.testStats.untested === 1, JSON.stringify(r.json?.data?.testStats));

  r = await api('GET', '/api/sources?status=untested');
  check('status=untested 命中 1', r.json?.data?.total === 1, r.json?.data?.total);
  r = await api('GET', '/api/sources?status=fail');
  check('status=fail 命中 0', r.json?.data?.total === 0, r.json?.data?.total);

  /* ---------- 4. 批量体检（该源指向 127.0.0.1:1，必然失败） ---------- */
  r = await api('POST', '/api/sources/test-batch', { ids: [1], keyword: '斗破苍穹', concurrency: 2 });
  const bt = r.json?.data;
  check('批量体检返回统计', r.status === 200 && bt.total === 1 && bt.fail === 1 && bt.ok === 0, JSON.stringify(bt).slice(0, 240));
  check('失败结果带原因并落库', bt.results[0].ok === false && !!bt.results[0].error, JSON.stringify(bt.results[0]));
  check('体检后 testStats.fail=1', bt.stats.fail === 1, JSON.stringify(bt.stats));

  r = await api('GET', '/api/sources?status=fail');
  check('status=fail 现在命中 1 且带失败原因', r.json?.data?.total === 1 && !!r.json.data.items[0].lastTestError, JSON.stringify(r.json?.data?.items?.[0]));

  /* ---------- 5. 一键删除失效源 ---------- */
  r = await api('POST', '/api/sources/delete-invalid', { retest: false });
  check('删除失效源 deleted=1', r.json?.data?.deleted === 1 && r.json.data.items[0].name === '老库遗留源', JSON.stringify(r.json?.data));
  r = await api('GET', '/api/sources');
  check('删除后书源清空', r.json?.data?.total === 0, r.json?.data?.total);

  /* ---------- 6. 未测试的源绝不能被误删（关键安全属性） ---------- */
  await api('POST', '/api/sources/import', {
    text: JSON.stringify([{
      bookSourceName: '未测源', bookSourceUrl: 'http://127.0.0.1:2/',
      searchUrl: '/s?q={{key}}', ruleSearch: { bookList: '.i', name: 'text' },
    }]),
  });
  r = await api('POST', '/api/sources/delete-invalid', {});
  const left = await api('GET', '/api/sources');
  check('从未测试的书源不会被误删', r.json?.data?.deleted === 0 && left.json.data.total === 1, JSON.stringify(r.json?.data));
  check('delete-invalid 返回处理范围 scope', r.json?.data?.scope === 1, JSON.stringify(r.json?.data));

  /* ---------- 7. SSE 批量体检流 ---------- */
  const evRes = await fetch(base + '/api/sources/test-batch/stream?keyword=' + encodeURIComponent('斗破') + '&concurrency=2');
  const evText = await evRes.text();
  check('SSE 推送 start/result/done',
    evText.includes('event: start') && evText.includes('event: result') && evText.includes('event: done'),
    evText.slice(0, 240).replace(/\n/g, '|'));
  check('SSE done 带汇总统计', /event: done\ndata: \{[^\n]*"total":1/.test(evText), evText.slice(-240).replace(/\n/g, '|'));
} catch (err) {
  fail.push('异常中断: ' + err.message + '\n' + err.stack);
} finally {
  console.log('通过 ' + pass.length + ' 项，失败 ' + fail.length + ' 项');
  for (const p of pass) console.log('  PASS ' + p);
  if (fail.length) {
    console.log('失败清单：');
    for (const f of fail) console.log('  FAIL ' + f);
    if (serverLog) console.log('--- 服务端日志（尾部） ---\n' + serverLog.split('\n').slice(-20).join('\n'));
  } else {
    console.log('全部通过 ✅');
  }
  cleanup();
  process.exit(fail.length ? 1 : 0);
}
